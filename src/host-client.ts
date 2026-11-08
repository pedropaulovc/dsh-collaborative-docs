import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { DocumentStore } from './engine.js'

export interface ServiceConfig { dataDir: string; port?: number }
type StoreMethod = 'list' | 'read' | 'create' | 'edit' | 'reply' | 'resolve' | 'exportMarkdown'
export type ServiceMethods = Pick<DocumentStore, StoreMethod> & {
  init(config: ServiceConfig): Promise<void>
  open(id?: string): Promise<{ url: string }>
  close(): Promise<void>
}
export type ServiceRequest = { [K in keyof ServiceMethods]: { id: number; method: K; args: Parameters<ServiceMethods[K]> } }[keyof ServiceMethods]
export interface ServiceError { name: string; message: string; stack?: string; code?: string; status?: number }
export type ServiceReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: ServiceError }

/** No editor/DOM runtime enters the DSH process; the child owns every document. */
export class DocumentService {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private readonly exited = Promise.withResolvers<void>()
  private sequence = 0
  private failure?: Error
  private didExit = false
  private stderr = ''
  private initializing?: Promise<void>
  private closing?: Promise<void>

  constructor(private readonly config: ServiceConfig) {
    this.child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [], {
      execPath: process.execPath,
      execArgv: [],
      // Electron's executable must act as plain Node. Do not inherit host loader hooks.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    })
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8192) })
    this.child.on('message', (reply: ServiceReply) => {
      const request = this.pending.get(reply.id)
      if (!request) return
      this.pending.delete(reply.id)
      if (reply.ok) request.resolve(reply.value)
      else request.reject(Object.assign(new Error(reply.error.message), reply.error))
    })
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => {
      this.didExit = true
      this.fail(new Error(`Document service exited (${signal ?? code})${this.stderr ? `\n${this.stderr}` : ''}`))
    })
    this.child.on('close', () => { this.didExit = true; this.exited.resolve() })
    this.child.on('disconnect', () => this.fail(new Error('Document service disconnected')))
  }

  private fail(error: Error) {
    this.failure ??= error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  private request<K extends keyof ServiceMethods>(method: K, ...args: Parameters<ServiceMethods[K]>): ReturnType<ServiceMethods[K]> {
    const result = Promise.withResolvers<unknown>()
    if (this.failure) result.reject(this.failure)
    else if (this.closing && method !== 'close') result.reject(new Error('Document service is closing'))
    else {
      const id = ++this.sequence
      this.pending.set(id, result)
      try {
        this.child.send({ id, method, args }, error => {
          if (!error) return
          this.pending.delete(id)
          result.reject(error)
        })
      } catch (error) {
        this.pending.delete(id)
        result.reject(error)
      }
    }
    return result.promise as ReturnType<ServiceMethods[K]>
  }

  init() { return this.initializing ??= this.request('init', this.config) }
  list(...args: Parameters<ServiceMethods['list']>) { return this.request('list', ...args) }
  read(...args: Parameters<ServiceMethods['read']>) { return this.request('read', ...args) }
  create(...args: Parameters<ServiceMethods['create']>) { return this.request('create', ...args) }
  edit(...args: Parameters<ServiceMethods['edit']>) { return this.request('edit', ...args) }
  reply(...args: Parameters<ServiceMethods['reply']>) { return this.request('reply', ...args) }
  resolve(...args: Parameters<ServiceMethods['resolve']>) { return this.request('resolve', ...args) }
  exportMarkdown(...args: Parameters<ServiceMethods['exportMarkdown']>) { return this.request('exportMarkdown', ...args) }
  open(...args: Parameters<ServiceMethods['open']>) { return this.request('open', ...args) }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      // Bound shutdown even if a child is stuck inside third-party editor code.
      const timeout = setTimeout(() => this.child.kill(), 10_000)
      try {
        if (!this.didExit && this.child.connected) await this.request('close')
        await this.exited.promise
      } finally {
        clearTimeout(timeout)
        if (!this.didExit) {
          this.child.kill()
          await this.exited.promise
        }
      }
    })()
  }
}
