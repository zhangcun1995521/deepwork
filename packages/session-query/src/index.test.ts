/**
 * What the capability looks like once it is mounted.
 *
 * A separately tested operation is not the same as a registered tool. The failure this file exists
 * to catch is the quiet one: the tool never reaches the registry, or reaches it under a name the
 * prompt does not call, and every test beside this one stays green while the model has no tool at
 * all. So these claims are the mounting's — the name, the argument schema the model is handed, the
 * render intent a UI reads, and one call that goes all the way through `apply`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, inject, name, type RegisteredTool, type SessionQueryContext } from './index.ts'

const WORKSPACE = '/work/project'
const CALLER = { id: 'session-caller', createdAt: 1000, cwd: WORKSPACE }
const TARGET = { header: { ...CALLER }, live: true, persisted: true }

interface Mounted {
  ctx: SessionQueryContext
  tools: RegisteredTool[]
}

function mounted(options: { title?: string } = {}): Mounted {
  const tools: RegisteredTool[] = []
  return {
    tools,
    ctx: {
      tools: {
        register(tool): void {
          tools.push(tool)
        },
      },
      sessionQuery: {
        async filterSessions() {
          return []
        },
        async traceSession() {
          return { target: TARGET, ancestors: [], descendants: [], complete: true }
        },
        async readTitleSnapshots(sessionIds) {
          return sessionIds.map((sessionId) => ({
            sessionId,
            status: 'fulfilled' as const,
            value: {
              session: TARGET.header,
              ...options.title === undefined ? {} : { title: { title: options.title } },
            },
          }))
        },
      },
    },
  }
}

function only(tools: readonly RegisteredTool[]): RegisteredTool {
  assert.equal(tools.length, 1, 'a capability that registers nothing looks like one that failed to load')
  return tools[0] as RegisteredTool
}

test('a mounted profile gets the one tool the prompt already calls', () => {
  const h = mounted()
  apply(h.ctx)

  assert.equal(only(h.tools).name, 'session_trace')
  assert.equal(name, 'deepwork-session-query')
})

test('the plugin is held until both the registry and a corpus exist', () => {
  // `sessionQuery` is a requirement, not a courtesy: a tool that registered without a corpus would
  // fail on every call instead of reading as unconfigured at load.
  assert.deepEqual(inject, ['tools', 'sessionQuery'])
})

test('the parameters are the ones a prompt written against this tool already passes', () => {
  const h = mounted()
  apply(h.ctx)

  assert.deepEqual(only(h.tools).parameters, {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Target session id. Omit for the current session.' },
    },
  })
})

test('the result is one text block, and the schema says so', () => {
  const h = mounted()
  apply(h.ctx)
  const tool = only(h.tools)

  assert.deepEqual(tool.output.schema, { type: 'string' })
  assert.deepEqual(tool.output.render({}, 'Session x — y'), [{ type: 'text', text: 'Session x — y' }])
})

test('a call is presented as a read that names its target', () => {
  const h = mounted()
  apply(h.ctx)
  const tool = only(h.tools)

  assert.deepEqual(tool.presentCall?.({} as never), {
    card: 'generic',
    kind: 'read',
    title: 'Trace current session',
  })
  assert.deepEqual(tool.presentCall?.({ session_id: 'session-other' } as never), {
    card: 'generic',
    kind: 'read',
    title: 'Trace session session-other',
    rawInput: 'session-other',
  })
})

test('a trace is safe to run beside its siblings', () => {
  // It takes no cursor and holds no state between calls, so two of them cannot interfere; saying so
  // is what lets the scheduler overlap it with the rest of a turn's calls.
  const h = mounted()
  apply(h.ctx)

  assert.equal(only(h.tools).isConcurrencySafe?.({} as never), true)
})

test('a call with no target reaches the caller\'s own session through apply', async () => {
  const h = mounted({ title: 'Pick up the delivery' })
  apply(h.ctx)

  const text = await only(h.tools).execute({} as never, {
    signal: new AbortController().signal,
    agent: { session: { id: CALLER.id, header: CALLER } },
  })

  assert.equal(text, [
    'Session session-caller — Pick up the delivery',
    'Created: 1970-01-01T00:00:01.000Z',
    'Availability: live, persisted',
    '',
    'Ancestors (nearest first):',
    '- none (target is a root session)',
    '',
    'Descendants:',
    '- none',
  ].join('\n'))
})
