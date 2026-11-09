/**
 * dsh-browser-host — host-side bridge for the DSH Browser Client extension.
 *
 * DSH 0.2.2 serves browsers through the client-connection transport:
 * `POST /api/<namespace>/<method>` (Typert RPC) plus the `/api/remote.mux`
 * object stream. Every one of those requests passes the same-origin
 * browser-trust fence in @deepseek-ai/dsh-client-connection: the Host header
 * must be a loopback/trusted authority AND the Origin header must equal the
 * Host, with Sec-Fetch-Site: cross-site rejected outright. A browser-extension
 * page (chrome-extension://<id>/panel.html) can never satisfy that — its
 * Origin is the extension id, not 127.0.0.1:3080.
 *
 * This plugin opens a separate, token-authenticated surface that the extension
 * can reach from any page (cross-origin is fine because WE attach the CORS
 * headers ourselves):
 *
 *   POST /ext-api/<method>            RPC proxy — same envelope as /api,
 *                                     dispatched through the official
 *                                     `connection.createSharedFetchHandler('/api')`
 *                                     with the owner `browserPeer`
 *   GET  /ext-events.mux?token=…      WebSocket pump of Cordis session events
 *                                     (`session/event`, `session/created`,
 *                                     `session/disposed`) — the extension keeps
 *                                     one socket open
 *   GET  /ext-events.host?token=…     WebSocket pump of session lifecycle events
 *   GET  /ext-api-control?token=…     WebSocket BIDIRECTIONAL control channel:
 *                                     host pushes tool requests down, the
 *                                     extension pushes tool responses up
 *   GET  /ext-api-health?token=…      trivial { ok: true } health check
 *
 * The control channel is what turns the extension from a passive event
 * consumer into a page-operation backend: the harness registers page.* tools
 * whose execute() sends a tool request over the control channel, waits for the
 * extension (which runs the request in the real page via content script), and
 * resolves with the result.
 *
 * Auth: the token is a random 32-byte hex minted at boot (persisted to the
 * configured tokenFile when persistToken is true — default
 * $DSH_HOME/browser-client-token) and printed in the boot log. It is passed via
 * `Authorization: Bearer <token>` on HTTP and as a `token` query parameter on
 * the WebSocket upgrade (a browser cannot set an Authorization header on a
 * WebSocket handshake).
 *
 * Everything here is delivered as a normal Cordis plugin: we register routes
 * on the `webServer` service, forward RPC through the official client
 * connection transport (`ctx.get('connection').createSharedFetchHandler`) —
 * exactly the handler the official `/api` route uses — and pump Cordis session
 * events over a `ws` WebSocketServer. No core package is modified.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import z from '@deepseek-ai/schemastery'
import { createToolBridge } from './bridge.js'
import { createPageTools } from './tools.js'
import { toUpstreamEndpoint, wireArguments, adaptUpstreamResult, learnArgName } from './upstream.js'
import { mountUiPage } from './ui-page.js'
import { mountMuxProxy } from './mux-proxy.js'
import { mountWorkflows } from './workflow/index.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-browser-host'

/** Services that must exist before we register routes. */
export const inject = ['webServer']

// Respect DSH_HOME so isolated verification instances (test/verify-boot.sh)
// mint their own token instead of sharing the real profile's.
const DEFAULT_TOKEN_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const DEFAULT_TOKEN_FILE = join(DEFAULT_TOKEN_DIR, 'browser-client-token')

/**
 * Read the persisted token, or mint + persist a fresh one.
 * @param persist - whether to write the token to disk.
 */
async function loadOrCreateToken(persist, tokenFile) {
  if (persist) {
    try {
      const existing = await readFile(tokenFile, 'utf8')
      const trimmed = existing.trim()
      if (/^[0-9a-f]{32,}$/.test(trimmed)) return trimmed
    } catch { /* first boot */ }
  }
  const token = randomBytes(32).toString('hex')
  if (persist) {
    try {
      await mkdir(dirname(tokenFile), { recursive: true })
      await writeFile(tokenFile, token, { mode: 0o600 })
    } catch (err) {
      console.warn(`[dsh-browser-host] cannot persist token to ${tokenFile}: ${err}`)
    }
  }
  return token
}

/** Timing-safe string compare for the bearer token. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Read the whole request body as a Buffer. */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** Send a JSON response. */
function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  })
  res.end(payload)
}

/**
 * Whether an Origin header is a browser-extension page origin we serve, or one
 * the operator explicitly allow-listed through `extraOrigins` (dev pages).
 */
function isAllowedOrigin(origin, extraOrigins = []) {
  if (typeof origin !== 'string') return false
  if (Array.isArray(extraOrigins) && extraOrigins.includes(origin)) return true
  // Chrome / Edge / Brave: chrome-extension://<32-hex-id>
  // Firefox: moz-extension://<uuid>
  // Safari: safari-extension://<id> (web-extension flavor uses chrome-extension in Safari 15+)
  if (/^chrome-extension:\/\/[A-Za-z0-9]+$/.test(origin)) return true
  if (/^moz-extension:\/\/[A-Za-z0-9-]+$/.test(origin)) return true
  if (/^safari-extension:\/\/[A-Za-z0-9-]+$/.test(origin)) return true
  return false
}

/** A plain JSON object (not array/null/class instance). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

/**
 * Build an AsyncIterable of extension frames from one family of Cordis events.
 *
 * DSH 0.2.2 removed the old `apiProxy.events.mux` stream; the canonical source
 * of live session activity is the `session/event` Cordis event (plus
 * `session/created` / `session/disposed`). We bridge it to the extension's
 * existing frame shape so the panel needs no change:
 *
 *   { type: 'session/event', sessionId, event }
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string[]} names - Cordis event names to forward.
 * @param {(name: string, args: unknown[]) => object} frame
 */
function cordisEventFrames(ctx, names, frame) {
  return (signal) => {
    const queue = []
    let wake = null
    let done = false

    const push = (f) => {
      if (done) return
      queue.push(f)
      const w = wake
      wake = null
      if (w !== undefined) w()
    }
    const offs = names.map((name) =>
      ctx.on(name, (...args) => push(frame(name, args)))
    )
    const onAbort = () => {
      done = true
      const w = wake
      wake = null
      if (w !== undefined) w()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    return (async function* pump() {
      try {
        while (!done) {
          if (queue.length === 0) {
            await new Promise((resolve) => {
              // An abort can land between the `done` check above and this
              // executor; resolve immediately in that case instead of parking
              // a promise nothing will ever wake.
              if (done) resolve()
              else wake = resolve
            })
          }
          while (queue.length > 0 && !done) yield queue.shift()
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        for (const off of offs) {
          try { off() } catch { /* already gone */ }
        }
      }
    })()
  }
}

/** Live session event stream (the panel's mux). */
function sessionEventStream(ctx) {
  return cordisEventFrames(ctx, ['session/event'], (name, args) => {
    const [session, event] = args
    return { type: 'session/event', sessionId: session && session.id, event }
  })
}

/** Session lifecycle stream (the panel's host stream; kept for compatibility). */
function sessionLifecycleStream(ctx) {
  return cordisEventFrames(ctx, ['session/created', 'session/disposed'], (name, args) => {
    const [session] = args
    return { type: name, sessionId: session && session.id }
  })
}


/**
 * Cordis plugin entry. Registered as a host row in cordis.patch.yml; config
 * keys are validated by the loader (see Config below).
 */
async function apply(ctx, config) {
  const extPrefix = config.extPrefix
  const extEventsPath = config.extEventsPath
  const tokenFile = config.tokenFile || DEFAULT_TOKEN_FILE
  const token = await loadOrCreateToken(config.persistToken, tokenFile)

  console.log(`[dsh-browser-host] extension token: ${token}`)
  console.log(`[dsh-browser-host] extension surface: ${extPrefix}/* (HTTP RPC), ${extEventsPath} (WS events), ${extPrefix}-control (tool channel)`)

  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.warn('[dsh-browser-host] webServer not available; extension surface disabled')
    return
  }

  const disposers = []

  // The embed route that serves the real WebUI to the floating window.
  const uiPrefix = typeof config.uiPrefix === 'string' && config.uiPrefix !== '' ? config.uiPrefix : '/browser-ui'
  const harnessOrigin = () => {
    try {
      return webServer.getOrigin()
    } catch {
      return `${webServer.protocol || 'http:'}//${webServer.host}`
    }
  }
  // The embed page is served from the harness origin itself, so its own
  // origin is a first-class client for the token surface (Bearer auth still
  // applies — this only opens CORS and the WS Origin fence).
  const originAllowed = (origin) => isAllowedOrigin(origin, extraOrigins)
    || (typeof origin === 'string' && origin === harnessOrigin())

  // CORS for extension-page origins (we attach it ourselves because the
  // browser enforces CORS on fetch() from the extension page, and the harness
  // /api fence would otherwise 403 these requests at the transport layer).
  const extraOrigins = Array.isArray(config.extraOrigins) ? config.extraOrigins : []
  const corsHeaders = (origin) => {
    if (!originAllowed(origin)) return {}
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-expose-headers': '*',
      'access-control-max-age': '600'
    }
  }

  // ── HTTP RPC proxy: POST /ext-api/<method> ────────────────────────────────
  // Local (custom) method handlers registered by subsystems (workflow.*).
  const localRpcHandlers = new Map()

  // The official client-facing transport. `createSharedFetchHandler('/api')`
  // returns the same fetch handler the official `/api` route mounts: it
  // resolves the endpoint to the Typert gateway interceptor and dispatches
  // with the Peer we pass in. We hand it `connection.browserPeer` (the owner
  // Peer every authenticated browser connection shares), so the extension sees
  // exactly the same access rules as the in-page client. Cached per service
  // instance so a profile reload picks up a fresh handler.
  let sharedHandler = null
  let sharedHandlerOwner = null
  const sharedFetchFor = (connection) => {
    if (sharedHandlerOwner !== connection) {
      sharedHandler = connection.createSharedFetchHandler('/api')
      sharedHandlerOwner = connection
    }
    return sharedHandler
  }

  const rpcHandler = async (req, res) => {
    try {
    const origin = req.headers.origin
    const cors = corsHeaders(origin)

    if (req.method === 'OPTIONS') {
      if (cors['access-control-allow-origin'] === undefined) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
      res.writeHead(204, { ...cors, 'content-length': '0' })
      res.end()
      return
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' }, cors)

    const auth = req.headers.authorization || ''
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!safeEqual(presented, token)) return sendJson(res, 401, { ok: false, error: 'invalid token' }, cors)

    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.createSharedFetchHandler !== 'function' || connection.browserPeer === undefined) {
      return sendJson(res, 503, { ok: false, error: 'connection service unavailable (client-connection not mounted)' }, cors)
    }

    const pathname = new URL(req.url, 'http://x').pathname
    const method = pathname.startsWith(`${extPrefix}/`) ? pathname.slice(extPrefix.length + 1) : undefined
    if (method === undefined || method === '') return sendJson(res, 404, { ok: false, error: 'method missing' }, cors)

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') return sendJson(res, 415, { ok: false, error: 'content type must be application/json' }, cors)

    let envelope
    try {
      envelope = JSON.parse((await readBody(req)).toString('utf8'))
    } catch {
      return sendJson(res, 400, { ok: false, error: 'body is not JSON' }, cors)
    }
    if (!envelope || typeof envelope !== 'object' || typeof envelope.rpcId !== 'string' || typeof envelope.method !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'envelope must be { rpcId, method, payload }' }, cors)
    }
    // The official transport requires the envelope method to equal the URL
    // endpoint; mirror that here so a mismatched call fails loudly.
    if (envelope.method !== method) {
      return sendJson(res, 400, { ok: false, error: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}` }, cors)
    }

    // Local (custom) methods are handled by the plugin itself; anything else
    // is dispatched through the official client-connection transport, which
    // resolves it to the Typert gateway exactly like /api does.
    const localHandler = localRpcHandlers.get(method)
    if (localHandler) {
      try {
        const value = await localHandler(envelope.payload ?? {})
        const body = JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors })
        res.end(body)
      } catch (err) {
        const body = JSON.stringify({
          type: 'server-response', rpcId: envelope.rpcId,
          result: { ok: false, error: { code: 'workflow-error', message: String(err && err.message || err) } }
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors })
        res.end(body)
      }
      return
    }

    // Two callers, two dialects, one upstream:
    //
    //   * the extension speaks the stable dotted dialect (`session.list`,
    //     0.1.x-shaped payloads); we translate it into `${namespace}/${method}`
    //     plus `{ args: { <parameter-name>: <request> } }`;
    //   * the embedded WebUI speaks the gateway dialect verbatim: its payload
    //     is already exactly `{ args: … }`, and its responses may be
    //     `multipart/form-data`, not just JSON.
    //
    // Both are forwarded through the official shared fetch handler, so the
    // access rules are identical to `/api`.
    const payload = envelope.payload ?? {}
    const gatewayDialect = isPlainObject(payload) && Object.keys(payload).length === 1 && isPlainObject(payload.args)
    const endpoint = gatewayDialect ? method : toUpstreamEndpoint(method)
    const handler = sharedFetchFor(connection)

    const callUpstream = async (wirePayload) => {
      // Do NOT forward `req.signal`: Node's IncomingMessage signal aborts once
      // the request body has been consumed, which the gateway would report as
      // `gateway/cancelled` and mask the real business error.
      const upstream = new Request(`http://dsh.internal/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: envelope.rpcId, method: endpoint, payload: wirePayload })
      })
      const response = await handler.fetch(upstream, connection.browserPeer)
      const status = response.status
      const responseType = response.headers.get('content-type') || ''
      const bytes = Buffer.from(await response.arrayBuffer())
      return { status, contentType: responseType, bytes }
    }

    const forwardRaw = (outcome) => {
      res.writeHead(outcome.status, {
        'content-type': outcome.contentType || 'application/octet-stream',
        'cache-control': 'no-store',
        ...cors,
        'content-length': outcome.bytes.length
      })
      res.end(outcome.bytes)
    }

    if (gatewayDialect) {
      // The WebUI path: pass the envelope through untouched and stream the
      // response back byte-for-byte, so JSON envelopes, multipart attachment
      // downloads and plain-text gateway errors all reach the page intact.
      forwardRaw(await callUpstream({ args: payload.args }))
      return
    }

    let outcome = await callUpstream({ args: wireArguments(endpoint, payload) })
    // Typert names wire arguments after the controller method parameters. If a
    // future DSH renames one, learn it from the gateway's validation error and
    // retry once instead of failing the extension call.
    const parseOutcome = (o) => {
      if (!/application\/json/i.test(o.contentType)) return undefined
      try {
        return JSON.parse(o.bytes.toString('utf8'))
      } catch {
        return undefined
      }
    }
    let parsed = parseOutcome(outcome)
    const firstError = parsed?.result?.ok === false ? parsed.result.error : undefined
    if (firstError && firstError.code === 'gateway/arguments-invalid' && learnArgName(endpoint, firstError.message)) {
      outcome = await callUpstream({ args: wireArguments(endpoint, payload) })
      parsed = parseOutcome(outcome)
    }

    if (parsed === undefined) {
      // The gateway answers unknown/unclaimed endpoints with a plain-text 404
      // ("not found"). Surface that as a proper RPC error so the extension
      // shows a readable message instead of a JSON parse failure.
      const text = outcome.bytes.toString('utf8').trim() || `upstream status ${outcome.status}`
      return sendJson(res, 200, {
        type: 'server-response', rpcId: envelope.rpcId,
        result: { ok: false, error: { code: 'upstream-status', message: `${text} (${outcome.status})` } }
      }, cors)
    }

    if (parsed && parsed.result && parsed.result.ok === true) {
      parsed.result.value = adaptUpstreamResult(endpoint, parsed.result.value)
    }
    const adapted = Buffer.from(JSON.stringify(parsed))
    res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors, 'content-length': adapted.length })
    res.end(adapted)
    } catch (err) {
      console.error(`[dsh-browser-host] rpcHandler error: ${err && err.stack || err}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: `handler error: ${String(err && err.message || err)}` }, cors)
      else res.destroy()
    }
  }

  // ── WebSocket event pumps: GET /ext-events.mux?token=… etc ────────────────
  // One `ws` server handles both upgrade paths; each socket pumps one stream.
  const wss = new WebSocketServer({ noServer: true })

  const pumpStream = async (req, socket, head, streamFactory) => {
    const url = new URL(req.url, 'http://x')
    if (!safeEqual(url.searchParams.get('token') || '', token)) {
      socket.end([
        'HTTP/1.1 401 Unauthorized',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'invalid token'
      ].join('\r\n'))
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined && !originAllowed(origin)) {
      socket.end([
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'origin not allowed'
      ].join('\r\n'))
      return
    }

    wss.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      websocket.once('close', () => abort.abort())
      websocket.once('error', () => abort.abort())
      // Downlink only: any client message is a protocol violation.
      websocket.on('message', () => websocket.close(1008, 'downlink only'))

      const send = (payload) => {
        if (websocket.readyState !== websocket.OPEN) return
        // The extension reads `msg.payload`; keep the envelope shape stable even
        // though the frames now originate from Cordis events instead of apiProxy.
        websocket.send(JSON.stringify({ rpcId: 'ext-events', payload }))
      }

      const pump = (async () => {
        try {
          for await (const frame of streamFactory(abort.signal)) send(frame)
        } catch (err) {
          if (!abort.signal.aborted) {
            try {
              send({ type: 'stream/error', error: { code: 'internal', message: String(err), details: {} } })
            } catch { /* socket gone */ }
          }
        } finally {
          abort.abort()
          try { websocket.close() } catch { /* already closed */ }
        }
      })()
    })
  }

  // ── route registration ─────────────────────────────────────────────────────
  const wsOnlyRoute = (path) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      res.writeHead(426, { connection: 'Upgrade', upgrade: 'websocket' })
      res.end('upgrade required')
    }
  })
  const hostEventsPath = extEventsPath.replace(/\.mux$/, '.host')
  const routes = [
    { kind: 'prefix', path: extPrefix, handler: rpcHandler },
    wsOnlyRoute(extEventsPath),
    ...(hostEventsPath === extEventsPath ? [] : [wsOnlyRoute(hostEventsPath)]),
    {
      kind: 'exact',
      path: `${extPrefix}-health`,
      handler: async (req, res) => {
        const origin = req.headers.origin
        const cors = corsHeaders(origin)
        if (req.method === 'OPTIONS') {
          // Allow-listed non-extension origins (dev pages) must preflight the
          // Authorization header before the actual health GET.
          res.writeHead(204, cors)
          return res.end()
        }
        const auth = req.headers.authorization || ''
        const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!safeEqual(presented, token)) return sendJson(res, 401, { ok: false, error: 'invalid token' }, cors)
        return sendJson(res, 200, { ok: true, host: 'dsh-browser-host', tokenPrefix: presented.slice(0, 8) + '…' }, cors)
      }
    }
  ]

  for (const route of routes) {
    try {
      const dispose = webServer.register(route)
      disposers.push(dispose)
    } catch (err) {
      console.warn(`[dsh-browser-host] failed to register route ${route.path}: ${err}`)
    }
  }

  // ── Embedded WebUI: GET /browser-ui/?token=… ───────────────────────────────
  // The floating window is no longer a hand-written panel: it loads the very
  // WebUI the harness serves at `/`, fetched in process through
  // `webServer.readResource(…, connection.browserPeer)` so we get the real
  // index with the real boot graph. `lib/ui-page.js` owns that route; the page
  // stays on the harness origin, so assets, `/plugins/*` bundles and the MV3
  // CSP issue all disappear.
  const uiLog = (msg) => console.log(`[dsh-browser-host] ${msg}`)
  try {
    disposers.push(mountUiPage({
      webServer,
      getConnection: () => ctx.get('connection'),
      token,
      uiPrefix,
      extPrefix,
      safeEqual,
      log: uiLog
    }))
    console.log(`[dsh-browser-host] embedded WebUI: ${uiPrefix}/?token=… (served by the harness itself)`)
  } catch (err) {
    console.warn(`[dsh-browser-host] failed to mount embedded WebUI at ${uiPrefix}: ${err}`)
  }

  // The WebUI streams session activity over `/api/remote.mux`, which sits
  // behind the harness cookie fence. `lib/mux-proxy.js` performs the official
  // `/connect` handshake in process (per socket) and pipes frames both ways.
  let muxProxy
  try {
    muxProxy = mountMuxProxy({
      webServer,
      getConnection: () => ctx.get('connection'),
      token,
      uiPrefix,
      safeEqual,
      originAllowed,
      log: uiLog
    })
    disposers.push(webServer.registerUpgrade({ path: muxProxy.path, handler: muxProxy.handler }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: muxProxy.path,
      handler: async (req, res) => {
        res.writeHead(426, { connection: 'Upgrade', upgrade: 'websocket' })
        res.end('upgrade required')
      }
    }))
  } catch (err) {
    console.warn(`[dsh-browser-host] failed to mount mux proxy ${uiPrefix}-mux: ${err}`)
  }

  // ── WebSocket upgrade routes ───────────────────────────────────────────────
  // The mux socket carries live session activity; the host socket carries
  // session lifecycle. Both are derived from Cordis events now — DSH 0.2.2 no
  // longer exposes `apiProxy.events.mux`/`.host`.
  const upgradeRoutes = [{ path: extEventsPath, stream: sessionEventStream(ctx) }]
  if (hostEventsPath !== extEventsPath) {
    upgradeRoutes.push({ path: hostEventsPath, stream: sessionLifecycleStream(ctx) })
  }
  for (const { path, stream } of upgradeRoutes) {
    try {
      const dispose = webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => pumpStream(req, socket, head, stream)
      })
      disposers.push(dispose)
    } catch (err) {
      console.warn(`[dsh-browser-host] failed to register upgrade route ${path}: ${err}`)
    }
  }

  // ── Bidirectional control channel: GET /ext-control?token=… ────────────────
  // Unlike the downlink-only event pumps above, this socket accepts messages
  // from the extension: tool-response frames answering host tool requests.
  // The extension panel holds exactly one such socket open for the lifetime of
  // the panel (panel open == extension connected == page tools available).
  const controlPath = `${extPrefix}-control`
  const controlWss = new WebSocketServer({ noServer: true })
  const toolBridge = createToolBridge({ log: (msg) => console.log(`[dsh-browser-host] ${msg}`) })

  const controlUpgrade = (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (!safeEqual(url.searchParams.get('token') || '', token)) {
      socket.end([
        'HTTP/1.1 401 Unauthorized',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'invalid token'
      ].join('\r\n'))
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined && !originAllowed(origin)) {
      socket.end([
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'origin not allowed'
      ].join('\r\n'))
      return
    }
    controlWss.handleUpgrade(req, socket, head, (websocket) => {
      toolBridge.attach(websocket)
    })
  }

  // HTTP fallback for the control path (non-upgrade requests)
  const controlHttpHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    res.writeHead(426, { connection: 'Upgrade', upgrade: 'websocket' })
    res.end('upgrade required')
  }

  try {
    const dispose = webServer.registerUpgrade({ path: controlPath, handler: controlUpgrade })
    disposers.push(dispose)
    const disposeHttp = webServer.register({ kind: 'exact', path: controlPath, handler: controlHttpHandler })
    disposers.push(disposeHttp)
  } catch (err) {
    console.warn(`[dsh-browser-host] failed to register control route ${controlPath}: ${err}`)
  }

  // ── page.* tools (page understanding + operation, executed in the extension) ─
  const registeredTools = []
  const toolsService = ctx.get('tools')
  if (toolsService !== undefined) {
    const tools = createPageTools(toolBridge, { timeoutMs: config.toolTimeoutMs })
    for (const tool of tools) {
      try {
        registeredTools.push(toolsService.register(tool))
        console.log(`[dsh-browser-host] registered tool ${tool.name}`)
      } catch (err) {
        console.warn(`[dsh-browser-host] failed to register tool ${tool.name}: ${err}`)
      }
    }
  } else {
    console.warn('[dsh-browser-host] tools service not available; page.* tools disabled')
  }

  // ── workflow subsystem (durable store + RPC + commands) ─────────────────────
  let workflowsDispose = null
  try {
    const wf = await mountWorkflows(ctx, {
      harness: {
        handle: (method, fn) => { localRpcHandlers.set(method, fn); return () => localRpcHandlers.delete(method) },
        unhandle: (method) => { localRpcHandlers.delete(method) }
      },
      tools: toolsService,
      skills: ctx.get('skills'),
      toolTimeoutMs: config.toolTimeoutMs,
      bridge: toolBridge,
      ctxServices: {
        askUser: async (req) => {
          // Ask the user through the panel: send an ask-request over the
          // control channel; the panel shows a dialog and replies with the
          // selected answer (or custom text).
          const question = req.question || '请确认'
          const options = Array.isArray(req.options) ? req.options.map((o) => (typeof o === 'object' ? o.label : String(o))) : []
          const answer = await toolBridge.requestAsk(question, {
            detail: req.detail || '',
            options
          })
          return answer
        }
      },
      log: (m) => console.log(`[dsh-browser-host] ${m}`)
    })
    workflowsDispose = wf.dispose
    // Expose the store so the executor can read saved definitions.
    ctx.provide('dshWorkflowStore', wf.store)
  } catch (err) {
    console.warn(`[dsh-browser-host] workflow subsystem failed: ${err && err.stack || err}`)
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already gone */ }
    }
    for (const dispose of registeredTools) {
      try { dispose() } catch { /* already gone */ }
    }
    if (workflowsDispose) { try { workflowsDispose() } catch { /* already gone */ } }
    try { wss.close() } catch { /* already closed */ }
    try { controlWss.close() } catch { /* already closed */ }
    if (muxProxy) { try { muxProxy.dispose() } catch { /* already gone */ } }
    toolBridge.close()
  }, 'dsh-browser-host.routes')
}

/** Config schema (schemastery; the loader rejects non-schema config). */
export const Config = z.object({
  extPrefix: z.string().default('/ext-api'),
  /** Prefix of the embedded WebUI route served to the floating window. */
  uiPrefix: z.string().default('/browser-ui'),
  extEventsPath: z.string().default('/ext-events.mux'),
  persistToken: z.boolean().default(true),
  tokenFile: z.string().default(DEFAULT_TOKEN_FILE),
  /** Extra exact Origin strings allowed besides browser-extension origins. */
  extraOrigins: z.array(z.string()).default([]),
  /** Default timeout for page.* tool round-trips (ms). */
  toolTimeoutMs: z.number().default(60000)
})

export default { name, inject, apply }
