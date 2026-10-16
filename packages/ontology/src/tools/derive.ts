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
 * Inside the dispatcher a declared function binds to one of four primitives: a filter, a
 * single-hop traversal, a substring search, or a *walk*. The walk is the one that answers a
 * question the other three cannot — "this service is failing, what else does that reach" — and
 * it is the only one that needs something the schema previously had no way to say. A walk
 * follows failures, not arrows, and which way a failure travels along a relation is a fact about
 * the relation: it is *declared* (`propagation`, see `LinkTypeDecl`) and never inferred from the
 * relation's name or its tag. A relation that has not declared it is not walked at all, because
 * a walk that guessed would report an invented direction as a stated one.
 *
 * @module @zhangcun123/ontology/tools/derive
 */

import {
  SEMANTICS_TAGS,
  type FieldDecl,
  type LinkTypeDecl,
  type ObjectTypeDecl,
  type Propagation,
  type SemanticsTag,
} from '../engine/schema.ts'
import type { OntologyGraph, OntologyObject, OntologyLink } from '../engine/graph.ts'

/** One tool argument, as JSON Schema. */
export interface JsonSchemaNode {
  type?: string
  description?: string
  enum?: readonly string[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: readonly string[]
  /**
   * Exactly one branch must validate. Used where one argument genuinely takes two shapes — the
   * host's own schema contract supports it, and advertising one shape while a mode accepts the
   * other would make the schema lie about what the tool does.
   */
  oneOf?: JsonSchemaNode[]
}

/** Arguments as the model supplies them. Validated by the runtime before `execute`. */
export type ToolArgs = Record<string, unknown>

/** One entity as returned to the model, without graph-internal bookkeeping. */
export interface ResultObject {
  type: string
  id: string
  data: Record<string, unknown>
  /**
   * How many hops from the start this entity was reached at, 1-based. Present only on a walk.
   *
   * Reported per entity because a blast radius is a *shape*, not a set: "the database and the
   * two services that talk to it" and "those two services' own callers" are the same kind of
   * answer at different distances, and a caller that cannot see the distance cannot tell which
   * one it got.
   */
  hop?: number
  /** The relation instance that reached this entity, present only on a walk. */
  via?: string
  /**
   * `via`'s declared semantics_tag, when that relation declares one. Absent means the relation
   * makes no claim, which is ordinary — not that the claim failed to reach the caller.
   */
  semantics_tag?: SemanticsTag
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
  /**
   * Entities left out because they are not in the type's default state, when the caller
   * did not ask for a state. Present so the answer never quietly narrows itself.
   */
  excludedByState?: number
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
const PRIMITIVES = ['filter_by', 'traverse', 'search', 'walk'] as const
type Primitive = (typeof PRIMITIVES)[number]

/**
 * How many hops a walk takes when the declaration does not say. Two, because the second hop is
 * where a blast radius stops being "the things wired to this one" and starts being the shape of
 * the outage — and because every extra hop grows the answer faster than it grows the
 * understanding of it.
 */
const WALK_DEFAULT_DEPTH = 2

/**
 * The most hops a walk may take, whatever the declaration asks for.
 *
 * A cap rather than a refusal, so a declaration asking for more still produces the deepest walk
 * the engine will run — but *clamped out loud*: the caller is told the depth was reduced, because
 * a truncated walk that looks complete is how "nothing else is affected" gets said about a graph
 * nobody finished traversing.
 */
const WALK_MAX_DEPTH = 5

/** Which way a walk moves relative to the direction failures travel. */
const WALK_DIRECTIONS = ['downstream', 'upstream', 'both'] as const
type WalkDirection = (typeof WALK_DIRECTIONS)[number]

/**
 * The default direction: what breaks because this entity failed.
 *
 * The half of the pair an incident actually asks about, and the one that can be read without
 * knowing what the caller meant. The prior art these defaults follow — a bounded `expand_topology`
 * BFS, default 2 hops, cap 5 — walks both directions unless told otherwise; here the other
 * direction has to be asked for, because a result that silently contains both is a blast radius
 * nobody can read.
 */
const WALK_DEFAULT_DIRECTION: WalkDirection = 'downstream'

/**
 * A declaration's walk, parsed and checked: what it narrowed to, and how far it may go.
 *
 * Resolved at derivation rather than at call time because everything in here is a fact about the
 * declarations, and a declaration that cannot take effect has to be reported where a domain
 * author will read it — at load, beside the tool it failed to produce.
 */
interface WalkSpec {
  /** Which way to move: with failures, against them, or both. */
  direction: WalkDirection
  /** Hops to take, already clamped to the cap. */
  depth: number
  /** Relation names the walk is restricted to; empty means every walkable relation. */
  relations: readonly string[]
  /** Semantics tags the walk is restricted to; empty means every walkable relation. */
  semantics_tag: readonly SemanticsTag[]
}

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

/** Read an argument that a `match: overlaps` mode asks for as a set of values. */
function optionalStringList(args: ToolArgs, name: string): string[] | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`argument "${name}" must be a list of strings`)
  return value.map(String)
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
  excludedByState?: number,
): QueryResult {
  const capped = objects.slice(0, maxResults)
  return {
    mode,
    objects: capped.map(toResult),
    links,
    total: objects.length,
    returned: capped.length,
    truncated: objects.length > capped.length,
    ...(excludedByState === undefined ? {} : { excludedByState }),
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
 *
 * A walk's per-entity line leads with how far away the entity was and what reached it. The
 * canonical value carries those three fields either way; leaving them out of the prose would
 * mean the model is handed a blast radius it cannot tell apart from a flat list — which is the
 * one thing the hop count exists to prevent.
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
    // Only a walk sets `hop`; every other tool's lines stay exactly as they were.
    const reached =
      object.hop === undefined
        ? ''
        : `  hop ${object.hop}${object.via === undefined ? '' : ` via ${object.via}`}` +
          `${object.semantics_tag === undefined ? '' : ` (${object.semantics_tag})`}`
    lines.push(
      `${object.type} ${object.id}${reached}${fields.length > 0 ? `  ${fields.join('  ')}` : ''}`,
    )
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
  if (value.excludedByState !== undefined && value.excludedByState > 0) {
    lines.push(
      `(${value.excludedByState} more ${value.excludedByState === 1 ? 'entity is' : 'entities are'} ` +
        'in another state; pass state="*" to include them)',
    )
  }
  return lines.join('\n')
}

/**
 * JSON Schema for one entity.
 *
 * `hop`, `via` and `semantics_tag` are declared here even though only a walk produces them: the
 * runtime validates a tool's value against this schema *before* the model sees it, so a field
 * the walk adds and this does not admit would turn a finished walk into a failed call — the
 * work done and thrown away at the last step. They are optional, so the other tools' results
 * still validate without them.
 */
const OBJECT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'Declared object type name.' },
    id: { type: 'string', description: 'Identity within that type.' },
    data: { type: 'object', description: 'The instance fields as stored.' },
    hop: {
      type: 'number',
      description: 'A walk result: how many hops from the start it was reached at.',
    },
    via: {
      type: 'string',
      description: 'A walk result: the relation that reached it.',
    },
    semantics_tag: {
      type: 'string',
      description: "A walk result: `via`'s semantics_tag, when that relation declares one.",
    },
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
    excludedByState: {
      type: 'number',
      description:
        "Entities hidden by the type's default state. Ask for a state, or \"*\" for all of them.",
    },
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
 * True when the instance's field shares any value with a set the caller supplied.
 *
 * The one question containment cannot answer: `matchesField` compares one wanted value against
 * a field, which covers "has this tag" and not "has any of these tags". A scalar field is
 * treated as a set of one, so a declaration does not have to know which shape the data took.
 */
function overlapsField(object: OntologyObject, field: string, wanted: readonly string[]): boolean {
  const value = object.data[field]
  if (value === undefined) return false
  const held = (Array.isArray(value) ? value : [value]).map(String)
  return held.some((candidate) => wanted.includes(candidate))
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
 * True when this relation is admitted by the walk's narrowings, whatever its propagation says.
 *
 * Split out from {@link narrowsWalk} because the two answers are both needed at derivation: which
 * relations the narrowing selected, and which of those can actually be followed. A narrowing that
 * selects a relation which declares no direction is the case worth naming precisely — the author
 * named something real and got a walk that cannot move.
 *
 * @param declared - A relation declaration.
 * @param spec - The walk being resolved.
 */
function admitsNarrowing(declared: LinkTypeDecl, spec: WalkSpec): boolean {
  if (spec.relations.length > 0 && !spec.relations.includes(declared.name)) return false
  if (
    spec.semantics_tag.length > 0 &&
    (declared.semanticsTag === undefined || !spec.semantics_tag.includes(declared.semanticsTag))
  ) {
    return false
  }
  return true
}

/**
 * True when this relation may be followed by this walk: it declares a direction, and both
 * narrowings admit it.
 *
 * The first clause is the whole rule of walkability, and it is a rule rather than a preference.
 * A relation's direction is not derivable from the data, so the engine either reads one or
 * invents one; the tag is deliberately *not* part of the test, because a tag says what a relation
 * means and not which way a failure moves along it — a relation that declares a tag and no
 * direction is therefore not walkable. The return type says so, so no caller has to assert it.
 *
 * @param declared - A relation declaration.
 * @param spec - The walk being resolved.
 */
function narrowsWalk(
  declared: LinkTypeDecl,
  spec: WalkSpec,
): declared is LinkTypeDecl & { propagation: Propagation } {
  return declared.propagation !== undefined && admitsNarrowing(declared, spec)
}

/**
 * Which way one step may move along a relation instance.
 *
 * Reduced to a pair of booleans because two of the three modes agree about a relation that
 * propagates both ways: `downstream` and `upstream` differ only for a directioned relation, and
 * `both` is both in every case. Three near-identical branches per mode would be one inverted
 * branch away from a walk that reports the opposite of the truth.
 *
 * @param direction - The declaration's mode.
 * @param propagation - The relation's declared direction.
 */
function stepDirections(
  direction: WalkDirection,
  propagation: Propagation,
): { forward: boolean; backward: boolean } {
  if (direction === 'both' || propagation === 'both') return { forward: true, backward: true }
  // `forward` is the direction the relation is drawn in. A failure travels with that arrow only
  // when the relation says so; `downstream` follows failures, `upstream` reverses them.
  const withArrow =
    direction === 'downstream' ? propagation === 'from_to' : propagation === 'to_from'
  return { forward: withArrow, backward: !withArrow }
}

/**
 * Walk outward from one id, breadth-first, over the relations that declare a failure direction.
 *
 * Breadth-first because the answer is a distance as much as a set, and because it makes the
 * first arrival at an entity the shortest one — so "visited" and "already reported at a nearer
 * hop" are the same statement, and a cycle costs one skip rather than a loop. Every entity is
 * reported once, with the hop and the relation that reached it first.
 *
 * The walk is bounded by two different limits, and they mean different things: `depth` is how far
 * the *declaration* says a failure reaches, and `maxResults` is how much of that the caller gets
 * to see. The second one sets `truncated`; the first one does not, because a walk that stopped at
 * its stated depth is complete for the question that was asked.
 *
 * Links are scanned once per visited entity rather than being indexed by endpoint. A domain pack is
 * hundreds of instances and the graph is rebuilt on every write, so an index would be a second
 * structure to keep in step with the one that a refresh replaces — and the cost that buys is a
 * constant, not a growth in the answer.
 *
 * @param graph - Loaded graph, read afresh here so a write between calls is visible.
 * @param spec - The declaration's walk: direction, depth, narrowings.
 * @param modeName - Mode name, carried into the result.
 * @param startId - Id of the entity to start from. An id nothing holds is an empty answer.
 * @param maxResults - Cap on returned entities.
 * @returns Entities reached, each with its hop, the relation that reached it and that relation's
 *   tag; the edges traversed; and the counts that say whether the answer is partial.
 */
function walkFrom(
  graph: OntologyGraph,
  spec: WalkSpec,
  modeName: string,
  startId: string,
  maxResults: number,
): QueryResult {
  // A walk has no `on`, so the id is looked up across every declared type rather than inside one.
  // Two types may hold the same id — the schema forbids that only within a type — and when they
  // do, the walk starts from both: choosing one would be the engine deciding which world the
  // caller meant, and the hop counts would be quietly wrong about the other.
  const queue: string[] = []
  const visited = new Map<string, { hop: number; via?: string; semantics_tag?: SemanticsTag }>()
  for (const object of graph.byId.values()) {
    if (object.id !== startId || visited.has(object.key)) continue
    visited.set(object.key, { hop: 0 })
    queue.push(object.key)
  }

  // Reported in arrival order, which is hop order: `order[i]` and `traversed[i]` are the i-th
  // entity and the edge that led to it, so the two lists cannot drift apart.
  const order: string[] = []
  const traversed: OntologyLink[] = []

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]
    if (current === undefined) continue
    const hit = visited.get(current)
    if (hit === undefined) continue
    if (hit.hop >= spec.depth) continue

    for (const link of graph.links) {
      const declared = graph.schema.linkTypes.get(link.type)
      // Following a relation nobody declared would be following a name, not a relation.
      if (declared === undefined || !narrowsWalk(declared, spec)) continue

      const directions = stepDirections(spec.direction, declared.propagation)
      const fromKey = `${link.fromType}:${link.from}`
      const toKey = `${link.toType}:${link.to}`
      let next: string | undefined
      if (directions.forward && current === fromKey) next = toKey
      else if (directions.backward && current === toKey) next = fromKey
      if (next === undefined || visited.has(next)) continue
      // A relation instance can point at an object that is not there. The loader has already
      // reported that edge; reporting it here as a reached entity would put an instance that does
      // not exist into an answer, and reporting it as a hop would make the walk look deeper than
      // the graph it walked.
      if (!graph.byId.has(next)) continue

      visited.set(next, {
        hop: hit.hop + 1,
        via: link.type,
        ...(declared.semanticsTag === undefined ? {} : { semantics_tag: declared.semanticsTag }),
      })
      order.push(next)
      traversed.push(link)
      queue.push(next)
    }
  }

  const objects: ResultObject[] = []
  const links: OntologyLink[] = []
  for (const [index, key] of order.entries()) {
    const object = graph.byId.get(key)
    const hit = visited.get(key)
    if (object === undefined || hit === undefined) continue
    objects.push({
      type: object.type,
      id: object.id,
      data: object.data,
      hop: hit.hop,
      ...(hit.via === undefined ? {} : { via: hit.via }),
      ...(hit.semantics_tag === undefined ? {} : { semantics_tag: hit.semantics_tag }),
    })
    // The edge that led to this entity and no other: an edge to something the cap left out would
    // contradict the rows it sits beside, which is the rule the traversal mode already follows.
    const edge = traversed[index]
    if (edge !== undefined) links.push(edge)
  }

  const capped = objects.slice(0, maxResults)
  return {
    mode: modeName,
    objects: capped,
    links: links.slice(0, capped.length),
    total: objects.length,
    returned: capped.length,
    truncated: objects.length > capped.length,
  }
}

/**
 * Parse a walk declaration, warning about every part of it that cannot take effect.
 *
 * Nothing here falls back silently. A direction outside the three, a depth that is not a whole
 * number of hops, a narrowing that names a relation or a tag this domain does not have — each of
 * those is a declaration whose author believes something was stated, and each is reported. The
 * one degradation that does not drop the mode is the depth cap: the declaration asks for more
 * hops than the engine will walk, so the walk happens, shorter, and says so.
 *
 * @param name - Function name, for the messages.
 * @param declaration - The function's raw declaration.
 * @param graph - Loaded graph, for the relations and tags a narrowing is checked against.
 * @param warnings - Collector for the messages.
 * @returns The walk to run, or `undefined` when the declaration is unusable.
 */
function parseWalk(
  name: string,
  declaration: Record<string, unknown>,
  graph: OntologyGraph,
  warnings: string[],
): WalkSpec | undefined {
  const rawDirection = declaration.direction
  if (rawDirection !== undefined) {
    if (
      typeof rawDirection !== 'string' ||
      !WALK_DIRECTIONS.includes(rawDirection as WalkDirection)
    ) {
      warnings.push(
        `function "${name}" declares direction "${String(rawDirection)}"; expected ` +
          `${WALK_DIRECTIONS.join(', ')} — the mode is unavailable`,
      )
      return undefined
    }
  }
  const direction: WalkDirection =
    rawDirection === undefined ? WALK_DEFAULT_DIRECTION : (rawDirection as WalkDirection)

  // Two keys the other primitives take and a walk does not. Both are reported rather than
  // ignored, and the mode still runs: a declaration copied from a filter and renamed is a
  // realistic mistake, and a clause that silently does nothing is worse than a slow tool —
  // the author reads the declaration and believes the answers are filtered.
  for (const key of ['on', 'where'] as const) {
    if (declaration[key] !== undefined) {
      warnings.push(
        key === 'on'
          ? `function "${name}" declares "on", which a walk has no use for — it starts at the id ` +
              'in "by" and follows relations from there'
          : `function "${name}" declares "where", which a walk does not narrow by — every entity ` +
              'it reaches is reported',
      )
    }
  }

  const rawDepth = declaration.depth
  if (
    rawDepth !== undefined &&
    (typeof rawDepth !== 'number' || !Number.isInteger(rawDepth) || rawDepth < 1)
  ) {
    warnings.push(
      `function "${name}" declares depth ${String(rawDepth)}, which is not a whole number of ` +
        'hops of at least 1 — the mode is unavailable',
    )
    return undefined
  }
  const asked = rawDepth === undefined ? WALK_DEFAULT_DEPTH : (rawDepth as number)
  const depth = Math.min(asked, WALK_MAX_DEPTH)
  if (depth < asked) {
    warnings.push(
      `function "${name}" declares depth ${asked}; walks are capped at ${WALK_MAX_DEPTH} hops, ` +
        `so this one stops at ${WALK_MAX_DEPTH}`,
    )
  }

  // A narrowing that is not a list is not a narrowing; reading it as "no narrowing" would widen
  // the walk to every relation, which is the opposite of what its author asked for.
  for (const key of ['relations', 'semantics_tag'] as const) {
    if (declaration[key] !== undefined && !Array.isArray(declaration[key])) {
      warnings.push(
        `function "${name}" declares "${key}" as something other than a list — the mode is ` +
          'unavailable',
      )
      return undefined
    }
  }
  const relations = Array.isArray(declaration.relations) ? declaration.relations.map(String) : []
  const semantics = Array.isArray(declaration.semantics_tag) ? declaration.semantics_tag.map(String) : []

  for (const relation of relations) {
    if (!graph.schema.linkTypes.has(relation)) {
      warnings.push(
        `function "${name}" narrows walk to relation "${relation}", which this domain does not ` +
          'declare — the mode is unavailable',
      )
      return undefined
    }
  }
  const tags: SemanticsTag[] = []
  for (const tag of semantics) {
    const known = SEMANTICS_TAGS.find((candidate) => candidate === tag)
    if (known === undefined) {
      warnings.push(
        `function "${name}" narrows walk to semantics_tag "${tag}"; expected one of ` +
          `${SEMANTICS_TAGS.join(', ')} — the mode is unavailable`,
      )
      return undefined
    }
    tags.push(known)
  }

  const spec: WalkSpec = { direction, depth, relations, semantics_tag: tags }
  // A narrowing that selects nothing walkable leaves a mode that can only ever return nothing.
  // That is worth saying at load: an empty answer from a correctly-asked question and an empty
  // answer from a declaration that cannot take effect look identical to the model.
  const walkable = [...graph.schema.linkTypes.values()].filter((declared) =>
    narrowsWalk(declared, spec),
  )
  if (walkable.length === 0) {
    const narrowed = relations.length > 0 || tags.length > 0
    const selected = [...graph.schema.linkTypes.values()].filter((declared) =>
      admitsNarrowing(declared, spec),
    )
    const available = [...graph.schema.linkTypes.values()]
      .filter((declared) => declared.propagation !== undefined)
      .map((declared) => declared.name)
    const reachable =
      available.length === 0 ? '' : ` — this domain can walk: ${available.join(', ')}`
    warnings.push(
      !narrowed
        ? `function "${name}" uses walk, but no relation in this domain declares a propagation ` +
          'direction, so a walk can never leave its start'
        : selected.length === 0
          ? `function "${name}" narrows walk to no declared relation; a walk can never leave its ` +
            `start${reachable}`
          : `function "${name}" narrows walk to ${selected.map((entry) => entry.name).join(', ')}, ` +
            `which declare no propagation direction; a walk can never leave its start${reachable}`,
    )
  }

  return spec
}

/**
 * What a walk mode adds to the description the model reads.
 *
 * The declaration's own words come first, and the bound follows them, because the bound is what
 * the model needs in order to ask a second question instead of concluding that the first one
 * answered everything. The cap is stated even when the declaration asked for less than it, since
 * that is the number that cannot be moved by editing the declaration.
 *
 * @param declared - The declaration's own description, if it supplied one.
 * @param walk - The parsed walk.
 */
function walkModeDescription(declared: string, walk: WalkSpec): string {
  const lead = declared.length > 0 ? `${declared} ` : ''
  return (
    `${lead}Walks ${walk.direction} at most ${walk.depth} ` +
    `hop${walk.depth === 1 ? '' : 's'} along relations that declare which way a failure travels; ` +
    `the cap is ${WALK_MAX_DEPTH} hops. Each reached entity carries its hop count, the relation ` +
    "that reached it, and that relation's semantics_tag."
  )
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
    /** For walk: what to follow, how far, and which way. Parsed and checked at derivation. */
    walk?: WalkSpec
    where: Record<string, unknown>
    /**
     * How the parameter is compared to the field it names.
     *
     * `equals` asks for one value; a field holding a list already answers it by containment,
     * which is why a declaration almost never has to say anything. `overlaps` is for the case
     * that cannot be said that way: the caller has a *set* of values and wants the entities
     * sharing any of them — "whose expertise covers one of these problem areas". That needs the
     * parameter itself to be a list, which the schema and the comparison both have to know.
     */
    match: 'equals' | 'overlaps'
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

    const rawMatch = declaration.match
    if (rawMatch !== undefined && rawMatch !== 'equals' && rawMatch !== 'overlaps') {
      warnings.push(
        `function "${name}" declares match "${String(rawMatch)}"; expected "equals" or ` +
          '"overlaps" — the mode is unavailable',
      )
      continue
    }
    const match: 'equals' | 'overlaps' = rawMatch === 'overlaps' ? 'overlaps' : 'equals'

    // A relation points one way, but the useful question often runs the other way:
    // `reported_on` goes Issue -> Project, while "what is blocking this project"
    // starts at the project. Reversing at query time is the only way to answer that,
    // because an inverse relation cannot be derived from the data.
    //
    // `walk` reads the same key for a different question — which way a *failure* travels — so its
    // three values are checked in `parseWalk` instead. Checking them here would refuse a walk for
    // not being a traversal, and checking a traversal's two values there would do the reverse.
    const rawDirection = declaration.direction
    if (
      primitive !== 'walk' &&
      rawDirection !== undefined &&
      rawDirection !== 'outgoing' &&
      rawDirection !== 'incoming'
    ) {
      warnings.push(
        `function "${name}" declares direction "${String(rawDirection)}"; expected "outgoing" or "incoming" — the mode is unavailable`,
      )
      continue
    }
    const incoming = rawDirection === 'incoming'

    // A walk starts from an entity id and follows relations, so there is no single `on` type for
    // it to be pointed at: the id belongs to whatever type holds it.
    if (primitive !== 'traverse' && primitive !== 'walk') {
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

    // Parsed here rather than at call time so a declaration that cannot take effect is reported
    // where the domain author is looking — with the other warnings from this load, beside the
    // mode that is missing.
    const walk = primitive === 'walk' ? parseWalk(name, declaration, graph, warnings) : undefined
    if (primitive === 'walk' && walk === undefined) continue

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
            : primitive === 'walk'
              ? 'Id of the entity to start the walk from — the question "what does a failure here reach". An id nothing holds yields an empty result rather than an error.'
              : type !== undefined
                ? describeFieldParam(type, by)
                : by

    modes.push({
      name,
      description:
        walk !== undefined
          ? walkModeDescription(description, walk)
          : description.length > 0
            ? description
            : `${primitive} over ${on ?? relation ?? ''}`.trim(),
      primitive: primitive as Primitive,
      ...(by === undefined ? {} : { param: by }),
      ...(paramDescription === undefined ? {} : { paramDescription }),
      ...(on === undefined ? {} : { on }),
      ...(relation === undefined ? {} : { relation }),
      incoming,
      ...(walk === undefined ? {} : { walk }),
      where,
      match,
    })
  }

  if (modes.length === 0) return undefined

  // One parameter node per distinct parameter name, described by every mode that uses
  // it. Modes that take no argument need none of this.
  const properties: Record<string, JsonSchemaNode> = {
    mode: stringNode(
      `Which query to run. ${modes.map((mode) => `${mode.name}${mode.param === undefined ? '' : ` (takes "${mode.param}"${mode.match === "overlaps" ? " as a list" : ""})`}`).join('; ')}.`,
      modes.map((mode) => mode.name),
    ),
  }
  // Two modes can name the same field and want it two ways — "has this tag" and "has any of these
  // tags" read one field differently. The argument name is the field name, so they cannot be
  // given different names, and the schema has to admit both shapes rather than advertise one and
  // let the other mode's reader reject what the schema allowed.
  const shapes = new Map<string, Set<'string' | 'array'>>()
  for (const mode of modes) {
    if (mode.param === undefined) continue
    const seen = shapes.get(mode.param) ?? new Set<'string' | 'array'>()
    seen.add(mode.match === 'overlaps' ? 'array' : 'string')
    shapes.set(mode.param, seen)
  }

  for (const mode of modes) {
    if (mode.param === undefined) continue
    const existing = properties[mode.param]
    const note = `for mode "${mode.name}"`
    const kinds = shapes.get(mode.param) ?? new Set(['string'])
    const shape: JsonSchemaNode =
      kinds.size > 1
        ? {
            oneOf: [
              stringNode(`${mode.paramDescription ?? mode.param}`),
              { type: 'array', items: { type: 'string' } },
            ],
          }
        : mode.match === 'overlaps'
          ? { type: 'array', items: { type: 'string' } }
          : stringNode(`${mode.paramDescription ?? mode.param}`)
    properties[mode.param] =
      existing === undefined
        ? { ...shape, description: `${mode.paramDescription ?? mode.param} — ${note}` }
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

      // A walk answers a question whose answer is a *path*, so it is handled before the
      // single-hop cases: it takes the same one argument they do, and nothing they share with
      // each other applies to it (no `on` type, no fixed `where`).
      if (mode.walk !== undefined) {
        const startId = mode.param === undefined ? undefined : optionalString(args, mode.param)
        if (startId === undefined) {
          throw new Error(`mode "${modeName}" requires argument "${mode.param ?? 'by'}"`)
        }
        // The graph is read here and not at derivation, so a write that refreshed it between
        // calls is walked, exactly as the other modes read it.
        return walkFrom(graph, mode.walk, modeName, startId, maxResults)
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
        if (mode.match === 'overlaps') {
          const wanted = optionalStringList(args, mode.param)
          if (wanted === undefined) {
            throw new Error(`mode "${modeName}" requires argument "${mode.param}"`)
          }
          objects = objects.filter((object) => overlapsField(object, mode.param as string, wanted))
        } else {
          const value = optionalString(args, mode.param)
          if (value === undefined) {
            throw new Error(`mode "${modeName}" requires argument "${mode.param}"`)
          }
          objects =
            mode.primitive === 'search'
              ? objects.filter((object) => matchesQuery(object, value))
              : objects.filter((object) => matchesField(object, mode.param as string, value))
        }
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
          state: stringNode(
            "Lifecycle state to include. Omitted, the type's default state applies; pass \"*\" for " +
              "every state. Ignored for types that declare no lifecycle.",
          ),
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
        const requestedState = optionalString(args, 'state')

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

        // The default state is where "use only what somebody vouched for" lives. Stated
        // rather than silent: whatever the filter removes is counted and reported, because
        // an answer that hides half the world without saying so is worse than a slower one.
        const lifecycle = type.lifecycle
        if (lifecycle !== undefined && lifecycle.defaultState !== undefined) {
          const wanted =
            requestedState === '*' ? undefined : (requestedState ?? lifecycle.defaultState)
          if (wanted !== undefined) {
            const before = objects.length
            objects = objects.filter((object) => {
              const value = object.data[lifecycle.field]
              const state = typeof value === 'string' && value.length > 0 ? value : lifecycle.initial
              return state === wanted
            })
            const excluded = before - objects.length
            if (excluded > 0 && requestedState === undefined) {
              return pack('find', objects, [], maxResults, excluded)
            }
          }
        } else if (requestedState !== undefined && requestedState !== '*') {
          throw new Error(
            `"${type.name}" declares no lifecycle, so there is no state "${requestedState}" to ask for`,
          )
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
