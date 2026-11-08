import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { workspaceUrl } from './urls.js';

export type SyncState = {
  connection: 'connecting' | 'connected' | 'disconnected';
  readiness: 'loading' | 'ready';
  persistence: 'saved' | 'pending';
  error: string | null;
};
const remoteOrigin = Symbol('server');
function encode(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** The server acknowledges only durable updates. Socket-open is not saved. */
export class DocumentSync {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  private state: SyncState = { connection: 'connecting', readiness: 'loading', persistence: 'saved', error: null };
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private timer: number | undefined;
  private handshakeTimer: number | undefined;
  private sequence = 0;
  private outstanding = new Set<number>();
  private stopped = false;
  private synchronized = false;
  private attempts = 0;
  private storageError: string | null = null;
  private readonly cacheKey: string;
  private readonly recoveryRecords = new Map<string, string>();

  constructor(readonly id: string) {
    const documentKey = `shared-doc-pending:${id}`;
    // Every provider gets a fresh writer identity: duplicated tabs copy sessionStorage.
    this.cacheKey = `${documentKey}:${crypto.randomUUID()}`;
    try {
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      for (const key of keys) {
        if (!key || (key !== documentKey && !key.startsWith(`${documentKey}:`))) continue;
        const cached = localStorage.getItem(key);
        if (!cached) continue;
        try {
          Y.applyUpdate(this.doc, decode(cached), remoteOrigin);
          // Retain the exact adopted bytes, not a later value written by its live owner.
          this.recoveryRecords.set(key, cached);
          this.state = { ...this.state, persistence: 'pending' };
        } catch {
          this.storageError = 'Some local recovery data could not be read. It was preserved; keep other editing tabs open.';
          this.state = { ...this.state, error: this.storageError };
        }
      }
    } catch {
      this.storageError = 'Local recovery storage is unavailable. Keep this tab open until changes are saved.';
      this.state = { ...this.state, error: this.storageError };
    }
    this.doc.on('update', this.onUpdate);
    this.connect();
  }
  getSnapshot = (): SyncState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private backup() {
    try {
      const bytes = encode(Y.encodeStateAsUpdate(this.doc));
      localStorage.setItem(this.cacheKey, bytes);
      this.recoveryRecords.set(this.cacheKey, bytes);
    }
    catch {
      this.storageError = 'Local recovery storage is full or unavailable. Keep this tab open until changes are saved.';
      this.publish({ error: this.storageError });
    }
  }
  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === remoteOrigin) return;
    this.publish({ persistence: 'pending' });
    this.backup();
    if (this.synchronized) this.send(update);
  };
  private send(update: Uint8Array) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const seq = ++this.sequence;
    this.outstanding.add(seq);
    this.publish({ persistence: 'pending' });
    try { this.socket.send(JSON.stringify({ type: 'update', update: encode(update), seq })); }
    catch { this.socket.close(); }
  }
  private connect() {
    if (this.stopped || this.socket) return;
    this.publish({ connection: 'connecting' });
    const url = workspaceUrl(`sync/${encodeURIComponent(this.id)}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    this.handshakeTimer = window.setTimeout(() => socket.close(), 15000);
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'sync') {
          if (this.synchronized || typeof frame.update !== 'string') throw new Error('Invalid initial document state.');
          Y.applyUpdate(this.doc, decode(frame.update), remoteOrigin);
          this.synchronized = true;
          this.attempts = 0;
          clearTimeout(this.handshakeTimer);
          this.outstanding.clear();
          this.publish({ connection: 'connected', readiness: 'ready', error: this.storageError });
          // Merge all edits made offline, including recovered edits, on every connection.
          this.send(Y.encodeStateAsUpdate(this.doc));
        } else if (frame.type === 'update') {
          if (typeof frame.update !== 'string') throw new Error('Invalid document update.');
          Y.applyUpdate(this.doc, decode(frame.update), remoteOrigin);
          if (this.state.persistence === 'pending') this.backup();
        } else if (frame.type === 'ack') {
          if (!this.outstanding.delete(frame.seq)) return;
          if (this.outstanding.size === 0) {
            // All sent local updates (including the full recovered state) are durable.
            // A different live writer may have appended edits since adoption: never
            // remove that newer value merely because this provider received an ack.
            try {
              for (const [key, adoptedBytes] of this.recoveryRecords) {
                if (localStorage.getItem(key) === adoptedBytes) localStorage.removeItem(key);
              }
              this.recoveryRecords.clear();
            } catch { /* Preserve recovery records when cleanup is unavailable. */ }
            this.publish({ persistence: 'saved', error: this.storageError });
          }
        } else if (frame.type === 'error') {
          throw new Error(typeof frame.message === 'string' ? frame.message : 'The server could not save changes.');
        } else throw new Error('Unrecognized sync response.');
      } catch (error) {
        this.publish({ error: error instanceof Error ? error.message : 'Document synchronization failed.' });
        socket.close();
      }
    };
    socket.onerror = () => {
      this.publish({ error: 'Cannot reach the document server. Reopen the editor from DSH if your session expired.' });
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      clearTimeout(this.handshakeTimer);
      this.socket = null;
      this.synchronized = false;
      this.outstanding.clear();
      this.publish({ connection: 'disconnected' });
      if (!this.stopped) {
        const delay = Math.min(15000, 750 * 2 ** Math.min(this.attempts++, 5));
        this.timer = window.setTimeout(() => this.connect(), delay);
      }
    };
  }
  reconnect = () => {
    clearTimeout(this.timer);
    if (this.socket) this.socket.close();
    else this.connect();
  };
  destroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.handshakeTimer);
    this.socket?.close();
    this.doc.off('update', this.onUpdate);
    this.awareness.destroy();
    this.doc.destroy();
    this.listeners.clear();
  }
}
