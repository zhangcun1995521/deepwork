import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { filter, linksOf, loadGraph, targetsOf } from './graph.ts'

/** Resolve a fixture domain directory, independent of the working directory. */
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url))

/** Render one edge as `fromType:from->toType:to`, for readable assertions. */
const edge = (link: { fromType: string; from: string; toType: string; to: string }): string =>
  `${link.fromType}:${link.from}->${link.toType}:${link.to}`

test('loads a clean domain and reports no warnings', () => {
  const graph = loadGraph(fixture('project-delivery'))
  assert.deepEqual(graph.warnings, [])
  assert.equal(graph.objects.length, 5)
  assert.equal(graph.byType.get('Project')?.length, 2)
})

test('indexes instances by type:id', () => {
  const graph = loadGraph(fixture('project-delivery'))
  assert.deepEqual([...graph.byId.keys()].sort(), [
    'Customer:CUST-ACME',
    'Issue:ISSUE-1',
    'Person:EMP-RIVERA',
    'Project:P-001',
    'Project:P-002',
  ])
})

test('derives an array-valued field into one edge per target', () => {
  const graph = loadGraph(fixture('project-delivery'))
  assert.deepEqual(linksOf(graph, 'owns').map(edge).sort(), [
    'Customer:CUST-ACME->Project:P-001',
    'Customer:CUST-ACME->Project:P-002',
  ])
})

test('reads the field a relation names, so `via` decouples relation from data', () => {
  const graph = loadGraph(fixture('project-delivery'))

  // The relation is `belongs_to`; the field carrying it is `customer`. Without
  // `via`, this edge could only exist if the data were renamed after the relation.
  assert.deepEqual(linksOf(graph, 'belongs_to').map(edge).sort(), [
    'Project:P-001->Customer:CUST-ACME',
    'Project:P-002->Customer:CUST-ACME',
  ])
  assert.deepEqual(linksOf(graph, 'accountable').map(edge).sort(), [
    'Project:P-001->Person:EMP-RIVERA',
    'Project:P-002->Person:EMP-RIVERA',
  ])
  assert.deepEqual(linksOf(graph, 'reported_on').map(edge), ['Issue:ISSUE-1->Project:P-001'])
})

test('an edge may not cross a type the relation did not declare', () => {
  const graph = loadGraph(fixture('link-guard'))

  // B-1 is a Beta and `points_at` is declared Beta -> Alpha: exactly one edge.
  assert.deepEqual(linksOf(graph, 'points_at').map(edge), ['Beta:B-1->Alpha:A-1'])

  // A-1 carries the same field name but is an Alpha, so it must contribute nothing.
  // Without the guard, this is where a self-loop appears in the graph.
  assert.equal(linksOf(graph, 'points_at', 'A-1').length, 0)
})

test('one field name can carry two relations, told apart by the source type', () => {
  const graph = loadGraph(fixture('link-guard'))

  // Beta and Gamma both reach Alpha through a field named `points_at`, under two
  // different relations. Keying relations by field name alone would let one displace
  // the other and the displaced one would derive nothing.
  assert.deepEqual(
    linksOf(graph, 'points_at').map(edge),
    ['Beta:B-1->Alpha:A-1'],
  )
  assert.deepEqual(
    linksOf(graph, 'also_points_at').map(edge),
    ['Gamma:G-1->Alpha:A-2'],
  )
})

test('queries filter by field and resolve edges to objects', () => {
  const graph = loadGraph(fixture('project-delivery'))

  assert.deepEqual(
    filter(graph, 'Project', (project) => project.data.status === 'AtRisk').map((p) => p.id),
    ['P-001'],
  )
  assert.deepEqual(targetsOf(graph, 'reported_on', 'ISSUE-1').map((p) => p.id), ['P-001'])
  assert.deepEqual(targetsOf(graph, 'accountable', 'P-001').map((person) => person.id), ['EMP-RIVERA'])
})

test('an unknown type name yields an empty result rather than throwing', () => {
  const graph = loadGraph(fixture('project-delivery'))
  assert.deepEqual(filter(graph, 'Nonexistent', () => true), [])
  assert.deepEqual(linksOf(graph, 'nonexistent'), [])
  assert.deepEqual(targetsOf(graph, 'nonexistent'), [])
})

test('the same engine reads an unrelated domain unchanged', () => {
  const graph = loadGraph(fixture('debug'))
  assert.deepEqual(graph.warnings, [])
  assert.equal(graph.objects.length, 2)
  assert.deepEqual(targetsOf(graph, 'verdict_by', 'BUG-1').map((e) => e.id), ['ENG-ADA'])
})

test('a malformed domain still loads, and says exactly what degraded', () => {
  const graph = loadGraph(fixture('broken'))
  // Everything reported, whether it needs somebody to act or not: the point of this test is
  // that nothing degrades silently.
  const reported = [...graph.warnings, ...graph.notes].join('\n')

  assert.ok(reported.includes('directory "objects/sprockets" does not exist'), reported)
  assert.ok(reported.includes('widgets/bad-syntax.yaml'), reported)
  assert.ok(reported.includes('widgets/not-a-mapping.yaml'), reported)
  assert.ok(reported.includes('using its filename "no-key" as the identity'), reported)
  assert.ok(reported.includes('using its filename "D-1" as the identity'), reported)
  assert.ok(reported.includes('duplicate id Widget:W-1'), reported)
  assert.ok(reported.includes('has no matching object'), reported)
  assert.ok(reported.includes('unwired (expects "unwired" on Widget)'), reported)

  // Loading never aborted: the surviving instances are queryable.
  assert.equal(graph.byId.has('Widget:W-1'), true)
  assert.equal(graph.byId.has('Doohickey:D-1'), true)
})

test('a relation no instance can satisfy yields no edge, and is called out', () => {
  const graph = loadGraph(fixture('broken'))

  // Declaring a relation asserts nothing on its own: without a field carrying it,
  // there is no edge to derive.
  assert.deepEqual(linksOf(graph, 'unwired'), [])

  // That state used to be silent — the schema said the relation existed and every
  // query simply came back empty. It is now one grouped note: a relation no instance has
  // wired yet is not a defect, but it is also not nothing.
  assert.ok(
    graph.notes.some((note) =>
      note.startsWith('declared relations with no matching instance field:'),
    ),
    graph.notes.join('\n'),
  )
})

test('what needs somebody to act is separated from what the data has not grown into', () => {
  const graph = loadGraph(fixture('broken'))
  const errors = graph.warnings.join('\n')
  const notes = graph.notes.join('\n')

  // An unreadable instance file and a dropped duplicate are the author's to fix.
  assert.ok(errors.includes('widgets/bad-syntax.yaml'), errors)
  assert.ok(errors.includes('widgets/not-a-mapping.yaml'), errors)
  assert.ok(errors.includes('duplicate id Widget:W-1'), errors)
  assert.ok(errors.includes('has no matching object'), errors)

  // An empty declared directory, an identity that fell back to the filename, and a relation
  // nothing has wired are facts about the data, and judging them as defects red-lights a domain
  // that loads and answers correctly.
  assert.ok(notes.includes('directory "objects/sprockets" does not exist'), notes)
  assert.ok(notes.includes('using its filename "no-key" as the identity'), notes)
  assert.ok(notes.includes('unwired (expects "unwired" on Widget)'), notes)
  assert.equal(errors.includes('objects/sprockets'), false, errors)
})

test('a duplicate id resolves deterministically to the first file in sorted order', () => {
  const graph = loadGraph(fixture('broken'))
  // Directory listing is sorted before reading, so `W-1.yaml` precedes
  // `duplicate-of-W-1.yaml` regardless of what the filesystem returns.
  assert.equal(graph.byId.get('Widget:W-1')?.file, 'objects/widgets/W-1.yaml')
})

test('a link to a missing object is reported, and the report is capped', () => {
  const graph = loadGraph(fixture('broken'))
  const reported = graph.warnings.filter((warning) => warning.includes('has no matching object'))
  assert.equal(reported.length, 1)
  assert.ok(reported[0]?.includes('Widget:W-1 -[mounts]-> Gadget:GADGET-404'), reported[0])
})
