/**
 * Reaching the systems a deployment does not own.
 *
 * A domain can describe the enterprise outside it — the systems, the routes, the authentication, the
 * pitfalls somebody paid for — and it cannot make a single call. That was written down as a boundary
 * twice over: the ontology's `examples/outside-systems` README says the tool its `tool_grants` name
 * is deliberately not in that repository, and the grants sit there (`reach: [engineer]`, and
 * `reach_system` as a narrowing) waiting for whoever declares it. This package is that tool. One
 * tool, because reaching a system well is one act — find the route, respect what the domain says
 * about it, resolve the credential, run the deployment's connector, and write the attempt down.
 *
 * Three properties are the whole point of it being a capability rather than a shell.
 *
 * **The caller chooses nothing but *which* route.** Not the program, not the address, not the
 * credential. Each of those comes from the deployment's own configuration or from the domain, which
 * is why `route_id` is the only argument: a tool that took a URL is a tool a model can point
 * anywhere, and the grant it holds would authorise reaching whatever it liked.
 *
 * **The declarations that a read respects are respected here too.** A route in another state than
 * the type's `default_state` is refused, exactly as a read hides it. An address a shell would read as
 * more than an address is refused rather than substituted. A credential that is not stored is a
 * refusal, not an empty environment variable handed to a connector that will fail in its own words.
 *
 * **What it runs, it declares.** Through the governance channel the ontology plugin publishes, this
 * tool states the program its configured command starts, so the domain's grant is keyed by the thing
 * that actually executes — `node` here, `reach` for a deployment whose connector is its own binary —
 * and a config edit that changed the program would need a grant nobody wrote.
 *
 * What this plugin deliberately does not do: **it does not write the ontology.** A reach is an
 * observation, and recording it is the domain's business — `examples/outside-systems` declares a
 * `RouteCheck` written by a `verifier`, and confirming a route needs a check from somebody other than
 * the person making the move. A connector that wrote its own check would be walking the route,
 * certifying it and closing the loop by itself, which is the control that domain exists to
 * demonstrate. So this returns facts and hands them back.
 *
 * @module @zhangcun123/external
 */

import { basename, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { connectorSnapshot } from './connectors.ts'
import { panelReach } from './panel.ts'
import { reach, type CredentialSurface, type ReachResult } from './reach.ts'
import type { RouteShape, RouteTarget } from './route.ts'

/** Plugin name, as the runtime's loader sees it. */
export const name = 'deepwork-external'

/** Declared so the loader holds this plugin until the tool registry exists. */
export const inject = ['tools']

/** Plugin configuration, taken from the composition that mounts this plugin. */
export interface Config {
  /** Domain root to read routes from. Empty means no tool is registered, and the plugin says so. */
  ontologyRoot?: string
  /**
   * The program a connector starts, with `{url}` where the address goes.
   *
   * Empty means this deployment has not said how it reaches anything, and then the tool is not
   * registered at all: an unconfigured deployment has to read as unconfigured rather than as a tool
   * whose every call fails for a reason the model will keep retrying.
   */
  command?: string
  /**
   * Which of the domain's own names mean what.
   *
   * Left empty by default on purpose. A route type and two field names are the customer's
   * vocabulary, and guessing `AccessRoute` here would make this package work against the example
   * domain and quietly mis-read a deployment that called its routes `Endpoint`.
   */
  route?: Partial<RouteShape> & {
    /**
     * Field holding the name of what a route reaches, for the connector view only.
     *
     * Optional and separate from {@link RouteShape}, which is the three names *reaching* needs: this
     * one is read by nothing on the call path, and a domain that points at its target by relation needs
     * to configure nothing here. Two real domains point in the two different ways, which is why both
     * are supported rather than one being declared correct.
     */
    target?: string
  }
  /** Seconds before the connector is killed, tree and all. */
  timeoutSeconds?: number
  /**
   * Whether a call must be approved before it is dialled. Asking is the default.
   *
   * The default is written in code rather than left to the deployment, because the two ways of being
   * wrong are not symmetrical: a deployment that wanted to be asked and was not has an agent reaching
   * systems unattended, while one that did not want to be asked and was has a prompt to answer. A
   * deployment that means to let an agent dial unwatched has to say `false`, and this file is where
   * that shows up in review.
   */
  requireApproval?: boolean
  /** Where attempts are recorded. Empty defaults to `.audit.jsonl` beside the domain. */
  auditLog?: string
}

/** A registered tool, in the shape the runtime's registry accepts. */
export interface RegisteredTool {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
  execute: (args: never, exec: ExecutionContext) => Promise<unknown>
}

/**
 * What a tool's `execute` is handed.
 *
 * Structural, like every other seam here. `agent` is the live agent on whose behalf the call runs,
 * set by the host's agent loop — one per session, and the identity the approval gate keys on. There
 * is deliberately no `agentId`: the host sets no such field, and a gate that keyed on one would ask
 * again on every call while looking like it remembered.
 */
export interface ExecutionContext {
  agent?: { id?: string }
  /**
   * The tool call this execution belongs to, when the host names one.
   *
   * Passed straight on to the approval question: it is what makes `approval/asked` and
   * `approval/decided` in the session log correlate with the call the interface rendered.
   */
  callId?: string
  /** The host's own cancellation signal, passed on to the approval question. */
  signal?: unknown
}

/** The slice of the runtime context this plugin uses. Structural, and so host-free. */
export interface ExternalContext {
  tools: { register(tool: RegisteredTool): void }
  logger?: { warn(message: string): void; info?(message: string): void }
  /**
   * The runtime's own service lookup.
   *
   * Used for the one thing this plugin cannot survive without: the host's credential seam. A
   * context *property* read is the obvious way to reach it and is wrong — cordis refuses a property
   * read on a service the plugin has not declared, with `cannot get property "credentials" without
   * inject`, which takes the whole row down at load and the tool with it. `get` asks the same
   * question without the declaration, which is what an opportunistic consumer wants: this plugin is
   * useful in a composition with no seam at all and has to load in one.
   */
  get?<Service>(name: string): Service | undefined
  /**
   * Look up a service by name once a context carrying it exists.
   *
   * Used for one thing: telling the governance plugin which program this tool runs. Optional and
   * looked up by name rather than imported, because a capability has to load with no governance
   * plugin at all — and then it is simply a tool nobody is judging, which this plugin says out loud
   * rather than leaving to be discovered.
   */
  inject?<Service>(names: readonly string[], callback: (scoped: Service) => void): void
}

/** The declaration channel, as the governance plugin publishes it. */
export interface GovernanceSurface {
  declareTool(
    name: string,
    access: { writes?: readonly string[]; executes?: readonly string[]; commands?: readonly string[] },
  ): () => void
}

/**
 * The vocabulary the host's approval service answers in.
 *
 * Copied from `@deepseek-ai/dsh-user-approval`'s types rather than imported, like every other seam
 * here: a closed set of four, and `allowed-once` is the only one that grants anything.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The slice of the host's approval service this plugin uses.
 *
 * `request` answers in the vocabulary above, and the host's contract names the obligation this
 * plugin is built around: **an asker fails closed on `unavailable`.** A connector that dialled when
 * nobody could be asked would dial in exactly the runs nobody is watching.
 */
export interface ApprovalSurface {
  /** Ask for one decision about one tool call. `agent` is opaque here — the service routes it. */
  request(request: {
    agent: unknown
    toolName: string
    /**
     * The tool call being approved, when the host names one.
     *
     * Not decoration: the host writes `approval/asked` and `approval/decided` into the session log,
     * and this id is what ties that pair to the call the interface already rendered. Without it the
     * trail records that somebody was asked about something, and cannot say which call the answer
     * was about — in a package whose product claim is a governance trail, that is the difference
     * between an audit and a diary.
     */
    callId?: string
    reason?: string
    signal?: unknown
  }): Promise<ApprovalOutcome>
}

/**
 * What a caller is told for each ending that is not the one-shot grant.
 *
 * Three endings are three different problems, and the model's next move differs for each, so they
 * must not read the same: a refusal is a decision not to repeat the call unchanged, a withdrawn
 * question can simply be asked again, and an environment with no answerer never had anyone to ask.
 */
const REFUSAL_DETAIL: Record<Exclude<ApprovalOutcome, 'allowed-once'>, string> = {
  // Deliberately not "the user said no": the host answers `rejected` both for a person who declined
  // and for a session whose policy never prompts at all, and a message claiming the first would have
  // the model tell a user they refused something they were never shown.
  rejected:
    'The call was refused, so nothing was dialled. Do not repeat it unchanged — say which route you ' +
    'were about to dial and why, and ask the user how they want to proceed.',
  cancelled:
    'The question was withdrawn before it was answered, so nothing was dialled. Ask again if the ' +
    'route still needs reaching.',
  unavailable:
    'Nobody could be asked: this environment has no answerer for an approval question. That is a ' +
    'refusal and not a permission, so the route was not dialled.',
}

/**
 * The web surface a web-carrying profile provides, as this plugin uses it.
 *
 * Structural, like every other seam here: the route registration is the host's, and this package has
 * to load in a composition that has no web server at all.
 */
export interface WebSurface {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    }): () => void
  }
  effect(callback: () => (() => void) | void, label: string): void
}

/** Where the connector view is served. */
export const CONNECTORS_ROUTE = '/connectors'

/** The largest request body this page will read. A route id is a few dozen bytes. */
const MAX_BODY_BYTES = 8 * 1024

/**
 * Read a JSON object body, with a cap.
 *
 * A cap rather than trust, because this is a network handler: an unbounded `data` accumulator lets a
 * caller grow this process's memory with one request, and the endpoint's whole input is one string.
 * The content type is not negotiated — a body that parses as the shape below is the shape, and one
 * that does not is a 400 naming that.
 */
async function readJsonBody(
  request: IncomingMessage,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: number; code: string; error: string }
> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        return {
          ok: false,
          status: 413,
          code: 'body-too-large',
          error: `the request body exceeds ${MAX_BODY_BYTES} bytes; the only field is route_id`,
        }
      }
      chunks.push(buffer)
    }
  } catch (error) {
    return {
      ok: false,
      status: 400,
      code: 'body-unreadable',
      error: `the request body could not be read (${error instanceof Error ? error.message : String(error)})`,
    }
  }

  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) {
    return { ok: false, status: 400, code: 'body-empty', error: 'a JSON body with route_id is required' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      status: 400,
      code: 'body-not-json',
      error: `the request body is not JSON (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, code: 'body-not-object', error: 'the body must be a JSON object' }
  }
  return { ok: true, value: parsed }
}

/** The name both packages state rather than import. */
const GOVERNANCE_SERVICE = 'deepworkGovernance'

/** The tool's name, which is also the name a domain may narrow in its `tool_grants`. */
const TOOL_NAME = 'reach_system'

/** The approval service's name in the runtime's registry, stated rather than imported. */
const APPROVAL_SERVICE = 'approval'

/**
 * The program a configured command starts: its first word's basename.
 *
 * The command is run through a shell, and the first word is what that shell execs on this tool's
 * behalf — everything after it is that program's arguments, the `{url}` slot included. That is the
 * thing whose authority the guard judges, so it is the thing declared. A command line that chained a
 * second program through `&&` or a pipe would start more than this names; the declaration covers the
 * program this tool chose to run, not the whole shell grammar.
 */
function programOf(command: string): string {
  return basename(command.trim().split(/\s+/)[0] ?? '')
}

/**
 * The host's credential seam, read the way a capability is allowed to read a service.
 *
 * Through the runtime's lookup rather than as a context property, which is the difference between a
 * tool that loads and one that does not: cordis answers a property read on an undeclared service
 * with `cannot get property "credentials" without inject`, thrown from `apply` — so the row fails,
 * the tool is never registered, and the composition reports it as one entry that did not activate.
 * The unit tests did not catch that because their context was a plain object, where the property was
 * simply there; the fixture that stands in for the runtime now throws on that read too.
 *
 * Read again on every call rather than captured once, because the seam's own contract is that a
 * consumer resolves per operation: a provider mounted after this plugin, or a credential rotated
 * underneath it, has to reach the next call.
 *
 * @param ctx - The runtime context, as this plugin sees it.
 * @returns The seam, or `undefined` in a composition that mounts none.
 */
function seamOf(ctx: ExternalContext): CredentialSurface | undefined {
  return ctx.get?.<CredentialSurface>('credentials')
}

/**
 * The canonical shape of a result.
 *
 * Every field the value carries is declared, because the runtime validates the value against this
 * before the model sees it, and an undeclared field is a call that fails after the far side was
 * already reached. `required` lists what is always there: `system` is absent when the domain declares
 * no relation out of the route type, and `output` when the program printed nothing.
 *
 * `exitCode` is a `oneOf` rather than a type array because the runtime's schema subset does not
 * support type arrays, and `null` is a real answer here — the deadline kills a connector that never
 * returns, and reporting that as `-1` or `255` would be this package inventing an exit status.
 */
const REACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    route: { type: 'string', description: 'Route the call named.' },
    system: { type: 'string', description: 'The object the route reaches, when the domain names one.' },
    url: { type: 'string', description: 'Address the connector was given.' },
    program: { type: 'string', description: 'Program the deployment configured.' },
    exitCode: {
      description: 'Exit status of the program, or null when the deadline killed it before it had one.',
      oneOf: [{ type: 'integer' }, { type: 'null' }],
    },
    reachable: { type: 'boolean', description: 'True when the program exited 0, and nothing more.' },
    elapsedMs: { type: 'integer', description: 'How long the program ran, in milliseconds.' },
    output: { type: 'string', description: 'What the program printed: stdout, plus stderr when it printed any.' },
  },
  required: ['route', 'url', 'program', 'exitCode', 'reachable', 'elapsedMs'],
} as const

/** The result as lines, in the order a reader wants them. */
function describe(result: ReachResult): string {
  const lines: string[] = [`route     ${result.route}`]
  if (result.system !== undefined) lines.push(`system    ${result.system}`)
  lines.push(`url       ${result.url}`)
  lines.push(`program   ${result.program}`)
  lines.push(
    result.exitCode === null
      ? `exit      none — the program ended without a status (${result.elapsedMs}ms)`
      : `exit      ${result.exitCode} after ${result.elapsedMs}ms`,
  )
  lines.push(`reachable ${result.reachable ? 'yes' : 'no'}`)
  if (result.output !== undefined) lines.push('', 'output', result.output.trimEnd())
  return lines.join('\n')
}

/**
 * Register the capability's tool.
 *
 * @param ctx - The runtime context.
 * @param config - The domain, the command, the domain's own field names, and the limits.
 */
export function apply(ctx: ExternalContext, config: Config = {}): void {
  const warn = (message: string): void => ctx.logger?.warn(message)
  const command = config.command ?? ''
  const ontologyRoot = config.ontologyRoot ?? ''
  const shape: RouteShape = {
    type: config.route?.type ?? '',
    url: config.route?.url ?? '',
    auth_ref: config.route?.auth_ref ?? '',
  }
  const timeoutSeconds = config.timeoutSeconds ?? 30
  const requireApproval = config.requireApproval ?? true
  const auditLog =
    config.auditLog === undefined || config.auditLog.length === 0
      ? join(ontologyRoot, '.audit.jsonl')
      : config.auditLog

  if (command.length === 0) {
    // Nothing to run, so nothing to offer. Said out loud rather than registering a tool that would
    // fail on its first call — a deployment that has not said how it reaches anything must not
    // appear to have a way of reaching something.
    warn(
      'external: no command configured, so this deployment has not said how it reaches anything; ' +
        'no tool is registered. Set the command to the program a connector starts, with {url} where ' +
        'the address goes',
    )
    return
  }
  if (ontologyRoot.length === 0) {
    warn(
      'external: no ontologyRoot configured, so there is no domain to read a route out of; no tool ' +
        'is registered',
    )
    return
  }
  const unnamed = (['type', 'url', 'auth_ref'] as const).filter((key) => shape[key].length === 0)
  if (unnamed.length > 0) {
    warn(
      `external: the domain's own names are incomplete — ${unnamed.join(', ')} ` +
        `${unnamed.length === 1 ? 'is' : 'are'} not configured, so no route can be read; no tool is ` +
        'registered. Set route.type to the object type a route is, route.url to the field holding ' +
        'the address, and route.auth_ref to the field holding the credential reference name',
    )
    return
  }
  if (!command.includes('{url}')) {
    warn(
      'external: the command has no {url} slot, so the address the route names never reaches the ' +
        'program; the tool still works, every call reaching whatever the program reaches on its own',
    )
  }
  if (seamOf(ctx) === undefined) {
    warn(
      'external: no credential service is mounted, so every call will be refused — a route files ' +
        'its credential in the host\'s seam, and there is no seam here to file one in',
    )
  }

  const program = programOf(command)

  /**
   * What one agent already holds an open grant for, keyed by who and which route.
   *
   * Keyed by both, which is the one place this gate differs from the host's desktop gate: there, the
   * unit of approval is the capability — four acts by one agent are one question, because "may this
   * agent use the desktop" is a single standing permission. Here the unit is the *route*: each system
   * is a separate authority, and a person who approved a health check on a development box has not
   * approved a tap on the payroll system. The host's own words for the approval seam are "grants
   * apply only to the requested action", and the action a caller requests is one route.
   *
   * The key is the agent's *id* when the host gave one and the agent object otherwise, never the
   * object alone while an id exists: the host hands over a live agent whose identity is its session,
   * and a gate keyed on object identity would ask again on every call while looking like it
   * remembered.
   */
  const open = new Set<string>()
  const keyOf = (exec: ExecutionContext): string | undefined => {
    const who = exec.agent
    if (who === undefined) return undefined
    const id = (who as { id?: unknown }).id
    return typeof id === 'string' && id.length > 0 ? id : String(who)
  }

  /**
   * Ask before dialling, and hand back what the caller reads when the call must not happen.
   * `undefined` means it may go ahead.
   *
   * The service is looked up here, per call, rather than during `apply`: a plugin that resolved it at
   * mount time would hold a service that was not there yet, and a deployment may mount one later.
   * Every ending that is not the one-shot grant refuses — including a service that threw — and the
   * refusal is text rather than an exception, because the model has to read it and tell the user.
   *
   * An unnamed agent is never remembered: a call that arrives with no agent at all cannot be
   * attributed to anyone, so it asks every time rather than opening a grant nobody owns.
   */
  const approveRoute = async (
    route: RouteTarget,
    exec: ExecutionContext,
  ): Promise<{ reason: string; text: string } | undefined> => {
    if (!requireApproval) return undefined
    const who = keyOf(exec)
    const key = who === undefined ? undefined : `${who}\u0000${route.id}`
    if (key !== undefined && open.has(key)) return undefined

    const approval = ctx.get?.<ApprovalSurface>(APPROVAL_SERVICE)
    if (approval === undefined) {
      return {
        reason: 'no-approval-service',
        text:
          `Refused (no-approval-service): this runtime has nothing mounted that can ask, and a route ` +
          `nobody can approve is not one this connector dials. Route "${route.id}" was not reached.`,
      }
    }

    // The question the person answers, and the only place the scope is stated. It names the route,
    // the system behind it when the domain declares one, and the address about to be dialled, so the
    // answer is a decision about something rather than about a tool name.
    const reaches = route.system === undefined ? '' : ` (${route.system})`
    let outcome: ApprovalOutcome
    try {
      outcome = await approval.request({
        agent: exec.agent,
        toolName: TOOL_NAME,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
        reason:
          `Allow this agent to dial route "${route.id}"${reaches} at ${route.url}. This session may ` +
          `dial that route without asking again; every other route asks separately.`,
        signal: exec.signal,
      })
    } catch (error) {
      // Throwing is not the same as refusing: the host throws when the question has nowhere to go,
      // which is a reason not to dial rather than a fault in the dialling.
      return {
        reason: 'ask-failed',
        text:
          `Refused (ask-failed): the approval question could not be asked — ` +
          `${error instanceof Error ? error.message : String(error)}. Route "${route.id}" was not reached.`,
      }
    }

    if (outcome === 'allowed-once') {
      if (key !== undefined) open.add(key)
      // Where an operator can find it; the question and its answer are appended to the session by the
      // host, so "when was this opened, and for what" is answered by the record.
      ctx.logger?.info?.(`external: route "${route.id}" approved for this session`)
      return undefined
    }
    return {
      reason: outcome,
      text: `Refused (${outcome}): ${REFUSAL_DETAIL[outcome]} Route "${route.id}" was not reached.`,
    }
  }

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Reach an outside system by dialling a route this deployment\'s domain declares, and report ' +
      'what the connector it started did. The caller names a route id and nothing else: which ' +
      'program runs, which address it dials and which credential it uses are all deployment ' +
      'configuration, chosen before the call. The exit status is reported, not interpreted — ' +
      'reachable means the program exited 0, which is the program\'s claim about a system this ' +
      'tool has not looked at, and a status of 0 is not a fact about the far side. The connector\'s ' +
      'output is returned as it came, for whoever knows that system to read.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        route_id: {
          type: 'string',
          description:
            'Id of a route in this deployment\'s domain (e.g. RT-001). The route holds the address ' +
            'and names the credential; neither is an argument, so a caller cannot aim this tool at ' +
            'a system the domain does not describe.',
        },
      },
      required: ['route_id'],
    },
    output: {
      schema: REACH_SCHEMA,
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: describe(value as ReachResult) },
      ],
    },
    async execute(args: { route_id?: string }, exec: ExecutionContext): Promise<unknown> {
      const routeId = args.route_id ?? ''
      if (routeId.length === 0) {
        throw new Error(
          'route_id is required: name a route in this deployment\'s domain, and nothing else',
        )
      }
      return reach({
        routeId,
        ontologyRoot,
        shape,
        command,
        program,
        timeoutSeconds,
        auditLog,
        ...(seamOf(ctx) === undefined ? {} : { credentials: seamOf(ctx) as CredentialSurface }),
        ...(requireApproval ? { approve: (route) => approveRoute(route, exec) } : {}),
      })
    },
  })

  // What this tool runs, told to the plugin that judges it — and told rather than known, because
  // that plugin has never heard of `reach_system` and should not have to.
  //
  // `executes` names the program the configured command starts, not an argument: the command is
  // deployment configuration, and which program it starts is exactly what needs a grant. The example
  // domain's `tool_grants` are written for precisely this — an entry under the program's name, which
  // is required, and one under `reach_system`, which only narrows.
  const governance = ctx.inject
  if (governance === undefined) {
    warn(
      'the runtime exposes no service lookup, so reach_system cannot declare what it runs and is ' +
        'not governed by the write guard',
    )
  } else {
    // The callback receives a context carrying the service, not the service itself — the same shape
    // the host's own plugins use (`inner.systemPrompt.section(...)`). Reading it as the value
    // compiled, and then called a method on a context that does not have one.
    governance([GOVERNANCE_SERVICE], (scoped: Record<string, GovernanceSurface>) => {
      scoped[GOVERNANCE_SERVICE]?.declareTool(TOOL_NAME, { executes: [program] })
    })
  }

  // The connector view, served the same lazy way and for the same reason as the domain panel: a
  // profile may have no web server, and everything above has to work identically without one. The
  // absence is said out loud rather than left to be discovered, because the page is how a human
  // finds out that a route nobody granted exists.
  //
  // Registered as an exact path rather than under the domain panel's prefix: these are two views of
  // one deployment, each owned by the package that knows its vocabulary, and neither should be a
  // sub-path of the other's route table.
  if (ctx.inject === undefined) {
    warn(
      'the runtime exposes no service lookup, so the connector view is not served — nothing shows ' +
        'which routes this deployment declares or how the last attempt ended',
    )
  } else {
    ctx.inject<WebSurface>(['webServer'], (scoped) => {
      // The scoped context carries two things, and they are not the same object: `webServer` is the
      // service a route is registered on, `effect` is the context's own tie to this plugin's lifetime.
      // Calling `effect` on the service instead compiles and does nothing — so the first version of
      // this block registered no route at all, and the optional call made that silent. A guard here
      // rather than `?.` is the point: an absence that produces no route must produce a sentence.
      if (typeof scoped.effect !== 'function') {
        warn(
          'this runtime exposes a web server without the effect that ties a route to this plugin, so ' +
            'the connector view is not registered',
        )
        return
      }
      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'prefix',
            path: CONNECTORS_ROUTE,
            handler: (request, response) => {
              // `POST /connectors/reach` is the page's one act; everything under the prefix answers the
              // snapshot. Split by method and path here rather than registering a second route, so the
              // page's data and its button stay one thing to find and one thing to review.
              const path = (request.url ?? '/').split('?')[0] ?? '/'
              if (request.method === 'POST' && path === `${CONNECTORS_ROUTE}/reach`) {
                void serveReach(request, response)
                return
              }
              if (request.method !== 'GET' && request.method !== 'HEAD') {
                response.writeHead(405, {
                  'content-type': 'application/json; charset=utf-8',
                  allow: 'GET, HEAD, POST',
                })
                response.end(JSON.stringify({ code: 'method-not-allowed', error: 'GET or POST' }))
                return
              }
              // Built per request, like the route lookup: a page holding a graph from boot would keep
              // showing a route in the state it was in before somebody confirmed it.
              const snapshot = connectorSnapshot({
                root: ontologyRoot,
                shape,
                target: config.route?.target ?? '',
                program,
                auditLog,
              })
              response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify(snapshot, null, 2))
            },
          }),
        'deepwork-external: connector view',
      )

      /**
       * Answer one page-initiated reach.
       *
       * The body is read with a cap and parsed before anything is dialled; a malformed request is a
       * 400 rather than a call with a defaulted route. No CSRF token is checked and none is needed:
       * the host's session cookie is `SameSite=Strict`, so a cross-site form post arrives without it
       * and is answered by the server's own authentication, not by this handler.
       */
      async function serveReach(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const body = await readJsonBody(request)
        if (!body.ok) {
          response.writeHead(body.status, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ code: body.code, error: body.error }))
          return
        }
        const routeId = typeof (body.value as { route_id?: unknown }).route_id === 'string'
          ? ((body.value as { route_id: string }).route_id)
          : ''
        const answer = await panelReach({
          routeId,
          root: ontologyRoot,
          shape,
          command,
          program,
          timeoutSeconds,
          auditLog,
          ...(seamOf(ctx) === undefined ? {} : { credentials: seamOf(ctx) as CredentialSurface }),
        })
        response.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(answer.body, null, 2))
      }
    })
  }
}
