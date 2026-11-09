/*
 * transport.js — the four-line transport hook that lets the real DSH WebUI run
 * inside the browser floating window.
 *
 * The page served at /browser-ui/ is the canonical harness index (same boot
 * facade, same client-plugin graph, same `/plugins/*` bundles). The only thing
 * it lacks is a token-authenticated way to reach the API, because the WebUI
 * normally posts to same-origin `/api/*` with the harness browser cookie — and
 * a floating window opened from a browser extension cannot obtain that cookie.
 *
 * DSH exposes a public seam for exactly this situation: `window.__DSH_TRANSPORT__`
 * (ClientTransportHooks). The page keeps speaking its native protocol; we only
 * change the wire:
 *
 *   fetch("api/session/list")  →  POST /ext-api/session/list  + Bearer token
 *   WebSocket("…/api/remote.mux")  →  ws://…/browser-ui-mux?token=…
 *
 * Everything else (boot, assets, plugin bundles, session store, chat renderer)
 * is upstream code running unmodified.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  var script = document.currentScript;
  var uiPrefix = (script && script.getAttribute('data-ui-prefix')) || '/browser-ui';
  var extPrefix = (script && script.getAttribute('data-ext-prefix')) || '/ext-api';
  var embed = { token: token, uiPrefix: uiPrefix, extPrefix: extPrefix };

  // The token is a bearer capability, never part of the visible address.
  try {
    if (params.has('token')) {
      params.delete('token');
      var qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    }
  } catch (_) { /* history is unavailable in some embedded contexts */ }

  var origin = location.origin;
  var muxPath = uiPrefix + '-mux';

  function apiUrl(route) {
    var raw = typeof route === 'string' ? route : String(route && route.url || route);
    var url = new URL(raw, origin + '/');
    var path = url.pathname.replace(/^\/+/, '');
    if (path.indexOf('api/') !== 0) return url.href;
    var endpoint = path.slice('api/'.length);
    return origin + extPrefix + '/' + endpoint + url.search;
  }

  function install() {
    // Mark the document before the first paint so `embed.css` applies without
    // a flash of the full-page shell.
    document.documentElement.setAttribute('data-dsh-embed', '');
    window.__DSH_EMBED__ = embed;
    window.__DSH_TRANSPORT__ = {
      // RpcFetch: the WebUI's RPC client hands us a document-relative route and
      // an init object, and expects a Response (JSON envelope or multipart).
      fetch: function (route, init) {
        var target = apiUrl(route);
        var headers = new Headers((init && init.headers) || {});
        headers.set('authorization', 'Bearer ' + token);
        var next = Object.assign({}, init || {}, {
          headers: headers,
          credentials: 'omit',
          mode: 'cors',
          cache: 'no-store'
        });
        return fetch(target, next);
      },
      // ConnectionWebSocketFactory: receives the already-resolved mux URL.
      createWebSocket: function (url) {
        var target = new URL(String(url), origin + '/');
        if (target.pathname.indexOf('remote.mux') !== -1) {
          var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          return new WebSocket(protocol + '//' + location.host + muxPath + '?token=' + encodeURIComponent(token));
        }
        return new WebSocket(target.href);
      },
      // The page is same-origin with the harness, so its own origin is the
      // correct base for every non-API route (assets, plugin bundles).
      streamBaseUrl: origin + '/',
      ownsHost: false
    };
  }

  install();
})();
