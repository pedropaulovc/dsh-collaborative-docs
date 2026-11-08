import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { DocumentStore, type EditRequest } from './engine.js'

const MAX_BODY = 1024 * 1024
// The engine caps full Yjs state at 10 MiB; allow its base64 representation
// on reconnect, while keeping HTTP imports and individual JSON requests small.
const MAX_FRAME = 14 * 1024 * 1024
const MAX_BUFFERED = 16 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' }

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
function same(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object')
  return value as Record<string, unknown>
}
async function body(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'Use application/json')
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY) throw new HttpError(413, 'Request exceeds 1 MiB')
    chunks.push(Buffer.from(chunk))
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON') }
}
function text(value: unknown, name: string, max = MAX_BODY): string {
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `Invalid ${name}`)
  return value
}
function statusOf(error: unknown) {
  const value = error as { status?: number; statusCode?: number; code?: string }
  if (error instanceof HttpError) return error.status
  if (value.status && value.status >= 400 && value.status < 600) return value.status
  if (value.statusCode && value.statusCode >= 400 && value.statusCode < 600) return value.statusCode
  if (/stale|conflict/i.test(value.code ?? '')) return 409
  if (/not.?found|ENOENT/i.test(value.code ?? '')) return 404
  if (/invalid|validation/i.test(value.code ?? '')) return 400
  return 500
}

export interface LocalDocumentServer {
  url: string
  store: DocumentStore
  close(): Promise<void>
}
export async function startServer(options: { dataDir: string; port?: number; store?: DocumentStore }): Promise<LocalDocumentServer> {
  const store = options.store ?? new DocumentStore(options.dataDir)
  if (!options.store) {
    try { await store.init() }
    catch (error) { await store.close(); throw error }
  }
  const token = randomBytes(32).toString('base64url')
  const cookieName = `docs_${randomBytes(8).toString('hex')}`
  const session = randomBytes(32).toString('base64url')
  const sockets = new Map<string, Set<WebSocket>>()
  const handshakes = new Map<string, Set<{ send(message: string): void; close(): void }>>()
  let origin = ''
  let host = ''
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  const webRoot = resolve(sourceDir, sourceDir.endsWith(`${sep}src`) ? '../dist/web' : 'web')
  const authenticated = (req: IncomingMessage) => (req.headers.cookie ?? '').split(';').some(part => {
    const [name, ...value] = part.trim().split('=')
    return name === cookieName && same(value.join('='), session)
  })
  const boundary = (req: IncomingMessage) => {
    if (req.headers.host !== host) throw new HttpError(403, 'Invalid Host')
    if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new HttpError(403, 'Invalid Origin')
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are forbidden')
  }
  function sendFrame(ws: WebSocket, message: string) {
    if (ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount + Buffer.byteLength(message) > MAX_BUFFERED) { ws.close(1013, 'Client too slow'); return }
    ws.send(message)
  }
  function send(ws: WebSocket, value: unknown) { sendFrame(ws, JSON.stringify(value)) }
  const unsubscribe = store.onUpdate((id, update, revision) => {
    const message = JSON.stringify({ type: 'update', update: Buffer.from(update).toString('base64'), revision })
    for (const ws of sockets.get(id) ?? []) sendFrame(ws, message)
    for (const handshake of handshakes.get(id) ?? []) handshake.send(message)
  })
  const requests = new Set<Promise<void>>()
  const server = http.createServer((req, res) => {
    const request = handle(req, res)
    requests.add(request)
    void request.then(
      () => { requests.delete(request) },
      error => { requests.delete(request); res.destroy(error instanceof Error ? error : new Error(String(error))) },
    )
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.maxHeadersCount = 64
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    res.setHeader('X-Frame-Options', 'DENY')
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)) }
    try {
      if (req.headers.host !== host) throw new HttpError(403, 'Invalid Host')
      const url = new URL(req.url ?? '/', origin)
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
        if (!same(url.searchParams.get('token') ?? '', token)) throw new HttpError(401, 'Invalid bootstrap token')
        const navigation = req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
        if (!navigation) boundary(req)
        res.setHeader('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`)
        const selected = url.searchParams.get('document')
        const location = selected && UUID.test(selected) ? `/?document=${selected}` : '/'
        if (navigation && req.headers['sec-fetch-site'] === 'cross-site') {
          // Commit a local document before navigating again: an HTTP redirect
          // retains the cross-site chain and browsers can withhold Strict cookies.
          const nonce = randomBytes(24).toString('base64')
          res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`)
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Opening documents</title></head><body><a href="${location}">Continue to documents</a><script nonce="${nonce}">location.replace(${JSON.stringify(location)})</script></body></html>`)
          return
        }
        res.writeHead(303, { Location: location }); res.end(); return
      }
      boundary(req)
      if (!authenticated(req)) throw new HttpError(401, 'Open the authenticated editor URL first')
      if (req.method === 'POST' && req.headers.origin !== origin) throw new HttpError(403, 'Origin required')
      if (url.pathname === '/api/documents') {
        if (req.method === 'GET') { json(await store.list()); return }
        if (req.method === 'POST') {
          const input = await body(req)
          json(await store.create({ title: text(input.title, 'title', 500), ...(input.markdown === undefined ? {} : { markdown: text(input.markdown, 'markdown') }) })); return
        }
      }
      const route = /^\/api\/documents\/([^/]+)(?:\/(edit|markdown|comments\/([^/]+)\/(reply|resolve)))?$/.exec(url.pathname)
      if (route) {
        const [, id, action, encodedThread, commentAction] = route
        if (!UUID.test(id)) throw new HttpError(400, 'Invalid document ID')
        if (req.method === 'GET' && !action) { json(await store.read(id)); return }
        if (req.method === 'GET' && action === 'markdown') {
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8'); res.end(await store.exportMarkdown(id)); return
        }
        if (req.method === 'POST' && action === 'edit') {
          const input = await body(req)
          text(input.expectedRevision, 'expectedRevision', 200)
          if (!Array.isArray(input.operations) || input.operations.length > 1000) throw new HttpError(400, 'Invalid operations')
          json(await store.edit(id, input as unknown as EditRequest)); return
        }
        if (req.method === 'POST' && encodedThread) {
          const thread = decodeURIComponent(encodedThread)
          if (!thread || thread.length > 200 || /[\x00-\x1f/\\]/.test(thread)) throw new HttpError(400, 'Invalid thread ID')
          const input = await body(req)
          if (commentAction === 'reply') json(await store.reply(id, thread, text(input.text, 'text', 100_000)))
          else {
            if (input.state !== 'open' && input.state !== 'resolved') throw new HttpError(400, 'Invalid comment state')
            json(await store.resolve(id, thread, input.state))
          }
          return
        }
        throw new HttpError(405, 'Method not allowed')
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sync/')) throw new HttpError(404, 'Not found')
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed')
      const pathname = decodeURIComponent(url.pathname)
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) throw new HttpError(400, 'Invalid asset path')
      const candidate = resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`)
      const root = await realpath(webRoot)
      let file: string
      try { file = await realpath(candidate) } catch { throw new HttpError(404, 'Asset not found; build the browser assets first') }
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile() || !MIME[extname(file)]) throw new HttpError(404, 'Asset not found')
      res.setHeader('Content-Type', MIME[extname(file)])
      res.end(req.method === 'HEAD' ? undefined : await readFile(file))
    } catch (error) {
      res.statusCode = error instanceof URIError ? 400 : statusOf(error)
      json({ error: res.statusCode === 500 ? 'Internal server error' : (error as Error).message })
    }
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        boundary(req)
        if (req.headers.origin !== origin || !authenticated(req)) throw new HttpError(403, 'Unauthorized WebSocket')
        const match = /^\/sync\/([0-9a-f-]+)$/.exec(new URL(req.url ?? '/', origin).pathname)
        if (!match || !UUID.test(match[1])) throw new HttpError(400, 'Invalid document ID')
        const id = match[1]
        // Subscribe before snapshot capture, without upgrading unknown documents.
        // Capture, sync delivery, and registration otherwise have an async gap
        // in which a durable publication can be lost forever.
        const pending = handshakes.get(id) ?? new Set()
        handshakes.set(id, pending)
        const messages: string[] = []
        let bytes = 0
        let abandoned = false
        const cleanup = () => {
          pending.delete(handshake)
          if (!pending.size && handshakes.get(id) === pending) handshakes.delete(id)
          messages.length = 0
          bytes = 0
          socket.off('close', abandon)
          socket.off('end', abandon)
          socket.off('error', abandon)
        }
        const abandon = () => { abandoned = true; cleanup(); socket.destroy() }
        const handshake = {
          send(message: string) {
            bytes += Buffer.byteLength(message)
            if (bytes > MAX_BUFFERED) { abandon(); return }
            messages.push(message)
          },
          close: abandon,
        }
        pending.add(handshake)
        socket.once('close', abandon)
        socket.once('end', abandon)
        socket.once('error', abandon)
        try {
          const state = await store.getSyncState(id)
          if (abandoned || socket.destroyed) return
          wss.handleUpgrade(req, socket, head, ws => {
            send(ws, { type: 'sync', update: Buffer.from(state.update).toString('base64'), revision: state.revision })
            // No await: sync is first, buffered publications retain their order,
            // and active subscription takes over before another edit can run.
            for (const message of messages) sendFrame(ws, message)
            const peers = sockets.get(id) ?? new Set<WebSocket>(); sockets.set(id, peers); peers.add(ws)
            ws.on('close', () => { peers.delete(ws); if (!peers.size) sockets.delete(id) })
            let queue = Promise.resolve()
            let lastSeq = -1
            let pending = 0
            ws.on('message', (data, binary) => {
              if (++pending > 4) { ws.close(1008, 'Too many pending updates'); return }
              queue = queue.then(async () => {
                if (binary) throw new Error('Use JSON text frames')
                const input = object(JSON.parse(data.toString()))
                if (input.type !== 'update' || !Number.isSafeInteger(input.seq) || (input.seq as number) <= lastSeq) throw new Error('Invalid update sequence')
                const encoded = text(input.update, 'update', MAX_FRAME - 1024)
                if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid base64 update')
                const update = Buffer.from(encoded, 'base64')
                await store.applyUpdate(id, update)
                lastSeq = input.seq as number
                send(ws, { type: 'ack', seq: lastSeq, revision: (await store.read(id)).revision })
              }).catch(error => { send(ws, { type: 'error', message: statusOf(error) === 500 ? 'Update rejected' : (error as Error).message }) }).finally(() => { pending-- })
            })
            ws.on('error', () => { /* close event removes the socket */ })
          })
        } finally { cleanup() }
      } catch (error) {
        socket.end(`HTTP/1.1 ${statusOf(error)} Rejected\r\nConnection: close\r\n\r\n`)
      }
    })()
  })
  try {
    const listening = Promise.withResolvers<void>()
    server.once('error', listening.reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', listening.reject); listening.resolve() })
    await listening.promise
  } catch (error) {
    unsubscribe()
    wss.close()
    if (!options.store) {
      try { await store.close() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Listener startup and store cleanup failed') }
    }
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local listener')
  host = `127.0.0.1:${address.port}`
  origin = `http://${host}`
  let closing: Promise<void> | undefined
  return {
    url: `${origin}/?token=${token}`,
    store,
    close() {
      return closing ??= (async () => {
        unsubscribe()
        const httpClosed = Promise.withResolvers<void>()
        server.close(error => error ? httpClosed.reject(error) : httpClosed.resolve())
        // Abort incomplete bodies instead of waiting past the child shutdown deadline.
        // Upgraded WebSockets are not covered by closeAllConnections.
        server.closeAllConnections()
        for (const peers of sockets.values()) for (const ws of peers) ws.terminate()
        for (const pending of handshakes.values()) for (const handshake of pending) handshake.close()
        const wsClosed = Promise.withResolvers<void>()
        wss.close(() => wsClosed.resolve())
        await Promise.all([httpClosed.promise, wsClosed.promise])
        // A disconnected HTTP response must not abandon an accepted durable edit.
        await Promise.allSettled(requests)
        if (!options.store) await store.close()
      })()
    },
  }
}
