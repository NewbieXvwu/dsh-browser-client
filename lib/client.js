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
      const state = sessions && typeof sessions.getSnapshot === 'function' ? sessions.getSnapshot() : undefined
      if (!state || !state.byId) return undefined
      const entries = Object.values(state.byId)
      const main = entries.find((s) => ((s && s.retainedBy && s.retainedBy.mainView) || 0) > 0)
      return main || entries.find((s) => s && s.running) || entries[entries.length - 1]
    }

    const name = 'dsh-browser-embed'

    /** Services that must exist before the embed behaviour activates. */
    const inject = ['remote', 'remote.workspace', 'sessions', 'uiWorkspace']

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

      const ensureBound = async (dir, { force = false } = {}) => {
        if (typeof dir !== 'string' || dir === '') return undefined
        if (!force && dir === boundDir) return boundWorkspace
        if (binding) return binding
        binding = (async () => {
          try {
            const result = await ctx.remote.workspace.create({ path: dir })
            // Typed remotes answer with the RPC envelope; tolerate both shapes so a
            // transport change upstream cannot silently break binding.
            const value = result && result.ok === true && result.value ? result.value : result
            embed.lastResult = value
            const workspace = value && value.workspace
            const workspaceId = workspace && workspace.workspaceId
            if (!workspaceId) throw new Error('workspace.create returned no workspaceId: ' + JSON.stringify(result))
            boundDir = dir
            boundWorkspace = workspaceId
            await uiWorkspace.openWorkspace(workspaceId)
            log('bound to', dir, workspaceId)
            post({ type: 'dsh:bound', dir, workspaceId, created: Boolean(value.created) })
            return workspaceId
          } catch (err) {
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
        if (!EMBED_ORIGIN.test(event.origin)) return
        const data = event.data
        if (!data || typeof data !== 'object') return
        if (data.type === 'dsh:bind-dir') {
          void ensureBound(data.dir, { force: Boolean(data.force) })
        } else if (data.type === 'dsh:page-url' && data.dir) {
          // The extension resolved the mapping already; bind without a round-trip.
          void ensureBound(data.dir)
        }
      }
      window.addEventListener('message', onMessage)

      // Test hook + extension fallback: binding is callable without postMessage.
      embed.bindDir = (dir) => ensureBound(dir, { force: true })
      embed.dir = () => boundDir
      embed.workspaceId = () => boundWorkspace
      embed.dirOf = () => dirOf(boundWorkspace)
      embed.newSession = () => uiWorkspace.openWorkspace(boundWorkspace)

      ctx.effect(() => () => {
        window.removeEventListener('message', onMessage)
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
