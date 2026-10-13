/**
 * The write guard: the one check that every tool call passes through.
 *
 * Permission checks inside our own tools only cover our own tools. The runtime
 * also ships a filesystem tool and a shell, and neither knows what this plugin
 * declared — so a domain that says "only the delivery lead may write cases/" is
 * still one native `write` call away from being ignored. The runtime's guard hook
 * is the only place that sees every call, which is why the rule lives here.
 *
 * What it enforces, per call:
 *
 *   - a write tool must name a path, and that path must sit inside a directory the
 *     caller's role may write (derived from the schema, never listed by hand)
 *   - a shell command must not redirect into a path outside those directories
 *   - a caller with no role, and a deployment with no roles configured, may write
 *     nothing at all
 *
 * Every branch fails closed. Two deliberate departures from the implementation this
 * was ported from: a write tool whose path cannot be found is denied rather than
 * allowed (that version's guard went quiet on a rename), and PowerShell is checked
 * alongside bash (that version knew only of bash, which covers nothing on Windows).
 *
 * @module @zhangcun123/ontology/govern/guard
 */

import { resolve } from 'node:path'

import type { ObjectTypeDecl } from '../engine/schema.ts'
import type { RoleRule } from './permission.ts'
import { roleOf } from './permission.ts'
import {
  SHELL_TOOLS,
  WRITE_TOOLS,
  extractPathFromArgs,
  extractPathsFromShell,
  isInside,
} from './path.ts'

/** One tool call, as the runtime hands it to a guard. */
export interface GuardedCall {
  /** Tool name being dispatched. */
  readonly name: string
  /** Parsed arguments, opaque to this module beyond path extraction. */
  readonly arguments: unknown
  /** Identity of the agent on whose behalf the call runs. */
  readonly agentId?: string
}

/** What the guard decided, for whoever keeps the trail. */
export interface GuardDecision {
  /** Tool that was called. */
  readonly tool: string
  /** Path the call would have touched, when one was found. */
  readonly target?: string
  /** Agent that made the call, when the runtime reported one. */
  readonly agentId?: string
  /** Role resolved for that agent, when one was resolved. */
  readonly role?: string
  /** True when the call was refused. */
  readonly denied: boolean
  /** Machine-readable reason, when refused. */
  readonly reason?: string
  /** Human-readable refusal, when refused. */
  readonly detail?: string
}

/** What the guard is configured with, all of it derived or resolved once. */
export interface WriteGuardOptions {
  /** Absolute working directory used to resolve relative paths in arguments. */
  cwd: string
  /** Absolute domain root; declared directories are resolved against it. */
  ontologyRoot: string
  /** Prefix-to-role map, exactly as configured for the write tool. */
  roles: readonly RoleRule[]
  /** Every declared object type, for deriving what each role may write. */
  objectTypes: Iterable<ObjectTypeDecl>
  /**
   * Called once per call the guard looked at, refusals and allowances alike.
   *
   * A boundary that leaves no trail is only half a boundary: "who tried to write
   * what, and was it stopped" is the question asked after an incident, and it cannot
   * be answered from the tools' own logs when the call never reached a tool. Injected
   * rather than written from here, so the guard stays a function over its inputs.
   */
  onDecision?: (decision: GuardDecision) => void
}

/**
 * Directories a role may write, resolved to absolute paths.
 *
 * Derived from the same two declarations the write tool uses (`written_by` and
 * `file_location`), so there is one policy in the system rather than two that can
 * drift. A type that names the role but declares no directory contributes nothing:
 * the gap is visible here rather than silently widening the grant.
 */
export function writableDirectories(
  objectTypes: Iterable<ObjectTypeDecl>,
  role: string,
  ontologyRoot: string,
): string[] {
  const directories: string[] = []
  for (const type of objectTypes) {
    if (!type.writtenBy.includes(role)) continue
    if (type.directory.length === 0) continue
    directories.push(resolve(ontologyRoot, type.directory))
  }
  return directories
}

/**
 * Build the guard.
 *
 * The returned function has the runtime's guard shape: a string is a refusal with
 * that reason, `undefined` lets the call proceed. Guards are monotonic — the
 * runtime offers no way to turn a refusal back into an allow — so this one can be
 * layered with any other without weakening it.
 */
export function writeGuard(options: WriteGuardOptions): (call: GuardedCall) => string | undefined {
  const { cwd, ontologyRoot, roles, objectTypes, onDecision } = options
  const types = [...objectTypes]

  return (call) => {
    const record = (decision: Omit<GuardDecision, 'tool' | 'agentId'>): string | undefined => {
      onDecision?.({
        tool: call.name,
        ...(call.agentId === undefined ? {} : { agentId: call.agentId }),
        ...decision,
      })
      return decision.denied ? decision.detail : undefined
    }

    const isWrite = WRITE_TOOLS.includes(call.name)
    const isShell = SHELL_TOOLS.includes(call.name)
    if (!isWrite && !isShell) return undefined

    // Who is asking. No role means no writable directory to reason about, and
    // guessing one for an unidentified caller is how a policy becomes decorative.
    const role = roleOf(call.agentId, roles)
    if (role === undefined) {
      if (roles.length === 0) {
        return record({
          denied: true,
          reason: 'no-roles-configured',
          detail:
            `${call.name} refused: no roles are configured, so this deployment is read-only. ` +
            'Declare who may write with the plugin\'s roles setting.',
        })
      }
      return record({
        denied: true,
        reason: 'no-role',
        detail: `${call.name} refused: agent "${call.agentId ?? '(none reported)'}" matches no configured role.`,
      })
    }

    const allowed = writableDirectories(types, role, ontologyRoot)
    if (allowed.length === 0) {
      return record({
        denied: true,
        role,
        reason: 'role-has-no-directory',
        detail: `${call.name} refused: role "${role}" is not named in written_by for any object type.`,
      })
    }

    if (isWrite) {
      const raw = extractPathFromArgs(call.arguments)
      if (raw === undefined) {
        // The ported implementation allowed this case, which meant a renamed
        // argument silently disabled the guard. Denying keeps the failure loud.
        return record({
          denied: true,
          role,
          reason: 'no-path-in-arguments',
          detail: `${call.name} refused: no path found in the arguments, so the write cannot be authorised.`,
        })
      }
      const target = resolve(cwd, raw)
      if (allowed.some((base) => isInside(base, target))) {
        return record({ denied: false, role, target })
      }
      return record({
        denied: true,
        role,
        target,
        reason: 'path-outside-granted-directories',
        detail:
          `${call.name} refused: ${target} is outside the directories role "${role}" may write ` +
          `(${allowed.join(', ')}).`,
      })
    }

    const targets = extractPathsFromShell(
      (call.arguments as Record<string, unknown> | undefined)?.command,
      cwd,
    )
    for (const target of targets) {
      if (allowed.some((base) => isInside(base, target))) continue
      return record({
        denied: true,
        role,
        target,
        reason: 'redirect-outside-granted-directories',
        detail:
          `${call.name} refused: the command redirects into ${target}, outside the directories ` +
          `role "${role}" may write (${allowed.join(', ')}).`,
      })
    }
    return record({ denied: false, role, ...(targets[0] === undefined ? {} : { target: targets[0] }) })
  }
}

/**
 * What this guard does not cover, stated rather than implied.
 *
 * A shell command can write through its own logic (`cp`, `mv`, `sed -i`, an
 * interpreter), and this guard only reads redirections. Naming the gap is the
 * difference between a boundary and a belief about a boundary.
 */
export const UNCOVERED_BY_GUARD: readonly string[] = [
  'shell commands that write without a redirection (cp, mv, sed -i, interpreters)',
  'processes started outside the tool pipeline (hooks, background services)',
]
