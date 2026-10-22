/**
 * Declared actions, derived into tools.
 *
 * The ontology model is objects, links, actions, functions. The first three and functions were
 * real here; `action_types` was parsed and counted but nothing derived from it, so a domain
 * could declare an action, watch it appear in the panel's summary, and get nothing when
 * calling it. A declaration that does not take effect is worse than no declaration: the author
 * believes it worked.
 *
 * An action is a thin shell over {@link writeEntity} — the same path the generic write tool
 * uses — so authority, lifecycle, independent review, counters, required fields, provenance
 * and audit all apply without being restated. What an action adds is intent: a name, and a
 * precondition that the entity must not exist (create) or must (update).
 *
 * @module @zhangcun123/ontology/tools/actions
 */

import type { ActionDecl } from '../engine/schema.ts'
import type { OntologyGraph } from '../engine/graph.ts'
import { RESULT_SCHEMA, renderResult, type DerivationResult, type JsonSchemaNode, type QueryResult, type ToolArgs } from './derive.ts'
import { writeEntity, type WriteOptions } from './write.ts'

/** Map a declared field onto a JSON Schema node, carrying its description and enum. */
function fieldNode(field: { type?: string; description?: string; values?: unknown[] }): JsonSchemaNode {
  const type =
    field.type === 'number' || field.type === 'integer'
      ? field.type
      : field.type === 'boolean'
        ? 'boolean'
        : field.type === 'array'
          ? 'array'
          : 'string'

  const node: JsonSchemaNode =
    type === 'array' ? { type: 'array', items: { type: 'string' } } : { type }

  const described: JsonSchemaNode = {
    ...node,
    ...(field.description === undefined ? {} : { description: field.description }),
  }
  // A reference is an id, so it is a string — saying so is the difference between the model
  // passing `P-001` and passing an object it invented.
  if (field.type === 'ref' && described.description === undefined) {
    described.description = 'Id of the related entity.'
  }
  const values = Array.isArray(field.values) ? field.values.filter((v): v is string => typeof v === 'string') : []
  return values.length > 0 ? { ...described, enum: values } : described
}

/**
 * Derive one tool per declared action.
 *
 * Actions are only derived when writes are configured, because an action is a write. A
 * deployment with no roles gets no write tool and no actions — which is the same promise as
 * everywhere else here: unconfigured means read-only, not permissive.
 */
export function deriveActionTools(graph: OntologyGraph, options: WriteOptions): DerivationResult {
  const warnings: string[] = []
  const tools: DerivationResult['tools'] = []
  const taken = new Set(['ontology_write', 'ontology_get', 'ontology_find', 'ontology_links', 'ontology_query'])

  for (const action of graph.schema.actions) {
    const type = graph.schema.objectTypes.get(action.target)
    if (type === undefined) {
      // The schema parser already warned about this; saying nothing here would be a silent
      // disappearance, so it is repeated where the tools are built.
      warnings.push(`action "${action.name}" targets an unknown type; no tool derived`)
      continue
    }
    if (taken.has(action.name)) {
      warnings.push(
        `action "${action.name}" collides with a tool of the same name; no tool derived`,
      )
      continue
    }
    taken.add(action.name)

    const properties: Record<string, JsonSchemaNode> = {
      [type.primaryKey]: {
        type: 'string',
        description: `Identity of the ${type.name}. Required for both create and update.`,
      },
    }
    for (const field of action.fields) {
      const declaration = type.fields[field]
      if (declaration === undefined) continue
      properties[field] = fieldNode(declaration)
    }

    // A create has to supply the fields the type requires; an update supplies only what it
    // changes, and the write path merges the rest from disk. Either way the identity is
    // required, because it is how the entity is found.
    const required =
      action.use === 'create'
        ? [type.primaryKey, ...action.fields.filter((field) => type.requiredFields.includes(field))]
        : [type.primaryKey]

    tools.push({
      name: action.name,
      description:
        `Declared action: ${action.use === 'create' ? 'create a new' : 'update an existing'} ` +
        `${type.name}. ` +
        (action.use === 'create'
          ? `Required: ${required.join(', ')}. `
          : `Supply only the fields to change; the rest are kept. `) +
        `Permitted for: ${action.by.length === 0 ? '(nobody)' : action.by.join(', ')}. ` +
        'The write is governed exactly as a direct write is: the same permissions, lifecycle, ' +
        'review and audit apply.',
      parameters: { type: 'object', properties, required },
      outputSchema: RESULT_SCHEMA,
      render: (args, value) =>
        renderResult(value as QueryResult, options.maxRenderedValueLength ?? 120, (name) =>
          graph.schema.objectTypes.get(name)?.primaryKey,
        ),
      execute: (args: ToolArgs, call) => {
        const id = args[type.primaryKey]
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error(`argument "${type.primaryKey}" is required and must be a non-empty string`)
        }
        // Only the fields the action declares, and only the ones actually supplied: an
        // update that omits a field must not blank it.
        const data: Record<string, unknown> = {}
        for (const field of action.fields) {
          if (Object.hasOwn(args, field)) data[field] = args[field]
        }
        return writeEntity(graph, options, {
          type: action.target,
          id,
          data,
          expect: action.use,
          // Enforced here, because a permission that is written down and not checked is worse
          // than one that was never claimed.
          ...(action.by.length === 0 ? {} : { requireRole: action.by }),
          auditAction: `action:${action.name}`,
          ...(call === undefined ? {} : { call }),
        })
      },
    })
  }

  return { tools, warnings }
}

/** The declared actions, for whoever renders what a domain produced. */
export function declaredActions(graph: OntologyGraph): ActionDecl[] {
  return graph.schema.actions
}

/**
 * Declared actions that produced no tool.
 *
 * Comparing counts is how a regression that stops deriving one of them shows up at all, but a
 * count cannot say *which* declaration went missing, and the reader's next move depends on
 * that. Returns names for that reason: the caller is expected to name the offender rather than
 * report two numbers that differ.
 *
 * Empty means the declaration is fully in effect, which is the only state worth calling clean.
 */
export function undeliveredActions(
  graph: OntologyGraph,
  derivedNames: readonly string[],
): string[] {
  const derived = new Set(derivedNames)
  return graph.schema.actions
    .filter((action) => !derived.has(action.name))
    .map((action) => action.name)
}
