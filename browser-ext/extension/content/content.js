/**
 * content.js — the floating window frame and the page bridge.
 *
 * The window itself is the real DSH WebUI, served by the host plugin at
 * `${baseUrl}/browser-ui/`. The extension owns three things only:
 *
 *   1. an iframe that loads that page lazily,
 *   2. the two presentations of that page — `minimal` (default) and `standard`,
 *   3. the page ↔ extension bridge for what only an extension can do:
 *      workspace binding by page URL, and running `page_*` tools in the
 *      current tab on behalf of the host's control channel.
 *
 * There is no always-on-screen launcher: the window is summoned by the
 * keyboard shortcut, the context menu, or the toolbar action, and dismissed
 * with Esc or a click anywhere on the page.
 *
 * Messaging contract with the embedded page (`assets/transport.js`,
 * the extension background over `chrome.runtime`):
 *
 *   page  → us   dsh:ready / dsh:busy / dsh:close / dsh:size
 *                dsh:open-settings / dsh:bind-failed
 *                dsh:tool       run a page tool in this tab
 *                dsh:ask        ask the user a question
 *   us    → page dsh:page-url   current tab URL + resolved directory
 *                dsh:set-mode / dsh:tone / dsh:prefill
 *                dsh:tool-result / dsh:ask-result
 */
(function () {
  'use strict'
  if (window.__DSH_BROWSER_CONTENT__) return
  window.__DSH_BROWSER_CONTENT__ = true

  const EMBED_PATH = '/browser-ui/'
  const MIN_HEIGHT = 84

  let config = null
  let ui = null
  let ask = null
  let mode = 'minimal'
  let visible = false
  let pageReady = false
  let pendingPrefill = null
  let lastTone = ''

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

  function panelUrl(base, token, nextMode) {
    const root = String(base || '').replace(/\/+$/, '')
    return `${root}${EMBED_PATH}?token=${encodeURIComponent(token || '')}&mode=${encodeURIComponent(nextMode)}`
  }

  function normalizeMode(value) {
    return value === 'standard' ? 'standard' : 'minimal'
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

      .dsh-frame {
        position: fixed; z-index: 2147483647;
        display: none; pointer-events: auto;
        border: 0; background: transparent;
      }
      .dsh-frame.open { display: block; }

      /* 极简：底部居中、透明、无边框，高度由页面内容决定。 */
      .dsh-frame.minimal {
        left: 50%; bottom: 28px; transform: translateX(-50%);
        width: min(680px, calc(100vw - 32px));
        height: var(--dsh-h, ${MIN_HEIGHT}px);
        border-radius: 0; box-shadow: none; overflow: visible;
      }
      /* 需要回答问题/授权时给对话框留出空间（这是唯一会临时出现的块）。 */
      .dsh-frame.minimal.asking { height: min(440px, 64vh); }

      /* 完整：沿用原来的 520×760 深色窗口。 */
      .dsh-frame.standard {
        right: 20px; bottom: 76px;
        width: min(520px, calc(100vw - 40px));
        height: min(760px, calc(100vh - 96px));
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.09);
        background: #151517;
        box-shadow: 0 24px 72px rgba(0, 0, 0, 0.52);
        overflow: hidden;
      }
      .dsh-frame.minimal.asking {
        border-radius: 14px;
        background: rgba(18, 18, 20, 0.82);
        backdrop-filter: blur(18px) saturate(1.1);
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.4);
        overflow: hidden;
      }

      .dsh-frame iframe {
        width: 100%; height: 100%; border: none;
        background: transparent; display: block; color-scheme: normal;
      }

      .dsh-frame .dsh-state {
        position: absolute; inset: 0;
        display: none; align-items: center; justify-content: center;
        padding: 24px; text-align: center;
        border-radius: inherit;
        color: #c9ced6;
        font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        background: rgba(12, 12, 14, 0.86);
      }
      .dsh-frame.error .dsh-state { display: flex; }
      .dsh-frame.error iframe { visibility: hidden; }

      .dsh-ask {
        position: absolute; inset: 0; z-index: 5;
        display: flex; align-items: center; justify-content: center;
        padding: 20px; background: rgba(9, 9, 11, 0.55);
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

  function buildUi(shadow) {
    shadow.appendChild(buildStyle())

    const frame = document.createElement('div')
    frame.className = 'dsh-frame minimal'

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

    return {
      frame,
      iframe,
      state,
      askEl,
      askQuestion: askEl.querySelector('.dsh-ask-question'),
      askDetail: askEl.querySelector('.dsh-ask-detail'),
      askOptions: askEl.querySelector('.dsh-ask-options'),
      askInput: askEl.querySelector('.dsh-ask-input'),
      loaded: false,
      loadedMode: ''
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

  function flushPrefill() {
    if (!pendingPrefill || !pageReady) return
    const text = pendingPrefill
    pendingPrefill = null
    postToPage({ type: 'dsh:prefill', text })
  }

  /** Effective background colour of whatever paints at a viewport point. */
  function backgroundAt(x, y) {
    try {
      let el = document.elementFromPoint(x, y)
      while (el && el !== document.documentElement) {
        // Our own overlay and its iframe are transparent, never a page colour.
        if (el === ui?.frame || el === ui?.host) break
        const bg = getComputedStyle(el).backgroundColor
        if (bg && bg !== 'transparent' && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) return bg
        el = el.parentElement
      }
      const bodyBg = getComputedStyle(document.body).backgroundColor
      if (bodyBg && bodyBg !== 'transparent' && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bodyBg)) return bodyBg
      const htmlBg = getComputedStyle(document.documentElement).backgroundColor
      if (htmlBg && htmlBg !== 'transparent' && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(htmlBg)) return htmlBg
    } catch {
      /* detached document */
    }
    return 'rgb(255, 255, 255)'
  }

  /**
   * Sample the page *around* the window (the iframe covers the centre), so the
   * minimal window can flip its text between dark-on-light and light-on-dark.
   */
  function sampleTone() {
    let rect = null
    try {
      rect = ui?.frame?.getBoundingClientRect()
    } catch {
      /* detached document */
    }
    const points = rect && rect.width > 0
      ? [
          [rect.left - 14, rect.top + 18],
          [rect.right + 14, rect.top + 18],
          [rect.left + rect.width / 2, rect.top - 14]
        ]
      : [[window.innerWidth / 2, window.innerHeight - 48]]
    let total = 0
    let count = 0
    for (const [rawX, rawY] of points) {
      const x = Math.round(Math.min(window.innerWidth - 1, Math.max(0, rawX)))
      const y = Math.round(Math.min(window.innerHeight - 1, Math.max(0, rawY)))
      const color = backgroundAt(x, y)
      const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color)
      if (!match) continue
      total += (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255
      count += 1
    }
    if (count === 0) return 'light'
    return total / count > 0.55 ? 'light' : 'dark'
  }

  function publishTone(force = false) {
    if (!visible) return
    const tone = sampleTone()
    if (!force && tone === lastTone) return
    lastTone = tone
    postToPage({ type: 'dsh:tone', tone })
  }

  function showAsk(data, respond) {
    if (!ui) {
      if (respond) respond(null)
      return
    }
    if (ask) finishAsk(null)
    if (!visible) void open()
    ask = {
      requestId: data.requestId,
      options: Array.isArray(data.options) ? data.options.map(String) : [],
      respond: respond || null
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
    ui.frame.classList.add('asking')
    if (ask.options.length === 0) {
      try { ui.askInput.focus() } catch { /* not focusable yet */ }
    }
  }

  function finishAsk(answer) {
    if (!ask) return
    const current = ask
    ask = null
    if (ui) {
      ui.askEl.hidden = true
      ui.frame.classList.remove('asking')
    }
    if (current.respond) {
      current.respond(answer)
      return
    }
    postToPage({
      type: 'dsh:ask-result',
      requestId: current.requestId,
      ok: answer !== null && answer !== undefined,
      answer: answer === null || answer === undefined ? null : String(answer)
    })
  }

  // ── frame lifecycle ───────────────────────────────────────────────────────

  // The host element mirrors a little state for the page (and for tests);
  // everything sensitive stays inside the closed shadow root.
  function publishState() {
    if (!ui) return
    ui.host.setAttribute('data-dsh-mode', mode)
    ui.host.setAttribute('data-dsh-visible', visible ? 'true' : 'false')
    ui.host.setAttribute('data-dsh-height', String(Math.round(ui.frame.getBoundingClientRect().height)))
  }

  function setMode(next) {
    const normalized = normalizeMode(next)
    const changed = normalized !== mode
    mode = normalized
    if (!ui) return
    ui.frame.classList.toggle('minimal', normalized === 'minimal')
    ui.frame.classList.toggle('standard', normalized === 'standard')
    if (normalized === 'minimal') ui.frame.style.removeProperty('--dsh-h')
    if (changed && ui.loaded) postToPage({ type: 'dsh:set-mode', mode: normalized })
    publishState()
  }

  function applyHeight(height) {
    if (!ui || mode !== 'minimal') return
    const max = Math.round(window.innerHeight * 0.66)
    const next = Math.max(MIN_HEIGHT, Math.min(max, Math.round(Number(height) || 0)))
    ui.frame.style.setProperty('--dsh-h', `${next}px`)
    publishState()
  }

  async function ensureFrame(nextMode) {
    if (!ui) return false
    if (ui.loaded) return true
    const cfg = await getConfig()
    if (!cfg.token) {
      ui.state.textContent = '尚未配置访问令牌。请打开扩展设置，填写 DSH 宿主的 access token。'
      ui.frame.classList.add('error')
      return false
    }
    setMode(nextMode)
    ui.loaded = true
    ui.loadedMode = mode
    ui.iframe.src = panelUrl(cfg.baseUrl, cfg.token, mode)
    return true
  }

  async function open(options = {}) {
    if (!ui) return
    const cfg = await getConfig()
    const requested = normalizeMode(options.mode || cfg.uiMode || mode)
    if (options.prefill && String(options.prefill).trim() !== '') pendingPrefill = String(options.prefill)
    const ok = await ensureFrame(requested)
    if (!ok) {
      ui.frame.classList.toggle('open', true)
      ui.frame.classList.toggle('error', true)
      visible = true
      publishState()
      return
    }
    if (ui.loaded && mode !== requested) setMode(requested)
    ui.frame.classList.add('open')
    ui.frame.classList.remove('error')
    visible = true
    publishState()
    void send({ type: 'dsh:panel-state', open: true, mode: requested })
    await syncPage()
    publishTone(true)
    try { ui.iframe.contentWindow.focus() } catch { /* not focusable yet */ }
    flushPrefill()
  }

  function close() {
    if (!ui) return
    ui.frame.classList.remove('open')
    visible = false
    publishState()
    if (ask) finishAsk(null)
    void send({ type: 'dsh:badge', busy: false })
    void send({ type: 'dsh:panel-state', open: false })
  }

  async function toggle(options = {}) {
    if (!ui) return
    if (visible) close()
    else await open(options)
  }

  function bindEvents() {
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
      if (!ui || event.source !== ui.iframe.contentWindow) return
      switch (data.type) {
        case 'dsh:ready':
          pageReady = true
          if (ui) ui.host.setAttribute('data-dsh-ready', 'true')
          void syncPage()
          // The first tone is posted before the embedded page has attached its
          // listener, so re-send once the page is up (and on every reload).
          publishTone(true)
          flushPrefill()
          break
        case 'dsh:size':
          applyHeight(data.height)
          break
        case 'dsh:close':
          close()
          break
        case 'dsh:busy':
          void send({ type: 'dsh:badge', busy: Boolean(data.busy) })
          break
        case 'dsh:open-settings':
          void send({ type: 'dsh:open-options' })
          break
        case 'dsh:bind-failed':
          console.warn('[dsh-browser-client] workspace bind failed:', data.message)
          break
        default:
          break
      }
    })

    // Esc closes from the page; inside the iframe the page itself posts dsh:close.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && visible) close()
    }, true)

    // Any click in the page document is outside the floating window: the iframe
    // is a separate document and never bubbles its clicks here.
    document.addEventListener('mousedown', (event) => {
      if (!visible) return
      if (event.composedPath().includes(ui.host)) return
      close()
    }, true)

    let toneTimer = 0
    const scheduleTone = () => {
      if (!visible) return
      clearTimeout(toneTimer)
      toneTimer = setTimeout(publishTone, 120)
    }
    window.addEventListener('scroll', scheduleTone, { passive: true, capture: true })
    window.addEventListener('resize', scheduleTone, { passive: true })

    // SPA navigation: the bound directory may change.
    let lastUrl = location.href
    const observer = new MutationObserver(() => {
      if (location.href === lastUrl) return
      lastUrl = location.href
      if (visible) void syncPage()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return
      const run = async () => {
        switch (message.type) {
          case 'dsh:toggle':
            await toggle()
            break
          case 'dsh:toggle-mode':
            if (!visible) await open()
            else setMode(mode === 'minimal' ? 'standard' : 'minimal')
            break
          case 'dsh:open':
            await open({ mode: message.mode, prefill: message.prefill })
            break
          case 'dsh:ask-ui': {
            const answer = await new Promise((resolve) => showAsk({
              requestId: message.requestId,
              question: message.question,
              detail: message.detail,
              options: message.options
            }, resolve))
            sendResponse({ ok: true, answered: answer !== null, answer })
            break
          }
          default:
            return
        }
        sendResponse({ ok: true })
      }
      void run()
      return true
    })

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.dshConfig) return
      config = null
      lastTone = ''
      if (!visible) return
      ui.loaded = false
      pageReady = false
      void ensureFrame(mode).then((ok) => {
        if (!ok) return
        ui.frame.classList.remove('error')
        void syncPage()
        publishTone()
      })
    })
  }

  try {
    const { host, shadow } = createShadowHost()
    ui = buildUi(shadow)
    ui.host = host
    bindEvents()
  } catch (err) {
    console.error('[dsh-browser-client] init failed', err)
  }
})()
