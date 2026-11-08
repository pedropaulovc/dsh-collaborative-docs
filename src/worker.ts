import { DocumentStore } from './engine.js'
import { startServer, type LocalDocumentServer } from './server.js'
import type { ServiceConfig, ServiceError, ServiceReply, ServiceRequest } from './host-client.js'

if (!process.send) throw new Error('Document service requires a parent IPC channel')

let config: ServiceConfig | undefined
let store: DocumentStore | undefined
let initializing: Promise<void> | undefined
let serverPromise: Promise<LocalDocumentServer> | undefined
let closing: Promise<void> | undefined
const active = new Set<Promise<void>>()

function serializeError(error: unknown): ServiceError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  const details = error as Error & { code?: string; status?: number }
  return { name: error.name, message: error.message, stack: error.stack, code: details.code, status: details.status }
}

function shutdown() {
  return closing ??= (async () => {
    // All accepted operations settle before closing the listener and durable store.
    await Promise.allSettled([...active])
    const errors: unknown[] = []
    const server = await serverPromise?.catch(() => undefined)
    if (server) {
      try { await server.close() } catch (error) { errors.push(error) }
    }
    if (store) {
      try { await store.close() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Document service cleanup failed')
  })()
}

async function execute(request: Exclude<ServiceRequest, { method: 'close' }>) {
  if (request.method === 'init') {
    return initializing ??= (async () => {
      config = request.args[0]
      store = new DocumentStore(config.dataDir)
      await store.init()
    })()
  }
  if (!initializing) throw new Error('Document service is not initialized')
  await initializing
  const documents = store!
  switch (request.method) {
    case 'list': return documents.list(...request.args)
    case 'read': return documents.read(...request.args)
    case 'create': return documents.create(...request.args)
    case 'edit': return documents.edit(...request.args)
    case 'reply': return documents.reply(...request.args)
    case 'resolve': return documents.resolve(...request.args)
    case 'exportMarkdown': return documents.exportMarkdown(...request.args)
    case 'open': {
      const [id] = request.args
      if (id) await documents.read(id)
      const server = await (serverPromise ??= startServer({ ...config!, store: documents })
        .catch(error => { serverPromise = undefined; throw error }))
      const url = new URL(server.url)
      if (id) url.searchParams.set('document', id)
      return { url: url.href }
    }
  }
}

function reply(message: ServiceReply) {
  if (process.connected) process.send!(message, error => {
    if (error) void shutdown().then(() => process.exit(1), () => process.exit(1))
  })
}

process.on('message', (request: ServiceRequest) => {
  if (request.method === 'close') {
    void shutdown().then(
      () => ({ id: request.id, ok: true, value: undefined } as const),
      error => ({ id: request.id, ok: false, error: serializeError(error) } as const),
    ).then(message => {
      if (!process.connected) { process.exit(message.ok ? 0 : 1); return }
      // Flush the final reply before closing IPC or terminating the child.
      process.send!(message, () => process.exit(message.ok ? 0 : 1))
    })
    return
  }
  if (closing) {
    reply({ id: request.id, ok: false, error: { name: 'Error', message: 'Document service is closing' } })
    return
  }
  const operation = execute(request).then(
    value => reply({ id: request.id, ok: true, value }),
    error => reply({ id: request.id, ok: false, error: serializeError(error) }),
  ).finally(() => { active.delete(operation) })
  active.add(operation)
})

// Parent crashes and host shutdowns must not orphan a listener or keep documents locked.
process.on('disconnect', () => {
  const timeout = setTimeout(() => process.exit(1), 10_000)
  timeout.unref()
  void shutdown().then(() => process.exit(0), error => {
    console.error(error)
    process.exit(1)
  })
})
