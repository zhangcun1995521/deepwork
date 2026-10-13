/**
 * Moving an object between declared states.
 *
 * This is where "knowledge somebody vouched for" becomes enforceable. A write that
 * changes a lifecycle field is not an ordinary field edit: it is a claim about the
 * object's standing, and the schema says who may make that claim and from where.
 *
 * The check lives here rather than inside the write tool so it can be tested without a
 * runtime, and so the tool has one thing to call rather than a rule to remember.
 *
 * @module @zhangcun123/ontology/govern/lifecycle
 */

import type { LifecycleDecl, TransitionDecl } from '../engine/lifecycle.ts'

/** Why a transition was refused. Machine-readable, so a caller can branch on it. */
export type TransitionDenial =
  | 'unknown-state'
  | 'no-declared-transition'
  | 'transition-not-permitted'

/** The outcome of a lifecycle check. */
export type TransitionDecision =
  | { allowed: true; change: boolean; transition?: TransitionDecl }
  | { allowed: false; reason: TransitionDenial; detail: string }

/**
 * Decide whether a write may set a lifecycle field to `next`.
 *
 * A write that leaves the state alone is not a transition: setting a record's other
 * fields must not require permission to re-affirm where it already stands. That case is
 * reported as `change: false` so the caller can say so in the audit trail rather than
 * record a promotion that never happened.
 *
 * @param lifecycle - The type's declaration.
 * @param current - State on disk, or `undefined` when the instance does not exist yet.
 * @param next - Value the write proposes. Anything but a declared state is refused.
 * @param role - Role the caller resolved to, if any.
 */
export function authoriseTransition(
  lifecycle: LifecycleDecl,
  current: string | undefined,
  next: unknown,
  role: string | undefined,
): TransitionDecision {
  const target = typeof next === 'string' ? next : ''
  if (target.length === 0 || !lifecycle.states.includes(target)) {
    return {
      allowed: false,
      reason: 'unknown-state',
      detail:
        `"${String(next)}" is not a declared state of ${lifecycle.field} ` +
        `(declared: ${lifecycle.states.join(', ')})`,
    }
  }

  const from = current === undefined || current.length === 0 ? lifecycle.initial : current
  if (from === target) {
    return { allowed: true, change: false }
  }

  const transition = lifecycle.transitions.find(
    (candidate) => candidate.to === target && candidate.from.includes(from),
  )
  if (transition === undefined) {
    const available = lifecycle.transitions
      .filter((candidate) => candidate.from.includes(from))
      .map((candidate) => `${candidate.name}→${candidate.to}`)
    return {
      allowed: false,
      reason: 'no-declared-transition',
      detail:
        `no declared transition moves ${lifecycle.field} from "${from}" to "${target}"` +
        (available.length === 0 ? `; nothing may leave "${from}"` : ` (from "${from}": ${available.join(', ')})`),
    }
  }

  if (role === undefined || !transition.by.includes(role)) {
    return {
      allowed: false,
      reason: 'transition-not-permitted',
      detail:
        `transition "${transition.name}" requires one of [${transition.by.join(', ')}]; ` +
        `caller resolved to ${role === undefined ? 'no role' : `"${role}"`}`,
    }
  }

  return { allowed: true, change: true, transition }
}
