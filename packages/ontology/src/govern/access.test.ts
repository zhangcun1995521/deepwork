/**
 * Tests for the declaration channel: a tool says what it touches, the domain says who may call it.
 *
 * The claim being pinned is the one the name lists could not make. A guard that recognises tools by
 * name governs exactly the tools its author knew about, so a capability added by another package is
 * invisible — and the failure mode is silence, not a refusal. These tests are written from the
 * capability's side: they declare a tool the guard has never heard of and check that it is judged.
 *
 * The other claim is the direction of failure. A tool that declares itself and finds no grant is
 * refused, because for a tool that runs code, "nobody said who may call this" is the worse answer.
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { createGovernanceRegistry } from './access.ts'
import { writeGuard } from './guard.ts'
import type { ObjectTypeDecl } from '../engine/schema.ts'

const ROOT = resolve('/work/domain')
const CWD = resolve('/work/workspace')

/** The smallest object type the guard needs: one role, one directory. */
function type(name: string, directory: string, writtenBy: string[]): ObjectTypeDecl {
  return {
    name,
    primaryKey: 'id',
    primaryKeySource: 'declared',
    requiredFields: [],
    fields: {},
    fileLocation: directory.length === 0 ? '' : `${directory}/x-*.yaml`,
    directory,
    writtenBy,
    raw: {},
  }
}

function guardFor(grants: Record<string, string[]>) {
  const registry = createGovernanceRegistry()
  registry.setGrants(new Map(Object.entries(grants)))
  return {
    registry,
    policy: writeGuard({
      cwd: CWD,
      ontologyRoot: ROOT,
      roles: [{ prefix: '*', role: 'engineer' }],
      objectTypes: [type('Case', 'objects/cases', ['engineer'])],
      govern: (tool) => registry.govern(tool),
    }),
  }
}

const call = (name: string, args: unknown) => ({ name, arguments: args, agentId: 'session-1' })

test('a tool the guard has never heard of is judged once it declares itself', () => {
  const { registry, policy } = guardFor({})

  assert.equal(policy(call('run_suite', { target: 'tests' })), undefined, 'undeclared: untouched')

  registry.declareTool('run_suite', { executes: ['target'] })
  assert.match(
    policy(call('run_suite', { target: 'tests' })) ?? '',
    /refused: it runs code \(target\)/,
    'declared: judged, and a tool that runs code with no grant is refused',
  )
})

test('a declared execution tool is authorised by the grant and not by a directory', () => {
  // The path is outside the domain entirely, which is the ordinary case: a project's tests live in
  // the project. A directory rule borrowed from the domain would refuse it, so the grant is what
  // authorises this — and only the grant.
  const { registry, policy } = guardFor({ run_suite: ['engineer'] })
  registry.declareTool('run_suite', { executes: ['target'] })

  assert.equal(policy(call('run_suite', { target: '../elsewhere' })), undefined)
})

test('a grant that does not name the caller refuses, and names what it does say', () => {
  const { registry, policy } = guardFor({ run_suite: ['reviewer'] })
  registry.declareTool('run_suite', { executes: ['target'] })

  const refusal = policy(call('run_suite', { target: 'tests' })) ?? ''
  assert.match(refusal, /role "engineer" is not in this domain's tool_grants/)
  assert.match(refusal, /reviewer/, 'the refusal says who may, not only who may not')
})

test('a grant to nobody is a decision, and reads differently from saying nothing', () => {
  const none = guardFor({ run_suite: [] })
  none.registry.declareTool('run_suite', { executes: ['target'] })
  assert.match(none.policy(call('run_suite', { target: 'tests' })) ?? '', /nobody is/)

  const silent = guardFor({})
  silent.registry.declareTool('run_suite', { executes: ['target'] })
  assert.match(silent.policy(call('run_suite', { target: 'tests' })) ?? '', /no tool_grants entry/)
})

test('a declared write argument is checked against the role, like the host tools are', () => {
  const { registry, policy } = guardFor({})
  registry.declareTool('record', { writes: ['file'] })

  assert.equal(policy(call('record', { file: `${ROOT}/objects/cases/C-1.yaml` })), undefined)
  assert.match(
    policy(call('record', { file: `${ROOT}/objects/people/P-1.yaml` })) ?? '',
    /outside the directories role "engineer" may write/,
  )
})

test('every declared write argument is looked at, not the first one that is granted', () => {
  // A tool naming two paths must not be authorised by the one that happens to be inside the grant.
  const { registry, policy } = guardFor({})
  registry.declareTool('move', { writes: ['from', 'to'] })

  assert.match(
    policy(call('move', { from: `${ROOT}/objects/cases/C-1.yaml`, to: `${ROOT}/objects/people/P-1.yaml` })) ?? '',
    /outside the directories/,
  )
})

test('a declaration withdrawn takes the governance with it, and only its own', () => {
  const { registry, policy } = guardFor({})
  const first = registry.declareTool('run_suite', { executes: ['target'] })
  const second = registry.declareTool('run_suite', { executes: ['target'] })

  // The superseded declaration must not be able to take away the one that replaced it.
  first()
  assert.match(policy(call('run_suite', { target: 'tests' })) ?? '', /refused/)

  second()
  assert.equal(policy(call('run_suite', { target: 'tests' })), undefined)
})

test('the host tools keep being judged with nothing declared and no lookup passed in', () => {
  // The default is the built-in table rather than "nothing is governed": forgetting to wire the
  // registry must not make the guard fail open on the tools it already knew about.
  const bare = writeGuard({
    cwd: CWD,
    ontologyRoot: ROOT,
    roles: [{ prefix: '*', role: 'engineer' }],
    objectTypes: [type('Case', 'objects/cases', ['engineer'])],
  })

  assert.match(
    bare(call('write', { path: `${ROOT}/objects/people/P-1.yaml` })) ?? '',
    /outside the directories/,
  )
  assert.equal(bare(call('some_tool_nobody_declared', { path: 'anything' })), undefined)
})
