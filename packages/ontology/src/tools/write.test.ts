import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph } from '../engine/graph.ts'
import type { AuditEntry } from '../govern/audit.ts'
import { isSafeId, roleOf, type RoleRule } from '../govern/permission.ts'
import type { DerivedToolSpec } from './derive.ts'
import { deriveWriteTools } from './write.ts'

/** Resolve a fixture domain directory, independent of the working directory. */
const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url))

/**
 * A throwaway copy of a fixture domain. The write tool really writes, so a test that
 * used the fixture in place would mutate the repository.
 */
function scratchDomain(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-write-'))
  cpSync(fixturePath(name), dir, { recursive: true })
  return dir
}

/** A fixed clock, so audit timestamps are assertable rather than incidental. */
const CLOCK = (): Date => new Date('2026-09-29T12:00:00.000Z')

/** The role map the fixtures are written for. */
const ANALYST: readonly RoleRule[] = [{ prefix: 'analyst-session-', role: 'analyst' }]

/** Collect audit entries instead of writing them anywhere. */
function collector(): { entries: AuditEntry[]; audit: (entry: AuditEntry) => void } {
  const entries: AuditEntry[] = []
  return { entries, audit: (entry) => entries.push(entry) }
}

/** The single write tool, asserted to exist. */
function writeTool(tools: DerivedToolSpec[]): DerivedToolSpec {
  const tool = tools[0]
  assert.ok(tool !== undefined, 'expected a write tool')
  return tool
}

test('roleOf takes the longest matching prefix, and resolves nothing without a caller', () => {
  const rules: readonly RoleRule[] = [
    { prefix: 'agent-', role: 'agent' },
    { prefix: 'agent-audit-', role: 'auditor' },
  ]

  assert.equal(roleOf('agent-7', rules), 'agent')
  assert.equal(roleOf('agent-audit-2', rules), 'auditor')
  assert.equal(roleOf('other-1', rules), undefined)
  assert.equal(roleOf(undefined, rules), undefined)
  assert.equal(roleOf('', rules), undefined)
})

test('an id is safe only when it cannot become a path', () => {
  for (const id of ['P-001', 'EMP-RIVERA', 'a.b', 'x_y-z']) assert.equal(isSafeId(id), true, id)
  for (const id of ['', '.', '..', 'a/b', 'a\\b', '../../etc/passwd']) {
    assert.equal(isSafeId(id), false, id)
  }
})

test('with no roles configured, every write is refused', () => {
  const root = scratchDomain('project-delivery')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK })

  assert.throws(
    () => writeTool(tools).execute({ type: 'Project', id: 'P-003', data: {} }, { agentId: 'analyst-session-1' }),
    /write denied \(no-role\)/,
  )
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.outcome, 'denied')
  assert.equal(entries[0]?.reason, 'no-role')
})

test('a role the type does not grant is refused, and the refusal names the role', () => {
  const root = scratchDomain('project-delivery')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, {
    audit,
    now: CLOCK,
    roles: [{ prefix: 'reader-session-', role: 'reader' }],
  })

  assert.throws(
    () => writeTool(tools).execute({ type: 'Project', id: 'P-003', data: {} }, { agentId: 'reader-session-1' }),
    /role "reader" is not in written_by for "Project"/,
  )
  // The log records the role the caller actually had, not merely that it failed.
  assert.equal(entries[0]?.role, 'reader')
  assert.equal(entries[0]?.reason, 'role-not-permitted')
})

test('an id that would escape the domain is refused before authority is even considered', () => {
  const root = scratchDomain('project-delivery')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: ANALYST })

  for (const id of ['../../escape', 'a/b', 'a\\b', '..', '.']) {
    assert.throws(
      () => writeTool(tools).execute({ type: 'Project', id, data: {} }, { agentId: 'analyst-session-1' }),
      /write denied \(unsafe-id\)/,
      `id ${JSON.stringify(id)} should be refused`,
    )
  }
  assert.equal(entries.filter((entry) => entry.reason === 'unsafe-id').length, 5)
})

test('a permitted write creates the entity, persists it, and is audited as allowed', (t) => {
  const root = scratchDomain('project-delivery')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: ANALYST })

  const result = writeTool(tools).execute(
    {
      type: 'Project',
      id: 'P-003',
      data: { customer: 'CUST-ACME', owner: 'EMP-RIVERA', status: 'Delayed' },
    },
    { agentId: 'analyst-session-1' },
  )

  assert.deepEqual(result.objects.map((object) => object.id), ['P-003'])
  assert.equal(result.objects[0]?.data.status, 'Delayed')

  // Real on disk: a fresh load sees it, so this is persistence and not bookkeeping.
  assert.ok(readFileSync(join(root, 'objects/projects/P-003.yaml'), 'utf8').includes('P-003'))
  assert.equal(loadGraph(root).byId.get('Project:P-003')?.data.status, 'Delayed')

  // And visible through the graph the read tools already closed over.
  assert.ok(graph.byId.has('Project:P-003'))

  const last = entries.at(-1)
  assert.equal(last?.outcome, 'allowed')
  assert.deepEqual(last?.fields?.sort(), ['customer', 'owner', 'status'])
  assert.equal(last?.role, 'analyst')
})

test('a relation is a field: writing one asserts an edge', (t) => {
  const root = scratchDomain('project-delivery')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const graph = loadGraph(root)
  const { tools } = deriveWriteTools(graph, { audit: () => {}, now: CLOCK, roles: ANALYST })

  const result = writeTool(tools).execute(
    { type: 'Issue', id: 'ISSUE-2', data: { project: 'P-002', summary: 'Second issue' } },
    { agentId: 'analyst-session-1' },
  )

  // `reported_on` is declared with `via: project`, so the field became the edge.
  assert.deepEqual(
    result.links.filter((link) => link.type === 'reported_on').map((link) => `${link.from}->${link.to}`),
    ['ISSUE-2->P-002'],
  )
  assert.deepEqual(
    (loadGraph(root).links.filter((link) => link.from === 'ISSUE-2')).map((link) => link.type),
    ['reported_on'],
  )
})

test('a write missing a field the type requires is refused', () => {
  const root = scratchDomain('project-delivery')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: ANALYST })

  assert.throws(
    () => writeTool(tools).execute({ type: 'Project', id: 'P-004', data: { status: 'OnTrack' } }, { agentId: 'analyst-session-1' }),
    /write denied \(missing-required-field\)/,
  )
  assert.equal(entries.at(-1)?.reason, 'missing-required-field')
  // The refusal names what was absent, so the caller can fix it.
  assert.ok(entries.at(-1)?.detail?.includes('customer'), entries.at(-1)?.detail)
})

test('a second write merges into the existing entity rather than replacing it', (t) => {
  const root = scratchDomain('project-delivery')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const graph = loadGraph(root)
  const { tools } = deriveWriteTools(graph, { audit: () => {}, now: CLOCK, roles: ANALYST })

  writeTool(tools).execute({ type: 'Project', id: 'P-001', data: { status: 'OnTrack' } }, { agentId: 'analyst-session-1' })

  const updated = graph.byId.get('Project:P-001')
  assert.equal(updated?.data.status, 'OnTrack')
  assert.equal(updated?.data.customer, 'CUST-ACME')
  assert.equal(updated?.data.owner, 'EMP-RIVERA')
})

test('the identity field comes from `id`, so `data` cannot make name and identity disagree', (t) => {
  const root = scratchDomain('project-delivery')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const graph = loadGraph(root)
  const { tools } = deriveWriteTools(graph, { audit: () => {}, now: CLOCK, roles: ANALYST })

  writeTool(tools).execute(
    {
      type: 'Project',
      id: 'P-009',
      data: { project_id: 'P-001', customer: 'CUST-ACME', owner: 'EMP-RIVERA', status: 'OnTrack' },
    },
    { agentId: 'analyst-session-1' },
  )

  assert.equal(graph.byId.get('Project:P-009')?.data.project_id, 'P-009')
})

test('the audit records field names and never their values', (t) => {
  const root = scratchDomain('project-delivery')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: ANALYST })

  writeTool(tools).execute(
    { type: 'Issue', id: 'ISSUE-9', data: { project: 'P-001', summary: 'a distinctive value' } },
    { agentId: 'analyst-session-1' },
  )

  const line = JSON.stringify(entries.at(-1))
  assert.ok(line.includes('summary'), line)
  assert.ok(!line.includes('a distinctive value'), line)
})

test('a type declaring no written_by refuses everyone, and says so at derivation', () => {
  const root = scratchDomain('broken')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools, warnings } = deriveWriteTools(graph, { audit, now: CLOCK, roles: ANALYST })

  assert.ok(
    warnings.some((warning) => warning.includes('no object type declares written_by')),
    warnings.join('\n'),
  )
  assert.throws(
    () => writeTool(tools).execute({ type: 'Widget', id: 'W-9', data: {} }, { agentId: 'analyst-session-1' }),
    /write denied \(type-not-writable\)/,
  )
  assert.equal(entries.at(-1)?.reason, 'type-not-writable')
})

test('the write tool offers a closed enum of declared types', () => {
  const root = scratchDomain('project-delivery')
  const graph = loadGraph(root)
  const { tools } = deriveWriteTools(graph, { audit: () => {}, now: CLOCK, roles: ANALYST })

  assert.deepEqual(writeTool(tools).parameters.properties?.type?.enum, [
    'Customer',
    'Project',
    'Person',
    'Issue',
  ])
})

// ── the lifecycle and the counters, on the write path itself ────────────────────
// The pure decisions are covered in `govern/lifecycle.test.ts`; these say the write
// tool actually consults them, which is a different claim.

const CURATOR: readonly RoleRule[] = [{ prefix: 'curator-session-', role: 'curator' }]
const EDITOR: readonly RoleRule[] = [{ prefix: 'editor-session-', role: 'editor' }]
const EXECUTOR: readonly RoleRule[] = [{ prefix: 'exec-session-', role: 'executor' }]

test('a promotion the schema grants is written, and audited as a write', () => {
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: CURATOR })

  writeTool(tools).execute(
    { type: 'Pattern', id: 'PAT-B', data: { status: 'verified' } },
    { agentId: 'curator-session-1' },
  )

  const written = readFileSync(join(root, 'objects/patterns/PAT-B.yaml'), 'utf8')
  assert.match(written, /status: verified/)
  assert.equal(entries[0]?.outcome, 'allowed')
})

test('a role that may write the type may still be refused the move', () => {
  // The fixture grants `editor` the type and withholds the promotion from it: editing a
  // claim and vouching for it are different rights, and this is where that shows.
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: EDITOR })

  assert.throws(
    () =>
      writeTool(tools).execute(
        { type: 'Pattern', id: 'PAT-B', data: { status: 'verified' } },
        { agentId: 'editor-session-1' },
      ),
    /write denied \(transition-not-permitted\)/,
  )
  const untouched = readFileSync(join(root, 'objects/patterns/PAT-B.yaml'), 'utf8')
  assert.match(untouched, /status: candidate/)
  assert.equal(entries[0]?.reason, 'transition-not-permitted')
})

test('a state that was never declared cannot be written at all', () => {
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: CURATOR })

  assert.throws(
    () =>
      writeTool(tools).execute(
        { type: 'Pattern', id: 'PAT-B', data: { status: 'blessed' } },
        { agentId: 'curator-session-1' },
      ),
    /write denied \(unknown-state\)/,
  )
})

test('a role that may record usage may count without being allowed to author', () => {
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { audit } = collector()
  const { tools } = deriveWriteTools(graph, {
    audit,
    now: CLOCK,
    roles: [...CURATOR, ...EXECUTOR],
  })

  // The executor may move a counter …
  const { entries } = collector()
  const withAudit = deriveWriteTools(graph, {
    audit: entries.push.bind(entries),
    now: CLOCK,
    roles: [...CURATOR, ...EXECUTOR],
  })
  writeTool(withAudit.tools).execute(
    { type: 'Pattern', id: 'PAT-A', data: {}, increment: { hits: 1 } },
    { agentId: 'exec-session-1' },
  )
  assert.match(readFileSync(join(root, 'objects/patterns/PAT-A.yaml'), 'utf8'), /hits: 3/)
  // The trail names the counter that moved; an increment otherwise records nothing moved.
  assert.deepEqual(entries[0]?.fields, ['hits'])

  // … but may not write the entity itself: `written_by` still governs that.
  assert.throws(
    () =>
      writeTool(tools).execute(
        { type: 'Pattern', id: 'PAT-A', data: { claim: 'rewritten' } },
        { agentId: 'exec-session-1' },
      ),
    /write denied \(role-not-permitted\)/,
  )
})

test('the author role may not move the counter', () => {
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: CURATOR })

  assert.throws(
    () =>
      writeTool(tools).execute(
        { type: 'Pattern', id: 'PAT-A', data: {}, increment: { hits: 1 } },
        { agentId: 'curator-session-1' },
      ),
    /write denied \(increment-not-permitted\)/,
  )
  assert.match(entries[0]?.detail ?? '', /executor/)
})

test('incrementing a field that is not a counter is refused, and says how to make it one', () => {
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: [...CURATOR, ...EXECUTOR] })

  assert.throws(
    () =>
      writeTool(tools).execute(
        { type: 'Pattern', id: 'PAT-A', data: {}, increment: { status: 1 } },
        { agentId: 'exec-session-1' },
      ),
    /write denied \(not-a-counter\)/,
  )
  assert.match(entries[0]?.detail ?? '', /increment_by/)
})

test('a delta that is not a whole number is refused', () => {
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: [...CURATOR, ...EXECUTOR] })

  for (const delta of [1.5, 0, '1']) {
    assert.throws(
      () =>
        writeTool(tools).execute(
          { type: 'Pattern', id: 'PAT-A', data: {}, increment: { hits: delta } },
          { agentId: 'exec-session-1' },
        ),
      /write denied \(invalid-increment\)/,
      String(delta),
    )
  }
})

test('a counter that does not exist yet starts from zero rather than failing', () => {
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { audit } = collector()
  const { tools } = deriveWriteTools(graph, { audit, now: CLOCK, roles: [...CURATOR, ...EXECUTOR] })

  writeTool(tools).execute(
    { type: 'Pattern', id: 'PAT-B', data: {}, increment: { hits: 1 } },
    { agentId: 'exec-session-1' },
  )
  assert.match(readFileSync(join(root, 'objects/patterns/PAT-B.yaml'), 'utf8'), /hits: 1/)
})
