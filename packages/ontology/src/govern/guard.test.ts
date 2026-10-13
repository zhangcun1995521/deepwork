/**
 * Tests for the write guard.
 *
 * These run without the runtime, without an API key and without a domain on disk:
 * the guard is a function over arguments, so it can be tested as one. That is the
 * point of keeping the policy out of the tool bodies.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'

import type { ObjectTypeDecl } from '../engine/schema.ts'
import type { RoleRule } from './permission.ts'
import { UNCOVERED_BY_GUARD, writeGuard, writableDirectories } from './guard.ts'
import { extractPathFromArgs, extractPathsFromShell, isInside } from './path.ts'

/** Minimal object type; only the fields the guard reads are meaningful. */
function type(name: string, directory: string, writtenBy: string[]): ObjectTypeDecl {
  return { name, directory, writtenBy } as ObjectTypeDecl
}

const CWD = resolve('/work')
const ROOT = resolve('/work/domain')
const ROLES: RoleRule[] = [{ prefix: 'lead-', role: 'delivery-lead' }]

const TYPES = [
  type('Engagement', 'cases', ['delivery-lead']),
  type('Pattern', 'patterns', ['curator']),
]

function guard() {
  return writeGuard({ cwd: CWD, ontologyRoot: ROOT, roles: ROLES, objectTypes: TYPES })
}

test('a write inside the role\'s declared directory is allowed', () => {
  const result = guard()({ name: 'write', arguments: { path: 'domain/cases/a/state.md' }, agentId: 'lead-1' })
  assert.equal(result, undefined)
})

test('a write outside every declared directory is refused, with the directory named', () => {
  const result = guard()({ name: 'write', arguments: { path: 'notes/plan.md' }, agentId: 'lead-1' })
  assert.equal(typeof result, 'string')
  assert.match(result as string, /outside the directories/)
  assert.match(result as string, /cases/)
})

test('a path that escapes through .. is refused', () => {
  const result = guard()({ name: 'write', arguments: { path: 'domain/cases/../../elsewhere.md' }, agentId: 'lead-1' })
  assert.equal(typeof result, 'string')
})

test('a write tool with no discoverable path is refused rather than allowed', () => {
  // The implementation this was ported from returned undefined here, so renaming
  // the argument field would silently switch the guard off.
  const result = guard()({ name: 'write', arguments: { content: 'hello' }, agentId: 'lead-1' })
  assert.equal(typeof result, 'string')
  assert.match(result as string, /no path found/)
})

test('an unrecognised caller is refused', () => {
  const result = guard()({ name: 'write', arguments: { path: 'domain/cases/a.md' }, agentId: 'stranger-9' })
  assert.match(result as string, /matches no configured role/)
})

test('a deployment with no roles configured refuses every write', () => {
  const noRoles = writeGuard({ cwd: CWD, ontologyRoot: ROOT, roles: [], objectTypes: TYPES })
  const result = noRoles({ name: 'write', arguments: { path: 'domain/cases/a.md' }, agentId: 'lead-1' })
  assert.match(result as string, /read-only/)
})

test('a role named in written_by but with no directory anywhere is refused', () => {
  const onlyCurator = writeGuard({
    cwd: CWD,
    ontologyRoot: ROOT,
    roles: [{ prefix: 'c-', role: 'nobody' }],
    objectTypes: TYPES,
  })
  const result = onlyCurator({ name: 'write', arguments: { path: 'domain/cases/a.md' }, agentId: 'c-1' })
  assert.match(result as string, /not named in written_by/)
})

test('a shell redirect outside the declared directories is refused', () => {
  const result = guard()({ name: 'bash', arguments: { command: 'echo x > /etc/hosts' }, agentId: 'lead-1' })
  assert.match(result as string, /redirects into/)
})

test('pwsh is covered as well as bash', () => {
  const result = guard()({ name: 'pwsh', arguments: { command: 'Set-Content x > ../../evil.txt' }, agentId: 'lead-1' })
  assert.equal(typeof result, 'string')
})

test('a shell redirect into a permitted directory is allowed', () => {
  const result = guard()({ name: 'pwsh', arguments: { command: 'echo ok > domain/cases/a/log.md' }, agentId: 'lead-1' })
  assert.equal(result, undefined)
})

test('writing to a device file is not treated as an escape', () => {
  const result = guard()({ name: 'bash', arguments: { command: 'run 2>/dev/null' }, agentId: 'lead-1' })
  assert.equal(result, undefined)
})

test('a shell command that does not redirect is allowed', () => {
  const result = guard()({ name: 'bash', arguments: { command: 'ls -la' }, agentId: 'lead-1' })
  assert.equal(result, undefined)
})

test('non-write tools are untouched', () => {
  const result = guard()({ name: 'read', arguments: { path: '/etc/passwd' }, agentId: 'lead-1' })
  assert.equal(result, undefined)
})

test('a directory equal to the base is not inside it', () => {
  assert.equal(isInside('/work/domain/cases', '/work/domain/cases'), false)
  assert.equal(isInside('/work/domain/cases', '/work/domain/cases-extra/x'), false)
  assert.equal(isInside('/work/domain/cases', '/work/domain/cases/a'), true)
})

test('writable directories come from the schema, and skip types without one', () => {
  const dirs = writableDirectories([...TYPES, type('Ghost', '', ['delivery-lead'])], 'delivery-lead', ROOT)
  assert.equal(dirs.length, 1)
  assert.equal(dirs[0], resolve(ROOT, 'cases'))
})

test('path extraction reads the field names the shipped tools use', () => {
  assert.equal(extractPathFromArgs({ file_path: 'a.md' }), 'a.md')
  assert.equal(extractPathFromArgs({ path: 'a.md' }), 'a.md')
  assert.equal(extractPathFromArgs({ content: 'x' }), undefined)
})

test('shell extraction finds redirects and tee targets', () => {
  assert.deepEqual(extractPathsFromShell('echo a > one.md', CWD), [resolve(CWD, 'one.md')])
  assert.deepEqual(extractPathsFromShell('echo a | tee two.md', CWD), [resolve(CWD, 'two.md')])
  assert.deepEqual(extractPathsFromShell('echo a > /dev/null', CWD), [])
  assert.deepEqual(extractPathsFromShell(undefined, CWD), [])
})

test('the gap the guard does not cover is stated, not implied', () => {
  assert.ok(UNCOVERED_BY_GUARD.some((item) => item.includes('sed -i')))
})

test('every decision reaches the audit sink, refusals and allowances alike', () => {
  const seen: { denied: boolean; reason?: string; target?: string; role?: string }[] = []
  const audited = writeGuard({
    cwd: CWD,
    ontologyRoot: ROOT,
    roles: ROLES,
    objectTypes: TYPES,
    onDecision: (decision) => seen.push(decision),
  })

  audited({ name: 'write', arguments: { path: 'domain/cases/a.md' }, agentId: 'lead-1' })
  audited({ name: 'write', arguments: { path: 'elsewhere.md' }, agentId: 'lead-1' })
  audited({ name: 'read', arguments: { path: 'x' }, agentId: 'lead-1' })

  assert.equal(seen.length, 2, 'a read is not the guard\'s business and is not recorded')
  assert.deepEqual(
    seen.map((entry) => [entry.denied, entry.reason]),
    [
      [false, undefined],
      [true, 'path-outside-granted-directories'],
    ],
  )
  assert.equal(seen[1]?.role, 'delivery-lead')
  assert.match(seen[1]?.target ?? '', /elsewhere\.md$/)
})
