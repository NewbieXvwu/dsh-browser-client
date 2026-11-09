/**
 * control.js — the floating window's half of the control channel.
 *
 * The host plugin's page.* tools reach the browser over a WebSocket control
 * channel (`/ext-api-control`). That channel lives here, inside the embedded
 * page, for the same reason it used to live in the panel: it stays open exactly
 * while the window is open, and it needs no service-worker keep-alive hacks.
 *
 * Page tools themselves still run in the content script of the *target* tab
 * (`content/page-tools.js`). This file therefore only relays:
 *
 *   WS tool-request  → parent frame (content.js) → extension background
 *                    → chrome.tabs.sendMessage → page-tools.js
 *                    → back up the same chain → WS tool-response
 *
 * `ask-request` takes the same path and is answered by a small modal rendered
 * by the content script.
 *
 * Everything here is plain classic script: it must run before the deferred
 * WebUI bundle, with no CSP surprises.
 */
;(function () {
  'use strict'
  const embed = window.__DSH_EMBED__
  if (!embed || !embed.token) return
  if (window.__DSH_CONTROL__) return
  window.__DSH_CONTROL__ = true

  const extPrefix = String(embed.extPrefix || '/ext-api').replace(/\/+$/, '')
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${extPrefix}-control?token=${encodeURIComponent(embed.token)}`

  const pending = new Map()
  let socket = null
  let retry = 0
  let disposed = false

  function post(message) {
    try {
      window.parent.postMessage(message, '*')
    } catch {
      /* parent gone */
    }
  }

  function settle(requestId, frame) {
    const entry = pending.get(requestId)
    if (!entry) return
    pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve(frame)
  }

  function awaitParent(requestId, send, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve({ ok: false, error: { code: 'timeout', message: '浏览器扩展没有在时限内响应' } })
      }, Math.max(1000, timeoutMs || 60000))
      pending.set(requestId, { resolve, timer })
      post(send)
    })
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (event.source !== window.parent) return
    if (data.type === 'dsh:tool-result' || data.type === 'dsh:ask-result') {
      settle(data.requestId, data)
    }
  })

  function connect() {
    if (disposed) return
    let ws
    try {
      ws = new WebSocket(url)
    } catch {
      schedule()
      return
    }
    socket = ws
    ws.addEventListener('open', () => {
      retry = 0
      ws.send(JSON.stringify({ kind: 'status', state: 'connected' }))
    })
    ws.addEventListener('message', (event) => {
      let frame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!frame || typeof frame !== 'object') return
      if (frame.kind === 'tool-request') {
        void awaitParent(frame.requestId, {
          type: 'dsh:tool',
          requestId: frame.requestId,
          tool: frame.tool,
          args: frame.args,
          timeoutMs: frame.timeoutMs
        }, frame.timeoutMs).then((reply) => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify(reply.ok
            ? { kind: 'tool-response', requestId: frame.requestId, ok: true, result: reply.result }
            : { kind: 'tool-response', requestId: frame.requestId, ok: false, error: reply.error }))
        })
      } else if (frame.kind === 'ask-request') {
        void awaitParent(frame.requestId, {
          type: 'dsh:ask',
          requestId: frame.requestId,
          question: frame.question,
          detail: frame.detail,
          options: frame.options,
          timeoutMs: frame.timeoutMs
        }, frame.timeoutMs).then((reply) => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify({
            kind: 'ask-response',
            requestId: frame.requestId,
            answer: reply.ok ? (reply.answer ?? null) : null,
            cancelled: !reply.ok
          }))
        })
      }
    })
    ws.addEventListener('close', () => {
      socket = null
      schedule()
    })
    ws.addEventListener('error', () => {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    })
  }

  function schedule() {
    if (disposed) return
    const delay = Math.min(15000, 500 * Math.pow(2, retry++))
    setTimeout(connect, delay)
  }

  window.addEventListener('pagehide', () => {
    disposed = true
    try {
      socket && socket.close()
    } catch {
      /* already closed */
    }
  })

  // The content script tells us it is ready; connecting immediately is fine
  // either way because the host accepts a control socket at any time.
  connect()
})()
