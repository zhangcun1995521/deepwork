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
import { GOVERNANCE_SERVICE, createGovernanceRegistry } from './govern/access.ts'
import type { RoleRule } from './govern/permission.ts'
import { parseSituation, renderSection, resolveActive, selectRules } from './inject.ts'
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
  /**
   * The situation this deployment is in, as comma-separated `key:value` tags — `stage:review,
   * artifact:handover`.
   *
   * It decides which of the domain's vouched-for rules are written into the agent's prompt, which
   * is what makes the answer a fact about the world rather than the model's choice. Empty is not
   * "inject nothing": a deployment that has not said where it is gets every rule, because the
   * rules are requirements and being unselective is the safe direction to be wrong in.
   */
  situation?: string
  /**
   * What this session is working on: an object id (`CASE-1042`) or a product id
   * (`DLV-RELEASE_NOTES`).
   *
   * This is the half of the situation a person can see and copy. The tag half above is a
   * vocabulary they have to remember; naming the thing they are working on is not, and the tags
   * follow from it. Naming a product directly is what covers the products with no object behind
   * them — a pytest script never enters the ontology, since the domain stores a pointer rather
   * than a copy.
   */
  active?: string
  /**
   * Ceiling on the injected rules, in characters.
   *
   * A backstop against a domain outgrowing its context, not a target: below it nothing changes, and
   * above it the least specific rules are the ones held back — still loadable by name, just not
   * impossible to miss. Undefined means the composition said nothing, and the section is written
   * whole.
   */
  budget?: number
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
  /**
   * Publish a value under a name other plugins can look up.
   *
   * The other half of {@link inject}, and the reason capabilities can declare what their tools
   * touch without either package importing the other: the name is stated by both sides and the
   * caller is whoever injects it. Optional for the same reason — a host without it still loads,
   * and only the declaration channel is missing, which this plugin reports.
   *
   * @param name - Service name to publish under.
   * @param value - The service value.
   * @returns the exact disposer that withdraws it.
   */
  provide?(name: string, value: unknown): () => void
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

/** The prompt registry a profile provides, when it has one. */
export interface SystemPromptSurface {
  systemPrompt: {
    /**
     * Register one ordered section. A duplicate name in one layer throws, so the name is the
     * plugin's own and namespaced; the host's own sections are named by the host.
     */
    section(section: {
      name: string
      order: number
      text: string
      /** False keeps the text literal, which matters when it comes from domain data. */
      interpolate?: boolean
    }): () => void
    /** The centrally allocated position for a named section. */
    getSectionOrder(name: string): number
  }
  /** Tie the registration to this plugin's lifetime, the way the web route is tied. */
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

  // The declaration channel, published before the guard is mounted so a capability that loads
  // after this one can declare its tools and be judged on the same boot.
  const registry = createGovernanceRegistry()
  registry.setGrants(graph.schema.toolGrants ?? new Map())
  const unpublished = ctx.provide?.(GOVERNANCE_SERVICE, registry) === undefined

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
    govern: (tool) => registry.govern(tool),
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

  if (unpublished) {
    warn(
      ctx,
      'the runtime exposes no way to publish a service, so capabilities cannot declare what ' +
        'their tools touch and only the tools listed in this plugin are governed',
    )
  } else {
    // What the guard can judge, said at boot rather than inferred later. A capability that loads
    // after this line still appears, because the registry is read per call — but only if it
    // declared anything, and a tool nobody declared is the one gap this cannot see.
    const declared = registry.declared()
    const grants = graph.schema.toolGrants
    if (ctx.logger?.info !== undefined) {
      ctx.logger.info(
        `${name}: governance published as "${GOVERNANCE_SERVICE}"; ${declared.length} tool(s) ` +
          `declared so far${declared.length === 0 ? '' : ` (${declared.join(', ')})`}; ` +
          `${
            grants === undefined
              ? 'the domain grants no tool'
              : `${grants.size} tool(s) granted (${[...grants.keys()].join(', ')})`
          }`,
      )
    }
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

  // The same vouched-for experience, this time written into the prompt rather than offered to the
  // model.
  //
  // This is the half the catalog cannot do, and the reason it is worth having both. A catalog is
  // a list of names the model has to remember to consult, and know-how can be trusted to that —
  // it reaches for a procedure when it wants one. A *rule* cannot: one the model may load is one
  // it may miss, and the rules here are the ones a person signed off on.
  //
  // Registered the same lazy, optional way as the web route and the catalog, because a profile
  // may have no prompt registry and nothing above may depend on one existing.
  //
  // The text is a plain string, not a provider, and that is a decision rather than a shortcut: it
  // is built once from the graph already in hand, so what is injected cannot drift from what the
  // read tools return, and a domain file that becomes unreadable mid-session cannot fail prompt
  // assembly. The cost is that a rule promoted during this process waits for the next boot, which
  // is the limit the catalog has too.
  const deliverablesResolved = resolveActive(graph, config.active ?? '')
  if (deliverablesResolved.note !== undefined) {
    warn(ctx, `the session named "${config.active ?? ''}" as what it is working on, but ${deliverablesResolved.note}`)
  }

  const selection = selectRules(
    graph,
    { deliverables: deliverablesResolved.deliverables, tags: parseSituation(config.situation ?? '') },
    config.budget === undefined ? {} : { budget: config.budget },
  )
  for (const tag of selection.unknown) {
    warn(
      ctx,
      `the declared situation tag "${tag}" matches no rule in this domain; it is probably a ` +
        `spelling mistake, and a tag that matches nothing selects nothing`,
    )
  }
  // Registered whenever the domain vouches for anything — including when the situation selected
  // none of it. That case is the one a reader most needs told: an empty selection and a mistyped
  // tag are indistinguishable from inside the rule set, and only one of them is a mistake. A
  // plugin that stayed silent when nothing matched would turn the loudest failure into the
  // quietest.
  if (selection.total > 0) {
    ctx.inject?.(['systemPrompt'], (prompt: SystemPromptSurface) => {
      prompt.effect?.(
        () =>
          prompt.systemPrompt.section({
            name: 'deepwork:experience',
            // Beside the persona and ahead of every tool description: these are requirements on
            // the work, and a reader meets them where it meets who it is.
            order: prompt.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
            // Domain data must not be able to fail prompt assembly, and the registry's
            // `{{variable}}` references are strict — an undefined one throws. A rule that happens
            // to contain a brace pair would otherwise take every turn down with it.
            interpolate: false,
            text: renderSection(selection),
          }),
        'deepwork-ontology: experience injection',
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
