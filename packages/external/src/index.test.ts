/**
 * Integration tests for the capability's own `apply`.
 *
 * These exist because of a failure this repository has already had once: the tool reached the
 * registry, the output schema was something the runtime rejected, `apply` threw, and the bundle
 * loaded as nothing at all — with every unit test green. So the claims here are the ones only
 * `apply` can make: that the tool reaches the registry, that its arguments are the ones the domain's
 * grant narrows, that its access is declared to whatever is judging it, and that a deployment which
 * has not said how to reach anything gets no tool rather than one that fails on every call.
 *
 * Neither the tool registry nor the governance channel is imported from the runtime: both are
 * structural, which is what lets this run with no runtime at all. The two things that ARE imported
 * are its real dependencies — the domain engine that reads the fixture, and the credential seam's
 * vocabulary — because those are what this package would get wrong in a way these tests have to
 * catch.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph } from '@zhangcun123/ontology/engine'

import { apply, CONNECTORS_ROUTE, type ExternalContext } from './index.ts'

/** The fixture domain, read for real: `apply` is handed a root, not a graph. */
const DOMAIN = fileURLToPath(new URL('../tests/fixtures/domain', import.meta.url))

/** The command the suite configures: a program the deployment owns, with the address in a slot. */
const COMMAND = 'node /opt/connectors/reach.mjs {url}'

/** A tool as this suite reads it back off the registry. */
interface Tool {
  name: string
  description: string
  parameters: { properties?: Record<string, unknown>; required?: readonly string[] }
  output: { schema: { properties?: Record<string, unknown>; required?: readonly string[] } }
  execute: (args: { route_id?: string }) => Promise<unknown>
}

interface Harness {
  ctx: ExternalContext
  tools: Tool[]
  declared: { tool: string; access: unknown }[]
  logs: string[]
  /** Routes registered on the web server, when the harness models one. */
  routes: WebRoute[]
}

/** A registered route, as the host would hold it. */
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (
    request: unknown,
    response: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void },
  ) => void
}

/**
 * A runtime, as far as this plugin can tell.
 *
 * `inject: false` models a host that exposes no service lookup at all — a different thing from a
 * host that exposes one and has no governance service in it, which is what `governance: false`
 * stands for. The distinction matters because only the first is knowable, and the plugin says so.
 *
 * `web: true` models a web-carrying composition, and it models the shape that matters: the callback
 * is handed a scoped context carrying **both** the service and cordis's own `effect`. The first
 * version of the connector view called `effect` on the service instead, which compiled, did nothing,
 * and registered no route — indistinguishable from a working one until a request 404'd. That is why
 * this harness now has a web server in it at all.
 */
function harness(options: { governance?: boolean; inject?: boolean; web?: boolean } = {}): Harness {
  const state: Harness = {
    tools: [],
    declared: [],
    logs: [],
    routes: [],
    ctx: undefined as unknown as ExternalContext,
  }
  const wantsGovernance = options.governance ?? true

  state.ctx = {
    tools: {
      register(tool): void {
        state.tools.push(tool as unknown as Tool)
      },
    },
    logger: { warn: (message) => state.logs.push(message) },
    // The lookup a capability is allowed to use for a service it has not declared. Nothing here
    // publishes a credential seam, which is the composition this suite is about.
    get: () => undefined,
    ...(options.inject === false
      ? {}
      : {
          inject: ((names: readonly string[], callback: (scoped: never) => void) => {
            const scoped: Record<string, unknown> = {}
            if (names.includes('deepworkGovernance')) {
              if (!wantsGovernance) return
              scoped.deepworkGovernance = {
                declareTool: (tool: string, access: unknown) => {
                  state.declared.push({ tool, access })
                  return () => {}
                },
              }
            }
            if (names.includes('webServer') && options.web === true) {
              scoped.webServer = {
                register: (route: WebRoute) => {
                  state.routes.push(route)
                  return () => {}
                },
              }
              scoped.effect = (effect: () => unknown) => {
                effect()
              }
            }
            callback(scoped as never)
          }) as ExternalContext['inject'],
        }),
  }
  // The runtime answers a context *property* read on an undeclared service with this error, thrown
  // out of `apply` — the row fails and the tool is never registered. The fixture throws it too, so
  // the difference between a lookup and a property read cannot regress unnoticed: this suite was
  // green the day a real composition refused to load the plugin for exactly this.
  Object.defineProperty(state.ctx, 'credentials', {
    get() {
      throw new Error('cannot get property "credentials" without inject')
    },
  })
  return state
}

/** The configuration a deployment that has said everything would carry. */
const CONFIGURED = {
  ontologyRoot: DOMAIN,
  command: COMMAND,
  route: { type: 'AccessRoute', url: 'url', auth_ref: 'auth_ref' },
}

test('a configured deployment gets its one tool, and declares the program its command starts', () => {
  const h = harness()
  apply(h.ctx, CONFIGURED)

  assert.deepEqual(
    h.tools.map((tool) => tool.name),
    ['reach_system'],
    'a capability that registers nothing looks exactly like one that failed to load',
  )
  assert.deepEqual(h.declared, [{ tool: 'reach_system', access: { executes: ['node'] } }])

  // The argument is the route and nothing else. A second argument here would be a second way to aim
  // the tool, and none of the four things a call needs — program, address, credential, domain — is
  // a caller's to choose.
  assert.deepEqual(h.tools[0]?.parameters.required, ['route_id'])
  assert.deepEqual(Object.keys(h.tools[0]?.parameters.properties ?? {}), ['route_id'])
})

test('the value the runtime will validate is declared in full, optional fields included', () => {
  const h = harness()
  apply(h.ctx, CONFIGURED)
  const schema = h.tools[0]?.output.schema

  // `required` belongs to the object, not to a property — the mistake that took a bundle down once
  // already. And the two fields that are sometimes absent are declared rather than required, because
  // the runtime refuses a value carrying a key its schema does not name.
  assert.deepEqual(schema?.required, ['route', 'url', 'program', 'exitCode', 'reachable', 'elapsedMs'])
  assert.deepEqual(Object.keys(schema?.properties ?? {}).sort(), [
    'elapsedMs',
    'exitCode',
    'output',
    'program',
    'reachable',
    'route',
    'system',
    'url',
  ])
})

test('the description says what the exit status is and is not', () => {
  const h = harness()
  apply(h.ctx, CONFIGURED)
  const description = h.tools[0]?.description ?? ''

  // The one claim a model will otherwise invent: a connector exiting 0 is a claim about a system
  // this tool has not looked at. It is stated in the description because that is the only place the
  // model reads before deciding whether a result means what it hopes.
  assert.match(description, /not interpreted/)
  assert.match(description, /route id and nothing else/)
})

test('the program declared is the one the domain grants', () => {
  const h = harness()
  apply(h.ctx, CONFIGURED)
  const program = (h.declared[0]?.access as { executes: readonly string[] }).executes[0] ?? ''
  const grants = loadGraph(DOMAIN).schema.toolGrants

  // The chain the example domain documents, pinned end to end: the tool declares the program its
  // configured command starts, and the domain's `tool_grants` already have an entry for it. A change
  // to either side that broke the pairing would leave the tool refused at the door, and this is
  // where that shows up rather than in a deployment.
  assert.equal(program, 'node')
  assert.deepEqual(grants?.get(program), ['engineer'])
  assert.deepEqual(grants?.get('reach_system'), ['engineer'])
})

test('a deployment that has not said how it reaches anything gets no tool, and is told why', () => {
  const h = harness()
  apply(h.ctx, { ...CONFIGURED, command: '' })

  assert.deepEqual(h.tools, [])
  assert.ok(h.logs.some((line) => line.includes('no command configured')))
})

test('a deployment that has not named its domain vocabulary gets no tool either', () => {
  const h = harness()
  apply(h.ctx, { ontologyRoot: DOMAIN, command: COMMAND })

  // No default is invented here. Guessing `AccessRoute` would make this package work against the
  // example domain and mis-read a deployment that called its routes something else, silently.
  assert.deepEqual(h.tools, [])
  assert.ok(h.logs.some((line) => line.includes('type, url, auth_ref')))
})

test('a deployment with no domain has nothing to read a route out of', () => {
  const h = harness()
  apply(h.ctx, { ...CONFIGURED, ontologyRoot: '' })

  assert.deepEqual(h.tools, [])
  assert.ok(h.logs.some((line) => line.includes('no ontologyRoot configured')))
})

test('a command with no address slot is registered anyway, with the address lost', () => {
  const h = harness()
  apply(h.ctx, { ...CONFIGURED, command: 'node /opt/connectors/reach.mjs' })

  assert.equal(h.tools.length, 1)
  assert.ok(h.logs.some((line) => line.includes('no {url} slot')))
})

test('a host with no credential seam still gets the tool, and is told what every call will do', () => {
  const h = harness()
  apply(h.ctx, CONFIGURED)

  // The tool is registered rather than withheld: a seam can be mounted later, and until then the
  // refusal is the honest answer. The warning exists so a deployment finds out at boot rather than
  // from a model that keeps retrying.
  assert.equal(h.tools.length, 1)
  assert.ok(h.logs.some((line) => line.includes('no credential service is mounted')))
})

test('a profile with no governance channel still gets the tool, and says nothing', () => {
  const h = harness({ governance: false })
  apply(h.ctx, CONFIGURED)

  assert.equal(h.tools.length, 1)
  assert.deepEqual(h.declared, [])
})

test('a context with no service lookup at all is reported, because then it is knowable', () => {
  const h = harness({ inject: false })
  apply(h.ctx, CONFIGURED)

  // There is no seam to look through, so nothing will ever arrive through it — which is the one
  // case where the absence is not "not yet" but "never".
  assert.equal(h.tools.length, 1)
  assert.ok(h.logs.some((line) => line.includes('not governed by the write guard')))
})

test('a web-carrying profile gets the connector view, and it serves what the domain declares', () => {
  const h = harness({ web: true })
  apply(h.ctx, CONFIGURED)

  // One route, at the path the deployment can open. A prefix rather than an exact path so a query
  // string or a trailing segment cannot make the page unreachable, and outside the domain panel's
  // own prefix so the two views do not sit in each other's route tables.
  assert.deepEqual(
    h.routes.map((route) => `${route.kind} ${route.path}`),
    [`prefix ${CONNECTORS_ROUTE}`],
    'a route that was never registered reads exactly like one that works, until a request 404s',
  )

  // What it serves, read the way a browser would: the handler writes a status and a body.
  let status: number | undefined
  let body = ''
  h.routes[0]?.handler(
    // The handler branches on method and path, so a request that is neither is answered 405 rather
    // than served a snapshot — which is what this models: the page's own GET.
    { method: 'GET', url: '/connectors' },
    {
      writeHead: (code) => {
        status = code
      },
      end: (text) => {
        body = text
      },
    },
  )
  assert.equal(status, 200)
  const snapshot = JSON.parse(body) as { routeType: string; connectors: unknown[] }
  assert.equal(snapshot.routeType, 'AccessRoute')
  assert.equal(snapshot.connectors.length, 5, 'the fixture domain declares five routes')
})

test('a web server with no effect is reported rather than silently ignored', () => {
  // The shape this suite was written for: a service is there, the context's tie to the plugin's
  // lifetime is not. The registration cannot happen, so it has to be said.
  const h = harness()
  apply(h.ctx, CONFIGURED)
  assert.equal(h.routes.length, 0)
  assert.ok(h.logs.some((line) => line.includes('connector view is not registered')))
})
