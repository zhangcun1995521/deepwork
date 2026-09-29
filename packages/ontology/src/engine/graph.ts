/**
 * Graph runtime — load a domain pack into memory and answer questions about it.
 *
 * Like `schema.ts`, nothing here knows a business concept. Entity types, relation
 * names, primary keys and directories all come from the schema, so pointing this at
 * a different domain is a data change. The debug-domain check in this package's
 * tests pins that property down.
 *
 * The graph is deliberately plain: an array of objects, an array of links, and two
 * indexes. Derivation of the agent's tool surface reads this structure; it does not
 * extend it.
 *
 * Edge derivation is explicit-only. A link exists when an instance carries the field
 * its relation names — `via` when declared, otherwise the relation's own name — *and*
 * the instance's type is that relation's declared `from`. The second half of that rule
 * is not decoration: without it, a primary-key field that happens to share a relation's
 * name silently produces a self-loop, which is how a wrong edge gets into the graph and
 * then into an answer.
 *
 * @module @deepwork/ontology/engine/graph
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { load as loadYaml } from 'js-yaml'

import { parseSchema, type OntologySchema } from './schema.ts'

/** One instance of a declared object type. */
export interface OntologyObject {
  /** Declared type name. */
  type: string
  /** Identity, from the type's primary-key field (or the filename as a fallback). */
  id: string
  /** `${type}:${id}` — precomputed because every lookup is keyed this way. */
  key: string
  /** The instance's fields as parsed. */
  data: Record<string, unknown>
  /** Path relative to the domain root, e.g. `objects/projects/P-001.yaml`. */
  file: string
}

/** One derived relation instance. */
export interface OntologyLink {
  /** Relation name. */
  type: string
  /** Source instance id. */
  from: string
  /** Source instance type. */
  fromType: string
  /** Target instance id. */
  to: string
  /** Target instance type, from the relation declaration. */
  toType: string
}

/** A loaded domain graph. */
export interface OntologyGraph {
  /** Domain root the graph was loaded from. */
  root: string
  /** The parsed schema this graph was built from. */
  schema: OntologySchema
  /** Every instance. */
  objects: OntologyObject[]
  /** Every derived relation instance. */
  links: OntologyLink[]
  /** Instances indexed by declared type. */
  byType: Map<string, OntologyObject[]>
  /** Instances indexed by `${type}:${id}`. */
  byId: Map<string, OntologyObject>
  /** Non-fatal problems found while loading. Never empty by accident. */
  warnings: string[]
}

/**
 * How many dangling-link warnings to report before collapsing the rest into a
 * count. A domain with a systematic reference bug would otherwise emit thousands of
 * near-identical lines and bury the one warning that matters.
 */
const DANGLING_LINK_REPORT_LIMIT = 20

/** True for files this loader should attempt to read as instances. */
function isYamlFile(name: string): boolean {
  return name.endsWith('.yaml') || name.endsWith('.yml')
}

/** Render an unknown thrown value as a single-line message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True for a plain mapping, which is what an instance file must contain. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Derive explicit links from instance fields.
 *
 * @param objects - Instances to scan.
 * @param schema - Parsed schema supplying the relation declarations.
 */
function deriveLinks(objects: OntologyObject[], schema: OntologySchema): OntologyLink[] {
  // Index relations by the field that carries them, which is `via` when declared and
  // the relation's own name otherwise.
  const byField = new Map([...schema.linkTypes.values()].map((link) => [link.field, link]))

  const links: OntologyLink[] = []
  for (const object of objects) {
    for (const [field, value] of Object.entries(object.data)) {
      const link = byField.get(field)
      // The field must carry a declared relation, and this object's type must be
      // that relation's declared source. See the module doc for why both halves
      // are required.
      if (link === undefined || link.from !== object.type) continue
      for (const target of Array.isArray(value) ? value : [value]) {
        if (typeof target !== 'string' || target.length === 0) continue
        links.push({
          type: link.name,
          from: object.id,
          fromType: object.type,
          to: target,
          toType: link.to,
        })
      }
    }
  }
  return links
}

/**
 * Load a domain pack into an in-memory graph.
 *
 * Throws only when the schema itself cannot be read (see `parseSchema`). Everything
 * else about the domain becomes a warning, so one missing directory cannot stop a
 * domain from loading while still being visible to the caller.
 *
 * @param root - Domain root directory containing `schema.yaml`.
 */
export function loadGraph(root: string): OntologyGraph {
  const schema = parseSchema(root)
  const warnings = [...schema.warnings]

  const objects: OntologyObject[] = []
  const byType = new Map<string, OntologyObject[]>()
  const byId = new Map<string, OntologyObject>()

  for (const type of schema.objectTypes.values()) {
    // `parseSchema` already warned about a missing file_location.
    if (type.directory.length === 0) continue

    const directory = join(root, type.directory)
    let entries: string[]
    try {
      entries = readdirSync(directory)
    } catch {
      warnings.push(
        `object type "${type.name}": directory "${type.directory}" does not exist; no instances loaded`,
      )
      continue
    }

    // Sorted so that load order — and therefore warning order and duplicate
    // resolution — is reproducible across machines.
    for (const file of entries.filter(isYamlFile).sort()) {
      const relative = `${type.directory}/${file}`

      let data: unknown
      try {
        data = loadYaml(readFileSync(join(directory, file), 'utf8'))
      } catch (error) {
        warnings.push(`skipped ${relative}: cannot parse YAML (${describe(error)})`)
        continue
      }
      if (!isMapping(data)) {
        warnings.push(`skipped ${relative}: expected a YAML mapping`)
        continue
      }

      const declaredId = data[type.primaryKey]
      let id: string
      if (declaredId === undefined || declaredId === null || String(declaredId).length === 0) {
        id = file.replace(/\.ya?ml$/, '')
        warnings.push(
          `object "${relative}" has no "${type.primaryKey}"; using its filename "${id}" as the identity`,
        )
      } else {
        id = String(declaredId)
      }

      const key = `${type.name}:${id}`
      if (byId.has(key)) {
        // Keeping the first occurrence makes the outcome independent of directory
        // order, which matters because a domain bug here changes query results.
        warnings.push(`duplicate id ${key}: ${relative} ignored, keeping the earlier instance`)
        continue
      }

      const object: OntologyObject = { type: type.name, id, key, data, file: relative }
      objects.push(object)
      byId.set(key, object)
      const list = byType.get(type.name)
      if (list === undefined) byType.set(type.name, [object])
      else list.push(object)
    }
  }

  const links = deriveLinks(objects, schema)

  // A link pointing at an object that is not there is the most common way a domain
  // pack goes quietly wrong: the relation looks present, and queries return nothing.
  let dangling = 0
  for (const link of links) {
    if (byId.has(`${link.toType}:${link.to}`)) continue
    dangling += 1
    if (dangling <= DANGLING_LINK_REPORT_LIMIT) {
      warnings.push(
        `link ${link.fromType}:${link.from} -[${link.type}]-> ${link.toType}:${link.to} has no matching object`,
      )
    }
  }
  if (dangling > DANGLING_LINK_REPORT_LIMIT) {
    warnings.push(
      `… and ${dangling - DANGLING_LINK_REPORT_LIMIT} more links pointing at missing objects (${dangling} total)`,
    )
  }

  // A relation the data can never satisfy is invisible from every tool surface built
  // on this graph: the schema says it exists, queries return nothing, and nothing
  // complains. One grouped line, because a domain with several unwired relations
  // should stay readable.
  const unwired = [...schema.linkTypes.values()].filter((link) => {
    // An undeclared target type is already reported as a malformed declaration; do
    // not report the same relation twice.
    if (!schema.objectTypes.has(link.to)) return false
    // No source instances yet means the relation is legitimately undefined, not
    // wired wrong.
    const sources = byType.get(link.from) ?? []
    if (sources.length === 0) return false
    return !sources.some((object) => Object.hasOwn(object.data, link.field))
  })
  if (unwired.length > 0) {
    warnings.push(
      'declared relations with no matching instance field: ' +
        unwired.map((link) => `${link.name} (expects "${link.field}" on ${link.from})`).join(', ') +
        ' — wire the field on an instance, or drop the relation',
    )
  }

  return { root, schema, objects, links, byType, byId, warnings }
}

/**
 * Instances of one declared type that satisfy a predicate.
 *
 * @param graph - Loaded graph.
 * @param type - Declared type name; an unknown name yields an empty array.
 * @param predicate - Test applied to each instance.
 */
export function filter(
  graph: OntologyGraph,
  type: string,
  predicate: (object: OntologyObject) => boolean,
): OntologyObject[] {
  return (graph.byType.get(type) ?? []).filter(predicate)
}

/**
 * Links of one relation, optionally restricted to a single source.
 *
 * @param graph - Loaded graph.
 * @param linkType - Declared relation name.
 * @param fromId - When given, only links originating from this instance id.
 */
export function linksOf(graph: OntologyGraph, linkType: string, fromId?: string): OntologyLink[] {
  return graph.links.filter(
    (link) => link.type === linkType && (fromId === undefined || link.from === fromId),
  )
}

/**
 * Objects reached by one relation, optionally from a single source.
 *
 * Unlike `linksOf`, this resolves each link to its target object and drops links
 * whose target is absent, so callers never receive a half-populated result.
 *
 * @param graph - Loaded graph.
 * @param linkType - Declared relation name.
 * @param fromId - When given, only links originating from this instance id.
 */
export function targetsOf(
  graph: OntologyGraph,
  linkType: string,
  fromId?: string,
): OntologyObject[] {
  const targets: OntologyObject[] = []
  for (const link of linksOf(graph, linkType, fromId)) {
    const target = graph.byId.get(`${link.toType}:${link.to}`)
    if (target !== undefined) targets.push(target)
  }
  return targets
}
