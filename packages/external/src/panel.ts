/**
 * Reaching a system from the connector page, on behalf of the person who pressed the button.
 *
 * **Why this is allowed to exist at all.** The rule this package argues for elsewhere is that a page
 * must not become the way around the gate: `reach_system` asks before it dials, and a route the guard
 * would refuse has to be refused everywhere. This path keeps both halves and gives up exactly one
 * thing.
 *
 * - It does **not** ask the approval service. Nobody is asked because there is nobody to ask: the
 *   person reading the page is the principal, the session cookie is how the host authenticated them,
 *   and the button they pressed *is* the answer. Asking an approval service on behalf of an agent that
 *   is not running would either fail closed for no reason or invent an identity.
 * - It **does** apply every check the tool applies — the same route resolution, the same lifecycle
 *   boundary, the same credential seam, the same command quoting — because those are the route's
 *   declaration rather than the caller's permission. Anything else would make the page a second,
 *   weaker implementation of the same act.
 * - It **does** read `tool_grants` first, and refuses when the program is granted to nobody. That is
 *   the one permission that cannot be derived from the session: the domain says which program may run
 *   at all, and a page that ignored it would be strictly more powerful than the agent — the exact
 *   inversion this design is trying not to build.
 * - It **does** write to the same trail, with `by: 'panel'`. Without that field, "an agent reached the
 *   payroll system unattended" and "an operator pressed a button" would read identically afterwards,
 *   which is the one thing an audit trail exists to distinguish.
 *
 * What it still cannot do is say *which* person. The host's web session seam hands this plugin no
 * identity, so the trail records that it was the page. A deployment that needs a name needs a session
 * API this package does not have, and saying so is better than recording a guess.
 *
 * @module @zhangcun123/external/panel
 */

import { loadGraph } from '@zhangcun123/ontology/engine'
import { reach, type CredentialSurface, type ReachResult } from './reach.ts'
import type { RouteShape } from './route.ts'

/** What the connector page's reach endpoint answers: an HTTP status and a body to render. */
export interface PanelAnswer {
  status: number
  body: unknown
}

/** Everything one page-initiated call needs. The credentials seam is optional, as it is for the tool. */
export interface PanelRequest {
  /** The route the page named. */
  routeId: string
  /** Domain root the deployment configured. */
  root: string
  /** The domain's own names, as configured. */
  shape: RouteShape
  /** The command, with `{url}` where the address goes. */
  command: string
  /** Program the command starts — the name `tool_grants` has to grant. */
  program: string
  /** Seconds before the program is killed. */
  timeoutSeconds: number
  /** Where the attempt is recorded. */
  auditLog: string
  /** The host's credential seam, when one is mounted. */
  credentials?: CredentialSurface
}

/** A refusal the page shows as a reason rather than as a crash. */
function refuse(status: number, code: string, error: string): PanelAnswer {
  return { status, body: { code, error } }
}

/**
 * Grant check, before anything is resolved or dialled.
 *
 * Read from the domain's own `tool_grants` rather than from a role, because a page has no role to be
 * resolved to: what it can establish is that the domain permits this program to run at all. An entry
 * that grants it to nobody — absent, or an empty list — is a refusal, and the message repeats the
 * guard's, so a reader who has seen the agent's refusal recognises this one.
 *
 * @returns The refusal to return, or `undefined` when the program is granted to somebody.
 */
function grantRefusal(program: string, root: string): PanelAnswer | undefined {
  let grants: ReadonlyMap<string, readonly string[]>
  try {
    grants = loadGraph(root).schema.toolGrants ?? new Map()
  } catch (error) {
    // No trail line: nothing was attempted, and this is the domain being unreadable rather than a
    // refusal about a route.
    return refuse(
      503,
      'domain-unreadable',
      `the domain at ${root} could not be read (${error instanceof Error ? error.message : String(error)}), ` +
        'so the page cannot tell which routes exist and nothing was dialled',
    )
  }

  const programRoles = grants.get(program)
  if (programRoles === undefined) {
    return refuse(
      403,
      'no-grant-declared',
      `tool_grants has no entry for "${program}", the program this deployment's command starts, so the ` +
        'guard refuses every call with no-grant-declared and this page does not do what the guard ' +
        'refuses. Grant it to a role in the domain, or stop the tool from declaring it',
    )
  }
  if (programRoles.length === 0) {
    return refuse(
      403,
      'tool-not-granted-to-role',
      `tool_grants grants "${program}" to no role, so every call is refused with ` +
        'tool-not-granted-to-role and this page does not do what the guard refuses',
    )
  }
  const toolRoles = grants.get('reach_system')
  if (toolRoles !== undefined && toolRoles.length === 0) {
    return refuse(
      403,
      'tool-not-granted-to-role',
      'tool_grants grants reach_system itself to no role, which narrows every program grant to nobody',
    )
  }
  return undefined
}

/**
 * Dial one route on behalf of the person at the page.
 *
 * @param request - The route, the domain, the command, and where the trail lives.
 * @returns The status and body the page renders: the reach result, or a refusal carrying a code.
 */
export async function panelReach(request: PanelRequest): Promise<PanelAnswer> {
  if (request.routeId.length === 0) {
    return refuse(400, 'route-required', 'a route id is required; nothing else is an argument')
  }
  if (request.command.length === 0 || request.root.length === 0) {
    return refuse(
      503,
      'not-configured',
      'this deployment has not said how it reaches anything (no command) or which domain to read a ' +
        'route out of (no ontologyRoot), so there is nothing to dial',
    )
  }

  const refused = grantRefusal(request.program, request.root)
  if (refused !== undefined) return refused

  let result: ReachResult
  try {
    result = await reach({
      routeId: request.routeId,
      ontologyRoot: request.root,
      shape: request.shape,
      command: request.command,
      program: request.program,
      timeoutSeconds: request.timeoutSeconds,
      auditLog: request.auditLog,
      ...(request.credentials === undefined ? {} : { credentials: request.credentials }),
      // No `approve`: see the module doc. The one thing this path gives up, and the trail records it.
      by: 'panel',
    })
  } catch (error) {
    // A refusal carries its reason, because `reach` attaches one to every ending it decides on. An
    // error without one is not a governance decision — the program could not be started, the disk
    // refused the trail — and reporting that as a 403 would tell a reader to go looking for a
    // permission problem that does not exist.
    const reason = (error as { reason?: unknown }).reason
    const message = error instanceof Error ? error.message : String(error)
    return typeof reason === 'string'
      ? refuse(403, reason, message)
      : refuse(500, 'run-failed', message)
  }

  return { status: 200, body: result }
}
