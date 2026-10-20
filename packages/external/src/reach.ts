/**
 * One call, from a route id to a record of what happened.
 *
 * The order of the steps is the design, and every one of them refuses rather than proceeds when what
 * it needs is missing:
 *
 *   1. the route, out of the deployment's domain;
 *   2. the lifecycle's default state, which is the same boundary a read respects;
 *   3. the address and the credential's *name*, both in fields the deployment named;
 *   4. the credential's value, out of the host's seam and nowhere else;
 *   5. the address substituted into the configured command, quoted;
 *   6. the program, run once, on a deadline.
 *
 * Nothing here interprets the result. `reachable` is one comparison — the program exited 0 — and
 * that is deliberately all this slice claims. A connector that talks to a device may exit 0 for a
 * device that answered "no"; a connector that follows a redirect may exit 0 for a page nobody
 * expected. Reading the answer is the program's work, and the program's output is handed back as it
 * came so whoever asked can read it with whatever knowledge of the system they have. A later slice
 * could ask the domain for a response shape to read against; inventing one here would be this
 * package deciding what the customer's world means.
 *
 * @module @zhangcun123/external/reach
 */

import { credentialRef, isCredentialRefName, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'

import { recordReach } from './audit.ts'
import { resolveRoute, type RouteShape, type RouteTarget } from './route.ts'
import { CREDENTIAL_ENV, runCommand, type ReachRun } from './run.ts'

/**
 * The credential seam, as this package uses it.
 *
 * Structural rather than imported from the host's service class, the way every other seam in this
 * repository is reached: the provider is mounted on the runtime's context, and all that is needed
 * from it is one method with one signature. What is imported is the *vocabulary* — `credentialRef`
 * and `isCredentialRefName` — because the grammar of a reference name belongs to the seam and not to
 * this package. A hand-rolled copy of it here is how two packages end up disagreeing about what a
 * reference is. The brand those helpers apply is a compile-time device (`brandString` returns its
 * argument unchanged), so nothing breaks if the host is running a second copy of that package:
 * the value that reaches its provider is the same string.
 */
export interface CredentialSurface {
  /**
   * Resolve one reference to its current value.
   *
   * @param ref - The reference, branded by the seam's own helper.
   * @returns The value and the layer that supplied it, or `undefined` when nothing is stored.
   */
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
}

/** What one call produced. */
export interface ReachResult {
  /** Route the call named. */
  route: string
  /** The object the route reaches, when the domain declares a relation out of the route type. */
  system?: string
  /** Address the program was given. */
  url: string
  /** Program the deployment's command started. */
  program: string
  /** Exit status of the program, or null when the deadline killed it first. */
  exitCode: number | null
  /** True when the program exited 0, and nothing more than that. */
  reachable: boolean
  /** Wall-clock time of the run, in milliseconds. */
  elapsedMs: number
  /** What the program printed: stdout, plus stderr when it printed any. Absent when it printed nothing. */
  output?: string
}

/** Everything one call needs, all of it deployment configuration. */
export interface ReachRequest {
  /** The route the caller named. */
  routeId: string
  /** Domain root the deployment configured. */
  ontologyRoot: string
  /** The domain's own names, as configured. */
  shape: RouteShape
  /** The command, with `{url}` where the address goes. */
  command: string
  /** Program the command starts — derived once, so the trail and the declaration agree. */
  program: string
  /** Seconds before the program is killed. */
  timeoutSeconds: number
  /** Where the attempt is recorded. */
  auditLog: string
  /** The host's credential seam, when one is mounted. */
  credentials?: CredentialSurface
  /**
   * The approval gate, when the deployment asked for one.
   *
   * Handed in rather than built here, because asking is a conversation with the host and this file
   * has no context: what it has is the resolved route, and the route is what a person is being asked
   * about. `undefined` from the callback means the call may proceed; anything returned means it must
   * not, and carries both the machine-readable reason and the sentence the model reads.
   */
  approve?: (route: RouteTarget) => Promise<{ reason: string; text: string } | undefined>
  /**
   * Who is dialling, when it is not an agent's tool call.
   *
   * Set by the connector page, and written into the trail so the two paths stay tellable apart. It
   * does *not* skip any check below: a page call resolves the same route, against the same lifecycle
   * and the same credential seam. The one thing it replaces is the question — the person who pressed
   * the button is the person the question would have been put to.
   */
  by?: 'panel'
}

/**
 * Characters a shell would still read as syntax inside the double quotes this adds.
 *
 * Quoting is not decoration. The address comes from a field of an object in the deployment's domain,
 * and that domain is *writable* — the example domain's routes are written by an engineer, and the
 * engineer is a role a running agent may hold through the ontology's write tool. So
 * `node connectors/reach.mjs {url}` with an unquoted address of `https://ok.example/; rm -rf ~` is
 * command injection wearing a route's clothes, and both halves of the fix are needed: the quotes,
 * and a refusal for the characters that survive them.
 *
 * What survives double quotes differs by shell, so one list covers both platforms rather than a
 * branch on `process.platform` — a domain edited on Windows and run on Linux must not be the
 * difference between refused and executed. `$`, a backtick and a backslash are live inside quotes on
 * POSIX; `"` ends them everywhere. `%` is here because `cmd.exe` expands `%NAME%` while it is still
 * parsing the line, and what it expands to is parsed as syntax in turn — the whole reason
 * `setlocal enabledelayedexpansion` exists. `!` is live under delayed expansion and `^` is the
 * interpreter's own escape, so both go with them. Control characters go too, since a newline inside
 * quotes starts a second command.
 *
 * The cost is real and stated rather than hidden: a percent-encoded address is refused. Passing the
 * address in the environment instead of into the command string would remove the question entirely,
 * and is the change to make the first time an address actually needs a `%`; until then, refusing one
 * is cheaper than a quoting rule that has to be right on two shells.
 */
const UNSAFE_IN_QUOTES = /["\\`$%!^]|[\u0000-\u001f\u007f]/

/** The command with the address in it, or the reason it cannot be put there. */
export type Substitution =
  | { readonly ok: true; readonly command: string }
  | { readonly ok: false; readonly reason: string; readonly message: string }

/**
 * Put one address into the deployment's command.
 *
 * Exported because it is the one piece here that is worth testing on its own: what it refuses is the
 * boundary between a route's address and this machine's shell, and a test that has to stand up a
 * server to reach it would be a test of something else.
 *
 * @param command - The configured command, with `{url}` where the address goes.
 * @param address - The address, straight out of the domain.
 * @returns The command to run, or a refusal naming what cannot be quoted.
 */
export function substituteAddress(command: string, address: string): Substitution {
  if (UNSAFE_IN_QUOTES.test(address)) {
    return {
      ok: false,
      reason: 'address-not-quotable',
      message:
        `the address ${JSON.stringify(address)} contains a character a shell reads as syntax even ` +
        'inside quotes, so it was not put into the command. A route\'s address is data an agent may ' +
        'have written; give it as a plain address with the credential in the credential seam, and ' +
        'put anything that needs shell syntax in the configured command instead',
    }
  }
  return { ok: true, command: command.replaceAll('{url}', `"${address}"`) }
}

/** What the program printed, as one piece of text, plus why there is no exit status when there is none. */
function composeOutput(outcome: ReachRun, timeoutSeconds: number): string | undefined {
  const parts = [outcome.stdout, outcome.stderr].filter((stream) => stream.trim().length > 0)
  if (outcome.timedOut) {
    // The one fact the exit status cannot carry: null means both "killed" and "never had a status",
    // and a reader who cannot tell those apart cannot tell a hung connector from a dead one.
    parts.push(`[the ${timeoutSeconds}s deadline was reached and the program was killed]`)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Reach the system a route names.
 *
 * @param request - The route to dial, the domain to read it from, and how to run the program.
 * @returns What the program did.
 * @throws Error when the call is refused, with a sentence saying what is available or what to do.
 */
export async function reach(request: ReachRequest): Promise<ReachResult> {
  /**
   * Write the refusal down, then hand back the error to throw.
   *
   * Both halves in one place because they must not come apart: a refusal that is not in the trail is
   * indistinguishable from a call that was never made, and the trail is what an incident is read
   * from. If the write itself fails, that error is what the caller sees — nothing is dialled either
   * way, and a refusal nobody could record is not a refusal this tool will pretend to have made.
   */
  const deny = (reason: string, message: string): Error => {
    recordReach(request.auditLog, {
      at: new Date().toISOString(),
      kind: 'reach',
      route: request.routeId,
      program: request.program,
      outcome: 'denied',
      reason,
      detail: message,
      ...(request.by === undefined ? {} : { by: request.by }),
    })
    // The reason rides on the error as well as in the trail, because the connector page has to show a
    // reader which check refused without re-deriving it from the sentence.
    const error = new Error(message) as Error & { reason?: string }
    error.reason = reason
    return error
  }

  const found = resolveRoute(request.ontologyRoot, request.routeId, request.shape)
  if (!found.ok) throw deny(found.reason, found.message)
  const route = found.route

  // Asked before the credential is looked up and before anything is dialled.
  //
  // Both halves matter. Before the spawn, because an act nobody approved must not reach the system —
  // the test asserts the far side saw no request rather than only that the result said no. Before the
  // seam, because a refusal that happens after the credential was fetched is one the trail cannot
  // tell apart from a call that ran, and the least a refusal can do is not touch the material.
  if (request.approve !== undefined) {
    const refused = await request.approve(route)
    if (refused !== undefined) throw deny(refused.reason, refused.text)
  }

  const credentials = request.credentials
  if (credentials === undefined) {
    throw deny(
      'no-credential-service',
      `route "${route.id}" files its credential under "${route.credentialName}", and no credential ` +
        'service is mounted, so there is nothing to resolve it with and nothing was dialled; the ' +
        'material lives in the host\'s credential seam, and a deployment that has not mounted one ' +
        'has nowhere for it to live',
    )
  }

  // Asked before resolving, because a name outside the grammar has no reference to miss: the seam's
  // own documentation says such a name reads as "not set" rather than as a thrown error, and a
  // thrown `TypeError` from a builder helper would reach the model as a stack trace instead of an
  // explanation.
  if (!isCredentialRefName(route.credentialName)) {
    throw deny(
      'credential-name-outside-grammar',
      `route "${route.id}" names its credential in its "${request.shape.auth_ref}" field, and what ` +
        `is there (${JSON.stringify(route.credentialName)}) is not a name the credential seam can ` +
        'address — a reference is an environment variable name: a letter or underscore followed by ' +
        'letters, digits and underscores. Nothing can be stored under that name, so nothing was dialled',
    )
  }

  let resolved: ResolvedCredential | undefined
  try {
    resolved = await credentials.resolve(credentialRef(route.credentialName))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw deny(
      'credential-lookup-failed',
      `the credential service could not resolve "${route.credentialName}", which route ` +
        `"${route.id}" files its credential under (${detail}), so nothing was dialled`,
    )
  }
  if (resolved === undefined || resolved.value.length === 0) {
    throw deny(
      'no-credential-stored',
      `nothing is stored under "${route.credentialName}", which route "${route.id}" names in its ` +
        `"${request.shape.auth_ref}" field, so nothing was dialled; store the credential in the ` +
        'host\'s credential seam under that name, or name a different one in the route',
    )
  }

  const substituted = substituteAddress(request.command, route.url)
  if (!substituted.ok) throw deny(substituted.reason, substituted.message)

  // The credential goes into the child's environment and appears in no argument, no result, no log
  // line and no audit record. `DEEPWORK_REACH_CREDENTIAL` is the name the deployment's connector is
  // told to read; see the module doc of `run.ts` for why the name carries no `KEY` or `SECRET`.
  const outcome = await runCommand({
    command: substituted.command,
    cwd: process.cwd(),
    timeoutSeconds: request.timeoutSeconds,
    env: { ...process.env, [CREDENTIAL_ENV]: resolved.value },
  })

  const output = composeOutput(outcome, request.timeoutSeconds)
  const result: ReachResult = {
    route: route.id,
    ...(route.system === undefined ? {} : { system: route.system }),
    url: route.url,
    program: request.program,
    exitCode: outcome.exitCode,
    reachable: outcome.exitCode === 0,
    elapsedMs: outcome.elapsedMs,
    ...(output === undefined ? {} : { output }),
  }

  // `outcome` here is about permission, not about the far side: a call that was made and could not
  // connect is `allowed` with `reachable: false`, the same distinction the write trail draws between
  // a write that was refused and a write that failed.
  recordReach(request.auditLog, {
    at: new Date().toISOString(),
    kind: 'reach',
    route: route.id,
    program: request.program,
    outcome: 'allowed',
    exitCode: outcome.exitCode,
    reachable: result.reachable,
    ...(outcome.timedOut ? { timedOut: true } : {}),
    elapsedMs: outcome.elapsedMs,
    ...(request.by === undefined ? {} : { by: request.by }),
  })

  return result
}
