/**
 * background.js — MV3 service worker for DSH Browser Client.
 *
 * Owns the things a page cannot do:
 *
 *  - host base URL + token + URL→directory rules (chrome.storage.local),
 *  - the toolbar action: toggles the floating window, or opens the WebUI in a
 *    standalone window on pages that cannot host content scripts,
 *  - running page tools: the embedded page asks (`dsh:exec-tool` through the
 *    content script), and we forward to that tab's `page-tools.js`,
 *  - visible-tab screenshots for `page_screenshot`.
 *
 * The chat UI itself is not here. It is the real DSH WebUI the host plugin
 * serves at `${baseUrl}/browser-ui/`; this worker never renders anything.
 */

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3080',
  token: '',
  // Rules: [{ pattern: 'github.com/foo/*', dir: '/Users/me/work/foo' }]
  rules: []
}

const EMBED_PATH = '/browser-ui/'

async function getConfig() {
  const stored = await chrome.storage.local.get('dshConfig')
  return { ...DEFAULTS, ...(stored.dshConfig || {}) }
}

async function setConfig(patch) {
  const cur = await getConfig()
  const next = { ...cur, ...patch }
  await chrome.storage.local.set({ dshConfig: next })
  return next
}

function embedUrl(cfg) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '')
  return `${base}${EMBED_PATH}?token=${encodeURIComponent(cfg.token || '')}`
}

/** Match a URL against a rule pattern; return the mapped dir or null. */
function matchRule(url, rules) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname
  const path = u.pathname
  for (const rule of rules || []) {
    const pattern = String((rule && rule.pattern) || '')
    if (!pattern) continue
    const star = pattern.indexOf('/*')
    const hostPart = star === -1 ? pattern : pattern.slice(0, star)
    const pathPart = star === -1 ? '/' : pattern.slice(star + 1) || '/'
    if (host.endsWith(hostPart) || host === hostPart) {
      if (path.startsWith(pathPart)) return rule.dir || null
    }
  }
  return null
}

async function resolveDirForUrl(url) {
  const cfg = await getConfig()
  const matched = matchRule(url, cfg.rules)
  return matched ? { dir: matched, via: 'rule' } : { dir: null, via: 'none' }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

async function captureScreenshot(msg) {
  try {
    const tab = await activeTab()
    if (!tab || !tab.id) return { ok: false, error: 'no active tab' }
    if (!tab.active) return { ok: false, error: 'tab not active; cannot capture' }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    return { ok: true, dataUrl, mode: msg.mode || 'viewport', name: msg.name || null }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

async function runPageTool(message, sender) {
  const tabId = (sender && sender.tab && sender.tab.id) || (await activeTab()).id
  if (!tabId) return { ok: false, error: { code: 'no-tab', message: '没有可执行的目标标签页' } }
  try {
    const reply = await chrome.tabs.sendMessage(tabId, {
      type: 'dsh:tool',
      tool: message.tool,
      args: message.args || {}
    })
    return reply || { ok: false, error: { code: 'no-reply', message: '页面工具没有返回结果' } }
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'tab-unavailable',
        message: `当前页面不能执行页面工具：${String((err && err.message) || err)}`
      }
    }
  }
}

async function openOptions() {
  await chrome.runtime.openOptionsPage().catch(() => {})
}

async function openStandalone() {
  const cfg = await getConfig()
  if (!cfg.token) {
    await openOptions()
    return
  }
  const width = 520
  const height = 800
  await chrome.windows.create({ url: embedUrl(cfg), type: 'popup', width, height })
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) {
    await openStandalone()
    return
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'dsh:toggle' })
  } catch {
    // chrome:// pages, the Web Store, PDF viewer, etc. have no content script.
    await openStandalone()
  }
})

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') await openOptions()
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return
  ;(async () => {
    switch (msg.type) {
      case 'dsh:get-config':
        sendResponse(await getConfig())
        break
      case 'dsh:set-config':
        sendResponse(await setConfig(msg.patch || {}))
        break
      case 'dsh:resolve-dir':
        sendResponse(await resolveDirForUrl(msg.url || ''))
        break
      case 'dsh:screenshot':
        sendResponse(await captureScreenshot(msg))
        break
      case 'dsh:exec-tool':
        sendResponse(await runPageTool(msg, sender))
        break
      case 'dsh:open-options':
        await openOptions()
        sendResponse({ ok: true })
        break
      case 'dsh:test-connection': {
        sendResponse(await testConnection(msg.baseUrl, msg.token))
        break
      }
      default:
        sendResponse({ ok: false, error: `unknown message ${msg.type}` })
    }
  })()
  return true // async response
})

/** Health probe used by the options page (host `/ext-api-health`). */
async function testConnection(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/ext-api-health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      cache: 'no-store'
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok !== true) {
      return { ok: false, status: res.status, error: body && body.error ? body.error : `HTTP ${res.status}` }
    }
    return { ok: true, status: res.status, version: body.version || null }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}
