// embed-test.mjs — end-to-end check of the embedded WebUI floating window.
//
// Opens the host-served page in headless Chrome and asserts, against a real
// isolated DSH instance:
//
//   1. the page is the real WebUI (boot graph, root slot, transport hook),
//   2. RPC through __DSH_TRANSPORT__ reaches /ext-api (session/list),
//   3. the mux WebSocket is established through the plugin proxy,
//   4. workspace binding creates the directory and opens its session,
//   5. a prompt streams back through the mux (turn error without an API key),
//   6. no console errors / exceptions along the way.
//
// Usage: DSH_BASE=http://127.0.0.1:4141 TOKEN_FILE=test/env/browser-client-token-4141 node test/embed-test.mjs

import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'

const BASE = (process.env.DSH_BASE || 'http://127.0.0.1:4141').replace(/\/+$/, '')
const TOKEN = (await readFile(process.env.TOKEN_FILE || new URL('./env/browser-client-token-4141', import.meta.url).pathname, 'utf8')).trim()
const WORKDIR = process.env.EMBED_WORKDIR || '/tmp/dsh-embed-case'
const SHOT = process.env.EMBED_SHOT || ''

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

await mkdir(WORKDIR, { recursive: true })
const REAL_WORKDIR = await realpath(WORKDIR)

const port = 9600 + Math.floor(Math.random() * 200)
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/chrome-embed-${port}`,
  '--window-size=860,900', 'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logs = []
const sockets = []
let clean = false

try {
  let target
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()
      target = list.find((t) => t.type === 'page')
      if (target) break
    } catch { /* not up yet */ }
    await sleep(200)
  }
  if (!target) throw new Error('headless Chrome did not expose a target')

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise((r) => ws.once('open', r))
  let seq = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
      if (msg.params.type === 'error') logs.push(`[console.error] ${text}`)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${String(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)}`)
    } else if (msg.method === 'Network.webSocketCreated') {
      sockets.push(msg.params.url)
    } else if (msg.method === 'Network.webSocketFrameError') {
      logs.push(`[ws error] ${msg.params.errorMessage}`)
    }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, (msg) => resolve(msg.result ?? msg.error ?? msg))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r?.result?.value
  }

  await send('Runtime.enable')
  await send('Network.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: `${BASE}/browser-ui/?token=${encodeURIComponent(TOKEN)}&mode=standard` })

  // 1. the real WebUI booted
  let booted = false
  for (let i = 0; i < 120; i++) {
    booted = Boolean(await evaluate(`Boolean(window.__DSH_BOOT__ && window.__DSH_TRANSPORT__ && document.querySelector('#root [data-slot="root"]'))`))
    if (booted) break
    await sleep(250)
  }
  check('embedded page boots the real WebUI', booted)

  // the transport shim is in charge of the page
  check('transport shim is installed', await evaluate(`typeof window.__DSH_TRANSPORT__.fetch === 'function' && Boolean(window.__DSH_EMBED__)`))
  check('embed stylesheet applied', await evaluate(`document.documentElement.hasAttribute('data-dsh-embed')`))
  check('token stripped from the address bar', await evaluate(`!location.search.includes('token=')`))

  // 2. RPC through the transport
  const listResult = await evaluate(`(async () => {
    const res = await window.__DSH_TRANSPORT__.fetch('api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'embed-test', method: 'session/list', payload: { args: { _request: {} } } })
    })
    const body = await res.json()
    return { status: res.status, ok: Boolean(body && body.result && body.result.ok), count: body && body.result && body.result.value ? body.result.value.items.length : -1 }
  })()`)
  check('RPC through /ext-api succeeds', Boolean(listResult && listResult.ok), JSON.stringify(listResult))

  // 3. mux over the plugin proxy
  let muxOpen = false
  for (let i = 0; i < 40; i++) {
    muxOpen = sockets.some((u) => u.includes('/browser-ui-mux'))
    if (muxOpen) break
    await sleep(250)
  }
  check('mux WebSocket connected through the proxy', muxOpen)

  // 4. bind the current page directory → workspace + session
  await evaluate(`new Promise((resolve) => {
    const tick = () => window.__DSH_EMBED__ && typeof window.__DSH_EMBED__.bindDir === 'function'
      ? resolve(true) : setTimeout(tick, 100)
    tick()
  })`)
  let bind
  let bindError = ''
  for (let i = 0; i < 20; i++) {
    bind = await evaluate(`window.__DSH_EMBED__.bindDir(${JSON.stringify(WORKDIR)})`)
    if (bind) break
    bindError = await evaluate(`String(window.__DSH_EMBED__.lastError || '')`)
    await sleep(250)
  }
  check('workspace binding returns a workspace id', Boolean(bind), String(bind || bindError || ''))

  let sessionId
  for (let i = 0; i < 40; i++) {
    sessionId = await evaluate(`(async () => {
      const res = await window.__DSH_TRANSPORT__.fetch('api/session/list', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'embed-test', method: 'session/list', payload: { args: { _request: {} } } })
      })
      const body = await res.json()
      const items = body && body.result && body.result.value ? body.result.value.items : []
      const match = items.find((s) => s.cwd === ${JSON.stringify(REAL_WORKDIR)})
      return match && match.sessionId
    })()`)
    if (sessionId) break
    await sleep(250)
  }
  check('bound workspace has a session', Boolean(sessionId), String(sessionId || ''))

  // 5. a prompt streams back through the mux — prompt the session the window
  // actually has open (binding may reuse or create a blank one).
  const openSessionId = await evaluate(`(window.__DSH_EMBED__ && window.__DSH_EMBED__.mainSessionId) ? window.__DSH_EMBED__.mainSessionId() : null`)
  if (openSessionId) sessionId = openSessionId
  if (sessionId) {
    const sent = await evaluate(`(async () => {
      const res = await window.__DSH_TRANSPORT__.fetch('api/session/prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'embed-test', method: 'session/prompt', payload: { args: { request: {
          requestId: 'embed-test-' + Date.now(),
          sessionId: ${JSON.stringify(sessionId)},
          mode: 'queue',
          content: [{ type: 'text', text: 'embed test: no key expected' }]
        } } } })
      })
      const body = await res.json()
      return Boolean(body && body.result && body.result.ok)
    })()`)
    check('prompt accepted', sent)

    let streamed = false
    for (let i = 0; i < 80; i++) {
      streamed = Boolean(await evaluate(`document.body.innerText.includes('embed test: no key expected')`))
      if (streamed) break
      await sleep(250)
    }
    check('prompt rendered from the mux stream', streamed)
  }

  check('no console errors or exceptions', logs.length === 0, logs.join(' | ').slice(0, 400))

  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot && shot.data) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(SHOT, Buffer.from(shot.data, 'base64'))
      console.log(`screenshot ${SHOT}`)
    }
  }

  ws.close()
  clean = true
} catch (err) {
  check('harness completed', false, String(err && err.stack || err))
} finally {
  try { chrome.kill() } catch { /* already gone */ }
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0 || !clean) {
  for (const item of failed) console.log(`FAILED: ${item.name} ${item.detail}`)
  process.exit(1)
}
