/**
 * Who may write what — derived from the schema, not hand-written per tool.
 *
 * This is the second half of the project's claim. Governance is not a list of
 * per-tool checks that a developer has to remember to add: the domain declares, on
 * each object type, which roles may write it (`written_by`) and where its instances
 * live (`file_location`). Those two declarations are the whole policy, and this
 * module turns them into the checks a write must pass:
 *
 *   - the caller has a role at all, resolved from its agent id
 *   - that role appears in the target type's `written_by`
 *   - the id the caller supplied cannot be turned into a path that escapes
 *   - the file to be written sits inside the type's declared directory
 *
 * Every check fails closed. No configured roles, an unrecognised caller, a type that
 * declares no `written_by`, an id containing a separator, a path that leaves the
 * declared directory — all deny. The direction is deliberate: a permission bug that
 * denies is a bug report, one that allows is an incident.
 *
 * @module @zhangcun123/ontology/govern/permission
 */

import { isAbsolute, relative, resolve } from 'node:path'

import type { ObjectTypeDecl } from '../engine/schema.ts'

/** Maps an agent id prefix to the role that agent acts under. */
export interface RoleRule {
  /** Prefix matched against the agent id, e.g. `editor-session-`. */
  prefix: string
  /** Role name, matched against a type's `written_by`. */
  role: string
}

/** Why a write was refused. Machine-readable, so a caller can branch on it. */
export type DenialReason =
  | 'no-caller'
  | 'no-role'
  | 'unsafe-id'
  | 'type-not-writable'
  | 'role-not-permitted'
  | 'missing-required-field'
  | 'path-outside-declared-directory'
  // Lifecycle refusals live in their own module; they surface through the same write
  // tool, so they are part of the same vocabulary a caller branches on.
  | 'unknown-state'
  | 'no-declared-transition'
  | 'transition-not-permitted'
  // Counter refusals, for the same reason: one vocabulary a caller can branch on.
  | 'invalid-increment'
  | 'not-a-counter'
  | 'increment-not-permitted'
  // Review refusals: a move that needed an independent verdict and did not get one.
  | 'review-required'
  | 'self-review-not-allowed'
  | 'review-producer-unknown'
  // Action preconditions: the world was not in the state the action assumed.
  | 'already-exists'
  | 'not-found'

/** The outcome of a permission check. */
export type Permission =
  | { allowed: true; role: string }
  | { allowed: false; reason: DenialReason; detail: string }

/**
 * Resolve the role a caller acts under.
 *
 * The longest matching prefix wins, so a specific rule can carve an exception out of
 * a broad one without the rules having to be ordered carefully.
 *
 * @param agentId - Identity the runtime reported, if any.
 * @param rules - Configured prefix-to-role map.
 */
export function roleOf(
  agentId: string | undefined,
  rules: readonly RoleRule[],
): string | undefined {
  if (agentId === undefined || agentId.length === 0) return undefined
  let best: RoleRule | undefined
  for (const rule of rules) {
    if (rule.prefix.length === 0 || !agentId.startsWith(rule.prefix)) continue
    if (best === undefined || rule.prefix.length > best.prefix.length) best = rule
  }
  return best?.role
}

/**
 * True when an id can be used to build a filename without escaping anywhere.
 *
 * The id comes from the model, so this is a real boundary rather than hygiene: an id
 * of `../../elsewhere` would otherwise place a file outside the domain entirely. The
 * path check below would still catch it, but rejecting the id says what actually went
 * wrong instead of reporting a confusing path complaint.
 */
export function isSafeId(id: string): boolean {
  if (id.length === 0) return false
  if (id === '.' || id === '..') return false
  return !/[\\/\0]/.test(id)
}

/**
 * Decide whether one write may proceed.
 *
 * @param type - Declaration of the type being written.
 * @param ontologyRoot - Domain root, for the path containment check.
 * @param targetFile - Absolute path the write would touch.
 * @param agentId - Identity the runtime reported, if any.
 * @param rules - Configured prefix-to-role map.
 */
export function authoriseWrite(
  type: ObjectTypeDecl,
  ontologyRoot: string,
  targetFile: string,
  agentId: string | undefined,
  rules: readonly RoleRule[],
  options: {
    /**
     * Whether the call authors content, and therefore needs `written_by`.
     *
     * False for a call that only moves a counter: recording that knowledge was used is
     * not authoring it, and `written_by` answers a different question. Collapsing the two
     * would mean only authors could count usage — and the role that actually observes
     * usage is never the author.
     */
    requireWrittenBy?: boolean
  } = {},
): Permission {
  if (agentId === undefined || agentId.length === 0) {
    return { allowed: false, reason: 'no-caller', detail: 'the runtime reported no agent identity' }
  }
  const role = roleOf(agentId, rules)
  if (role === undefined) {
    return {
      allowed: false,
      reason: 'no-role',
      detail: `agent "${agentId}" matches no configured role`,
    }
  }
  if (options.requireWrittenBy === false) {
    // Still checked: the id is usable and the path stays inside the declared directory.
    // Only the question "may this role author this type" is someone else's to answer.
    return finish(type, ontologyRoot, targetFile, role)
  }

  if (type.writtenBy.length === 0) {
    return {
      allowed: false,
      reason: 'type-not-writable',
      detail: `type "${type.name}" declares no written_by, so nobody may write it`,
    }
  }
  if (!type.writtenBy.includes(role)) {
    return {
      allowed: false,
      reason: 'role-not-permitted',
      detail: `role "${role}" is not in written_by for "${type.name}" (${type.writtenBy.join(', ')})`,
    }
  }
  return finish(type, ontologyRoot, targetFile, role)
}

/** The checks that apply however the call is authorised: is this a path in the domain. */
function finish(
  type: ObjectTypeDecl,
  ontologyRoot: string,
  targetFile: string,
  role: string,
): Permission {
  if (type.directory.length === 0) {
    return {
      allowed: false,
      reason: 'path-outside-declared-directory',
      detail: `type "${type.name}" declares no file_location, so it has no writable directory`,
    }
  }

  const base = resolve(ontologyRoot, type.directory)
  const target = resolve(targetFile)
  const within = relative(base, target)
  if (within.length === 0 || within.startsWith('..') || isAbsolute(within)) {
    return {
      allowed: false,
      reason: 'path-outside-declared-directory',
      detail: `${target} is outside ${base}`,
    }
  }

  return { allowed: true, role }
}
