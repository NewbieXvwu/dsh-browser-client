// embed-minimal-test.mjs — checks the transparent minimal floating window.
//
// Opens the host-served page with `?mode=minimal` and asserts, against a real
// isolated DSH instance:
//
//   1. minimal mode is applied before boot (html attrs, no opaque shells),
//   2. the sidebar / conversation header / composer chrome are not rendered,
//   3. the composer stays usable (prefill works) and is the only input surface,
//   4. a bound workspace + prompt leaves exactly the newest turn on screen,
//   5. no console errors / exceptions along the way.
//
// Usage: DSH_BASE=http://127.0.0.1:4145 TOKEN_FILE=test/env/browser-client-token-4145 node test/embed-minimal-test.mjs

import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import WebSocket from 'ws'

const BASE = (process.env.DSH_BASE || 'http://127.0.0.1:4141').replace(/\/+$/, '')
const TOKEN = (await readFile(process.env.TOKEN_FILE || new URL('./env/browser-client-token-4141', import.meta.url).pathname, 'utf8')).trim()
const WORKDIR = process.env.EMBED_WORKDIR || '/tmp/dsh-embed-minimal'
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
  `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/chrome-minimal-${port}`,
  '--window-size=520,760', 'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logs = []
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
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push(`[console.error] ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${String(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)}`)
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
  await send('Page.enable')
  const params = new URLSearchParams({ token: TOKEN, mode: 'minimal' })
  await send('Page.navigate', { url: `${BASE}/browser-ui/?${params}` })

  let booted = false
  for (let i = 0; i < 120; i++) {
    booted = Boolean(await evaluate(`Boolean(window.__DSH_BOOT__ && window.__DSH_TRANSPORT__ && document.querySelector('#root [data-slot="root"]'))`))
    if (booted) break
    await sleep(250)
  }
  check('embedded WebUI booted in minimal mode', booted)

  const shell = await evaluate(`(() => {
    const mode = document.documentElement.getAttribute('data-dsh-mode')
    const hidden = (sel) => { const el = document.querySelector(sel); return el ? el.getClientRects().length === 0 : true }
    const bg = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backgroundColor : null }
    const frame = document.querySelector('[data-slot="root"] > div')
    return {
      mode,
      embed: document.documentElement.hasAttribute('data-dsh-embed'),
      sidebar: hidden('[data-slot="sidebar"]'),
      leading: hidden('[data-shell-leading]'),
      frameBg: frame ? getComputedStyle(frame).backgroundColor : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      cardBg: (document.querySelector('[data-composer-card]') ? getComputedStyle(document.querySelector('[data-composer-card]')).backgroundColor : null),
      composer: Boolean(document.querySelector('[data-composer-input]'))
    }
  })()`)
  check('minimal mode applied', shell.mode === 'minimal' && shell.embed, JSON.stringify(shell))
  check('sidebar and shell chrome are gone', shell.sidebar && shell.leading)
  check('page is transparent', [shell.frameBg, shell.bodyBg, shell.cardBg].every((c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent'), `${shell.frameBg} / ${shell.bodyBg} / ${shell.cardBg}`)
  check('composer is the only input surface', shell.composer === true)

  let prefilled = { ok: false, text: '' }
  for (let i = 0; i < 12; i++) {
    prefilled = await evaluate(`(() => {
      const ok = window.__DSH_EMBED__.prefill('minimal prefill check')
      return { ok, text: window.__DSH_EMBED__.composerText() }
    })()`)
    if (prefilled && String(prefilled.text).includes('minimal prefill check')) break
    await sleep(200)
  }
  check('selected text can be prefilled', prefilled && prefilled.text.includes('minimal prefill check'), JSON.stringify(prefilled))

  let bind = ''
  for (let i = 0; i < 20; i++) {
    bind = await evaluate(`window.__DSH_EMBED__.bindDir(${JSON.stringify(WORKDIR)})`)
    if (bind) break
    await sleep(250)
  }
  check('workspace binding returns a workspace id', Boolean(bind), String(bind || ''))

  let sessionId
  for (let i = 0; i < 40; i++) {
    sessionId = await evaluate(`(async () => {
      const res = await window.__DSH_TRANSPORT__.fetch('api/session/list', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'embed-min-test', method: 'session/list', payload: { args: { _request: {} } } })
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

  if (sessionId) {
    await evaluate(`(async () => {
      const res = await window.__DSH_TRANSPORT__.fetch('api/session/prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'embed-min-test', method: 'session/prompt', payload: { args: { request: {
          requestId: 'embed-min-' + Date.now(),
          sessionId: ${JSON.stringify(sessionId)},
          mode: 'queue',
          content: [{ type: 'text', text: 'minimal test: no key expected' }]
        } } } })
      })
      return res.status
    })()`)
  }

  let visible = { rows: -1, marked: 0, kinds: [] }
  for (let i = 0; i < 40; i++) {
    visible = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-chat-flow-kind]')]
      const shown = rows.filter((r) => getComputedStyle(r).display !== 'none')
      const composer = document.querySelector('[data-composer-seat]')
      const composerTop = composer ? composer.getBoundingClientRect().top : null
      return {
        rows: shown.length,
        marked: rows.filter((r) => r.hasAttribute('data-dsh-last')).length,
        kinds: shown.map((r) => r.getAttribute('data-chat-flow-kind')),
        composerVisible: composer ? getComputedStyle(composer).display !== 'none' : false,
        anchoredLow: composerTop === null ? false : composerTop > window.innerHeight * 0.3,
        lastKind: window.__DSH_EMBED__.lastKind()
      }
    })()`)
    if (visible.rows === 1) break
    await sleep(250)
  }
  check('only the newest turn stays on screen', visible.rows === 1 && visible.marked === 1, JSON.stringify(visible))
  check('turn content is anchored to the bottom', visible.composerVisible === true && visible.anchoredLow === true, JSON.stringify(visible))

  check('no console errors or exceptions', logs.length === 0, logs.slice(0, 4).join(' | '))

  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(SHOT, Buffer.from(shot.data, 'base64'))
  }
  clean = true
} finally {
  chrome.kill('SIGKILL')
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  for (const c of failed) console.log(`FAILED: ${c.name} ${c.detail}`)
  process.exitCode = 1
}
if (!clean) process.exitCode = 1
