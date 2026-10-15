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
 *
 * `agreed-practice` carries the half a skill catalog cannot: the same vouched-for set written into
 * the agent's prompt, with the rules the state of the work item calls for marked within it.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph, type OntologyGraph } from './engine/graph.ts'
import { createGovernanceRegistry } from './govern/access.ts'
import type { AuditEntry } from './govern/audit.ts'
import { writeGuard, type GuardDecision } from './govern/guard.ts'
import type { RoleRule } from './govern/permission.ts'
import { deriveActionTools } from './tools/actions.ts'
import type { DerivedToolSpec } from './tools/derive.ts'
import { deriveTools } from './tools/derive.ts'
import { deriveWriteTools } from './tools/write.ts'
import { resolveActive, renderSection, selectRules, type Selection } from './inject.ts'
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
  return { graph, root, entries, ...writes, tools: [...writes.tools, ...actions.tools] }
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
  //
  // The reason is worth reading closely, because it changed: this used to be refused as
  // `role-not-permitted` — the verifier is not in `written_by` — and it is now refused as
  // `transition-not-permitted`, the verifier not being a role the move names. A pure move is
  // authorised by the transition's `by` and not by `written_by`, which keeps vouching and moving
  // apart in both directions: the grant that lets a role record a verdict is not the grant that
  // lets it act on one, and a role that may move cannot thereby author content.
  assert.throws(
    () =>
      run(
        write,
        { type: 'Lesson', id: 'LES-002', data: { status: 'verified' } },
        'verifier-session-1',
      ),
    /write denied \(transition-not-permitted\)/,
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

test('a role the move names may move without being able to author', (t) => {
  // The case a real domain hit first: "the reviewer sends it back, and the reviewer does not rewrite
  // it". Declared, both halves valid, and dead — because a pure move was being authorised by
  // `written_by` as well, and the reviewer appears in that list nowhere.
  //
  // The copy removes `curator` from `written_by` and leaves every transition exactly as declared, so
  // the only thing granting the move is the move itself.
  const root = mkdtempSync(join(tmpdir(), 'deepwork-move-only-'))
  cpSync(example('lessons'), root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const schema = join(root, 'schema.yaml')
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8').replace(
      /^    written_by: \[contributor, curator\]$/m,
      '    written_by: [contributor]',
    ),
  )

  const graph = loadGraph(root)
  const entries: AuditEntry[] = []
  const { tools } = deriveWriteTools(graph, {
    roles: [CONTRIBUTOR, CURATOR, VERIFIER],
    audit: (entry) => entries.push(entry),
    now: CLOCK,
  })
  const write = tool(tools, 'ontology_write')

  // Authoring content is refused: the curator is not in `written_by`, and a move is not authorship
  // of the fields that go with it.
  assert.throws(
    () =>
      run(
        write,
        { type: 'Lesson', id: 'LES-001', data: { rule: 'Rewritten by a mover.' } },
        'curator-session-1',
      ),
    /role-not-permitted/,
  )

  // The move itself is not: the transition names the curator, and nothing else has to.
  run(
    write,
    { type: 'Verdict', id: 'VER-900', data: { lesson: 'LES-002', outcome: 'uphold' } },
    'verifier-session-1',
  )
  run(write, { type: 'Lesson', id: 'LES-002', data: { status: 'verified' } }, 'curator-session-1')

  assert.equal(graph.byId.get('Lesson:LES-002')?.data.status, 'verified')
  assert.deepEqual(
    entries.filter((entry) => entry.outcome === 'denied').map((entry) => entry.reason),
    ['role-not-permitted'],
    'and only the authoring attempt was denied',
  )
})

// ── the same rules, written into the prompt ─────────────────────────────────────
//
// `agreed-practice` is the domain that exercises the half a skill catalog cannot: the vouched-for
// set is written into the prompt, and which of those rules the platform marks — the ones it asserts
// apply to the work in hand — is computed from the state of the work item the session names. What
// the example's README asserts about that is pinned here, because an example that quietly stopped
// showing the mechanism is worse than no example — the README still claims it.

const AUTHOR: RoleRule = { prefix: 'author-', role: 'author' }
const REVIEWER: RoleRule = { prefix: 'reviewer-', role: 'reviewer' }

const practiceSurface = (roles: readonly RoleRule[], t: TestContext) =>
  surfaceOf('agreed-practice', roles, t)

/**
 * What naming one object gets a deployment, computed the way the plugin computes it.
 *
 * Both halves matter and neither is chosen here: the product comes from the kind of thing named,
 * and the tag from the state that thing is in.
 */
function selectionFor(graph: OntologyGraph, active: string): Selection {
  const resolved = resolveActive(graph, active)
  return selectRules(graph, {
    deliverables: resolved.deliverables,
    tags: resolved.tags,
    ...(resolved.because === undefined ? {} : { because: resolved.because }),
    ...(resolved.note === undefined ? {} : { trouble: resolved.note }),
  })
}

const ruleIds = (selection: Selection): string[] => selection.rules.map((rule) => rule.id)

const markedIds = (selection: Selection): string[] =>
  selection.rules.filter((rule) => rule.marked).map((rule) => rule.id)

/** The six the domain vouches for, in the order the block reads them: by kind, then by id. */
const AGREED = ['PRA-006', 'PRA-003', 'PRA-004', 'PRA-005', 'PRA-001', 'PRA-002']

test('naming a work item marks the practices its stage calls for, and others once it moves', (t) => {
  const { graph, tools } = practiceSurface([AUTHOR, REVIEWER], t)

  // Every agreed practice is in the block whichever item is named. What the situation decides is
  // which of them are marked — and the marks are worth computing precisely because they move.
  const drafting = selectionFor(graph, 'WI-1043')
  assert.deepEqual(drafting.tags, ['stage:drafting'])
  assert.deepEqual(ruleIds(drafting), AGREED)
  assert.deepEqual(markedIds(drafting), ['PRA-001', 'PRA-002'])
  assert.equal(drafting.total, 6, 'the denominator is what the domain vouches for')
  assert.equal(drafting.available, 6, 'and naming no role means every one of them is available')

  const reviewing = selectionFor(graph, 'WI-1042')
  assert.deepEqual(reviewing.tags, ['stage:review'])
  assert.deepEqual(ruleIds(reviewing), AGREED, 'and the same six, whatever stage the item is at')
  // Five rather than three: a work item resolves to both deliverables, so a practice written about
  // either one is marked as well as the three the stage names.
  assert.deepEqual(markedIds(reviewing), ['PRA-003', 'PRA-004', 'PRA-005', 'PRA-001', 'PRA-002'])
  // Nobody typed the tag. It was read off the object, and the section says what it read, because a
  // computed situation has no other way to be checked.
  assert.match(
    reviewing.because ?? '',
    /WorkItem WI-1042 is in_review, which this domain maps to stage:review/,
  )

  // Naming the product rather than the item is the same machinery with one half empty: a product
  // has no state, so no stage tag, and the marks come from the constraint alone — which is why the
  // two deliverables mark one practice each and not the same one.
  const product = selectionFor(graph, 'DLV-WI-1043')
  assert.deepEqual(product.tags, [])
  assert.deepEqual(markedIds(product), ['PRA-001'])
  const other = selectionFor(graph, 'DLV-WI-1042')
  assert.deepEqual(other.tags, [])
  assert.deepEqual(markedIds(other), ['PRA-002'], 'the practice written about this deliverable')

  // The same item answers differently once it moves. This is the cycle turning, and the marks the
  // prompt carries turn with it.
  run(
    tool(tools, 'ontology_write'),
    { type: 'WorkItem', id: 'WI-1043', data: { stage: 'in_review' } },
    'author-session-1',
  )
  const moved = selectionFor(graph, 'WI-1043')
  assert.deepEqual(moved.tags, ['stage:review'])
  assert.deepEqual(ruleIds(moved), AGREED)
  assert.deepEqual(markedIds(moved), ['PRA-003', 'PRA-004', 'PRA-005', 'PRA-001', 'PRA-002'])
})

test('a practice nobody has agreed to is in neither surface, and is not counted as vouched for', (t) => {
  const { graph } = practiceSurface([], t)

  const catalog = experienceSkills(graph).skills.map((skill) => skill.name)
  assert.equal(catalog.length, 6)
  assert.ok(catalog.includes('practice-pra-001'), 'an agreed practice is loadable')
  assert.equal(catalog.includes('practice-pra-007'), false, 'and a candidate is not')

  // PRA-007 is a candidate written for exactly this situation. Had it been agreed it would be marked
  // here, so its absence is the lifecycle's doing rather than a routing accident.
  const selection = selectionFor(graph, 'WI-1043')
  const rendered = renderSection(selection)
  assert.match(rendered, /PRA-001/)
  assert.doesNotMatch(rendered, /PRA-007/)
  assert.equal(selection.total, 6, 'a candidate is not in the denominator either')
  assert.equal(selection.available, 6)
  assert.deepEqual(markedIds(selection), ['PRA-001', 'PRA-002'])

  // The read tools draw the same line, from the same declaration — the catalog, the listing and a
  // read are one answer asked from three directions.
  const found = run(tool(deriveTools(graph).tools, 'ontology_find'), { type: 'Practice' }, 'anonymous')
  assert.equal(found.returned, 6)
  assert.equal(found.excludedByState, 3)
})

test('the reviewer may send work back and may not rewrite it, and the author the other way round', (t) => {
  const { graph, entries, tools } = practiceSurface([AUTHOR, REVIEWER], t)
  const write = tool(tools, 'ontology_write')

  // The author may not make the return move: the transition names the reviewer and only the
  // reviewer, and a write carrying nothing but the lifecycle field is authorised by the move.
  assert.throws(
    () =>
      run(
        write,
        { type: 'WorkItem', id: 'WI-1042', data: { stage: 'draft' } },
        'author-session-1',
      ),
    /write denied \(transition-not-permitted\)/,
  )
  assert.match(entries.at(-1)?.detail ?? '', /requires one of \[reviewer\]/)
  assert.equal(graph.byId.get('WorkItem:WI-1042')?.data.stage, 'in_review')

  // The reviewer makes it while appearing in `written_by` nowhere — the case that was declared,
  // valid and dead until a pure move stopped being asked to be authorship.
  run(write, { type: 'WorkItem', id: 'WI-1042', data: { stage: 'draft' } }, 'reviewer-session-1')
  assert.equal(graph.byId.get('WorkItem:WI-1042')?.data.stage, 'draft')

  // Sending it back is not rewriting it, and the same absence from `written_by` is what says so.
  assert.throws(
    () =>
      run(
        write,
        { type: 'WorkItem', id: 'WI-1042', data: { title: 'Rewritten in review.' } },
        'reviewer-session-1',
      ),
    /write denied \(role-not-permitted\)/,
  )
  assert.equal(graph.byId.get('WorkItem:WI-1042')?.data.title, 'Rate-limit the webhook fan-out')

  // The cycle turns: the author submits it again and it is back where it started.
  run(write, { type: 'WorkItem', id: 'WI-1042', data: { stage: 'in_review' } }, 'author-session-1')
  assert.equal(graph.byId.get('WorkItem:WI-1042')?.data.stage, 'in_review')
  assert.deepEqual(
    entries.filter((entry) => entry.outcome === 'denied').map((entry) => entry.reason),
    ['transition-not-permitted', 'role-not-permitted'],
    'and those were the only two refusals',
  )
})

test('naming a work item that does not exist is reported, not quietly turned into every rule', (t) => {
  const { graph } = practiceSurface([], t)

  const resolved = resolveActive(graph, 'WI-4040')
  assert.deepEqual(resolved.deliverables, [])
  assert.deepEqual(resolved.tags, [])
  assert.match(resolved.note ?? '', /nothing in this domain is identified as "WI-4040"/)

  // An id nothing answers to states no situation, and an unstated situation is every vouched-for
  // rule — that is the safe direction and it is deliberate. What must not happen is silence: the
  // report is the whole safeguard, so it has to reach the section the model reads.
  const selection = selectionFor(graph, 'WI-4040')
  assert.equal(selection.available, selection.total, 'an unstated situation is every vouched-for rule')
  const rendered = renderSection(selection)
  assert.match(rendered, /Note for whoever configured this deployment/)
  assert.match(rendered, /nothing in this domain is identified as "WI-4040"/)
})

test('which practices govern a deliverable is a query in both directions', (t) => {
  const { graph } = practiceSurface([], t)
  const tools = deriveTools(graph).tools

  // Forward, off the relation the domain declared.
  const forward = run(
    tool(tools, 'ontology_links'),
    { relation: 'governs', from: 'PRA-002' },
    'anonymous',
  )
  assert.deepEqual(ids(forward), ['DLV-WI-1042'])

  // Backward, off a declared traversal — the direction that makes "what governs this" a question
  // the agent can ask rather than a field somebody has to be told about.
  const back = run(
    tool(tools, 'ontology_query'),
    { mode: 'practices_governing', deliverable_id: 'DLV-WI-1043' },
    'anonymous',
  )
  // PRA-007 names this deliverable too and is a candidate. The declaration's `where` is what keeps
  // an unagreed practice out of an answer about what the team has agreed: a traversal walks the
  // graph, and the state filter a read would apply is not something a walk gets for free.
  assert.deepEqual(ids(back), ['PRA-001'])
})

// ── the enterprise outside the deployment ───────────────────────────────────────
//
// `outside-systems` is where the world this deployment does not own is written down: the systems
// outside it, the routes that reach them, and the record that somebody walked one. Three claims
// are pinned here, and they are the three the example's README makes — a system outside the
// deployment is an ordinary object type, a route nobody has walked does not read as established,
// and who may reach out is a grant the domain declares rather than a habit the agent keeps.

const ENGINEER: RoleRule = { prefix: 'engineer-', role: 'engineer' }

const outside = (roles: readonly RoleRule[], t: TestContext) => surfaceOf('outside-systems', roles, t)

test('a system outside the deployment is an object type like any other', (t) => {
  const { graph } = outside([], t)
  const tools = deriveTools(graph).tools

  // The read surface is the one every domain gets, and the type is in the same argument enum as
  // every other type. Nothing in the engine has a branch that knows this one is "external", which
  // is the whole reason a domain can describe the enterprise without the engine learning it.
  assert.deepEqual(
    tools.map((spec) => spec.name),
    ['ontology_get', 'ontology_find', 'ontology_links', 'ontology_query'],
  )
  const find = tool(tools, 'ontology_find')
  assert.ok(find.parameters.properties?.type?.enum?.includes('OutsideSystem'))

  const result = run(find, { type: 'OutsideSystem' }, 'anonymous')
  assert.deepEqual(ids(result).sort(), ['SYS-FERRY', 'SYS-LANTERN'])
  assert.equal(result.excludedByState, undefined, 'nothing filters an ordinary type')

  const got = run(
    tool(tools, 'ontology_get'),
    { type: 'OutsideSystem', id: 'SYS-LANTERN' },
    'anonymous',
  )
  assert.deepEqual(ids(got), ['SYS-LANTERN'])

  // It declares no lifecycle, so there is no state to ask for — refused the way any other type
  // that declares none is refused, rather than answered with a state the engine invented.
  assert.equal(graph.schema.objectTypes.get('OutsideSystem')?.lifecycle, undefined)
  assert.throws(
    () => run(find, { type: 'OutsideSystem', state: 'confirmed' }, 'anonymous'),
    /declares no lifecycle/,
  )
})

test('a route nobody has walked is a candidate, and the read says how many it left out', (t) => {
  const { graph } = outside([], t)
  const tools = deriveTools(graph).tools
  const find = tool(tools, 'ontology_find')

  // RT-003 reaches the partner's service and is documented in as much detail as the two confirmed
  // routes: authentication, proxy, segment, three pitfalls and a date. `default_state: confirmed`
  // is why it is not in the answer, and the count is reported rather than the result being quietly
  // shorter.
  const result = run(find, { type: 'AccessRoute' }, 'anonymous')
  assert.deepEqual(ids(result).sort(), ['RT-001', 'RT-002'])
  assert.equal(result.excludedByState, 1)
  assert.match(find.render({}, result), /1 more entity is in another state/)

  // The default is a default and not a wall: asking for the state gets it, fields and all.
  const named = run(find, { type: 'AccessRoute', state: 'candidate' }, 'anonymous')
  assert.deepEqual(ids(named), ['RT-003'])

  // And a traversal does not inherit that filter. `where` in the declaration is what keeps a
  // candidate out of an answer about which routes reach a system — the same trap
  // `practices_governing` avoids in `agreed-practice`, with the same fix.
  const query = tool(tools, 'ontology_query')
  assert.deepEqual(
    ids(run(query, { mode: 'routes_reaching', system_id: 'SYS-FERRY' }, 'anonymous')),
    [],
  )
  assert.deepEqual(
    ids(run(query, { mode: 'routes_reaching', system_id: 'SYS-LANTERN' }, 'anonymous')).sort(),
    ['RT-001', 'RT-002'],
  )
})

test('reaching an outside system is a grant the domain declares, not a habit', (t) => {
  const { graph, root } = outside([ENGINEER, CURATOR], t)

  // Wired the way the plugin wires it: the domain's own grants, and a tool that declares the
  // programs it runs. `reach_system` is a connector's tool — nothing in this repository declares
  // it, which is exactly why the grant has to be in the domain, and why the entry the guard
  // requires is for `reach`, the program the connector starts, with the tool's own name held to
  // only as a narrowing.
  const registry = createGovernanceRegistry()
  registry.setGrants(graph.schema.toolGrants ?? new Map())
  registry.declareTool('reach_system', { executes: ['reach'] })

  const decisions: GuardDecision[] = []
  const policy = writeGuard({
    cwd: root,
    ontologyRoot: root,
    roles: [ENGINEER, CURATOR],
    objectTypes: graph.schema.objectTypes.values(),
    govern: (name) => registry.govern(name),
    onDecision: (decision) => decisions.push(decision),
  })
  const reach = (agentId: string) =>
    policy({
      name: 'reach_system',
      // A path outside the domain entirely, which is the ordinary case for a tool like this: there
      // is no directory rule to fall back on, so the grant is the whole of its authority.
      arguments: { route_id: 'RT-001', client: '../connectors/reach' },
      agentId,
    })

  assert.equal(reach('engineer-session-1'), undefined, 'the granted role gets through')
  assert.equal(decisions.at(-1)?.reason, undefined)

  assert.match(reach('curator-session-1') ?? '', /not in this domain's tool_grants/)
  assert.equal(decisions.at(-1)?.reason, 'tool-not-granted-to-role')
  // The refusal names who may, not only who may not, so a caller can tell a missing grant from one
  // made for somebody else.
  assert.match(decisions.at(-1)?.detail ?? '', /engineer/)

  // A tool that reaches out and finds no entry for the program it runs is refused rather than
  // licensed — "nobody said who may run this" is the worse answer to give a tool that touches
  // something outside the domain.
  registry.declareTool('push_result', { executes: ['push'] })
  assert.match(
    policy({
      name: 'push_result',
      arguments: { client: '../connectors/push' },
      agentId: 'engineer-session-1',
    }) ?? '',
    /no tool_grants entry/,
  )
  assert.equal(decisions.at(-1)?.reason, 'no-grant-declared')

  // And with no roles configured there is no caller identity to reason about at all: the
  // deployment is read-only, and the refusal says so instead of guessing a role.
  const bare: GuardDecision[] = []
  const unconfigured = writeGuard({
    cwd: root,
    ontologyRoot: root,
    roles: [],
    objectTypes: graph.schema.objectTypes.values(),
    govern: (name) => registry.govern(name),
    onDecision: (decision) => bare.push(decision),
  })
  assert.match(
    unconfigured({ name: 'reach_system', arguments: { client: '../connectors/reach' } }) ?? '',
    /read-only/,
  )
  assert.equal(bare.at(-1)?.reason, 'no-roles-configured')
})

test('a route becomes established only on a check from somebody who did not write it', (t) => {
  const { graph, entries, tools } = outside([ENGINEER, CURATOR, VERIFIER], t)
  const write = tool(tools, 'ontology_write')
  const confirm = (agentId: string) =>
    run(write, { type: 'AccessRoute', id: 'RT-003', data: { status: 'confirmed' } }, agentId)

  // The engineer who wired the route and wrote its pitfalls cannot make the move: `confirm` names
  // the curator, and being able to describe a route is not being able to settle it.
  assert.throws(() => confirm('engineer-session-1'), /transition-not-permitted/)
  assert.equal(entries.at(-1)?.reason, 'transition-not-permitted')

  // The curator may make it, and cannot make it on the check that exists: RC-003 says
  // `unreachable`, which is the honest record of a route somebody tried and could not walk.
  assert.throws(() => confirm('curator-session-1'), /review-required/)
  assert.equal(entries.at(-1)?.reason, 'review-required')
  assert.match(entries.at(-1)?.detail ?? '', /outcome is "reachable"/)
  assert.equal(graph.byId.get('AccessRoute:RT-003')?.data.status, 'candidate')

  // A check from a role that wrote neither the route nor the move. Provenance is the platform's
  // record of that, and it is what the independence rule reads.
  run(
    write,
    {
      type: 'RouteCheck',
      id: 'RC-900',
      data: { route: 'RT-003', outcome: 'reachable', checked_on: '2026-10-14' },
    },
    'verifier-session-1',
  )

  confirm('curator-session-1')
  assert.equal(graph.byId.get('AccessRoute:RT-003')?.data.status, 'confirmed')

  // And the read the deployment gets changes with it, from the same declaration as everything else.
  const result = run(tool(deriveTools(graph).tools, 'ontology_find'), { type: 'AccessRoute' }, 'anonymous')
  assert.deepEqual(ids(result).sort(), ['RT-001', 'RT-002', 'RT-003'])
  assert.equal(result.excludedByState, undefined)
})

test('the dependency chain reads one way, which is the half of impact that is answerable', (t) => {
  // The `infrastructure` example exists for both halves of one question — what does this need, and
  // what needs this — and to show that only the first one is answerable today. It is pinned here
  // because the README says so: an example that quietly stopped demonstrating its own limit would
  // leave the prose claiming something the code no longer does, which is the failure every other
  // test in this file exists to prevent.
  const graph = loadGraph(example('infrastructure'))
  const tools = deriveTools(graph).tools
  const links = (args: Record<string, unknown>) => run(tool(tools, 'ontology_links'), args, 'anonymous')

  // With the arrow: the dependent names what it depends on, so this is the direction a read can go.
  assert.deepEqual(ids(links({ relation: 'depends_on', from: 'SVC-CHECKOUT' })), ['SVC-PAYMENTS'])
  // And the machines it runs on and sits in, which is where a shared failure comes from even when
  // two services have nothing declared in common.
  assert.deepEqual(ids(links({ relation: 'hosted_by', from: 'SVC-CHECKOUT' })), ['CL-PROD-01'])
  assert.deepEqual(ids(links({ relation: 'in_cluster', from: 'DEV-01' })), ['CL-PROD-01'])
  assert.deepEqual(ids(links({ relation: 'in_rack', from: 'DEV-01' })), ['RK-01'])

  // Against the arrow — the question an incident actually asks, "payments is failing, what else is
  // affected" — returns nothing. The traversal only goes forward, so this half is a fact a person
  // reads off the relation rather than an answer the tool gives. Asserted, not merely described.
  assert.deepEqual(ids(links({ relation: 'depends_on', from: 'SVC-PAYMENTS' })), [])

  // The vouched-for state applies to infrastructure as it does everywhere else: a retired service
  // is not part of what is running, and the count is reported rather than the list being short.
  const services = run(tool(tools, 'ontology_find'), { type: 'Service' }, 'anonymous')
  assert.deepEqual(ids(services).sort(), ['SVC-CHECKOUT', 'SVC-CHECKOUT-STAGING', 'SVC-PAYMENTS'])
  assert.equal(services.excludedByState, 1)
})
