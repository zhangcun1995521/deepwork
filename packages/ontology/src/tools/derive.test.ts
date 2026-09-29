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

test('the surface is four tools, and only the dispatcher grows with the domain', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('project-delivery')))

  assert.deepEqual(warnings, [])
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ontology_get', 'ontology_find', 'ontology_links', 'ontology_query'],
  )
})

test('a domain declaring no functions gets the structural three, and no dispatcher', () => {
  const { tools, warnings } = deriveTools(loadGraph(fixture('debug')))

  assert.deepEqual(warnings, [])
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['ontology_get', 'ontology_find', 'ontology_links'],
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
