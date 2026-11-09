#!/usr/bin/env node
/**
 * embed-shell-test.mjs — the content script (floating window shell) contract.
 *
 * Loads the real `content/content.js` into a plain page with a mocked
 * `chrome.*` API and drives the messages background.js sends, asserting the
 * window opens, toggles, closes on Escape, closes on an outside click, resizes
 * from `dsh:size`, and switches presentation without reloading the iframe.
 *
 * Usage: node test/embed-shell-test.mjs
 * Requires a booted instance: ./test/verify-boot.sh 4145
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.SHELL_PORT || 8903)
const CDP_PORT = Number(process.env.CDP_PORT || 9860)
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:4145'
const TOKEN = (await readFile(process.env.TOKEN_FILE || new URL('./env/browser-client-token-4145', import.meta.url).pathname, 'utf8')).trim()

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/harness') {
    const html = await readFile(join(ROOT, 'test/env/shell-harness.html'), 'utf8')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
    return
  }
  const path = normalize(join(ROOT, decodeURIComponent(url.pathname)))
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return }
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=/tmp/dsh-shell-${process.pid}`,
  '--window-size=900,700', 'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const watchdog = setTimeout(() => { console.error('WATCHDOG'); process.exit(3) }, 120000)

let target
for (let i = 0; i < 80; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
    target = list.find((t) => t.type === 'page')
    if (target) break
  } catch {}
  await sleep(200)
}
if (!target) throw new Error('no CDP page')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => ws.once('open', resolve))
let seq = 0
const pending = new Map()
const consoleErrors = []
ws.on('message', (raw) => {
  const msg = JSON.parse(raw)
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails?.exception?.description || 'exception')
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '))
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  const timer = setTimeout(() => resolve({ timeout: true }), 10000)
  pending.set(id, (result) => { clearTimeout(timer); resolve(result) })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed')
  if (result?.timeout) throw new Error('evaluate timeout')
  return result?.result?.value
}

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/harness?token=${encodeURIComponent(TOKEN)}&base=${encodeURIComponent(BASE)}` })
await sleep(1200)

const state = () => evaluate(`(() => {
  const host = document.getElementById('dsh-browser-client-root')
  if (!host) return { present: false, visible: false, mode: null, height: 0, ready: false }
  return {
    present: true,
    visible: host.getAttribute('data-dsh-visible') === 'true',
    mode: host.getAttribute('data-dsh-mode'),
    height: Number(host.getAttribute('data-dsh-height') || 0),
    ready: host.getAttribute('data-dsh-ready') === 'true'
  }
})()`)

// 1. nothing is on screen until summoned
let st = await state()
check('starts hidden (no always-on launcher)', st.visible === false, st)

// 2. keyboard shortcut / toolbar path: background sends dsh:open
await evaluate(`window.__emit({ type: 'dsh:open', mode: 'minimal' })`)
await sleep(1500)
st = await state()
check('opens on dsh:open', st.visible === true, st)
check('host page reports ready', st.ready === true, st)
check('minimal presentation', st.mode === 'minimal', st.mode)

// 3. Escape closes
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(500)
st = await state()
check('Escape closes', st.visible === false, st)

// 4. toggle opens again and outside click closes
await evaluate(`window.__emit({ type: 'dsh:toggle' })`)
await sleep(900)
st = await state()
check('dsh:toggle reopens', st.visible === true, st)
await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))`)
await sleep(400)
st = await state()
check('page click closes', st.visible === false, st)

// 5. mode switch keeps the same iframe (no reload)
await evaluate(`window.__emit({ type: 'dsh:open', mode: 'minimal' })`)
await sleep(1200)
await evaluate(`window.__emit({ type: 'dsh:toggle-mode' })`)
await sleep(700)
const afterSwitch = await state()
check('toggle-mode switches presentation', afterSwitch.mode === 'standard', afterSwitch.mode)
check('toggle-mode keeps the page loaded', afterSwitch.ready === true, afterSwitch)

// 6. dsh:size from the page drives the frame height
await evaluate(`window.postMessage({ type: 'dsh:size', height: 300 }, '*')`)
await sleep(800)
const sized = await state()
check('height follows dsh:size', sized.height >= 200, sized)

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3))

clearTimeout(watchdog)
chrome.kill()
ws.close()
await new Promise((resolve) => server.close(resolve))
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
