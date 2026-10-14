/**
 * Tests for the declared lifecycle: how a declaration is read, and when a move is
 * allowed.
 *
 * The interesting cases are the refusals, because those are what a lifecycle is for. A
 * state machine that only ever says yes is a comment.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseLifecycle, type LifecycleDecl } from '../engine/lifecycle.ts'
import { authoriseTransition } from './lifecycle.ts'

function declaration(raw: unknown): { lifecycle?: LifecycleDecl; warnings: string[] } {
  const warnings: string[] = []
  const lifecycle = parseLifecycle(raw, 'Pattern', warnings)
  return { ...(lifecycle === undefined ? {} : { lifecycle }), warnings }
}

const VALID = {
  field: 'status',
  initial: 'candidate',
  states: ['candidate', 'verified', 'retired'],
  transitions: {
    verify: { from: ['candidate'], to: 'verified', by: ['curator'] },
    retire: { from: ['verified'], to: 'retired', by: ['curator'] },
  },
}

test('a well-formed declaration is read as declared', () => {
  const { lifecycle, warnings } = declaration(VALID)
  assert.equal(warnings.length, 0)
  assert.equal(lifecycle?.field, 'status')
  assert.equal(lifecycle?.initial, 'candidate')
  assert.deepEqual(lifecycle?.transitions.map((t) => t.name), ['verify', 'retire'])
})

test('a declaration that cannot be understood is dropped, not half-applied', () => {
  for (const broken of [42, { initial: 'x', states: ['x'] }, { field: 'status', states: ['a'] }]) {
    const { lifecycle, warnings } = declaration(broken)
    assert.equal(lifecycle, undefined)
    assert.ok(warnings.length > 0, `expected a warning for ${JSON.stringify(broken)}`)
  }
})

test('an initial state outside the declared states invalidates the declaration', () => {
  const { lifecycle, warnings } = declaration({ ...VALID, initial: 'draft' })
  assert.equal(lifecycle, undefined)
  assert.match(warnings[0] ?? '', /initial state "draft"/)
})

test('a transition into an undeclared state is skipped and named', () => {
  const { lifecycle, warnings } = declaration({
    ...VALID,
    transitions: { promote: { from: ['candidate'], to: 'blessed', by: ['curator'] } },
  })
  assert.equal(lifecycle?.transitions.length, 0)
  assert.match(warnings.join('\n'), /transition "promote" targets "blessed"/)
})

test('a transition that names no roles survives, with a warning that nobody may do it', () => {
  const { lifecycle, warnings } = declaration({
    ...VALID,
    transitions: { verify: { from: ['candidate'], to: 'verified', by: [] } },
  })
  assert.equal(lifecycle?.transitions.length, 1)
  assert.match(warnings.join('\n'), /names no roles/)
})

test('no declaration at all is not a warning', () => {
  const { lifecycle, warnings } = declaration(undefined)
  assert.equal(lifecycle, undefined)
  assert.equal(warnings.length, 0)
})

test('leaving the state alone is not a transition', () => {
  const { lifecycle } = declaration(VALID)
  const decision = authoriseTransition(lifecycle as LifecycleDecl, 'candidate', 'candidate', 'curator')
  assert.equal(decision.allowed, true)
  assert.equal(decision.allowed && decision.change, false)
})

test('a declared move by a permitted role is allowed', () => {
  const { lifecycle } = declaration(VALID)
  const decision = authoriseTransition(lifecycle as LifecycleDecl, 'candidate', 'verified', 'curator')
  assert.equal(decision.allowed, true)
  assert.equal(decision.allowed && decision.change, true)
})

test('a declared move by the wrong role is refused, and says who could do it', () => {
  const { lifecycle } = declaration(VALID)
  const decision = authoriseTransition(lifecycle as LifecycleDecl, 'candidate', 'verified', 'executor')
  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'transition-not-permitted')
  assert.match(decision.allowed === false ? decision.detail : '', /curator/)
})

test('a caller with no role cannot move anything', () => {
  const { lifecycle } = declaration(VALID)
  const decision = authoriseTransition(lifecycle as LifecycleDecl, 'candidate', 'verified', undefined)
  assert.equal(decision.allowed, false)
  assert.match(decision.allowed === false ? decision.detail : '', /no role/)
})

test('an undeclared move is refused, and lists what is available instead', () => {
  const { lifecycle } = declaration(VALID)
  const decision = authoriseTransition(lifecycle as LifecycleDecl, 'candidate', 'retired', 'curator')
  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'no-declared-transition')
  assert.match(decision.allowed === false ? decision.detail : '', /verify→verified/)
})

test('a state that was never declared is refused before any transition is looked for', () => {
  const { lifecycle } = declaration(VALID)
  const decision = authoriseTransition(lifecycle as LifecycleDecl, 'candidate', 'blessed', 'curator')
  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'unknown-state')
})

test('an instance with no value on disk is treated as being in the initial state', () => {
  const { lifecycle } = declaration(VALID)
  const decision = authoriseTransition(lifecycle as LifecycleDecl, undefined, 'verified', 'curator')
  assert.equal(decision.allowed, true)
  assert.equal(decision.allowed && decision.change, true)
})

test('a declared move back to an earlier state is a move like any other', () => {
  // A lifecycle is a graph, not a ladder, and this pins it because the shape is easy to assume away.
  // Every example in this repository runs forwards — four gated stages, a candidate becoming
  // verified — so a reader could reasonably take "a sequence of states" to mean the states are
  // visited once, in order. They are not: a review that sends work back is a cycle, and it is
  // declared beside the move that got the work there.
  const { lifecycle } = declaration({
    ...VALID,
    transitions: {
      ...VALID.transitions,
      revise: { from: ['verified'], to: 'candidate', by: ['curator'] },
    },
  })

  const forward = authoriseTransition(lifecycle as LifecycleDecl, 'candidate', 'verified', 'curator')
  const back = authoriseTransition(lifecycle as LifecycleDecl, 'verified', 'candidate', 'curator')

  assert.equal(forward.allowed, true)
  assert.equal(back.allowed, true, 'a state that has been left may be entered again')
  assert.equal(back.allowed && back.transition?.name, 'revise')
})

test('a move nobody declared is refused, naming what was declared instead', () => {
  // The counterpart, and the sentence a domain relies on before it has decided: the engine refuses
  // rather than guessing at a path, and says which paths exist.
  const { lifecycle } = declaration(VALID)
  const wrong = authoriseTransition(lifecycle as LifecycleDecl, 'verified', 'candidate', 'curator')

  assert.equal(wrong.allowed, false)
  assert.equal(wrong.allowed === false && wrong.reason, 'no-declared-transition')
  assert.match(
    wrong.allowed === false ? wrong.detail : '',
    /no declared transition moves status from "verified" to "candidate"/,
  )
  assert.match(
    wrong.allowed === false ? wrong.detail : '',
    /from "verified": retire→retired/,
    'and it lists what could have been done instead',
  )
})

test('a state nothing leaves at all says so, which is what an undecided domain relies on', () => {
  const { lifecycle } = declaration(VALID)
  const stuck = authoriseTransition(lifecycle as LifecycleDecl, 'retired', 'candidate', 'curator')

  assert.equal(stuck.allowed, false)
  assert.match(stuck.allowed === false ? stuck.detail : '', /nothing may leave "retired"/)
})
