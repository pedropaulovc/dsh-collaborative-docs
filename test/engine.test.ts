import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as Y from 'yjs';
import { YjsThreadStore } from '@blocknote/core/yjs';
import { DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { DocumentError, DocumentStore, type Block } from '../src/engine.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'collaborative-engine-'));
  const stores: DocumentStore[] = [];
  const makeStore = () => {
    const next = new DocumentStore(dir);
    stores.push(next);
    return next;
  };
  const store = makeStore();
  await store.init();
  t.after(async () => {
    for (const owned of stores) await owned.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store, makeStore };
}
function clientClone(doc: Y.Doc): Y.Doc {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  return client;
}
function containers(doc: Y.Doc): Y.XmlElement[] {
  const group = doc.getXmlFragment('blocknote').toArray()[0];
  assert.ok(group instanceof Y.XmlElement);
  return group.toArray() as Y.XmlElement[];
}
function contentText(block: Y.XmlElement): Y.XmlText {
  const content = block.toArray()[0];
  assert.ok(content instanceof Y.XmlElement);
  const text = content.toArray()[0];
  assert.ok(text instanceof Y.XmlText);
  return text;
}
function plain(block: Block): string {
  if (!Array.isArray(block.content)) return '';
  return block.content.map(item => 'text' in item ? item.text : '').join('');
}

test('imports and exports native Markdown, persists authoritative binary through restart', async t => {
  const { dir, store, makeStore } = await fixture(t);
  const created = await store.create({ title: 'Guide', markdown: '# Heading\n\nA **bold** paragraph' });
  assert.equal(created.blocks[0].type, 'heading');
  assert.equal(plain(created.blocks[1]), 'A bold paragraph');
  assert.match(await store.exportMarkdown(created.id), /\*\*bold\*\*/);
  const encoded = Y.encodeStateAsUpdate(await store.getDoc(created.id));
  await store.close();
  const recovered = makeStore();
  await recovered.init();
  assert.deepEqual(await recovered.read(created.id), created);
  assert.deepEqual(Y.encodeStateAsUpdate(await recovered.getDoc(created.id)), encoded);
  assert.equal((await recovered.list())[0].title, 'Guide');
});

test('server targeted text edits preserve unaffected Yjs identities, relative anchors and native threads', async t => {
  const { store } = await fixture(t);
  const created = await store.create({ title: 'Anchors', markdown: 'First **styled** sentence\n\nKeep this anchored text' });
  const doc = await store.getDoc(created.id);
  const client = clientClone(doc);
  t.after(() => client.destroy());
  const native = new YjsThreadStore('human', client.getMap('threads'), new DefaultThreadStoreAuth('human', 'editor'));
  const thread = await native.createThread({ initialComment: { body: [{ type: 'paragraph', content: 'Please preserve this' }] } });
  const anchoredText = contentText(containers(client)[1]);
  const relative = Y.createRelativePositionFromTypeIndex(anchoredText, 5);
  anchoredText.format(5, 4, { comment: { threadId: thread.id } });
  const editedText = contentText(containers(client)[0]);
  const sameBlockRelative = Y.createRelativePositionFromTypeIndex(editedText, 13);
  editedText.format(13, 8, { comment: { threadId: thread.id } });
  await store.applyUpdate(created.id, Y.encodeStateAsUpdate(client, Y.encodeStateVector(doc)));
  const before = await store.read(created.id);
  const originalBlocks = containers(doc);
  const originalText = contentText(originalBlocks[1]);
  const originalEditedText = contentText(originalBlocks[0]);
  const edited = await store.edit(created.id, { expectedRevision: before.revision, operations: [{ type: 'replace_text', blockId: before.blocks[0].id, search: 'First styled', replacement: 'Updated' }] });
  assert.equal(plain(edited.blocks[0]), 'Updated sentence');
  assert.equal(containers(doc)[1], originalBlocks[1]);
  assert.equal(contentText(containers(doc)[1]), originalText);
  const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);
  assert.equal(absolute?.type, originalText);
  assert.equal(absolute?.index, 5);
  assert.deepEqual(edited.threads, before.threads);
  assert.deepEqual(originalText.toDelta().find((delta: { attributes?: Record<string, unknown> }) => delta.attributes?.comment)?.attributes?.comment, { threadId: thread.id });
  assert.equal(contentText(containers(doc)[0]), originalEditedText);
  const sameBlockAbsolute = Y.createAbsolutePositionFromRelativePosition(sameBlockRelative, doc);
  assert.equal(sameBlockAbsolute?.type, originalEditedText);
  assert.equal(sameBlockAbsolute?.index, 8);
  const survivingMark = originalEditedText.toDelta().find((delta: { attributes?: Record<string, unknown> }) => delta.attributes?.comment);
  assert.equal(survivingMark?.insert, 'sentence');
  assert.deepEqual(survivingMark?.attributes?.comment, { threadId: thread.id });
});

test('multi-operation validation is atomic and stale CAS makes no changes', async t => {
  const { store } = await fixture(t);
  const created = await store.create({ title: 'Atomic', markdown: 'Original\n\nSecond' });
  const doc = await store.getDoc(created.id);
  const before = Y.encodeStateAsUpdate(doc);
  const events: unknown[] = [];
  store.onUpdate((...args) => events.push(args));
  await assert.rejects(store.edit(created.id, { expectedRevision: created.revision, operations: [
    { type: 'replace_text', blockId: created.blocks[0].id, search: 'Original', replacement: 'Partial' },
    { type: 'delete_block', blockId: 'missing' },
  ] }), /Block not found/);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert.deepEqual(await store.read(created.id), created);
  assert.equal(events.length, 0);
  const changed = await store.edit(created.id, { expectedRevision: created.revision, operations: [{ type: 'replace_text', blockId: created.blocks[0].id, search: 'Original', replacement: 'Changed' }] });
  await assert.rejects(store.edit(created.id, { expectedRevision: created.revision, operations: [{ type: 'delete_block', blockId: created.blocks[1].id }] }), (error: unknown) => error instanceof DocumentError && error.status === 409 && error.code === 'STALE_REVISION');
  assert.deepEqual(await store.read(created.id), changed);
});

test('insertion and deletion mutate only targeted native block siblings', async t => {
  const { store } = await fixture(t);
  const created = await store.create({ title: 'Siblings', markdown: 'One\n\nTwo\n\nThree' });
  const doc = await store.getDoc(created.id);
  const originals = containers(doc);
  const edited = await store.edit(created.id, { expectedRevision: created.revision, operations: [
    { type: 'insert_after', blockId: created.blocks[0].id, markdown: '## Inserted\n\nNew paragraph' },
    { type: 'delete_block', blockId: created.blocks[1].id },
  ] });
  assert.deepEqual(edited.blocks.map(plain), ['One', 'Inserted', 'New paragraph', 'Three']);
  assert.equal(edited.blocks[1].type, 'heading');
  assert.equal(containers(doc)[0], originals[0]);
  assert.equal(containers(doc)[3], originals[2]);
});

test('browser updates serialize before agent CAS; concurrent clients converge', async t => {
  const { store } = await fixture(t);
  const created = await store.create({ title: 'Concurrent', markdown: 'Hello world' });
  const doc = await store.getDoc(created.id);
  const a = clientClone(doc), b = clientClone(doc);
  t.after(() => { a.destroy(); b.destroy(); });
  const vector = Y.encodeStateVector(doc);
  contentText(containers(a)[0]).insert(0, 'A ');
  contentText(containers(b)[0]).insert(11, ' B');
  const pending = store.applyUpdate(created.id, Y.encodeStateAsUpdate(a, vector));
  const stale = store.edit(created.id, { expectedRevision: created.revision, operations: [{ type: 'delete_block', blockId: created.blocks[0].id }] });
  await pending;
  await assert.rejects(stale, (error: unknown) => error instanceof DocumentError && error.status === 409);
  await store.applyUpdate(created.id, Y.encodeStateAsUpdate(b, vector));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(doc));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(doc));
  assert.equal(plain((await store.read(created.id)).blocks[0]), 'A Hello world B');
  assert.deepEqual(Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b));
});

test('native thread reply and resolve/reopen survive recovery; events observe durable bytes', async t => {
  const { dir, store, makeStore } = await fixture(t);
  const created = await store.create({ title: 'Comments', markdown: 'Review me' });
  const doc = await store.getDoc(created.id);
  const client = clientClone(doc);
  t.after(() => client.destroy());
  const native = new YjsThreadStore('human', client.getMap('threads'), new DefaultThreadStoreAuth('human', 'editor'));
  const thread = await native.createThread({ initialComment: { body: [{ type: 'paragraph', content: 'Question' }] } });
  const durableChecks: Promise<void>[] = [];
  store.onUpdate((id, update, rev) => {
    Y.applyUpdate(client, update);
    durableChecks.push((async () => {
      const raw = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'));
      const disk = new Y.Doc();
      try {
        Y.applyUpdate(disk, Buffer.from(raw.state, 'base64'));
        assert.equal(typeof rev, 'string');
        const persisted = Y.encodeStateAsUpdate(disk);
        Y.applyUpdate(disk, update);
        assert.deepEqual(Y.encodeStateAsUpdate(disk), persisted, 'notified update was already durably saved');
      } finally { disk.destroy(); }
    })());
  });
  await store.applyUpdate(created.id, Y.encodeStateAsUpdate(client, Y.encodeStateVector(doc)));
  const replied = await store.reply(created.id, thread.id, 'Agent answer');
  assert.equal(replied.threads[0].comments[1].userId, 'agent');
  assert.equal(replied.threads[0].comments[1].body[0].content[0].text, 'Agent answer');
  assert.notEqual(replied.revision, created.revision);
  const resolved = await store.resolve(created.id, thread.id, 'resolved');
  assert.equal(resolved.threads[0].resolved, true);
  assert.notEqual(resolved.revision, replied.revision);
  const reopened = await store.resolve(created.id, thread.id, 'open');
  assert.equal(reopened.threads[0].resolved, false);
  assert.equal(native.getThread(thread.id).comments.length, 2);
  await Promise.all(durableChecks);
  assert.equal(durableChecks.length, 4);
  await store.close();
  const recovered = makeStore();
  await recovered.init();
  assert.deepEqual(await recovered.read(created.id), reopened);
});

test('a second store cannot write the same directory', async t => {
  const { store, makeStore } = await fixture(t);
  const second = makeStore();
  await assert.rejects(second.init(), (error: unknown) => error instanceof DocumentError && error.code === 'STORE_LOCKED');
  const created = await store.create({ title: 'Single writer', markdown: 'Safe' });
  assert.equal((await store.read(created.id)).title, 'Single writer');
});

test('invalid browser updates cannot poison authoritative state or emit persisted notifications', async t => {
  const { store } = await fixture(t);
  const created = await store.create({ title: 'Boundaries', markdown: 'Safe' });
  const doc = await store.getDoc(created.id);
  const before = Y.encodeStateAsUpdate(doc);
  let notifications = 0;
  store.onUpdate(() => notifications++);
  await assert.rejects(store.applyUpdate(created.id, new Uint8Array([255, 255])), /Invalid document update/);
  await assert.rejects(store.applyUpdate(created.id, new Uint8Array(10 * 1024 * 1024 + 1)), /oversized/);
  const hostile = clientClone(doc);
  hostile.getMap('server-title').set('title', 'Injected');
  await assert.rejects(store.applyUpdate(created.id, Y.encodeStateAsUpdate(hostile)), /Unknown shared document root/);
  hostile.destroy();
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert.equal(notifications, 0);
  await assert.rejects(store.read('../escape'), (error: unknown) => error instanceof DocumentError && error.status === 400);
  await assert.rejects(store.reply(created.id, 'missing', 'reply'), (error: unknown) => error instanceof DocumentError && error.status === 404);
  assert.deepEqual(await store.read(created.id), created);
});

test('corrupted persisted state fails closed rather than resetting documents', async t => {
  const { dir, store, makeStore } = await fixture(t);
  const created = await store.create({ title: 'Must not disappear', markdown: 'Persisted' });
  await store.close();
  const file = join(dir, `${created.id}.json`);
  await writeFile(file, '{broken');
  const recovered = makeStore();
  await assert.rejects(recovered.init(), (error: unknown) => error instanceof DocumentError && error.code === 'CORRUPT_STORAGE');
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('initial sync bytes and revision are captured atomically after preceding durable edits', async t => {
  const { dir, store } = await fixture(t);
  const created = await store.create({ title: 'Sync', markdown: 'Original' });
  const edit = store.edit(created.id, { expectedRevision: created.revision, operations: [
    { type: 'replace_text', blockId: created.blocks[0].id, search: 'Original', replacement: 'Durable' },
  ] });
  const sync = store.getSyncState(created.id);
  const edited = await edit;
  const captured = await sync;
  assert.equal(captured.revision, edited.revision);
  assert.equal(createHash('sha256').update(captured.update).digest('hex'), captured.revision);
  const disk = JSON.parse(await readFile(join(dir, `${created.id}.json`), 'utf8'));
  assert.deepEqual(Buffer.from(captured.update), Buffer.from(disk.state, 'base64'));
  const savedBytes = captured.update.slice();
  await store.edit(created.id, { expectedRevision: edited.revision, operations: [
    { type: 'replace_text', blockId: created.blocks[0].id, search: 'Durable', replacement: 'Later' },
  ] });
  assert.deepEqual(captured.update, savedBytes);
});

test('oversized thread replies reject before mutation, notification or persistence', async t => {
  const { dir, store, makeStore } = await fixture(t);
  const created = await store.create({ title: 'Comment size boundary', markdown: 'Review' });
  const doc = await store.getDoc(created.id);
  const client = clientClone(doc);
  t.after(() => client.destroy());
  const native = new YjsThreadStore('human', client.getMap('threads'), new DefaultThreadStoreAuth('human', 'editor'));
  const thread = await native.createThread({
    initialComment: { body: [{ type: 'paragraph', content: 'Question' }] },
    metadata: { padding: 'x'.repeat(10 * 1024 * 1024 - 8192) },
  });
  await store.applyUpdate(created.id, Y.encodeStateAsUpdate(client, Y.encodeStateVector(doc)));
  const before = await store.getSyncState(created.id);
  const diskBefore = await readFile(join(dir, `${created.id}.json`));
  let notifications = 0;
  store.onUpdate(() => notifications++);
  await assert.rejects(store.reply(created.id, thread.id, 'y'.repeat(20_000)), /Document exceeds storage limit/);
  const after = await store.getSyncState(created.id);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.update, before.update);
  assert.deepEqual(await readFile(join(dir, `${created.id}.json`)), diskBefore);
  assert.equal(notifications, 0);
  // A failed oversized operation does not poison the queue; a small native resolution still works.
  assert.equal((await store.resolve(created.id, thread.id, 'resolved')).threads[0].resolved, true);
  await store.close();
  const recovered = makeStore();
  await recovered.init();
  const snapshot = await recovered.read(created.id);
  assert.equal(snapshot.threads[0].comments.length, 1);
  assert.equal(snapshot.threads[0].resolved, true);
});

test('malformed native comment bodies are rejected without poisoning valid threads; tombstones recover', async t => {
  const { dir, store, makeStore } = await fixture(t);
  const created = await store.create({ title: 'Comment schema', markdown: 'Review' });
  const doc = await store.getDoc(created.id);
  const author = clientClone(doc);
  t.after(() => author.destroy());
  const native = new YjsThreadStore('human', author.getMap('threads'), new DefaultThreadStoreAuth('human', 'editor'));
  const thread = await native.createThread({ initialComment: { body: [{ type: 'paragraph', content: 'Valid question' }] } });
  await store.applyUpdate(created.id, Y.encodeStateAsUpdate(author, Y.encodeStateVector(doc)));
  const before = await store.getSyncState(created.id);
  const diskBefore = await readFile(join(dir, `${created.id}.json`));
  let notifications = 0;
  store.onUpdate(() => notifications++);
  for (const body of [
    [],
    [{ type: 'unknown', content: 'Bad' }],
    [{ type: 'paragraph', content: [{ type: 'text', text: 42, styles: {} }] }],
    [{ type: 'paragraph', content: [{ type: 'text', text: 'Bad', styles: { bold: 'yes' } }] }],
    [{ type: 'paragraph', content: [{ type: 'link', href: 42, content: 'Bad' }] }],
    [{ type: 'paragraph', children: {} }],
  ]) {
    const malformed = clientClone(doc);
    try {
      const storeForClient = new YjsThreadStore('human', malformed.getMap('threads'), new DefaultThreadStoreAuth('human', 'editor'));
      await storeForClient.updateComment({ threadId: thread.id, commentId: thread.comments[0].id, comment: { body } });
      await assert.rejects(store.applyUpdate(created.id, Y.encodeStateAsUpdate(malformed, Y.encodeStateVector(doc))), /comment/i);
      const after = await store.getSyncState(created.id);
      assert.deepEqual(after, before);
      assert.deepEqual(await readFile(join(dir, `${created.id}.json`)), diskBefore);
      assert.equal((await store.read(created.id)).threads[0].comments[0].body[0].content, 'Valid question');
    } finally { malformed.destroy(); }
  }
  assert.equal(notifications, 0);
  // Native soft-delete removes body, and must remain acceptable.
  await native.deleteComment({ threadId: thread.id, commentId: thread.comments[0].id, softDelete: true });
  await store.applyUpdate(created.id, Y.encodeStateAsUpdate(author, Y.encodeStateVector(doc)));
  await store.close();
  const recovered = makeStore();
  await recovered.init();
  const recoveredThread = (await recovered.read(created.id)).threads[0];
  assert.equal(recoveredThread.comments[0].body, undefined);
  assert.ok(recoveredThread.comments[0].deletedAt instanceof Date);
});

test('deleting the final block rejects atomically, while replacing the final block in a batch is valid', async t => {
  const { dir, store, makeStore } = await fixture(t);
  const created = await store.create({ title: 'Last block', markdown: 'Only block' });
  const before = await store.getSyncState(created.id);
  const diskBefore = await readFile(join(dir, `${created.id}.json`));
  let notifications = 0;
  store.onUpdate(() => notifications++);
  await assert.rejects(store.edit(created.id, {
    expectedRevision: created.revision,
    operations: [{ type: 'delete_block', blockId: created.blocks[0].id }],
  }), /Document must contain at least one block/);
  assert.deepEqual(await store.getSyncState(created.id), before);
  assert.deepEqual(await readFile(join(dir, `${created.id}.json`)), diskBefore);
  assert.equal(notifications, 0);
  const replacement = await store.edit(created.id, {
    expectedRevision: created.revision,
    operations: [
      { type: 'insert_after', blockId: created.blocks[0].id, markdown: 'Replacement block' },
      { type: 'delete_block', blockId: created.blocks[0].id },
    ],
  });
  assert.equal(replacement.blocks.length, 1);
  assert.equal(plain(replacement.blocks[0]), 'Replacement block');
  await store.close();
  const recovered = makeStore();
  await recovered.init();
  assert.deepEqual(await recovered.read(created.id), replacement);
});
