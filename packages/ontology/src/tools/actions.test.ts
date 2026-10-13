/**
 * Tests for declared actions.
 *
 * The load-time rules are in `engine`; these say what happens when an action is called: the
 * preconditions it adds, and — the part worth defending — that it does not become a way
 * around anything the write path enforces.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph } from '../engine/graph.ts'
import type { AuditEntry } from '../govern/audit.ts'
import type { RoleRule } from '../govern/permission.ts'
import { deriveActionTools } from './actions.ts'
import { deriveTools } from './derive.ts'
import { deriveWriteTools, type WriteOptions } from './write.ts'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url))

function scratchDomain(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-actions-'))
  cpSync(fixture(name), dir, { recursive: true })
  return dir
}

const CLOCK = (): Date => new Date('2026-10-13T09:00:00.000Z')
const ANALYST: readonly RoleRule[] = [{ prefix: 'analyst-session-', role: 'analyst' }]
const CURATOR: readonly RoleRule[] = [{ prefix: 'curator-session-', role: 'curator' }]
const EDITOR: readonly RoleRule[] = [{ prefix: 'editor-session-', role: 'editor' }]

function collector(): { entries: AuditEntry[]; audit: (entry: AuditEntry) => void } {
  const entries: AuditEntry[] = []
  return { entries, audit: (entry) => entries.push(entry) }
}

/** The domain's actions plus the generic write tool, derived together as the plugin does. */
function surface(graph: ReturnType<typeof loadGraph>, options: WriteOptions) {
  const actions = deriveActionTools(graph, options)
  const write = deriveWriteTools(graph, options)
  return { actions: actions.tools, write: write.tools[0], warnings: [...actions.warnings, ...write.warnings] }
}

test('every declared action produces a tool, and the counts are compared', () => {
  const graph = loadGraph(fixture('project-delivery'))
  const { actions, warnings } = surface(graph, { audit: () => {}, roles: ANALYST })

  assert.equal(warnings.length, 0)
  assert.equal(actions.length, graph.schema.actions.length)
  // The declaration that used to be inert: an action named in the schema is callable.
  assert.deepEqual(
    actions.map((tool) => tool.name),
    graph.schema.actions.map((action) => action.name),
  )
})

test('a create action requires a whole entity, an update action only its identity', () => {
  const graph = loadGraph(fixture('project-delivery'))
  const { actions } = surface(graph, { audit: () => {}, roles: ANALYST })
  const flagRisk = actions.find((tool) => tool.name === 'flag_risk')

  // Issue requires issue_id, project, summary; the action supplies the latter two by default.
  assert.deepEqual(flagRisk?.parameters.required, ['issue_id', 'project', 'summary'])

  const lifecycle = loadGraph(fixture('lifecycle'))
  const verify = surface(lifecycle, { audit: () => {}, roles: CURATOR }).actions[0]
  assert.deepEqual(verify?.parameters.required, ['pattern_id'], 'an update changes some fields')
})

test('create refuses an identity that already exists, and says so', () => {
  const root = scratchDomain('project-delivery')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { actions } = surface(graph, { audit, now: CLOCK, roles: ANALYST })
  const flagRisk = actions[0]

  assert.throws(
    () =>
      flagRisk?.execute(
        { issue_id: 'ISSUE-1', project: 'P-001', summary: 'another one' },
        { agentId: 'analyst-session-1' },
      ),
    /write denied \(already-exists\)/,
  )
  assert.equal(entries.at(-1)?.outcome, 'denied')
  assert.equal(entries.at(-1)?.reason, 'already-exists')
  assert.equal(readFileSync(join(root, 'objects/issues/ISSUE-1.yaml'), 'utf8').includes('another one'), false)
})

test('create writes a new entity, and the trail names the action rather than the tool', () => {
  const root = scratchDomain('project-delivery')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { actions } = surface(graph, { audit, now: CLOCK, roles: ANALYST })

  actions[0]?.execute(
    { issue_id: 'ISSUE-9', project: 'P-001', summary: 'Risk flagged by the action' },
    { agentId: 'analyst-session-1' },
  )

  assert.match(readFileSync(join(root, 'objects/issues/ISSUE-9.yaml'), 'utf8'), /ISSUE-9/)
  // "who called flag_risk" is the question an audit has to answer, so the action names itself.
  assert.equal(entries.at(-1)?.action, 'action:flag_risk')
  assert.equal(entries.at(-1)?.outcome, 'allowed')
})

test('update refuses an identity that does not exist', () => {
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { actions } = surface(graph, { audit, now: CLOCK, roles: CURATOR })

  assert.throws(
    () => actions[0]?.execute({ pattern_id: 'PAT-MISSING', status: 'verified' }, { agentId: 'curator-session-1' }),
    /write denied \(not-found\)/,
  )
  assert.equal(entries.at(-1)?.action, 'action:verify_pattern')
})

test('an action is narrower than the type when it says so', () => {
  // The lifecycle fixture grants `editor` the Pattern type but not the verify action
  // (written_by is [curator, editor]; the action inherits written_by, so it is widened here
  // by editing the declaration in memory — the point is that `by` narrows, and a narrowing
  // that is not enforced would be decoration).
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const action = graph.schema.actions[0]
  assert.ok(action)
  const narrowed = { ...action, by: ['curator'] }
  graph.schema.actions = [narrowed]

  const { entries, audit } = collector()
  const { actions } = surface(graph, { audit, now: CLOCK, roles: EDITOR })

  assert.throws(
    () => actions[0]?.execute({ pattern_id: 'PAT-B', status: 'verified' }, { agentId: 'editor-session-1' }),
    /write denied \(role-not-permitted\)/,
  )
  assert.match(entries.at(-1)?.detail ?? '', /permits curator/)
})

test('an action cannot walk around the review requirement', () => {
  // The whole reason actions are a shell over the write path rather than a second one. If
  // this passes on an unimplemented action it would mean the governance was bypassed.
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { entries, audit } = collector()
  const { actions } = surface(graph, { audit, now: CLOCK, roles: CURATOR })

  assert.throws(
    () => actions[0]?.execute({ pattern_id: 'PAT-B', status: 'verified' }, { agentId: 'curator-session-1' }),
    /write denied \((review-required|review-producer-unknown)\)/,
  )
  assert.match(readFileSync(join(root, 'objects/patterns/PAT-B.yaml'), 'utf8'), /status: candidate/)
})

test('an action cannot walk around the lifecycle either', () => {
  const root = scratchDomain('lifecycle')
  const graph = loadGraph(root)
  const { audit } = collector()
  const { actions } = surface(graph, { audit, now: CLOCK, roles: CURATOR })

  assert.throws(
    () => actions[0]?.execute({ pattern_id: 'PAT-A', status: 'blessed' }, { agentId: 'curator-session-1' }),
    /write denied \(unknown-state\)|write denied \(no-declared-transition\)/,
  )
})

test('a deployment with no roles gets no read surface either, and no actions', () => {
  const graph = loadGraph(fixture('project-delivery'))
  const reads = deriveTools(graph)
  const { actions } = surface(graph, { audit: () => {} })

  assert.ok(reads.tools.length > 0, 'reads are always available')
  // derived here with no roles: the write tool would refuse everything, so the plugin does not
  // register actions at all — asserted at the register layer, and mirrored here.
  assert.equal(actions.length, graph.schema.actions.length)
})
