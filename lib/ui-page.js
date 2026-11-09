/**
 * ui-page.js — serve the real DSH WebUI inside the browser floating window.
 *
 * The floating window used to run a hand-written panel. It now runs the very
 * same web client the harness serves at `/`, so the panel stops being a
 * look-alike: it *is* the WebUI, with the harness's own boot graph, session
 * store, chat renderer and tool cards.
 *
 * How the page is obtained without copying any upstream artifact:
 *
 *   `webServer.readResource(request, peer)` is the in-process resource
 *   dispatcher. `@deepseek-ai/dsh-host-frontend-static` claims the fallback
 *   seat; when a `peer` is passed, it skips its own cookie check and returns
 *   `renderIndex(indexHtml, peer)` — i.e. the production index.html with every
 *   `webserver/index-inject` row already rendered (boot facade, script rows,
 *   `__DSH_BOOT__`, and the client-plugin graph including this package's
 *   `./client` face).
 *
 * So this route is a thin, token-gated facade over the canonical page:
 *
 *   1. read `/` through readResource with `connection.browserPeer`;
 *   2. rewrite the directory-relative `<base href="./">` to `<base href="/">`
 *      (assets and `/plugins/*` bundles stay at the listener root);
 *   3. inject our transport shim and embed stylesheet;
 *   4. serve it with `no-store`, never sharing a cache with the real `/`.
 *
 * The page then lives on the harness origin, which means:
 *
 *   - no MV3 CSP problem (`new Function` in the client bundle is fine),
 *   - `/assets/*` and `/plugins/*` are served by the harness itself,
 *   - the transport shim can rewrite the canonical `api/<endpoint>` calls to
 *     the token surface, so the WebUI talks to `/ext-api` exactly as it would
 *     talk to `/api`.
 *
 * Everything the WebUI needs is upstream code. The only files this plugin owns
 * are `assets/transport.js` (four-line transport hook), `assets/embed.css`
 * (chrome removal) and `lib/client.js` (page→workspace binding).
 */

import { readFile } from 'node:fs/promises'

/** Static files this route serves next to the index (name → content type). */
const ASSETS = new Map([
  ['embed.css', 'text/css; charset=utf-8'],
  ['transport.js', 'text/javascript; charset=utf-8'],
  ['control.js', 'text/javascript; charset=utf-8']
])

/**
 * @param {URL} url
 * @param {string} origin - harness origin, e.g. `http://127.0.0.1:3080`
 * @returns {Promise<string>}
 */
async function readAsset(name, origin) {
  const body = await readFile(new URL(`../assets/${name}`, import.meta.url), 'utf8')
  // `@ORIGIN@` is replaced so the same file works for every bind address.
  return body.replaceAll('@ORIGIN@', origin)
}

/** Escape text interpolated into the small error document. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

/** Minimal, honest error page: what failed and what to check. */
function errorPage(title, detail) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH 悬浮窗不可用</title>
<style>
  :root { color-scheme: light dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 14px/1.6 -apple-system, "PingFang SC", system-ui, sans-serif; background: #151517; color: #f5f7fa }
  main { max-width: 34rem; padding: 2.5rem; }
  h1 { font-size: 1.05rem; margin: 0 0 .75rem }
  pre { white-space: pre-wrap; background: #ffffff0f; border-radius: 12px; padding: .9rem 1rem; font-size: .82rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #d7dbe3 }
  p { color: #9aa3af; margin: .9rem 0 0 }
</style></head><body><main>
<h1>${escapeHtml(title)}</h1>
<pre>${escapeHtml(detail)}</pre>
<p>DSH 仍在运行；修复后重新打开悬浮窗即可，不需要重启浏览器扩展。</p>
</main></body></html>`
}

/**
 * Build the embeddable page HTML from the canonical index.
 * @param {string} html - `renderIndex` output.
 * @param {{ uiPrefix: string, extPrefix: string }} opts
 */
export function decorateIndex(html, { uiPrefix, extPrefix }) {
  let page = html
  // frontend-static injects `<base href="./">`; the page no longer lives at the
  // listener root, so every relative asset must resolve against the root.
  if (/<base\b[^>]*>/i.test(page)) {
    page = page.replace(/<base\b[^>]*>/i, '<base href="/">')
  } else if (/<head\b[^>]*>/i.test(page)) {
    page = page.replace(/<head\b[^>]*>/i, (head) => `${head}\n<base href="/">`)
  }
  const injection = [
    `<link rel="stylesheet" href="${uiPrefix}/embed.css">`,
    `<script src="${uiPrefix}/transport.js" data-ui-prefix="${uiPrefix}" data-ext-prefix="${extPrefix}"></script>`,
    `<script src="${uiPrefix}/control.js" data-ext-prefix="${extPrefix}"></script>`
  ].join('\n')
  if (/<\/head>/i.test(page)) {
    page = page.replace(/<\/head>/i, `${injection}\n</head>`)
  } else {
    page = `${injection}\n${page}`
  }
  return page
}

/**
 * Mount the embed route (prefix `uiPrefix`) and its assets.
 *
 * @param {{
 *   webServer: { host: string, protocol: string, getOrigin?: () => string, register: Function, readResource?: Function },
 *   getConnection: () => any,
 *   token: string,
 *   uiPrefix: string,
 *   extPrefix: string,
 *   safeEqual: (a: string, b: string) => boolean,
 *   log: (msg: string) => void
 * }} opts
 * @returns {() => void} disposer
 */
export function mountUiPage({ webServer, getConnection, token, uiPrefix, extPrefix, safeEqual, log }) {
  const origin = () => {
    try {
      if (typeof webServer.getOrigin === 'function') return webServer.getOrigin()
    } catch { /* listener not bound yet */ }
    return `${webServer.protocol || 'http:'}//${webServer.host}`
  }

  const readIndex = async () => {
    const connection = getConnection()
    if (connection === undefined || connection.browserPeer === undefined) {
      return { error: new Error('connection 服务不可用：client-connection 尚未挂载') }
    }
    if (typeof webServer.readResource !== 'function') {
      return { error: new Error('webServer 不提供 readResource（DSH 版本过旧）') }
    }
    const request = new Request(new URL('/', origin()).href)
    const response = await webServer.readResource(request, connection.browserPeer)
    if (!response.ok) {
      return { error: new Error(`宿主前端返回 HTTP ${response.status}（通常是 frontend-static 未启用）`) }
    }
    const html = await response.text()
    if (!html.includes('__DSH_BOOT__')) {
      return { error: new Error('取回的页面没有 boot 注入：Web 前端没有挂载到 webServer fallback') }
    }
    return { html }
  }

  const handler = async (req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://dsh.invalid')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
      res.end('method not allowed')
      return
    }
    try {
      url = new URL(req.url, 'http://dsh.invalid')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }

    const rest = url.pathname.slice(uiPrefix.length)
    if (rest === '') {
      res.writeHead(302, { location: `${uiPrefix}/${url.search}`, 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (rest !== '/') {
      const name = rest.slice(1)
      const contentType = ASSETS.get(name)
      if (contentType === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('not found')
        return
      }
      try {
        const text = await readAsset(name, origin())
        res.writeHead(200, {
          'content-type': contentType,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        })
        res.end(req.method === 'HEAD' ? undefined : text)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`asset error: ${String(err && err.message || err)}`)
      }
      return
    }

    // The page itself carries the extension token so the iframe URL alone is
    // not a capability: the document is useless without `/ext-api` access.
    if (!safeEqual(url.searchParams.get('token') || '', token)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(errorPage('缺少有效的扩展凭据', '地址里没有正确的 token。请从浏览器扩展的悬浮窗入口打开本页。'))
      return
    }

    try {
      const { html, error } = await readIndex()
      if (error !== undefined) {
        log(`ui-page: ${error.message}`)
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(errorPage('无法读取 DSH WebUI 页面', error.message))
        return
      }
      const page = decorateIndex(html, { uiPrefix, extPrefix })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      })
      res.end(req.method === 'HEAD' ? undefined : page)
    } catch (err) {
      log(`ui-page: ${err && err.stack || err}`)
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(errorPage('悬浮窗页面渲染失败', String(err && err.message || err)))
    }
  }

  return webServer.register({ kind: 'prefix', path: uiPrefix, handler })
}
