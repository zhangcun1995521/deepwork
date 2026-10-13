/**
 * Derive the domain's write surface — and the governance that gates it.
 *
 * One tool, not one per action. `ontology_write` creates or updates a single entity,
 * and relations need no separate verb because a relation *is* a field: passing a
 * relation's field name inside `data` asserts an edge, and the next reload derives it
 * like any other. That is the same collapse the read side makes, for the same reason —
 * a surface that grows per type is a surface the model has to be taught.
 *
 * What makes it safe is that none of the policy lives here. Who may write a type comes
 * from that type's `written_by`; where instances may live comes from its
 * `file_location`; which fields must be present comes from its `required_fields`. The
 * tool enforces those declarations and invents none of its own, so tightening a domain
 * is a schema edit rather than a code change.
 *
 * Every attempt is audited, refusals included. The refusals are the interesting half:
 * "who tried and was turned away" is the question asked after something goes wrong, and
 * a log that only records successes cannot answer it.
 *
 * @module @zhangcun123/ontology/tools/write
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dump as dumpYaml } from 'js-yaml'

import { refreshGraph, type OntologyGraph } from '../engine/graph.ts'
import type { AuditEntry } from '../govern/audit.ts'
import { authoriseTransition } from '../govern/lifecycle.ts'
import {
  authoriseWrite,
  isSafeId,
  roleOf,
  type DenialReason,
  type Permission,
  type RoleRule,
} from '../govern/permission.ts'
import {
  RESULT_SCHEMA,
  renderResult,
  type DerivationResult,
  type DerivedToolSpec,
  type QueryResult,
  type ToolArgs,
} from './derive.ts'

/** Everything the write surface needs beyond the graph itself. */
export interface WriteOptions {
  /**
   * Prefix-to-role map for callers. Empty by default, which denies every write: an
   * unconfigured deployment should not be a permissive one.
   */
  roles?: readonly RoleRule[]
  /** Called for every attempt, allowed or denied. */
  audit: (entry: AuditEntry) => void
  /** Clock, injectable so a test can pin a timestamp. */
  now?: () => Date
  /** Cap on a rendered field value, matching the read side. */
  maxRenderedValueLength?: number
}

/** Declared type names, as a closed enum for the argument schema. */
function typeNames(graph: OntologyGraph): string[] {
  return [...graph.schema.objectTypes.keys()]
}

/** Coerce a required string argument, or throw naming what it was. */
function requireString(args: ToolArgs, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`argument "${name}" is required and must be a non-empty string`)
  }
  return value
}

/** True for a plain mapping. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build the domain's write tool.
 *
 * @param graph - Loaded domain graph. Written to, and refreshed in place.
 * @param options - Role map, audit sink and clock.
 */
export function deriveWriteTools(graph: OntologyGraph, options: WriteOptions): DerivationResult {
  const roles = options.roles ?? []
  const now = options.now ?? ((): Date => new Date())
  const warnings: string[] = []
  const names = typeNames(graph)

  if (names.length === 0) {
    return { tools: [], warnings: ['no object types are declared, so no write tool can be derived'] }
  }

  const writable = names.filter((name) => (graph.schema.objectTypes.get(name)?.writtenBy.length ?? 0) > 0)
  if (writable.length === 0) {
    warnings.push(
      'no object type declares written_by, so every write will be refused; ' +
        'declare written_by on a type to make it writable',
    )
  }

  const tool: DerivedToolSpec = {
    name: 'ontology_write',
    description:
      'Create or update one entity in the ontology. Which types may be written is declared by the ' +
      'domain, not by this tool: a caller whose role is not granted on the target type is refused, ' +
      'and the refusal names the role it wanted. Relations are fields — putting a relation\'s field ' +
      'name in `data` asserts an edge — and fields the type declares as required must be present. ' +
      `Types: ${names.join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Declared object type name.',
          enum: names,
        },
        id: {
          type: 'string',
          description:
            'Identity of the entity. Created when nothing has this id, merged into the existing ' +
            'entity when something does. May not contain a path separator.',
        },
        data: {
          type: 'object',
          description:
            'Field values to write. Relation fields name the related entity ids. The identity field ' +
            'is set from `id` and cannot be overridden here.',
        },
      },
      required: ['type', 'id', 'data'],
    },
    outputSchema: RESULT_SCHEMA,
    render: (args, value) =>
      renderResult(value, options.maxRenderedValueLength ?? 120, (type) =>
        graph.schema.objectTypes.get(type)?.primaryKey,
      ),
    execute: (args, call) => {
      const typeName = requireString(args, 'type')
      const id = requireString(args, 'id')
      const data = args.data

      if (!isMapping(data)) {
        throw new Error('argument "data" is required and must be an object of field values')
      }

      const type = graph.schema.objectTypes.get(typeName)
      if (type === undefined) {
        throw new Error(`unknown object type "${typeName}"; declared types are: ${names.join(', ')}`)
      }

      const file = join(graph.root, type.directory, `${id}.yaml`)
      // Resolved up front so a refusal records the role the caller actually had,
      // rather than leaving the log to imply it had none.
      const attemptedRole = roleOf(call?.agentId, roles)

      /** Record an attempt and refuse the call. */
      const deny = (reason: DenialReason, detail: string): never => {
        options.audit({
          at: now().toISOString(),
          action: 'ontology_write',
          ...(call?.agentId === undefined ? {} : { agentId: call.agentId }),
          ...(attemptedRole === undefined ? {} : { role: attemptedRole }),
          type: typeName,
          id,
          file,
          outcome: 'denied',
          reason,
          detail,
        })
        throw new Error(`write denied (${reason}): ${detail}`)
      }

      // Id safety is separate from authority on purpose: the id comes from the model
      // and becomes part of a path, so it is checked before anything is resolved.
      const decision: Permission = isSafeId(id)
        ? authoriseWrite(type, graph.root, file, call?.agentId, roles)
        : {
            allowed: false,
            reason: 'unsafe-id',
            detail: `id "${id}" cannot be used as a filename`,
          }

      if (!decision.allowed) deny(decision.reason, decision.detail)
      const callerRole = decision.allowed ? decision.role : undefined

      // The identity field is taken from `id`, never from `data`, so a caller cannot
      // write an entity whose file name and identity disagree.
      const existing = graph.byId.get(`${type.name}:${id}`)

      // A change of state is not an ordinary field edit: the schema says who may make
      // that claim and from where. Checked on this same write path rather than in an
      // action of its own, so the promotion is covered by the ACL above and by the audit
      // below — the reference implementation wrote the file directly from its own
      // promotion code and quietly bypassed both.
      const lifecycle = type.lifecycle
      if (lifecycle !== undefined && Object.hasOwn(data, lifecycle.field)) {
        const onDisk = existing?.data[lifecycle.field]
        const transition = authoriseTransition(
          lifecycle,
          typeof onDisk === 'string' ? onDisk : undefined,
          data[lifecycle.field],
          callerRole,
        )
        if (!transition.allowed) deny(transition.reason, transition.detail)
      }

      const merged: Record<string, unknown> = {
        ...(existing === undefined ? {} : existing.data),
        ...data,
        [type.primaryKey]: id,
      }

      const missing = type.requiredFields.filter((field) => {
        const value = merged[field]
        return value === undefined || value === null || String(value).length === 0
      })
      if (missing.length > 0) {
        deny(
          'missing-required-field',
          `"${type.name}" requires ${type.requiredFields.join(', ')}, and ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} absent`,
        )
      }

      writeFileSync(file, dumpYaml(merged, { lineWidth: 120, noRefs: true }))
      refreshGraph(graph)

      options.audit({
        at: now().toISOString(),
        action: 'ontology_write',
        ...(call?.agentId === undefined ? {} : { agentId: call.agentId }),
        ...(attemptedRole === undefined ? {} : { role: attemptedRole }),
        type: typeName,
        id,
        file,
        outcome: 'allowed',
        // Names, never values: an audit trail that copies domain content into a second
        // file widens the surface that content can leak from.
        fields: Object.keys(data),
      })

      const written = graph.byId.get(`${type.name}:${id}`)
      const result: QueryResult = {
        mode: 'write',
        objects: written === undefined ? [] : [{ type: written.type, id: written.id, data: written.data }],
        // Edges touching the entity, so a caller sees the relations it just asserted
        // as relations rather than only as fields.
        links: graph.links.filter((link) => link.from === id || link.to === id),
        total: written === undefined ? 0 : 1,
        returned: written === undefined ? 0 : 1,
        truncated: false,
      }
      return result
    },
  }

  return { tools: [tool], warnings }
}
