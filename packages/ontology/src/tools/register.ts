/**
 * Bridge from derived tool specs to a runtime tool registry.
 *
 * This package depends on nothing from DSH. The registry is described by the smallest
 * structural interface this file actually uses, which keeps the whole package
 * installable on its own and every part of it testable without booting a runtime.
 *
 * The trade is compile-time checking against DSH's own types. That is worth less here
 * than it sounds: `@deepseek-ai/dsh-tools` is not dependably published — npm serves a
 * `0.0.1-rc.1` stub while the shipping runtime carries `0.1.7-rc.2` — so those types
 * could not be imported anyway. The boot smoke test is the real check, and it tests
 * more: that the runtime accepts these schemas at all.
 *
 * Registration is per-tool and isolated. One definition the runtime rejects must not
 * take the others down with it, and the rejection has to be reported rather than
 * swallowed — the same failure policy the engine follows.
 *
 * @module @zhangcun123/ontology/tools/register
 */

import type { OntologyGraph } from '../engine/graph.ts'
import {
  deriveTools,
  type DeriveOptions,
  type JsonSchemaNode,
  type ToolArgs,
  type ToolValue,
} from './derive.ts'
import { deriveActionTools } from './actions.ts'
import { deriveWriteTools, type WriteOptions } from './write.ts'

/** Content the runtime shows the model, in the shape DSH expects from `render`. */
export interface TextContent {
  type: 'text'
  text: string
}

/**
 * What the runtime tells a tool about the call it is serving.
 *
 * Only the identity is taken. The adapter deliberately does not model the rest of the
 * runtime's execution context — a wider surface here would tie this package to
 * release details it does not need and cannot test.
 */
export interface ExecutionContext {
  /** The agent the call is attributed to. */
  agent?: { id?: string }
}

/** A tool definition in the shape the runtime's `register` accepts. */
export interface RegisterableTool {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: JsonSchemaNode
  output: {
    /** JSON Schema for the canonical return value. */
    schema: JsonSchemaNode
    render: (args: ToolArgs, value: unknown) => TextContent[]
  }
  execute: (args: ToolArgs, exec?: ExecutionContext) => Promise<ToolValue> | ToolValue
}

/** The shape the runtime hands a guard: its own tool-execution object. */
export interface RuntimeToolCall {
  readonly name: string
  readonly arguments: unknown
  /** The agent on whose behalf the call runs. Absent when no agent is in scope. */
  readonly agent?: { readonly id: string }
}

/** The slice of a runtime tool registry this adapter needs. */
export interface ToolRegistry {
  register(definition: RegisterableTool): unknown
  /**
   * Register a guard: a function the runtime calls before dispatching any tool, where
   * a returned string refuses the call and `undefined` lets it through.
   *
   * The parameter is the runtime's own execution object. A guard written against a
   * hand-made shape of our own would compile and then never see an agent identity,
   * which is how a role check silently becomes a deny-everything check — this
   * signature is the runtime's, so the adapter has to do the mapping explicitly.
   *
   * Optional, because a registry also exists in tests and in profiles that do not run
   * the guard pipeline. Callers must say so out loud when it is missing rather than
   * assume unrestricted writes are fine — a guard that quietly fails to mount is worse
   * than one that was never written, because the domain still claims the rule applies.
   */
  guard?(guard: (call: RuntimeToolCall) => string | undefined): void
}

/** What registration produced, and what it could not. */
export interface RegistrationResult {
  /** Tool names the registry accepted. */
  registered: string[]
  /** Tool names the registry rejected, with the reason. */
  failed: string[]
  /** Non-fatal problems from the derivation itself. */
  warnings: string[]
}

/** Options for registering a domain's surface. */
export interface RegisterOptions extends DeriveOptions {
  /**
   * Write options. Omitting them registers no write tool at all; see the note in
   * `registerOntologyTools`.
   */
  writes?: WriteOptions
}

/** Render an unknown thrown value as a single-line message. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derive the domain's tool surface and register it.
 *
 * @param registry - The runtime's tool registry.
 * @param graph - Loaded domain graph.
 * @param options - Result caps, plus write options when the write surface is wanted.
 */
export function registerOntologyTools(
  registry: ToolRegistry,
  graph: OntologyGraph,
  options: RegisterOptions = {},
): RegistrationResult {
  const reads = deriveTools(graph, options)
  // Writes are opt-in. A deployment that has not said who may write gets no write tool
  // at all, rather than one that refuses every call — an always-refusing tool only
  // teaches the model to try something else.
  const writes =
    options.writes === undefined
      ? { tools: [], warnings: [] }
      : deriveWriteTools(graph, options.writes)
  // Actions come with the write half, because an action is a write. A deployment with no
  // roles gets neither, which is the same promise as everywhere else: unconfigured means
  // read-only rather than permissive.
  const actions =
    options.writes === undefined
      ? { tools: [], warnings: [] }
      : deriveActionTools(graph, options.writes)

  const registered: string[] = []
  const failed: string[] = []

  for (const tool of [...reads.tools, ...writes.tools, ...actions.tools]) {
    try {
      registry.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: {
          schema: tool.outputSchema,
          // The derivation returns prose; the runtime wants content blocks. Keeping
          // the derivation framework-free is what puts this conversion in one place.
          render: (args, value) => [{ type: 'text', text: tool.render(args, value as ToolValue) }],
        },
        // The caller's identity reaches the tool from here and nowhere else; a read
        // tool simply ignores it.
        execute: (args, exec) =>
          tool.execute(args, exec?.agent?.id === undefined ? {} : { agentId: exec.agent.id }),
      })
      registered.push(tool.name)
    } catch (error) {
      failed.push(`${tool.name}: ${reason(error)}`)
    }
  }

  return {
    registered,
    failed,
    warnings: [...reads.warnings, ...writes.warnings, ...actions.warnings],
  }
}
