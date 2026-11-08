import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EditRequest } from './engine.js'
import { DocumentService } from './host-client.js'

export const name = '@pedropaulovc/dsh-collaborative-docs'
export const inject = ['tools', 'connection']
export interface Config { dataDir?: string; port?: number }
type PluginContext = Context & { connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): unknown } } }
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const id = { type: 'string', required: true, description: 'Document UUID returned by docs_list or docs_create.' } as const
const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/** Cancellation stops waiting; once an atomic durable edit has begun it is not rolled back. */
async function cancellable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => aborted.reject(signal.reason ?? new Error('Aborted'))
  signal.addEventListener('abort', onAbort, { once: true })
  try { return await Promise.race([work(), aborted.promise]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

export function apply(ctx: PluginContext, config: Config = {}) {
  const dataDir = config.dataDir ?? join(homedir(), '.dsh', 'collaborative-docs')
  let storePromise: Promise<DocumentService> | undefined
  let disposed = false
  const getStore = () => {
    if (disposed) throw new Error('Documents plugin has been disposed')
    return storePromise ??= (async () => {
      const store = new DocumentService({ dataDir, port: config.port })
      try { await store.init(); return store }
      catch (error) {
        try { await store.close() }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Store initialization and cleanup failed') }
        throw error
      }
    })().catch(error => { storePromise = undefined; throw error })
  }
  const use = <T>(signal: AbortSignal, operation: (store: DocumentService) => Promise<T>) => cancellable(signal, async () => {
    const store = await getStore(); signal.throwIfAborted(); return await operation(store) as T & Json
  })
  const open = (signal: AbortSignal, documentId?: string) => use(signal, store => store.open(documentId))
  ctx.effect(() => async () => {
    disposed = true
    // The child drains accepted edits before closing its listener and durable store.
    const store = await storePromise?.catch(() => undefined)
    if (store) await store.close()
  }, 'collaborative-docs: isolated document service')

  ctx.tools.register(defineTool({ name: 'docs_open', description: 'Open the local collaborative document editor. The returned URL is a private bootstrap capability; share only with the owner.', parameters: { id: { type: 'string', description: 'Optional document UUID to select.' } }, output, execute: (args, exec) => open(exec.signal, args.id) }))
  ctx.tools.register(defineTool({ name: 'docs_list', description: 'List local collaborative documents.', parameters: {}, output, execute: (_args, exec) => use(exec.signal, store => store.list()) }))
  ctx.tools.register(defineTool({ name: 'docs_read', description: 'Read a document with block IDs, native comment threads, and its revision for guarded edits.', parameters: { id }, output, execute: (args, exec) => use(exec.signal, store => store.read(args.id)) }))
  ctx.tools.register(defineTool({ name: 'docs_create', description: 'Create a local document, optionally importing Markdown text. No filesystem paths are accepted.', parameters: { title: { type: 'string', required: true }, markdown: { type: 'string' } }, output, execute: (args, exec) => use(exec.signal, store => store.create(args)) }))
  ctx.tools.register(defineTool({
    name: 'docs_edit', description: 'Atomically edit by block ID at the exact read revision. Stale revisions fail without modifying the document; reread before retrying. Unaffected blocks and comment anchors remain intact.',
    parameters: {
      id, expectedRevision: { type: 'string', required: true },
      operations: { type: 'array', required: true, items: { oneOf: [
        { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'replace_text', required: true }, blockId: { type: 'string', required: true }, search: { type: 'string', required: true }, replacement: { type: 'string', required: true } } },
        { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'insert_after', required: true }, blockId: { type: 'string', required: true }, markdown: { type: 'string', required: true } } },
        { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'delete_block', required: true }, blockId: { type: 'string', required: true } } },
      ] } },
    }, output,
    execute: (args, exec) => use(exec.signal, store => store.edit(args.id, { expectedRevision: args.expectedRevision, operations: args.operations } as EditRequest)),
  }))
  ctx.tools.register(defineTool({ name: 'docs_comments', description: 'Read native comment threads on a document.', parameters: { id }, output, execute: (args, exec) => use(exec.signal, async store => (await store.read(args.id)).threads) }))
  ctx.tools.register(defineTool({ name: 'docs_reply', description: 'Reply to an existing native comment thread.', parameters: { id, threadId: { type: 'string', required: true }, text: { type: 'string', required: true } }, output, execute: (args, exec) => use(exec.signal, store => store.reply(args.id, args.threadId, args.text)) }))
  ctx.tools.register(defineTool({ name: 'docs_resolve', description: 'Resolve or reopen an existing native comment thread.', parameters: { id, threadId: { type: 'string', required: true }, state: { type: 'string', enum: ['resolved', 'open'], required: true } }, output, execute: (args, exec) => use(exec.signal, store => store.resolve(args.id, args.threadId, args.state)) }))
  ctx.tools.register(defineTool({ name: 'docs_export', description: 'Export current document content as Markdown text, not a filesystem write.', parameters: { id }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: (args, exec) => use(exec.signal, store => store.exportMarkdown(args.id)) }))

  // Exact Connection routes are owner-only in rc.3. Speak the RPC envelope so
  // the desktop IPC carrier works without a browser-relative fetch assumption.
  ctx.connection.fetch.register({
    path: '/api/collaborative_docs_open', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const raw = await request.text()
      if (raw.length > 4096) return new Response('Request too large', { status: 413 })
      let message: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
      try { message = JSON.parse(raw) } catch { return new Response('Invalid JSON', { status: 400 }) }
      if (!message || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.rpcId.length > 200 || message.method !== 'collaborative_docs_open' || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload) || Object.keys(message.payload).length) return new Response('Invalid request', { status: 400 })
      const value = await open(request.signal)
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }, { headers: { 'Cache-Control': 'no-store' } })
    },
  })
}
