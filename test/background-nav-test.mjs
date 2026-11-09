/**
 * background-nav-test.mjs — the floating window must come back after a full
 * page navigation (the iframe is torn out of the DOM with the old document).
 *
 * Loads background.js in a vm with a mocked chrome.* surface, reports the
 * panel as open for a tab, fires webNavigation.onCompleted, and asserts the
 * worker re-sends `dsh:open` to that tab with the remembered mode.
 */
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const src = await readFile(new URL('../browser-ext/extension/background/background.js', import.meta.url), 'utf8')

const sent = []
const messageListeners = []
const navListeners = []
const storage = {}

const chrome = {
  storage: {
    local: {
      async get(key) { return key in storage ? { [key]: storage[key] } : {} },
      async set(patch) { Object.assign(storage, patch) }
    }
  },
  action: { onClicked: { addListener() {} }, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  commands: { onCommand: { addListener() {} } },
  contextMenus: { removeAll: async () => {}, create() {}, onClicked: { addListener() {} } },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    openOptionsPage: async () => {}
  },
  tabs: {
    onRemoved: { addListener() {} },
    async sendMessage(tabId, msg) { sent.push({ tabId, msg }) },
    async query() { return [] }
  },
  webNavigation: { onCompleted: { addListener: (fn) => navListeners.push(fn) } },
  windows: { async create() {} },
  tabs2: undefined
}

vm.runInNewContext(src, { chrome, fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }), URL, URLSearchParams, console, setTimeout, Promise })

if (navListeners.length !== 1) throw new Error('expected one webNavigation listener')

const respond = (msg, sender) => new Promise((resolve) => {
  const listener = messageListeners[0]
  const keep = listener(msg, sender, (value) => resolve(value))
  if (keep !== true) resolve(undefined)
})

await respond({ type: 'dsh:panel-state', open: true, mode: 'standard' }, { tab: { id: 7 } })
navListeners[0]({ frameId: 0, tabId: 7 })
await new Promise((r) => setTimeout(r, 50))

const reopened = sent.find((entry) => entry.tabId === 7 && entry.msg && entry.msg.type === 'dsh:open')
if (!reopened) throw new Error('panel was not reopened after navigation')
if (reopened.msg.mode !== 'standard') throw new Error(`wrong mode on reopen: ${reopened.msg.mode}`)

// A subframe navigation must not reopen, and a closed panel must stay closed.
sent.length = 0
await respond({ type: 'dsh:panel-state', open: false }, { tab: { id: 8 } })
navListeners[0]({ frameId: 0, tabId: 8 })
navListeners[0]({ frameId: 3, tabId: 7 })
await new Promise((r) => setTimeout(r, 50))
if (sent.length !== 0) throw new Error(`unexpected reopen: ${JSON.stringify(sent)}`)

console.log('BACKGROUND NAV TEST: PASSED')
