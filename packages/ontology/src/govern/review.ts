/**
 * Independent review: a move that requires a verdict from somebody else.
 *
 * The rule the platform enforces is narrow and general — *a passing verdict for this
 * subject must exist, and its producer must not be the caller*. What a verdict means, who
 * may give one, and which object carries it are all declared by the domain. That is what
 * makes the same mechanism usable for a sign-off on a delivery, an approval on a contract,
 * or a review on a piece of knowledge, without the engine learning any of those words.
 *
 * Two cases are refused rather than assumed. A verdict produced by the caller is refused
 * by name, because that is the failure this whole mechanism exists to prevent. A verdict
 * whose producer the platform cannot establish — provenance damaged, or a write that
 * predates the record — is refused too: "we cannot tell who reviewed it" is not
 * "somebody did".
 *
 * @module @zhangcun123/ontology/govern/review
 */

import type { ReviewRequirement } from '../engine/lifecycle.ts'

/** Why a review precondition was not met. Machine-readable. */
export type ReviewDenial = 'review-required' | 'self-review-not-allowed' | 'review-producer-unknown'

/** A verdict object, as the engine holds it. */
export interface VerdictObject {
  type: string
  id: string
  data: Record<string, unknown>
}

/** The outcome of the check. */
export type ReviewDecision =
  | { allowed: true; verdictId: string }
  | { allowed: false; reason: ReviewDenial; detail: string }

/**
 * Decide whether a subject has the independent verdict its next state requires.
 *
 * @param requirement - The declared precondition.
 * @param subjectId - Id of the object being moved.
 * @param verdicts - Every object of the declared verdict type.
 * @param producerOf - Who wrote a given verdict, from platform provenance.
 * @param callerAgentId - Identity of the agent attempting the move.
 * @param unreadable - Entries of the provenance record that could not be parsed.
 */
export function authoriseReview(options: {
  requirement: ReviewRequirement
  subjectId: string
  verdicts: readonly VerdictObject[]
  producerOf: (verdict: VerdictObject) => string | undefined
  callerAgentId?: string
  unreadable?: number
}): ReviewDecision {
  const { requirement, subjectId, verdicts, producerOf, callerAgentId } = options

  const matching = verdicts.filter(
    (verdict) =>
      verdict.type === requirement.type &&
      verdict.data[requirement.link] === subjectId &&
      verdict.data[requirement.field] === requirement.pass,
  )

  if (matching.length === 0) {
    return {
      allowed: false,
      reason: 'review-required',
      detail:
        `moving this ${subjectId} requires a "${requirement.type}" whose ${requirement.link} is ` +
        `"${subjectId}" and whose ${requirement.field} is "${requirement.pass}"; none exists`,
    }
  }

  const selfReviewed: string[] = []
  const unknownProducers: string[] = []
  for (const verdict of matching) {
    const producer = producerOf(verdict)
    if (producer !== undefined && callerAgentId !== undefined && producer === callerAgentId) {
      selfReviewed.push(verdict.id)
      continue
    }
    if (producer === undefined) {
      unknownProducers.push(verdict.id)
      continue
    }
    return { allowed: true, verdictId: verdict.id }
  }

  if (selfReviewed.length > 0) {
    return {
      allowed: false,
      reason: 'self-review-not-allowed',
      detail:
        `the only passing verdict${selfReviewed.length === 1 ? '' : 's'} for "${subjectId}" ` +
        `(${selfReviewed.join(', ')}) ${selfReviewed.length === 1 ? 'was' : 'were'} produced by the ` +
        'caller, so it does not count as independent review',
    }
  }

  return {
    allowed: false,
    reason: 'review-producer-unknown',
    detail:
      `a passing verdict exists for "${subjectId}" (${unknownProducers.join(', ')}) but the platform ` +
      'cannot establish who produced it' +
      ((options.unreadable ?? 0) > 0
        ? `; the provenance record has ${options.unreadable} unreadable ` +
          `${options.unreadable === 1 ? 'entry' : 'entries'}`
        : ''),
  }
}
