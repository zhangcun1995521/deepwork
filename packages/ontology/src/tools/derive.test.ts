import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph } from '../engine/graph.ts'
import { deriveTools, type DerivedToolSpec, type ToolArgs } from './derive.ts'

/** Resolve a fixture domain directory, independent of the working directory. */
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url))

/** Find a derived tool by name, failing with the actual list when it is absent. */
function toolNamed(tools: DerivedToolSpec[], name: string): DerivedToolSpec {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found, `expected a tool named ${name}; got: ${tools.map((tool) => tool.name).join(', ')}`)
  return found
}

/** The declared property names of a tool's argument schema. */
function propertyNames(tool: DerivedToolSpec): string[] {
  return Object.keys(tool.parameters.properties ?? {})
}

/** Run a tool, typing the arguments loosely — they are JSON by construction. */
function run(tool: DerivedToolSpec, args: ToolArgs) {
  return tool.execute(args)
}

test('the surface is five tools, and only the dispatcher grows with the domain', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('project-delivery')))

  assert.deepEqual(warnings, [])
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ontology_schema', 'ontology_get', 'ontology_find', 'ontology_links', 'ontology_query'],
  )
})

test('a domain declaring no functions gets the structural four, and no dispatcher', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('debug')))

  assert.deepEqual(warnings, [])
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ontology_schema', 'ontology_get', 'ontology_find', 'ontology_links'],
  )
})

test('type and relation arguments are closed enums taken from the schema', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))

  assert.deepEqual(toolNamed(tools, 'ontology_find').parameters.properties?.type?.enum, [
    'Customer',
    'Project',
    'Person',
    'Issue',
  ])
  assert.deepEqual(toolNamed(tools, 'ontology_links').parameters.properties?.relation?.enum, [
    'owns',
    'belongs_to',
    'accountable',
    'reported_on',
  ])
})

test('every tool declares a result schema that can admit a partial answer', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  for (const tool of tools) {
    assert.ok(
      tool.outputSchema.required?.includes('truncated'),
      `${tool.name} must require "truncated" so a capped result cannot look complete`,
    )
  }
})

test('ontology_get fetches one entity, and an absent id is an empty result', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const get = toolNamed(tools, 'ontology_get')

  const found = run(get, { type: 'Project', id: 'P-001' })
  assert.deepEqual(found.objects.map((object) => object.id), ['P-001'])
  assert.equal(found.total, 1)

  // Missing is an answer, not an error: the entity simply is not there.
  const absent = run(get, { type: 'Project', id: 'NOPE' })
  assert.deepEqual(absent.objects, [])
  assert.equal(absent.total, 0)
  assert.equal(absent.truncated, false)
})

test('a request naming something undeclared fails loudly', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))

  assert.throws(
    () => run(toolNamed(tools, 'ontology_get'), { type: 'Nonexistent', id: 'X' }),
    /unknown object type/,
  )
  assert.throws(
    () => run(toolNamed(tools, 'ontology_links'), { relation: 'nope', from: 'X' }),
    /unknown relation/,
  )
  assert.throws(() => run(toolNamed(tools, 'ontology_get'), { type: 'Project' }), /"id" is required/)
})

test('ontology_find narrows by exact field, by substring, or by neither', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const find = toolNamed(tools, 'ontology_find')

  assert.deepEqual(
    run(find, { type: 'Project', field: 'status', value: 'AtRisk' }).objects.map((o) => o.id),
    ['P-001'],
  )
  assert.deepEqual(
    run(find, { type: 'Project', query: 'p-00' }).objects.map((o) => o.id).sort(),
    ['P-001', 'P-002'],
  )
  assert.equal(run(find, { type: 'Project' }).objects.length, 2)
  assert.throws(() => run(find, { type: 'Project', field: 'status' }), /"value" is required/)
})

test('ontology_links follows a relation and returns targets and edges together', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))

  const result = run(toolNamed(tools, 'ontology_links'), { relation: 'reported_on', from: 'ISSUE-1' })
  assert.deepEqual(result.objects.map((object) => object.id), ['P-001'])
  assert.deepEqual(
    result.links.map((link) => `${link.fromType}:${link.from}->${link.toType}:${link.to}`),
    ['Issue:ISSUE-1->Project:P-001'],
  )
})

test('the dispatcher offers one mode per declared function', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const query = toolNamed(tools, 'ontology_query')

  assert.deepEqual(query.parameters.properties?.mode?.enum, [
    'at_risk_projects',
    'projects_for_customer',
    'blockers_of',
    'project_of_blocker',
    'find_projects',
  ])
  // The tool description carries each declaration's own words, so the model chooses
  // a mode by what the domain author wrote rather than by the mode's name alone.
  assert.ok(query.description.includes('Projects currently flagged AtRisk.'), query.description)
})

test('a mode with no declared argument runs on `mode` alone', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const query = toolNamed(tools, 'ontology_query')

  assert.deepEqual(
    run(query, { mode: 'at_risk_projects' }).objects.map((object) => object.id),
    ['P-001'],
  )
})

test('a parameterized mode takes exactly the argument its `by` named', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const query = toolNamed(tools, 'ontology_query')

  assert.deepEqual(
    run(query, { mode: 'projects_for_customer', customer: 'CUST-ACME' })
      .objects.map((object) => object.id)
      .sort(),
    ['P-001', 'P-002'],
  )
  assert.throws(
    () => run(query, { mode: 'projects_for_customer' }),
    /requires argument "customer"/,
  )
})

test('every mode\'s parameters are unioned into one schema, each naming its mode', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const query = toolNamed(tools, 'ontology_query')

  assert.deepEqual(propertyNames(query).sort(), [
    'customer',
    'issue_id',
    'mode',
    'project_id',
    'query',
  ])
  // A union is the one place the model can slip, so each argument says which mode
  // needs it.
  assert.ok(query.parameters.properties?.customer?.description?.includes('projects_for_customer'))
  assert.ok(query.parameters.properties?.project_id?.description?.includes('blockers_of'))
  assert.ok(query.parameters.properties?.query?.description?.includes('find_projects'))
})

test('a traverse mode follows the relation in its declared direction by default', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const query = toolNamed(tools, 'ontology_query')

  // `reported_on` is declared Issue -> Project, and this mode does not reverse it.
  assert.deepEqual(
    run(query, { mode: 'project_of_blocker', issue_id: 'ISSUE-1' }).objects.map((o) => o.id),
    ['P-001'],
  )
})

test('a traverse mode may run against the declared direction', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const query = toolNamed(tools, 'ontology_query')

  // "What is blocking this project" starts at the project, which the relation does
  // not point at. `direction: incoming` is what makes that question askable at all —
  // an inverse relation cannot be derived from the data.
  assert.deepEqual(
    run(query, { mode: 'blockers_of', project_id: 'P-001' }).objects.map((o) => o.id),
    ['ISSUE-1'],
  )
  assert.deepEqual(run(query, { mode: 'blockers_of', project_id: 'P-002' }).objects, [])
})

test('declare a search mode and it matches substrings, case-insensitively', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const query = toolNamed(tools, 'ontology_query')

  assert.deepEqual(
    run(query, { mode: 'find_projects', query: 'atrisk' }).objects.map((object) => object.id),
    ['P-001'],
  )
})

test('an unknown mode fails and lists what is available', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const query = toolNamed(tools, 'ontology_query')

  assert.throws(() => run(query, { mode: 'nope' }), /unknown mode "nope"[\s\S]*available modes are/)
})

test('a malformed function is dropped with a warning, and the sound one survives', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('broken')))
  const joined = warnings.join('\n')

  assert.ok(joined.includes('function "missing_use" declares use "undefined"'), joined)
  assert.ok(joined.includes('function "unknown_use" declares use "explode"'), joined)
  assert.ok(joined.includes('function "filter_without_on" uses filter_by but declares no "on"'), joined)
  assert.ok(joined.includes('function "filter_on_undeclared" targets undeclared type "Nonexistent"'), joined)
  assert.ok(joined.includes('function "traverse_without_relation"'), joined)
  assert.ok(joined.includes('function "traverse_unknown_relation"'), joined)
  assert.ok(joined.includes('function "search_without_by" uses search but declares no "by"'), joined)
  assert.ok(joined.includes('function "bad_direction" declares direction "sideways"'), joined)

  // The sound declaration still registers, which is what proves each bad one was
  // dropped on its own rather than the whole block being abandoned.
  assert.deepEqual(
    toolNamed(tools, 'ontology_query').parameters.properties?.mode?.enum,
    ['sound_mode'],
  )
})

test('a capped result says it was capped, in both the value and the prose', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')), { maxResults: 1 })
  const find = toolNamed(tools, 'ontology_find')

  const capped = run(find, { type: 'Project' })
  assert.equal(capped.total, 2)
  assert.equal(capped.returned, 1)
  assert.equal(capped.truncated, true)

  const text = find.render({}, capped)
  assert.ok(text.includes('Project P-001'), text)
  assert.ok(text.includes('(showing 1 of 2)'), text)

  const complete = run(find, { type: 'Project', field: 'status', value: 'AtRisk' })
  assert.equal(complete.truncated, false)
})

test('an empty result renders as an answer, not as silence', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const find = toolNamed(tools, 'ontology_find')

  const nothing = run(find, { type: 'Project', field: 'status', value: 'Nope' })
  assert.equal(nothing.total, 0)
  assert.equal(find.render({}, nothing), '(nothing matched)')
})

/** The shipped example is what a demo points at, so it must not drift out of validity. */
const exampleDomain = (): string =>
  fileURLToPath(new URL('../../examples/project-delivery', import.meta.url))

test('the example domain loads clean and derives exactly the surface it declares', () => {
  const graph = loadGraph(exampleDomain())
  const { tools, warnings } = deriveTools(graph)

  assert.deepEqual(graph.warnings, [])
  assert.deepEqual(warnings, [])
  assert.deepEqual(toolNamed(tools, 'ontology_query').parameters.properties?.mode?.enum, [
    'at_risk_projects',
    'projects_for_customer',
    'open_issues_of',
    'high_severity_open_issues',
    'accountable_for',
    'documents_about',
    'find_projects',
  ])
})

test('a list in `where` reads as "either of these"', () => {
  const { tools } = deriveTools(loadGraph(exampleDomain()))

  // `at_risk_projects` declares `where: { status: [AtRisk, Delayed] }`, so both the
  // AtRisk project and the Delayed one qualify, and the OnTrack one does not.
  assert.deepEqual(
    run(toolNamed(tools, 'ontology_query'), { mode: 'at_risk_projects' })
      .objects.map((object) => object.id)
      .sort(),
    ['P-2026-001', 'P-2026-003'],
  )
})

test('a declared traversal narrows what it arrives at', () => {
  const { tools } = deriveTools(loadGraph(exampleDomain()))

  // `open_issues_of` runs `reported_on` backwards and carries `where: { status: open }`.
  // The project has one closed issue, so the narrowing has to be doing the work.
  const opened = run(toolNamed(tools, 'ontology_query'), {
    mode: 'open_issues_of',
    project_id: 'P-2026-001',
  })
  assert.deepEqual(opened.objects.map((object) => object.id).sort(), [
    'ISSUE-101',
    'ISSUE-102',
    'ISSUE-103',
  ])

  // Without the narrowing the closed issue would come back too, so the reported edges
  // have to stay consistent with the entities beside them.
  assert.equal(opened.links.length, 3)
  assert.deepEqual(
    run(toolNamed(tools, 'ontology_links'), { relation: 'reported_on', from: 'ISSUE-104' })
      .objects.map((object) => object.id),
    ['P-2026-001'],
  )
})

// ── a mode that takes a set rather than a value ──────────────────────────────────
//
// Containment already falls out of a list field, so `equals` answers "has this tag". What it
// cannot answer is "has any of these tags", because its parameter is one value. That is the whole
// of what `match: overlaps` adds, and the fixture reads the same field both ways so the
// difference is the thing under test rather than an implementation detail.

test('overlaps asks a question a single value cannot, over the same field', () => {
  const { tools } = deriveTools(loadGraph(fixture('tagged')))
  const query = toolNamed(tools, 'ontology_query')
  const ids = (result: { objects: Array<{ id: string }> }): string[] =>
    result.objects.map((object) => object.id)

  // One value: containment, which is what `equals` has always done with a list field.
  assert.deepEqual(ids(run(query, { mode: 'covers_one', tags: 'ontology' }) as never), ['P-1'])
  assert.deepEqual(ids(run(query, { mode: 'covers_one', tags: 'testing' }) as never), ['P-2'])

  // A set: either tag, so both people — and one declaration, not one per tag.
  assert.deepEqual(ids(run(query, { mode: 'covers_any', tags: ['ontology', 'testing'] }) as never), [
    'P-1',
    'P-2',
  ])
  assert.deepEqual(ids(run(query, { mode: 'covers_any', tags: ['tooling'] }) as never), ['P-2'])
  assert.deepEqual(ids(run(query, { mode: 'covers_any', tags: ['nothing-still-has-this'] }) as never), [])
})

test('a mode taking a set says so in its schema, so the caller sends a set', () => {
  const { tools } = deriveTools(loadGraph(fixture('tagged')))
  const properties = (toolNamed(tools, 'ontology_query').parameters as {
    properties: Record<string, { type?: string }>
  }).properties

  // Two modes read one field two ways, and the argument name is the field name — so the schema
  // has to admit both shapes rather than advertise one and let the other mode's reader reject
  // what the schema allowed.
  const tags = properties.tags as { oneOf?: Array<{ type?: string }> }
  assert.deepEqual(
    tags.oneOf?.map((branch) => branch.type),
    ['string', 'array'],
    'both shapes are advertised, because one mode takes each',
  )
  // And a mode that needs a set refuses a single value rather than guessing — the schema admitted
  // both shapes, so the mode is the only place left that can tell the caller which one it wanted.
  assert.throws(
    () => run(toolNamed(tools, 'ontology_query'), { mode: 'covers_any', tags: 'ontology' }),
    /argument "tags" must be a list of strings/,
  )
})

test('a match nothing understands drops the mode and says what was expected', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('tagged')))
  const joined = warnings.join('\n')

  assert.ok(joined.includes('function "covers_broken" declares match "sort-of"'), joined)
  const modes = (toolNamed(tools, 'ontology_query').parameters as {
    properties: { mode: { enum: string[] } }
  }).properties.mode.enum
  assert.deepEqual(modes, ['covers_one', 'covers_any'])
})

// ── walk: a bounded walk over declared failure directions ─────────────────────────
//
// A one-hop read answers "what is wired to this"; the question an incident actually asks is
// "what does this failure reach", which is a *path* and not one edge. The fixture is a chain of
// six edges with a mutual dependency in the middle, a relation that declares a tag but no
// direction, and a cluster attached to the far end — enough that every decision this primitive
// makes shows up as a different answer: a reversed direction, a tag mistaken for a direction, a
// depth that was not clamped, or a cycle that was not deduplicated would each change the result.

/** The dispatcher of the topology fixture, whose modes are one walk each. */
const topologyQuery = (): DerivedToolSpec =>
  toolNamed(deriveTools(loadGraph(fixture('topology'))).tools, 'ontology_query')

/** Ids of the reached entities, in the order the walk reported them. */
const reached = (result: { objects: Array<{ id: string }> }): string[] =>
  result.objects.map((object) => object.id)

test('a walk is two hops deep by default, and the third hop is not there', () => {
  // SVC-1 depends_on ... depends_on SVC-7. `depends_on` declares `to_from`, so a failure on
  // SVC-7 reaches SVC-6, then SVC-5, then SVC-4 — three hops, of which the default takes two.
  const result = run(topologyQuery(), { mode: 'downstream', start: 'SVC-7' })

  assert.deepEqual(reached(result), ['SVC-6', 'SVC-5'])
  assert.deepEqual(result.objects.map((object) => object.hop), [1, 2])
  assert.equal(reached(result).includes('SVC-4'), false)
})

test('a depth above the cap is clamped to it, and the clamp is reported', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('topology')))
  const result = run(toolNamed(tools, 'ontology_query'), { mode: 'deep', start: 'SVC-7' })

  // `deep` asks for 9 hops. The chain is six edges long, so a walk that honoured 9 would return
  // SVC-1 as well; a walk that stopped at an unclamped-by-accident depth would not.
  assert.deepEqual(reached(result), ['SVC-6', 'SVC-5', 'SVC-4', 'SVC-3', 'SVC-2'])
  assert.equal(reached(result).includes('SVC-1'), false)
  assert.ok(
    warnings.join('\n').includes('function "deep" declares depth 9; walks are capped at 5 hops'),
    warnings.join('\n'),
  )
})

test('only relations that declare a failure direction are walked', () => {
  // `monitors` declares a tag (`observation`) and no direction, and its edge points exactly the
  // way a walk would follow it if a tag were read as a direction: SVC-8 monitors SVC-7, and under
  // `to_from` a failure on SVC-7 would reach SVC-8. It is not reached — a tag says what a
  // relation means, never which way a failure moves along it.
  const result = run(topologyQuery(), { mode: 'deep', start: 'SVC-7' })

  assert.equal(reached(result).includes('SVC-8'), false)
  assert.equal(reached(result).length, 5)
})

test('downstream, upstream and both follow the declared failure direction, not the arrow', () => {
  const query = topologyQuery()
  // `depends_on` is drawn SVC-4 -> SVC-5 and declares `to_from`, so what SVC-4 depends on is
  // what can kill it: downstream from SVC-4 runs toward the lower numbers, upstream toward the
  // higher ones. Swapping the two answers would be the whole failure mode this fixture exists
  // for, and each mode reaches a different set, so neither can be the other by accident.
  assert.deepEqual(reached(run(query, { mode: 'downstream', start: 'SVC-4' })), ['SVC-3', 'SVC-2'])
  assert.deepEqual(reached(run(query, { mode: 'upstream', start: 'SVC-4' })), ['SVC-5', 'SVC-6'])

  // Both reaches them together, nearest first, whichever way each was found.
  assert.deepEqual(reached(run(query, { mode: 'both_ways', start: 'SVC-4' })), [
    'SVC-3',
    'SVC-5',
    'SVC-2',
    'SVC-6',
  ])
})

test('a cycle terminates, and every entity is reported once at its shortest hop', () => {
  // SVC-5 and SVC-6 depend on each other, so each is reachable from the other and the walk from
  // SVC-7 runs into a loop. Breadth-first order makes the first arrival the shortest one, so the
  // cycle costs one skip rather than an infinite walk or a second copy of SVC-6.
  const result = run(topologyQuery(), { mode: 'deep', start: 'SVC-7' })

  assert.deepEqual(reached(result), ['SVC-6', 'SVC-5', 'SVC-4', 'SVC-3', 'SVC-2'])
  assert.deepEqual(result.objects.map((object) => object.hop), [1, 2, 3, 4, 5])
  assert.equal(new Set(reached(result)).size, reached(result).length)
})

test('each reached entity carries its hop, the relation that reached it and that tag', () => {
  const query = topologyQuery()
  // Two different relations reach two entities at the same hop — SVC-6 through `depends_on` and
  // CL-1 through `hosted_by` — so the relation has to be recorded per entity rather than per walk.
  const result = run(query, { mode: 'both_ways', start: 'SVC-7' })
  const byId = new Map(result.objects.map((object) => [object.id, object]))

  assert.deepEqual(byId.get('SVC-6'), {
    type: 'Service',
    id: 'SVC-6',
    data: { service_id: 'SVC-6', name: 'service-6', dependencies: ['SVC-7', 'SVC-5'] },
    hop: 1,
    via: 'depends_on',
    semantics_tag: 'hard_dep',
  })
  assert.equal(byId.get('CL-1')?.hop, 1)
  assert.equal(byId.get('CL-1')?.via, 'hosted_by')
  assert.equal(byId.get('CL-1')?.semantics_tag, 'runtime_dep')
  assert.equal(byId.get('SVC-5')?.hop, 2)
  assert.equal(byId.get('SVC-5')?.via, 'depends_on')

  // And the prose the model reads has to carry the same three facts, or a blast radius reaches it
  // as a list with no shape.
  assert.ok(query.render({}, result).includes('hop 1 via depends_on (hard_dep)'), query.render({}, result))
})

test('a walk narrowed by relation and by tag follows only what was named', () => {
  const query = topologyQuery()

  // Both narrowings reach the cluster, which no one-hop read can: `hosted_by` is `to_from`, so
  // upstream from a service is "what could take it down".
  assert.deepEqual(reached(run(query, { mode: 'only_depends_on', start: 'SVC-7' })), [
    'SVC-6',
    'SVC-5',
  ])
  assert.deepEqual(reached(run(query, { mode: 'only_runtime_dep', start: 'SVC-7' })), ['CL-1'])
  assert.equal(
    reached(run(query, { mode: 'only_depends_on', start: 'SVC-7' })).includes('CL-1'),
    false,
  )
})

test('a narrowing that can reach nothing says so, and answers nothing rather than everything', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('topology')))
  const query = toolNamed(tools, 'ontology_query')
  const joined = warnings.join('\n')

  // A tag no relation carries, and a tag carried by a relation that declares no direction: two
  // declarations that cannot take effect, both reported at load. Neither may fall back to walking
  // every relation, which is what ignoring the narrowing would do.
  assert.ok(joined.includes('function "narrows_to_nothing" narrows walk to no declared relation'), joined)
  assert.ok(
    joined.includes(
      'function "narrows_to_unwalkable" narrows walk to monitors, which declare no propagation direction',
    ),
    joined,
  )
  assert.deepEqual(run(query, { mode: 'narrows_to_nothing', start: 'SVC-7' }).objects, [])
  assert.deepEqual(run(query, { mode: 'narrows_to_unwalkable', start: 'SVC-7' }).objects, [])
})

test('a start id nothing holds is an empty answer, not an error', () => {
  const query = topologyQuery()
  const nothing = run(query, { mode: 'downstream', start: 'SVC-NOPE' })

  assert.deepEqual(nothing.objects, [])
  assert.equal(nothing.total, 0)
  assert.equal(nothing.truncated, false)
  assert.equal(query.render({}, nothing), '(nothing matched)')
})

test('a walk declaration nothing understands is dropped, and one that is only too deep is kept', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('topology')))
  const joined = warnings.join('\n')

  assert.ok(
    joined.includes(
      'function "sideways" declares direction "sideways"; expected downstream, upstream, both',
    ),
    joined,
  )
  // The dropped mode is gone from the enum; every sound one stays, which proves each was judged
  // on its own declaration rather than the block being abandoned.
  const modes = (toolNamed(tools, 'ontology_query').parameters as {
    properties: { mode: { enum: string[] } }
  }).properties.mode.enum
  assert.deepEqual(modes, [
    'downstream',
    'upstream',
    'both_ways',
    'deep',
    'only_depends_on',
    'only_runtime_dep',
    'narrows_to_nothing',
    'narrows_to_unwalkable',
    'with_a_filters_keys',
  ])
})

test('a walk ignores the keys a filter takes, and says so rather than pretending', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('topology')))
  const joined = warnings.join('\n')
  const query = toolNamed(tools, 'ontology_query')

  // `on` and `where` are established keys of the other primitives and mean nothing to a walk. The
  // mode still runs — it is not a malformed declaration — but the clauses are named, because an
  // author who believes a walk is filtered reads a complete answer as a narrowed one.
  assert.ok(joined.includes('function "with_a_filters_keys" declares "on", which a walk has no use for'), joined)
  assert.ok(joined.includes('function "with_a_filters_keys" declares "where", which a walk does not narrow by'), joined)
  assert.deepEqual(
    reached(run(query, { mode: 'with_a_filters_keys', start: 'SVC-7' })),
    reached(run(query, { mode: 'downstream', start: 'SVC-7' })),
  )
})

test('a walk capped by the result limit says so, and keeps its edges beside its entities', () => {
  const { tools } = deriveTools(loadGraph(fixture('topology')), { maxResults: 2 })
  const result = run(toolNamed(tools, 'ontology_query'), { mode: 'deep', start: 'SVC-7' })

  assert.equal(result.total, 5)
  assert.equal(result.returned, 2)
  assert.equal(result.truncated, true)
  // One edge per returned entity and none for the rows the cap left out, so the edges cannot
  // describe a reach the result does not show.
  assert.deepEqual(
    result.links.map((link) => `${link.from} -[${link.type}]-> ${link.to}`),
    ['SVC-6 -[depends_on]-> SVC-7', 'SVC-5 -[depends_on]-> SVC-6'],
  )
})

test('a walk mode says its bound in the description the model reads', () => {
  const query = topologyQuery()

  // The limit is not the model's to discover by asking twice: the cap is stated, and so is the
  // depth that applies to each mode — which for `deep` is the clamped one, not the declared one.
  assert.ok(query.description.includes('the cap is 5 hops'), query.description)
  assert.ok(query.description.includes('at most 2 hops'), query.description)
  assert.ok(query.description.includes('at most 5 hops'), query.description)
})

test('a relation declaring prose semantics is warned about, not silently ignored', () => {
  const graph = loadGraph(fixture('topology'))
  const joined = graph.warnings.join('\n')

  // `reports_to` writes a sentence where a tag belongs. It reads as a statement and takes effect
  // as nothing, which is the defect this check exists for — the user's own domain did exactly this.
  assert.ok(
    joined.includes(
      'relation "reports_to" declares semantics_tag "the on-call rotation owns this edge"',
    ),
    joined,
  )
  assert.ok(
    joined.includes('expected one of hard_dep, runtime_dep, traffic, aggregation, redundancy'),
    joined,
  )
  // The relation itself survives: a bad tag is not a bad relation, and dropping it would lose
  // edges that are really there.
  assert.equal(graph.schema.linkTypes.has('reports_to'), true)
  assert.equal(graph.schema.linkTypes.get('reports_to')?.semanticsTag, undefined)
})


test('ontology_schema answers what is declared: direction, edge counts, and what has none', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const schema = run(toolNamed(tools, 'ontology_schema'), {}) as {
    types: Array<{ name: string; instances: number; fields: Array<{ name: string }> }>
    relations: Array<{ name: string; from: string; to: string; via: string; edges: number; cardinality: string }>
    totals: { types: number; relations: number; objects: number; edges: number }
    unpopulatedRelations: string[]
    truncated: boolean
  }

  // Every type, with its instance count and its declared fields — the facts a caller needs before it
  // can name anything.
  assert.equal(schema.types.length, schema.totals.types)
  const project = schema.types.find((type) => type.name === 'Project')
  assert.ok(project !== undefined)
  assert.ok(project.fields.some((field) => field.name === 'customer'))

  // Direction is the load-bearing fact: it is what a caller gets wrong, and what an empty answer
  // used to conceal.
  const belongs = schema.relations.find((relation) => relation.name === 'belongs_to')
  assert.deepEqual(
    { from: belongs?.from, to: belongs?.to, via: belongs?.via },
    { from: 'Project', to: 'Customer', via: 'customer' },
  )
  assert.equal(belongs?.edges, 2)

  // This format has no cardinality, and the answer says so in words rather than leaving the field
  // out — an absent field reads as an oversight, the words read as a fact about the domain.
  assert.equal(belongs?.cardinality, 'not declared')

  assert.equal(schema.truncated, false)
})

test('ontology_schema lists the relations nothing has wired, and says so once', () => {
  // The topology fixture carries both cases on purpose: `depends_on` is populated and `reports_to`
  // is declared with no instance to wire it.
  const { tools } = deriveTools(loadGraph(fixture('topology')))
  const schema = run(toolNamed(tools, 'ontology_schema'), {}) as {
    relations: Array<{ name: string; edges: number }>
    unpopulatedRelations: string[]
  }

  const populated = schema.relations.find((relation) => relation.name === 'depends_on')
  assert.equal(populated?.edges, 7)
  // Listed here once, instead of being discovered by probing each relation's ends and mistaking
  // "I looked in the wrong place" for "there is nothing".
  assert.deepEqual(schema.unpopulatedRelations, ['reports_to', 'escalates_to'])
})

test('an empty relation walk says which kind of empty it is', () => {
  const { tools } = deriveTools(loadGraph(fixture('project-delivery')))
  const links = toolNamed(tools, 'ontology_links')
  const run1 = (relation: string, from: string) =>
    run(links, { relation, from }) as { total: number; note?: string }

  // Wrong end: `belongs_to` is Project -> Customer, and CUST-ACME is a Customer. The answer must not
  // read as "this customer has no such relation" — it is a fact about the question.
  const wrongEnd = run1('belongs_to', 'CUST-ACME')
  assert.equal(wrongEnd.total, 0)
  assert.match(wrongEnd.note ?? '', /Project -> Customer/)
  assert.match(wrongEnd.note ?? '', /wrong end/)
  assert.match(wrongEnd.note ?? '', /target side/)

  // An id no entity carries: nothing was followed, which is different from "it has none".
  const unknown = run1('belongs_to', 'PRJ-NOPE')
  assert.equal(unknown.total, 0)
  assert.match(unknown.note ?? '', /no entity in this domain has the id/)

  // And a walk that does find something carries no note at all: the caveat only appears where there
  // is an empty answer to explain.
  const found = run1('belongs_to', 'P-001')
  assert.ok(found.total > 0)
  assert.equal(found.note, undefined)
})

test('a relation nothing wired is distinguished from a route the entity lacks', () => {
  // Same tool, the topology fixture, where the two empties sit next to each other: `depends_on` is
  // populated and SVC-7 has none, while `reports_to` is populated nowhere at all.
  const { tools } = deriveTools(loadGraph(fixture('topology')))
  const links = toolNamed(tools, 'ontology_links')
  const run1 = (relation: string, from: string) =>
    run(links, { relation, from }) as { total: number; note?: string }

  const noneHere = run1('depends_on', 'SVC-7')
  assert.equal(noneHere.total, 0)
  assert.match(noneHere.note ?? '', /has 7 edges elsewhere in this domain/)
  assert.match(noneHere.note ?? '', /this Service has none/)

  const unpopulated = run1('reports_to', 'SVC-1')
  assert.equal(unpopulated.total, 0)
  assert.match(unpopulated.note ?? '', /0 edges anywhere in this domain/)
})
