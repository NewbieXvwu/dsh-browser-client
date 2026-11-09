/**
 * upstream.js — translate the extension's stable RPC dialect to the DSH 0.2.2
 * client-connection dialect.
 *
 * The extension (panel.js / dsh-client.js) speaks the *dotted* method names of
 * the 0.1.x apiProxy era and the payload/result shapes of that era:
 *
 *   session.list     { }                             -> { items }
 *   session.create   { workspaceId }                 -> { sessionId }
 *   session.history  { sessionId, maxMessages }      -> { events }
 *   session.prompt   { sessionId, mode, content }    -> { accepted }
 *   session.cancel   { sessionId }                   -> { accepted }
 *   workspace.create { path }                        -> { workspace, created }
 *
 * DSH 0.2.2 mounted a Typert gateway on `connection` instead: endpoints are
 * `namespace/method` (two segments), the wire payload is `{ args }`, and the
 * session controller renamed `history` to `page` and made history records
 * `{ type: 'event', event }`. Keeping the translation here means the browser
 * extension never has to change when the host API evolves again.
 */

/**
 * Renamed endpoints between the 0.1.x apiProxy API and 0.2.2.
 * `session.history` became `session.page` (addressed by SessionAddress).
 * @type {Record<string, string>}
 */
const RENAMED = {
  'session/history': 'session/page'
}

/**
 * Map one extension method to the upstream endpoint.
 * `workflow.*` and other plugin-owned methods are handled locally before this
 * function is called; everything else is a dotted `namespace.method` alias.
 * @param {string} method
 * @returns {string}
 */
export function toUpstreamEndpoint(method) {
  if (method.includes('/')) return RENAMED[method] ?? method
  const dot = method.indexOf('.')
  if (dot === -1) return method
  const endpoint = `${method.slice(0, dot)}/${method.slice(dot + 1)}`
  return RENAMED[endpoint] ?? endpoint
}

/**
 * Adapt the extension payload to the upstream request record.
 * @param {string} endpoint
 * @param {Record<string, unknown>} payload
 */
export function adaptUpstreamRequest(endpoint, payload) {
  const request = { ...(payload || {}) }

  // 0.2.2: session.history -> session.page, addressed by a discriminated
  // SessionAddress instead of a bare sessionId.
  if (endpoint === 'session/page' && request.sessionId !== undefined) {
    request.address = { kind: 'session', sessionId: request.sessionId }
    delete request.sessionId
  }

  // 0.2.2: every prompt carries a client-minted requestId for idempotency.
  if (endpoint === 'session/prompt' && request.requestId === undefined) {
    request.requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
  }

  return request
}

/**
 * Adapt the upstream result value back to what the extension expects.
 * @param {string} endpoint
 * @param {unknown} value
 */
export function adaptUpstreamResult(endpoint, value) {
  // 0.2.2: a page carries `records` of `{ type:'event', event }`; the panel's
  // foldHistory reads `page.events` with exactly that record shape.
  if (endpoint === 'session/page' && value && typeof value === 'object' && Array.isArray(value.records)) {
    return { ...value, events: value.records }
  }
  return value
}

/**
 * Typert's wire arguments are named after the *method parameters*, so every
 * unary controller call arrives as `{ request: {...} }` (the parameter is
 * literally called `request`). `session.list` is the one documented outlier:
 * its parameter is `_request`.
 *
 * The table is a starting point, not a contract: `learnArgName` upgrades it
 * from the gateway's own "missing \"X\"" error, so a future rename self-heals
 * on the first call instead of breaking the extension.
 * @type {Map<string, string>}
 */
const ARG_NAMES = new Map([
  ['session/list', '_request'],
  ['session/search', '_request'],
  ['session/create', 'request'],
  ['session/page', 'request'],
  ['session/prompt', 'request'],
  ['session/cancel', 'request'],
  ['session/rename', 'request'],
  ['session/fork', 'request'],
  ['workspace/create', 'request']
])

/** Named-argument wrapper the gateway accepts for one endpoint. */
export function wireArguments(endpoint, payload) {
  const name = ARG_NAMES.get(endpoint) ?? 'request'
  return { [name]: adaptUpstreamRequest(endpoint, payload) }
}

/**
 * Learn an endpoint's argument name from a gateway validation error.
 * @param {string} endpoint
 * @param {string} message
 * @returns {boolean} whether the table changed (i.e. a retry is worthwhile)
 */
export function learnArgName(endpoint, message) {
  const match = /missing "([^"]+)"/.exec(String(message || ''))
  if (!match) return false
  const name = match[1]
  if (ARG_NAMES.get(endpoint) === name) return false
  ARG_NAMES.set(endpoint, name)
  return true
}

