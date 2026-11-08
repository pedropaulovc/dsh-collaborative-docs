import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { DefaultThreadStoreAuth } from '@blocknote/core/comments'
import { YjsThreadStore } from '@blocknote/core/yjs'
import { startServer } from '../src/server.js'

type Frame = { type: string; update?: string; revision?: string; seq?: number; message?: string }
function peer(url: string, origin: string, cookie: string) {
  const ws = new WebSocket(url, { origin, headers: { Cookie: cookie } })
  const frames: Frame[] = []
  const waiting: { resolve(value: Frame): void; reject(error: Error): void }[] = []
  ws.on('message', raw => {
    const frame = JSON.parse(raw.toString()) as Frame
    const waiter = waiting.shift()
    if (waiter) waiter.resolve(frame); else frames.push(frame)
  })
  ws.on('error', error => { for (const waiter of waiting.splice(0)) waiter.reject(error) })
  return { ws, async next() {
    if (frames.length) return frames.shift()!
    const deferred = Promise.withResolvers<Frame>()
    waiting.push(deferred)
    return deferred.promise
  } }
}
async function refused(url: string, origin: string, cookie = '') {
  const deferred = Promise.withResolvers<number>()
  const ws = new WebSocket(url, { origin, headers: { Cookie: cookie } })
  ws.on('unexpected-response', (_request, response) => { response.resume(); deferred.resolve(response.statusCode ?? 0); ws.terminate() })
  ws.on('open', () => { ws.terminate(); deferred.reject(new Error('Unauthorized WebSocket was accepted')) })
  ws.on('error', () => {})
  return deferred.promise
}

test('capability bootstrap, strict HTTP/WS boundaries and bounded inputs', { timeout: 20_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'docs-security-'))
  const server = await startServer({ dataDir })
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }) })
  const origin = new URL(server.url).origin
  assert.equal((await fetch(`${origin}/api/documents`)).status, 401)
  assert.equal((await fetch(`${origin}/?token=wrong`, { redirect: 'manual' })).status, 401)
  assert.equal((await fetch(server.url, { headers: { Origin: 'https://attacker.example' }, redirect: 'manual' })).status, 403)
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
  const crossSiteBootstrap = await fetch(server.url, { headers: navigation, redirect: 'manual' })
  assert.equal(crossSiteBootstrap.status, 200)
  assert.match(crossSiteBootstrap.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/)
  const landing = await crossSiteBootstrap.text()
  assert.ok(landing.includes('location.replace("/")'))
  assert.match(crossSiteBootstrap.headers.get('content-security-policy')!, /script-src 'nonce-/)
  assert.ok(!landing.includes(new URL(server.url).searchParams.get('token')!))
  assert.equal((await fetch(`${origin}/?token=wrong`, { headers: navigation, redirect: 'manual' })).status, 401)
  assert.equal((await fetch(server.url, { headers: { ...navigation, Host: 'evil.example' }, redirect: 'manual' })).status, 403)
  const bootstrap = await fetch(server.url, { redirect: 'manual' })
  assert.equal(bootstrap.status, 303)
  assert.equal(bootstrap.headers.get('location'), '/')
  const setCookie = bootstrap.headers.get('set-cookie')!
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  const cookie = setCookie.split(';')[0]
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  assert.equal((await fetch(`${origin}/api/documents`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await fetch(`${origin}/api/documents`, { headers: { Cookie: cookie, Host: 'evil.example' } })).status, 403)
  assert.equal((await fetch(`${origin}/api/documents`, { method: 'POST', headers: { ...headers, Origin: 'null' }, body: '{"title":"evil"}' })).status, 403)
  assert.equal((await fetch(`${origin}/api/documents`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"title":"evil"}' })).status, 403)
  assert.equal((await fetch(`${origin}/api/unknown`, { headers })).status, 404)
  assert.equal((await fetch(`${origin}/api/documents/not-a-uuid`, { headers })).status, 400)
  assert.equal((await fetch(`${origin}/api/documents`, { method: 'POST', headers, body: '{broken' })).status, 400)
  assert.equal((await fetch(`${origin}/api/documents`, { method: 'POST', headers, body: JSON.stringify({ title: 'large', markdown: 'x'.repeat(1024 * 1024) }) })).status, 413)
  assert.deepEqual(await (await fetch(`${origin}/api/documents`, { headers })).json(), [])
  const created = await (await fetch(`${origin}/api/documents`, { method: 'POST', headers, body: JSON.stringify({ title: 'Boundary', markdown: 'hello' }) })).json()
  const sync = `${origin.replace('http:', 'ws:')}/sync/${created.id}`
  assert.equal(await refused(sync, origin), 403)
  assert.equal(await refused(sync, 'https://attacker.example', cookie), 403)
  assert.equal(await refused(sync, 'null', cookie), 403)
  // Neither encoded traversal nor filenames outside the public asset root are exposed.
  assert.ok([400, 404].includes((await fetch(`${origin}/%2e%2e%2fpackage.json`, { headers })).status))
  assert.equal((await fetch(`${origin}/package.json`, { headers })).status, 404)
})

test('durable agent broadcasts, two peer Yjs sync, stale edit rejection and restart', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'docs-sync-'))
  let server = await startServer({ dataDir })
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }) })
  const origin = new URL(server.url).origin
  const bootstrap = await fetch(server.url, { redirect: 'manual' })
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]
  const snapshot = await server.store.create({ title: 'Shared', markdown: 'hello world' })
  const url = `${origin.replace('http:', 'ws:')}/sync/${snapshot.id}`
  const first = peer(url, origin, cookie), second = peer(url, origin, cookie)
  t.after(() => { first.ws.terminate(); second.ws.terminate() })
  const initial = await first.next()
  assert.equal(initial.type, 'sync')
  assert.equal((await second.next()).type, 'sync')
  const a = new Y.Doc(), b = new Y.Doc()
  t.after(() => { a.destroy(); b.destroy() })
  Y.applyUpdate(a, Buffer.from(initial.update!, 'base64'))
  const edited = await server.store.edit(snapshot.id, { expectedRevision: snapshot.revision, operations: [{ type: 'replace_text', blockId: snapshot.blocks[0].id, search: 'hello', replacement: 'goodbye' }] })
  const [eventA, eventB] = await Promise.all([first.next(), second.next()])
  assert.equal(eventA.type, 'update')
  assert.equal(eventA.revision, edited.revision)
  assert.equal(eventB.update, eventA.update)
  Y.applyUpdate(a, Buffer.from(eventA.update!, 'base64'))
  assert.match(await server.store.exportMarkdown(snapshot.id), /goodbye world/)
  const stale = await fetch(`${origin}/api/documents/${snapshot.id}/edit`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: snapshot.revision, operations: [{ type: 'delete_block', blockId: snapshot.blocks[0].id }] }) })
  assert.equal(stale.status, 409)
  assert.equal((await server.store.read(snapshot.id)).revision, edited.revision)
  // A full client state merge is idempotent and only acknowledged after saving.
  first.ws.send(JSON.stringify({ type: 'update', seq: 1, update: Buffer.from(Y.encodeStateAsUpdate(a)).toString('base64') }))
  let ack = await first.next()
  if (ack.type === 'update') ack = await first.next()
  assert.equal(ack.type, 'ack')
  assert.equal(ack.seq, 1)
  first.ws.send(JSON.stringify({ type: 'update', seq: 1, update: 'AAAA' }))
  assert.equal((await first.next()).type, 'error')
  first.ws.send(JSON.stringify({ type: 'update', seq: 2, update: '!!!!' }))
  assert.equal((await first.next()).type, 'error')
  // Merge a real client-side text operation through the wire, then check its peer.
  function findText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText && child.toString().includes('goodbye')) return child
      if (child instanceof Y.XmlElement) { const found = findText(child); if (found) return found }
    }
  }
  const content = findText(a.getXmlFragment('blocknote'))
  assert.ok(content, 'real BlockNote Yjs text exists')
  const vector = Y.encodeStateVector(a)
  content.insert(0, 'client ')
  first.ws.send(JSON.stringify({ type: 'update', seq: 2, update: Buffer.from(Y.encodeStateAsUpdate(a, vector)).toString('base64') }))
  let broadcast = await second.next()
  if (broadcast.revision === edited.revision) broadcast = await second.next()
  assert.equal(broadcast.type, 'update')
  Y.applyUpdate(b, Buffer.from(initial.update!, 'base64'))
  Y.applyUpdate(b, Buffer.from(eventB.update!, 'base64'))
  Y.applyUpdate(b, Buffer.from(broadcast.update!, 'base64'))
  assert.match(b.getXmlFragment('blocknote').toString(), /client goodbye/)
  assert.match(await server.store.exportMarkdown(snapshot.id), /client goodbye world/)
  await server.close()
  server = await startServer({ dataDir })
  assert.match(await server.store.exportMarkdown(snapshot.id), /client goodbye world/)
  assert.equal((await fetch(`${new URL(server.url).origin}/api/documents`, { headers: { Cookie: cookie } })).status, 401)
})

test('native comments merge over WebSocket and HTTP reply/resolve persist across restart', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'docs-comments-'))
  let server = await startServer({ dataDir })
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }) })
  const origin = new URL(server.url).origin
  const bootstrap = await fetch(server.url, { redirect: 'manual' })
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]
  const created = await server.store.create({ title: 'Comments', markdown: 'Discuss this' })
  const client = peer(`${origin.replace('http:', 'ws:')}/sync/${created.id}`, origin, cookie)
  const doc = new Y.Doc()
  t.after(() => { client.ws.terminate(); doc.destroy() })
  const initial = await client.next()
  Y.applyUpdate(doc, Buffer.from(initial.update!, 'base64'))
  const vector = Y.encodeStateVector(doc)
  const native = new YjsThreadStore('human', doc.getMap('threads'), new DefaultThreadStoreAuth('human', 'editor'))
  const thread = await native.createThread({ initialComment: { body: [{ type: 'paragraph', content: 'Question' }] } })
  client.ws.send(JSON.stringify({ type: 'update', seq: 1, update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64') }))
  assert.equal((await client.next()).type, 'update')
  assert.equal((await client.next()).type, 'ack')
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  const replied = await fetch(`${origin}/api/documents/${created.id}/comments/${thread.id}/reply`, { method: 'POST', headers, body: JSON.stringify({ text: 'Agent answer' }) })
  assert.equal(replied.status, 200)
  const replyUpdate = await client.next()
  assert.equal(replyUpdate.type, 'update')
  Y.applyUpdate(doc, Buffer.from(replyUpdate.update!, 'base64'))
  assert.equal(native.getThreads().get(thread.id)?.comments.length, 2)
  assert.equal((await fetch(`${origin}/api/documents/${created.id}/comments/${thread.id}/resolve`, { method: 'POST', headers, body: JSON.stringify({ state: 'resolved' }) })).status, 200)
  const resolvedUpdate = await client.next()
  Y.applyUpdate(doc, Buffer.from(resolvedUpdate.update!, 'base64'))
  assert.equal(native.getThreads().get(thread.id)?.resolved, true)
  assert.equal((await fetch(`${origin}/api/documents/${created.id}/comments/${thread.id}/resolve`, { method: 'POST', headers, body: JSON.stringify({ state: 'invalid' }) })).status, 400)
  await server.close()
  server = await startServer({ dataDir })
  const restored = await server.store.read(created.id)
  assert.equal(restored.threads[0].comments.length, 2)
  assert.equal(restored.threads[0].resolved, true)
})

test('listener startup failure preserves a borrowed store for retry and caller disposal', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'docs-startup-'))
  const owner = await startServer({ dataDir })
  t.after(async () => { await owner.close(); await rm(dataDir, { recursive: true, force: true }) })
  const created = await owner.store.create({ title: 'Still available', markdown: 'Retained' })
  await assert.rejects(startServer({ dataDir, store: owner.store, port: Number(new URL(owner.url).port) }), { code: 'EADDRINUSE' })
  assert.equal((await owner.store.read(created.id)).title, 'Still available')
  const retried = await startServer({ dataDir, store: owner.store })
  await retried.close()
  assert.equal((await owner.store.read(created.id)).title, 'Still available', 'borrowed store remains caller-owned after listener shutdown')
})
