/**
 * Derive the agent's tool surface from a domain schema.
 *
 * This module is the point of the project. A domain author declares what questions
 * exist; this turns those declarations into tool definitions the model can call. No
 * TypeScript is written per domain, and no tool is registered by hand.
 *
 * It is deliberately framework-free: the output is plain data plus closures over the
 * graph. Nothing here imports DSH, so the whole derivation is testable with
 * `node --test` — no runtime to boot, no key, no agent.
 *
 * The surface is four tools, and only one of them grows with the domain:
 *
 *   ontology_get    fetch one entity by type and id
 *   ontology_find   find entities by field equality and/or substring
 *   ontology_links  follow a declared relation from one entity
 *   ontology_query  run the domain's own declared functions, dispatched by `mode`
 *
 * The first three are parameterized *by* type rather than duplicated *per* type, so a
 * domain with forty entities still exposes three tools. Only `ontology_query`'s `mode`
 * enum grows, and an enum value costs far less than a tool — which is the whole point:
 * the model sees a small, tight surface instead of forty near-identical tools whose
 * descriptions crowd out the task.
 *
 * @module @zhangcun123/ontology/tools/derive
 */

import type { FieldDecl, ObjectTypeDecl } from '../engine/schema.ts'
import type { OntologyGraph, OntologyObject, OntologyLink } from '../engine/graph.ts'

/** One tool argument, as JSON Schema. */
export interface JsonSchemaNode {
  type?: string
  description?: string
  enum?: readonly string[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: readonly string[]
}

/** Arguments as the model supplies them. Validated by the runtime before `execute`. */
export type ToolArgs = Record<string, unknown>

/** One entity as returned to the model, without graph-internal bookkeeping. */
export interface ResultObject {
  type: string
  id: string
  data: Record<string, unknown>
}

/** One relation instance as returned to the model. */
export interface ResultLink {
  type: string
  from: string
  fromType: string
  to: string
  toType: string
}

/**
 * What every tool returns.
 *
 * `truncated` is not decoration. A capped result that does not say it was capped
 * invites the model to conclude "these are all of them", which is how a confident
 * wrong answer gets built out of a correct query.
 */
export interface QueryResult {
  /** Which entry produced this: a structural tool or a declared function name. */
  mode: string
  objects: ResultObject[]
  links: ResultLink[]
  /** How many matched before the cap. */
  total: number
  /** How many are in `objects`. */
  returned: number
  truncated: boolean
}

/** Who is asking, as far as the runtime can tell. */
export interface CallContext {
  /**
   * Identity of the calling agent, when the runtime supplies one. Read tools ignore
   * it; a write tool needs it to decide whose authority it is acting under.
   */
  agentId?: string
}

/** A tool the adapter can register on the runtime's tool registry. */
export interface DerivedToolSpec {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: JsonSchemaNode
  /** JSON Schema for the canonical return value. */
  outputSchema: JsonSchemaNode
  /** Model-facing prose for a returned value. */
  render: (args: ToolArgs, value: QueryResult) => string
  /**
   * Run the tool. Throws for a bad request (unknown type, missing argument) so the
   * runtime reports it as an error; a legitimate "nothing matched" is a successful
   * result with an empty list.
   *
   * `call` is optional so a read tool can ignore it entirely.
   */
  execute: (args: ToolArgs, call?: CallContext) => QueryResult | Promise<QueryResult>
}

/** Everything the derivation produced, plus what it refused to produce and why. */
export interface DerivationResult {
  tools: DerivedToolSpec[]
  warnings: string[]
}

/** Tuning for the derivation. */
export interface DeriveOptions {
  /** Maximum objects in one result. Over the cap, the result says so. */
  maxResults?: number
  /** Longest single field value in rendered prose, before elision. */
  maxRenderedValueLength?: number
}

/** Default cap on one result set. */
const DEFAULT_MAX_RESULTS = 50

/** Default cap on one field value in rendered prose. */
const DEFAULT_MAX_RENDERED_VALUE = 120

/** The primitives a declared function may bind to. */
const PRIMITIVES = ['filter_by', 'traverse', 'search'] as const
type Primitive = (typeof PRIMITIVES)[number]

/** True for a plain mapping. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Coerce a required string argument, or throw with the reason. */
function requireString(args: ToolArgs, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`argument "${name}" is required and must be a non-empty string`)
  }
  return value
}

/** Coerce an optional string argument. */
function optionalString(args: ToolArgs, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`argument "${name}" must be a string`)
  return value
}

/** Look up an object type, or throw naming what was asked for. */
function requireType(graph: OntologyGraph, type: string): ObjectTypeDecl {
  const declared = graph.schema.objectTypes.get(type)
  if (declared === undefined) {
    const known = [...graph.schema.objectTypes.keys()].join(', ')
    throw new Error(`unknown object type "${type}"; declared types are: ${known}`)
  }
  return declared
}

/** Look up a relation, or throw naming what was asked for. */
function requireRelation(graph: OntologyGraph, relation: string) {
  const declared = graph.schema.linkTypes.get(relation)
  if (declared === undefined) {
    const known = [...graph.schema.linkTypes.keys()].join(', ')
    throw new Error(`unknown relation "${relation}"; declared relations are: ${known}`)
  }
  return declared
}

/** Strip graph-internal bookkeeping from an instance. */
function toResult(object: OntologyObject): ResultObject {
  return { type: object.type, id: object.id, data: object.data }
}

/** Apply the result cap and report both the capped and uncapped counts. */
function pack(
  mode: string,
  objects: OntologyObject[],
  links: OntologyLink[],
  maxResults: number,
): QueryResult {
  const capped = objects.slice(0, maxResults)
  return {
    mode,
    objects: capped.map(toResult),
    links,
    total: objects.length,
    returned: capped.length,
    truncated: objects.length > capped.length,
  }
}

/** Render one field value for prose, eliding anything long. */
function renderValue(value: unknown, limit: number): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') return '{…}'
  const text = String(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Model-facing prose for a result: one line per entity, with scalar fields inline.
 *
 * Relations are listed separately because an entity's related ids are often the
 * answer, and burying them in the field list makes them easy to miss.
 */
export function renderResult(
  value: QueryResult,
  limit: number,
  primaryKeyOf: (type: string) => string | undefined,
): string {
  const lines: string[] = []
  for (const object of value.objects) {
    const primaryKey = primaryKeyOf(object.type)
    const fields = Object.entries(object.data)
      .filter(([name, fieldValue]) => name !== primaryKey && typeof fieldValue !== 'object')
      .map(([name, fieldValue]) => `${name}=${renderValue(fieldValue, limit)}`)
    lines.push(`${object.type} ${object.id}${fields.length > 0 ? `  ${fields.join('  ')}` : ''}`)
  }
  if (value.links.length > 0) {
    lines.push(
      ...value.links
        .slice(0, value.objects.length === 0 ? 20 : 10)
        .map((link) => `  ${link.fromType}:${link.from} -[${link.type}]-> ${link.toType}:${link.to}`),
    )
  }
  if (lines.length === 0) lines.push('(nothing matched)')
  if (value.truncated) {
    lines.push(`(showing ${value.returned} of ${value.total})`)
  }
  return lines.join('\n')
}

/** JSON Schema for one entity. */
const OBJECT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'Declared object type name.' },
    id: { type: 'string', description: 'Identity within that type.' },
    data: { type: 'object', description: 'The instance fields as stored.' },
  },
  required: ['type', 'id', 'data'],
}

/** JSON Schema for one relation instance. */
const LINK_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'Declared relation name.' },
    from: { type: 'string' },
    fromType: { type: 'string' },
    to: { type: 'string' },
    toType: { type: 'string' },
  },
  required: ['type', 'from', 'fromType', 'to', 'toType'],
}

/** JSON Schema shared by every tool's canonical return value. */
export const RESULT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    mode: { type: 'string', description: 'The entry that produced this result.' },
    objects: { type: 'array', items: OBJECT_SCHEMA },
    links: { type: 'array', items: LINK_SCHEMA },
    total: { type: 'number', description: 'Matches before the cap.' },
    returned: { type: 'number', description: 'Entries in `objects`.' },
    truncated: {
      type: 'boolean',
      description: 'True when `total` exceeds `returned`; the answer is partial.',
    },
  },
  required: ['mode', 'objects', 'links', 'total', 'returned', 'truncated'],
}

/** A string-typed argument node. */
function stringNode(description: string, values?: readonly string[]): JsonSchemaNode {
  return values === undefined
    ? { type: 'string', description }
    : { type: 'string', description, enum: values }
}

/**
 * Describe a parameter taken from a declared field.
 *
 * The field's own description wins when present; otherwise the type is stated so the
 * model at least knows what kind of value to pass.
 */
function describeFieldParam(type: ObjectTypeDecl, field: string): string {
  const declared: FieldDecl | undefined = type.fields[field]
  if (declared?.description !== undefined) return String(declared.description)
  const to = declared?.to
  if (typeof to === 'string' && to.length > 0) return `${field} — a ${to} id`
  return `${field} — a value from ${type.name}.${field}`
}

/** Narrow a search predicate to the scalar fields, which are the searchable ones. */
function scalarEntries(data: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(data)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .map(([name, value]) => [name, String(value)])
}

/** True when the instance has the field and its value equals the wanted string. */
function matchesField(object: OntologyObject, field: string, wanted: string): boolean {
  const value = object.data[field]
  if (value === undefined) return false
  if (Array.isArray(value)) return value.map(String).includes(wanted)
  return String(value) === wanted
}

/**
 * True when the field equals any of several wanted values.
 *
 * A declaration writes this as a list — `where: { status: [AtRisk, Delayed] }` — which
 * reads as "either of these", the way a person would state it. The alternative would be
 * two near-identical declarations for one question.
 */
function matchesAnyField(
  object: OntologyObject,
  field: string,
  wanted: readonly string[],
): boolean {
  return wanted.some((value) => matchesField(object, field, value))
}

/**
 * Apply a declaration's fixed narrowing to one instance: every clause must hold.
 *
 * Shared by the two kinds of declaration that narrow. A filtered declaration narrows
 * what it starts from; a traversal narrows what it arrives at, which is what makes
 * "the open issues of this project" one declaration rather than two.
 */
function matchesWhere(object: OntologyObject, where: Record<string, unknown>): boolean {
  for (const [field, wanted] of Object.entries(where)) {
    const holds = Array.isArray(wanted)
      ? matchesAnyField(object, field, wanted.map(String))
      : matchesField(object, field, String(wanted))
    if (!holds) return false
  }
  return true
}

/** True when any scalar field contains the query, case-insensitively. */
function matchesQuery(object: OntologyObject, query: string): boolean {
  const needle = query.toLowerCase()
  return scalarEntries(object.data).some(([, value]) => value.toLowerCase().includes(needle))
}

/** JSON Schema for the three structural tools' `type`/`relation` arguments. */
function enumOf(names: Iterable<string>): readonly string[] {
  return [...names]
}

/**
 * Build the `ontology_query` dispatcher for the domain's declared functions.
 *
 * Every mode's parameters are gathered into one schema. A parameter is named by the
 * declaration's `by`, and its description says which mode needs it, because the union
 * is the one place the model can go wrong.
 */
function deriveDispatcher(
  graph: OntologyGraph,
  maxResults: number,
  renderLimit: number,
  warnings: string[],
): DerivedToolSpec | undefined {
  interface Mode {
    name: string
    description: string
    primitive: Primitive
    /** Parameter name, when the mode takes one. */
    param?: string
    paramDescription?: string
    on?: string
    relation?: string
    /** For traverse: whether to walk the relation against its declared direction. */
    incoming: boolean
    where: Record<string, unknown>
  }

  const modes: Mode[] = []

  for (const [name, declaration] of Object.entries(graph.schema.functions)) {
    if (!isMapping(declaration)) {
      warnings.push(`function "${name}" is not a mapping; the mode is unavailable`)
      continue
    }
    const primitive = declaration.use
    if (typeof primitive !== 'string' || !PRIMITIVES.includes(primitive as Primitive)) {
      warnings.push(
        `function "${name}" declares use "${String(primitive)}"; expected one of ${PRIMITIVES.join(', ')} — the mode is unavailable`,
      )
      continue
    }

    const description = typeof declaration.description === 'string' ? declaration.description : ''
    const by = typeof declaration.by === 'string' && declaration.by.length > 0 ? declaration.by : undefined
    const relation = typeof declaration.relation === 'string' ? declaration.relation : undefined
    const on = typeof declaration.on === 'string' ? declaration.on : undefined
    const where = isMapping(declaration.where) ? declaration.where : {}

    // A relation points one way, but the useful question often runs the other way:
    // `reported_on` goes Issue -> Project, while "what is blocking this project"
    // starts at the project. Reversing at query time is the only way to answer that,
    // because an inverse relation cannot be derived from the data.
    const rawDirection = declaration.direction
    if (rawDirection !== undefined && rawDirection !== 'outgoing' && rawDirection !== 'incoming') {
      warnings.push(
        `function "${name}" declares direction "${String(rawDirection)}"; expected "outgoing" or "incoming" — the mode is unavailable`,
      )
      continue
    }
    const incoming = rawDirection === 'incoming'

    if (primitive !== 'traverse') {
      if (on === undefined) {
        warnings.push(`function "${name}" uses ${primitive} but declares no "on"; the mode is unavailable`)
        continue
      }
      if (!graph.schema.objectTypes.has(on)) {
        warnings.push(
          `function "${name}" targets undeclared type "${on}"; the mode is unavailable`,
        )
        continue
      }
    }

    if (primitive === 'traverse') {
      if (relation === undefined || !graph.schema.linkTypes.has(relation)) {
        warnings.push(
          `function "${name}" uses traverse but declares no known "relation"; the mode is unavailable`,
        )
        continue
      }
    }

    if (by === undefined && primitive !== 'filter_by') {
      warnings.push(`function "${name}" uses ${primitive} but declares no "by"; the mode is unavailable`)
      continue
    }

    const type = on === undefined ? undefined : graph.schema.objectTypes.get(on)
    const relationDecl = relation === undefined ? undefined : graph.schema.linkTypes.get(relation)
    const paramDescription =
      by === undefined
        ? undefined
        : primitive === 'search'
          ? `Substring to match, case-insensitive, across ${on ?? 'the type'}'s text fields`
          : primitive === 'traverse'
            ? incoming
              ? `Id of the ${relationDecl?.to ?? 'entity'} to look back from`
              : `Id of the starting ${relationDecl?.from ?? 'entity'}`
            : type !== undefined
              ? describeFieldParam(type, by)
              : by

    modes.push({
      name,
      description:
        description.length > 0
          ? description
          : `${primitive} over ${on ?? relation ?? ''}`.trim(),
      primitive: primitive as Primitive,
      ...(by === undefined ? {} : { param: by }),
      ...(paramDescription === undefined ? {} : { paramDescription }),
      ...(on === undefined ? {} : { on }),
      ...(relation === undefined ? {} : { relation }),
      incoming,
      where,
    })
  }

  if (modes.length === 0) return undefined

  // One parameter node per distinct parameter name, described by every mode that uses
  // it. Modes that take no argument need none of this.
  const properties: Record<string, JsonSchemaNode> = {
    mode: stringNode(
      `Which query to run. ${modes.map((mode) => `${mode.name}${mode.param === undefined ? '' : ` (takes "${mode.param}")`}`).join('; ')}.`,
      modes.map((mode) => mode.name),
    ),
  }
  for (const mode of modes) {
    if (mode.param === undefined) continue
    const existing = properties[mode.param]
    const note = `for mode "${mode.name}"`
    properties[mode.param] =
      existing === undefined
        ? stringNode(`${mode.paramDescription ?? mode.param} — ${note}`)
        : { ...existing, description: `${existing.description} ${note}` }
  }

  const byName = new Map(modes.map((mode) => [mode.name, mode]))

  return {
    name: 'ontology_query',
    description:
      `Run a query declared by this ontology. Available modes: ` +
      modes.map((mode) => `${mode.name} (${mode.description})`).join('; '),
    parameters: { type: 'object', properties, required: ['mode'] },
    outputSchema: RESULT_SCHEMA,
    render: (_args, value) =>
      renderResult(value, renderLimit, (type) => graph.schema.objectTypes.get(type)?.primaryKey),
    execute: (args) => {
      const modeName = requireString(args, 'mode')
      const mode = byName.get(modeName)
      if (mode === undefined) {
        throw new Error(
          `unknown mode "${modeName}"; available modes are: ${modes.map((m) => m.name).join(', ')}`,
        )
      }

      if (mode.primitive === 'traverse') {
        const startId = mode.param === undefined ? undefined : optionalString(args, mode.param)
        if (startId === undefined) {
          throw new Error(`mode "${modeName}" requires argument "${mode.param ?? 'by'}"`)
        }
        const relation = requireRelation(graph, mode.relation ?? '')
        // Walking against the declared direction swaps which end the given id is,
        // and therefore which end comes back.
        const links = graph.links.filter(
          (link) =>
            link.type === relation.name &&
            (mode.incoming ? link.to === startId : link.from === startId),
        )
        const reached: OntologyObject[] = []
        for (const link of links) {
          const key = mode.incoming ? `${link.fromType}:${link.from}` : `${link.toType}:${link.to}`
          const object = graph.byId.get(key)
          if (object !== undefined) reached.push(object)
        }
        // `where` narrows what the traversal arrives at, so a declaration can ask for
        // the open issues of a project rather than every issue ever raised on it.
        const filtered = reached.filter((object) => matchesWhere(object, mode.where))
        // Keep the reported edges consistent with the reported entities; an edge to
        // something filtered out would contradict the result it sits beside.
        const kept = new Set(filtered.map((object) => object.key))
        const keptLinks = links.filter((link) =>
          mode.incoming
            ? kept.has(`${link.fromType}:${link.from}`)
            : kept.has(`${link.toType}:${link.to}`),
        )
        return pack(modeName, filtered, keptLinks, maxResults)
      }

      const type = requireType(graph, mode.on ?? '')
      let objects = graph.byType.get(type.name) ?? []

      objects = objects.filter((object) => matchesWhere(object, mode.where))
      if (mode.param !== undefined) {
        const value = optionalString(args, mode.param)
        if (value === undefined) {
          throw new Error(`mode "${modeName}" requires argument "${mode.param}"`)
        }
        objects =
          mode.primitive === 'search'
            ? objects.filter((object) => matchesQuery(object, value))
            : objects.filter((object) => matchesField(object, mode.param as string, value))
      }

      return pack(modeName, objects, [], maxResults)
    },
  }
}

/**
 * Turn a loaded graph into the tool surface for its domain.
 *
 * @param graph - Loaded domain graph.
 * @param options - Caps for result size and rendered value length.
 */
export function deriveTools(graph: OntologyGraph, options: DeriveOptions = {}): DerivationResult {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  const renderLimit = options.maxRenderedValueLength ?? DEFAULT_MAX_RENDERED_VALUE
  const warnings: string[] = []

  const types = graph.schema.objectTypes
  const typeNames = enumOf(types.keys())
  const relationNames = enumOf(graph.schema.linkTypes.keys())

  // Field names are only offered as an enum when a single type is in play, so the
  // filter argument is an enum per type rather than an untyped string.
  const primaryKeyOf = (type: string): string | undefined => types.get(type)?.primaryKey

  const tools: DerivedToolSpec[] = [
    {
      name: 'ontology_get',
      description:
        'Fetch one entity from the ontology by its type and id. Returns an empty list when nothing has that id — that is not an error.',
      parameters: {
        type: 'object',
        properties: {
          type: stringNode('Declared object type name.', typeNames),
          id: stringNode('Identity within that type, e.g. the value of its primary key field.'),
        },
        required: ['type', 'id'],
      },
      outputSchema: RESULT_SCHEMA,
      render: (_args, value) => renderResult(value, renderLimit, primaryKeyOf),
      execute: (args) => {
        const type = requireType(graph, requireString(args, 'type'))
        const id = requireString(args, 'id')
        const found = graph.byId.get(`${type.name}:${id}`)
        return pack('get', found === undefined ? [] : [found], [], maxResults)
      },
    },

    {
      name: 'ontology_find',
      description:
        'Find entities of one type. Narrow with `field` + `value` for an exact match on a declared field, and/or `query` for a substring match over the type\'s text fields. Given neither, returns every entity of the type.',
      parameters: {
        type: 'object',
        properties: {
          type: stringNode('Declared object type name.', typeNames),
          field: stringNode(
            'Name of a declared field to match exactly. Pair it with `value`. If the name is not a declared field of this type, no entity matches.',
          ),
          value: stringNode('The exact value `field` must equal.'),
          query: stringNode('Substring to look for, case-insensitive, across text fields.'),
        },
        required: ['type'],
      },
      outputSchema: RESULT_SCHEMA,
      render: (_args, value) => renderResult(value, renderLimit, primaryKeyOf),
      execute: (args) => {
        const type = requireType(graph, requireString(args, 'type'))
        const field = optionalString(args, 'field')
        const value = optionalString(args, 'value')
        const query = optionalString(args, 'query')

        if (field !== undefined && value === undefined) {
          throw new Error('argument "value" is required when "field" is given')
        }

        let objects = graph.byType.get(type.name) ?? []
        if (field !== undefined && value !== undefined) {
          objects = objects.filter((object) => matchesField(object, field, value))
        }
        if (query !== undefined) {
          objects = objects.filter((object) => matchesQuery(object, query))
        }
        return pack('find', objects, [], maxResults)
      },
    },

    {
      name: 'ontology_links',
      description:
        'Follow a declared relation from one entity and return what it points at, along with the relation instances themselves.',
      parameters: {
        type: 'object',
        properties: {
          relation: stringNode('Declared relation name.', relationNames),
          from: stringNode('Id of the entity the relation starts at.'),
        },
        required: ['relation', 'from'],
      },
      outputSchema: RESULT_SCHEMA,
      render: (_args, value) => renderResult(value, renderLimit, primaryKeyOf),
      execute: (args) => {
        const relation = requireRelation(graph, requireString(args, 'relation'))
        const from = requireString(args, 'from')
        const links = graph.links.filter(
          (link) => link.type === relation.name && link.from === from,
        )
        const targets: OntologyObject[] = []
        for (const link of links) {
          const target = graph.byId.get(`${link.toType}:${link.to}`)
          if (target !== undefined) targets.push(target)
        }
        return pack('links', targets, links, maxResults)
      },
    },
  ]

  // A domain that declares no functions gets the structural three and no dispatcher;
  // an empty mode enum would be a tool that cannot be called correctly.
  const dispatcher = deriveDispatcher(graph, maxResults, renderLimit, warnings)
  if (dispatcher !== undefined) tools.push(dispatcher)

  return { tools, warnings }
}
