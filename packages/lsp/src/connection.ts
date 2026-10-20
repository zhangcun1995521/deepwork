/**
 * A JSON-RPC endpoint over one language-server process.
 *
 * The endpoint owns id correlation, outbound requests and notifications, and the requests a server
 * sends *back*: `workspace/configuration` is answered from static deployment config, lifecycle
 * bookkeeping is acknowledged, and `workspace/applyEdit` is **refused**. That last one is the point
 * of answering at all — a server that could ask this client to edit files would be a second write
 * path into the workspace, arriving from a binary the model reached for. Navigation is read-only,
 * and so is this.
 *
 * A framing or JSON failure corrupts the stream position irrecoverably, so it is fatal to the
 * connection rather than skipped: everything after it would be parsed from the wrong offset.
 *
 * @module @zhangcun123/lsp/connection
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'

import { encodeMessage, MessageDecoder } from './framing.ts'

/** How to launch the server and answer its config requests. */
export interface ConnectionSpec {
  /** The resolved executable path: absolute, or the exact name a PATH lookup found. */
  readonly command: string
  /** Arguments passed to the executable. */
  readonly args: readonly string[]
  /** The child's working directory: the canonical workspace. */
  readonly cwd: string
  /** Explicit child environment entries, merged after the ambient credential scrub. */
  readonly env: Record<string, string>
  /** Largest single framed message accepted from the server. */
  readonly maxMessageBytes: number
  /** Largest stderr tail retained for diagnostics. */
  readonly maxStderrBytes: number
  /** The SIGTERM→SIGKILL window when a server will not exit. */
  readonly killGraceMs: number
  /** Static answer to every `workspace/configuration` item. */
  readonly configuration: unknown
}

/** How one process is launched once the platform's shim rules are applied. */
export interface LaunchPlan {
  /** The file to execute. */
  readonly file: string
  /** Arguments to pass it. */
  readonly args: readonly string[]
  /** Whether the launch must go through a shell to reach a shim. */
  readonly shell: boolean
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Write one JSON-RPC message to the child's stdin.
 * @param stdin - the spawned server's stdin.
 * @param message - the unencoded JSON-RPC message.
 * @param done - callback reporting asynchronous stream settlement.
 */
export type ConnectionWriter = (
  stdin: Writable,
  message: unknown,
  done: (error?: Error | null) => void,
) => void

const writeConnectionMessage: ConnectionWriter = (stdin, message, done) => {
  stdin.write(encodeMessage(message), done)
}

/**
 * The two halves of the host's child-environment scrub, copied rather than imported.
 *
 * A language server is a third-party binary, and it does not need this harness's keys or its own
 * identity. `<host>/dsh-subprocess` scrubs the same two things for every child it starts — a
 * credential-shaped name, and **every `DSH_*` name** — and this copy had only the first half, so the
 * harness's own variables reached the server. The second half matters because those names carry
 * deployment facts (home, domain root, mode) that are not the server's business, and because a
 * harness that leaks its identity to a third-party binary has one less boundary than it claims.
 *
 * Both halves match case-insensitively for the reason the host gives: Windows environment names are
 * case-insensitive, so a parent `dsh_*` entry would otherwise survive and read back as `DSH_*`.
 * Copied, not imported, because this package depends on nothing from the host; the cost of a copy is
 * exactly the drift this comment exists to make visible.
 */
const CREDENTIAL_KEY = /(KEY|PASSWORD|SECRET|TOKEN)/i
const HARNESS_ENV_PREFIX = /^DSH_/i

/**
 * Variables whose names look like credentials are not handed to a language server.
 *
 * The server is a third-party binary that needs a compiler and a PATH; it does not need the keys
 * this harness runs on. A deployment that does want one passes it explicitly in `env`, which is why
 * the scrub happens before the merge rather than after.
 * @param overrides - explicit entries from the server's configuration.
 * @param ambient - the environment to scrub; defaults to this process's.
 * @returns the merged child environment.
 */
export function launchEnvironment(
  overrides: Record<string, string>,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(ambient)) {
    if (CREDENTIAL_KEY.test(key) || HARNESS_ENV_PREFIX.test(key)) continue
    environment[key] = value
  }
  return { ...environment, ...overrides }
}

/**
 * Apply the platform's rule for reaching an executable shim.
 *
 * A language server installed from npm is a `.cmd` shim on Windows, and Windows will not execute one
 * without a shell — so that case goes through one, and only that case. Every other launch passes the
 * executable and its arguments directly, which is what keeps a deployment's configuration from being
 * read as shell syntax.
 * @param command - the resolved executable.
 * @param args - its arguments.
 * @returns the file and arguments to launch.
 */
export function launchPlan(command: string, args: readonly string[]): LaunchPlan {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return { file: command, args, shell: true }
  }
  return { file: command, args, shell: false }
}

/** A live JSON-RPC endpoint bound to one child process. */
export class LspConnection {
  private readonly child: ChildProcess
  private readonly stdin: Writable
  private readonly onServerRequest: (method: string, params: unknown) => Promise<unknown>
  private readonly writer: ConnectionWriter
  private readonly decoder: MessageDecoder
  private readonly pending = new Map<number, Pending>()
  private readonly maxStderrBytes: number
  private readonly killGraceMs: number
  private stderrBuffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private closeReason: Error | undefined
  private terminated = false
  private closedSettled = false
  /** Set once the process has fully exited; the instance awaits it during teardown. */
  readonly closed: Promise<void>

  /**
   * @param spec - how to launch the server and answer its config requests.
   * @param onServerRequest - answers a server→client request; rejects to send an error response.
   * @param writer - message writer; tests inject write failures without relying on OS pipe races.
   */
  constructor(
    spec: ConnectionSpec,
    onServerRequest: (method: string, params: unknown) => Promise<unknown>,
    writer: ConnectionWriter = writeConnectionMessage,
  ) {
    this.onServerRequest = onServerRequest
    this.writer = writer
    this.decoder = new MessageDecoder(spec.maxMessageBytes)
    this.maxStderrBytes = spec.maxStderrBytes
    this.killGraceMs = spec.killGraceMs
    const plan = launchPlan(spec.command, spec.args)
    this.child = spawn(plan.file, [...plan.args], {
      cwd: spec.cwd,
      env: launchEnvironment(spec.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: plan.shell,
      windowsHide: true,
      // Its own process group on POSIX, so teardown can signal the tree a language server starts
      // (a node server keeps its plugins). Windows gets the same reach from `taskkill /T`.
      detached: process.platform !== 'win32',
    })
    if (this.child.stdin === null || this.child.stdout === null) {
      throw new Error('lsp: the language server was spawned without the piped stdio this client requires')
    }
    this.stdin = this.child.stdin
    this.closed = new Promise<void>((resolve) => {
      const close = (): void => {
        this.closedSettled = true
        const reason = this.closeReason ?? new Error(this.exitMessage())
        // Record the reason so a request issued AFTER close rejects immediately instead of hanging:
        // a closed process sends no further responses.
        this.closeReason = reason
        this.failAll(reason)
        resolve()
      }
      this.child.on('close', close)
      this.child.on('error', (error: Error) => {
        // A spawn-level failure never produces a close event; the rejection is the fatal cause and
        // the close boundary at once.
        this.fail(error)
        close()
      })
    })
    // Child stdin can fail while the process stays alive — a server that closes fd 0, for instance.
    // Treat it as a fatal connection error so pending requests reject now instead of waiting for a
    // close event that may never arrive.
    this.stdin.on('error', (error: Error) => { this.fail(error) })
    this.child.stdout.on('data', (chunk: Buffer) => { this.onStdout(chunk) })
    // The bounded tail IS the diagnostic contract; there is nothing to spill and nobody to spill to.
    this.child.stderr?.on('data', (chunk: Buffer) => { this.collectStderr(chunk) })
  }

  /** The child's pid, or `-1` when the spawn produced none (so signalling is a no-op). */
  get pid(): number {
    return this.child.pid ?? -1
  }

  /** The retained stderr tail, for diagnostics on a failed server. */
  get stderrTail(): string {
    return this.stderrBuffer.toString('utf8')
  }

  /** Whether the transport has failed, even if the child's close event has not arrived yet. */
  get failed(): boolean {
    return this.closeReason !== undefined
  }

  /**
   * Test whether a caught error is this connection's retained fatal transport cause.
   * @param error - the error caught by the instance or provider.
   * @returns `true` only when this connection produced that exact failure.
   */
  failedWith(error: unknown): boolean {
    return this.closeReason === error
  }

  /**
   * Send a request and await its result.
   * @param method - the JSON-RPC method.
   * @param params - the request params.
   * @returns the response result; rejects on an error response, write failure, or close.
   */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.closeReason !== undefined) {
        reject(this.closeReason)
        return
      }
      this.pending.set(id, { resolve, reject })
      void this.write({ jsonrpc: '2.0', id, method, params }).catch(() => {})
    })
    // A caller that stops awaiting — an aborted query — leaves this promise to reject later when the
    // process closes; the no-op handler keeps that from surfacing as an unhandled rejection, while
    // the returned promise still delivers the rejection to the caller's own await.
    promise.catch(() => {})
    return promise
  }

  /**
   * Send a notification: no id, no response.
   * @param method - the JSON-RPC method.
   * @param params - the notification params.
   * @returns a promise settling when the framed notification has been written.
   */
  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Send a `$/cancelRequest` for an in-flight request id; best-effort, ignoring write failure.
   * @param requestId - the numeric id of the request to cancel.
   */
  cancel(requestId: number): void {
    void this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId } }).catch(() => {})
  }

  /**
   * The id the NEXT `request()` will use, so the instance can pre-arm a cancellation.
   * @returns the numeric id the next request will be assigned.
   */
  peekNextId(): number {
    return this.nextId
  }

  /**
   * Terminate the server's process tree. Idempotent, and never throws: teardown must reach
   * quiescence whether or not the server cooperates.
   */
  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    const pid = this.child.pid
    if (pid === undefined || this.closedSettled) return
    if (process.platform === 'win32') {
      // A language server keeps children — a node host keeps its plugins — and killing the launcher
      // alone leaves them holding the pipes and the CPU. `/T` is the tree.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
      return
    }
    signalTree(pid, 'SIGTERM')
    const escalate = setTimeout(() => { signalTree(pid, 'SIGKILL') }, this.killGraceMs)
    escalate.unref()
    this.child.once('close', () => { clearTimeout(escalate) })
  }

  /** Retain the last `maxStderrBytes` bytes of stderr. */
  private collectStderr(chunk: Buffer): void {
    const combined = this.stderrBuffer.length === 0 ? chunk : Buffer.concat([this.stderrBuffer, chunk])
    this.stderrBuffer = combined.length > this.maxStderrBytes
      ? combined.subarray(combined.length - this.maxStderrBytes)
      : combined
  }

  private onStdout(chunk: Buffer): void {
    let messages: unknown[]
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      // A framing or JSON failure corrupts the stream position irrecoverably: fail the connection and
      // kill the tree, so nothing outlives a transport this client can no longer trust.
      this.fail(asError(error))
      this.terminate()
      return
    }
    for (const message of messages) this.dispatch(message)
  }

  private dispatch(message: unknown): void {
    if (message === null || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      void this.handleServerRequest(id, method, frame.params).catch(() => {})
      return
    }
    if (typeof method === 'string') {
      // A server→client notification, such as diagnostics or a log line. Nothing here consumes one;
      // diagnostics need their own freshness and accumulation rules and are not part of a query.
      return
    }
    if (typeof id === 'number') this.handleResponse(id, frame)
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onServerRequest(method, params)
      await this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      await this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: asError(error).message } })
    }
  }

  private handleResponse(id: number, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    const error = frame.error
    if (error !== null && typeof error === 'object') {
      const record = error as Record<string, unknown>
      pending.reject(new Error(typeof record.message === 'string' ? record.message : 'LSP error response'))
      return
    }
    pending.resolve(frame.result)
  }

  private write(message: unknown): Promise<void> {
    if (this.closeReason !== undefined) return Promise.reject(this.closeReason)
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null): void => {
        if (error === undefined || error === null) {
          resolve()
          return
        }
        this.fail(error)
        reject(error)
      }
      try {
        this.writer(this.stdin, message, done)
      } catch (error) {
        // Node delivers stream write failures through the callback; this guards a Writable that
        // throws synchronously instead.
        const failure = asError(error)
        this.fail(failure)
        reject(failure)
      }
    })
  }

  /** The exit-close error message, appending the retained stderr tail when the server wrote any. */
  private exitMessage(): string {
    const tail = this.stderrBuffer.toString('utf8').trim()
    return tail === '' ? 'language server exited' : `language server exited; stderr: ${tail}`
  }

  private fail(error: Error): void {
    if (this.closeReason === undefined) this.closeReason = error
    this.failAll(error)
  }

  private failAll(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) pending.reject(error)
  }
}

/** Signal a process group, falling back to the process itself when it never became a group leader. */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone; nothing to signal.
    }
  }
}

/** Coerce an unknown thrown value to an `Error`. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
