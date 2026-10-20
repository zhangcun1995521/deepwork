/**
 * The connector view: what this deployment can reach, who may reach it, and what the trail says
 * happened last.
 *
 * **Why this lives in the connector and not in the domain panel.** The ontology panel answers "what
 * is in this world". This answers "what can be dialled, by whom, and how did the last attempt end" —
 * questions whose vocabulary (a route type, an address field, a credential reference, a program) is
 * this package's, not the domain engine's. Putting it in the domain panel would make the ontology
 * learn what a connector is, which is the direction this repository spends its comments arguing
 * against.
 *
 * **What this view never carries.** Not the address, even though the domain holds it: an address may
 * carry a token in its query string, and a page served over HTTP is a worse place for that than the
 * trail that refused to record it either. Not the credential — the name is shown because the name is
 * what the domain declares and what an operator has to look up, and the material stays in the host's
 * seam, unasked. What is shown is the shape of a declaration and the shape of a refusal.
 *
 * **What it does not show is as deliberate.** There is no "test this route" button. Reaching a system
 * is an act with an approval gate on it (`reach.ts` asks before the credential is even looked up), and
 * a page has no agent identity to ask on behalf of — a probe fired from here would be refused by this
 * deployment's own gate, or worse, would be the one path around it. The page says who to ask instead:
 * an agent calling `reach_system`, which is the same door every other caller uses.
 *
 * **Two kinds of finding, kept apart.** A *problem* is something one route can fix: an empty address,
 * a blank reference. A *deployment finding* is a fact about the whole composition — a program nobody
 * granted, a field the connector was told to read that the type does not declare, a target field
 * nobody configured. The second kind is reported once and makes every route uncallable, because
 * saying it nine times would read as nine broken routes rather than as one broken configuration.
 *
 * **The limit worth stating out loud.** Everything below is read from declarations and from this
 * package's own trail. Whether the credential is actually *stored* under the name a route files, and
 * whether the program exists on this machine, are facts only a call can settle — and this view
 * deliberately does not make one. A route marked complete here is a route whose declaration is
 * complete, not a route known to answer.
 *
 * @module @zhangcun123/external/connectors
 */

import { readFileSync } from 'node:fs'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { loadGraph, type OntologyGraph } from '@zhangcun123/ontology/engine'
import type { ObjectTypeDecl } from '@zhangcun123/ontology/engine/schema'
import type { ReachAuditEntry } from './audit.ts'
import { stateOf, type RouteShape } from './route.ts'

/** One thing that stops a call, in a form a page or a test can key on. */
export interface Finding {
  /** Machine-readable code. The detail is for a reader; the code is for everything else. */
  code: string
  /** The sentence a reader acts on. */
  detail: string
}

/** What the trail says about one attempt, without the address or the output. */
export interface AttemptView {
  at: string
  /** Whether the call was allowed to happen — not whether the far side answered. */
  outcome: 'allowed' | 'denied'
  exitCode?: number | null
  reachable?: boolean
  timedOut?: boolean
  elapsedMs?: number
  /** Machine-readable refusal reason, on a refusal. */
  reason?: string
}

/** One route, as a page can show it. */
export interface ConnectorView {
  /** Route id, which is the pointer a caller uses. */
  id: string
  /**
   * What this route reaches: the target of the domain's own relation when it declares one, and
   * otherwise the value of the field the deployment configured as the target. Null when the domain
   * says neither, which is a deployment finding rather than this route's fault.
   */
  system: string | null
  /** The field the deployment named as the address, and whether the route fills it. Never the value. */
  address: { field: string; set: boolean }
  /** The field the deployment named as the credential reference, the name in it, and whether the seam's grammar can address that name. Never the material. */
  credential: { field: string; name: string; addressable: boolean }
  /**
   * Who the domain lets call this route.
   *
   * `programRoles` is the grant that is *required*: the guard refuses a call whose program has no
   * entry, so `null` here means nobody can call the route no matter what else is declared.
   * `toolRoles` is a grant on the tool's own name, which only ever narrows — an absent entry is not a
   * refusal, an empty one is.
   */
  callers: { program: string; programRoles: string[] | null; toolRoles: string[] | null }
  /** The state the route is in and the state a call requires, when its type declares a lifecycle. */
  dialable: { state: string; required: string | null; ok: boolean }
  /** Last attempt in the trail, when there was one. */
  last: AttemptView | null
  /** Attempts this trail records as refused, counted rather than sampled. */
  refusals: number
  /** Everything about this route that says a call will not go through. */
  problems: Finding[]
}

/** Every connector this deployment declares, plus what the trail says about them. */
export interface ConnectorSnapshot {
  root: string
  /** Route type the deployment configured, echoed so a reader can see what was read. */
  routeType: string
  /** Program the deployment's command starts — the grant name that is required. */
  program: string
  /** Where attempts are recorded, echoed for the same reason. */
  auditLog: string
  /** False when the domain could not be read; every list is then empty and `findings` says why. */
  readable: boolean
  /**
   * Counts, with the difference between "this route is complete" and "a call could go through" kept
   * explicit. A deployment missing a grant has nine complete routes and nothing callable, and a page
   * that collapsed those two numbers would be reporting the wrong one.
   */
  summary: {
    routes: number
    /** Routes whose own declaration says nothing against a call. */
    complete: number
    /** Routes a call would get through, given both what this route declares and what the deployment does. */
    callable: number
    attempted: number
    refused: number
  }
  /** Facts about the deployment as a whole, rather than about one route. */
  findings: Finding[]
  /** The sentence this view cannot say with data: how to find out whether a route answers. */
  note: string
  connectors: ConnectorView[]
}

/** How many trail entries are read. A page needs the last attempt, not the history. */
const TRAIL_TAIL = 2000

/**
 * Findings that stop every route, whatever a route's own declaration says.
 *
 * Kept as a set of codes rather than as a flag on each finding so that the reason a route is
 * uncallable stays a property of the finding: a page can group by it, and a test can assert the code
 * without reading prose.
 */
const BLOCKING: ReadonlySet<string> = new Set([
  'domain-unreadable',
  'route-type-undeclared',
  'program-not-granted',
  'tool-not-granted',
  'address-field-not-declared',
  'credential-field-not-declared',
])

/** Read the trail, keeping only reach entries, and only the last {@link TRAIL_TAIL} of them. */
function readTrail(path: string, findings: Finding[]): ReachAuditEntry[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // A trail that does not exist yet is the normal state of a fresh deployment, not a problem: every
    // route reads as never attempted, which is true.
    const code = (error as { code?: unknown }).code
    if (code !== 'ENOENT') {
      findings.push({
        code: 'trail-unreadable',
        detail:
          `the trail at ${path} could not be read ` +
          `(${error instanceof Error ? error.message : String(error)}), so every route below reads ` +
          'as never attempted',
      })
    }
    return []
  }
  const entries: ReachAuditEntry[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A half-written last line is what a crash leaves behind. Skipping it loses one attempt;
      // refusing to show the page over it loses all of them.
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    if ((parsed as { kind?: unknown }).kind !== 'reach') continue
    entries.push(parsed as ReachAuditEntry)
  }
  return entries.slice(-TRAIL_TAIL)
}

/** The parts of a trail entry a page shows. */
function toAttempt(entry: ReachAuditEntry): AttemptView {
  return {
    at: entry.at,
    outcome: entry.outcome,
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    ...(entry.reachable === undefined ? {} : { reachable: entry.reachable }),
    ...(entry.timedOut === undefined ? {} : { timedOut: entry.timedOut }),
    ...(entry.elapsedMs === undefined ? {} : { elapsedMs: entry.elapsedMs }),
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  }
}

/**
 * Check one configured field name against the type's declaration.
 *
 * This is the check that keeps the commonest configuration mistake from reading as nine broken
 * routes: a deployment pointed at a field its domain does not declare gets an address, a reference or
 * a target of `undefined` for *every* instance, and the per-route checks below would each report the
 * blank they see. The field is the deployment's own name for something, so the finding names it and
 * the fields the type does have.
 */
function checkField(
  type: ObjectTypeDecl,
  role: string,
  configKey: string,
  field: string,
  code: string,
  blocking: boolean,
): Finding | null {
  if (field.length === 0) {
    return {
      code,
      detail:
        `this deployment configured no field as the ${role}; set route.${configKey} to the field the ` +
        `domain uses, or ${blocking ? 'no route can be dialled' : 'the page cannot say what a route reaches'}`,
    }
  }
  if (type.fields[field] !== undefined) return null
  const declared = Object.keys(type.fields)
  return {
    code,
    detail:
      `this deployment configured "${field}" as the ${role}, and type "${type.name}" does not ` +
      `declare that field; it declares ${declared.length === 0 ? 'none' : declared.join(', ')}`,
  }
}

/**
 * Build the connector view for one deployment.
 *
 * @param request - The domain root, the domain's own names, the program the command starts, where the
 *   trail lives, and the optional field naming what a route reaches.
 * @returns Everything the page shows, whether or not the domain could be read.
 */
export function connectorSnapshot(request: {
  root: string
  shape: RouteShape
  /** Field holding the name of what a route reaches, when the domain points by field rather than by relation. */
  target?: string
  program: string
  auditLog: string
}): ConnectorSnapshot {
  const findings: Finding[] = []
  const note =
    'Reaching a system is an agent act, not a page act: ask an agent to call reach_system with a route ' +
    'id. This view reads declarations and the trail; it never resolves a credential and never dials, ' +
    'so a complete route is one whose declaration is complete, not one known to answer.'

  const empty = { summary: { routes: 0, complete: 0, callable: 0, attempted: 0, refused: 0 }, connectors: [] }

  let graph: OntologyGraph
  try {
    graph = loadGraph(request.root)
  } catch (error) {
    return {
      root: request.root,
      routeType: request.shape.type,
      program: request.program,
      auditLog: request.auditLog,
      ...empty,
      readable: false,
      findings: [
        {
          code: 'domain-unreadable',
          detail:
            `the domain at ${request.root} could not be read ` +
            `(${error instanceof Error ? error.message : String(error)}), so no connector is shown`,
        },
      ],
      note,
    }
  }

  const trail = readTrail(request.auditLog, findings)

  const type = graph.schema.objectTypes.get(request.shape.type)
  if (type === undefined) {
    const declared = [...graph.schema.objectTypes.keys()]
    return {
      root: request.root,
      routeType: request.shape.type,
      program: request.program,
      auditLog: request.auditLog,
      ...empty,
      readable: true,
      findings: [
        ...findings,
        {
          code: 'route-type-undeclared',
          detail:
            `this deployment's route type "${request.shape.type}" is not declared in the domain at ` +
            `${request.root}; it declares ${declared.length === 0 ? 'no object types' : declared.join(', ')}`,
        },
      ],
      note,
    }
  }

  const grants = graph.schema.toolGrants ?? new Map<string, string[]>()
  const programRoles = grants.get(request.program)
  const toolRoles = grants.get('reach_system')

  // The configuration's own names, checked before anything is read through them. A field the type
  // does not declare is reported once, and the per-route checks then skip that field rather than
  // reporting an empty value on every route.
  const addressFinding = checkField(
    type,
    'address',
    'url',
    request.shape.url,
    'address-field-not-declared',
    true,
  )
  const credentialFinding = checkField(
    type,
    'credential reference',
    'auth_ref',
    request.shape.auth_ref,
    'credential-field-not-declared',
    true,
  )
  const targetField = request.target ?? ''
  const targetFinding =
    targetField.length === 0
      ? null
      : checkField(type, 'target', 'target', targetField, 'target-field-not-declared', false)
  for (const finding of [addressFinding, credentialFinding, targetFinding]) {
    if (finding !== null) findings.push(finding)
  }

  // Said once rather than ten times. Per-route problems are for things one route can fix; this is the
  // deployment's own grant, and every route inherits it.
  if (programRoles === undefined) {
    findings.push({
      code: 'program-not-granted',
      detail:
        `tool_grants has no entry for "${request.program}", the program this deployment's command ` +
        'starts, so the guard refuses every call with no-grant-declared — no route is callable until ' +
        'that entry exists',
    })
  } else if (programRoles.length === 0) {
    findings.push({
      code: 'program-not-granted',
      detail:
        `tool_grants grants "${request.program}" to no role, so every call is refused with ` +
        'tool-not-granted-to-role',
    })
  }
  if (toolRoles !== undefined && toolRoles.length === 0) {
    findings.push({
      code: 'tool-not-granted',
      detail:
        'tool_grants grants reach_system itself to no role, which narrows every program grant to ' +
        'nobody: the tool is callable by no one',
    })
  }

  const instances = graph.byType.get(type.name) ?? []
  const connectors: ConnectorView[] = instances.map((object) => {
    const problems: Finding[] = []

    // Only checked when the deployment's name for the field is one the type declares: otherwise the
    // blank is the same blank on every route and `address-field-not-declared` already said it.
    const addressValue = object.data[request.shape.url]
    const addressSet = typeof addressValue === 'string' && addressValue.length > 0
    if (addressFinding === null && !addressSet) {
      problems.push({
        code: 'no-address',
        detail:
          `its "${request.shape.url}" field is empty, and this deployment configured that field as ` +
          'the address to dial',
      })
    }

    const rawName = object.data[request.shape.auth_ref]
    const credentialName = typeof rawName === 'string' ? rawName : ''
    if (credentialFinding === null) {
      if (credentialName.length === 0) {
        problems.push({
          code: 'no-credential-name',
          detail:
            `its "${request.shape.auth_ref}" field is empty, so nothing can be filed under it and ` +
            'nothing was dialled',
        })
      } else if (!isCredentialRefName(credentialName)) {
        problems.push({
          code: 'credential-name-outside-grammar',
          detail:
            'what its credential field holds is not a name the seam can address — a reference is an ' +
            'environment variable name: a letter or underscore followed by letters, digits and ' +
            'underscores',
        })
      }
    }

    // The lifecycle is read the same way a call reads it, including the blank-field fallback to
    // `initial`. Two answers to "is this route in the default state" would diverge exactly when a
    // domain sets `initial` and `default_state` to the same string.
    let state = ''
    let required: string | null = null
    let ok = true
    const lifecycle = type.lifecycle
    if (lifecycle !== undefined) {
      state = stateOf(object, lifecycle).state
      if (lifecycle.defaultState !== undefined) {
        required = lifecycle.defaultState
        ok = state === required
        if (!ok) {
          problems.push({
            code: 'not-in-default-state',
            detail:
              `it is in "${state}" and only a route in "${required}" is dialled, for the same reason ` +
              'a read of this domain hides it',
          })
        }
      }
    }

    // Two ways for a domain to say what a route reaches, because two real ones do it differently: a
    // relation out of the route type, or a field holding the name. Neither is a defect, and neither
    // stops a call — a route reaches what its address points at either way.
    const link = graph.links.find(
      (candidate) => candidate.fromType === type.name && candidate.from === object.id,
    )
    const rawTarget = targetField.length === 0 ? undefined : object.data[targetField]
    const system =
      link !== undefined
        ? link.to
        : typeof rawTarget === 'string' && rawTarget.length > 0
          ? rawTarget
          : null

    const attempts = trail.filter((entry) => entry.route === object.id)
    const last = attempts.at(-1)

    return {
      id: object.id,
      system,
      address: { field: request.shape.url, set: addressSet },
      credential: {
        field: request.shape.auth_ref,
        name: credentialName,
        addressable: credentialName.length > 0 && isCredentialRefName(credentialName),
      },
      callers: {
        program: request.program,
        programRoles: programRoles ?? null,
        toolRoles: toolRoles ?? null,
      },
      dialable: { state, required, ok },
      last: last === undefined ? null : toAttempt(last),
      refusals: attempts.filter((entry) => entry.outcome === 'denied').length,
      problems,
    }
  })

  // Neither a relation nor a configured target field: one finding, because the domain is the same for
  // every route and a page that repeated it per route would read as many broken routes.
  if (
    targetFinding === null &&
    targetField.length === 0 &&
    connectors.every((connector) => connector.system === null)
  ) {
    findings.push({
      code: 'no-target',
      detail:
        `type "${type.name}" declares no relation out of a route and this deployment configured no ` +
        'target field, so the page can show which routes exist but not what each one reaches; set ' +
        'route.target to the field holding the name, if the domain has one',
    })
  }

  const complete = connectors.filter((connector) => connector.problems.length === 0)
  const blocked = findings.some((finding) => BLOCKING.has(finding.code))
  return {
    root: request.root,
    routeType: type.name,
    program: request.program,
    auditLog: request.auditLog,
    readable: true,
    summary: {
      routes: connectors.length,
      complete: complete.length,
      callable: blocked ? 0 : complete.length,
      attempted: connectors.filter((connector) => connector.last !== null).length,
      refused: connectors.filter((connector) => connector.refusals > 0).length,
    },
    findings,
    note,
    connectors,
  }
}
