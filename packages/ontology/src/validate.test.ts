/**
 * Tests for domain validation.
 *
 * The command exists because a malformed declaration used to be silent: the domain loaded,
 * the panel rendered, and a capability was simply absent. These say what counts as a problem
 * and — the part worth defending — what does not, because a check that fails on a sound domain
 * is worse than no check at all.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph } from './engine/graph.ts'
import type { RoleRule } from './govern/permission.ts'
import { undeliveredActions } from './tools/actions.ts'
import { validateDomain } from './validate.ts'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url))

const DELIVERY_LEAD: readonly RoleRule[] = [{ prefix: 'session-', role: 'delivery-lead' }]

test('a sound domain validates clean', () => {
  const report = validateDomain(loadGraph(fixture('project-delivery')), DELIVERY_LEAD)

  assert.deepEqual(report.diagnostics, [])
  assert.equal(report.writesChecked, true)
  // Both declared actions derived, which is the reconciliation the command adds.
  assert.equal(report.summary.declaredActions, report.summary.derivedActions)
})

test('without roles the write half is reported as unchecked, not as clean', () => {
  const graph = loadGraph(fixture('project-delivery'))
  const report = validateDomain(graph)

  // The domain declares actions and this deployment cannot derive any of them, so a naive
  // comparison would call all of them undelivered and fail on a sound domain.
  assert.equal(graph.schema.actions.length > 0, true)
  assert.equal(report.summary.derivedActions, 0)
  assert.deepEqual(report.diagnostics, [])
  assert.equal(report.writesChecked, false)
})

test('each malformed action is named, with what was wrong with it', () => {
  const report = validateDomain(loadGraph(fixture('broken')), DELIVERY_LEAD)
  const reported = report.diagnostics.map((diagnostic) => diagnostic.message).join('\n')

  assert.ok(
    reported.includes('action "action_targets_undeclared_type" targets "Nonexistent"'),
    reported,
  )
  assert.ok(
    reported.includes('action "action_names_a_field_the_type_lacks" supplies fields mounts_typo'),
    reported,
  )
  assert.ok(
    reported.includes('action "action_use_is_neither_create_nor_update" declares use "created"'),
    reported,
  )
  assert.ok(report.diagnostics.length > 0)
})

test('declared actions that produced no tool are reported by name', () => {
  const graph = loadGraph(fixture('project-delivery'))
  const declared = graph.schema.actions.map((action) => action.name)

  // The property the count comparison in the summary exists for: a regression that stops
  // deriving one action shows up as a name rather than as two numbers that differ.
  assert.deepEqual(undeliveredActions(graph, declared), [])
  assert.deepEqual(undeliveredActions(graph, declared.slice(0, 1)), declared.slice(1))
})

test('a schema that cannot be read at all throws while loading', () => {
  // Not a diagnostic: there is no loaded domain to report on, so the caller reports it. The
  // command prints it as a failing domain, which is what keeps it out of the exit-code gap.
  assert.throws(() => loadGraph(fixture('not-a-mapping')), /must be a YAML mapping/)
})

test('a domain written ahead of its data is clean, with the count visible', () => {
  const report = validateDomain(loadGraph(fixture('ahead-of-its-data')), DELIVERY_LEAD)

  // Nothing to fix: an empty declared directory and a relation no instance has wired are facts
  // about the data, not defects in the declaration.
  assert.deepEqual(report.diagnostics, [])
  assert.equal(report.notes.length, 2)
  // And not hidden either: "nothing to fix" must not read as "nothing to see", because those two
  // notes are exactly what a reader wants to know before trusting an empty query result.
  assert.ok(report.notes.some((note) => note.includes('objects/contracts')), report.notes.join('\n'))
  assert.ok(report.notes.some((note) => note.includes('signs')), report.notes.join('\n'))
})

test('a defect is still a defect when the same domain also has notes', () => {
  const report = validateDomain(loadGraph(fixture('broken')), DELIVERY_LEAD)

  assert.ok(report.diagnostics.length > 0)
  assert.ok(report.notes.length > 0)
  // The two channels do not leak into each other: an unreadable instance file is not a note,
  // and an empty directory is not a problem.
  const problems = report.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
  assert.ok(problems.includes('bad-syntax.yaml'), problems)
  assert.equal(problems.includes('does not exist; no instances loaded'), false, problems)
})
