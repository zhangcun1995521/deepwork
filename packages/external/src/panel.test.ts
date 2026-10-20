/**
 * The suite for the one act the connector page can perform.
 *
 * Two claims, and they pull in opposite directions, which is why both are here. A page call has to
 * *work* — the button exists because a read-only view answered nothing — and a page call has to be no
 * more powerful than the tool: the domain's `tool_grants` still decides, and the trail still says who
 * started it. A suite that only proved the first would pass with the second quietly inverted.
 *
 * Everything is real: a socket, a child process, the trail read back off the disk. The credential seam
 * is the one stand-in, for the reason the reach suite gives — mounting the host's provider would mean
 * booting a runtime, and the seam's contract is one method.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { ReachAuditEntry } from './audit.ts'
import { panelReach, type PanelRequest } from './panel.ts'
import type { CredentialSurface } from './reach.ts'

/** The fixture domain, copied per test so one route can hold a live port. */
const FIXTURE_DOMAIN = fileURLToPath(new URL('../tests/fixtures/domain', import.meta.url))

/** The stand-in connector the configured command runs, by absolute path so `cwd` cannot matter. */
const REACH_SCRIPT = fileURLToPath(new URL('../tests/fixtures/reach.mjs', import.meta.url))

/** Scratch space inside the repository: nothing this suite writes may land outside it. */
const SCRATCH = fileURLToPath(new URL('../tests/.tmp', import.meta.url))

/** The reference name the fixture routes file their credential under. */
const REFERENCE = 'FIXTURE_REACH_CREDENTIAL'

/** The secret the tests store. Easy to grep for, and it must not appear in the trail. */
const SECRET = 'panel-credential-nobody-should-log'

let counter = 0

/** A unique scratch path per test, removed afterwards whether the test passed or not. */
function scratch(t: TestContext, label: string): string {
  const path = join(SCRATCH, `${label}-${(counter += 1)}`)
  mkdirSync(SCRATCH, { recursive: true })
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

/** A real HTTP server on 127.0.0.1, answering with the address it was reached at. */
async function server(t: TestContext): Promise<{ address: string; requests: string[] }> {
  const requests: string[] = []
  const http: Server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, path: request.url }))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())))
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('no port from the server')
  return { address: `http://127.0.0.1:${address.port}/health`, requests }
}

/**
 * A copy of the fixture domain, with R-1 pointed at a live address.
 *
 * Only R-1 is rewritten. The other routes keep the placeholder and never need more: each is refused
 * before its address is substituted, which their own tests assert by checking nothing was dialled.
 */
function domain(t: TestContext, address: string): string {
  const root = scratch(t, 'domain')
  cpSync(FIXTURE_DOMAIN, root, { recursive: true })
  const file = join(root, 'objects', 'routes', 'R-1.yaml')
  const before = readFileSync(file, 'utf8')
  const after = before.replace(/^url: .*$/m, `url: ${address}`)
  assert.notEqual(after, before, 'the fixture route no longer has a url line to rewrite')
  writeFileSync(file, after)
  return root
}

/** Rewrite the fixture schema, asserting the text a test means to remove was there. */
function rewriteSchema(root: string, from: RegExp, to: string): void {
  const file = join(root, 'schema.yaml')
  const text = readFileSync(file, 'utf8')
  const after = text.replace(from, to)
  assert.notEqual(after, text, 'the fixture schema no longer holds the text being rewritten')
  writeFileSync(file, after)
}

/** A credential seam that hands back one value, and records which names were asked for. */
function seam(entries: Readonly<Record<string, string>>, asked: string[] = []): CredentialSurface {
  return {
    async resolve(ref) {
      const name = String(ref)
      asked.push(name)
      const value = entries[name]
      return value === undefined ? undefined : { value, source: 'test' }
    },
  }
}

/** The trail as it landed on disk. */
function trail(path: string): ReachAuditEntry[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ReachAuditEntry)
}

/** The request one test makes, with the parts it does not care about filled in. */
function request(root: string, auditLog: string, overrides: Partial<PanelRequest> = {}): PanelRequest {
  return {
    routeId: 'R-1',
    root,
    shape: { type: 'AccessRoute', url: 'url', auth_ref: 'auth_ref' },
    command: `node "${REACH_SCRIPT}" {url}`,
    program: 'node',
    timeoutSeconds: 10,
    auditLog,
    ...overrides,
  }
}

test('a page call dials the route, and the trail says a page made it', async (t) => {
  const live = await server(t)
  const root = domain(t, live.address)
  const auditLog = join(scratch(t, 'trail'), '.audit.jsonl')
  const asked: string[] = []

  const answer = await panelReach(
    request(root, auditLog, { credentials: seam({ [REFERENCE]: SECRET }, asked) }),
  )

  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  const body = answer.body as { route: string; reachable: boolean; url: string }
  assert.equal(body.route, 'R-1')
  assert.equal(body.reachable, true)
  assert.equal(live.requests.length, 1, 'the far side saw exactly one request')

  // The credential was asked for by name and never recorded, the same rule the tool's own trail keeps.
  assert.deepEqual(asked, [REFERENCE])
  const [line] = trail(auditLog)
  assert.equal(line?.outcome, 'allowed')
  assert.equal(line?.reachable, true)
  assert.equal(line?.by, 'panel', 'a page call and an agent call must not read the same afterwards')
  assert.ok(!JSON.stringify(line).includes(SECRET))
  assert.ok(!JSON.stringify(line).includes('127.0.0.1'), 'the address stays out of the trail')
})

test('a program nobody granted is refused at the page, before anything is dialled', async (t) => {
  const live = await server(t)
  const root = domain(t, live.address)
  rewriteSchema(root, /^  node: \[engineer\]$/m, '')
  const auditLog = join(scratch(t, 'trail'), '.audit.jsonl')

  const answer = await panelReach(request(root, auditLog))

  assert.equal(answer.status, 403)
  assert.equal((answer.body as { code: string }).code, 'no-grant-declared')
  assert.equal(live.requests.length, 0, 'the page must not do what the guard refuses')
  // Nothing was attempted, so there is nothing to record: a trail line here would be a claim that a
  // refusal about a route happened, and this refusal is about the deployment.
  assert.deepEqual(trail(auditLog), [])
})

test('a route a read would hide is refused, and the trail names the check', async (t) => {
  const live = await server(t)
  const root = domain(t, live.address)
  const auditLog = join(scratch(t, 'trail'), '.audit.jsonl')

  // R-2 is a candidate: confirmed-by-nobody, which a read hides and a call refuses.
  const answer = await panelReach(request(root, auditLog, { routeId: 'R-2' }))

  assert.equal(answer.status, 403)
  assert.equal((answer.body as { code: string }).code, 'not-in-default-state')
  assert.equal(live.requests.length, 0)
  const [line] = trail(auditLog)
  assert.equal(line?.outcome, 'denied')
  assert.equal(line?.by, 'panel')
  assert.equal(line?.reason, 'not-in-default-state')
})

test('a request without a route, or a deployment that cannot dial, is refused as such', async (t) => {
  const live = await server(t)
  const root = domain(t, live.address)
  const auditLog = join(scratch(t, 'trail'), '.audit.jsonl')

  const noRoute = await panelReach(request(root, auditLog, { routeId: '' }))
  assert.equal(noRoute.status, 400)
  assert.equal((noRoute.body as { code: string }).code, 'route-required')

  // A deployment with no command has not said how it reaches anything; that is a 503 and not a
  // permission story, because the fix is configuration rather than a grant.
  const unconfigured = await panelReach(request(root, auditLog, { command: '' }))
  assert.equal(unconfigured.status, 503)
  assert.equal((unconfigured.body as { code: string }).code, 'not-configured')

  // And a domain that cannot be read is the same kind of answer, from the grant check that reads it.
  const unreadable = await panelReach(request(join(SCRATCH, 'no-such-domain'), auditLog))
  assert.equal(unreadable.status, 503)
  assert.equal((unreadable.body as { code: string }).code, 'domain-unreadable')

  assert.equal(live.requests.length, 0)
  assert.deepEqual(trail(auditLog), [])
})
