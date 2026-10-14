/**
 * One language-server instance: the connection, the initialize handshake, and the query lifecycle.
 *
 * A query is **transient-open**: the source is opened with `didOpen` at version 1 carrying the full
 * text, the request is made, and `didClose` runs in `finally`. That is the whole document story —
 * no `didChange`, no content cache, no LRU — and it is why a query always reads what is on disk when
 * its turn starts rather than what a server was told an hour ago.
 *
 * Queries serialize through one queue. The queue is what makes cancellation safe: a request the
 * server ignores is terminated with the instance rather than left running beside the next query's
 * document lifecycle, and terminating the instance is only acceptable because nothing else is using
 * it. Distinct instances — distinct workspaces — run in parallel.
 *
 * @module @zhangcun123/lsp/instance
 */

import { LspError } from './seam.ts'
import type {
  LspOperation,
  LspProviderQuery,
  LspQueryResult,
} from './seam.ts'
import { abortable, abortError, deadline } from './deadline.ts'
import { LspConnection } from './connection.ts'
import type { ConnectionSpec, ConnectionWriter } from './connection.ts'
import type { HostSource } from './workspace.ts'
import type { WireInitializeResult, WireServerCapabilities } from './protocol.ts'
import {
  negotiatePositionEncoding,
  normalizeHover,
  normalizeLocations,
  requestMethod,
  supportsOperation,
  supportsTransientOpen,
} from './translate.ts'

/** Everything an instance needs beyond the connection spec. */
export interface InstanceSpec extends ConnectionSpec {
  /** Canonical workspace file URI, sent at initialization and used to relativize locations. */
  readonly workspaceUri: string
  /** Static `initialize` options forwarded to the server. */
  readonly initializationOptions: unknown
  /** Graceful `shutdown`/`exit` budget before escalation (ms). */
  readonly shutdownTimeoutMs: number
}

/**
 * A single initialized server process. The provider single-flights and pools these;
 * `query()` serializes and `dispose()` rejects queued work and tears the process down.
 */
export class LspInstance {
  private readonly spec: InstanceSpec
  private readonly connection: LspConnection
  private capabilities: WireServerCapabilities | undefined
  /** The serialization tail: each query awaits the prior one, so lifecycles never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  /** The one teardown transaction shared by abort, failure, and explicit disposal. */
  private teardownPromise: Promise<void> | undefined
  /** Set once the process closes, so the pool can synchronously skip a dead instance. */
  private processClosed = false
  /** Resolves once `initialize` succeeds; a failed handshake rejects every query. */
  private readonly ready: Promise<void>

  /**
   * @param spec - the launch, initialize, and teardown parameters.
   * @param writer - optional connection writer used by transport conformance tests.
   */
  constructor(spec: InstanceSpec, writer?: ConnectionWriter) {
    this.spec = spec
    this.connection = new LspConnection(spec, (method, params) => this.answerServerRequest(method, params), writer)
    this.ready = this.initialize()
    // A handshake rejection must not surface as an unhandled rejection before the first query awaits
    // it; queries attach the real handler.
    this.ready.catch(() => {})
    void this.connection.closed.then(() => { this.processClosed = true })
  }

  /** Synchronous liveness check: true once the process closed or the instance was disposed. */
  get dead(): boolean {
    return this.processClosed || this.disposed || this.connection.failed
  }

  /**
   * Test whether a caught query error came from this instance's transport.
   * @param error - the error caught by the provider.
   * @returns `true` only for the connection's retained fatal transport cause.
   */
  isTransportFailure(error: unknown): boolean {
    return this.connection.failedWith(error)
  }

  /**
   * Run one query through the serialized queue.
   * @param request - the resolved provider query.
   * @param source - the pre-validated, already-read source.
   * @param signal - optional cancellation for this query's complete lifecycle.
   * @returns the normalized result.
   */
  query(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    // Serialize behind prior work, but observe abort DURING the queue wait too: if an earlier query
    // hangs, a later caller's timeout must still be able to give up rather than block on the shared
    // tail forever.
    const run = abortable(this.queue, signal)
      .then(() => this.runQuery(request, source, signal))
      .catch(async (error: unknown) => {
        if (this.isTransportFailure(error)) await this.startTeardown()
        throw error
      })
    // Keep the tail alive whatever this query's outcome, so the next caller still serializes. The
    // tail follows the ACTUAL prior work, not the abortable view, so a caller giving up on its wait
    // does not deserialize the queue.
    this.queue = this.queue.then(() => run).then(() => undefined, () => undefined)
    return run
  }

  private async initialize(): Promise<void> {
    const initializeResult = await this.connection.request('initialize', {
      // A server may run in another PID namespace or on another machine; the harness PID would let
      // it monitor an unrelated process.
      processId: null,
      rootUri: this.spec.workspaceUri,
      workspaceFolders: [{ uri: this.spec.workspaceUri, name: 'workspace' }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.spec.initializationOptions,
    }) as WireInitializeResult
    const capabilities = initializeResult.capabilities
    // An omitted encoding defaults to utf-16; any other value is a protocol error.
    negotiatePositionEncoding(capabilities.positionEncoding)
    this.capabilities = capabilities
    await this.connection.notify('initialized', {})
  }

  private async runQuery(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new LspError('LSP instance was disposed', 'LSP_DISPOSED')
    if (signal?.aborted) throw abortError(signal)
    // Observe abort during the handshake wait, and never pool a poisoned instance: a wait that ends
    // in failure — an abort on a pending handshake, or `initialize` rejecting without the process
    // exiting — tears the instance down, so a permanently-rejecting handshake cannot make every
    // later query for this workspace fail.
    try {
      await abortable(this.ready, signal)
    } catch (error) {
      if (!this.dead) await this.startTeardown()
      throw error
    }
    const capabilities = this.capabilities
    if (capabilities === undefined) throw new Error('LSP instance is not initialized')
    if (!supportsOperation(capabilities, request.operation)) {
      throw new LspError(`server does not support ${request.operation}`, 'LSP_UNSUPPORTED_OPERATION')
    }
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      throw new LspError(
        'server does not support the transient textDocument/didOpen this client requires',
        'LSP_UNSUPPORTED_OPERATION',
      )
    }

    const uri = source.fileUrl
    let opened = false
    try {
      if (signal?.aborted) throw abortError(signal)
      try {
        await abortable(this.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: request.languageId, version: 1, text: source.text },
        }), signal)
      } catch (error) {
        // A canceled backpressured write or a failed stdin leaves the protocol stream unusable before
        // `opened` can arm the didClose cleanup. Teardown here makes the pool evict the instance.
        await this.startTeardown()
        throw error
      }
      opened = true
      const payload = await this.sendRequest(request.operation, uri, request.position, signal)
      return this.normalize(request.operation, payload)
    } finally {
      // A disposed or closed instance — an aborted request whose server ignored `$/cancelRequest` —
      // is already tearing down; sending didClose would race it and let the next queued query's
      // document lifecycle overlap a still-active request.
      if (opened && !this.dead) {
        try {
          await this.connection.notify('textDocument/didClose', { textDocument: { uri } })
        } catch {
          // A close-write failure does not replace the settled result, but the instance can no longer
          // be trusted: invalidate it and await bounded process termination.
          try {
            await this.startTeardown()
          } catch {
            // Teardown owns every expected process race; this keeps an already-settled query outcome
            // when an unexpected cleanup primitive itself rejects.
          }
        }
      }
    }
  }

  private async sendRequest(
    operation: LspOperation,
    uri: string,
    position: LspProviderQuery['position'],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const params = {
      textDocument: { uri },
      position: { line: position.line, character: position.character },
      // findReferences always includes declarations: the caller gets no flag, and impact analysis
      // never omits the defining site.
      ...(operation === 'findReferences' ? { context: { includeDeclaration: true } } : {}),
    }
    const requestId = this.connection.peekNextId()
    const send = this.connection.request(requestMethod(operation), params)
    if (signal === undefined) return send
    return this.raceAbort(send, requestId, signal)
  }

  /**
   * Race a pending request against abort. On abort, send `$/cancelRequest` and give the server a
   * bounded grace to acknowledge; if it does not settle in time, invalidate and tear down the
   * instance, so a still-active request cannot overlap the next queued query's document lifecycle.
   */
  private async raceAbort(send: Promise<unknown>, requestId: number, signal: AbortSignal): Promise<unknown> {
    try {
      return await abortable(send, signal)
    } catch (error) {
      if (!signal.aborted) throw error
      this.connection.cancel(requestId)
      const grace = deadline(this.spec.killGraceMs, 'LSP_CANCEL_GRACE')
      try {
        // `settled` is true if the request finished, either outcome, before the grace elapsed.
        const settled = await Promise.race([
          send.then(markSettled, markSettled),
          new Promise<boolean>((resolve) => {
            if (grace.signal.aborted) {
              resolve(false)
              return
            }
            grace.signal.addEventListener('abort', () => { resolve(false) }, { once: true })
          }),
        ])
        if (!settled) await this.startTeardown()
      } finally {
        grace.dispose()
      }
      throw error
    }
  }

  private normalize(operation: LspOperation, payload: unknown): LspQueryResult {
    if (operation === 'hover') {
      return { kind: 'hover', hover: normalizeHover(payload) }
    }
    // The workspace URI is the one the server was told about, which is the coordinate its locations
    // are expressed in; reparsing the request path here would break on a symlinked root.
    return { kind: 'locations', locations: normalizeLocations(payload), resolvedWorkspaceUri: this.spec.workspaceUri }
  }

  private answerServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'workspace/configuration') {
      const record = params as { items?: unknown[] } | null
      const items = Array.isArray(record?.items) ? record.items : []
      return Promise.resolve(items.map(() => this.spec.configuration))
    }
    if (LIFECYCLE_NOOP_METHODS.has(method)) {
      // Lifecycle bookkeeping is acknowledged with an empty result; nothing is registered dynamically.
      return Promise.resolve(null)
    }
    if (method === 'workspace/applyEdit') {
      // This client never applies edits or runs commands.
      return Promise.reject(new Error('workspace/applyEdit is not permitted by this client'))
    }
    return Promise.reject(new Error(`unsupported server request: ${method}`))
  }

  /**
   * Reject queued work, attempt graceful `shutdown`/`exit`, then escalate to a tree kill, awaiting
   * process close so nothing outlives disposal.
   */
  async dispose(): Promise<void> {
    await this.startTeardown()
  }

  /** Publish disposal once and make every caller await the same quiescence boundary. */
  private startTeardown(): Promise<void> {
    this.disposed = true
    this.teardownPromise ??= this.tearDown()
    return this.teardownPromise
  }

  private async tearDown(): Promise<void> {
    const shutdownDeadline = deadline(this.spec.shutdownTimeoutMs, 'LSP_SHUTDOWN')
    try {
      await this.gracefulShutdown(shutdownDeadline.signal)
    } catch {
      // A server that will not shut down gracefully still gets killed; the cleanup below is what
      // makes that a bounded wait rather than a hang.
    } finally {
      shutdownDeadline.dispose()
    }
    await this.forceTerminate()
  }

  /** Best-effort LSP `shutdown`/`exit`, including process close, bounded by `signal`. */
  private async gracefulShutdown(signal: AbortSignal): Promise<void> {
    await abortable(this.connection.request('shutdown', null), signal)
    await this.connection.notify('exit', null)
    await abortable(this.connection.closed, signal)
  }

  /**
   * Kill the server's process tree — `taskkill /T` on Windows, the process group elsewhere — then
   * await the leader's close. The await is unbounded on purpose: the kill already committed to the
   * strongest signal available, so quiescence, not another timer, is what disposal owes its callers.
   */
  private async forceTerminate(): Promise<void> {
    this.connection.terminate()
    await this.connection.closed
  }
}

/** Server→client request methods acknowledged with an empty result (no dynamic registration). */
const LIFECYCLE_NOOP_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
])

/** Mark a settled request in the cancel-grace race: either outcome means the request finished. */
function markSettled(): boolean {
  return true
}

/**
 * The client capabilities advertised at `initialize`: UTF-16 positions, workspace folders and
 * configuration, markdown/plaintext hover, and link support for definition and implementation. No
 * dynamic registration; the server's returned capabilities are authoritative.
 */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
  },
} as const
