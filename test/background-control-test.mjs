import { WebSocketServer } from 'ws'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../browser-ext/extension/background/background.js', import.meta.url), 'utf8')
const port = 9500 + Math.floor(Math.random() * 300)
const server = new WebSocketServer({ port })
const calls = []
let socket
const received = []
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out waiting for tool-response')), 8000)
  server.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw))
      received.push(frame)
      if (frame.kind === 'tool-response') {
        clearTimeout(timer)
        resolve(frame)
      }
    })
    ws.send(JSON.stringify({ kind: 'status', state: 'connected' }))
    setTimeout(() => ws.send(JSON.stringify({ kind: 'tool-request', requestId: 'r1', tool: 'page_snapshot', args: {} })), 150)
  })
})

const listeners = []
const chrome = {
  storage: {
    local: { get: async () => ({ dshConfig: { baseUrl: `ws://127.0.0.1:${port}`, token: 't', rules: [] } }), set: async () => {} },
    onChanged: { addListener: () => {} },
  },
  tabs: {
    query: async () => [{ id: 7, url: 'https://example.com', active: true }],
    get: async () => ({ id: 7 }),
    sendMessage: async (tabId, message) => {
      calls.push({ tabId, message })
      return { ok: true, result: { text: 'snapshot' } }
    },
    onRemoved: { addListener: () => {} },
  },
  action: { onClicked: { addListener: () => {} }, setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  commands: { onCommand: { addListener: () => {} } },
  contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
  runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} }, sendMessage: async () => ({ ok: true }) },
  windows: { create: async () => ({}) },
  webNavigation: { onCompleted: { addListener: () => {} } },
}

const context = {
  chrome,
  WebSocket,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  fetch: async () => ({ ok: true }),
}
vm.createContext(context)
vm.runInContext(source, context)
context.__setTarget = (id) => { context.control ? undefined : undefined }

const frame = await done
assert.equal(frame.kind, 'tool-response')
assert.equal(frame.requestId, 'r1')
assert.equal(frame.ok, true)
assert.deepEqual(frame.result, { ok: true, result: { text: 'snapshot' } }.result)
assert.equal(calls.length, 1)
assert.equal(calls[0].message.type, 'dsh:tool')
assert.equal(calls[0].message.tool, 'page_snapshot')
console.log('background control test PASSED')
socket.close()
await new Promise((r) => server.close(r))
process.exit(0)
