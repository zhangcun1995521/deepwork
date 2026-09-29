import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseSchema } from './schema.ts'

/** Resolve a fixture domain directory, independent of the working directory. */
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url))

test('a missing schema file is fatal', () => {
  assert.throws(() => parseSchema(fixture('no-such-domain')), /cannot read ontology schema/)
})

test('a schema that is not a mapping is fatal', () => {
  assert.throws(() => parseSchema(fixture('not-a-mapping')), /must be a YAML mapping/)
})

test('parses object types, relations, functions and actions', () => {
  const schema = parseSchema(fixture('project-delivery'))

  assert.deepEqual([...schema.objectTypes.keys()], ['Customer', 'Project', 'Person', 'Issue'])
  assert.deepEqual(
    [...schema.linkTypes.keys()],
    ['owns', 'belongs_to', 'accountable', 'reported_on'],
  )
  assert.ok('at_risk_projects' in schema.functions)
  assert.ok('flag_risk' in schema.actionTypes)
  assert.deepEqual(schema.warnings, [])
})

test('a relation resolves which field it reads: `via` when declared, else its own name', () => {
  const schema = parseSchema(fixture('project-delivery'))

  const explicit = schema.linkTypes.get('belongs_to')
  assert.equal(explicit?.via, 'customer')
  assert.equal(explicit?.field, 'customer')

  const implicit = schema.linkTypes.get('owns')
  assert.equal(implicit?.via, undefined)
  assert.equal(implicit?.field, 'owns')
})

test('a declared primary key wins', () => {
  const project = parseSchema(fixture('project-delivery')).objectTypes.get('Project')
  assert.equal(project?.primaryKey, 'project_id')
  assert.equal(project?.primaryKeySource, 'declared')
})

test('required_fields[0] is the primary-key fallback', () => {
  const issue = parseSchema(fixture('project-delivery')).objectTypes.get('Issue')
  assert.equal(issue?.primaryKey, 'issue_id')
  assert.equal(issue?.primaryKeySource, 'required_fields')
})

test('file_location yields both the declaration and the instance directory', () => {
  const customer = parseSchema(fixture('project-delivery')).objectTypes.get('Customer')
  assert.equal(customer?.fileLocation, 'objects/customers/CUST-*.yaml')
  assert.equal(customer?.directory, 'objects/customers')
})

test('written_by is carried for the guard layer', () => {
  const project = parseSchema(fixture('project-delivery')).objectTypes.get('Project')
  assert.deepEqual(project?.writtenBy, ['analyst', 'system'])
})

test('every malformed declaration is a warning, not a failure', () => {
  const schema = parseSchema(fixture('broken'))
  const warnings = schema.warnings.join('\n')

  assert.ok(warnings.includes('object type "Gadget" declares no file_location'), warnings)
  assert.ok(warnings.includes('object type "Doohickey" declares neither primary_key'), warnings)
  assert.ok(warnings.includes('link type "missing_target" must declare both "from" and "to"'), warnings)
  assert.ok(warnings.includes('link type "unknown_target" has unknown target type "Nonexistent"'), warnings)
  assert.ok(warnings.includes('link type "phantom_source" has unknown source type "Phantom"'), warnings)

  // A relation that cannot state a direction is dropped...
  assert.equal(schema.linkTypes.has('missing_target'), false)
  // ...while one that can, but names an undeclared type, is kept and flagged.
  assert.equal(schema.linkTypes.has('unknown_target'), true)
})
