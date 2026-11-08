import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, open, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import type { Block } from '@blocknote/core';
import { CommentsExtension, DefaultThreadStoreAuth, type ThreadData } from '@blocknote/core/comments';
import { YjsThreadStore } from '@blocknote/core/yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { getDocument } from '@blocknote/server-util/dom';

export type { Block, ThreadData };
export interface DocumentInfo { id: string; title: string; updatedAt: string }
export interface DocumentSnapshot extends DocumentInfo { revision: string; blocks: Block[]; threads: ThreadData[] }
export type EditOperation =
  | { type: 'replace_text'; blockId: string; search: string; replacement: string }
  | { type: 'insert_after'; blockId: string; markdown: string }
  | { type: 'delete_block'; blockId: string };
export interface EditRequest { expectedRevision: string; operations: EditOperation[] }
export class DocumentError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'DOCUMENT_ERROR', cause?: unknown) { super(message, { cause }); }
}
interface Entry { info: DocumentInfo; doc: Y.Doc }
type UpdateListener = (id: string, update: Uint8Array, revision: string) => void;
type PreparedOperation = { operation: EditOperation; blocks?: Block[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 10 * 1024 * 1024;
let serverDOM: Document | undefined;
function invalid(message: string): never { throw new DocumentError(400, message); }
function boundedText(value: unknown, name: string, max = 1_000_000): asserts value is string {
  if (typeof value !== 'string' || value.length > max) invalid(`${name} must be text of at most ${max} characters`);
}
function clone(doc: Y.Doc): Y.Doc { const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc)); return copy; }
function revision(doc: Y.Doc): string { return createHash('sha256').update(Y.encodeStateAsUpdate(doc)).digest('hex'); }
function threads(doc: Y.Doc): YjsThreadStore {
  return new YjsThreadStore('agent', doc.getMap('threads'), new DefaultThreadStoreAuth('agent', 'editor'));
}
function findBlock(fragment: Y.XmlFragment, id: string): Y.XmlElement | undefined {
  for (const node of fragment.toArray()) {
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName === 'blockContainer' && node.getAttribute('id') === id) return node;
    const found = findBlock(node, id);
    if (found) return found;
  }
  return undefined;
}
function textNodes(fragment: Y.XmlFragment): Y.XmlText[] {
  const result: Y.XmlText[] = [];
  for (const node of fragment.toArray()) {
    if (node instanceof Y.XmlText) result.push(node);
    else if (node instanceof Y.XmlElement && node.nodeName !== 'blockContainer') result.push(...textNodes(node));
  }
  return result;
}

/** One queue owns CAS, browser updates, snapshots, and durable publication. No browser/editor mount is needed. */
export class DocumentStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<UpdateListener>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private initialized = false;
  private fault: unknown;
  private editor?: ServerBlockNoteEditor;
  private readonly schemaDoc = new Y.Doc();
  private lock?: FileHandle;
  constructor(private readonly dataDir: string) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (this.closed) throw new DocumentError(503, 'Document store is closed');
      if (this.fault) throw new DocumentError(503, 'Document store persistence failed; restart after fixing storage');
      return action();
    });
    this.queue = run.catch(() => {});
    return run;
  }
  private get converter(): ServerBlockNoteEditor {
    return this.editor ??= ServerBlockNoteEditor.create({
      extensions: [CommentsExtension({ threadStore: threads(this.schemaDoc), resolveUsers: async () => [] })],
    }, serverDOM ??= getDocument());
  }
  async init(): Promise<void> {
    return this.serial(async () => {
      if (this.initialized) return;
      await mkdir(this.dataDir, { recursive: true });
      try {
        this.lock = await open(join(this.dataDir, '.writer-lock'), 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DocumentError(409, 'This data directory is locked by another store. After an unclean exit, verify its recorded process is stopped before removing .writer-lock.', 'STORE_LOCKED');
        throw error;
      }
      await this.lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await this.lock.sync();
      await this.syncDirectory();
      const loaded: Entry[] = [];
      try {
        for (const name of await readdir(this.dataDir)) {
          if (!name.endsWith('.json')) continue;
          const raw = JSON.parse(await readFile(join(this.dataDir, name), 'utf8'));
          if (!raw || raw.version !== 1 || !UUID.test(raw.id) || name !== `${raw.id}.json` || typeof raw.title !== 'string' || !raw.title.trim() || !Number.isFinite(Date.parse(raw.updatedAt)) || typeof raw.state !== 'string') throw new Error(`Invalid persisted document ${name}`);
          const bytes = Buffer.from(raw.state, 'base64');
          if (bytes.length > MAX_BYTES || bytes.toString('base64') !== raw.state) throw new Error(`Invalid persisted Yjs state ${name}`);
          const doc = new Y.Doc();
          loaded.push({ info: { id: raw.id, title: raw.title, updatedAt: raw.updatedAt }, doc });
          Y.applyUpdate(doc, bytes);
          this.validate(doc);
        }
        for (const entry of loaded) this.entries.set(entry.info.id, entry);
        this.initialized = true;
      } catch (error) {
        for (const entry of loaded) entry.doc.destroy();
        throw new DocumentError(500, `Cannot recover document storage: ${error instanceof Error ? error.message : String(error)}`, 'CORRUPT_STORAGE');
      }
    });
  }
  onUpdate(listener: UpdateListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private entry(id: string): Entry {
    if (!this.initialized) throw new DocumentError(503, 'Document store is not initialized');
    if (typeof id !== 'string' || !UUID.test(id)) invalid('Invalid document ID');
    const entry = this.entries.get(id);
    if (!entry) throw new DocumentError(404, 'Document not found');
    return entry;
  }
  private validateCommentBody(body: unknown): void {
    // BlockNote 0.57 react/Comments/defaultCommentEditorSchema: paragraphs, default text/link
    // inline content, and boolean styles only (textColor/backgroundColor styles are removed).
    if (!Array.isArray(body) || body.length === 0) invalid('Comment body must contain at least one paragraph');
    const checkText = (value: unknown): void => {
      if (typeof value === 'string') return;
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid comment text');
      const text = value as Record<string, unknown>;
      if (text.type !== 'text' || typeof text.text !== 'string') invalid('Invalid comment text');
      if (text.styles !== undefined) {
        if (!text.styles || typeof text.styles !== 'object' || Array.isArray(text.styles)) invalid('Invalid comment styles');
        for (const [key, enabled] of Object.entries(text.styles)) {
          if (!['bold', 'italic', 'underline', 'strike', 'code'].includes(key) || typeof enabled !== 'boolean') invalid('Unsupported comment style');
        }
      }
    };
    const checkBlocks = (items: unknown[], depth: number): void => {
      if (depth > 64) invalid('Comment nesting exceeds limit');
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Invalid comment block');
        const block = item as Record<string, unknown>;
        if (block.type !== 'paragraph') invalid('Unsupported comment block type');
        if (block.id !== undefined && (typeof block.id !== 'string' || !block.id)) invalid('Invalid comment block ID');
        if (block.props !== undefined) {
          if (!block.props || typeof block.props !== 'object' || Array.isArray(block.props)) invalid('Invalid comment properties');
          for (const [key, value] of Object.entries(block.props)) {
            if (key === 'textAlignment') {
              if (!['left', 'center', 'right', 'justify'].includes(value as string)) invalid('Invalid comment alignment');
            } else if (!['textColor', 'backgroundColor'].includes(key) || typeof value !== 'string') invalid('Unsupported comment property');
          }
        }
        if (block.content !== undefined && typeof block.content !== 'string') {
          if (!Array.isArray(block.content)) invalid('Invalid comment content');
          for (const inline of block.content) {
            if (inline && typeof inline === 'object' && !Array.isArray(inline) && inline.type === 'link') {
              if (typeof inline.href !== 'string' || (!Array.isArray(inline.content) && typeof inline.content !== 'string')) invalid('Invalid comment link');
              if (Array.isArray(inline.content)) inline.content.forEach(checkText);
            } else checkText(inline);
          }
        }
        if (block.children !== undefined) {
          if (!Array.isArray(block.children)) invalid('Invalid comment children');
          checkBlocks(block.children, depth + 1);
        }
      }
    };
    checkBlocks(body, 0);
    this.converter._blocksToProsemirrorNode(body as Block[]).check();
  }
  private validate(doc: Y.Doc): void {
    if ([...doc.share.keys()].some(key => key !== 'blocknote' && key !== 'threads')) invalid('Unknown shared document root');
    const blocks = this.converter.yDocToBlocks(doc, 'blocknote');
    if (blocks.length === 0) invalid('Document must contain at least one block; replace its text instead of deleting the final block');
    const ids = new Set<string>();
    const visit = (items: Block[]) => { for (const block of items) { if (!block.id || ids.has(block.id)) invalid('Missing or duplicate block ID'); ids.add(block.id); visit(block.children); } };
    visit(blocks);
    for (const thread of threads(doc).getThreads().values()) {
      if (!Array.isArray(thread.comments)) invalid('Invalid thread comments');
      for (const comment of thread.comments) {
        // Native soft-deleted comments intentionally have no body.
        if (comment.deletedAt !== undefined) {
          if (!(comment.deletedAt instanceof Date) || !Number.isFinite(comment.deletedAt.getTime()) || comment.body !== undefined) invalid('Invalid comment tombstone');
        } else this.validateCommentBody(comment.body);
      }
    }
    if (Y.encodeStateAsUpdate(doc).byteLength > MAX_BYTES) invalid('Document exceeds storage limit');
  }
  private snapshot(entry: Entry): DocumentSnapshot {
    return { ...entry.info, revision: revision(entry.doc), blocks: this.converter.yDocToBlocks(entry.doc, 'blocknote'), threads: [...threads(entry.doc).getThreads().values()] };
  }
  private async syncDirectory(): Promise<void> {
    // Node cannot fsync directory handles on Windows. Atomic rename still protects ordinary process restarts,
    // but Windows power-loss durability is not guaranteed by this implementation.
    if (process.platform === 'win32') return;
    const directory = await open(this.dataDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async save(entry: Entry): Promise<void> {
    const destination = join(this.dataDir, `${entry.info.id}.json`);
    const temporary = join(this.dataDir, `${entry.info.id}.${randomUUID()}.tmp`);
    const state = Y.encodeStateAsUpdate(entry.doc);
    try {
      const file = await open(temporary, 'wx');
      try { await file.writeFile(JSON.stringify({ version: 1, ...entry.info, state: Buffer.from(state).toString('base64') })); await file.sync(); }
      finally { await file.close(); }
      // Windows replacement can transiently fail while a reader/virus scanner holds the destination.
      // Keep the old file intact and retry only the atomic rename, never unlink-then-replace.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, destination);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 6) throw error;
          await delay(10 * 2 ** attempt);
        }
      }
      await this.syncDirectory();
    } catch (error) {
      await unlink(temporary).catch(() => {});
      this.fault = error;
      throw new DocumentError(503, 'Failed to persist document; storage requires recovery', 'PERSISTENCE_FAILED', error);
    }
  }
  private async publish(entry: Entry, before: Uint8Array): Promise<DocumentSnapshot> {
    entry.info.updatedAt = new Date().toISOString();
    await this.save(entry);
    const snapshot = this.snapshot(entry);
    const update = Y.encodeStateAsUpdate(entry.doc, before);
    for (const listener of this.listeners) { try { listener(entry.info.id, update, snapshot.revision); } catch { /* A disconnected subscriber cannot roll back durable state. */ } }
    return snapshot;
  }
  async list(): Promise<DocumentInfo[]> { return this.serial(async () => { if (!this.initialized) throw new DocumentError(503, 'Document store is not initialized'); return [...this.entries.values()].map(e => ({ ...e.info })); }); }
  async create(input: { title: string; markdown?: string }): Promise<DocumentSnapshot> {
    return this.serial(async () => {
      if (!this.initialized) throw new DocumentError(503, 'Document store is not initialized');
      if (!input || typeof input !== 'object') invalid('Expected document input');
      boundedText(input.title, 'title', 200);
      if (!input.title.trim()) invalid('Title cannot be empty');
      boundedText(input.markdown ?? '', 'markdown');
      const blocks = await this.converter.tryParseMarkdownToBlocks(input.markdown || '');
      const doc = this.converter.blocksToYDoc(blocks.length ? blocks : [{ type: 'paragraph', content: '' }], 'blocknote');
      doc.getMap('threads');
      const entry: Entry = { info: { id: randomUUID(), title: input.title.trim(), updatedAt: new Date().toISOString() }, doc };
      this.validate(doc);
      await this.save(entry);
      this.entries.set(entry.info.id, entry);
      return this.snapshot(entry);
    });
  }
  async read(id: string): Promise<DocumentSnapshot> { return this.serial(async () => this.snapshot(this.entry(id))); }
  /** Transport must never mutate this document directly: submit browser bytes through applyUpdate. */
  async getDoc(id: string): Promise<Y.Doc> { return this.serial(async () => this.entry(id).doc); }
  /** Capture sync bytes and revision in the durability queue, never from an exposed mutable document. */
  async getSyncState(id: string): Promise<{ update: Uint8Array; revision: string }> {
    return this.serial(async () => {
      const doc = this.entry(id).doc;
      const update = Y.encodeStateAsUpdate(doc);
      return { update, revision: createHash('sha256').update(update).digest('hex') };
    });
  }
  async applyUpdate(id: string, update: Uint8Array): Promise<void> {
    return this.serial(async () => {
      const entry = this.entry(id);
      if (!(update instanceof Uint8Array) || update.byteLength > MAX_BYTES) invalid('Invalid or oversized document update');
      const copy = clone(entry.doc);
      try { Y.applyUpdate(copy, update); this.validate(copy); }
      catch (error) { throw new DocumentError(400, `Invalid document update: ${error instanceof Error ? error.message : String(error)}`); }
      finally { copy.destroy(); }
      const before = Y.encodeStateVector(entry.doc);
      Y.applyUpdate(entry.doc, update, 'browser');
      await this.publish(entry, before);
    });
  }
  private applyOperations(doc: Y.Doc, prepared: PreparedOperation[]): void {
    for (const { operation, blocks } of prepared) {
      const block = findBlock(doc.getXmlFragment('blocknote'), operation.blockId);
      if (!block) invalid(`Block not found: ${operation.blockId}`);
      if (operation.type === 'delete_block') {
        const parent = block.parent;
        if (!(parent instanceof Y.XmlFragment)) invalid('Invalid block parent');
        parent.delete(parent.toArray().indexOf(block), 1);
      } else if (operation.type === 'insert_after') {
        const parent = block.parent;
        if (!(parent instanceof Y.XmlFragment)) invalid('Invalid block parent');
        const insertion = this.converter.blocksToYDoc(blocks!, 'blocknote');
        try {
          // Conversion is only for NEW blocks. Existing Yjs elements and their relative anchors stay intact.
          const group = insertion.getXmlFragment('blocknote').toArray()[0];
          if (!(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup') invalid('Unexpected BlockNote block group');
          const children = group.toArray().map(node => {
            if (!(node instanceof Y.XmlElement) || node.nodeName !== 'blockContainer') invalid('Unexpected inserted BlockNote node');
            return node.clone();
          });
          parent.insert(parent.toArray().indexOf(block) + 1, children);
        } finally { insertion.destroy(); }
      } else {
        const nodes = textNodes(block);
        const plain = nodes.map(node => node.toDelta().map((delta: { insert: unknown }) => typeof delta.insert === 'string' ? delta.insert : '\uFFFC').join('')).join('');
        const start = plain.indexOf(operation.search);
        if (start < 0) invalid(`Text not found in block: ${operation.blockId}`);
        if (plain.indexOf(operation.search, start + 1) >= 0) invalid('Search text is ambiguous; use a unique substring');
        const end = start + operation.search.length;
        let offset = 0;
        const edits = nodes.map(node => { const from = Math.max(0, start - offset); const to = Math.min(node.length, end - offset); const at = offset; offset += node.length; return { node, from, to, at }; }).filter(edit => edit.to > edit.from);
        const first = edits[0];
        if (!first) invalid('Search does not identify editable text');
        // Preserve existing formatting/comment marks at the insertion point, including inline thread anchors.
        let cursor = 0;
        let attributes: Record<string, unknown> | undefined;
        for (const delta of first.node.toDelta()) { const size = typeof delta.insert === 'string' ? delta.insert.length : 1; if (cursor + size > first.from) { attributes = delta.attributes; break; } cursor += size; }
        for (const edit of edits.reverse()) edit.node.delete(edit.from, edit.to - edit.from);
        if (operation.replacement) first.node.insert(first.from, operation.replacement, attributes);
      }
    }
  }
  async edit(id: string, input: EditRequest): Promise<DocumentSnapshot> {
    if (!input || typeof input.expectedRevision !== 'string' || !Array.isArray(input.operations) || !input.operations.length || input.operations.length > 100) invalid('Expected revision and 1–100 operations');
    const prepared: PreparedOperation[] = [];
    for (const raw of input.operations) {
      if (!raw || typeof raw.blockId !== 'string') invalid('Operation requires blockId');
      const operation = { ...raw };
      if (operation.type === 'replace_text') {
        boundedText(operation.search, 'search'); boundedText(operation.replacement, 'replacement');
        if (!operation.search) invalid('Search cannot be empty');
        prepared.push({ operation });
      } else if (operation.type === 'insert_after') {
        boundedText(operation.markdown, 'markdown');
        if (!operation.markdown.trim()) invalid('Inserted markdown cannot be empty');
        prepared.push({ operation, blocks: await this.converter.tryParseMarkdownToBlocks(operation.markdown) });
      } else if (operation.type === 'delete_block') prepared.push({ operation });
      else invalid('Unknown edit operation');
    }
    const expectedRevision = input.expectedRevision;
    return this.serial(async () => {
      const entry = this.entry(id);
      if (expectedRevision !== revision(entry.doc)) throw new DocumentError(409, 'Document revision changed; read the document and retry', 'STALE_REVISION');
      const copy = clone(entry.doc);
      try { copy.transact(() => this.applyOperations(copy, prepared)); this.validate(copy); }
      finally { copy.destroy(); }
      const before = Y.encodeStateVector(entry.doc);
      // Replay targeted operations, NOT replacement of the original document or cloned full state.
      entry.doc.transact(() => this.applyOperations(entry.doc, prepared), 'agent');
      return this.publish(entry, before);
    });
  }
  private async updateThread(entry: Entry, threadId: string, mutate: (store: YjsThreadStore) => Promise<unknown>): Promise<DocumentSnapshot> {
    const staged = clone(entry.doc);
    const before = Y.encodeStateVector(entry.doc);
    let update: Uint8Array;
    try {
      const store = threads(staged);
      if (!store.getThreads().has(threadId)) throw new DocumentError(404, 'Comment thread not found');
      await mutate(store);
      this.validate(staged);
      update = Y.encodeStateAsUpdate(staged, before);
    } finally {
      staged.destroy();
    }
    // Merge the exact validated, thread-only delta; preserve the original document and all anchors.
    Y.applyUpdate(entry.doc, update, 'agent-comments');
    return this.publish(entry, before);
  }
  async reply(id: string, threadId: string, text: string): Promise<DocumentSnapshot> {
    return this.serial(async () => {
      const entry = this.entry(id);
      boundedText(text, 'reply', 100_000);
      if (!text.trim()) invalid('Reply cannot be empty');
      return this.updateThread(entry, threadId, store => store.addComment({
        threadId,
        comment: { body: [{ id: randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] }] },
      }));
    });
  }
  async resolve(id: string, threadId: string, state: 'resolved' | 'open'): Promise<DocumentSnapshot> {
    return this.serial(async () => {
      const entry = this.entry(id);
      if (state !== 'resolved' && state !== 'open') invalid('State must be resolved or open');
      return this.updateThread(entry, threadId, async store => {
        if (state === 'resolved') await store.resolveThread({ threadId }); else await store.unresolveThread({ threadId });
      });
    });
  }
  async exportMarkdown(id: string): Promise<string> { return this.serial(async () => this.converter.blocksToMarkdownLossy(this.snapshot(this.entry(id)).blocks)); }
  async close(): Promise<void> {
    await this.queue;
    this.closed = true;
    this.listeners.clear();
    for (const entry of this.entries.values()) entry.doc.destroy();
    this.entries.clear();
    this.editor?.editor._tiptapEditor?.destroy();
    this.schemaDoc.destroy();
    if (this.lock) {
      await this.lock.close();
      this.lock = undefined;
      await unlink(join(this.dataDir, '.writer-lock'));
      await this.syncDirectory();
    }
  }
}
