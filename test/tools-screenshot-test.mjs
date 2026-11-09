/**
 * tools-screenshot-test.mjs — page_screenshot results must land on disk and
 * hand the model a readable absolute path (not a giant base64 blob).
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = await mkdtemp(path.join(tmpdir(), 'dsh-shot-'))
process.env.DSH_HOME = dir
const { persistScreenshot } = await import('../lib/tools.js')

// 1x1 transparent PNG
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const out = await persistScreenshot({ ok: true, dataUrl: `data:image/png;base64,${png}`, mode: 'viewport' }, 'my/shot name')

if (!out || typeof out.path !== 'string') throw new Error('no path returned')
if ('dataUrl' in out) throw new Error('base64 still present in the result')
const info = await stat(out.path)
if (info.size !== Buffer.from(png, 'base64').length) throw new Error('written bytes mismatch')
if (!out.path.startsWith(path.join(dir, 'browser-screenshots'))) throw new Error(`unexpected dir: ${out.path}`)
if ((await readFile(out.path)).length === 0) throw new Error('empty file')
if (!/image\/file tool/.test(out.note || '')) throw new Error('note does not tell the model how to read it')

const passthrough = await persistScreenshot({ ok: false, error: 'no active tab' })
if (passthrough.ok !== false) throw new Error('error results must pass through untouched')

await rm(dir, { recursive: true, force: true })
console.log('SCREENSHOT STORE TEST: PASSED')
