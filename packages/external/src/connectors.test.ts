/**
 * The connector view's suite.
 *
 * Every test here is about what a *page* is allowed to say, so the assertions are mostly about
 * absences and about the line between two numbers: a route whose own declaration is complete, and a
 * route a call would actually get through. The fixture domain is shaped so the first can be
 * non-zero while the second is zero — which is the state a real domain was in the first time this
 * view was pointed at it, and the one a summary that collapsed the two would have mis-reported.
 *
 * A file, not a socket. Nothing in this view dials, so nothing here needs a server: the trail is
 * written to disk and read back, and the whole point of the tests is that reaching a system is the one
 * thing this page does not do.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { connectorSnapshot, type ConnectorSnapshot } from './connectors.ts'
import type { ReachAuditEntry } from './audit.ts'
import type { RouteShape } from './route.ts'

/** The fixture domain, copied per test because a test may rewrite a route or the schema. */
const FIXTURE_DOMAIN = fileURLToPath(new URL('../tests/fixtures/domain', import.meta.url))

/** Scratch space inside the repository: nothing this suite writes may land outside it. */
const SCRATCH = fileURLToPath(new URL('../tests/.tmp', import.meta.url))

/** The domain's own names, as the deployment configures them. */
const SHAPE: RouteShape = { type: 'AccessRoute', url: 'url', auth_ref: 'auth_ref' }

/** The program the fixture deployment's command starts. */
const PROGRAM = 'node'

let counter = 0

/** A unique scratch path per test, removed afterwards whether the test passed or not. */
function scratch(t: TestContext, label: string): string {
  const path = join(SCRATCH, `${label}-${(counter += 1)}`)
  mkdirSync(SCRATCH, { recursive: true })
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

/** A copy of the fixture domain, and a trail path beside it that does not exist yet. */
function domain(t: TestContext): { root: string; auditLog: string } {
  const root = scratch(t, 'domain')
  cpSync(FIXTURE_DOMAIN, root, { recursive: true })
  return { root, auditLog: join(scratch(t, 'trail'), '.audit.jsonl') }
}

/** Rewrite the fixture's schema, asserting that the text a test means to remove was there. */
function rewriteSchema(root: string, from: RegExp, to: string): void {
  const file = join(root, 'schema.yaml')
  const before = readFileSync(file, 'utf8')
  const after = before.replace(from, to)
  assert.notEqual(after, before, 'the fixture schema no longer holds the text being rewritten')
  writeFileSync(file, after)
}

/** Write trail lines, exactly as the two other writers would leave them. */
function writeTrail(path: string, lines: readonly unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
}

/** One reach entry, with the fields under test defaulted rather than repeated. */
function reachEntry(route: string, overrides: Partial<ReachAuditEntry> = {}): ReachAuditEntry {
  return {
    at: '2026-10-16T07:06:25.811Z',
    kind: 'reach',
    route,
    program: PROGRAM,
    outcome: 'allowed',
    exitCode: 0,
    reachable: true,
    elapsedMs: 49,
    ...overrides,
  }
}

/** The route with the given id, from a snapshot that is expected to hold it. */
function routeOf(snapshot: ConnectorSnapshot, id: string): ConnectorSnapshot['connectors'][number] {
  const found = snapshot.connectors.find((connector) => connector.id === id)
  assert.ok(found !== undefined, `route ${id} is missing from the view`)
  return found
}

/** The codes of everything that stops a call, in declaration order. */
function codesOf(findings: readonly { code: string }[]): string[] {
  return findings.map((finding) => finding.code)
}

test('every route the domain declares appears, with the problem its own state predicts', (t) => {
  const { root, auditLog } = domain(t)
  const snapshot = connectorSnapshot({ root, shape: SHAPE, program: PROGRAM, auditLog })

  assert.equal(snapshot.readable, true)
  assert.equal(snapshot.routeType, 'AccessRoute')
  assert.equal(snapshot.program, PROGRAM)
  assert.equal(snapshot.connectors.length, 5, 'one entry per route in the fixture domain')

  // R-1: confirmed, an address, a name the seam can address. The only route nothing is wrong with.
  const complete = routeOf(snapshot, 'R-1')
  assert.deepEqual(complete.problems, [])
  assert.deepEqual(complete.dialable, { state: 'confirmed', required: 'confirmed', ok: true })
  assert.deepEqual(complete.credential, {
    field: 'auth_ref',
    name: 'FIXTURE_REACH_CREDENTIAL',
    addressable: true,
  })
  assert.equal(complete.system, 'SYS-LANTERN', 'read from the domain relation, not from a field name')

  // R-2: confirmed-by-nobody — a candidate, which a read hides and a call refuses.
  assert.deepEqual(codesOf(routeOf(snapshot, 'R-2').problems), ['not-in-default-state'])

  // R-3: the deployment configured an address field and this route leaves it empty.
  assert.deepEqual(codesOf(routeOf(snapshot, 'R-3').problems), ['no-address'])

  // R-4: a blank reference is a name problem rather than a missing credential.
  const blankName = routeOf(snapshot, 'R-4')
  assert.deepEqual(codesOf(blankName.problems), ['no-credential-name'])
  assert.equal(blankName.credential.addressable, false)

  // R-5: no state field at all, so the type's `initial` state is the answer — the same fallback a
  // read applies. Comparing the field to `confirmed` would call this route dialable.
  const unstated = routeOf(snapshot, 'R-5')
  assert.equal(unstated.dialable.state, 'candidate')
  assert.deepEqual(codesOf(unstated.problems), ['not-in-default-state'])

  assert.deepEqual(snapshot.summary, {
    routes: 5,
    complete: 1,
    callable: 1,
    attempted: 0,
    refused: 0,
  })
  // No trail file yet is the normal state of a fresh deployment, not a finding.
  assert.deepEqual(snapshot.findings, [])
})

test('the address is never served, and neither is anything behind the credential', (t) => {
  const { root, auditLog } = domain(t)
  const snapshot = connectorSnapshot({ root, shape: SHAPE, program: PROGRAM, auditLog })

  // The fixture's placeholder address, which is what the domain files for every route but R-3.
  assert.ok(
    !JSON.stringify(snapshot).includes('127.0.0.1'),
    'the address must not reach the page: an address may carry a token in its query string',
  )
  // What is shown about the address is the field's name and whether it is filled.
  assert.deepEqual(routeOf(snapshot, 'R-1').address, { field: 'url', set: true })
  assert.deepEqual(routeOf(snapshot, 'R-3').address, { field: 'url', set: false })
  // The credential name is shown — it is what the domain declares and what an operator looks up. The
  // material is not reachable from here at all: nothing in this module asks the seam.
  assert.equal(routeOf(snapshot, 'R-1').credential.name, 'FIXTURE_REACH_CREDENTIAL')
})

test('who may call is read from the domain, and a missing grant makes nothing callable', (t) => {
  const granted = domain(t)
  const snapshot = connectorSnapshot({
    root: granted.root,
    shape: SHAPE,
    program: PROGRAM,
    auditLog: granted.auditLog,
  })
  assert.deepEqual(routeOf(snapshot, 'R-1').callers, {
    program: PROGRAM,
    programRoles: ['engineer'],
    toolRoles: ['engineer'],
  })
  assert.deepEqual(snapshot.findings, [], 'a domain that grants the program has nothing to report')

  // The same domain with the program's grant removed: the guard refuses every call with
  // `no-grant-declared`, so no route is callable however complete its own declaration is.
  const ungranted = domain(t)
  rewriteSchema(ungranted.root, /^  node: \[engineer\]$/m, '')

  const stripped = connectorSnapshot({
    root: ungranted.root,
    shape: SHAPE,
    program: PROGRAM,
    auditLog: ungranted.auditLog,
  })
  assert.equal(routeOf(stripped, 'R-1').callers.programRoles, null)
  assert.deepEqual(codesOf(stripped.findings), ['program-not-granted'])
  // Said once for the deployment rather than five times, because it is not a route's fault.
  assert.match(stripped.findings[0]?.detail ?? '', /no-grant-declared/)

  // The distinction the two numbers exist for: five routes, one of which is complete, and nothing a
  // call would get through.
  assert.equal(stripped.summary.complete, 1)
  assert.equal(stripped.summary.callable, 0)
})

test('a field the connector was told to read that the type does not declare is one finding', (t) => {
  const { root, auditLog } = domain(t)
  const snapshot = connectorSnapshot({
    root,
    shape: { type: 'AccessRoute', url: 'url', auth_ref: 'token_ref' },
    program: PROGRAM,
    auditLog,
  })

  // One finding rather than five identical `no-credential-name` problems: the field name is the
  // deployment's mistake, and every route would report the same blank because of it.
  assert.deepEqual(codesOf(snapshot.findings), ['credential-field-not-declared'])
  assert.match(snapshot.findings[0]?.detail ?? '', /"token_ref"/)
  assert.match(snapshot.findings[0]?.detail ?? '', /auth_ref/, 'it names the fields the type does have')
  for (const route of snapshot.connectors) {
    assert.ok(!codesOf(route.problems).includes('no-credential-name'), `${route.id} repeated it`)
  }
  // And it stops every call, so nothing is callable even though the routes are otherwise fine.
  assert.equal(snapshot.summary.callable, 0)
})

test('the trail is read, and only its reach entries', (t) => {
  const { root, auditLog } = domain(t)
  writeTrail(auditLog, [
    // Two entries of other kinds, which share the file and must not be counted as attempts.
    { at: '2026-10-16T07:00:00.000Z', kind: 'guard', tool: 'bash', outcome: 'denied', reason: 'x' },
    { at: '2026-10-16T07:00:01.000Z', action: 'ontology_write', type: 'T', id: 'i', file: 'f', outcome: 'allowed' },
    reachEntry('R-1'),
    reachEntry('R-2', { outcome: 'denied', reason: 'unavailable', exitCode: undefined, reachable: undefined }),
    reachEntry('R-2', { outcome: 'denied', reason: 'rejected', exitCode: undefined, reachable: undefined }),
    // A half-written last line, which is what a crash leaves behind.
    '{"at":"2026-10-16T07:30:00.000Z","kind":"reach","route":"R-1"',
  ])
  const snapshot = connectorSnapshot({ root, shape: SHAPE, program: PROGRAM, auditLog })

  const reached = routeOf(snapshot, 'R-1')
  assert.deepEqual(reached.last, {
    at: '2026-10-16T07:06:25.811Z',
    outcome: 'allowed',
    exitCode: 0,
    reachable: true,
    elapsedMs: 49,
  })
  assert.equal(reached.refusals, 0)

  const refused = routeOf(snapshot, 'R-2')
  // The last attempt, not the first: a page that showed the first refusal would hide the repetition.
  assert.equal(refused.last?.reason, 'rejected')
  assert.equal(refused.refusals, 2)
  // Never attempted, as opposed to attempted and refused.
  assert.equal(routeOf(snapshot, 'R-3').last, null)

  assert.equal(snapshot.summary.attempted, 2)
  assert.equal(snapshot.summary.refused, 1)
})

test('what a route reaches is read from a relation, or from a field when the domain has none', (t) => {
  // The fixture says it with a relation, which wins when both exist.
  const relational = domain(t)
  const fromLink = connectorSnapshot({
    root: relational.root,
    shape: SHAPE,
    target: 'system',
    program: PROGRAM,
    auditLog: relational.auditLog,
  })
  assert.equal(routeOf(fromLink, 'R-1').system, 'SYS-LANTERN')
  // Nothing to report: the relation answered, so the configured field was never needed.
  assert.deepEqual(codesOf(fromLink.findings), [])

  // A domain that models the same fact as a plain field and declares no relation — which is what the
  // real one does, deliberately, and the reason the target name is optional configuration rather than
  // a rule about how a domain must be shaped.
  const flat = domain(t)
  rewriteSchema(flat.root, /link_types:[\s\S]*?\ntool_grants:/, 'tool_grants:')
  const fromField = connectorSnapshot({
    root: flat.root,
    shape: SHAPE,
    target: 'system',
    program: PROGRAM,
    auditLog: flat.auditLog,
  })
  assert.equal(routeOf(fromField, 'R-1').system, 'SYS-LANTERN')

  // With no relation and no configured field, the page says so once instead of five times.
  const silent = domain(t)
  rewriteSchema(silent.root, /link_types:[\s\S]*?\ntool_grants:/, 'tool_grants:')
  const nothing = connectorSnapshot({
    root: silent.root,
    shape: SHAPE,
    program: PROGRAM,
    auditLog: silent.auditLog,
  })
  assert.equal(routeOf(nothing, 'R-1').system, null)
  assert.deepEqual(codesOf(nothing.findings), ['no-target'])
})

test('a domain that cannot be read is reported rather than thrown', (t) => {
  const auditLog = join(scratch(t, 'trail'), '.audit.jsonl')
  const snapshot = connectorSnapshot({
    root: join(SCRATCH, 'no-such-domain'),
    shape: SHAPE,
    program: PROGRAM,
    auditLog,
  })
  assert.equal(snapshot.readable, false)
  assert.deepEqual(snapshot.connectors, [])
  assert.deepEqual(codesOf(snapshot.findings), ['domain-unreadable'])
})

test('a route type the domain does not declare is named, with what it does declare', (t) => {
  const { root, auditLog } = domain(t)
  const snapshot = connectorSnapshot({
    root,
    shape: { type: 'Endpoint', url: 'url', auth_ref: 'auth_ref' },
    program: PROGRAM,
    auditLog,
  })
  assert.equal(snapshot.readable, true, 'the domain was readable; only the configured name was wrong')
  assert.deepEqual(snapshot.connectors, [])
  assert.deepEqual(codesOf(snapshot.findings), ['route-type-undeclared'])
  assert.match(snapshot.findings[0]?.detail ?? '', /"Endpoint" is not declared/)
  assert.match(snapshot.findings[0]?.detail ?? '', /AccessRoute/)
})
