/**
 * The stdio backend: one configured language server, one process per workspace, and the queue that
 * serializes queries through it.
 *
 * Three decisions carry most of the weight here.
 *
 * **The command is configuration, and it is resolved at load.** A deployment names a server; a model
 * never does. Resolving the executable before any provider is registered means a mistyped command
 * fails the plugin's load instead of failing the first question somebody asks.
 *
 * **One process per canonical workspace, created lazily.** A server indexes a workspace, so sharing
 * one across two roots would answer from the wrong index. Lazy because a deployment may configure a
 * server for a language this session never opens.
 *
 * **A failed transport is replaced once.** A language server can die while idle, and a read-only
 * query is safe to repeat — so the pool evicts the dead instance and retries that query on a fresh
 * process rather than reporting a failure the caller cannot act on.
 *
 * @module @zhangcun123/lsp/provider
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'

import { LspError, LspProviderId } from './seam.ts'
import type { LspProvider, LspProviderQuery, LspQueryResult } from './seam.ts'
import { abortable, abortError } from './deadline.ts'
import { canonicalizeWorkspace, readHostSource } from './workspace.ts'
import type { HostWorkspace } from './workspace.ts'
import { LspInstance } from './instance.ts'
import type { InstanceSpec } from './instance.ts'

/** The largest timer Node will schedule rather than clamp. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

const DEFAULT_MAX_MESSAGE_BYTES = 16_000_000
const DEFAULT_MAX_STDERR_BYTES = 1_000_000
const DEFAULT_MAX_DOCUMENT_BYTES = 4_000_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_KILL_GRACE_MS = 2_000

/** One configured local language server and its bounds, as a deployment writes it. */
export interface LspServerConfig {
  /** Executable to run: absolute, or a name resolved on the child PATH at load. */
  command: string
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  extensionToLanguage: Record<string, string>
  /** Arguments passed to the executable. Default `[]`. */
  args?: string[]
  /** Extra environment entries, merged after the ambient credential scrub. Default `{}`. */
  env?: Record<string, string>
  /** Static `initialize` options forwarded to the server. Default `null`. */
  initializationOptions?: unknown
  /** Static answer to every `workspace/configuration` item. Default `null`. */
  configuration?: unknown
  /** Largest single framed message accepted from the server. Default 16000000. */
  maxMessageBytes?: number
  /** Largest stderr tail retained for diagnostics. Default 1000000. */
  maxStderrBytes?: number
  /** Largest source file this client will open. Default 4000000. */
  maxDocumentBytes?: number
  /** Graceful `shutdown`/`exit` budget before escalation (ms). Default 5000. */
  shutdownTimeoutMs?: number
  /** Request-cancel and terminate-escalation grace (ms). Default 2000. */
  killGraceMs?: number
}

/** A server configuration with every default filled and every value checked. */
export interface ResolvedServerConfig {
  readonly command: string
  readonly extensionToLanguage: Record<string, string>
  readonly args: readonly string[]
  readonly env: Record<string, string>
  readonly initializationOptions: unknown
  readonly configuration: unknown
  readonly maxMessageBytes: number
  readonly maxStderrBytes: number
  readonly maxDocumentBytes: number
  readonly shutdownTimeoutMs: number
  readonly killGraceMs: number
}

/**
 * Check and default one server entry.
 *
 * Everything lands here because this is the boundary where a value written in YAML becomes a value
 * the runtime acts on. A cap of zero is not a small cap: `maxStderrBytes: 0` retains nothing,
 * `maxMessageBytes: 0` makes every response fatal, and a nonpositive timer budget would let a server
 * that ignores `shutdown` hang disposal forever.
 * @param serverId - the server's configured name, used in every message.
 * @param config - the entry as the deployment wrote it.
 * @returns the resolved configuration.
 * @throws Error naming the offending field, before any provider registers.
 */
export function resolveServerConfig(serverId: string, config: LspServerConfig): ResolvedServerConfig {
  const command = requiredString(serverId, 'command', config.command)
  const extensions = config.extensionToLanguage
  if (extensions === null || typeof extensions !== 'object' || Array.isArray(extensions)) {
    throw new Error(`lsp: servers.${serverId}.extensionToLanguage must be an object of language ids`)
  }
  const extensionToLanguage: Record<string, string> = {}
  for (const [extension, languageId] of Object.entries(extensions)) {
    extensionToLanguage[extension] = requiredString(serverId, `extensionToLanguage.${extension}`, languageId)
  }
  if (Object.keys(extensionToLanguage).length === 0) {
    throw new Error(`lsp: servers.${serverId}.extensionToLanguage must map at least one extension`)
  }
  return {
    command,
    extensionToLanguage,
    args: stringList(serverId, 'args', config.args ?? []),
    env: stringRecord(serverId, 'env', config.env ?? {}),
    initializationOptions: config.initializationOptions ?? null,
    configuration: config.configuration ?? null,
    maxMessageBytes: positiveInteger(serverId, 'maxMessageBytes', config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
    maxStderrBytes: positiveInteger(serverId, 'maxStderrBytes', config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES),
    maxDocumentBytes: positiveInteger(serverId, 'maxDocumentBytes', config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES),
    shutdownTimeoutMs: timerBudget(serverId, 'shutdownTimeoutMs', config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS),
    killGraceMs: timerBudget(serverId, 'killGraceMs', config.killGraceMs ?? DEFAULT_KILL_GRACE_MS),
  }
}

function requiredString(serverId: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`lsp: servers.${serverId}.${field} must be a non-empty string`)
  }
  return value
}

function positiveInteger(serverId: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`lsp: servers.${serverId}.${field} must be a positive integer`)
  }
  return value
}

function timerBudget(serverId: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`lsp: servers.${serverId}.${field} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}

function stringList(serverId: string, field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`lsp: servers.${serverId}.${field} must be an array of strings`)
  }
  return value as string[]
}

function stringRecord(serverId: string, field: string, value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`lsp: servers.${serverId}.${field} must be an object of strings`)
  }
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`lsp: servers.${serverId}.${field}.${key} must be a string`)
    }
    record[key] = entry
  }
  return record
}

/**
 * Resolve a configured command to an executable that exists.
 *
 * PATH is searched here rather than left to the spawn, so a name that does not exist fails at load
 * with the name in the message instead of surfacing later as a spawn error on somebody's first
 * question. Windows also tries each `PATHEXT` suffix, which is how a language server installed as an
 * npm shim is found at all.
 * @param command - the configured command.
 * @param env - the environment the server will run with; its PATH and PATHEXT are the ones searched.
 * @returns the path to an executable file.
 * @throws Error when nothing matches.
 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string {
  const looksLikePath = isAbsolute(command) || command.includes('/') || command.includes('\\')
  const suffixes = executableSuffixes(command, env)
  if (looksLikePath) {
    const base = resolve(command)
    for (const suffix of suffixes) {
      const candidate = `${base}${suffix}`
      if (isExecutableFile(candidate)) return candidate
    }
    throw new Error(`lsp: the command "${command}" is not an executable file`)
  }
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const suffix of suffixes) {
      const candidate = resolve(directory, `${command}${suffix}`)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  throw new Error(`lsp: the command "${command}" was not found on PATH`)
}

/** The suffixes to try for a command: the name as written, plus `PATHEXT` expansions on Windows. */
function executableSuffixes(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return ['']
  if (/\.[^./\\]+$/.test(command)) return ['']
  const pathext = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  return ['', ...pathext.split(';').filter(suffix => suffix !== '')]
}

/** Whether a candidate is a regular file this process may execute. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    // Windows has no execute bit; there, "exists as a file" is the whole question.
    if (process.platform === 'win32') return true
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    // Not a file, or not one this user may run: either way it is not this candidate.
    return false
  }
}

/** A provider plus the one teardown the plugin owes its servers. */
export interface LocalProvider extends LspProvider {
  /** Dispose every live instance and block further queries. */
  disposeAll(): Promise<void>
}

/**
 * Create the provider for one configured server.
 * @param serverId - the stable provider id reserved on the seam.
 * @param config - the resolved server configuration.
 * @param executable - the resolved executable path.
 * @returns the provider, owning one lazily created process per canonical workspace.
 */
export function createLocalProvider(
  serverId: string,
  config: ResolvedServerConfig,
  executable: string,
): LocalProvider {
  /** One live instance per stable canonical workspace identity. */
  const instances = new Map<string, LspInstance>()
  /** One complete source-read→open→query→close serialization tail per canonical workspace. */
  const queues = new Map<string, Promise<void>>()
  /** Workspace canonicalizations that have not entered a provider-owned queue yet. */
  const workspaceLookups = new Set<Promise<void>>()
  const lifetime = new AbortController()
  let disposed = false

  // Read through a method so a `query()` await cannot narrow the flag to a literal.
  const isDisposed = (): boolean => disposed

  /** Reject work that cannot publish or use a provider-owned instance. */
  const assertActive = (signal?: AbortSignal): void => {
    if (isDisposed()) throw new LspError('the LSP provider is disposed', 'LSP_DISPOSED')
    if (signal?.aborted) throw abortError(signal)
  }

  /** Fuse caller cancellation with provider disposal for every filesystem and protocol await. */
  const querySignal = (signal?: AbortSignal): AbortSignal =>
    signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])

  /** Serialize one complete query lifecycle for a canonical workspace. */
  const enqueue = <T>(workspace: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(workspace) ?? Promise.resolve()
    const result = abortable(previous, signal).then(run)
    // The tail follows the actual prior work even when this caller abandons its wait. It never
    // rejects, so later callers serialize without inheriting an earlier query's outcome.
    const tail = previous.then(() => result).then(() => undefined, () => undefined)
    queues.set(workspace, tail)
    void tail.then(() => {
      if (queues.get(workspace) === tail) queues.delete(workspace)
    })
    return result
  }

  /** Return or synchronously publish the one instance for a canonical workspace. */
  const instanceFor = (workspaceKey: string, workspace: HostWorkspace): LspInstance => {
    assertActive()
    const existing = instances.get(workspaceKey)
    if (existing !== undefined) return existing
    const spec: InstanceSpec = {
      command: executable,
      args: config.args,
      cwd: workspace.canonicalPath,
      workspaceUri: workspace.fileUrl,
      env: config.env,
      configuration: config.configuration,
      initializationOptions: config.initializationOptions,
      maxMessageBytes: config.maxMessageBytes,
      maxStderrBytes: config.maxStderrBytes,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      killGraceMs: config.killGraceMs,
    }
    const created = new LspInstance(spec)
    instances.set(workspaceKey, created)
    return created
  }

  /** Drop the slot only if it still contains this instance. */
  const evictIfCurrent = (workspaceKey: string, instance: LspInstance): void => {
    if (instances.get(workspaceKey) === instance) instances.delete(workspaceKey)
  }

  return {
    id: LspProviderId(serverId),
    extensionToLanguage: config.extensionToLanguage,

    async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
      // Honor an already-aborted signal before any I/O, so a canceled request never starts a server.
      assertActive(signal)
      const active = querySignal(signal)
      const workspaceResult = canonicalizeWorkspace(request.workspaceRoot, active)
      const workspaceLookup = workspaceResult.then(() => undefined, () => undefined)
      workspaceLookups.add(workspaceLookup)
      let workspace: HostWorkspace
      try {
        workspace = await workspaceResult
      } finally {
        workspaceLookups.delete(workspaceLookup)
      }
      assertActive(active)
      const workspaceKey = workspace.targetKey
      return enqueue(workspaceKey, active, async () => {
        assertActive(active)
        // Read inside the queue but before spawning: a queued query sees the current bytes when its
        // turn starts, while an invalid source still cannot leave an idle process pooled.
        const source = await readHostSource(request.filePath, workspace, config.maxDocumentBytes, active)
        // Disposal may have snapshotted the instance map while the read was pending. Re-check before a
        // synchronous get-or-create, so every spawned process remains owned by teardown.
        assertActive(active)
        let instance = instanceFor(workspaceKey, workspace)
        try {
          return await instance.query(request, source, active)
        } catch (error) {
          // A pooled child can have died while idle, or fail during the next write. Queries are
          // read-only, so replace that transport once and retry transparently.
          if (!instance.isTransportFailure(error)) throw error
          await instance.dispose()
          evictIfCurrent(workspaceKey, instance)
          assertActive(active)
          instance = instanceFor(workspaceKey, workspace)
          return await instance.query(request, source, active)
        } finally {
          // Reach quiescence before dropping a dead slot; a replacement must survive this check.
          if (instance.dead) {
            await instance.dispose()
            evictIfCurrent(workspaceKey, instance)
          }
        }
      })
    },

    async disposeAll(): Promise<void> {
      disposed = true
      lifetime.abort(new LspError('the LSP provider is disposed', 'LSP_DISPOSED'))
      const live = [...instances.values()]
      const draining = [...queues.values()]
      const resolving = [...workspaceLookups]
      instances.clear()
      const results = await Promise.allSettled([
        ...live.map(instance => instance.dispose()),
        ...draining,
        ...resolving,
      ])
      queues.clear()
      workspaceLookups.clear()
      throwTeardownFailures(results, 'LSP instance teardown failed')
    },
  }
}

/** Propagate teardown failures only after every sibling has settled. */
function throwTeardownFailures(results: readonly PromiseSettledResult<void>[], message: string): void {
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}
