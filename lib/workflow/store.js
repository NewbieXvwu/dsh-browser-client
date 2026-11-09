/**
 * store.js — durable WorkflowDefinition store.
 *
 * Preferred backend: the harness `storageDomain` service (a `workflows` table
 * in the `dsh_browser_workflows` domain, validated by the zod schema below).
 * DSH 0.2.2's storage-domain service accepts a duck-typed spec, so no
 * `@deepseek-ai/*` import is needed (a plugin installed outside the harness's
 * package tree could not resolve one anyway). When the service is missing we
 * fall back to a single JSON file under $DSH_HOME. Both backends expose the
 * same API, so the workflow subsystem never has to care.
 *
 * Usage (host side, inside the plugin):
 *   const store = await openWorkflowStore(ctx)
 *   const saved = await store.save(def)   // assigns id on create
 *   const all = store.list()
 *   const one = store.get(id)
 *   await store.remove(id)
 *   store.close()                         // plugin teardown
 */

import z from 'zod'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Zod schema for a stored workflow record (validated at the durable boundary). */
export const WorkflowRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.number(),
  trigger: z.object({
    kind: z.union([z.literal('manual'), z.literal('schedule')]).default('manual'),
    schedule: z.object({
      everySeconds: z.number().optional(),
      at: z.string().optional(),
      timeZone: z.string().optional()
    }).optional()
  }).default({ kind: 'manual' }),
  target: z.object({
    urlPattern: z.string().default('*'),
    titlePattern: z.string().optional()
  }).default({ urlPattern: '*' }),
  steps: z.array(z.unknown()).default([]),
  parameters: z.array(z.unknown()).default([]),
  approval: z.object({
    confirmOn: z.array(z.union([z.literal('write'), z.literal('batch'), z.literal('navigate-external')])).default(['write', 'batch']),
    sampleBeforeBatch: z.boolean().default(true)
  }).default({ confirmOn: ['write', 'batch'], sampleBeforeBatch: true }),
  verify: z.object({
    successCriteria: z.array(z.string()).default([]),
    retry: z.object({
      maxAttempts: z.number().default(1),
      onFailure: z.union([z.literal('ask-user'), z.literal('skip'), z.literal('stop')]).default('ask-user')
    }).default({ successCriteria: [], retry: { maxAttempts: 1, onFailure: 'ask-user' } })
  }).default({ successCriteria: [], retry: { maxAttempts: 1, onFailure: 'ask-user' } }),
  output: z.object({
    saveScreenshots: z.boolean().default(false),
    collectTo: z.union([z.literal('workspace'), z.literal('sheet'), z.literal('copy')]).default('workspace')
  }).default({ saveScreenshots: false, collectTo: 'workspace' })
})

const DEFAULT_STORE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'browser-workflows.json')
const DOMAIN_NAME = 'dsh_browser_workflows'
const TABLE_NAME = 'workflows'

/** Zod-error message without depending on a specific zod major's shape. */
const errorMessage = (error) => String((error && error.message) || error)

/**
 * Assert one record against the schema and return the parsed value.
 * @param {unknown} rec
 */
function assertRecord(rec) {
  const parsed = WorkflowRecordSchema.safeParse(rec)
  if (!parsed.success) throw new Error(`corrupt workflow record: ${errorMessage(parsed.error)}`)
  return parsed.data
}

/** Build the store facade over a minimal get/put/delete/entries/size table. */
function storeOverTable(table, close) {
  return {
    list() {
      const out = []
      for (const [, value] of table.entries()) out.push(assertRecord(value))
      out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      return out
    },

    get(id) {
      const value = table.get(id)
      return value ? assertRecord(value) : undefined
    },

    async save(def) {
      const now = Date.now()
      const existing = def.id ? table.get(def.id) : undefined
      const record = {
        ...(existing || {}),
        ...def,
        id: def.id || randomUUID(),
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        version: existing ? (existing.version || 0) + 1 : 1
      }
      assertRecord(record)
      await table.put(record.id, record)
      return assertRecord(table.get(record.id))
    },

    async remove(id) {
      return table.delete(id)
    },

    get size() {
      return table.size
    },

    close
  }
}

/** File-backed fallback: one JSON object keyed by workflow id. */
async function openFileStore(file) {
  let records = new Map()
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      records = new Map(Object.entries(parsed))
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.warn(`[dsh-browser-host] workflow store: ignoring unreadable ${file}: ${errorMessage(err)}`)
  }

  let writing = Promise.resolve()
  const persist = () => {
    writing = writing.then(async () => {
      const data = {}
      for (const [key, value] of records) data[key] = value
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(data, null, 2), 'utf8')
    }).catch((err) => console.warn(`[dsh-browser-host] workflow store write failed: ${errorMessage(err)}`))
    return writing
  }
  const table = {
    get: (id) => records.get(id),
    entries: () => [...records.entries()],
    async put(id, value) { records.set(id, value); await persist() },
    async delete(id) { const had = records.delete(id); if (had) await persist(); return had },
    get size() { return records.size }
  }
  return storeOverTable(table, async () => { await writing })
}

/**
 * Try the harness storage-domain backend.
 *
 * The spec is built duck-typed instead of importing
 * `@deepseek-ai/dsh-storage-domain`: a plugin installed outside the harness's
 * own package tree cannot resolve that module, yet the *service* only needs a
 * `{ name, version, tables: { <name>: { valueSchema: { parse } } } }` spec.
 * That keeps the durable backend working with no @deepseek-ai/* dependency.
 */
async function openDomainStore(ctx) {
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain === undefined || typeof storageDomain.open !== 'function') return undefined
  try {
    const spec = {
      name: DOMAIN_NAME,
      version: 1,
      tables: { [TABLE_NAME]: { valueSchema: WorkflowRecordSchema } }
    }
    const domain = await storageDomain.open(spec)
    const table = domain.table(TABLE_NAME)
    return storeOverTable(table, () => domain.close())
  } catch (err) {
    console.warn(`[dsh-browser-host] workflow store: storageDomain backend unavailable: ${errorMessage(err)}`)
    return undefined
  }
}

/**
 * Open the workflow store. Caller owns close() (typically ctx.effect disposer).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ file?: string }} [options]
 * @returns {Promise<ReturnType<typeof storeOverTable>>}
 */
export async function openWorkflowStore(ctx, options = {}) {
  const domainStore = await openDomainStore(ctx)
  if (domainStore) return domainStore
  const file = options.file || DEFAULT_STORE_FILE
  console.warn(`[dsh-browser-host] workflow store: storageDomain unavailable, using file store ${file}`)
  return openFileStore(file)
}
