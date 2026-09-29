/**
 * Schema parsing and validation — the only place that understands the domain-pack
 * file format.
 *
 * A domain pack is one `schema.yaml` plus a tree of instance files. This module
 * turns that YAML into typed declarations, and nothing here knows any business
 * concept: entity names, directory layout, primary keys and relation names are all
 * read from the file. That is what makes a new domain a data change rather than a
 * code change.
 *
 * Failure policy — the split matters, because both halves have bitten this project
 * before:
 *
 *   - Fatal (`throw`): the schema file itself is missing, unreadable, or not a
 *     mapping. That means the caller pointed at the wrong place, and returning an
 *     empty graph would hide a configuration mistake behind a working-looking
 *     startup.
 *   - Warning: anything wrong with one individual declaration. A single bad entry
 *     must not take the whole domain down, but it must never be silent either —
 *     every degradation is recorded in `warnings` for the caller to surface.
 *
 * @module @zhangcun123/ontology/engine/schema
 */

import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { load as loadYaml } from 'js-yaml'

/** How an object type's primary key was determined; kept for diagnostics. */
export type PrimaryKeySource = 'declared' | 'required_fields' | 'fallback'

/** A single field declared on an object type. Unknown keys are preserved as-is. */
export interface FieldDecl {
  /** Declared value kind (`string`, `ref`, `enum`, …). Free-form by design. */
  type?: string
  /** Whether the field must be present on every instance. */
  required?: boolean
  /** Human-readable meaning, surfaced to the model in derived tool schemas. */
  description?: string
  /** Allowed values when the field is an enumeration. */
  values?: unknown[]
  /** Target object type when the field holds a reference. */
  to?: string
  [key: string]: unknown
}

/** An object type: one kind of thing the domain declares. */
export interface ObjectTypeDecl {
  /** Type name, exactly as declared under `object_types`. */
  name: string
  /** Field holding the identity of an instance. */
  primaryKey: string
  /** Where `primaryKey` came from — `fallback` means the schema said nothing. */
  primaryKeySource: PrimaryKeySource
  /** Fields declared required, in declaration order. */
  requiredFields: string[]
  /** Field declarations. */
  fields: Record<string, FieldDecl>
  /** Declared `file_location`, kept verbatim for diagnostics. */
  fileLocation: string
  /** Directory holding instances, derived from `file_location` (posix form). */
  directory: string
  /** Roles permitted to write this type. Consumed by the guard layer. */
  writtenBy: string[]
  /** The declaration as parsed, for anything this shape does not model yet. */
  raw: Record<string, unknown>
}

/** A relation type: a named, directed edge between two object types. */
export interface LinkTypeDecl {
  /** Relation name, exactly as declared under `link_types`. */
  name: string
  /** Source object type name. */
  from: string
  /** Target object type name. */
  to: string
  /**
   * Field on the source instance that carries this relation, when it is not simply
   * the relation's name. Declaring it lets a domain keep its natural field names —
   * `customer` rather than `belongs_to` — because otherwise the only way to wire a
   * relation is to rename the data after it.
   */
  via?: string
  /** The field read during edge derivation: `via` when declared, otherwise `name`. */
  field: string
  /** Human-readable meaning. */
  description?: string
  /** The declaration as parsed. */
  raw: Record<string, unknown>
}

/** A parsed domain schema. */
export interface OntologySchema {
  /** Domain root the schema was read from. */
  root: string
  /** Declared schema version, if any. */
  version?: string
  /** Object types by name. */
  objectTypes: Map<string, ObjectTypeDecl>
  /** Relation types by name. */
  linkTypes: Map<string, LinkTypeDecl>
  /** Declared functions, kept raw — typed by the derivation layer. */
  functions: Record<string, unknown>
  /** Declared actions, kept raw — typed by the derivation layer. */
  actionTypes: Record<string, unknown>
  /** The document as parsed. */
  raw: Record<string, unknown>
  /** Non-fatal problems found while parsing. Never empty by accident. */
  warnings: string[]
}

/** Render an unknown thrown value as a single-line message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True for a plain mapping, which is what every declaration must be. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read `values` when it is a list, otherwise `undefined`. */
function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((entry) => String(entry))
}

/** Read `fields` when it is a mapping of mappings, otherwise `{}`. */
function asFieldMap(value: unknown): Record<string, FieldDecl> {
  if (!isMapping(value)) return {}
  const fields: Record<string, FieldDecl> = {}
  for (const [name, decl] of Object.entries(value)) {
    fields[name] = isMapping(decl) ? (decl as FieldDecl) : {}
  }
  return fields
}

/**
 * Resolve an object type's primary key.
 *
 * An explicit `primary_key` wins. Otherwise the first `required_fields` entry is
 * used, which is the convention inherited from the reference implementation. If
 * neither is present the type is still loadable, but instances can only be
 * identified by filename, so the caller gets a warning rather than a surprise.
 */
function resolvePrimaryKey(
  typeName: string,
  decl: Record<string, unknown>,
  requiredFields: string[],
  warnings: string[],
): { primaryKey: string; source: PrimaryKeySource } {
  const declared = decl.primary_key ?? decl.primaryKey
  if (typeof declared === 'string' && declared.length > 0) {
    return { primaryKey: declared, source: 'declared' }
  }
  const first = requiredFields[0]
  if (first !== undefined && first.length > 0) {
    return { primaryKey: first, source: 'required_fields' }
  }
  warnings.push(
    `object type "${typeName}" declares neither primary_key nor a required field; ` +
      `instances will fall back to their filename as the identity`,
  )
  return { primaryKey: 'id', source: 'fallback' }
}

/**
 * Parse and validate a domain pack's `schema.yaml`.
 *
 * Throws when the schema file cannot be read or is not a mapping — see the module
 * doc for why that half is fatal. Everything else becomes a warning.
 *
 * @param root - Domain root directory containing `schema.yaml`.
 */
export function parseSchema(root: string): OntologySchema {
  const schemaPath = join(root, 'schema.yaml')

  let document: unknown
  try {
    document = loadYaml(readFileSync(schemaPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ontology schema at ${schemaPath}: ${describe(error)}`)
  }
  if (!isMapping(document)) {
    throw new Error(`ontology schema at ${schemaPath} must be a YAML mapping`)
  }

  const warnings: string[] = []
  const objectTypes = new Map<string, ObjectTypeDecl>()
  const linkTypes = new Map<string, LinkTypeDecl>()

  // ── object types ──────────────────────────────────────────────────────────
  const rawObjectTypes = document.object_types
  if (rawObjectTypes !== undefined && !isMapping(rawObjectTypes)) {
    warnings.push('"object_types" must be a mapping; ignoring it entirely')
  }
  for (const [name, declaration] of Object.entries(asFieldMap(rawObjectTypes))) {
    if (!isMapping(declaration)) {
      warnings.push(`object type "${name}" is not a mapping; skipped`)
      continue
    }
    const decl = declaration as Record<string, unknown>

    const fileLocation = typeof decl.file_location === 'string' ? decl.file_location : ''
    if (fileLocation.length === 0) {
      // Without a location there is nowhere to look for instances, so the type is
      // unusable. Recorded rather than thrown: other types still load.
      warnings.push(`object type "${name}" declares no file_location; its instances cannot be loaded`)
    }

    const requiredFields = asStringList(decl.required_fields) ?? []
    const { primaryKey, source } = resolvePrimaryKey(name, decl, requiredFields, warnings)

    objectTypes.set(name, {
      name,
      primaryKey,
      primaryKeySource: source,
      requiredFields,
      fields: asFieldMap(decl.fields),
      fileLocation,
      // `file_location` names a file pattern like `objects/patterns/TP-*.yaml`;
      // its directory is what holds the instances. posix.dirname keeps this
      // deterministic regardless of the host platform, since the schema is
      // authored with forward slashes.
      directory: fileLocation.length > 0 ? posix.dirname(fileLocation) : '',
      writtenBy: asStringList(decl.written_by) ?? [],
      raw: decl,
    })
  }

  // ── link types ────────────────────────────────────────────────────────────
  const rawLinkTypes = document.link_types
  if (rawLinkTypes !== undefined && !isMapping(rawLinkTypes)) {
    warnings.push('"link_types" must be a mapping; ignoring it entirely')
  }
  for (const [name, declaration] of Object.entries(asFieldMap(rawLinkTypes))) {
    const decl = isMapping(declaration) ? declaration : {}
    const from = typeof decl.from === 'string' ? decl.from : ''
    const to = typeof decl.to === 'string' ? decl.to : ''

    if (from.length === 0 || to.length === 0) {
      warnings.push(`link type "${name}" must declare both "from" and "to"; skipped`)
      continue
    }
    // A relation naming an undeclared type can never produce an edge, because
    // edge derivation matches the source object's declared type.
    if (!objectTypes.has(from)) {
      warnings.push(`link type "${name}" has unknown source type "${from}"; it will never match an object`)
    }
    if (!objectTypes.has(to)) {
      warnings.push(`link type "${name}" has unknown target type "${to}"; edges will resolve to nothing`)
    }

    const description = decl.description
    const via = typeof decl.via === 'string' && decl.via.length > 0 ? decl.via : undefined
    if (decl.via !== undefined && via === undefined) {
      warnings.push(`link type "${name}" declares an empty "via"; falling back to the relation name`)
    }

    linkTypes.set(name, {
      name,
      from,
      to,
      ...(via === undefined ? {} : { via }),
      field: via ?? name,
      ...(typeof description === 'string' ? { description } : {}),
      raw: decl,
    })
  }

  const version = document.version
  return {
    root,
    ...(typeof version === 'string' || typeof version === 'number' ? { version: String(version) } : {}),
    objectTypes,
    linkTypes,
    functions: isMapping(document.functions) ? document.functions : {},
    actionTypes: isMapping(document.action_types) ? document.action_types : {},
    raw: document,
    warnings,
  }
}
