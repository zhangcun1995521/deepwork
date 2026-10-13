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
