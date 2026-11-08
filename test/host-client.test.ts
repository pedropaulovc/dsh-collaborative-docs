import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'
import { build } from 'esbuild'
import type { DocumentService, ServiceReply } from '../src/host-client.js'

let root: string
let Service: typeof DocumentService
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-document-worker-test-'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction')
  // Exercise the emitted worker, not tsx's inherited loader or an in-process mock.
  await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['src/host-client.ts', 'src/worker.ts'],
    outdir: root, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22',
  })
  // The compiled module exists only at this test's runtime-selected temporary path.
  Service = (await import(pathToFileURL(join(root, 'host-client.js')).href)).DocumentService
})
after(async () => { if (root) await rm(root, { recursive: true, force: true }) })

async function partialAuthenticatedPost(url: string) {
  const bootstrap = await fetch(url, { redirect: 'manual' })
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const destination = new URL('/api/documents', url)
  const request = httpRequest(destination, {
    method: 'POST',
    headers: {
      Cookie: cookie, Origin: destination.origin, 'Content-Type': 'application/json',
      'Content-Length': '1024', Expect: '100-continue',
    },
  })
  // Shutdown intentionally resets this incomplete request.
  request.on('error', () => {})
  const accepted = once(request, 'continue')
  request.flushHeaders()
  await accepted
  request.write('{"title":')
  return request
}

test('graceful shutdown aborts an incomplete authenticated POST and drains accepted edits', { timeout: 30_000 }, async () => {
  const dataDir = join(root, 'partial-close')
  const service = new Service({ dataDir })
  let request
  try {
    await service.init()
    request = await partialAuthenticatedPost((await service.open()).url)
    const edit = service.create({ title: 'Accepted before close', markdown: 'Durable content' })
    const started = performance.now()
    const [created] = await Promise.all([edit, service.close()])
    assert.ok(performance.now() - started < 5_000, 'shutdown must not reach the 10-second forced-exit deadline')
    await assert.rejects(access(join(dataDir, '.writer-lock')), { code: 'ENOENT' })
    const reopened = new Service({ dataDir })
    try {
      await reopened.init()
      assert.equal((await reopened.read(created.id)).revision, created.revision)
    } finally { await reopened.close() }
  } finally { request?.destroy(); await service.close() }
})

test('child RPC preserves edits, error metadata, persistence, and host globals', { timeout: 30_000 }, async () => {
  const dataDir = join(root, 'rpc')
  const globals = { document: globalThis.document, window: globalThis.window }
  const service = new Service({ dataDir })
  try {
    assert.equal(service.init(), service.init())
    await service.init()
    const created = await service.create({ title: 'Child process', markdown: 'Original paragraph' })
    const edited = await service.edit(created.id, {
      expectedRevision: created.revision,
      operations: [{ type: 'replace_text', blockId: created.blocks[0].id, search: 'Original', replacement: 'Changed' }],
    })
    assert.match(await service.exportMarkdown(created.id), /Changed paragraph/)
    await assert.rejects(service.edit(created.id, {
      expectedRevision: created.revision,
      operations: [{ type: 'delete_block', blockId: created.blocks[0].id }],
    }), (error: unknown) => {
      const details = error as Error & { status?: number; code?: string }
      return details instanceof Error && details.status === 409 && details.code === 'STALE_REVISION'
    })
    const [first, second] = await Promise.all([service.open(created.id), service.open(created.id)])
    assert.equal(first.url, second.url)
    assert.equal(new URL(first.url).searchParams.get('document'), created.id)
    const response = await fetch(first.url, { redirect: 'manual' })
    assert.equal(response.status, 303)
    assert.ok(response.headers.get('set-cookie'))
    assert.equal(globalThis.document, globals.document)
    assert.equal(globalThis.window, globals.window)
    await service.close()
    await service.close()
    await assert.rejects(service.list())
    const reopened = new Service({ dataDir })
    try {
      await reopened.init()
      assert.equal((await reopened.read(created.id)).revision, edited.revision)
    } finally { await reopened.close() }
  } finally { await service.close() }
})

test('failed child initialization releases the process without stealing another store lock', { timeout: 30_000 }, async () => {
  const dataDir = join(root, 'locked')
  const owner = new Service({ dataDir })
  const rejected = new Service({ dataDir })
  try {
    await owner.init()
    await assert.rejects(rejected.init(), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'STORE_LOCKED')
    await rejected.close()
    assert.deepEqual(await owner.list(), [])
  } finally { await rejected.close(); await owner.close() }
})

test('parent disconnect aborts an incomplete authenticated POST and releases the store lock', { timeout: 30_000 }, async () => {
  const dataDir = join(root, 'orphan')
  const child = fork(join(root, 'worker.js'), [], {
    execPath: process.execPath, execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  })
  const exited = once(child, 'exit')
  let request
  try {
    let reply = once(child, 'message')
    child.send({ id: 1, method: 'init', args: [{ dataDir }] })
    const initialized = (await reply)[0] as ServiceReply
    assert.equal(initialized.ok, true)
    reply = once(child, 'message')
    child.send({ id: 2, method: 'open', args: [] })
    const opened = (await reply)[0] as ServiceReply
    assert.ok(opened.ok)
    assert.ok(opened.value && typeof opened.value === 'object' && 'url' in opened.value)
    const { url } = opened.value
    assert.equal(typeof url, 'string')
    request = await partialAuthenticatedPost(String(url))
    const started = performance.now()
    child.disconnect()
    assert.equal((await exited)[0], 0)
    assert.ok(performance.now() - started < 5_000, 'disconnect must not reach the 10-second forced-exit deadline')
    await assert.rejects(access(join(dataDir, '.writer-lock')), { code: 'ENOENT' })
    await assert.rejects(fetch(String(url)))
    const reopened = new Service({ dataDir })
    try { await reopened.init(); assert.deepEqual(await reopened.list(), []) }
    finally { await reopened.close() }
  } finally {
    request?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  }
})
