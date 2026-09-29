/**
 * @deepwork/ontology — the plugin.
 *
 * Loads one domain pack and registers the tool surface that pack declares. Nothing
 * here knows a business concept: it decides what to load, says clearly what it could
 * not load, and stays out of the way.
 *
 * @module @deepwork/ontology
 */

import { join } from 'node:path'

import { loadGraph } from './engine/graph.ts'
import { appendAuditLine, formatAuditLine, type AuditEntry } from './govern/audit.ts'
import type { RoleRule } from './govern/permission.ts'
import { registerOntologyTools, type ToolRegistry } from './tools/register.ts'

/** Plugin name, as the runtime's loader sees it in logs and error messages. */
export const name = 'deepwork-ontology'

/** Declared so the loader holds this plugin until the tool registry exists. */
export const inject = ['tools']

/** Plugin configuration, taken from the composition that mounts this plugin. */
export interface Config {
  /**
   * Directory holding the domain pack: `schema.yaml` plus the instance files it
   * points at. Empty means no domain is configured, and the plugin registers nothing
   * rather than guessing a location.
   */
  ontologyRoot?: string
  /** Maximum entities in one tool result. */
  maxResults?: number
  /**
   * Prefix-to-role map for callers. Empty means the write tool is not registered at
   * all: a deployment that has not said who may write gets no write surface, rather
   * than one that refuses every call.
   */
  roles?: RoleRule[]
  /** Where write attempts are recorded. Defaults to `<ontologyRoot>/.audit.jsonl`. */
  auditLog?: string
}

/** The slice of the runtime context this plugin uses. */
export interface OntologyContext {
  tools: ToolRegistry
  logger?: {
    warn(message: string): void
    info?(message: string): void
  }
}

/** Report a problem on whichever channel is available. */
function warn(ctx: OntologyContext, message: string): void {
  if (ctx.logger?.warn !== undefined) ctx.logger.warn(message)
  else process.stderr.write(`[${name}] ${message}\n`)
}

/**
 * Load the configured domain and register its tools.
 *
 * An unreadable schema throws, and that is deliberate: a plugin pointed at the wrong
 * directory must fail its boot rather than come up looking healthy with no tools.
 * Everything short of that — a malformed declaration, a tool the runtime rejects — is
 * reported and does not stop the rest from loading.
 */
export function apply(ctx: OntologyContext, config: Config = {}): void {
  const ontologyRoot = config.ontologyRoot ?? ''
  if (ontologyRoot.length === 0) {
    warn(ctx, 'no ontologyRoot configured; no ontology tools registered')
    return
  }

  // Throws on an unreadable schema; see the doc comment above.
  const graph = loadGraph(ontologyRoot)

  // Writes are opt-in, and the gate is the role map rather than a separate flag: a
  // deployment that has not said who may write gets no write tool.
  const roles = config.roles ?? []
  const auditLog = config.auditLog ?? join(ontologyRoot, '.audit.jsonl')
  const writes =
    roles.length === 0
      ? undefined
      : {
          roles,
          audit: (entry: AuditEntry): void => appendAuditLine(auditLog, formatAuditLine(entry)),
        }

  const { registered, failed, warnings } = registerOntologyTools(ctx.tools, graph, {
    ...(config.maxResults === undefined ? {} : { maxResults: config.maxResults }),
    ...(writes === undefined ? {} : { writes }),
  })

  const summary =
    `loaded "${graph.root}": ${graph.objects.length} entities, ${graph.links.length} relations, ` +
    `${graph.schema.objectTypes.size} types, ${registered.length} tools registered; ` +
    (writes === undefined
      ? 'writes disabled (no roles configured)'
      : `writes enabled, audited to ${auditLog}`)
  if (ctx.logger?.info !== undefined) ctx.logger.info(summary)
  else process.stderr.write(`[${name}] ${summary}\n`)

  // Loading warnings first: a caller reading a log top-down should meet the domain's
  // problems before the derivation's, because a broken domain explains a lot of them.
  for (const message of [...graph.warnings, ...warnings]) warn(ctx, message)
  for (const message of failed) warn(ctx, `tool not registered — ${message}`)
}
