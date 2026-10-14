/**
 * What is around one session: the authorized lineage, and the text that says so.
 *
 * The host answers the question — `ctx.sessionQuery.traceSession` walks the live-preferred corpus —
 * and this module decides who may ask it and what the model is allowed to see back. Authority is
 * exact string equality between the target's stored `cwd` and the caller's, so a session outside
 * the caller's workspace is one it cannot read even when it can name it. A lineage that leaves that
 * workspace is cut at the boundary and the boundary is *marked* rather than blanked: the marker
 * carries no session id, because a marker that carried one would be the leak the boundary exists to
 * prevent.
 *
 * The other half of what this module owns is what a *failure* looks like. The service's own
 * messages name storage paths and corpus internals, and a tool result is model input; so every
 * service call goes through one translation that logs the real diagnostic where only an operator
 * reads it and returns a fixed sentence where the model does. Caller cancellation is checked before
 * that translation and preserved exactly, so an abort still arrives as its own reason.
 *
 * @module @zhangcun123/session-query/trace
 */

/** Storage metadata one session log carries, as far as a lineage read needs it. */
export interface SessionHeader {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
}

/** One live-preferred record for a session in the corpus. */
export interface SessionRecord {
  readonly header: SessionHeader
  /** Whether this id currently exists as a live session. */
  readonly live: boolean
  /** Whether the active persistence backend currently lists this id. */
  readonly persisted: boolean
}

/** One descendant: its record, and its own children. */
export interface SessionLineageNode {
  readonly session: SessionRecord
  readonly descendants: readonly SessionLineageNode[]
}

/**
 * Known ancestry and descendants for one session.
 *
 * `complete: false` means the parent chain leaves the corpus, so the ancestor list stops at the
 * last parent that could be resolved rather than at the root.
 */
export interface SessionLineageTrace {
  readonly target: SessionRecord
  readonly ancestors: readonly SessionRecord[]
  readonly descendants: readonly SessionLineageNode[]
  readonly complete: boolean
}

/** The latest folded title for one session. */
export interface SessionTitleSnapshot {
  readonly title: string
}

/** One session's header and its latest title, from a single observation. */
export interface SessionTitleObservation {
  readonly session: SessionHeader
  readonly title?: SessionTitleSnapshot
}

/** One ordered title result: a value, or a failure isolated to that session. */
export type SessionTitleObservationResult =
  | {
    readonly sessionId: string
    readonly status: 'fulfilled'
    readonly value: SessionTitleObservation
  }
  | {
    readonly sessionId: string
    readonly status: 'rejected'
    readonly reason: unknown
  }

/** One clause over the corpus. Only the two kinds a lineage read filters on. */
export type SessionFilter =
  | { readonly kind: 'id'; readonly values: readonly string[] }
  | { readonly kind: 'cwd'; readonly values: readonly (string | null)[] }

/**
 * The part of `ctx.sessionQuery` this capability reads.
 *
 * Declared here rather than imported. The host's service class would tie this package to one
 * release of it, and these three methods are the entire dependency — which is also what lets the
 * tests below stand in for the host with no runtime at all. A deployment must mount a provider for
 * `sessionQuery`; a lineage is not derivable from the tool registry.
 */
export interface SessionQuerySurface {
  filterSessions(filters: readonly SessionFilter[], signal?: AbortSignal): Promise<SessionRecord[]>
  traceSession(sessionId: string, signal?: AbortSignal): Promise<SessionLineageTrace>
  readTitleSnapshots(
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]>
}

/** The runtime slice one call runs with: who it is for, and what cancels it. */
export interface ToolExecution {
  readonly signal: AbortSignal
  /**
   * The agent on whose behalf the call runs — the only source of caller identity.
   *
   * Optional because the registry types it optional, and refused rather than defaulted when absent:
   * a call with no caller has no workspace, and so has no authority to read any session at all.
   */
  readonly agent?: { readonly session: { readonly id: string; readonly header: SessionHeader } }
}

/** What the runtime offers the operation besides the service. */
export interface QueryHost {
  readonly sessionQuery: SessionQuerySurface
  /** Where a failure the model must not read is recorded instead of shown. */
  readonly logger?: { warn(message: string): void }
}

/** The arguments `session_trace` accepts. */
export interface SessionTraceArgs {
  /** Target session id. Omit for the current session. */
  readonly session_id?: string
}

/** Who is asking, and the workspace that decides what it may read. */
interface Caller {
  readonly id: string
  readonly cwd: string | undefined
}

/** A subtree the caller may see, with `null` where it may not. */
interface VisibleDescendant {
  readonly record: SessionRecord
  readonly descendants: readonly (VisibleDescendant | null)[]
}

/** One title as the model will read it, or why it could not be read. */
interface TitleView {
  readonly text: string
  readonly unavailableCode?: string
}

const UNAUTHORIZED = 'SESSION_QUERY_TOOL_UNAUTHORIZED'
const FAILED = 'SESSION_QUERY_TOOL_FAILED'
const UNPRINTABLE = '[unprintable session query failure]'

/**
 * The failures that keep a specific sentence, keyed by the service's code.
 *
 * Short on purpose: it lists only the codes the three calls above can raise. A code outside it —
 * including one that belongs to the search and event tools that are not in this package — becomes
 * the fixed generic sentence, so a new upstream code arrives as "it failed" rather than as an
 * unread service message.
 */
const SAFE_FAILURES: Readonly<Record<string, string>> = {
  SESSION_QUERY_ABORTED: 'session query was cancelled',
  SESSION_QUERY_CORRUPT_SESSION: 'session event history is corrupt',
  SESSION_QUERY_INVALID_FILTER: 'session query filters were rejected',
  SESSION_QUERY_INVALID_LINEAGE: 'session lineage is invalid',
  SESSION_QUERY_INVALID_SURFACE: 'session event history is invalid',
  SESSION_QUERY_PERSISTENCE_FAILED: 'session history storage is unavailable',
  SESSION_QUERY_SESSION_NOT_FOUND: 'session was not found',
}

/**
 * Answer one `session_trace` call.
 *
 * @param host - the query surface, and where diagnostics go.
 * @param args - the target, or nothing for the caller's own session.
 * @param exec - caller identity and cancellation.
 * @returns the lineage as text for the model.
 */
export async function traceSessionText(
  host: QueryHost,
  args: SessionTraceArgs,
  exec: ToolExecution,
): Promise<string> {
  const caller = callerOf(exec)
  const target = args.session_id ?? caller.id
  await authorizeTarget(host, caller, target, exec.signal)
  const trace = await callService(host, exec.signal, 'session lineage trace', () =>
    host.sessionQuery.traceSession(target, exec.signal))
  assertTargetObserved(caller, target, trace.target.header)

  const ancestors: SessionRecord[] = []
  let boundary = false
  for (const ancestor of trace.ancestors) {
    if (!authorized(ancestor.header, caller)) {
      boundary = true
      break
    }
    ancestors.push(ancestor)
  }
  // A chain that left the corpus ended somewhere the caller cannot see, even though every ancestor
  // that *was* found here is one of its own.
  if (ancestors.length === trace.ancestors.length && !trace.complete) boundary = true

  const descendants = projectDescendants(trace.descendants, caller)
  const titles = await readTitles(host, caller, [
    trace.target.header.id,
    ...ancestors.map((record) => record.header.id),
    ...visibleIds(descendants),
  ], exec.signal)
  return renderTrace(trace, ancestors, boundary, descendants, titles)
}

/** Read caller identity, which only the execution carries and which never comes from the model. */
function callerOf(exec: ToolExecution): Caller {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error('session query tools require an agent-bound caller')
  }
  return { id: session.id, cwd: session.header.cwd }
}

/** Whether one observed header sits inside the caller's workspace. */
function authorized(header: SessionHeader, caller: Caller): boolean {
  if (header.id === caller.id) return header.cwd === caller.cwd
  return caller.cwd !== undefined && header.cwd === caller.cwd
}

/**
 * Refuse a target the caller's workspace does not contain, before the service is asked about it.
 *
 * The preflight is what makes a guess indistinguishable from an absence: a session that does not
 * exist and a session in somebody else's workspace both stop here, so a caller cannot use the
 * failure to learn which ids exist.
 */
async function authorizeTarget(
  host: QueryHost,
  caller: Caller,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  if (target === caller.id) return
  const cwd = caller.cwd
  if (cwd === undefined) throw unauthorized()
  const records = await callService(host, signal, 'target authorization', () =>
    host.sessionQuery.filterSessions([
      { kind: 'id', values: [target] },
      { kind: 'cwd', values: [cwd] },
    ], signal))
  if (records.length !== 1) throw unauthorized()
}

/** Refuse a lineage whose own record no longer matches the target that was authorized. */
function assertTargetObserved(caller: Caller, target: string, observed: SessionHeader): void {
  if (observed.id !== target || !authorized(observed, caller)) throw unauthorized()
}

/**
 * The refusal a caller gets for a target it may not read.
 *
 * One sentence covers both a session that does not exist and a session in somebody else's
 * workspace, deliberately: telling them apart would answer "does this id exist" for a caller with
 * no right to ask.
 */
function unauthorized(): Error {
  return new Error('session target is outside the caller workspace')
}

/** Keep the subtrees the caller may see, and mark the ones it may not with `null`. */
function projectDescendants(
  nodes: readonly SessionLineageNode[],
  caller: Caller,
): readonly (VisibleDescendant | null)[] {
  return nodes.map((node) => projectDescendant(node, caller))
}

function projectDescendant(node: SessionLineageNode, caller: Caller): VisibleDescendant | null {
  if (!authorized(node.session.header, caller)) return null
  return {
    record: node.session,
    descendants: node.descendants.map((child) => projectDescendant(child, caller)),
  }
}

function visibleIds(nodes: readonly (VisibleDescendant | null)[]): string[] {
  const ids: string[] = []
  for (const node of nodes) {
    if (node === null) continue
    ids.push(node.record.header.id)
    ids.push(...visibleIds(node.descendants))
  }
  return ids
}

/**
 * Fold every visible session's title in one observation.
 *
 * One batch rather than one call per session: the corpus resolves the whole list against a single
 * listing, and a title is presentation — a session whose title cannot be read is still a session
 * the model should be told about.
 */
async function readTitles(
  host: QueryHost,
  caller: Caller,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, TitleView>> {
  const views = new Map<string, TitleView>()
  const observations = await callService(host, signal, 'title observation', () =>
    host.sessionQuery.readTitleSnapshots(ids, signal))
  for (const observation of observations) {
    if (observation.status === 'rejected') {
      views.set(observation.sessionId, unavailableTitle(host, observation.reason))
      continue
    }
    assertTargetObserved(caller, observation.sessionId, observation.value.session)
    views.set(observation.sessionId, { text: observation.value.title?.title ?? 'untitled' })
  }
  return views
}

/**
 * Keep one unreadable title from taking the lineage with it — unless it was unreadable because the
 * caller was never entitled to it, which is a refusal and not a missing title.
 */
function unavailableTitle(host: QueryHost, reason: unknown): TitleView {
  const failure = refuse(host, 'title observation item', reason)
  if (failure.code === UNAUTHORIZED) throw new Error(failure.message)
  return { text: 'untitled', unavailableCode: failure.code }
}

/**
 * Call the service, and turn whatever comes back into something a model may read.
 *
 * The signal is checked on both sides of the call and once more in the failure path, so an abort
 * that happened during the call rethrows its own reason instead of the translated failure that the
 * aborted call produced.
 */
async function callService<Value>(
  host: QueryHost,
  signal: AbortSignal,
  operation: string,
  invoke: () => Promise<Value>,
): Promise<Value> {
  signal.throwIfAborted()
  try {
    const value = await invoke()
    signal.throwIfAborted()
    return value
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw new Error(refuse(host, operation, error).message)
  }
}

/**
 * The model-safe reading of one failure, with the real diagnostic sent to the log instead.
 *
 * The log line is the whole reason this exists: a service message names storage paths and corpus
 * internals, and this text becomes tool output, which is model input.
 */
function refuse(host: QueryHost, operation: string, error: unknown): { code: string; message: string } {
  const generic = { code: FAILED, message: 'session query operation failed' }
  try {
    host.logger?.warn(`session-query: ${operation} failed: ${diagnostic(error)}`)
    const code = codeOf(error)
    if (code !== undefined) {
      if (code === UNAUTHORIZED) return { code, message: 'session target is outside the caller workspace' }
      const message: string | undefined = SAFE_FAILURES[code]
      if (message !== undefined) return { code, message }
    }
    return generic
  } catch {
    // Logging and classification are guarded together so that an unreadable diagnostic cannot
    // replace a safely classified failure with an unprintable one.
    return generic
  }
}

/** Read the service's code, whatever shape the thrown value has. */
function codeOf(error: unknown): string | undefined {
  try {
    if (typeof error !== 'object' || error === null) return undefined
    const code: unknown = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

/** Render a failure for the log, following its causes, without trusting it to be printable. */
function diagnostic(error: unknown): string {
  try {
    const parts: string[] = []
    const seen = new Set<Error>()
    let current: unknown = error
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current)
      parts.push(current.stack ?? String(current))
      current = current.cause
    }
    return parts.join('\nCaused by: ')
  } catch {
    return UNPRINTABLE
  }
}

function renderTrace(
  trace: SessionLineageTrace,
  ancestors: readonly SessionRecord[],
  boundary: boolean,
  descendants: readonly (VisibleDescendant | null)[],
  titles: ReadonlyMap<string, TitleView>,
): string {
  const lines = [
    `Session ${trace.target.header.id} — ${titleText(titles.get(trace.target.header.id))}`,
    `Created: ${formatTime(trace.target.header.createdAt)}`,
    `Availability: ${availabilityText(trace.target)}`,
    '',
    'Ancestors (nearest first):',
  ]
  if (ancestors.length === 0 && !boundary) lines.push('- none (target is a root session)')
  for (const record of ancestors) {
    lines.push(
      `- ${record.header.id} — ${titleText(titles.get(record.header.id))}`
      + ` | ${formatTime(record.header.createdAt)} | ${availabilityText(record)}`,
    )
  }
  if (boundary) lines.push('- [outside workspace boundary]')
  lines.push('', 'Descendants:')
  if (descendants.length === 0) lines.push('- none')
  else renderDescendants(lines, descendants, titles, 0)
  return lines.join('\n')
}

function renderDescendants(
  lines: string[],
  nodes: readonly (VisibleDescendant | null)[],
  titles: ReadonlyMap<string, TitleView>,
  depth: number,
): void {
  for (const node of nodes) {
    const indent = '  '.repeat(depth)
    if (node === null) {
      lines.push(`${indent}- [outside workspace subtree]`)
      continue
    }
    const { header } = node.record
    lines.push(
      `${indent}- ${header.id} — ${titleText(titles.get(header.id))}`
      + ` | ${formatTime(header.createdAt)} | ${availabilityText(node.record)}`,
    )
    renderDescendants(lines, node.descendants, titles, depth + 1)
  }
}

function titleText(view: TitleView | undefined): string {
  if (view === undefined) return 'untitled'
  return view.unavailableCode === undefined
    ? view.text
    : `${view.text} (title unavailable: ${view.unavailableCode})`
}

function availabilityText(record: SessionRecord): string {
  return [
    record.live ? 'live' : undefined,
    record.persisted ? 'persisted' : undefined,
  ].filter((value): value is string => value !== undefined).join(', ') || 'unavailable'
}

function formatTime(value: number): string {
  return new Date(value).toISOString()
}
