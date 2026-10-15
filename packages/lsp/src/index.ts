/**
 * @zhangcun123/lsp — the plugin.
 *
 * A capability in this platform's sense: one plugin that gives an agent an ability. Here the ability
 * is answering "where is this defined" from a real language server rather than from a text match,
 * and the plugin carries the three parts that make it true — the seam, the stdio backend, and the
 * model-facing tool.
 *
 * The wiring is deliberately flat: resolve every configured server, register every provider, then
 * register the tool. Nothing is published before everything has been checked, so a table whose
 * second entry is wrong does not leave the first one routable.
 *
 * `@module @zhangchun123/lsp`
 */

import { basename } from 'node:path'

import { createLspRegistry } from './seam.ts'
import type { LspService } from './seam.ts'
import { launchEnvironment } from './connection.ts'
import { createLocalProvider, resolveExecutable, resolveServerConfig } from './provider.ts'
import type { LocalProvider, LspServerConfig } from './provider.ts'
import { registerLspTool } from './tool.ts'
import type { LspToolConfig, LspToolContext } from './tool.ts'

export { LspError, LspProviderId, createLspRegistry, finalExtension } from './seam.ts'
export type {
  LspErrorCode,
  LspHover,
  LspLocation,
  LspOperation,
  LspPosition,
  LspProvider,
  LspProviderQuery,
  LspQueryRequest,
  LspQueryResult,
  LspRange,
  LspService,
} from './seam.ts'
export { DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS, LSP_OPERATIONS } from './render.ts'
export type { LspServerConfig } from './provider.ts'
export {
  DEFAULT_LSP_TOOL_TIMEOUT_MS,
  LSP_PROMPT_ORDER,
  LSP_PROMPT_SECTION,
  LSP_PROMPT_TEXT,
  sessionCwd,
} from './tool.ts'
export type { LspToolArgs, LspToolInput } from './render.ts'
export type { LspToolExecution, RegisterableTool } from './tool.ts'

/** Plugin name, as the runtime's loader sees it. */
export const name = 'deepwork-lsp'

/**
 * Declared so the loader holds this plugin until both surfaces exist: a tool registered before the
 * tool registry is up has nowhere to land, and the prompt section needs the prompt registry.
 */
export const inject = ['tools', 'systemPrompt']

/** The service name a second language-server backend can register against. */
export const LSP_SERVICE = 'lsp'

/** Plugin configuration, taken from the composition that mounts this plugin. */
export interface Config extends LspToolConfig {
  /**
   * Language servers, one entry per server, keyed by the provider id reserved on the seam.
   *
   * Empty means no language server is configured, and the plugin registers no tool at all rather
   * than one whose every call fails: an unconfigured deployment should read as unconfigured.
   */
  servers?: Record<string, LspServerConfig>
}

/** The declaration channel, as the governance plugin publishes it. */
export interface GovernanceSurface {
  declareTool(
    name: string,
    access: { writes?: readonly string[]; executes?: readonly string[]; commands?: readonly string[] },
  ): () => void
}

/** The name both packages state rather than import. */
const GOVERNANCE_SERVICE = 'deepworkGovernance'

/** The slice of the runtime this plugin uses. Structural, and so host-free. */
export interface LspContext extends LspToolContext {
  logger?: {
    warn(message: string): void
    info?(message: string): void
  }
  /**
   * Run `callback` once a context carrying the named services exists, or never if it never does.
   *
   * Optional, and used for one thing: telling the governance layer what this tool touches, so the
   * guard can judge it. A profile with no governance plugin simply has no guard to tell, and the
   * tool must work anyway — which is why this is a lookup rather than a module-level `inject`
   * entry: naming the service there would hold this plugin hostage to it existing.
   */
  inject?<Service>(names: readonly string[], callback: (scoped: Service) => void): void
  /**
   * Publish a value under a name other plugins can look up.
   *
   * Optional, and used for one thing: making the seam reachable as `ctx.lsp`, so a backend written
   * as its own plugin can register against the same interface this package's own provider uses.
   * A host without it still gets a working `lsp` tool.
   * @param serviceName - the name to publish under.
   * @param value - the service value.
   * @returns the exact disposer that withdraws it.
   */
  provide?(serviceName: string, value: unknown): () => void
  /**
   * Tie a teardown to this plugin's lifetime. The server processes are the reason it is needed: a
   * language server outlives an unloaded plugin unless something owns it, and nothing else does.
   * @param callback - returns the disposer to run on unload.
   * @param label - the contribution being tied, for diagnostics.
   */
  effect?(callback: () => () => void | Promise<void>, label?: string): unknown
}

/** Report a problem on whichever channel is available. */
function warn(ctx: LspContext, message: string): void {
  if (ctx.logger?.warn !== undefined) ctx.logger.warn(message)
  else process.stderr.write(`[${name}] ${message}\n`)
}

/**
 * Register the configured language servers and the `lsp` tool.
 *
 * Throws for a server entry that cannot be resolved or validated: a deployment that wrote a command
 * meant it, and a plugin that came up with the server missing would answer every navigation question
 * with a failure instead of saying so at load.
 */
export function apply(ctx: LspContext, config: Config = {}): void {
  const servers = config.servers ?? {}
  const entries = Object.entries(servers)
  if (entries.length === 0) {
    warn(ctx, 'no language server configured; no lsp tool registered')
    return
  }

  // Every server is resolved before any provider is registered, so a bad later entry cannot leave an
  // earlier one routable.
  const providers: LocalProvider[] = []
  // The programs this deployment has configured the tool to start, deduplicated: two servers may
  // name the same executable, and the guard asks which programs may run, not how many times.
  const programs = new Set<string>()
  for (const [serverId, serverConfig] of entries) {
    if (serverId.trim() === '') throw new Error('lsp: server ids must be non-empty strings')
    const resolved = resolveServerConfig(serverId, serverConfig)
    // Resolved against the environment the server will actually run in, so a configured PATH entry
    // finds the command it names.
    const executable = resolveExecutable(resolved.command, launchEnvironment(resolved.env))
    providers.push(createLocalProvider(serverId, resolved, executable))
    // The basename of the command as written, which is the name a grant can be keyed by whichever
    // way `resolveExecutable` reads it — as a path, or as a name searched on PATH.
    programs.add(basename(resolved.command))
  }

  const registry: LspService = createLspRegistry()
  const disposers: Array<() => void> = []
  try {
    for (const provider of providers) disposers.push(registry.registerProvider(provider))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  // Published only once every route is live. A service whose every query answers "no provider
  // handles this" is worse than no service at all, and a load that failed halfway must not leave one
  // behind for the next plugin to find.
  const withdraw = ctx.provide?.(LSP_SERVICE, registry)
  if (withdraw === undefined) {
    warn(
      ctx,
      'the runtime exposes no service publication, so the seam is not reachable as ctx.lsp; ' +
        'the lsp tool works, and a separate language-server backend cannot register with it',
    )
  }

  registerLspTool(ctx, registry, config)

  if (ctx.effect === undefined) {
    warn(
      ctx,
      'the runtime exposes no effect hook, so the configured language servers are not tied to this ' +
        'plugin\'s lifetime and will outlive it',
    )
    return
  }
  ctx.effect(() => () => {
    // Withdraw every route before process teardown, so no new query can enter a draining provider.
    for (const dispose of [...disposers].reverse()) dispose()
    withdraw?.()
    return Promise.allSettled(providers.map(provider => provider.disposeAll())).then((results) => {
      const failures: unknown[] = []
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'lsp provider teardown failed')
    })
  }, 'lsp.registerProviders')

  ctx.logger?.info?.(`lsp: ${providers.length} language server(s): ${entries.map(([id]) => id).join(', ')}`)

  // What this tool runs, told to the plugin that judges it.
  //
  // It spawns the configured language servers and reads the file it is asked about, and neither is
  // visible to the guard without this — a tool the guard has never heard of is a tool it lets
  // through, silently. The port shipped without it, which is the same hole the first capability had.
  //
  // `executes` names the programs, not an argument: which server runs is decided by this
  // deployment's `servers` table, so that is what a grant has to name. A grant under the tool's
  // name alone would say "this role may call lsp" and stay silent on which program starts — and a
  // config edit would change the program with nobody reviewing it. With no server configured the
  // tool is not registered at all, so there is no declaration to make.
  const governance = ctx.inject
  if (governance === undefined) {
    ctx.logger?.warn?.(
      'lsp: the runtime exposes no service lookup, so this tool cannot declare what it runs ' +
        'and is not governed by the write guard',
    )
  } else {
    governance([GOVERNANCE_SERVICE], (scoped: Record<string, GovernanceSurface>) => {
      scoped[GOVERNANCE_SERVICE]?.declareTool('lsp', { executes: [...programs] })
    })
  }
}
