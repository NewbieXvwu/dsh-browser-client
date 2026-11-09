/**
 * options.js — connection settings and page→directory rules.
 *
 * Kept deliberately plain: one storage record (`dshConfig`), two forms, a
 * health probe. No framework, no bundler, no extra permissions.
 */
;(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (reply) => resolve(chrome.runtime.lastError ? undefined : reply))
    })
  }

  function setStatus(el, text, kind) {
    el.textContent = text
    el.classList.toggle('ok', kind === 'ok')
    el.classList.toggle('bad', kind === 'bad')
  }

  function ruleRow(rule) {
    const row = document.createElement('div')
    row.className = 'rule'

    const pattern = document.createElement('input')
    pattern.type = 'text'
    pattern.placeholder = 'github.com/acme/*'
    pattern.value = (rule && rule.pattern) || ''
    pattern.setAttribute('aria-label', 'URL 规则')

    const dir = document.createElement('input')
    dir.type = 'text'
    dir.placeholder = '/Users/me/work/acme'
    dir.value = (rule && rule.dir) || ''
    dir.setAttribute('aria-label', '本地目录')

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove'
    remove.textContent = '移除'
    remove.addEventListener('click', () => row.remove())

    row.append(pattern, dir, remove)
    return row
  }

  function renderRules(rules) {
    const list = $('rules')
    list.textContent = ''
    for (const rule of rules) list.appendChild(ruleRow(rule))
    if (!rules.length) list.appendChild(ruleRow(null))
  }

  function collectRules() {
    return [...$('rules').querySelectorAll('.rule')]
      .map((row) => {
        const [pattern, dir] = row.querySelectorAll('input')
        return { pattern: pattern.value.trim(), dir: dir.value.trim() }
      })
      .filter((rule) => rule.pattern && rule.dir)
  }

  async function load() {
    const cfg = (await send({ type: 'dsh:get-config' })) || {}
    $('base-url').value = cfg.baseUrl || ''
    $('token').value = cfg.token || ''
    $('ui-mode').value = cfg.uiMode === 'standard' ? 'standard' : 'minimal'
    renderRules(Array.isArray(cfg.rules) ? cfg.rules : [])
  }

  async function save() {
    const status = $('status')
    const patch = {
      baseUrl: $('base-url').value.trim().replace(/\/+$/, ''),
      token: $('token').value.trim(),
      uiMode: $('ui-mode').value === 'standard' ? 'standard' : 'minimal'
    }
    if (!/^https?:\/\//.test(patch.baseUrl)) {
      setStatus(status, '宿主地址必须以 http:// 或 https:// 开头', 'bad')
      return
    }
    await send({ type: 'dsh:set-config', patch })
    setStatus(status, '已保存', 'ok')
  }

  async function test() {
    const status = $('status')
    setStatus(status, '正在测试…', '')
    const result = await send({
      type: 'dsh:test-connection',
      baseUrl: $('base-url').value.trim(),
      token: $('token').value.trim()
    })
    if (result && result.ok) {
      setStatus(status, `连接正常${result.version ? ` · DSH ${result.version}` : ''}`, 'ok')
    } else {
      setStatus(status, `连接失败：${(result && (result.error || result.status)) || '无响应'}`, 'bad')
    }
  }

  async function saveRules() {
    const rules = collectRules()
    await send({ type: 'dsh:set-config', patch: { rules } })
    setStatus($('rules-status'), `已保存 ${rules.length} 条规则`, 'ok')
  }

  $('reveal').addEventListener('click', () => {
    const input = $('token')
    const shown = input.type === 'text'
    input.type = shown ? 'password' : 'text'
    $('reveal').textContent = shown ? '显示' : '隐藏'
  })
  $('add-rule').addEventListener('click', () => $('rules').appendChild(ruleRow(null)))
  $('save').addEventListener('click', () => void save())
  $('test').addEventListener('click', () => void test())
  $('save-rules').addEventListener('click', () => void saveRules())

  void load()
})()
