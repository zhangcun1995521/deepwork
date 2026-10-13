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
        increment: {
          type: 'object',
          description:
            'Whole-number deltas added to declared counters, e.g. { "hits": 1 }. A field is a ' +
            'counter when the domain declares increment_by on it, and that declaration — not ' +
            'written_by — decides who may increment. Counters can also be set outright through ' +
            '`data` by a role that may write the type.',
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
      // Whether this call authors anything. A call that only moves a counter does not:
      // its grant is `increment_by`, checked below per field. Passing the distinction in,
      // rather than letting one check answer both questions, is what keeps "who may
      // record usage" and "who may author the claim" from collapsing into one gate.
      // Counter increments. Declared per field rather than granted wholesale, because who
      // may record that knowledge was used is not who may author it: an executor accrues
      // the count, a curator owns the claim. The reference implementation bumped its
      // counter from code that wrote the file directly; here it is a write like any other,
      // covered by the refusals above and the audit below.
      const increments: [string, number][] = []
      const rawIncrement = (args as Record<string, unknown>).increment
      if (rawIncrement !== undefined && !isMapping(rawIncrement)) {
        deny('invalid-increment', '"increment" must be an object of field names to whole-number deltas')
      }
      // Bound to a mapping of its own so the loop below reads a value the compiler can see
      // the shape of, rather than one it has to trust.
      const incrementsArg: Record<string, unknown> = isMapping(rawIncrement) ? rawIncrement : {}
      if (rawIncrement !== undefined) {
        for (const [field, delta] of Object.entries(incrementsArg)) {
          const step =
            typeof delta === 'number' && Number.isInteger(delta) && delta !== 0 ? delta : 0
          if (step === 0) {
            deny('invalid-increment', `the increment for "${field}" must be a non-zero whole number`)
          }
          const by = type.fields[field]?.incrementBy ?? []
          if (type.fields[field] === undefined || by.length === 0) {
            deny(
              'not-a-counter',
              `"${field}" is not a declared counter of ${type.name} (declare increment_by on the field)`,
            )
          }
          if (attemptedRole === undefined || !by.includes(attemptedRole)) {
            deny(
              'increment-not-permitted',
              `incrementing "${field}" requires one of [${by.join(', ')}]; caller resolved to ` +
                `${attemptedRole === undefined ? 'no role' : `"${attemptedRole}"`}`,
            )
          }
          increments.push([field, step])
        }
      }

      // A call that carries nothing but counter increments is the one case where
      // `written_by` is the wrong question: recording that knowledge was used is not
      // authoring it. Every other call — including one that writes nothing but names no
      // counters — is authorised as content, so an empty `data` cannot be used to slip
      // past the type's grant.
      const counterOnly = Object.keys(data).length === 0 && increments.length > 0

      const decision: Permission = isSafeId(id)
        ? authoriseWrite(type, graph.root, file, call?.agentId, roles, {
            requireWrittenBy: !counterOnly,
          })
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

      for (const [field, delta] of increments) {
        const current = merged[field]
        merged[field] = (typeof current === 'number' ? current : 0) + delta
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
        // file widens the surface that content can leak from. Counter fields are named
        // here too — "which counter moved, and by whom" is half of what the trail is for,
        // and an increment otherwise leaves an entry that says nothing moved.
        fields: [...Object.keys(data), ...increments.map(([field]) => field)],
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
