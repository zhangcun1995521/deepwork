/**
 * Session lineage, for a model, from the host's own session-query service.
 *
 * A session's history does not end at its own log. A subagent's session has a parent, a parent has
 * a chain above it, and a task that was handed on has children below — and a model asked to pick up
 * work that another session started has no way to see any of that from inside its own turn. This
 * capability puts that one question in front of it: `session_trace`, which answers "what is around
 * this session" from the corpus the deployment already indexes.
 *
 * Two things about it are deliberate, and both are about trust rather than about features.
 *
 * **The caller comes from the execution, never from the arguments.** `exec.agent.session` is the
 * only source of identity, so the model cannot name a workspace it would like to read. A target is
 * admitted only when its own stored `cwd` is exactly the caller's, which is conservative — two
 * symlinked paths to one directory do not count as one workspace — and that conservatism is the
 * point: the alternative is a boundary that resolves links at read time, in a tool whose whole job
 * is reading history.
 *
 * **What leaves the workspace is marked, not described.** A lineage that crosses out of the
 * caller's workspace stops there and says so, with a marker carrying no session id. A trace that
 * listed the hidden session would be a directory of other people's work; one that simply stopped
 * would read as "there is nothing above this", which is a different and false answer.
 *
 * This plugin is opt-in, in the same sense as the model-facing session-query tool upstream: it is
 * mounted by a deployment that wants it, and shipped surfaces do not carry its schema or any prompt
 * guidance with it.
 *
 * @module @zhangcun123/session-query
 */

import { traceSessionText, type SessionQuerySurface, type ToolExecution } from './trace.ts'

/** Plugin name, as the runtime's loader sees it. */
export const name = 'deepwork-session-query'

/**
 * Held until the tool registry exists and a session-query provider answers.
 *
 * `sessionQuery` is a real requirement rather than an optional one: without a corpus there is
 * nothing to trace, and a tool that registered anyway would fail on every call instead of reading
 * as unconfigured at load.
 */
export const inject = ['tools', 'sessionQuery']

/** A registered tool, in the shape the runtime's registry accepts. */
export interface RegisteredTool {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
  isConcurrencySafe?: (args: never) => boolean
  presentCall?: (args: never) => unknown
  execute: (args: never, exec: ToolExecution) => Promise<unknown>
}

/** The slice of the runtime context this plugin uses. Structural, and so host-free. */
export interface SessionQueryContext {
  tools: { register(tool: RegisteredTool): void }
  sessionQuery: SessionQuerySurface
  logger?: { warn(message: string): void }
}

/**
 * The tool's parameters, as the model reads them.
 *
 * Written out as the raw schema the registry takes, which is the compiled form of the upstream
 * tool's one-property spec. `session_id` is optional in both, and so is an omitted root
 * `additionalProperties`, which is what upstream sends: the model that omits the parameter gets its
 * own session, and one that invents a parameter is not told about a constraint upstream does not
 * impose.
 */
const PARAMETERS = {
  type: 'object',
  properties: {
    session_id: {
      type: 'string',
      description: 'Target session id. Omit for the current session.',
    },
  },
} as const

/**
 * The result is one string, which is what a lineage is for: a model reads a shape it can reason
 * about and a person reads the same lines in a log.
 */
const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: value as string }],
}

/** The pending-call card, kept from upstream so a UI renders this call as a read. */
function presentSessionTraceCall(args: { readonly session_id?: string }): unknown {
  return {
    card: 'generic',
    kind: 'read',
    title: args.session_id === undefined ? 'Trace current session' : `Trace session ${args.session_id}`,
    ...args.session_id === undefined ? {} : { rawInput: args.session_id },
  }
}

/**
 * Register the tool.
 *
 * @param ctx - The runtime context.
 */
export function apply(ctx: SessionQueryContext): void {
  ctx.tools.register({
    name: 'session_trace',
    description:
      'Read the authorized session lineage around one session, including complete visible ancestor '
      + 'and descendant relationships.',
    parameters: PARAMETERS,
    output: TEXT_OUTPUT,
    // A trace is an observation of a corpus that may move under it, and it takes no cursor and
    // holds no state between calls, so sibling calls cannot interfere with it.
    isConcurrencySafe: () => true,
    execute: (args: { readonly session_id?: string }, exec: ToolExecution) =>
      traceSessionText(ctx, args, exec),
    presentCall: presentSessionTraceCall,
  })
}
