/**
 * content.js — the floating launcher, the window frame, and the page bridge.
 *
 * The window itself is the real DSH WebUI, served by the host plugin at
 * `${baseUrl}/browser-ui/`. The extension owns three things only:
 *
 *   1. a neutral launcher button (44px, monochrome — no gradients, no mascot),
 *   2. an iframe that loads that page lazily,
 *   3. the page ↔ extension bridge for what only an extension can do:
 *      workspace binding by page URL, and running `page_*` tools in the
 *      current tab on behalf of the host's control channel.
 *
 * Messaging contract with the embedded page (`assets/transport.js`,
 * `assets/control.js`, `lib/client.js`):
 *
 *   page  → us   dsh:ready / dsh:busy / dsh:open-settings / dsh:bind-failed
 *                dsh:tool       run a page tool in this tab
 *                dsh:ask        ask the user a question
 *   us    → page dsh:page-url   current tab URL + resolved directory
 *                dsh:tool-result / dsh:ask-result
 */
(function () {
  'use strict'
  if (window.__DSH_BROWSER_CONTENT__) return
  window.__DSH_BROWSER_CONTENT__ = true

  const EMBED_PATH = '/browser-ui/'

  let config = null
  let ui = null
  let ask = null

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => resolve(chrome.runtime.lastError ? undefined : reply))
      } catch {
        resolve(undefined)
      }
    })
  }

  async function getConfig() {
    if (config) return config
    config = (await send({ type: 'dsh:get-config' })) || {}
    return config
  }

  function originOf(base) {
    try {
      return new URL(String(base || '')).origin
    } catch {
      return '*'
    }
  }

  function panelUrl(base, token) {
    return `${String(base || '').replace(/\/+$/, '')}${EMBED_PATH}?token=${encodeURIComponent(token || '')}`
  }

  // ── shadow UI ─────────────────────────────────────────────────────────────

  function createShadowHost() {
    const host = document.createElement('div')
    host.id = 'dsh-browser-client-root'
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;'
    const shadow = host.attachShadow({ mode: 'closed' })
    document.documentElement.appendChild(host)
    return { host, shadow }
  }

  function buildStyle() {
    const style = document.createElement('style')
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .dsh-launcher {
        position: fixed; right: 20px; bottom: 20px;
        width: 44px; height: 44px; padding: 0;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: #111113; color: #f5f7fa;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; pointer-events: auto;
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.34);
        transition: transform .16s ease, background-color .16s ease, box-shadow .16s ease;
        -webkit-font-smoothing: antialiased;
      }
      .dsh-launcher:hover { transform: translateY(-1px); background: #1b1b1c; box-shadow: 0 14px 32px rgba(0,0,0,.42); }
      .dsh-launcher:active { transform: translateY(0); }
      .dsh-launcher svg { width: 20px; height: 20px; display: block; }
      .dsh-launcher .dsh-dot {
        position: absolute; top: -1px; right: -1px;
        width: 10px; height: 10px; border-radius: 50%;
        background: #f5a524; border: 2px solid #111113; display: none;
      }
      .dsh-launcher.busy .dsh-dot { display: block; }
      .dsh-frame {
        position: fixed; right: 20px; bottom: 76px;
        width: min(520px, calc(100vw - 40px));
        height: min(760px, calc(100vh - 96px));
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.09);
        background: #151517;
        box-shadow: 0 24px 72px rgba(0, 0, 0, 0.52);
        overflow: hidden; pointer-events: auto;
        display: none; flex-direction: column;
      }
      .dsh-frame.open { display: flex; }
      .dsh-frame iframe { width: 100%; height: 100%; border: none; background: #151517; }
      .dsh-frame .dsh-state {
        position: absolute; inset: 0;
        display: none; align-items: center; justify-content: center;
        padding: 32px; text-align: center;
        color: #9aa0aa; font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        background: #151517;
      }
      .dsh-frame.error .dsh-state { display: flex; }
      .dsh-frame.error iframe { visibility: hidden; }

      .dsh-ask {
        position: absolute; inset: 0; z-index: 5;
        display: flex; align-items: center; justify-content: center;
        padding: 24px; background: rgba(9, 9, 11, 0.55);
        font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      }
      .dsh-ask[hidden] { display: none; }
      .dsh-ask-card {
        width: 100%; max-width: 360px;
        background: #1b1b1c; color: #f5f7fa;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px; padding: 16px 16px 12px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
      }
      .dsh-ask-question { font-size: 14px; font-weight: 600; line-height: 1.5; margin: 0 0 6px; }
      .dsh-ask-detail { color: #9aa3af; font-size: 12px; white-space: pre-wrap; margin: 0 0 12px; }
      .dsh-ask-options { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
      .dsh-ask-options button, .dsh-ask-submit {
        width: 100%; text-align: left;
        background: rgba(255, 255, 255, 0.06); color: inherit;
        border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 9px;
        padding: 8px 10px; font: inherit; cursor: pointer;
      }
      .dsh-ask-options button:hover, .dsh-ask-submit:hover { background: rgba(255, 255, 255, 0.11); }
      .dsh-ask input {
        width: 100%; margin-bottom: 8px;
        background: #151517; color: #f5f7fa;
        border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 9px;
        padding: 8px 10px; font: inherit; outline: none;
      }
      .dsh-ask input:focus { border-color: rgba(255, 255, 255, 0.3); }
      .dsh-ask-actions { display: flex; gap: 8px; }
      .dsh-ask-actions .dsh-ask-submit { flex: 1; text-align: center; }
      .dsh-ask-actions .dsh-ask-cancel {
        flex: 0 0 auto; padding: 8px 12px; border-radius: 9px;
      }
    `
    return style
  }

  function launcherSvg() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16H9.8l-3.6 3v-3H7a2.5 2.5 0 0 1-2.5-2.5z"/>
      <path d="M8.5 9h7M8.5 12h4.5"/>
    </svg>`
  }

  function buildUi(shadow) {
    shadow.appendChild(buildStyle())

    const launcher = document.createElement('button')
    launcher.className = 'dsh-launcher'
    launcher.type = 'button'
    launcher.setAttribute('aria-label', 'DSH')
    launcher.setAttribute('title', 'DSH')
    launcher.innerHTML = launcherSvg() + '<span class="dsh-dot" aria-hidden="true"></span>'

    const frame = document.createElement('div')
    frame.className = 'dsh-frame'

    const iframe = document.createElement('iframe')
    iframe.setAttribute('allow', 'clipboard-write; clipboard-read')
    iframe.setAttribute('title', 'DSH')

    const state = document.createElement('div')
    state.className = 'dsh-state'

    const askEl = document.createElement('div')
    askEl.className = 'dsh-ask'
    askEl.hidden = true
    askEl.innerHTML = `
      <div class="dsh-ask-card" role="dialog" aria-modal="true">
        <p class="dsh-ask-question"></p>
        <p class="dsh-ask-detail"></p>
        <div class="dsh-ask-options"></div>
        <input class="dsh-ask-input" type="text" placeholder="输入回答…">
        <div class="dsh-ask-actions">
          <button class="dsh-ask-submit" type="button">提交</button>
          <button class="dsh-ask-cancel dsh-ask-submit" type="button">取消</button>
        </div>
      </div>`

    frame.appendChild(iframe)
    frame.appendChild(state)
    frame.appendChild(askEl)
    shadow.appendChild(frame)
    shadow.appendChild(launcher)

    return {
      launcher,
      frame,
      iframe,
      state,
      askEl,
      askQuestion: askEl.querySelector('.dsh-ask-question'),
      askDetail: askEl.querySelector('.dsh-ask-detail'),
      askOptions: askEl.querySelector('.dsh-ask-options'),
      askInput: askEl.querySelector('.dsh-ask-input'),
      loaded: false,
      opened: false
    }
  }

  // ── page bridge ───────────────────────────────────────────────────────────

  function postToPage(message) {
    if (!ui || !ui.iframe.contentWindow) return
    try {
      ui.iframe.contentWindow.postMessage(message, originOf(config && config.baseUrl))
    } catch {
      /* frame gone */
    }
  }

  async function syncPage() {
    if (!ui) return
    const resolved = await send({ type: 'dsh:resolve-dir', url: location.href })
    postToPage({
      type: 'dsh:page-url',
      url: location.href,
      title: document.title,
      dir: resolved && resolved.dir,
      via: resolved && resolved.via
    })
  }

  async function runToolFromPage(data) {
    const reply = await send({ type: 'dsh:exec-tool', tool: data.tool, args: data.args })
    postToPage({
      type: 'dsh:tool-result',
      requestId: data.requestId,
      ok: Boolean(reply && reply.ok),
      result: reply && reply.result,
      error: reply && reply.error
    })
  }

  function showAsk(data) {
    if (!ui) return
    if (ask) finishAsk(null)
    if (!ui.opened) void open()
    ask = {
      requestId: data.requestId,
      options: Array.isArray(data.options) ? data.options.map(String) : []
    }
    ui.askQuestion.textContent = String(data.question || '请确认')
    ui.askDetail.textContent = String(data.detail || '')
    ui.askOptions.textContent = ''
    for (const option of ask.options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = option
      button.addEventListener('click', () => finishAsk(option))
      ui.askOptions.appendChild(button)
    }
    ui.askOptions.hidden = ask.options.length === 0
    ui.askInput.value = ''
    ui.askInput.hidden = ask.options.length > 0
    ui.askEl.hidden = false
    if (ask.options.length === 0) {
      try { ui.askInput.focus() } catch { /* not focusable yet */ }
    }
  }

  function finishAsk(answer) {
    if (!ask) return
    const current = ask
    ask = null
    if (ui) ui.askEl.hidden = true
    postToPage({
      type: 'dsh:ask-result',
      requestId: current.requestId,
      ok: answer !== null && answer !== undefined,
      answer: answer === null || answer === undefined ? null : String(answer)
    })
  }

  // ── frame lifecycle ───────────────────────────────────────────────────────

  async function ensureFrame() {
    if (!ui) return false
    if (ui.loaded) return true
    const cfg = await getConfig()
    if (!cfg.token) {
      ui.state.textContent = '尚未配置访问令牌。请打开扩展设置，填写 DSH 宿主的 access token。'
      ui.frame.classList.add('error')
      return false
    }
    ui.loaded = true
    ui.iframe.src = panelUrl(cfg.baseUrl, cfg.token)
    return true
  }

  async function open() {
    if (!ui) return
    const ok = await ensureFrame()
    ui.frame.classList.toggle('open', ok)
    ui.frame.classList.toggle('error', !ok)
    ui.opened = ok
    if (ok) {
      await syncPage()
      try { ui.iframe.contentWindow.focus() } catch { /* not focusable yet */ }
    }
  }

  function close() {
    if (!ui) return
    ui.frame.classList.remove('open')
    ui.opened = false
  }

  async function toggle() {
    if (!ui) return
    if (ui.opened) close()
    else await open()
  }

  function bindEvents() {
    ui.launcher.addEventListener('click', (event) => {
      event.stopPropagation()
      void toggle()
    })

    ui.askEl.querySelector('.dsh-ask-submit:not(.dsh-ask-cancel)').addEventListener('click', () => {
      finishAsk(ui.askInput.value.trim() || null)
    })
    ui.askEl.querySelector('.dsh-ask-cancel').addEventListener('click', () => finishAsk(null))
    ui.askInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        finishAsk(ui.askInput.value.trim() || null)
      }
    })

    window.addEventListener('message', (event) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (event.source !== ui.iframe.contentWindow) return
      switch (data.type) {
        case 'dsh:busy':
          ui.launcher.classList.toggle('busy', Boolean(data.busy))
          break
        case 'dsh:ready':
          void syncPage()
          break
        case 'dsh:open-settings':
          void send({ type: 'dsh:open-options' })
          break
        case 'dsh:bind-failed':
          console.warn('[dsh-browser-client] workspace bind failed:', data.message)
          break
        case 'dsh:tool':
          void runToolFromPage(data)
          break
        case 'dsh:ask':
          showAsk(data)
          break
        default:
          break
      }
    })

    // SPA navigation: the bound directory may change.
    let lastUrl = location.href
    const observer = new MutationObserver(() => {
      if (location.href === lastUrl) return
      lastUrl = location.href
      if (ui.opened) void syncPage()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== 'dsh:toggle') return
      void toggle().then(() => sendResponse({ ok: true }))
      return true
    })

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.dshConfig) return
      config = null
      if (!ui.opened) return
      ui.loaded = false
      void ensureFrame().then((ok) => {
        if (!ok) return
        ui.frame.classList.remove('error')
        void syncPage()
      })
    })
  }

  try {
    const { shadow } = createShadowHost()
    ui = buildUi(shadow)
    bindEvents()
  } catch (err) {
    console.error('[dsh-browser-client] init failed', err)
  }
})()
