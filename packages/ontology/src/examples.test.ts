/**
 * Tests for the shipped example domains, driven as domains rather than as fixtures.
 *
 * The fixtures under `tests/fixtures` are deliberately tiny — they exist to pin one declaration
 * each. These are the domains a reader is pointed at, so what they demonstrate has to keep
 * working: an example that quietly stopped showing what the README says it shows is worse than
 * no example, because the README still claims it.
 *
 * `lessons` carries the whole experience loop in one place: a candidate nobody has upheld, a
 * verdict from somebody else, and a read that returns only what was vouched for.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph } from './engine/graph.ts'
import type { AuditEntry } from './govern/audit.ts'
import type { RoleRule } from './govern/permission.ts'
import type { DerivedToolSpec } from './tools/derive.ts'
import { deriveTools } from './tools/derive.ts'
import { deriveWriteTools } from './tools/write.ts'

const example = (name: string): string =>
  fileURLToPath(new URL(`../examples/${name}`, import.meta.url))

const CLOCK = (): Date => new Date('2026-10-13T09:00:00.000Z')

const CONTRIBUTOR: RoleRule = { prefix: 'contributor-', role: 'contributor' }
const CURATOR: RoleRule = { prefix: 'curator-', role: 'curator' }
const VERIFIER: RoleRule = { prefix: 'verifier-', role: 'verifier' }
const PRACTITIONER: RoleRule = { prefix: 'practitioner-', role: 'practitioner' }

/**
 * The read and write surface a deployment gets for the shipped `lessons` domain, over a
 * throwaway copy: the loop this file exercises really writes, and the example in the repository
 * has to survive the test run.
 */
function surface(roles: readonly RoleRule[], t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'deepwork-lessons-'))
  cpSync(example('lessons'), root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const graph = loadGraph(root)
  const entries: AuditEntry[] = []
  const writes = deriveWriteTools(graph, {
    roles,
    audit: (entry) => entries.push(entry),
    now: CLOCK,
  })
  return { graph, entries, ...writes }
}

function tool(tools: DerivedToolSpec[], name: string): DerivedToolSpec {
  const found = tools.find((candidate) => candidate.name === name)
  assert.ok(found !== undefined, `expected a tool named ${name}`)
  return found
}

/** Run a tool, typing the result loosely — it is a query result by construction. */
function run(spec: DerivedToolSpec, args: unknown, agentId: string): Record<string, any> {
  return (spec.execute as (args: unknown, call: unknown) => Record<string, any>)(args, {
    agentId,
  })
}

const ids = (result: Record<string, any>): string[] =>
  result.objects.map((object: { id: string }) => object.id)

test('a candidate is not what a reader gets back, and the read says how many it left out', (t) => {
  const { graph } = surface([], t)
  const find = tool(deriveTools(graph).tools, 'ontology_find')

  const result = run(find, { type: 'Lesson' }, 'anonymous')

  // LES-002 is a candidate and LES-003 was rejected; `default_state: verified` is why neither
  // comes back, and the count is reported rather than the result being quietly shorter.
  assert.deepEqual(ids(result), ['LES-001'])
  assert.equal(result.excludedByState, 2)
  assert.match(find.render({}, result), /2 more entities/)
})

test('a lesson cannot be vouched for without somebody else having vouched first', (t) => {
  const { graph, entries, tools } = surface([CURATOR], t)

  assert.throws(
    () =>
      run(
        tool(tools, 'ontology_write'),
        { type: 'Lesson', id: 'LES-002', data: { status: 'verified' } },
        'curator-session-1',
      ),
    /write denied \(review-required\)/,
  )
  assert.equal(entries.at(-1)?.reason, 'review-required')
  // The refusal names what it looked for, so the caller knows a verdict is the missing piece
  // rather than guessing at permissions.
  assert.match(entries.at(-1)?.detail ?? '', /outcome is "uphold"/)
  assert.equal(graph.byId.get('Lesson:LES-002')?.data.status, 'candidate')
})

test('the loop closes: a verdict from somebody else makes the lesson readable', (t) => {
  const { graph, tools } = surface([CURATOR, VERIFIER], t)

  // Somebody who may vouch writes the verdict. They are not the one who makes the move.
  run(
    tool(tools, 'ontology_write'),
    {
      type: 'Verdict',
      id: 'VER-002',
      data: { lesson: 'LES-002', outcome: 'uphold', basis: 'seen twice this quarter' },
    },
    'verifier-session-1',
  )

  // The move, made under a different grant from the verdict's.
  run(
    tool(tools, 'ontology_write'),
    { type: 'Lesson', id: 'LES-002', data: { status: 'verified' } },
    'curator-session-1',
  )

  const find = tool(deriveTools(graph).tools, 'ontology_find')
  const result = run(find, { type: 'Lesson' }, 'anonymous')
  assert.deepEqual(ids(result), ['LES-001', 'LES-002'])
  assert.equal(result.excludedByState, 1)
})

test('vouching and moving are separate grants, so no role can do both', (t) => {
  const { entries, tools } = surface([CURATOR, VERIFIER], t)
  const write = tool(tools, 'ontology_write')

  // A curator moves lessons and cannot write the verdict that justifies the move...
  assert.throws(
    () =>
      run(
        write,
        { type: 'Verdict', id: 'VER-003', data: { lesson: 'LES-002', outcome: 'uphold' } },
        'curator-session-1',
      ),
    /write denied \(role-not-permitted\)/,
  )

  // ...and a verifier writes verdicts and cannot move the lesson.
  assert.throws(
    () =>
      run(
        write,
        { type: 'Lesson', id: 'LES-002', data: { status: 'verified' } },
        'verifier-session-1',
      ),
    /write denied \(role-not-permitted\)/,
  )
  assert.equal(entries.filter((entry) => entry.outcome === 'denied').length, 2)
})

test('counting that a lesson was applied is a grant apart from writing one', (t) => {
  const { graph, entries, tools } = surface([CONTRIBUTOR, PRACTITIONER], t)
  const write = tool(tools, 'ontology_write')

  // A practitioner is not in `written_by`, so they cannot author a lesson...
  assert.throws(
    () =>
      run(
        write,
        { type: 'Lesson', id: 'LES-004', data: { status: 'candidate', rule: 'x' } },
        'practitioner-session-1',
      ),
    /write denied \(role-not-permitted\)/,
  )

  // ...and may still record that one was applied, which is the half of the loop that used to
  // require writing the whole entity to perform.
  run(
    write,
    { type: 'Lesson', id: 'LES-001', data: {}, increment: { applied_count: 1 } },
    'practitioner-session-1',
  )
  assert.equal(graph.byId.get('Lesson:LES-001')?.data.applied_count, 5)
  assert.equal(entries.at(-1)?.fields?.includes('applied_count'), true)
})
