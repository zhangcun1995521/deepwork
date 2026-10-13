import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph } from './engine/graph.ts'
import { domainSnapshot } from './web.ts'

/** Resolve a fixture domain directory, independent of the working directory. */
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url))

/** The shipped example, which the panel is expected to be pointed at. */
const example = (): string =>
  fileURLToPath(new URL('../examples/project-delivery', import.meta.url))

test('the snapshot reports what the engine found, in the engine\'s own vocabulary', () => {
  const snapshot = domainSnapshot(loadGraph(example()), [])

  assert.equal(snapshot.summary.objects, 16)
  assert.equal(snapshot.summary.objectTypes, 5)
  assert.equal(snapshot.summary.linkTypes, 6)
  assert.equal(snapshot.summary.declaredFunctions, 7)
  assert.deepEqual(snapshot.warnings.load, [])
  assert.deepEqual(snapshot.warnings.derivation, [])
  assert.equal(snapshot.objectTypes.length, 5)
  assert.equal(snapshot.linkTypes.length, 6)
})

test('with no role map there is no write tool, matching the plugin', () => {
  const snapshot = domainSnapshot(loadGraph(example()), [])

  assert.equal(snapshot.summary.readTools, 4)
  assert.equal(snapshot.summary.writeTools, 0)
  assert.deepEqual(snapshot.tools.write, [])
})

test('a supplied role map produces the write tool, and is echoed back', () => {
  const roles = [{ prefix: 'session-', role: 'delivery-lead' }]
  const snapshot = domainSnapshot(loadGraph(example()), roles)

  assert.deepEqual(snapshot.roles, roles)
  assert.equal(snapshot.summary.writeTools, 1)
  assert.deepEqual(
    snapshot.tools.write.map((tool) => tool.name),
    ['ontology_write'],
  )
})

test('a role map nobody matches still registers the tool — authority is per call', () => {
  // The write tool exists because the deployment said who may write; whether a given
  // caller qualifies is decided at call time, not at derivation time. Conflating the two
  // would make the panel unable to answer "what would this role see".
  const snapshot = domainSnapshot(loadGraph(example()), [{ prefix: 'nobody-', role: 'ghost' }])

  assert.equal(snapshot.summary.writeTools, 1)
})

test('entities are an index, not their contents', () => {
  const snapshot = domainSnapshot(loadGraph(example()), [])

  assert.equal(snapshot.entities.length, 16)
  for (const entity of snapshot.entities) {
    assert.deepEqual(Object.keys(entity).sort(), ['id', 'type'])
  }
})

test('object types carry the declarations that govern writes', () => {
  const snapshot = domainSnapshot(loadGraph(example()), [])
  const project = snapshot.objectTypes.find((type) => type.name === 'Project')

  assert.equal(project?.primaryKey, 'project_id')
  assert.deepEqual(project?.writtenBy, ['delivery-lead', 'system'])
  assert.equal(project?.instances, 3)
  assert.ok((project?.fieldCount ?? 0) > 0)
})

test('relations expose the field they read, which is what explains an empty result', () => {
  const snapshot = domainSnapshot(loadGraph(example()), [])
  const belongsTo = snapshot.linkTypes.find((link) => link.name === 'belongs_to')

  // `via` differs from the relation name, so this is exactly the case a reader would
  // otherwise have to guess at.
  assert.equal(belongsTo?.field, 'customer')
  assert.equal(belongsTo?.via, 'customer')
  assert.equal(belongsTo?.edges, 3)

  const owns = snapshot.linkTypes.find((link) => link.name === 'owns')
  assert.equal(owns?.field, 'owns')
  assert.equal(owns?.via, undefined)
})

test('a malformed domain reaches the panel with its warnings attached', () => {
  const snapshot = domainSnapshot(loadGraph(fixture('broken')), [])

  assert.ok(snapshot.warnings.load.length > 0)
  assert.ok(snapshot.warnings.derivation.length > 0)
  // And the panel still has something to render: a broken declaration degrades itself.
  assert.ok(snapshot.objectTypes.length > 0)
})

test('the snapshot carries a declared lifecycle, so a reader can see the rules', () => {
  // Added when the panel's data gained states and transitions. The demo script prints them
  // and the panel will render them, so the shape is asserted here rather than left to two
  // consumers to discover separately.
  const snapshot = domainSnapshot(
    loadGraph(fixture('review-delivery')),
    [{ prefix: 'session-', role: 'engineer' }],
  )
  const deliverable = snapshot.objectTypes.find((type) => type.name === 'Deliverable')
  assert.equal(deliverable?.lifecycle?.field, 'state')
  assert.deepEqual(deliverable?.lifecycle?.states, ['draft', 'signed_off'])
  assert.equal(deliverable?.lifecycle?.transitions[0]?.requiresReview, true)
  assert.equal(deliverable?.lifecycle?.transitions[0]?.by.join(','), 'engineer')

  const signoff = snapshot.objectTypes.find((type) => type.name === 'Signoff')
  assert.equal(signoff?.lifecycle, undefined, 'a type without a lifecycle declares none')
})
