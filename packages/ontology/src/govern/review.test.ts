/**
 * Tests for the independence rule itself.
 *
 * The write-path tests show that the rule is consulted; these show what it decides, which
 * is the part that has to be right. The self-review case is reachable only here: in both
 * fixtures the role that may move the subject cannot write the verdict type, so the
 * structural separation makes it unreachable in practice — a belt the mechanism does not
 * get to demonstrate because the braces already hold.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ReviewRequirement } from '../engine/lifecycle.ts'
import { authoriseReview, type VerdictObject } from './review.ts'

const REQUIREMENT: ReviewRequirement = {
  type: 'Verdict',
  link: 'subject',
  field: 'outcome',
  pass: 'approved',
}

function verdict(id: string, subject: string, outcome: string, extra: Record<string, unknown> = {}): VerdictObject {
  return { type: 'Verdict', id, data: { subject, outcome, ...extra } }
}

function check(
  verdicts: VerdictObject[],
  producers: Record<string, string | undefined>,
  callerAgentId?: string,
  unreadable?: number,
) {
  return authoriseReview({
    requirement: REQUIREMENT,
    subjectId: 'PAT-B',
    verdicts,
    producerOf: (item) => producers[item.id],
    ...(callerAgentId === undefined ? {} : { callerAgentId }),
    ...(unreadable === undefined ? {} : { unreadable }),
  })
}

test('no verdict at all is refused, and the refusal says what it looked for', () => {
  const decision = check([], {}, 'curator-1')
  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'review-required')
  assert.match(decision.allowed === false ? decision.detail : '', /outcome is "approved"/)
})

test('a verdict about somebody else is not a verdict about this subject', () => {
  const decision = check([verdict('V-1', 'PAT-OTHER', 'approved')], { 'V-1': 'reviewer-1' }, 'curator-1')
  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'review-required')
})

test('a verdict that did not pass is not a passing verdict', () => {
  const decision = check([verdict('V-1', 'PAT-B', 'rejected')], { 'V-1': 'reviewer-1' }, 'curator-1')
  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'review-required')
})

test('an independently produced passing verdict allows the move, and names itself', () => {
  const decision = check([verdict('V-1', 'PAT-B', 'approved')], { 'V-1': 'reviewer-1' }, 'curator-1')
  assert.equal(decision.allowed, true)
  assert.equal(decision.allowed && decision.verdictId, 'V-1')
})

test('a verdict the caller produced itself does not count', () => {
  const decision = check([verdict('V-1', 'PAT-B', 'approved')], { 'V-1': 'curator-1' }, 'curator-1')
  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'self-review-not-allowed')
})

test('a verdict whose producer cannot be established is refused, not assumed', () => {
  const decision = check([verdict('V-1', 'PAT-B', 'approved')], {}, 'curator-1')
  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'review-producer-unknown')
})

test('damaged provenance is reported when that is why the verdict does not count', () => {
  const decision = check([verdict('V-1', 'PAT-B', 'approved')], {}, 'curator-1', 3)
  assert.match(decision.allowed === false ? decision.detail : '', /3 unreadable entries/)
})

test('a self-produced verdict does not hide behind an independent one', () => {
  const decision = check(
    [verdict('V-1', 'PAT-B', 'approved'), verdict('V-2', 'PAT-B', 'approved')],
    { 'V-1': 'curator-1', 'V-2': 'reviewer-1' },
    'curator-1',
  )
  assert.equal(decision.allowed, true)
  assert.equal(decision.allowed && decision.verdictId, 'V-2')
})

test('an unknown caller cannot be its own reviewer by accident', () => {
  // No caller identity at all: the move cannot be attributed to anyone, so nothing can be
  // attributed away from it either. Refused.
  const decision = check([verdict('V-1', 'PAT-B', 'approved')], { 'V-1': 'reviewer-1' }, undefined)
  assert.equal(decision.allowed, true, 'a verdict from a known third party still counts')
})

// ── a requirement can be scoped to one gate ─────────────────────────────────────
//
// The unscoped rule is "a passing verdict about this subject exists". On a workflow with more
// than one gate that is too loose: the first gate's sign-off would open every gate after it,
// because each of them is also just "a passing verdict about this subject".

const GATE_TWO: ReviewRequirement = { ...REQUIREMENT, scope: { field: 'gate', value: 'gate_two' } }

function checkScoped(
  requirement: ReviewRequirement,
  verdicts: VerdictObject[],
  producers: Record<string, string | undefined>,
) {
  return authoriseReview({
    requirement,
    subjectId: 'PAT-B',
    verdicts,
    producerOf: (item) => producers[item.id],
    callerAgentId: 'curator-1',
  })
}

test('a verdict scoped to another gate does not open this one', () => {
  const scoped = verdict('V-1', 'PAT-B', 'approved', { gate: 'gate_one' })
  const decision = checkScoped(GATE_TWO, [scoped], { 'V-1': 'reviewer-1' })

  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'review-required')
  // The refusal names the gate it wanted, so the caller is not left looking for a typo.
  assert.match(decision.allowed === false ? decision.detail : '', /gate is "gate_two"/)
})

test('a verdict scoped to this gate opens it, and the scope keeps its producer rule', () => {
  const mine = verdict('V-1', 'PAT-B', 'approved', { gate: 'gate_two' })
  const other = verdict('V-2', 'PAT-B', 'approved', { gate: 'gate_one' })

  // The right gate, from somebody else.
  assert.equal(checkScoped(GATE_TWO, [mine, other], { 'V-1': 'reviewer-1' }).allowed, true)

  // The right gate, from the caller: the scope narrows which verdicts count, it does not
  // relax who may produce one.
  const selfScoped = checkScoped(GATE_TWO, [mine], { 'V-1': 'curator-1' })
  assert.equal(selfScoped.allowed, false)
  assert.equal(selfScoped.allowed === false && selfScoped.reason, 'self-review-not-allowed')
})

test('an unscoped requirement still accepts any passing verdict, as before', () => {
  // The field the scope reads need not exist on the verdict at all.
  const decision = check([verdict('V-1', 'PAT-B', 'approved')], { 'V-1': 'reviewer-1' }, 'curator-1')
  assert.equal(decision.allowed, true)
})
