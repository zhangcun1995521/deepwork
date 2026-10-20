/**
 * The model-facing `lsp` tool.
 *
 * One read-only tool with four operations. The schema, the prompt guidance, the coordinate
 * convention and the rendering live here and nowhere else: a provider answers the four semantic
 * questions in the seam's zero-based positions and knows nothing about what the model sees.
 *
 * The names and the argument shape are the ported contract and are not ours to improve. A prompt
 * that says `operation: "findReferences"` with a one-based `line` is already written against them,
 * and changing any of it would mean editing that prompt.
 *
 * @module @zhangcun123/lsp/tool
 */

import { LspError } from './seam.ts'
import type { LspQueryResult, LspRange, LspService } from './seam.ts'
import { MAX_TIMER_DELAY_MS } from './provider.ts'
import {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatHover,
  formatLocations,
  LSP_OPERATIONS,
  parseLspArgs,
  presentLspCall,
} from './render.ts'
import type { GenericCallView, LspToolArgs } from './render.ts'

/** The stable system-prompt section name for this tool. */
export const LSP_PROMPT_SECTION = 'tool:lsp'

/**
 * The section's order: the host's own `SECTION_ORDERS.TOOL_LSP` slot, which it reserves for exactly
 * this tool. The upstream copy of this file used a bare `112`, a number no prompt registry gave a
 * meaning to; the host's table does, so the port takes the slot the host named.
 */
export const LSP_PROMPT_ORDER = 2200

/** The stable prompt guidance positioning LSP as a precision aid rather than a default. */
export const LSP_PROMPT_TEXT =
  'Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration.'

/** Default tool-call timeout budget (ms), covering the queued read, open, query, and close. */
export const DEFAULT_LSP_TOOL_TIMEOUT_MS = 60_000

/** One block of model-facing content, in the shape the runtime's renderer returns. */
export interface TextContent {
  readonly type: 'text'
  readonly text: string
}

/**
 * What the runtime tells the tool about the call it is serving.
 *
 * Only the cancellation signal and the caller's session workspace are taken. The workspace is read
 * from the session header rather than defaulted, because a language server has to be given a real
 * root to index and a guessed one answers about the wrong files.
 */
export interface LspToolExecution {
  /** Caller cancellation, forwarded to the language server. */
  readonly signal: AbortSignal
  /** The calling agent, when the call has one; absent for a non-agent caller. */
  readonly agent?: {
    readonly session: {
      readonly header: {
        readonly cwd?: string
      }
    }
  }
}

/** A tool definition in the shape the runtime's `register` accepts. */
export interface RegisterableTool {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>
  output: {
    /** JSON Schema for the canonical return value, enforced by the runtime. */
    schema: Record<string, unknown>
    render: (args: LspToolArgs, value: LspQueryResult) => TextContent[]
  }
  /** Cooperative tool-call timeout budget in milliseconds; never sent to the model. */
  timeoutMs?: number
  execute: (args: LspToolArgs, exec: LspToolExecution) => Promise<LspQueryResult>
  /** Pure pending-state presenter, derived from the arguments alone. */
  presentCall?: (args: LspToolArgs) => GenericCallView
}

/** The slice of the runtime this tool contributes to. Structural, and so host-free. */
export interface LspToolContext {
  tools: { register(definition: RegisterableTool): unknown }
  /**
   * The prompt registry, when the composition has one.
   *
   * Optional on purpose: the tool works without it and the section is an advertisement. A host
   * without one gets a working `lsp` tool whose existence the model is not told about, which is a
   * degradation of manner rather than of capability.
   */
  systemPrompt?: { section(section: { name: string; order: number; text: string }): unknown }
}

/** The tool's own settings, taken from the composition that mounts this plugin. */
export interface LspToolConfig {
  /** Largest number of rendered locations before an omission marker. Default 100. */
  maxLocations?: number
  /** Largest complete rendered result in characters, including truncation metadata. Default 16000. */
  maxResultChars?: number
  /** Tool-call timeout budget in milliseconds. Default 60000. */
  timeoutMs?: number
}

const POSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer' },
    character: { type: 'integer' },
  },
  required: ['line', 'character'],
} as const

const RANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: POSITION_SCHEMA,
    end: POSITION_SCHEMA,
  },
  required: ['start', 'end'],
} as const

/**
 * The canonical result schema: the closed union the seam produces, in the enforced JSON Schema
 * subset. `oneOf` stands alone at the root because the subset rejects sibling keywords beside it,
 * and each branch declares its own `type`, `properties`, and `required`.
 */
const LSP_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'locations' },
        locations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              uri: { type: 'string' },
              range: RANGE_SCHEMA,
            },
            required: ['uri', 'range'],
          },
        },
        resolvedWorkspaceUri: { type: 'string' },
      },
      required: ['kind', 'locations', 'resolvedWorkspaceUri'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'hover' },
        hover: {
          oneOf: [
            { type: 'null' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                contents: { type: 'string' },
                range: RANGE_SCHEMA,
              },
              required: ['contents'],
            },
          ],
        },
      },
      required: ['kind', 'hover'],
    },
  ],
} as const

/** The `lsp` arguments, as the model sees them. */
const LSP_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: {
      type: 'string',
      enum: [...LSP_OPERATIONS],
      description: 'goToDefinition, findReferences, goToImplementation, or hover.',
    },
    file_path: {
      type: 'string',
      description: 'The source file to query, relative to the workspace or absolute.',
    },
    line: { type: 'number', description: 'One-based line of the cursor.' },
    character: { type: 'number', description: 'One-based UTF-16 column of the cursor.' },
  },
  required: ['operation', 'file_path', 'line', 'character'],
} as const

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * @param exec - the tool-execution context; only its optional agent is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller.
 */
export function sessionCwd(exec: LspToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * Register the `lsp` tool and its prompt guidance.
 * @param ctx - the runtime surfaces this tool contributes to.
 * @param lsp - the seam to query.
 * @param config - the tool's settings.
 * @throws Error when a cap or the timeout budget is not a positive integer in timer range.
 */
export function registerLspTool(ctx: LspToolContext, lsp: LspService, config: LspToolConfig = {}): void {
  const maxLocations = config.maxLocations ?? DEFAULT_MAX_LOCATIONS
  const maxResultChars = config.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  const timeoutMs = config.timeoutMs ?? DEFAULT_LSP_TOOL_TIMEOUT_MS
  assertPositiveInteger('maxLocations', maxLocations)
  assertPositiveInteger('maxResultChars', maxResultChars)
  assertTimer('timeoutMs', timeoutMs)

  ctx.systemPrompt?.section({ name: LSP_PROMPT_SECTION, order: LSP_PROMPT_ORDER, text: LSP_PROMPT_TEXT })

  ctx.tools.register({
    name: 'lsp',
    description:
      'Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, goToImplementation, hover. line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration.',
    parameters: LSP_PARAMETERS_SCHEMA,
    output: {
      schema: LSP_OUTPUT_SCHEMA,
      render: (_args, value) => {
        switch (value.kind) {
          case 'locations':
            return [{
              type: 'text',
              text: formatLocations(value.locations, value.resolvedWorkspaceUri, maxLocations, maxResultChars),
            }]
          case 'hover':
            return [{ type: 'text', text: formatHover(value.hover, maxResultChars) }]
        }
      },
    },
    timeoutMs,
    async execute(args, exec) {
      const input = parseLspArgs(args)
      const workspaceRoot = sessionCwd(exec)
      if (workspaceRoot === undefined) {
        throw new LspError('the lsp tool requires a session workspace cwd', 'LSP_WORKSPACE_REQUIRED')
      }
      const result = await lsp.query({
        operation: input.operation,
        filePath: input.filePath,
        position: input.position,
        workspaceRoot,
      }, exec.signal)
      return projectResult(result)
    },
    presentCall: presentLspCall,
  })
}

/**
 * Re-shape a seam result into exactly the declared canonical value.
 *
 * The optional hover range is the reason: spreading `undefined` into the value would put a key the
 * output schema does not accept in front of the runtime's own validation, and the call would fail
 * after the answer had already been fetched.
 */
function projectResult(result: LspQueryResult): LspQueryResult {
  switch (result.kind) {
    case 'locations':
      return {
        kind: 'locations',
        locations: result.locations.map(location => ({
          uri: location.uri,
          range: projectRange(location.range),
        })),
        resolvedWorkspaceUri: result.resolvedWorkspaceUri,
      }
    case 'hover':
      return {
        kind: 'hover',
        hover: result.hover === null
          ? null
          : {
            contents: result.hover.contents,
            ...result.hover.range === undefined ? {} : { range: projectRange(result.hover.range) },
          },
      }
  }
}

/** Copy a range into a fresh plain value, so nothing the provider holds is exposed as the result. */
function projectRange(range: LspRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

/** Reject a non-positive-integer setting at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`lsp: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`lsp: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
