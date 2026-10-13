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
import { deriveActionTools } from './tools/actions.ts'
import type { DerivedToolSpec } from './tools/derive.ts'
import { deriveTools } from './tools/derive.ts'
import { deriveWriteTools } from './tools/write.ts'
import { experienceSkills } from './skills.ts'

const example = (name: string): string =>
  fileURLToPath(new URL(`../examples/${name}`, import.meta.url))

const CLOCK = (): Date => new Date('2026-10-13T09:00:00.000Z')

const CONTRIBUTOR: RoleRule = { prefix: 'contributor-', role: 'contributor' }
const CURATOR: RoleRule = { prefix: 'curator-', role: 'curator' }
const VERIFIER: RoleRule = { prefix: 'verifier-', role: 'verifier' }
const PRACTITIONER: RoleRule = { prefix: 'practitioner-', role: 'practitioner' }

/**
 * The read and write surface a deployment gets for a shipped domain, over a throwaway copy:
 * these tests really write, and the examples in the repository have to survive the test run.
 */
function surfaceOf(domain: string, roles: readonly RoleRule[], t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `deepwork-${domain}-`))
  cpSync(example(domain), root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const graph = loadGraph(root)
  const entries: AuditEntry[] = []
  const audit = (entry: AuditEntry): void => entries.push(entry)
  const writes = deriveWriteTools(graph, { roles, audit, now: CLOCK })
  // Actions are derived apart from the write tool, and a test that wants one has to ask for it
  // here — an action is a shell over the same write path, so it needs the same audit sink.
  const actions = deriveActionTools(graph, { roles, audit })
  return { graph, entries, ...writes, tools: [...writes.tools, ...actions.tools] }
}

/** {@link surfaceOf} for the lessons example, which most of this file is about. */
const surface = (roles: readonly RoleRule[], t: TestContext) => surfaceOf('lessons', roles, t)

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

// ── the staged workflow ─────────────────────────────────────────────────────────
//
// `engagement` is the same engine moving an engagement through four phases, where entering
// each one needs the customer to have signed for it. What these pin is that the gates are a
// *sequence*: a signature opens the stage it names and no other.

const FDE: RoleRule = { prefix: 'fde-', role: 'fde' }
const CUSTOMER: RoleRule = { prefix: 'customer-', role: 'customer' }

const advance = (tools: DerivedToolSpec[], id: string, phase: string, agentId: string) =>
  run(tool(tools, 'ontology_write'), { type: 'Engagement', id, data: { phase } }, agentId)

test('a stage cannot be entered without the customer having signed for it', (t) => {
  const { graph, entries, tools } = surfaceOf('engagement', [FDE], t)

  assert.throws(() => advance(tools, 'ENG-002', 'validate', 'fde-session-1'), /review-required/)
  // The refusal names the gate, not just the requirement, so what is missing is unambiguous.
  assert.match(entries.at(-1)?.detail ?? '', /gate is "validate"/)
  assert.equal(graph.byId.get('Engagement:ENG-002')?.data.phase, 'qualify')
})

test('a signature for one stage does not open the next one', (t) => {
  const { graph, entries, tools } = surfaceOf('engagement', [FDE], t)

  // ENG-001 is at `validate`, so its validate gate is already open behind it. The signature
  // that opened it names `gate: validate`; the build gate is a different gate and stays shut,
  // which is the whole reason a requirement can carry a scope.
  assert.throws(() => advance(tools, 'ENG-001', 'build', 'fde-session-1'), /review-required/)
  assert.match(entries.at(-1)?.detail ?? '', /gate is "build"/)
  assert.equal(graph.byId.get('Engagement:ENG-001')?.data.phase, 'validate')
})

test('the road opens one stage at a time, each on its own signature', (t) => {
  const { graph, tools } = surfaceOf('engagement', [FDE, CUSTOMER], t)
  const sign = (id: string, gate: string) =>
    run(
      tool(tools, 'ontology_write'),
      { type: 'Signoff', id, data: { engagement: 'ENG-002', gate, decision: 'approved' } },
      'customer-session-1',
    )

  // Nothing signed: refused, and it stays refused however often it is attempted.
  assert.throws(() => advance(tools, 'ENG-002', 'validate', 'fde-session-1'), /review-required/)

  // Signed for the first stage: that stage opens.
  sign('SIG-100', 'validate')
  advance(tools, 'ENG-002', 'validate', 'fde-session-1')
  assert.equal(graph.byId.get('Engagement:ENG-002')?.data.phase, 'validate')

  // And the next one is still shut, on the same signature that just worked.
  assert.throws(() => advance(tools, 'ENG-002', 'build', 'fde-session-1'), /review-required/)

  // Signed for the second: it opens.
  sign('SIG-101', 'build')
  advance(tools, 'ENG-002', 'build', 'fde-session-1')
  assert.equal(graph.byId.get('Engagement:ENG-002')?.data.phase, 'build')

  // Two stages in, the third is still shut. Three gates, three signatures.
  assert.throws(() => advance(tools, 'ENG-002', 'handover', 'fde-session-1'), /review-required/)
})

test('the role that moves cannot sign, so no gate is self-service', (t) => {
  const { entries, tools } = surfaceOf('engagement', [FDE], t)

  assert.throws(
    () =>
      run(
        tool(tools, 'ontology_write'),
        {
          type: 'Signoff',
          id: 'SIG-999',
          data: { engagement: 'ENG-002', gate: 'validate', decision: 'approved' },
        },
        'fde-session-1',
      ),
    /role-not-permitted/,
  )
  assert.equal(entries.at(-1)?.reason, 'role-not-permitted')
})

test('the gated move is also refused when it is asked for through the declared action', (t) => {
  const { entries, tools } = surfaceOf('engagement', [FDE], t)

  // An action is a shell over the write path, so it inherits the gate rather than bypassing it
  // — and the refusal lands in the trail under the action's own name.
  assert.throws(
    () => run(tool(tools, 'start_build'), { engagement_id: 'ENG-001', phase: 'build' }, 'fde-session-1'),
    /review-required/,
  )
  assert.equal(entries.at(-1)?.action, 'action:start_build')
})

// ── the loop, both directions ───────────────────────────────────────────────────
//
// `lessons` is the domain where experience travels: an agent writes down what it learned, a
// second party vouches for it, and only then does it become something the agent can load. These
// pin the whole circuit — including the move that must not exist, which is vouching for itself.

test('experience goes in as a candidate, comes out as a skill only on a verdict', (t) => {
  const { graph, tools } = surfaceOf('lessons', [CONTRIBUTOR, CURATOR, VERIFIER], t)
  const write = tool(tools, 'ontology_write')
  const skills = () => experienceSkills(graph).skills.map((skill) => skill.name)

  assert.deepEqual(skills(), ['lesson-les-001'], 'the domain starts with one vouched-for lesson')

  // In. The action names the step, and what it creates is a candidate.
  run(
    tool(tools, 'record_lesson'),
    {
      lesson_id: 'LES-900',
      status: 'candidate',
      rule: 'A migration and its rollback belong in the same change.',
      applies_to: 'artifact:migration',
    },
    'contributor-session-1',
  )
  assert.equal(graph.byId.get('Lesson:LES-900')?.data.status, 'candidate')
  assert.deepEqual(skills(), ['lesson-les-001'], 'and it is not loadable yet')

  // The move that must not exist: arriving already vouched for. Two refusals, in the order the
  // write path asks its questions — the mover's role is settled first, then what the move
  // requires. A contributor may not make this move at all; a curator may make it and cannot make
  // it without a verdict. So a lesson cannot certify itself by being born.
  assert.throws(
    () =>
      run(
        write,
        { type: 'Lesson', id: 'LES-901', data: { status: 'verified', rule: 'Mine.' } },
        'contributor-session-1',
      ),
    /transition-not-permitted/,
  )
  assert.throws(
    () =>
      run(
        write,
        { type: 'Lesson', id: 'LES-902', data: { status: 'verified', rule: 'Mine.' } },
        'curator-session-1',
      ),
    /review-required/,
  )
  assert.equal(graph.byId.has('Lesson:LES-901'), false)
  assert.equal(graph.byId.has('Lesson:LES-902'), false)

  // Somebody else vouches, and the move is made by a role that is not that somebody.
  run(
    write,
    { type: 'Verdict', id: 'VER-900', data: { lesson: 'LES-900', outcome: 'uphold' } },
    'verifier-session-1',
  )
  run(
    tool(tools, 'uphold_lesson'),
    { lesson_id: 'LES-900', status: 'verified' },
    'curator-session-1',
  )

  // Out. The catalog the agent reads now contains it — built from the same state a read uses.
  assert.deepEqual(skills(), ['lesson-les-001', 'lesson-les-900'])
})
