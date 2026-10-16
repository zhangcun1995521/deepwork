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

import { reach, type CredentialSurface, type ReachResult } from './reach.ts'
import type { RouteShape } from './route.ts'

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
  route?: Partial<RouteShape>
  /** Seconds before the connector is killed, tree and all. */
  timeoutSeconds?: number
  /** Where attempts are recorded. Empty defaults to `.audit.jsonl` beside the domain. */
  auditLog?: string
}

/** A registered tool, in the shape the runtime's registry accepts. */
export interface RegisteredTool {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
  execute: (args: never, exec: { agentId?: string }) => Promise<unknown>
}

/** The slice of the runtime context this plugin uses. Structural, and so host-free. */
export interface ExternalContext {
  tools: { register(tool: RegisteredTool): void }
  logger?: { warn(message: string): void }
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
  get?(name: string): unknown
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

/** The name both packages state rather than import. */
const GOVERNANCE_SERVICE = 'deepworkGovernance'

/** The tool's name, which is also the name a domain may narrow in its `tool_grants`. */
const TOOL_NAME = 'reach_system'

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
  return ctx.get?.('credentials') as CredentialSurface | undefined
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
    async execute(args: { route_id?: string }): Promise<unknown> {
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
}
