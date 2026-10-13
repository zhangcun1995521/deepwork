/**
 * The browser-facing view of a loaded domain.
 *
 * The panel's job is to show what the engine derived, so this returns the engine's own
 * vocabulary — object types, link types, tool definitions — rather than a presentation
 * model. Translating it here would hide the thing worth looking at.
 *
 * It carries an **index** of entities, not their contents. A real ontology is hundreds
 * of instances whose fields hold paragraphs, and shipping all of that to the browser to
 * render a page nobody has scrolled yet is waste. The index is enough to show scale and
 * to browse by type; a detail view can fetch one entity when there is a reason to.
 *
 * Read and write tools are both derived, and the write half is derived *with the
 * supplied role map* rather than the deployment's. That is the point of taking `roles`
 * as an argument: it lets the panel answer "what would this role see", which is the
 * question a governance model has to be able to answer out loud.
 *
 * @module @zhangcun/web
 */

import type { OntologyGraph } from './engine/graph.ts'
import type { RoleRule } from './govern/permission.ts'
import { deriveTools, type DeriveOptions, type DerivedToolSpec } from './tools/derive.ts'
import { deriveWriteTools } from './tools/write.ts'

/** A tool definition as the model receives it, minus the closures. */
export interface ToolView {
  name: string
  description: string
  parameters: unknown
  outputSchema: unknown
}

/** Everything the panel shows for one domain. */
export interface DomainSnapshot {
  root: string
  /** Role map this snapshot's write half was derived with. */
  roles: readonly RoleRule[]
  summary: {
    objects: number
    links: number
    objectTypes: number
    linkTypes: number
    declaredFunctions: number
    declaredActions: number
    readTools: number
    writeTools: number
  }
  warnings: {
    load: string[]
    derivation: string[]
  }
  objectTypes: Array<{
    name: string
    primaryKey: string
    primaryKeySource: string
    requiredFields: string[]
    directory: string
    writtenBy: string[]
    fieldCount: number
    /**
     * Declared states and the moves between them, when the type has a lifecycle.
     *
     * Surfaced because it is the part of a domain a reader can check at a glance: which
     * states exist, who may move something between them, and which moves need a second
     * pair of eyes.
     */
    lifecycle?: {
      field: string
      initial: string
      defaultState?: string
      states: string[]
      transitions: Array<{
        name: string
        from: string[]
        to: string
        by: string[]
        requiresReview: boolean
      }>
    }
    instances: number
  }>
  linkTypes: Array<{
    name: string
    from: string
    to: string
    /** The field edge derivation actually reads. */
    field: string
    via?: string
    description?: string
    edges: number
  }>
  tools: {
    read: ToolView[]
    write: ToolView[]
  }
  /** Identity only — enough to browse by type without moving the contents. */
  entities: Array<{ type: string; id: string }>
}

/** Strip a derived tool down to the parts a browser needs. */
function toView(tool: DerivedToolSpec): ToolView {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    outputSchema: tool.outputSchema,
  }
}

/**
 * Build the snapshot for one domain.
 *
 * @param graph - Loaded domain graph.
 * @param roles - Role map for the write half. Empty means no write tool, matching the
 *   plugin: an unconfigured deployment is a read-only one rather than a refusing one.
 * @param options - Result caps forwarded to the derivation.
 */
export function domainSnapshot(
  graph: OntologyGraph,
  roles: readonly RoleRule[],
  options: DeriveOptions = {},
): DomainSnapshot {
  const reads = deriveTools(graph, options)
  const writes =
    roles.length === 0
      ? { tools: [], warnings: [] as string[] }
      : deriveWriteTools(graph, { roles, audit: () => {} })

  return {
    root: graph.root,
    roles,
    summary: {
      objects: graph.objects.length,
      links: graph.links.length,
      objectTypes: graph.schema.objectTypes.size,
      linkTypes: graph.schema.linkTypes.size,
      declaredFunctions: Object.keys(graph.schema.functions).length,
      declaredActions: Object.keys(graph.schema.actionTypes).length,
      readTools: reads.tools.length,
      writeTools: writes.tools.length,
    },
    warnings: {
      load: graph.warnings,
      derivation: [...reads.warnings, ...writes.warnings],
    },
    objectTypes: [...graph.schema.objectTypes.values()].map((type) => ({
      name: type.name,
      primaryKey: type.primaryKey,
      primaryKeySource: type.primaryKeySource,
      requiredFields: type.requiredFields,
      directory: type.directory,
      writtenBy: type.writtenBy,
      fieldCount: Object.keys(type.fields).length,
      instances: (graph.byType.get(type.name) ?? []).length,
      ...(type.lifecycle === undefined
        ? {}
        : {
            lifecycle: {
              field: type.lifecycle.field,
              initial: type.lifecycle.initial,
              ...(type.lifecycle.defaultState === undefined
                ? {}
                : { defaultState: type.lifecycle.defaultState }),
              states: type.lifecycle.states,
              transitions: type.lifecycle.transitions.map((transition) => ({
                name: transition.name,
                from: transition.from,
                to: transition.to,
                by: transition.by,
                requiresReview: transition.review !== undefined,
              })),
            },
          }),
    })),
    linkTypes: [...graph.schema.linkTypes.values()].map((link) => ({
      name: link.name,
      from: link.from,
      to: link.to,
      field: link.field,
      ...(link.via === undefined ? {} : { via: link.via }),
      ...(link.description === undefined ? {} : { description: link.description }),
      edges: graph.links.filter((candidate) => candidate.type === link.name).length,
    })),
    tools: {
      read: reads.tools.map(toView),
      write: writes.tools.map(toView),
    },
    entities: graph.objects.map((object) => ({ type: object.type, id: object.id })),
  }
}
