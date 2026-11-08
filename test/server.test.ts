import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request, type IncomingHttpHeaders } from 'node:http'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { DefaultThreadStoreAuth } from '@blocknote/core/comments'
import { YjsThreadStore } from '@blocknote/core/yjs'
import { startServer } from '../src/server.js'
import { DocumentStore } from '../src/engine.js'

type Frame = { type: string; update?: string; revision?: string; seq?: number; message?: string }
// Unlike Fetch, node:http preserves browser-supplied navigation metadata.
async function navigationRequest(url: string, headers: Record<string, string>) {
  const result = Promise.withResolvers<{ status: number; headers: IncomingHttpHeaders; body: string }>()
  const req = request(url, { headers }, response => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of response) chunks.push(Buffer.from(chunk))
      result.resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })
    })().catch(result.reject)
  })
  req.on('error', result.reject)
  req.end()
  return result.promise
}
function peer(url: string, origin: string, cookie = '') {
  const ws = new WebSocket(url, { origin, headers: cookie ? { Cookie: cookie } : {} })
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
async function refused(url: string, origin: string, cookie = '', headers: Record<string, string> = {}) {
  const deferred = Promise.withResolvers<number>()
  const ws = new WebSocket(url, { origin, headers: { Cookie: cookie, ...headers } })
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
  const crossSiteBootstrap = await navigationRequest(server.url, navigation)
  assert.equal(crossSiteBootstrap.status, 200)
  assert.match(crossSiteBootstrap.headers['set-cookie']!.join(';'), /HttpOnly; SameSite=Strict/)
  const landing = crossSiteBootstrap.body
  assert.ok(!landing.includes(new URL(server.url).searchParams.get('token')!))
  assert.equal((await navigationRequest(`${origin}/?token=wrong`, navigation)).status, 401)
  assert.equal((await navigationRequest(server.url, { ...navigation, Host: 'evil.example' })).status, 403)
  const navigationCookie = crossSiteBootstrap.headers['set-cookie']![0].split(';')[0]
  assert.equal((await fetch(`${origin}/api/documents`, { headers: { Cookie: navigationCookie } })).status, 200)
  const bootstrap = await fetch(server.url, { redirect: 'manual' })
  assert.equal(bootstrap.status, 303)
  assert.equal(bootstrap.headers.get('location'), '/')
  const setCookie = bootstrap.headers.get('set-cookie')!
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  const cookie = setCookie.split(';')[0]
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  assert.equal((await navigationRequest(`${origin}/api/documents`, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await navigationRequest(`${origin}/api/documents`, { Cookie: cookie, Host: 'evil.example' })).status, 403)
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
  assert.equal(await refused(`${origin.replace('http:', 'ws:')}/sync/00000000-0000-4000-8000-000000000000`, origin, cookie), 404)
  // Neither encoded traversal nor filenames outside the public asset root are exposed.
  assert.ok([400, 404].includes((await fetch(`${origin}/%2e%2e%2fpackage.json`, { headers })).status))
  assert.equal((await fetch(`${origin}/package.json`, { headers })).status, 404)
})

test('embedded capabilities serve assets, API and sync without cookies and isolate local parents', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'docs-embed-'))
  const server = await startServer({ dataDir })
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }) })
  const origin = new URL(server.url).origin
  const desktop = server.embed('dsh-app://app').url
  const web = server.embed('http://localhost:5173').url
  assert.equal(server.embed('http://LOCALHOST:5173/').url, web)
  assert.notEqual(desktop, web)
  assert.match(new URL(desktop).pathname, /^\/embedded\/[A-Za-z0-9_-]{43}\/$/)
  for (const parent of ['null', 'file:///app', 'data:text/html,x', 'https://remote.example', 'http://127.0.0.2', 'http://localhost.evil', 'http://user@localhost', 'http://localhost/path', 'http://localhost?x', 'http://localhost#x', 'dsh-app://other', 'dsh-app://app/']) {
    assert.throws(() => server.embed(parent), /Invalid local parent origin/)
  }
  assert.ok(server.embed('https://[::1]:8443').url)
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }
  for (const [url, parent] of [[desktop, 'dsh-app://app'], [web, 'http://localhost:5173']]) {
    const page = await navigationRequest(url, navigation)
    assert.equal(page.status, 200)
    assert.match(String(page.headers['content-type']), /text\/html/)
    assert.ok(String(page.headers['content-security-policy']).includes(`frame-ancestors ${parent};`))
    assert.equal(page.headers['x-frame-options'], undefined)
    assert.equal(page.headers['set-cookie'], undefined)
    assert.equal(page.headers.location, undefined)
    assert.equal(page.headers['referrer-policy'], 'no-referrer')
    assert.equal((await navigationRequest(url, { ...navigation, Origin: 'https://evil.example' })).status, 403)
    const asset = await fetch(new URL('app.js', url))
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type')!, /javascript/)
    assert.equal(asset.headers.get('set-cookie'), null)
    const api = new URL('api/documents', url)
    assert.deepEqual(await (await fetch(api)).json(), [])
    assert.equal((await navigationRequest(api.href, navigation)).status, 403)
    assert.equal((await navigationRequest(api.href, { Host: 'evil.example' })).status, 403)
    assert.equal((await fetch(api, { headers: { Origin: parent } })).status, 403)
    for (const deniedOrigin of [undefined, parent, 'null']) {
      assert.equal((await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(deniedOrigin ? { Origin: deniedOrigin } : {}) }, body: '{"title":"Denied"}' })).status, 403)
    }
  }
  const headers = { Origin: origin, 'Content-Type': 'application/json' }
  const createdResponse = await fetch(new URL('api/documents', desktop), { method: 'POST', headers, body: JSON.stringify({ title: 'Cookie-free', markdown: 'Imported paragraph' }) })
  assert.equal(createdResponse.status, 200)
  assert.equal(createdResponse.headers.get('set-cookie'), null)
  const created = await createdResponse.json()
  const sync = new URL(`sync/${created.id}`, desktop).href.replace('http:', 'ws:')
  const client = peer(sync, origin)
  t.after(() => client.ws.terminate())
  assert.equal((await client.next()).type, 'sync')
  const editedResponse = await fetch(new URL(`api/documents/${created.id}/edit`, desktop), { method: 'POST', headers, body: JSON.stringify({
    expectedRevision: created.revision, operations: [{ type: 'replace_text', blockId: created.blocks[0].id, search: 'Imported', replacement: 'Edited' }],
  }) })
  assert.equal(editedResponse.status, 200)
  const edited = await editedResponse.json()
  assert.equal((await client.next()).revision, edited.revision)
  assert.match(await (await fetch(new URL(`api/documents/${created.id}/markdown`, desktop))).text(), /Edited paragraph/)
  assert.equal((await server.store.read(created.id)).revision, edited.revision)
  assert.equal(await refused(sync, 'dsh-app://app'), 403)
  assert.equal(await refused(sync, origin, '', { Host: 'evil.example' }), 403)
  assert.equal(await refused(sync, origin, '', { 'Sec-Fetch-Site': 'cross-site' }), 403)
  const unknown = `${origin}/embedded/${'x'.repeat(43)}/`
  assert.equal((await fetch(unknown)).status, 401)
  assert.equal((await fetch(new URL('api/documents', unknown))).status, 401)
  assert.equal(await refused(new URL(`sync/${created.id}`, unknown).href.replace('http:', 'ws:'), origin), 401)
  assert.equal((await fetch(desktop.slice(0, -1))).status, 401)
  assert.equal((await fetch(`${origin}/api/documents`)).status, 401)
  for (const path of ['%2e%2e%2fpackage.json', '%2e%2e/api/documents', 'a/%2e%2e/api/documents', '%5cpackage.json', '%00']) {
    // A raw client is required: URL/Fetch normalize encoded dot segments.
    const response = Promise.withResolvers<number>()
    const req = request(origin, { path: new URL(desktop).pathname + path }, res => { res.resume(); response.resolve(res.statusCode!) })
    req.on('error', response.reject); req.end()
    assert.equal(await response.promise, 400)
  }
  const bootstrap = await fetch(server.url, { redirect: 'manual' })
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]
  const standalone = await fetch(origin, { headers: { Cookie: cookie } })
  assert.equal(standalone.headers.get('x-frame-options'), 'DENY')
  assert.match(standalone.headers.get('content-security-policy')!, /frame-ancestors 'none'/)
  assert.equal((await fetch(unknown, { headers: { Cookie: cookie } })).status, 401)
  for (let port = 6000; port < 6013; port++) server.embed(`http://127.0.0.1:${port}`)
  assert.throws(() => server.embed('http://127.0.0.1:7000'), /Too many/)
  assert.equal(server.embed('dsh-app://app').url, desktop)
  const closed = Promise.withResolvers<void>()
  client.ws.once('close', () => closed.resolve())
  await server.close()
  await closed.promise
  assert.throws(() => server.embed('dsh-app://app'), /closing/)
  await assert.rejects(fetch(new URL('api/documents', desktop)))
  const replacement = await startServer({ dataDir })
  try {
    assert.equal((await replacement.store.read(created.id)).revision, edited.revision)
    const stale = new URL(desktop).pathname
    assert.equal((await fetch(new URL(stale, replacement.url))).status, 401)
    assert.notEqual(new URL(replacement.embed('dsh-app://app').url).pathname, stale)
  } finally { await replacement.close() }
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

for (const embedded of [false, true]) test(`initial sync includes durable edits captured during the ${embedded ? 'embedded' : 'standalone'} handshake before reporting saved`, { timeout: 20_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'docs-handshake-'))
  const server = await startServer({ dataDir })
  const release = Promise.withResolvers<void>()
  t.after(async () => { release.resolve(); await server.close(); await rm(dataDir, { recursive: true, force: true }) })
  const origin = new URL(server.url).origin
  const bootstrap = embedded ? undefined : await fetch(server.url, { redirect: 'manual' })
  const cookie = bootstrap?.headers.get('set-cookie')!.split(';')[0] ?? ''
  const base = embedded ? server.embed('dsh-app://app').url : `${origin}/`
  const created = await server.store.create({ title: 'Handshake', markdown: 'before' })
  const captured = Promise.withResolvers<void>()
  const getSyncState = server.store.getSyncState.bind(server.store)
  t.mock.method(server.store, 'getSyncState', async (id: string) => {
    const state = await getSyncState(id)
    captured.resolve()
    await release.promise
    return state
  })
  const client = peer(new URL(`sync/${created.id}`, base).href.replace('http:', 'ws:'), origin, cookie)
  const doc = new Y.Doc()
  t.after(() => { client.ws.terminate(); doc.destroy() })
  await captured.promise
  // These are real persisted edits, after snapshot capture but before delivery.
  const first = await server.store.edit(created.id, { expectedRevision: created.revision, operations: [
    { type: 'replace_text', blockId: created.blocks[0].id, search: 'before', replacement: 'during' },
  ] })
  const second = await server.store.edit(created.id, { expectedRevision: first.revision, operations: [
    { type: 'replace_text', blockId: created.blocks[0].id, search: 'during', replacement: 'after' },
  ] })
  release.resolve()
  const initial = await client.next()
  assert.equal(initial.type, 'sync', 'sync must remain the first frame')
  assert.equal(initial.revision, created.revision, 'the barrier held the original snapshot')
  Y.applyUpdate(doc, Buffer.from(initial.update!, 'base64'))
  // Like the browser, merge local state on sync and wait for the durable ack.
  // A stale initial snapshot alone must never yield a falsely "saved" client.
  client.ws.send(JSON.stringify({ type: 'update', seq: 1, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') }))
  const revisions: string[] = []
  for (;;) {
    const frame = await client.next()
    if (frame.type === 'ack') {
      assert.equal(frame.seq, 1)
      assert.equal(frame.revision, second.revision)
      break
    }
    assert.equal(frame.type, 'update')
    revisions.push(frame.revision!)
    Y.applyUpdate(doc, Buffer.from(frame.update!, 'base64'))
  }
  assert.match(doc.getXmlFragment('blocknote').toString(), /after/, 'client converges before saved without reconnecting')
  assert.deepEqual(revisions.slice(0, 2), [first.revision, second.revision], 'buffered durable updates preserve publication order')
  const durable = new Y.Doc()
  t.after(() => durable.destroy())
  Y.applyUpdate(durable, (await getSyncState(created.id)).update)
  assert.equal(doc.getXmlFragment('blocknote').toString(), durable.getXmlFragment('blocknote').toString())
  assert.equal(client.ws.readyState, WebSocket.OPEN)
})

for (const embedded of [false, true]) for (const outcome of ['disconnect', 'shutdown', 'overflow'] as const) {
  test(`${embedded ? 'embedded' : 'standalone'} pending initial sync cleans up on ${outcome}`, { timeout: 20_000 }, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'docs-pending-sync-'))
    const store = new DocumentStore(dataDir)
    await store.init()
    let publish!: Parameters<DocumentStore['onUpdate']>[0]
    const subscribe = store.onUpdate.bind(store)
    t.mock.method(store, 'onUpdate', (listener: typeof publish) => { publish = listener; return subscribe(listener) })
    const server = await startServer({ dataDir, store })
    const release = Promise.withResolvers<void>()
    t.after(async () => { release.resolve(); await server.close(); await store.close(); await rm(dataDir, { recursive: true, force: true }) })
    const origin = new URL(server.url).origin
    const bootstrap = embedded ? undefined : await fetch(server.url, { redirect: 'manual' })
    const cookie = bootstrap?.headers.get('set-cookie')!.split(';')[0] ?? ''
    const base = embedded ? server.embed('dsh-app://app').url : `${origin}/`
    const created = await store.create({ title: 'Pending', markdown: 'before' })
    const captured = Promise.withResolvers<void>()
    const getSyncState = store.getSyncState.bind(store)
    const capture = t.mock.method(store, 'getSyncState', async (id: string) => {
      const state = await getSyncState(id)
      captured.resolve()
      await release.promise
      return state
    })
    const client = peer(new URL(`sync/${created.id}`, base).href.replace('http:', 'ws:'), origin, cookie)
    t.after(() => client.ws.terminate())
    let opened = false
    client.ws.on('open', () => { opened = true })
    const closed = Promise.withResolvers<void>()
    client.ws.once('close', () => closed.resolve())
    await captured.promise
    if (outcome === 'disconnect') client.ws.terminate()
    else if (outcome === 'shutdown') await server.close()
    else {
      // Exercise the transport's byte limit independently of the engine's own
      // state-size limit. The convergence regression above uses durable edits.
      const update = new Uint8Array(1024 * 1024)
      for (let i = 0; i < 13; i++) publish(created.id, update, created.revision)
    }
    // Closure must not depend on the held snapshot completing.
    await closed.promise
    assert.equal(opened, false)
    release.resolve()
    capture.mock.restore()
    if (outcome !== 'shutdown') {
      // A new connection to the same document still receives a clean sync.
      const retry = peer(new URL(`sync/${created.id}`, base).href.replace('http:', 'ws:'), origin, cookie)
      t.after(() => retry.ws.terminate())
      assert.equal((await retry.next()).type, 'sync')
    }
  })
}

for (const embedded of [false, true]) test(`${embedded ? 'embedded' : 'standalone'} native comments merge over WebSocket and HTTP reply/resolve persist across restart`, { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'docs-comments-'))
  let server = await startServer({ dataDir })
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }) })
  const origin = new URL(server.url).origin
  const bootstrap = embedded ? undefined : await fetch(server.url, { redirect: 'manual' })
  const cookie = bootstrap?.headers.get('set-cookie')!.split(';')[0] ?? ''
  const base = embedded ? server.embed('dsh-app://app').url : `${origin}/`
  const created = await server.store.create({ title: 'Comments', markdown: 'Discuss this' })
  const client = peer(new URL(`sync/${created.id}`, base).href.replace('http:', 'ws:'), origin, cookie)
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
  const headers = { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, 'Content-Type': 'application/json' }
  const replied = await fetch(new URL(`api/documents/${created.id}/comments/${thread.id}/reply`, base), { method: 'POST', headers, body: JSON.stringify({ text: 'Agent answer' }) })
  assert.equal(replied.status, 200)
  const replyUpdate = await client.next()
  assert.equal(replyUpdate.type, 'update')
  Y.applyUpdate(doc, Buffer.from(replyUpdate.update!, 'base64'))
  assert.equal(native.getThreads().get(thread.id)?.comments.length, 2)
  assert.equal((await fetch(new URL(`api/documents/${created.id}/comments/${thread.id}/resolve`, base), { method: 'POST', headers, body: JSON.stringify({ state: 'resolved' }) })).status, 200)
  const resolvedUpdate = await client.next()
  Y.applyUpdate(doc, Buffer.from(resolvedUpdate.update!, 'base64'))
  assert.equal(native.getThreads().get(thread.id)?.resolved, true)
  assert.equal((await fetch(new URL(`api/documents/${created.id}/comments/${thread.id}/resolve`, base), { method: 'POST', headers, body: JSON.stringify({ state: 'invalid' }) })).status, 400)
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
