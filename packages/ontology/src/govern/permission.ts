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

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

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
  // The same refusal, arrived at differently: the path is inside the declared directory as a string
  // and outside it as a filesystem, which is what a junction or a symlink buys.
  | 'path-escapes-through-a-link'
  // Value refusals: a field declared a closed set of choices and the write stepped outside it.
  | 'value-not-declared'
  // Lifecycle refusals live in their own module; they surface through the same write
  // tool, so they are part of the same vocabulary a caller branches on.
  | 'unknown-state'
  | 'no-declared-transition'
  | 'transition-not-permitted'
  // Counter refusals, for the same reason: one vocabulary a caller can branch on.
  | 'invalid-increment'
  // The write itself failed — no directory could be created, or the file could not be moved into
  // place. Distinct from every refusal above because nothing about the call was wrong: the disk was.
  | 'write-failed'
  | 'not-a-counter'
  | 'increment-not-permitted'
  // Review refusals: a move that needed an independent verdict and did not get one.
  | 'review-required'
  | 'self-review-not-allowed'
  | 'review-producer-unknown'
  // Action preconditions: the world was not in the state the action assumed.
  | 'already-exists'
  | 'not-found'
  // A file for this id exists and did not load. Kept apart from `missing-required-field`, which is
  // what a caller would otherwise be told about an object that is present and unreadable.
  | 'unreadable-instance'

/** The outcome of a permission check. */
export type Permission =
  | { allowed: true; role: string }
  | { allowed: false; reason: DenialReason; detail: string }

/**
 * A rule whose prefix is this matches every caller, whatever id it arrives with.
 *
 * The point of it is to make the role a deployment *states* rather than one inferred from an
 * id the deployment does not control. An id-shaped rule is an assumption about the host's
 * naming: when the host changes how it names agents — as it does between a plugin route and a
 * preset — the rule stops matching, and every write is refused. That failure reads as a
 * permissions problem rather than as a stale assumption, which is the expensive part.
 */
export const ANY_CALLER = '*'

/**
 * Resolve the role a caller acts under.
 *
 * The longest matching prefix wins, so a specific rule can carve an exception out of
 * a broad one without the rules having to be ordered carefully. {@link ANY_CALLER} is one
 * character, so it loses to every real prefix and wins only when nothing else matches —
 * a process hosting several kinds of agent can name them individually and let the wildcard
 * cover whatever is left.
 *
 * An empty prefix stays ignored rather than becoming that wildcard. It was ignored before, and
 * turning it into a grant now would make an existing configuration silently permissive, which
 * is the one direction a change to a permission rule must never go.
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
    const matches =
      rule.prefix === ANY_CALLER || (rule.prefix.length > 0 && agentId.startsWith(rule.prefix))
    if (!matches) continue
    if (best === undefined || rule.prefix.length > best.prefix.length) best = rule
  }
  return best?.role
}

/**
 * Device names Windows reserves, with or without an extension.
 *
 * `NUL.yaml` is the null device exactly as `NUL` is: writing to it reports success and the bytes go
 * nowhere, and `existsSync` afterwards can answer true. That is the worst failure this predicate
 * guards: not a refused write, but a write that appears to have worked and left no record.
 */
const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
])

/** Longest id this predicate accepts, leaving room for a directory, a separator and `.yaml`. */
const MAX_ID_LENGTH = 200


/**
 * The real path of `path`, or of its deepest existing ancestor with the rest appended.
 *
 * `realpathSync` needs the file to exist, and on a first write it does not: neither the file nor, in
 * the ordinary case, its directory. Walking up to the nearest ancestor that does exist answers the
 * question the caller is actually asking — "where would this land, once the parts that do not exist
 * yet are created" — and it resolves the links on the way, which is the whole point.
 *
 * @param path - An absolute path that may or may not exist.
 * @returns The path with every existing link resolved.
 */
function realPathOf(path: string): string {
  const suffix: string[] = []
  let current = path
  while (true) {
    try {
      const real = realpathSync(current)
      return suffix.length === 0 ? real : join(real, ...suffix.reverse())
    } catch {
      // Not there yet; its parent is the next question.
    }
    const parent = dirname(current)
    if (parent === current) return path
    suffix.push(basename(current))
    current = parent
  }
}

/**
 * True when an id can be used to build a filename without escaping anywhere.
 *
 * The id comes from the model, so this is a real boundary rather than hygiene: an id
 * of `../../elsewhere` would otherwise place a file outside the domain entirely. The
 * path check below would still catch it, but rejecting the id says what actually went
 * wrong instead of reporting a confusing path complaint.
 *
 * The rules below are the ones a filesystem makes necessary rather than the ones a reader might
 * guess, and each is here because the alternative is a silent success:
 *
 * - **path separators and NUL**, which would leave the declared directory;
 * - **`:`**, which on NTFS opens an alternate data stream (`X.yaml::$DATA` is another file that is
 *   not the one the domain reads) and elsewhere starts a drive or a scheme;
 * - **control characters**, which no filename round-trip preserves;
 * - **a trailing dot or space**, which Windows strips — `a.` and `a` would name the same file on one
 *   platform and two on another, so the same domain would hold one instance or two depending on
 *   where it was read;
 * - **a reserved device name in any extension**, because `NUL.yaml` is the null device;
 * - **a length past what a filename safely holds** once a directory, a separator and `.yaml` are
 *   added.
 *
 * What it deliberately cannot decide: two ids that differ only by case name one file on Windows and
 * two on Linux. That is a fact about a pair of instances, so it belongs to the loader that reads the
 * directory, not to a predicate over one id.
 */
export function isSafeId(id: string): boolean {
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return false
  if (id === '.' || id === '..') return false
  if (/[\\/:\u0000-\u001f\u007f]/.test(id)) return false
  if (/[. ]$/.test(id)) return false
  const stem = (id.split('.')[0] ?? '').toUpperCase()
  return !RESERVED_NAMES.has(stem)
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

  // The check above is lexical, and a link is the thing that makes a lexical check disagree with the
  // filesystem: a junction created inside the declared directory pointing at `C:/Windows` is inside
  // it as a string and outside it as a place. Resolving the *deepest existing ancestor* of each side
  // answers the question the string cannot — the file itself need not exist yet, and neither does
  // its immediate directory on the first write.
  const realBase = realPathOf(base)
  const realTarget = realPathOf(target)
  const realWithin = relative(realBase, realTarget)
  if (realWithin.length === 0 || realWithin.startsWith('..') || isAbsolute(realWithin)) {
    return {
      allowed: false,
      reason: 'path-escapes-through-a-link',
      detail:
        `${target} resolves to ${realTarget}, outside ${realBase} — which is where a link inside the ` +
        'declared directory can make a path land',
    }
  }

  return { allowed: true, role }
}
