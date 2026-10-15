/**
 * Tests for the declaration channel: a tool says what it touches, the domain says who may call it.
 *
 * The claim being pinned is the one the name lists could not make. A guard that recognises tools by
 * name governs exactly the tools its author knew about, so a capability added by another package is
 * invisible — and the failure mode is silence, not a refusal. These tests are written from the
 * capability's side: they declare a tool the guard has never heard of and check that it is judged.
 *
 * The other claim is the direction of failure. A tool that declares itself and finds no grant is
 * refused, because for a tool that runs code, "nobody said who may run this" is the worse answer.
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

  registry.declareTool('run_suite', { executes: ['pytest'] })
  assert.match(
    policy(call('run_suite', { target: 'tests' })) ?? '',
    /refused: it runs pytest/,
    'declared: judged, and a tool that runs a program with no grant is refused',
  )
})

test('a declared execution tool is authorised by the grant and not by a directory', () => {
  // The path is outside the domain entirely, which is the ordinary case: a project's tests live in
  // the project. A directory rule borrowed from the domain would refuse it, so the grant for the
  // program is what authorises this — and only the grant.
  const { registry, policy } = guardFor({ pytest: ['engineer'] })
  registry.declareTool('run_suite', { executes: ['pytest'] })

  assert.equal(policy(call('run_suite', { target: '../elsewhere' })), undefined)
})

test('a grant that does not name the caller refuses, and names what it does say', () => {
  const { registry, policy } = guardFor({ pytest: ['reviewer'] })
  registry.declareTool('run_suite', { executes: ['pytest'] })

  const refusal = policy(call('run_suite', { target: 'tests' })) ?? ''
  assert.match(refusal, /it runs pytest/)
  assert.match(refusal, /role "engineer" is not in this domain's tool_grants/)
  assert.match(refusal, /reviewer/, 'the refusal says who may, not only who may not')
})

test('a grant to nobody is a decision, and reads differently from saying nothing', () => {
  const none = guardFor({ pytest: [] })
  none.registry.declareTool('run_suite', { executes: ['pytest'] })
  assert.match(none.policy(call('run_suite', { target: 'tests' })) ?? '', /nobody is/)

  const silent = guardFor({})
  silent.registry.declareTool('run_suite', { executes: ['pytest'] })
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
  const first = registry.declareTool('run_suite', { executes: ['pytest'] })
  const second = registry.declareTool('run_suite', { executes: ['pytest'] })

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

test('a declared program with no grant anywhere is refused, and the refusal names the program', () => {
  // The authority being judged is "which program may run", so the refusal has to say which program
  // found no grant — otherwise the operator cannot tell whether to grant the program or stop the
  // tool from declaring it.
  const { registry, policy } = guardFor({ run_suite: ['engineer'] })
  registry.declareTool('run_suite', { executes: ['pytest'] })

  const refusal = policy(call('run_suite', { target: 'tests' })) ?? ''
  assert.match(refusal, /it runs pytest/)
  assert.match(refusal, /no tool_grants entry for that program/)
})

test('a program granted to another role is refused, naming the program and the roles granted', () => {
  const { registry, policy } = guardFor({ pytest: ['reviewer', 'auditor'] })
  registry.declareTool('run_suite', { executes: ['pytest'] })

  const refusal = policy(call('run_suite', { target: 'tests' })) ?? ''
  assert.match(refusal, /it runs pytest/)
  assert.match(refusal, /role "engineer" is not in this domain's tool_grants for that program/)
  assert.match(refusal, /reviewer, auditor/, 'who may run it, not only who may not')
})

test('a program granted and the tool also granted by name is allowed', () => {
  const { registry, policy } = guardFor({ pytest: ['engineer'], run_suite: ['engineer'] })
  registry.declareTool('run_suite', { executes: ['pytest'] })

  assert.equal(policy(call('run_suite', { target: 'tests' })), undefined)
})

test('a program granted with no entry for the tool name is allowed: the name is an optional narrowing', () => {
  // The decision this pins. The program is what carries the risk and what the guard requires a
  // grant for; the tool's own name is only a further restriction a domain may write. A domain that
  // grants the program and says nothing about the name has authorised everything the tool can run.
  const { registry, policy } = guardFor({ pytest: ['engineer'] })
  registry.declareTool('run_suite', { executes: ['pytest'] })

  assert.equal(policy(call('run_suite', { target: 'tests' })), undefined)
})

test('one tool declaring two programs is refused when only one of them is granted', () => {
  // Every declared program is judged, not the first one that passes — a tool that could start two
  // programs is not authorised by the one the domain happened to name.
  const { registry, policy } = guardFor({ pytest: ['engineer'] })
  registry.declareTool('run_suite', { executes: ['pytest', 'playwright'] })

  const refusal = policy(call('run_suite', { target: 'tests' })) ?? ''
  assert.match(refusal, /it runs playwright/)
  assert.match(refusal, /no tool_grants entry for that program/)
})
