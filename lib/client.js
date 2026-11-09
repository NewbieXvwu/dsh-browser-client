/**
 * dsh-browser-host — client face (DSH client-module bundle).
 *
 * Format: the harness's client module loader (`window.__ModuleLoader__`) hands
 * us a `require` that resolves platform modules and other client plugins. We
 * export the plugin lifecycle (`name` / `inject` / `apply`) exactly like the
 * upstream `lib/client.js` bundles under node_modules/@deepseek-ai/dsh-client-*.
 *
 * The package declares this file through `exports["./client"]` and
 * `dsh.client = { platform: 'web', inject: [ ...package ids... ] }`, so the
 * client-module registry discovers it automatically and adds it to the boot
 * graph — including the graph served to the floating window.
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-host',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

/**
     * client.js — the client-side face of the browser floating window.
     *
     * This is a normal DSH client plugin: the harness loads it through
     * `window.__ModuleLoader__.load({ id, factory })` and mounts it only when the
     * WebUI page actually runs. It is *inert in the production WebUI* and only
     * activates inside the floating window, where `window.__DSH_EMBED__` was set by
     * `/browser-ui/transport.js`.
     *
     * What it does — and only this:
     *
     *   1. binds the floating window to the directory of the page the user is on
     *      (the extension posts `dsh:bind-dir`; we reuse/create the workspace and
     *      open its session through the public services, never through a fork of
     *      the session or chat components);
     *   2. reports whether the active session is running (`dsh:busy`) so the
     *      launcher can show a dot without polling;
     *   3. answers `dsh:ready` so the extension knows the real WebUI booted.
     *
     * Chrome removal is not done by patching components: `assets/embed.css`
     * hides the harness navigation regions, which keeps this file tiny and keeps
     * upstream components untouched (the whole point of serving the real WebUI).
     */

    const EMBED_ORIGIN = /^(chrome-extension|moz-extension|safari-extension):\/\//;

    /** Resolve the current main session summary, if any. */
    function mainSession(sessions) {
      const store = sessions && sessions.list ? sessions.list : sessions
      const state = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined
      if (!state || !state.byId) return undefined
      const entries = Object.values(state.byId)
      const main = entries.find((s) => ((s && s.retainedBy && s.retainedBy.mainView) || 0) > 0)
      return main || entries.find((s) => s && s.running) || entries[entries.length - 1]
    }

    const name = 'dsh-browser-embed'

    /** Services that must exist before the embed behaviour activates. */
    const inject = ['remote', 'remote.workspace', 'remote.session', 'sessions', 'uiWorkspace']

    function apply(ctx) {
      if (typeof window === 'undefined') return
      const embed = window.__DSH_EMBED__
      if (!embed || typeof embed !== 'object' || typeof embed.token !== 'string' || embed.token === '') return

      const uiWorkspace = ctx.get('uiWorkspace')
      const sessions = ctx.get('sessions')
      if (!uiWorkspace || !sessions) return

      const log = (...args) => console.debug('[dsh-browser-embed]', ...args)
      const parentOrigin = (() => {
        try {
          const ref = document.referrer
          if (typeof ref === 'string' && ref !== '') return new URL(ref).origin
        } catch { /* not embedded */ }
        return undefined
      })()

      let boundDir
      let boundWorkspace
      let binding

      const post = (message, targetOrigin = parentOrigin || '*') => {
        try {
          if (window.parent !== window) window.parent.postMessage(message, targetOrigin)
        } catch { /* no parent */ }
      }

      const sameDir = (a, b) => {
        if (!a || !b) return false
        // macOS /tmp is a symlink to /private/tmp; the harness reports real paths.
        const norm = (p) => String(p).replace(/\/+$/, '').replace(/^\/private(?=\/)/, '')
        return norm(a) === norm(b)
      }

      const dirOf = (workspaceId) => {
        if (!workspaceId) return undefined
        try {
          const workspaces = ctx.get('workspaces')
          const snapshot = workspaces && typeof workspaces.getSnapshot === 'function' ? workspaces.getSnapshot() : undefined
          const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
          const entry = items.find((item) => item && item.workspaceId === workspaceId)
          return entry && entry.path
        } catch {
          return undefined
        }
      }

      /** Reuse a session of this workspace, or create one, and return its id. */
      const openSessionIn = async (workspaceId) => {
        const snapshot = sessions.list.getSnapshot()
        const candidates = Object.values((snapshot && snapshot.byId) || {})
          .filter((s) => s && s.cwd && sameDir(s.cwd, boundDir))
          .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        const reusable = candidates.find((s) => s.blank) || candidates[0]
        if (reusable) return reusable.id
        const result = await ctx.remote.session.create({ workspaceId })
        const value = result && result.ok === true && result.value ? result.value : result
        return value && value.sessionId
      }

      /** The app finishes booting after `dsh:ready`; the first create can lose that race. */
      const createWorkspace = async (dir) => {
        let lastError
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            return await ctx.remote.workspace.create({ path: dir })
          } catch (err) {
            lastError = err
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
          }
        }
        throw lastError
      }

      const ensureBound = async (dir, { force = false } = {}) => {
        if (typeof dir !== 'string' || dir === '') return undefined
        if (!force && dir === boundDir) return boundWorkspace
        if (binding) return binding
        binding = (async () => {
          try {
            const result = await createWorkspace(dir)
            // Typed remotes answer with the RPC envelope; tolerate both shapes so a
            // transport change upstream cannot silently break binding.
            const value = result && result.ok === true && result.value ? result.value : result
            embed.lastResult = value
            const workspace = value && value.workspace
            const workspaceId = workspace && workspace.workspaceId
            if (!workspaceId) throw new Error('workspace.create returned no workspaceId: ' + JSON.stringify(result))
            boundDir = dir
            boundWorkspace = workspaceId
            // Open a concrete session instead of `uiWorkspace.openWorkspace`:
            // that helper builds its navigation from `layout.beginNavigation()`
            // and silently returns when another navigation is in flight, which
            // left the window on the welcome screen after a bind.
            const sessionId = await openSessionIn(workspaceId)
            if (sessionId) uiWorkspace.openSession(sessionId)
            log('bound to', dir, workspaceId)
            post({ type: 'dsh:bound', dir, workspaceId, created: Boolean(value.created) })
            return workspaceId
          } catch (err) {
            embed.lastError = String(err && err.message || err)
            log('bind failed', err)
            post({ type: 'dsh:bind-failed', dir, message: String(err && err.message || err) })
            return undefined
          } finally {
            binding = undefined
          }
        })()
        return binding
      }

      // Status: `dsh:busy` follows the active session's running flag.
      let busy
      const publishBusy = () => {
        const current = mainSession(sessions)
        const next = Boolean(current && current.running)
        if (next === busy) return
        busy = next
        post({ type: 'dsh:busy', busy })
      }
      const unsubscribe = sessions.list.subscribe(publishBusy)

      const onMessage = (event) => {
        if (window.parent === window || event.source !== window.parent) return
        const data = event.data
        if (!data || typeof data !== 'object') return
        // Presentation messages only style this page; binding is privileged and
        // must come from an extension origin.
        const extension = EMBED_ORIGIN.test(event.origin)
        if (data.type === 'dsh:bind-dir') {
          if (extension) void ensureBound(data.dir, { force: Boolean(data.force) })
        } else if (data.type === 'dsh:page-url' && data.dir) {
          if (extension) void ensureBound(data.dir)
        } else if (data.type === 'dsh:set-mode') {
          applyMode(data.mode)
        } else if (data.type === 'dsh:tone') {
          document.documentElement.setAttribute('data-dsh-tone', data.tone === 'light' ? 'light' : 'dark')
        } else if (data.type === 'dsh:prefill') {
          prefillComposer(data.text)
        }
      }
      window.addEventListener('message', onMessage)


      // ── presentations ───────────────────────────────────────────────────────
      //
      // `minimal` shows the newest model reply and the composer, all on a
      // transparent background. `standard` is the 520px window. Both are the
      // same booted client — switching presentations never reloads the page and
      // never drops the running turn.

      const hidden = new Set()
      let minimalObserver
      let minimalFrame = 0
      let resizeObserver
      // transport.js seeds this from `?mode=`; it stays a string until the
      // `embed.mode()` hook replaces it below.
      const initialMode = embed.mode === 'standard' ? 'standard' : 'minimal'
      let currentMode = initialMode

      const hideForMinimal = (el) => {
        if (!el || el.nodeType !== 1) return
        if (!hidden.has(el)) {
          hidden.add(el)
          el.setAttribute('data-dsh-min-hidden', el.style.display || '')
        }
        el.style.setProperty('display', 'none', 'important')
      }

      const restoreHidden = () => {
        for (const el of hidden) {
          el.style.removeProperty('display')
          const previous = el.getAttribute('data-dsh-min-hidden')
          if (previous) el.style.display = previous
          el.removeAttribute('data-dsh-min-hidden')
        }
        hidden.clear()
      }

      /** The webui folds a finished Turn's answer into its process disclosure.
       *  Open the newest disclosure once so the answer becomes a real row. */
      const expandTurnProcess = () => {
        const rows = document.querySelectorAll('[data-chat-flow-kind="turn-process"]')
        const row = rows[rows.length - 1]
        if (!row || row.hasAttribute('data-dsh-expanded')) return false
        const toggle = row.querySelector('button[aria-expanded="false"]')
          || row.querySelector('[role="button"][aria-expanded="false"]')
          || row.querySelector('button')
        if (!toggle) return false
        row.setAttribute('data-dsh-expanded', '')
        toggle.click()
        return true
      }

      /** Mark the newest assistant reply (or turn error) as the only visible row. */
      const markLastRow = () => {
        const rows = document.querySelectorAll('[data-chat-flow-kind]')
        for (const row of rows) row.removeAttribute('data-dsh-last')
        let last
        for (const row of rows) {
          const kind = row.getAttribute('data-chat-flow-kind')
          if (kind === 'assistant' || kind === 'assistant-step' || kind === 'turn-error') last = row
        }
        if (last) last.setAttribute('data-dsh-last', '')
        if (!last && expandTurnProcess()) {
          setTimeout(markLastRow, 300)
          setTimeout(markLastRow, 900)
        }
        return last
      }

      /** The hero block (brand, workspace row, preset, options) lives beside the
       *  composer bar. Keep only the chain that contains the bar. */
      const pruneComposerChrome = () => {
        const seat = document.querySelector('[data-composer-seat]')
        const bar = seat && seat.querySelector('[data-slot="conversation.composer.bar"]')
        if (!seat || !bar) return
        let node = bar
        while (node && node !== seat && node.parentElement) {
          for (const sibling of Array.from(node.parentElement.children)) {
            if (sibling !== node) hideForMinimal(sibling)
          }
          node = node.parentElement
        }
      }

      /** The action row (attach / permission chip / send) is chrome in minimal
       *  mode: Enter sends, so the row can go entirely. */
      const markActions = () => {
        const card = document.querySelector('[data-composer-card]')
        const row = card ? card.lastElementChild : null
        if (row && row.tagName === 'DIV') row.classList.add('dsh-min-actions')
      }

      /** Acknowledge the upstream preview notice once: it is a full-screen
       *  informational dialog that would otherwise block the transparent window
       *  for every fresh browser profile. Functional dialogs are untouched. */
      let promoAcknowledged = false
      const dismissPromo = () => {
        if (promoAcknowledged) return
        for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
          const text = String(dialog.innerText || '')
          if (!/预览版说明|Preview notice/i.test(text)) continue
          const button = Array.from(dialog.querySelectorAll('button'))
            .find((b) => /^(继续|知道了|Continue|Got it)$/.test(String(b.innerText || '').trim()))
          if (!button) continue
          button.click()
          promoAcknowledged = true
          return
        }
      }

      /** While a turn runs, keep only the stop control from the composer dock. */
      const pruneDock = () => {
        const dock = document.querySelector('[data-composer-dock]')
        if (!dock) return
        const stop = dock.querySelector('[aria-label*="停止"], [aria-label*="Stop"]')
        for (const child of Array.from(dock.children)) child.classList.remove('dsh-min-stop-seat')
        dock.classList.remove('dsh-min-stop')
        if (!stop) return
        let seat = stop
        while (seat.parentElement && seat.parentElement !== dock) seat = seat.parentElement
        if (seat.parentElement !== dock) return
        for (const child of Array.from(dock.children)) {
          if (child !== seat) hideForMinimal(child)
        }
        seat.classList.add('dsh-min-stop-seat')
        dock.classList.add('dsh-min-stop')
      }

      /** Keep the newest row above the composer when the window is short. */
      const stickToBottom = () => {
        const row = document.querySelector('[data-chat-flow-kind][data-dsh-last]')
        if (!row) return
        let node = row.parentElement
        while (node && node !== document.body) {
          const style = getComputedStyle(node)
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
            node.scrollTop = node.scrollHeight
            return
          }
          node = node.parentElement
        }
      }

      /** Report the content height so the extension can size the iframe. */
      const publishSize = () => {
        if (currentMode !== 'minimal') return
        const row = document.querySelector('[data-chat-flow-kind][data-dsh-last]')
        const seat = document.querySelector('[data-composer-seat]')
        const viewport = window.innerHeight
        const composer = seat ? Math.max(48, viewport - seat.getBoundingClientRect().top) : 96
        const rowHeight = row ? row.getBoundingClientRect().height : 0
        const wanted = Math.round(rowHeight + composer + 20)
        // The iframe starts small and grows: clamp against a fixed ceiling and
        // let the content script apply the page-height cap.
        const height = Math.min(Math.max(wanted, 84), 600)
        post({ type: 'dsh:size', height })
        requestAnimationFrame(stickToBottom)
        setTimeout(stickToBottom, 120)
      }

      const measure = () => {
        if (currentMode !== 'minimal') return
        if (minimalFrame) return
        minimalFrame = requestAnimationFrame(() => {
          minimalFrame = 0
          if (resizeObserver) resizeObserver.disconnect()
          const row = markLastRow()
          pruneComposerChrome()
          markActions()
          dismissPromo()
          pruneDock()
          if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => publishSize())
            const bar = document.querySelector('[data-slot="conversation.composer.bar"]')
            if (row) resizeObserver.observe(row)
            if (bar) resizeObserver.observe(bar)
          }
          publishSize()
        })
      }

      const startMinimal = () => {
        if (minimalObserver) return
        document.documentElement.setAttribute('data-dsh-mode', 'minimal')
        minimalObserver = new MutationObserver(() => measure())
        minimalObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
        measure()
      }

      const stopMinimal = () => {
        if (minimalObserver) minimalObserver.disconnect()
        minimalObserver = undefined
        if (minimalFrame) cancelAnimationFrame(minimalFrame)
        minimalFrame = 0
        if (resizeObserver) resizeObserver.disconnect()
        resizeObserver = undefined
        restoreHidden()
        const dock = document.querySelector('[data-composer-dock]')
        if (dock) {
          dock.classList.remove('dsh-min-stop')
          for (const child of Array.from(dock.children)) child.classList.remove('dsh-min-stop-seat')
        }
        for (const row of document.querySelectorAll('[data-chat-flow-kind][data-dsh-last]')) {
          row.removeAttribute('data-dsh-last')
        }
      }

      const applyMode = (next) => {
        currentMode = next === 'standard' ? 'standard' : 'minimal'
        const root = document.documentElement
        if (currentMode === 'minimal') {
          root.setAttribute('data-dsh-mode', 'minimal')
          // Chromium paints an opaque white canvas behind a transparent
          // document when the scheme is `light`; `dark` keeps it see-through.
          root.style.setProperty('color-scheme', 'dark')
          startMinimal()
        } else {
          root.setAttribute('data-dsh-mode', 'standard')
          root.style.removeProperty('color-scheme')
          stopMinimal()
        }
      }

      /** Insert text into the Lexical composer. Best effort: never blocks open. */
      const prefillComposer = (text) => {
        const editor = document.querySelector('[data-composer-input]')
        if (!editor || typeof text !== 'string' || text.trim() === '') return false
        const current = String(editor.innerText || '')
        if (current.includes(text.trim())) return true
        editor.focus()
        // Lexical inserts through its paste pipeline; execCommand alone is
        // ignored by several of its versions and lands twice when combined
        // with a paste event, so paste is the only path.
        try {
          const data = new DataTransfer()
          data.setData('text/plain', text)
          editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        } catch { /* DataTransfer is unavailable */ }
        return String(editor.innerText || '').includes(text.trim())
      }

      const onEmbedKey = (event) => {
        if (event.key === 'Escape') post({ type: 'dsh:close' })
      }

      // Test hook + extension fallback: binding is callable without postMessage.
      embed.bindDir = (dir) => ensureBound(dir, { force: true })
      embed.dir = () => boundDir
      embed.workspaceId = () => boundWorkspace
      embed.dirOf = () => dirOf(boundWorkspace)
      embed.newSession = () => uiWorkspace.openWorkspace(boundWorkspace)
      embed.openSession = (sessionId) => uiWorkspace.openSession(sessionId)
      embed.storeSessions = () => Object.values((sessions.list.getSnapshot() || {}).byId || {}).map((item) => ({
        id: item.id, cwd: item.cwd, blank: item.blank, main: (item.retainedBy || {}).mainView || 0
      }))
      embed.listSessions = async () => {
        const result = await ctx.remote.session.list({})
        const value = result && result.ok === true && result.value ? result.value : result
        return (value && value.items) || []
      }
      embed.mainSessionId = () => {
        const session = mainSession(sessions)
        return session ? session.id : null
      }
      embed.mode = () => currentMode
      embed.setMode = (next) => applyMode(next)
      embed.lastKind = () => {
        const row = document.querySelector('[data-chat-flow-kind][data-dsh-last]')
        return row ? row.getAttribute('data-chat-flow-kind') : null
      }
      embed.bounds = () => {
        const row = document.querySelector('[data-chat-flow-kind][data-dsh-last]')
        return row ? row.getBoundingClientRect().toJSON() : null
      }
      embed.composerText = () => {
        const editor = document.querySelector('[data-composer-input]')
        return editor ? String(editor.innerText || '') : ''
      }
      embed.prefill = (text) => prefillComposer(text)
      window.addEventListener('keydown', onEmbedKey)

      applyMode(initialMode)
      // Opened directly (toolbar popup window): the browser paints white behind
      // us, and no parent frame will report a tone.
      if (window.parent === window) document.documentElement.setAttribute('data-dsh-tone', 'light')
      if (typeof embed.prefill === 'string' && embed.prefill) {
        // Selected text from the page arrives as a URL param for standalone
        // windows; the composer may not exist until the first session opens.
        const tryPrefill = (left) => {
          if (prefillComposer(embed.prefill)) return
          if (left > 0) setTimeout(() => tryPrefill(left - 1), 250)
        }
        setTimeout(() => tryPrefill(8), 300)
      }

      ctx.effect(() => () => {
        window.removeEventListener('message', onMessage)
        window.removeEventListener('keydown', onEmbedKey)
        stopMinimal()
        unsubscribe()
      }, 'dsh-browser-embed: bridge')

      publishBusy()
      post({ type: 'dsh:ready', tokenKind: 'embed' })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
