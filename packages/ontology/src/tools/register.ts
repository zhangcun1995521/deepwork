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
 * @module @deepwork/ontology/tools/register
 */

import type { OntologyGraph } from '../engine/graph.ts'
import {
  deriveTools,
  type DeriveOptions,
  type JsonSchemaNode,
  type QueryResult,
  type ToolArgs,
} from './derive.ts'

/** Content the runtime shows the model, in the shape DSH expects from `render`. */
export interface TextContent {
  type: 'text'
  text: string
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
  execute: (args: ToolArgs) => Promise<QueryResult> | QueryResult
}

/** The slice of a runtime tool registry this adapter needs. */
export interface ToolRegistry {
  register(definition: RegisterableTool): unknown
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

/** Render an unknown thrown value as a single-line message. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derive the domain's tool surface and register it.
 *
 * @param registry - The runtime's tool registry.
 * @param graph - Loaded domain graph.
 * @param options - Result caps, forwarded to the derivation.
 */
export function registerOntologyTools(
  registry: ToolRegistry,
  graph: OntologyGraph,
  options: DeriveOptions = {},
): RegistrationResult {
  const { tools, warnings } = deriveTools(graph, options)
  const registered: string[] = []
  const failed: string[] = []

  for (const tool of tools) {
    try {
      registry.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: {
          schema: tool.outputSchema,
          // The derivation returns prose; the runtime wants content blocks. Keeping
          // the derivation framework-free is what puts this conversion in one place.
          render: (args, value) => [{ type: 'text', text: tool.render(args, value as QueryResult) }],
        },
        execute: (args) => tool.execute(args),
      })
      registered.push(tool.name)
    } catch (error) {
      failed.push(`${tool.name}: ${reason(error)}`)
    }
  }

  return { registered, failed, warnings }
}
