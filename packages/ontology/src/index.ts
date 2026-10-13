/**
 * @zhangcun123/ontology — the plugin.
 *
 * Loads one domain pack and registers the tool surface that pack declares. Nothing
 * here knows a business concept: it decides what to load, says clearly what it could
 * not load, and stays out of the way.
 *
 * @module @zhangcun123/ontology
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'

import { loadGraph, type OntologyGraph } from './engine/graph.ts'
import {
  appendAuditLine,
  formatAuditLine,
  formatGuardAuditLine,
  type AuditEntry,
} from './govern/audit.ts'
import { writeGuard } from './govern/guard.ts'
import type { RoleRule } from './govern/permission.ts'
import { experienceSkills, type ExperienceSkill } from './skills.ts'
import { registerOntologyTools, type ToolRegistry } from './tools/register.ts'
import { domainSnapshot } from './web.ts'

/** Plugin name, as the runtime's loader sees it in logs and error messages. */
export const name = 'deepwork-ontology'

/** Declared so the loader holds this plugin until the tool registry exists. */
export const inject = ['tools']

/** The route the browser half reads its data from. */
export const DOMAIN_ROUTE = '/deepwork'

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
  /**
   * Run `callback` once a context carrying the named services exists, or never if it
   * never does. Optional, and deliberately so: a headless profile has no web server and a bare
   * one has no skill registry, and this plugin must load its domain and register its tools in
   * both. The caller names the shape it expects, because the host's own service types are not
   * imported here — the package depends on nothing from the host, which is what lets the engine
   * be tested without one.
   */
  inject?<Service>(names: readonly string[], callback: (scoped: Service) => void): void
}

/** The skill registry a profile provides, when it has one. */
export interface SkillSurface {
  skills: {
    /** Contribute one skill. The returned callback releases it. */
    register(skill: ExperienceSkill): () => void
  }
  /** Tie a contribution to this plugin's lifetime, the way the web route is tied. */
  effect?(callback: () => () => void, label?: string): void
}

/** The web surface a web-carrying profile provides. */
export interface WebSurface {
  webServer: {
    /** Register a route; the returned callback releases it. */
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    }): () => void
  }
  /** Register a disposable side effect. */
  effect(callback: () => (() => void) | void, label: string): void
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

  // The write guard, mounted here rather than inside each tool.
  //
  // A check inside our own tools only covers our own tools: the runtime also ships a
  // filesystem tool and a shell, and neither has read the domain. Mounted globally, this
  // is the one place that sees every call, which is what makes "only this role may write
  // here" a boundary instead of a statement of intent.
  //
  // It is mounted even when no roles are configured — with none, every write is refused,
  // which is what "an unconfigured deployment is a read-only one" has to mean if it is
  // to mean anything.
  //
  // The adapter is explicit because the two shapes are not the same: the runtime hands
  // its own execution object (`agent.id`), and the guard reasons over a flat `agentId`.
  // Passing the guard straight through compiled and then read no identity at all, which
  // turned every write into a refusal for the wrong reason.
  const policy = writeGuard({
    cwd: process.cwd(),
    ontologyRoot: resolve(ontologyRoot),
    roles,
    objectTypes: graph.schema.objectTypes.values(),
    // The trail. Mounted even with writes disabled, because the refusals worth reading
    // are exactly the ones that happen when nobody was allowed to write.
    onDecision: (decision) =>
      appendAuditLine(
        auditLog,
        formatGuardAuditLine({
          at: new Date().toISOString(),
          kind: 'guard',
          tool: decision.tool,
          outcome: decision.denied ? 'denied' : 'allowed',
          ...(decision.agentId === undefined ? {} : { agentId: decision.agentId }),
          ...(decision.role === undefined ? {} : { role: decision.role }),
          ...(decision.target === undefined ? {} : { target: decision.target }),
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          ...(decision.detail === undefined ? {} : { detail: decision.detail }),
        }),
      ),
  })
  const guardMounted = ctx.tools.guard !== undefined
  ctx.tools.guard?.((call) =>
    policy({
      name: call.name,
      arguments: call.arguments,
      ...(call.agent?.id === undefined ? {} : { agentId: call.agent.id }),
    }),
  )

  const summary =
    `loaded "${graph.root}": ${graph.objects.length} entities, ${graph.links.length} relations, ` +
    `${graph.schema.objectTypes.size} types, ${registered.length} tools registered; ` +
    (writes === undefined
      ? 'writes disabled (no roles configured)'
      : `writes enabled, audited to ${auditLog}`) +
    (guardMounted ? '; write guard mounted' : '; write guard NOT mounted')
  if (ctx.logger?.info !== undefined) ctx.logger.info(summary)
  else process.stderr.write(`[${name}] ${summary}\n`)

  if (!guardMounted) {
    warn(
      ctx,
      'the runtime exposes no tool guard, so writes made through tools this plugin did ' +
        'not register (the filesystem tool, the shell) are unchecked',
    )
  }

  // Loading warnings first: a caller reading a log top-down should meet the domain's
  // problems before the derivation's, because a broken domain explains a lot of them.
  for (const message of [...graph.warnings, ...warnings]) warn(ctx, message)
  for (const message of failed) warn(ctx, `tool not registered — ${message}`)

  // The panel's data, served over the same origin as the UI that reads it. Registered
  // lazily and optionally: only web-carrying profiles have a web server, and everything
  // above has to work identically without one.
  ctx.inject?.(['webServer'], (web: WebSurface) => {
    web.effect(
      () =>
        web.webServer.register({
          kind: 'prefix',
          path: DOMAIN_ROUTE,
          handler: (request, response) => serveSnapshot(graph, roles, config, request, response),
        }),
      'deepwork-ontology: domain route',
    )
  })

  // The domain's vouched-for experience, offered as skills. Registered the same lazy way and for
  // the same reason: a profile may have no skill registry, and everything above has to work
  // identically without one.
  //
  // Registered at load, which is a real limit worth stating: experience promoted *during* this
  // process is not in the catalog until it restarts. Promotion is the rare event — an agent
  // verifies what it learned, a human signs off — so the alternative, re-registering the whole
  // catalog on every write, would pay for itself only in the case that never happens.
  const { skills, notes: skillNotes } = experienceSkills(graph)
  for (const note of skillNotes) warn(ctx, note)
  if (skills.length > 0) {
    ctx.inject?.(['skills'], (registry: SkillSurface) => {
      registry.effect?.(
        () => {
          const disposers = skills.map((skill) => registry.skills.register(skill))
          return () => {
            for (const dispose of disposers) dispose()
          }
        },
        'deepwork-ontology: experience skills',
      )
    })
  }
}

/**
 * Answer one snapshot request.
 *
 * `roles` may be overridden per request, so the panel can show what a different role map
 * would produce without a deployment change. That is a question a governance model has
 * to be able to answer out loud, and answering it from the running system beats
 * answering it from a document.
 */
function serveSnapshot(
  graph: OntologyGraph,
  deployedRoles: readonly RoleRule[],
  config: Config,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const raw = url.searchParams.get('roles')

  let roles: readonly RoleRule[] = deployedRoles
  if (raw !== null && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('expected an array')
      roles = parsed as RoleRule[]
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      response.end(
        JSON.stringify({
          error: `roles must be a JSON array of {prefix, role}: ${error instanceof Error ? error.message : String(error)}`,
        }),
      )
      return
    }
  }

  const snapshot = domainSnapshot(graph, roles, {
    ...(config.maxResults === undefined ? {} : { maxResults: config.maxResults }),
  })
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(snapshot, null, 2))
}
