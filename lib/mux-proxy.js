/**
 * mux-proxy.js — bridge the embed page's WebSocket to the harness API mux.
 *
 * DSH 0.2.2 streams session activity over `/api/remote.mux`, and that upgrade
 * is fenced: `connection.admitConnection(req)` requires a trusted Host/Origin
 * plus the browser-session cookie. A page served by this plugin is same-origin
 * with the harness, so the browser would send that cookie — but the page is
 * loaded from an extension token URL, and the harness cookie is
 * `SameSite=Strict` for its own document, not for our route. Rather than
 * weaken the harness fence, this proxy performs the same browser handshake in
 * process, per connection:
 *
 *   1. `connection.authenticatedUrl(origin)` → the process launch token;
 *   2. `connection.authorizeConnect(shimReq, shimRes)` with
 *      `/connect?token=…&interactions=answer` and a Host header of the
 *      listener authority — the harness mints one operator cookie and
 *      publishes its Peer;
 *   3. open `ws://<authority>/api/remote.mux` with that cookie, so the mux
 *      upgrade passes `admitConnection` and owns an independent operator;
 *   4. pipe frames both ways until either side closes.
 *
 * The upstream peer is released by the harness when the socket closes, so a
 * reloaded floating window does not leak peers.
 */

import { WebSocket, WebSocketServer } from 'ws'

/** Close code used when the upstream leg fails before or during piping. */
const UPSTREAM_FAILURE = 1011

/**
 * @param {{
 *   webServer: { host: string, protocol: string, getOrigin?: () => string },
 *   getConnection: () => any,
 *   token: string,
 *   uiPrefix: string,
 *   safeEqual: (a: string, b: string) => boolean,
 *   originAllowed: (origin: string | undefined) => boolean,
 *   log: (msg: string) => void
 * }} opts
 * @returns {{ path: string, handler: (req: any, socket: any, head: Buffer) => void, dispose: () => void }}
 */
export function mountMuxProxy({ webServer, getConnection, token, uiPrefix, safeEqual, originAllowed, log }) {
  const path = `${uiPrefix}-mux`
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false })

  const origin = () => {
    try {
      if (typeof webServer.getOrigin === 'function') return webServer.getOrigin()
    } catch { /* not bound yet */ }
    return `${webServer.protocol || 'http:'}//${webServer.host}`
  }

  const authority = () => new URL(origin()).host

  /**
   * Mint one operator cookie through the public connection handshake.
   * @returns {{ cookie?: string, status?: number, reason?: string }}
   */
  const mintCookie = (connection) => {
    let launchToken
    try {
      launchToken = new URL(connection.authenticatedUrl(origin())).searchParams.get('token')
    } catch (err) {
      return { reason: `cannot read launch token: ${String(err && err.message || err)}` }
    }
    if (typeof launchToken !== 'string' || launchToken === '') return { reason: 'launch token is empty' }

    let captured
    let status
    const shimResponse = {
      writeHead(code, headers) {
        status = code
        const setCookie = headers && (headers['set-cookie'] ?? headers['Set-Cookie'])
        if (setCookie !== undefined) captured = Array.isArray(setCookie) ? setCookie[0] : String(setCookie)
      },
      end() {},
      setHeader() {},
      getHeader() { return undefined }
    }
    const shimRequest = {
      method: 'GET',
      url: `/connect?token=${encodeURIComponent(launchToken)}&interactions=answer`,
      headers: { host: authority() }
    }
    try {
      connection.authorizeConnect(shimRequest, shimResponse)
    } catch (err) {
      return { reason: `authorizeConnect threw: ${String(err && err.message || err)}` }
    }
    if (typeof captured !== 'string' || captured === '') {
      return { status, reason: `connection handshake produced no cookie (status ${status ?? 'unknown'})` }
    }
    return { cookie: captured.split(';')[0] }
  }

  const reject = (socket, status, text) => {
    const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Error'
    socket.end([
      `HTTP/1.1 ${status} ${reason}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(text)}`,
      '',
      text
    ].join('\r\n'))
  }

  const handler = (req, socket, head) => {
    let url
    try {
      url = new URL(req.url, 'http://dsh.invalid')
    } catch {
      reject(socket, 400, 'bad request')
      return
    }
    if (!safeEqual(url.searchParams.get('token') || '', token)) {
      reject(socket, 401, 'invalid token')
      return
    }
    if (!originAllowed(req.headers.origin)) {
      reject(socket, 403, 'origin not allowed')
      return
    }

    const connection = getConnection()
    if (connection === undefined || typeof connection.authorizeConnect !== 'function' || typeof connection.authenticatedUrl !== 'function') {
      reject(socket, 503, 'connection service unavailable (client-connection not mounted)')
      return
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      const minted = mintCookie(connection)
      if (minted.cookie === undefined) {
        log(`mux-proxy: ${minted.reason}`)
        try { client.close(UPSTREAM_FAILURE, 'harness handshake failed') } catch { /* already gone */ }
        return
      }

      const target = `${webServer.protocol === 'https:' ? 'wss:' : 'ws:'}//${authority()}/api/remote.mux`
      const upstream = new WebSocket(target, {
        headers: { cookie: minted.cookie },
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024
      })

      // Frames arriving before the upstream leg is open are held briefly: the
      // mux client sends its first request immediately after connect.
      const queued = []
      let upstreamOpen = false
      let closed = false

      const finish = (code, reason) => {
        if (closed) return
        closed = true
        queued.length = 0
        try { upstream.close() } catch { /* already gone */ }
        try { client.close(code, reason) } catch { /* already gone */ }
      }

      upstream.on('open', () => {
        upstreamOpen = true
        for (const frame of queued.splice(0)) {
          try { upstream.send(frame.data, { binary: frame.isBinary }) } catch { /* closing */ }
        }
      })
      upstream.on('message', (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN) return
        try { client.send(data, { binary: isBinary }) } catch { /* closing */ }
      })
      upstream.on('close', (code, reason) => {
        finish(code === 1000 ? 1000 : UPSTREAM_FAILURE, reason && reason.length ? reason.toString('utf8') : 'upstream closed')
      })
      upstream.on('error', (err) => {
        log(`mux-proxy: upstream error: ${err && err.message || err}`)
        finish(UPSTREAM_FAILURE, 'upstream error')
      })

      client.on('message', (data, isBinary) => {
        if (upstreamOpen) {
          try { upstream.send(data, { binary: isBinary }) } catch { /* closing */ }
        } else {
          queued.push({ data, isBinary })
        }
      })
      client.on('close', () => finish(1000, 'client closed'))
      client.on('error', (err) => {
        log(`mux-proxy: client error: ${err && err.message || err}`)
        finish(UPSTREAM_FAILURE, 'client error')
      })
    })
  }

  return {
    path,
    handler,
    dispose: () => {
      try { wss.close() } catch { /* already closed */ }
    }
  }
}
