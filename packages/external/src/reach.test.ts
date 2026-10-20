/**
 * The suite that actually reaches something.
 *
 * Every claim here is made against a real socket, a real child process and a real file: an
 * `http.createServer` on 127.0.0.1, the fixture connector run as `node <script> <address>`, and the
 * trail read back off the disk. Nothing about the path under test is simulated, because the parts
 * that break are exactly the parts a simulated version would smooth over — whether a credential
 * survives the trip through the environment, whether a quoted address arrives as one argument, and
 * whether a refusal leaves the far side untouched.
 *
 * The credential seam is the one seam that is stood in for, and deliberately: mounting the host's
 * own provider would mean booting a runtime, and the seam's contract is one method. What that stand-in
 * cannot prove is that the *host's* provider resolves a reference; what it does prove is that this
 * package asks it for the right name, hands the value to a program and keeps it out of everything
 * else. The fixture connector sends the value as a bearer token, so the server can confirm where it
 * ended up.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply, type ApprovalOutcome, type ApprovalSurface, type ExecutionContext, type ExternalContext } from './index.ts'
import { substituteAddress, type CredentialSurface, type ReachResult } from './reach.ts'
import type { ReachAuditEntry } from './audit.ts'

/** The fixture domain, copied per test so a route can hold the port of a server that just started. */
const FIXTURE_DOMAIN = fileURLToPath(new URL('../tests/fixtures/domain', import.meta.url))

/** The stand-in connector the configured command runs, by absolute path so `cwd` cannot matter. */
const REACH_SCRIPT = fileURLToPath(new URL('../tests/fixtures/reach.mjs', import.meta.url))

/** Scratch space inside the repository: nothing this suite writes may land outside it. */
const SCRATCH = fileURLToPath(new URL('../tests/.tmp', import.meta.url))

/** The reference name the fixture routes file their credential under. */
const REFERENCE = 'FIXTURE_REACH_CREDENTIAL'

/** The secret the tests store. Deliberately a string that is easy to grep for. */
const SECRET = 'fixture-credential-nobody-should-log'

/** The tool as this suite calls it. The runtime always hands over an execution context; this suite
 * makes it optional so a call that is not about the gate stays one line. */
interface Tool {
  execute: (args: { route_id: string }, exec?: ExecutionContext) => Promise<unknown>
}

/** The agent a call is made on behalf of when a test does not care which one it is. */
const AGENT: ExecutionContext = { agent: { id: 'agent-under-test' } }

/** One deployment, configured and mounted, with its tool and its trail. */
interface Deployment {
  tool: Tool
  /** What the plugin warned about: a configured deployment has none. */
  logs: string[]
  /** What it logged for an operator rather than as a problem — an opened grant, for instance. */
  notes: string[]
  auditLog: string
}

/** A stand-in for the host's approval service: it records what it was asked and answers as told. */
interface FakeApproval {
  surface: ApprovalSurface
  asked: { agent: unknown; toolName: string; callId?: string; reason?: string }[]
}

/**
 * An approval service that answers `outcome` every time, or throws when given an error.
 *
 * Answers and records, in that order, so a test can assert both what the person was asked and what
 * the answer did. The default is the one-shot grant, because that is the ending a test about
 * *dialling* needs and the other three are what the gate tests are for.
 */
function fakeApproval(outcome: ApprovalOutcome | Error = 'allowed-once'): FakeApproval {
  const asked: FakeApproval['asked'] = []
  return {
    asked,
    surface: {
      async request(request) {
        asked.push({
          agent: request.agent,
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        })
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    },
  }
}

let counter = 0

/** A unique scratch path per test, removed afterwards whether the test passed or not. */
function scratch(t: TestContext, label: string): string {
  const path = join(SCRATCH, `${label}-${(counter += 1)}`)
  mkdirSync(SCRATCH, { recursive: true })
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

/**
 * A copy of the fixture domain with R-1 pointed at a live address.
 *
 * Only R-1 is rewritten. The other routes keep the fixture's placeholder and never need more than
 * that: each is refused before its address is substituted, which is a claim their tests make by
 * asserting that nothing was dialled.
 */
function domainReaching(t: TestContext, address: string, alsoDialable: readonly string[] = []): string {
  const root = scratch(t, 'domain')
  cpSync(FIXTURE_DOMAIN, root, { recursive: true })
  const file = join(root, 'objects', 'routes', 'R-1.yaml')
  const before = readFileSync(file, 'utf8')
  const after = before.replace(/^url: .*$/m, `url: ${address}`)
  assert.notEqual(after, before, 'the fixture route no longer has a url line to rewrite')
  writeFileSync(file, after)

  // A second dialable route, for the tests that need two: the fixture's R-2 is a candidate, so it is
  // given both an address and the state a read would return it in. Only the routes named here are
  // touched; the others keep the state their own tests assert.
  for (const id of alsoDialable) {
    const extra = join(root, 'objects', 'routes', `${id}.yaml`)
    const text = readFileSync(extra, 'utf8')
      .replace(/^url: .*$/m, `url: ${address}`)
      .replace(/^status: .*$/m, 'status: confirmed')
    writeFileSync(extra, text)
  }
  return root
}

/**
 * Configure and mount the capability, and hand back the tool it registered.
 *
 * The registry is the only place the tool can be observed — `apply` hands it over and never gives it
 * back, exactly as the real runtime takes it — so it is captured on the way in. Going through `apply`
 * rather than calling `reach` directly is the point of this file: the configuration, the argument
 * contract and the run are one path, and a suite that started half way along it would not notice a
 * command that never got substituted.
 */
function deployment(
  t: TestContext,
  address: string,
  options: {
    credentials?: CredentialSurface
    /** The approval service to mount. `null` is a runtime whose lookup answers nothing. */
    approval?: ApprovalSurface | null
    /** What the deployment said about asking. Default: it said nothing, and asking is the default. */
    requireApproval?: boolean
    /** Routes to make dialable besides R-1, which this helper always points at the address. */
    alsoDialable?: readonly string[]
    /** Model a runtime with no service lookup at all, which is a different absence again. */
    noLookup?: boolean
  } = {},
): Deployment {
  const root = domainReaching(t, address, options.alsoDialable ?? [])
  const auditLog = join(scratch(t, 'trail'), '.audit.jsonl')
  const logs: string[] = []
  const notes: string[] = []
  let registered: Tool | undefined

  // Asking is the default, so a deployment that says nothing gets a service that grants once; the
  // gate tests mount their own. `null` is a runtime with no such service, which is a different case
  // from one whose service is mounted and says no.
  const approval = options.approval === undefined ? fakeApproval().surface : options.approval

  const ctx: ExternalContext = {
    tools: {
      register(tool): void {
        const captured = tool as unknown as { execute: (args: never, exec: ExecutionContext) => Promise<unknown> }
        // The runtime always hands over a context; this suite defaults the agent so a test about the
        // run does not have to name one.
        registered = {
          execute: (args, exec) => captured.execute(args as never, exec ?? AGENT),
        }
      },
    },
    logger: { warn: (message) => logs.push(message), info: (message) => notes.push(message) },
    // The lookup the runtime exposes, with no governance service behind it: the plugin declares its
    // program to nobody and says nothing, which is the case `index.test.ts` covers from the other
    // side — the declaration happening when a service IS mounted.
    inject: ((names: readonly string[], callback: (scoped: never) => void) => {
      if (names.includes('deepworkGovernance')) return
      callback({} as never)
    }) as ExternalContext['inject'],
    // The seams are reached through the runtime's lookup, and only through it: a property read is
    // what cordis refuses on an undeclared service, and that refusal is what this stands in for.
    ...(options.noLookup === true
      ? {}
      : {
          get: ((name: string) => {
            if (name === 'credentials') return options.credentials
            if (name === 'approval') return approval ?? undefined
            return undefined
          }) as ExternalContext['get'],
        }),
  }

  apply(ctx, {
    ontologyRoot: root,
    // Quoted, so the path is one argument on every shell this has to run under — including the
    // Windows one, where a checkout under `C:\Program Files` would otherwise split in two.
    command: `node "${REACH_SCRIPT}" {url}`,
    route: { type: 'AccessRoute', url: 'url', auth_ref: 'auth_ref' },
    timeoutSeconds: 10,
    auditLog,
    ...(options.requireApproval === undefined ? {} : { requireApproval: options.requireApproval }),
  })

  const captured = registered
  assert.ok(captured !== undefined, 'a configured deployment registered no tool')
  return { tool: captured, logs, notes, auditLog }
}

/** The credential seam, as the host publishes it: one method, and no value until it is called. */
function seam(
  entries: Readonly<Record<string, string>>,
  asked: string[] = [],
): CredentialSurface {
  return {
    async resolve(ref) {
      const name = String(ref)
      asked.push(name)
      const value = entries[name]
      return value === undefined ? undefined : { value, source: 'test' }
    },
  }
}

/** A real HTTP server on 127.0.0.1, answering with a body the test can recognise. */
async function serve(t: TestContext): Promise<{ address: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization ?? '')
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('the system answered')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const bound = server.address()
  if (bound === null || typeof bound === 'string') throw new Error('the server bound to nothing')
  // A query string, on purpose: `&` is the character an unquoted address would hand the shell as a
  // separator, so the address that reaches the far side proves the substitution is quoted.
  return {
    address: `http://127.0.0.1:${bound.port}/answer?probe=1&x=2`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** The trail, read back: one JSON object per line, or nothing when no line was written. */
function trail(path: string): ReachAuditEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ReachAuditEntry)
}

test('a confirmed route is dialled, and the credential travels without ever being an argument', async (t) => {
  const server = await serve(t)
  const asked: string[] = []
  const mounted = deployment(t, server.address, {
    credentials: seam({ [REFERENCE]: SECRET }, asked),
  })

  const result = (await mounted.tool.execute({ route_id: 'R-1' })) as ReachResult

  assert.equal(result.route, 'R-1')
  assert.equal(result.system, 'SYS-LANTERN')
  assert.equal(result.url, server.address)
  assert.equal(result.program, 'node')
  assert.equal(result.exitCode, 0)
  assert.equal(result.reachable, true)
  assert.equal(result.output, 'the system answered')
  assert.ok(result.elapsedMs >= 0)

  // The socket really was opened, once, and the credential arrived in a header — which is the claim
  // the whole design rests on: it went through the environment and never through a command line.
  assert.deepEqual(server.requests, [`Bearer ${SECRET}`])
  assert.deepEqual(asked, [REFERENCE])
  assert.equal(mounted.logs.length, 0, 'a configured deployment has nothing to complain about')

  // And the secret is in neither of the two places it must never be.
  assert.ok(!JSON.stringify(result).includes(SECRET), 'the credential is in the result')
  assert.ok(!readFileSync(mounted.auditLog, 'utf8').includes(SECRET), 'the credential is in the trail')

  // The trail records the call, and only what the call is: no address, no output, no credential.
  const [line] = trail(mounted.auditLog)
  assert.deepEqual(
    line === undefined ? [] : Object.keys(line).sort(),
    ['at', 'elapsedMs', 'exitCode', 'kind', 'outcome', 'program', 'reachable', 'route'],
  )
  assert.equal(line?.kind, 'reach')
  assert.equal(line?.outcome, 'allowed')
  assert.equal(line?.route, 'R-1')
  assert.equal(line?.program, 'node')
  assert.equal(line?.exitCode, 0)
  assert.equal(line?.reachable, true)
})

test('a route nobody has walked is refused, and the system is not dialled at all', async (t) => {
  const server = await serve(t)
  const mounted = deployment(t, server.address, { credentials: seam({ [REFERENCE]: SECRET }) })

  // The lifecycle's default state decides this, and it is the same declaration a read respects: the
  // route is documented, present in the graph, and still not a route anything may go through.
  await assert.rejects(() => mounted.tool.execute({ route_id: 'R-2' }), /"candidate"[\s\S]*"confirmed"/)

  assert.deepEqual(server.requests, [], 'a refusal must not reach the far side')
  const [line] = trail(mounted.auditLog)
  assert.equal(line?.outcome, 'denied')
  assert.equal(line?.reason, 'not-in-default-state')
  assert.match(line?.detail ?? '', /R-2/)
})

test('an id the domain does not have is refused, and the refusal says which ids exist', async (t) => {
  const server = await serve(t)
  const mounted = deployment(t, server.address, { credentials: seam({ [REFERENCE]: SECRET }) })

  await assert.rejects(
    () => mounted.tool.execute({ route_id: 'R-9' }),
    /no route "R-9" in type "AccessRoute"; the ids that exist are R-1, R-2, R-3, R-4, R-5/,
  )

  assert.deepEqual(server.requests, [])
  assert.equal(trail(mounted.auditLog)[0]?.reason, 'unknown-route')
})

test('a route with no state field at all is in the type\'s initial state, which a read agrees with', async (t) => {
  const server = await serve(t)
  const mounted = deployment(t, server.address, { credentials: seam({ [REFERENCE]: SECRET }) })

  // R-5 carries no `status`. A read of this domain treats a blank state as the declared `initial`
  // state — `candidate` here — so it hides the route, and the connector has to refuse it for the same
  // reason rather than reading the empty field as "no state to check".
  await assert.rejects(
    () => mounted.tool.execute({ route_id: 'R-5' }),
    /is in "candidate"[\s\S]*"status" field is empty, which a read takes as "candidate"/,
  )

  assert.deepEqual(server.requests, [])
  assert.equal(trail(mounted.auditLog)[0]?.reason, 'not-in-default-state')
})

test('a confirmed route with no address is refused, and the refusal names the field', async (t) => {
  const server = await serve(t)
  const mounted = deployment(t, server.address, { credentials: seam({ [REFERENCE]: SECRET }) })

  // R-3 is confirmed, so the lifecycle rule lets it through and the address is what stops it. The
  // message has to name the configured field, because the fix is a domain edit rather than a code
  // change, and the deployment is the only party who knows which edit that is.
  await assert.rejects(() => mounted.tool.execute({ route_id: 'R-3' }), /R-3[\s\S]*"url" field/)

  assert.deepEqual(server.requests, [])
  assert.equal(trail(mounted.auditLog)[0]?.reason, 'no-address')
})

test('a reference the credential seam cannot address is refused as a name, not as a miss', async (t) => {
  const server = await serve(t)
  const mounted = deployment(t, server.address, { credentials: seam({ [REFERENCE]: SECRET }) })

  // R-4 leaves the reference blank. The seam's own documentation is what decides how that reads: a
  // name outside the reference grammar has no reference to miss, so it is "not set" rather than an
  // exception thrown by a builder helper — and the message says which of the two this is.
  await assert.rejects(
    () => mounted.tool.execute({ route_id: 'R-4' }),
    /not a name the credential seam can address/,
  )

  assert.deepEqual(server.requests, [])
  assert.equal(trail(mounted.auditLog)[0]?.reason, 'credential-name-outside-grammar')
})

test('a reference the deployment has not stored is refused, naming it and the field', async (t) => {
  const server = await serve(t)
  const mounted = deployment(t, server.address, { credentials: seam({}) })

  await assert.rejects(
    () => mounted.tool.execute({ route_id: 'R-1' }),
    new RegExp(`nothing is stored under "${REFERENCE}"[\\s\\S]*"auth_ref" field`),
  )

  assert.deepEqual(server.requests, [], 'a call with no credential is not worth making')
  assert.equal(trail(mounted.auditLog)[0]?.reason, 'no-credential-stored')
})

test('no credential seam at all is a refusal, and it says so before anything is dialled', async (t) => {
  const server = await serve(t)
  const mounted = deployment(t, server.address)

  await assert.rejects(
    () => mounted.tool.execute({ route_id: 'R-1' }),
    /no credential service is mounted/,
  )

  assert.deepEqual(server.requests, [])
  assert.equal(trail(mounted.auditLog)[0]?.reason, 'no-credential-service')
})

test('a system that does not answer is a result, not an error, and the attempt is written down', async (t) => {
  const server = await serve(t)
  const address = server.address
  // Nothing listening: the address is real, the port is real, and connecting to it fails the way a
  // route the deployment has not opened yet fails.
  await server.close()
  const mounted = deployment(t, address, { credentials: seam({ [REFERENCE]: SECRET }) })

  const result = (await mounted.tool.execute({ route_id: 'R-1' })) as ReachResult

  // The call was permitted and made, and the far side did not answer. Those are two different facts,
  // and the trail keeps them apart the same way it does for a write that failed after being allowed.
  assert.equal(result.reachable, false)
  assert.equal(result.exitCode, 1)
  assert.match(result.output ?? '', /^reach: /)
  assert.equal(result.exitCode === 0, result.reachable)

  const [line] = trail(mounted.auditLog)
  assert.equal(line?.outcome, 'allowed')
  assert.equal(line?.reachable, false)
  assert.equal(line?.exitCode, 1)
})

test('the address is quoted, and one a shell could still read as syntax is refused', () => {
  assert.deepEqual(substituteAddress('node reach.mjs {url}', 'https://lantern.example/api?v=1&x=2'), {
    ok: true,
    command: 'node reach.mjs "https://lantern.example/api?v=1&x=2"',
  })

  // The address is a field of a domain an agent may be able to write, and the command is read by a
  // shell. Quoting fixes the separators — `;`, `&`, `|`, a redirect — and these are what quoting does
  // not fix, so they are refused instead of substituted. `%` is the one that is easy to get wrong:
  // `cmd.exe` expands `%NAME%` while parsing the line and parses the expansion as syntax in turn, so
  // quoting does nothing about it. The price is that a percent-encoded address is refused, which is
  // stated in the code and charged deliberately.
  for (const address of [
    'https://ok.example/$(id)',
    'https://ok.example/`id`',
    'https://ok.example/a\nb',
    'https://ok.example/"quoted"',
    'https://ok.example/a\\b',
    'https://ok.example/a%20b',
    'https://ok.example/%PATH%',
    'https://ok.example/^a',
    'https://ok.example/a!b',
  ]) {
    const result = substituteAddress('node reach.mjs {url}', address)
    assert.equal(result.ok, false, `${JSON.stringify(address)} must not be substituted into a command`)
    assert.equal(result.ok ? '' : result.reason, 'address-not-quotable')
  }
})


// ── the approval gate ────────────────────────────────────────────────────────────────────────────
//
// The gate is the one part of this package that is about a person rather than a system, so the
// claims below are about what that person is shown and what their answer does. The strongest of them
// is the one that is easiest to fake: that a refusal left the far side untouched. Every test that
// expects a refusal asserts the server saw no request, not merely that the result said no.

test('a call is a question before it is a dial, and the question names the route and the address', async (t) => {
  const server = await serve(t)
  const approval = fakeApproval()
  const mounted = deployment(t, server.address, {
    credentials: seam({ [REFERENCE]: SECRET }),
    approval: approval.surface,
  })
  const exec: ExecutionContext = { agent: { id: 'agent-1' }, callId: 'call-42' }

  const result = (await mounted.tool.execute({ route_id: 'R-1' }, exec)) as ReachResult

  assert.equal(result.reachable, true, 'the granted answer let the call through')
  assert.equal(approval.asked.length, 1)
  assert.equal(approval.asked[0]?.toolName, 'reach_system')
  // The person has to be able to tell what they are approving: which route, and which address is
  // about to be dialled. A question that said "allow reach_system?" would be answered on trust.
  assert.match(approval.asked[0]?.reason ?? '', /R-1/)
  assert.match(approval.asked[0]?.reason ?? '', /127\.0\.0\.1/)
  assert.equal(approval.asked[0]?.agent, exec.agent, 'asked on behalf of that agent, as the host routes it')
  // The call id is what ties the host's `approval/asked` and `approval/decided` records to the call
  // the interface already rendered. Dropping it left the trail unable to say which call was
  // approved — the one thing a governance trail exists to answer.
  assert.equal(approval.asked[0]?.callId, 'call-42', 'the question names the call it is about')
})

test('one grant covers one route for one agent, and nothing else', async (t) => {
  const server = await serve(t)
  const approval = fakeApproval()
  const mounted = deployment(t, server.address, {
    credentials: seam({ [REFERENCE]: SECRET }),
    approval: approval.surface,
    alsoDialable: ['R-2'],
  })
  const one: ExecutionContext = { agent: { id: 'agent-1' } }

  await mounted.tool.execute({ route_id: 'R-1' }, one)
  await mounted.tool.execute({ route_id: 'R-1' }, one)
  assert.equal(approval.asked.length, 1, 'the same agent dialling the same route asks once')

  await mounted.tool.execute({ route_id: 'R-2' }, one)
  assert.equal(approval.asked.length, 2, 'another route is another authority, and asks again')

  await mounted.tool.execute({ route_id: 'R-1' }, { agent: { id: 'agent-2' } })
  assert.equal(approval.asked.length, 3, 'another agent was not party to the first answer')
})

test('an unnamed caller is never remembered, because a grant nobody owns cannot be recorded', async (t) => {
  const server = await serve(t)
  const approval = fakeApproval()
  const mounted = deployment(t, server.address, {
    credentials: seam({ [REFERENCE]: SECRET }),
    approval: approval.surface,
  })

  await mounted.tool.execute({ route_id: 'R-1' }, {})
  await mounted.tool.execute({ route_id: 'R-1' }, {})
  assert.equal(approval.asked.length, 2, 'a call with no agent is asked about every time')
})

test('every ending that is not the one-shot grant refuses, in its own words, with the far side untouched', async (t) => {
  const server = await serve(t)
  const texts = new Map<string, string>()

  for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
    const approval = fakeApproval(outcome)
    const mounted = deployment(t, server.address, {
      credentials: seam({ [REFERENCE]: SECRET }),
      approval: approval.surface,
    })

    await assert.rejects(
      () => mounted.tool.execute({ route_id: 'R-1' }),
      (error: Error) => {
        texts.set(outcome, error.message)
        return error.message.includes(outcome)
      },
      `${outcome} must refuse`,
    )

    const [line] = trail(mounted.auditLog)
    assert.equal(line?.outcome, 'denied', `${outcome} is written down as a denial`)
    assert.equal(line?.reason, outcome, 'the reason is the word the host itself answered with')
    assert.equal(line?.exitCode, undefined, 'a refused call has no exit status to report')
  }

  // Three endings, three different next moves for the model: a refusal not to be retried unchanged,
  // a withdrawn question that can be asked again, and an environment that never had anyone to ask.
  assert.equal(new Set(texts.values()).size, 3, 'the three endings must not read the same')
  assert.equal(server.requests.length, 0, 'not one of them reached the system')
})

test('with no approval service anywhere, nothing is dialled and the refusal says which absence it is', async (t) => {
  const server = await serve(t)

  for (const options of [{ approval: null as null }, { noLookup: true }] as const) {
    const mounted = deployment(t, server.address, { credentials: seam({ [REFERENCE]: SECRET }), ...options })
    await assert.rejects(() => mounted.tool.execute({ route_id: 'R-1' }), /no-approval-service/)
    const [line] = trail(mounted.auditLog)
    assert.equal(line?.reason, 'no-approval-service')
  }

  assert.equal(server.requests.length, 0, 'nothing reached the system in either shape')
})

test('a service that throws is a refusal, and reads differently from one that answered no', async (t) => {
  const server = await serve(t)
  const approval = fakeApproval(new Error('approval.request() outside an open turn'))
  const mounted = deployment(t, server.address, {
    credentials: seam({ [REFERENCE]: SECRET }),
    approval: approval.surface,
  })

  await assert.rejects(
    () => mounted.tool.execute({ route_id: 'R-1' }),
    /ask-failed.*outside an open turn/,
    'a question with nowhere to go is a refusal, and it says why',
  )
  const [line] = trail(mounted.auditLog)
  assert.equal(line?.reason, 'ask-failed')
  assert.equal(server.requests.length, 0)
})

test('a deployment that switched asking off dials without a question', async (t) => {
  const server = await serve(t)
  const approval = fakeApproval()
  const mounted = deployment(t, server.address, {
    credentials: seam({ [REFERENCE]: SECRET }),
    approval: approval.surface,
    requireApproval: false,
  })

  const result = (await mounted.tool.execute({ route_id: 'R-1' })) as ReachResult

  assert.equal(result.reachable, true)
  assert.equal(approval.asked.length, 0, 'turned off means not asked, not asked-and-ignored')
  assert.equal(mounted.notes.length, 0)
})

test('an approved call is noted where an operator looks, and is not reported as a problem', async (t) => {
  const server = await serve(t)
  const mounted = deployment(t, server.address, { credentials: seam({ [REFERENCE]: SECRET }) })

  await mounted.tool.execute({ route_id: 'R-1' })

  assert.equal(mounted.logs.length, 0, 'a configured deployment has nothing to warn about')
  assert.equal(mounted.notes.length, 1, 'opening a grant is worth a line an operator can find')
  assert.match(mounted.notes[0] ?? '', /R-1.*approved/)
})
