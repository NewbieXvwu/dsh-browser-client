/**
 * extension-flow-test.mjs — verify the host plugin against DSH 0.2.2 using
 * exactly the RPC dialect the browser extension speaks (dotted method names,
 * 0.1.x payloads). This is the regression test for lib/upstream.js: it proves
 * the translation layer keeps the panel working without touching it.
 *
 * Requires a verification instance booted by test/verify-boot.sh:
 *   DSH_BASE=http://127.0.0.1:4124 \
 *   TOKEN_FILE=test/env/browser-client-token-4124 \
 *   node test/extension-flow-test.mjs
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:4101'
const TOKEN_FILE = process.env.TOKEN_FILE || new URL('./env/browser-client-token-4101', import.meta.url).pathname
const token = readFileSync(TOKEN_FILE, 'utf8').trim()

const call = async (method, payload = {}) => {
  const res = await fetch(`${BASE}/ext-api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ rpcId: crypto.randomUUID(), method, payload })
  })
  const body = await res.json()
  return body.result
}

const ok = async (method, payload, check) => {
  const result = await call(method, payload)
  if (!result || result.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(result && result.error)}`)
  if (check) check(result.value)
  console.log(`✓ ${method}`)
  return result.value
}

const fail = async (method, payload, expectedCode) => {
  const result = await call(method, payload)
  if (!result || result.ok !== false) throw new Error(`${method} unexpectedly succeeded`)
  if (expectedCode && result.error.code !== expectedCode) {
    throw new Error(`${method}: expected ${expectedCode}, got ${result.error.code}: ${result.error.message}`)
  }
  console.log(`✓ ${method} → ${result.error.code}: ${result.error.message.slice(0, 80)}`)
}

const health = await fetch(`${BASE}/ext-api-health`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json())
if (!health.ok) throw new Error('health check failed')
console.log('✓ health')

const dir = mkdtempSync(join(tmpdir(), 'dsh-ext-'))
const workspace = await ok('workspace.create', { path: dir }, v => {
  if (!v.workspace || !v.workspace.workspaceId) throw new Error('workspace.create returned no workspaceId')
  if (typeof v.created !== 'boolean') throw new Error('workspace.create returned no created flag')
})

const session = await ok('session.create', { workspaceId: workspace.workspace.workspaceId }, v => {
  if (typeof v.sessionId !== 'string') throw new Error('session.create returned no sessionId')
})

const list = await ok('session.list', {}, v => {
  if (!Array.isArray(v.items)) throw new Error('session.list returned no items array')
  if (!v.items.some(item => item.sessionId === session.sessionId)) throw new Error('created session missing from list')
})

await ok('session.history', { sessionId: session.sessionId, maxMessages: 50 }, v => {
  if (!Array.isArray(v.events)) throw new Error('session.history did not expose an events array')
  for (const record of v.events) {
    if (!record.event || typeof record.event.type !== 'string') throw new Error('history record is not { event: { type } }')
  }
})

await ok('session.prompt', {
  sessionId: session.sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '扩展适配自检：只需回复 ok' }],
  clientTimeZone: 'Asia/Shanghai'
}, v => {
  if (v.accepted !== true) throw new Error('session.prompt was not accepted')
})

await ok('session.cancel', { sessionId: session.sessionId }, v => {
  if (v.accepted !== true) throw new Error('session.cancel was not accepted')
})

await ok('workflow.templates', {}, v => {
  if (!v || !Array.isArray(v.items)) throw new Error('workflow.templates is not handled locally')
})

await fail('session.doesNotExist', { sessionId: session.sessionId }, 'upstream-status')

console.log('\nALL EXTENSION-FLOW CHECKS PASSED')
console.log(`session ${session.sessionId} (${list.items.length} listed)`)
