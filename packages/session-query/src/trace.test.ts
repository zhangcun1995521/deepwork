/**
 * What `session_trace` answers, and who it refuses.
 *
 * These tests drive the operation directly against a fake corpus, because the claims being made are
 * about a *boundary* rather than about mounting: which sessions one caller may name, what a lineage
 * that crosses out of its workspace looks like, and what a failure reads like when the model is the
 * reader. None of that is visible from a registered tool definition, and none of it needs a runtime
 * — the surface this plugin consumes is three methods, so a fake stands in for the host exactly.
 *
 * The fixtures are lineages, not session logs: the host computes the lineage and this package
 * decides who sees it, so a test that rebuilt the walk would be testing the wrong package.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  traceSessionText,
  type QueryHost,
  type SessionLineageNode,
  type SessionLineageTrace,
  type SessionQuerySurface,
  type SessionRecord,
  type ToolExecution,
} from './trace.ts'

const WORKSPACE = '/work/project'
const ELSEWHERE = '/work/other'
const UNAUTHORIZED = 'SESSION_QUERY_TOOL_UNAUTHORIZED'

interface World {
  host: QueryHost
  /** Every service call, in order, as `method:argument`. */
  calls: string[]
  /** Everything the operation logged, in order. */
  logs: string[]
  /** The execution a call runs with: the caller's own session, and cancellation. */
  exec: ToolExecution
}

function record(id: string, cwd: string | undefined, createdAt: number): SessionRecord {
  return {
    header: { id, createdAt, ...cwd === undefined ? {} : { cwd } },
    live: true,
    persisted: true,
  }
}

function node(session: SessionRecord, descendants: SessionLineageNode[] = []): SessionLineageNode {
  return { session, descendants }
}

function lineage(
  target: SessionRecord,
  ancestors: readonly SessionRecord[],
  descendants: readonly SessionLineageNode[],
  complete = true,
): SessionLineageTrace {
  return { target, ancestors, descendants, complete }
}

/** A failure the service raises with a code, which is how it classifies its own failures. */
function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * A corpus that answers the two questions authority asks, and replays a lineage fixture.
 *
 * `filterSessions` really does match on the clauses it is handed, so a test that gets an
 * authorization answer has exercised the request rather than a stub that always said yes.
 */
function world(options: {
  caller?: SessionRecord
  corpus?: readonly SessionRecord[]
  trace?: SessionLineageTrace | Error
  /** A title per session id; an `Error` value is a rejected observation with that reason. */
  titles?: ReadonlyMap<string, string | Error>
  logger?: QueryHost['logger']
  signal?: AbortSignal
} = {}): World {
  const caller = options.caller ?? record('session-caller', WORKSPACE, 3000)
  const trace = options.trace
  const calls: string[] = []
  const logs: string[] = []
  const known = new Map<string, SessionRecord>(
    [...options.corpus ?? [], ...trace instanceof Error || trace === undefined ? [] : within(trace)]
      .map((entry) => [entry.header.id, entry]),
  )
  known.set(caller.header.id, caller)

  const sessionQuery: SessionQuerySurface = {
    async filterSessions(filters) {
      calls.push(`filterSessions:${JSON.stringify(filters)}`)
      const ids = filters.filter((filter) => filter.kind === 'id').flatMap((filter) => filter.values)
      const cwds = filters.filter((filter) => filter.kind === 'cwd').flatMap((filter) => filter.values)
      return [...known.values()].filter(
        (entry) => ids.includes(entry.header.id) && cwds.includes(entry.header.cwd ?? null),
      )
    },
    async traceSession(sessionId) {
      calls.push(`traceSession:${sessionId}`)
      if (trace === undefined) throw new Error('no lineage fixture')
      if (trace instanceof Error) throw trace
      return trace
    },
    async readTitleSnapshots(sessionIds) {
      calls.push(`readTitleSnapshots:${sessionIds.join(',')}`)
      return sessionIds.map((sessionId) => {
        const entry = known.get(sessionId)
        const title = options.titles?.get(sessionId)
        if (entry === undefined || title instanceof Error) {
          return {
            sessionId,
            status: 'rejected' as const,
            reason: title instanceof Error ? title : new Error('unknown session'),
          }
        }
        return {
          sessionId,
          status: 'fulfilled' as const,
          value: { session: entry.header, ...title === undefined ? {} : { title: { title } } },
        }
      })
    },
  }

  return {
    host: {
      sessionQuery,
      logger: options.logger ?? { warn: (message: string) => logs.push(message) },
    },
    calls,
    logs,
    exec: {
      signal: options.signal ?? new AbortController().signal,
      agent: { session: { id: caller.header.id, header: caller.header } },
    },
  }
}

/** Every record a lineage fixture carries, so the fake corpus can resolve titles for them. */
function within(trace: SessionLineageTrace): SessionRecord[] {
  const records = [trace.target, ...trace.ancestors]
  const walk = (nodes: readonly SessionLineageNode[]): void => {
    for (const entry of nodes) {
      records.push(entry.session)
      walk(entry.descendants)
    }
  }
  walk(trace.descendants)
  return records
}

/** The shape a refusal has, matched by sentence because that is what the model reads. */
function refusedAs(sentence: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && error.message === sentence
}

test('the caller\'s own session needs no authorization question', async () => {
  const own = record('session-caller', WORKSPACE, 1000)
  const w = world({ caller: own, trace: lineage(own, [], []) })
  const text = await traceSessionText(w.host, {}, w.exec)

  assert.deepEqual(w.calls, ['traceSession:session-caller', 'readTitleSnapshots:session-caller'])
  assert.match(text, /^Session session-caller — untitled\n/)
})

test('a target is admitted only on an exact cwd match with the caller', async () => {
  const other = record('session-other', WORKSPACE, 2000)
  const w = world({ corpus: [other], trace: lineage(other, [], []) })
  await traceSessionText(w.host, { session_id: 'session-other' }, w.exec)

  // Both clauses in one request: an id clause alone would admit any id, and the workspace clause is
  // the half that decides.
  assert.equal(
    w.calls[0],
    `filterSessions:${JSON.stringify([
      { kind: 'id', values: ['session-other'] },
      { kind: 'cwd', values: [WORKSPACE] },
    ])}`,
  )
})

test('a target outside the caller\'s workspace is refused before the corpus is asked for it', async () => {
  const hidden = record('session-hidden', ELSEWHERE, 2000)
  const w = world({ corpus: [hidden], trace: lineage(hidden, [], []) })

  await assert.rejects(
    () => traceSessionText(w.host, { session_id: 'session-hidden' }, w.exec),
    refusedAs('session target is outside the caller workspace'),
  )
  // The refusal is the preflight's, so somebody else's lineage was never read.
  assert.equal(w.calls.filter((call) => call.startsWith('traceSession:')).length, 0)
})

test('a caller with no workspace of its own may read only itself', async () => {
  const own = record('session-caller', undefined, 1000)
  const other = record('session-other', undefined, 2000)
  const w = world({ caller: own, corpus: [other], trace: lineage(own, [], []) })

  await assert.rejects(
    () => traceSessionText(w.host, { session_id: 'session-other' }, w.exec),
    refusedAs('session target is outside the caller workspace'),
  )
  assert.match(await traceSessionText(w.host, {}, w.exec), /Session session-caller/)
})

test('a call with no caller is refused rather than defaulted to somebody', async () => {
  const own = record('session-caller', WORKSPACE, 1000)
  const w = world({ caller: own, trace: lineage(own, [], []) })

  await assert.rejects(
    () => traceSessionText(w.host, {}, { signal: w.exec.signal }),
    refusedAs('session query tools require an agent-bound caller'),
  )
})

test('a lineage that leaves the workspace is cut, and the marker names nobody', async () => {
  const own = record('session-caller', WORKSPACE, 3000)
  const hiddenAncestor = record('session-hidden-parent', ELSEWHERE, 1000)
  const hiddenChild = record('session-hidden-child', ELSEWHERE, 4000)
  const w = world({
    caller: own,
    trace: lineage(own, [record('session-parent', WORKSPACE, 2000), hiddenAncestor], [
      node(record('session-visible-child', WORKSPACE, 4000)),
      node(hiddenChild),
    ]),
  })

  const text = await traceSessionText(w.host, {}, w.exec)
  assert.match(text, /- \[outside workspace boundary\]/)
  assert.match(text, /- \[outside workspace subtree\]/)
  for (const hidden of [hiddenAncestor, hiddenChild]) {
    assert.ok(!text.includes(hidden.header.id), `the boundary marker leaked "${hidden.header.id}"`)
  }
  // The ancestor the caller may see is still listed and the visible child still hangs under the
  // target: the cut is a boundary, not the abandonment of everything past it.
  assert.match(text, /- session-parent —/)
  assert.match(text, /- session-visible-child —/)
})

test('a chain that left the corpus entirely still reads as a boundary', async () => {
  const own = record('session-caller', WORKSPACE, 3000)
  const w = world({ caller: own, trace: lineage(own, [record('session-parent', WORKSPACE, 2000)], [], false) })

  const text = await traceSessionText(w.host, {}, w.exec)
  assert.match(text, /- session-parent —/)
  assert.match(text, /- \[outside workspace boundary\]/)
})

test('the result is a lineage a reader can follow, down to the line', async () => {
  const own = record('session-caller', WORKSPACE, 3000)
  const w = world({
    caller: own,
    trace: lineage(own, [record('session-parent', WORKSPACE, 500)], [
      node(record('session-child', WORKSPACE, 4000), [node(record('session-grandchild', WORKSPACE, 5000))]),
    ]),
    titles: new Map([
      ['session-caller', 'Pick up the delivery'],
      ['session-parent', 'Plan the delivery'],
      ['session-child', 'Draft the plan'],
      ['session-grandchild', 'Review the draft'],
    ]),
  })

  assert.equal(await traceSessionText(w.host, {}, w.exec), [
    'Session session-caller — Pick up the delivery',
    'Created: 1970-01-01T00:00:03.000Z',
    'Availability: live, persisted',
    '',
    'Ancestors (nearest first):',
    '- session-parent — Plan the delivery | 1970-01-01T00:00:00.500Z | live, persisted',
    '',
    'Descendants:',
    '- session-child — Draft the plan | 1970-01-01T00:00:04.000Z | live, persisted',
    '  - session-grandchild — Review the draft | 1970-01-01T00:00:05.000Z | live, persisted',
  ].join('\n'))
})

test('a root session says so rather than printing an empty list', async () => {
  const own = record('session-caller', WORKSPACE, 3000)
  const w = world({ caller: own, trace: lineage(own, [], []) })

  const text = await traceSessionText(w.host, {}, w.exec)
  assert.match(text, /- none \(target is a root session\)/)
  assert.match(text, /Descendants:\n- none/)
})

test('a title that cannot be folded leaves its session in place, with a marker', async () => {
  const own = record('session-caller', WORKSPACE, 3000)
  const w = world({
    caller: own,
    trace: lineage(own, [], []),
    titles: new Map([['session-caller', coded('unreadable', 'SESSION_QUERY_PERSISTENCE_FAILED')]]),
  })

  assert.match(
    await traceSessionText(w.host, {}, w.exec),
    /Session session-caller — untitled \(title unavailable: SESSION_QUERY_PERSISTENCE_FAILED\)/,
  )
})

test('a title whose header came back unauthorized fails the whole call', async () => {
  const own = record('session-caller', WORKSPACE, 3000)
  const w = world({
    caller: own,
    trace: lineage(own, [], []),
    titles: new Map([['session-caller', coded('denied', UNAUTHORIZED)]]),
  })

  // A missing title is presentation; an unauthorized one means the corpus handed back a record the
  // caller was never entitled to, which is a boundary failure and not a rendering problem.
  await assert.rejects(
    () => traceSessionText(w.host, {}, w.exec),
    refusedAs('session target is outside the caller workspace'),
  )
})

test('a lineage whose own record no longer matches the target is refused', async () => {
  const w = world({ trace: lineage(record('session-caller', ELSEWHERE, 3000), [], []) })

  await assert.rejects(
    () => traceSessionText(w.host, {}, w.exec),
    refusedAs('session target is outside the caller workspace'),
  )
})

test('a failing call is translated for the model and logged whole for an operator', async () => {
  const w = world({
    trace: coded('/corpus/private/session-caller.jsonl could not be read', 'SESSION_QUERY_PERSISTENCE_FAILED'),
  })

  await assert.rejects(
    () => traceSessionText(w.host, {}, w.exec),
    refusedAs('session history storage is unavailable'),
  )
  assert.ok(
    w.logs.some((line) => line.includes('/corpus/private/session-caller.jsonl')),
    'the diagnostic belongs in the log, which is the only reason it is not in the result',
  )
})

test('a code this package does not know becomes the fixed generic sentence', async () => {
  const w = world({ trace: coded('something new upstream', 'SESSION_QUERY_SOMETHING_NEW') })

  // A new upstream code arrives as "it failed", never as an unread service message.
  await assert.rejects(
    () => traceSessionText(w.host, {}, w.exec),
    refusedAs('session query operation failed'),
  )
  assert.ok(w.logs.some((line) => line.includes('something new upstream')))
})

test('an unprintable failure, and a log sink that throws, both end as the generic sentence', async () => {
  const poisoned = new Error('poisoned')
  Object.defineProperty(poisoned, 'stack', {
    get() {
      throw new Error('unprintable')
    },
  })
  const w = world({ trace: poisoned })
  const brokenSink = world({
    trace: coded('unreadable', 'SESSION_QUERY_PERSISTENCE_FAILED'),
    logger: { warn: () => { throw new Error('log sink is down') } },
  })

  await assert.rejects(() => traceSessionText(w.host, {}, w.exec), refusedAs('session query operation failed'))
  assert.ok(w.logs.some((line) => line.includes('[unprintable session query failure]')))
  await assert.rejects(
    () => traceSessionText(brokenSink.host, {}, brokenSink.exec),
    refusedAs('session query operation failed'),
  )
})

test('cancellation arrives as its own reason, never as a translated failure', async () => {
  const own = record('session-caller', WORKSPACE, 3000)
  const reason = new Error('the turn was cancelled by the operator')
  const before = new AbortController()
  before.abort(reason)
  const during = new AbortController()
  const base = world({ caller: own, trace: lineage(own, [], []) })
  const cancelling: SessionQuerySurface = {
    ...base.host.sessionQuery,
    async traceSession() {
      during.abort(reason)
      return lineage(own, [], [])
    },
  }
  const host: QueryHost = { ...base.host, sessionQuery: cancelling }

  const already = (error: unknown): boolean => error === reason
  await assert.rejects(
    () => traceSessionText(host, {}, { signal: before.signal, agent: base.exec.agent }),
    already,
  )
  // Aborted while the service was working: the translation must not replace the caller's reason
  // with a sentence about storage.
  await assert.rejects(
    () => traceSessionText(host, {}, { signal: during.signal, agent: base.exec.agent }),
    already,
  )
})

test('every visible session is asked for its title in one observation', async () => {
  const own = record('session-caller', WORKSPACE, 3000)
  const w = world({
    caller: own,
    trace: lineage(own, [record('session-parent', WORKSPACE, 2000)], [
      node(record('session-child', WORKSPACE, 4000)),
      node(record('session-hidden', ELSEWHERE, 5000)),
    ]),
  })

  await traceSessionText(w.host, {}, w.exec)
  assert.equal(w.calls.at(-1), 'readTitleSnapshots:session-caller,session-parent,session-child')
})
