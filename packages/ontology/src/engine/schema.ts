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

import { parseLifecycle, type LifecycleDecl } from './lifecycle.ts'

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
  /**
   * Roles permitted to *increment* this field, when it is a counter.
   *
   * Kept apart from `written_by` on purpose: who may record that knowledge was used is
   * not who may author it. In the reference implementation the counter was bumped by a
   * write that bypassed the permission layer entirely; here the increment is a declared
   * right like any other, and refusing it is a normal refusal.
   */
  incrementBy?: string[]
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
  /**
   * Declared states and the moves between them, when the type has a lifecycle.
   * Undefined means writes behave as plain field edits, with no state to enforce.
   */
  lifecycle?: LifecycleDecl
  /**
   * How to turn this type's instances into skills the agent can load, when the domain says to.
   *
   * Declared per type rather than inferred, because which field is the instruction and which is
   * the routing line is a fact about the domain and nothing else can guess it. The set exposed
   * is the set a read would return — the lifecycle's default state — so "what a reader is given"
   * and "what the agent may load" stay the same answer from the same declaration.
   */
  skill?: SkillDecl
  /** The declaration as parsed, for anything this shape does not model yet. */
  raw: Record<string, unknown>
}

/** Which fields carry what a skill needs. */
export interface SkillDecl {
  /** Field holding the short routing description. */
  description: string
  /** Field holding extra routing guidance, when one is declared. */
  whenToUse?: string
  /** Field holding the instructions the agent loads. */
  body: string
  /**
   * Field holding the heading a rendered listing groups by, when one is declared.
   *
   * Declared for the same reason as the other two: which field classifies a domain's experience
   * is a fact about the domain, and an engine that guessed a name like `kind` would work on
   * exactly the one domain it was written against. The skill catalog has no use for it — it is
   * read by the injected listing, where forty rules in a flat run are rules nobody follows.
   */
  groupBy?: string
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
/**
 * A declared action: a named way to write, rather than the one generic write tool.
 *
 * The ontology model is objects, links, actions, functions. Objects, links and functions
 * were real here before this; `action_types` was parsed and counted but nothing derived from
 * it, which meant a domain could declare an action, see it in the panel's summary, and get
 * nothing when calling it. A declaration that does not take effect is worse than no
 * declaration, because the domain author believes it worked.
 *
 * An action is deliberately a thin shell over the same write path as `ontology_write`:
 * `create` and `update` add a precondition, and the permission, lifecycle, review, audit and
 * provenance machinery is the machinery that already exists.
 */
export interface ActionDecl {
  /** Action name, as declared under `action_types`. */
  name: string
  /** Whether the entity must not exist yet, or must already exist. */
  use: 'create' | 'update'
  /** Object type the action writes. */
  target: string
  /** Roles permitted to invoke it. Defaults to the target type's `written_by`. */
  by: string[]
  /** Fields the caller supplies. Defaults to the target's required fields. */
  fields: string[]
}

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
  /** Declared actions that passed validation. Invalid ones are warnings, not actions. */
  actions: ActionDecl[]
  /**
   * Object type whose instances a rule is understood to be constraining, when the domain says so.
   *
   * Declared at the top level rather than repeated per type, because it is one fact about the
   * domain. What it buys is that "which products does this rule constrain" is answered from the
   * relations the domain already declares, rather than from a field name the engine would have to
   * know: the rule's constraints are its links into this type, whatever the relation is called.
   */
  situationProduct?: string
  /**
   * Which situation tag a type's state stands for: `Engagement` in `build` is `stage:delivery`.
   *
   * This is what lets an object answer "which stage is this" instead of a person answering it. The
   * engine reads "this type in this state means this tag" and never learns what a stage or a phase
   * is — the same shape as `product_type`, and for the same reason: a declaration, not a keyword.
   */
  situationStateTags?: Map<string, Map<string, string>>
  /**
   * Who may call which tool, as the domain declares it.
   *
   * The other half of a tool's governance. A capability says what its tool touches; only the
   * deployment can say who is allowed to touch it, and this is where the deployment already states
   * that kind of thing — beside `written_by`, for the same reason. A tool absent from this map is
   * one the domain said nothing about, which the guard reads differently depending on whether the
   * tool touches anything outside the domain.
   */
  toolGrants?: Map<string, string[]>
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
    const field = isMapping(decl) ? (decl as FieldDecl) : {}
    // Normalised so the write path reads one spelling, and so a field that is not a
    // counter has no increment rights to find by accident.
    const incrementBy = asStringList(field.increment_by)
    fields[name] = incrementBy === undefined ? field : { ...field, incrementBy }
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
 * Read a type's `skill` declaration: which fields carry an experience worth handing to an agent.
 *
 * Everything is required except the routing hint, and every named field must exist, because a
 * skill built from a field the type does not have would arrive empty — a declaration that cannot
 * take effect, which is the failure this project exists to catch rather than to ship.
 *
 * A type with no `default_state` is refused rather than defaulted to "every instance". The point
 * of the mechanism is that only experience somebody upheld becomes loadable, and a domain that
 * has not said which state is the vouched-for one has not answered that question. Reads ask the
 * same declaration the same thing, so what a reader is given and what the agent may load stay
 * one answer.
 */
function parseSkillDecl(
  raw: unknown,
  typeName: string,
  fields: Record<string, FieldDecl>,
  defaultState: string | undefined,
  warnings: string[],
): SkillDecl | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isMapping(raw)) {
    warnings.push(`object type "${typeName}": "skill" is not a mapping; ignored`)
    return undefined
  }

  const description = typeof raw.description === 'string' ? raw.description : ''
  const body = typeof raw.body === 'string' ? raw.body : ''
  const whenToUse = typeof raw.when_to_use === 'string' ? raw.when_to_use : ''
  const groupBy = typeof raw.group_by === 'string' ? raw.group_by : ''
  const missing = [
    description.length === 0 ? 'description' : '',
    body.length === 0 ? 'body' : '',
  ].filter((part) => part.length > 0)
  if (missing.length > 0) {
    warnings.push(
      `object type "${typeName}": "skill" declares no ${missing.join(', ')}; no skill is exposed`,
    )
    return undefined
  }

  const named = [
    description,
    body,
    ...(whenToUse.length === 0 ? [] : [whenToUse]),
    ...(groupBy.length === 0 ? [] : [groupBy]),
  ]
  const unknown = named.filter((field) => fields[field] === undefined)
  if (unknown.length > 0) {
    warnings.push(
      `object type "${typeName}": "skill" names fields ${unknown.join(', ')}, which the type does ` +
        'not declare; no skill is exposed',
    )
    return undefined
  }

  if (defaultState === undefined) {
    warnings.push(
      `object type "${typeName}": "skill" has no state to draw from — the lifecycle declares no ` +
        'default_state, so which experience has been upheld is not stated',
    )
    return undefined
  }

  return {
    description,
    body,
    ...(whenToUse.length === 0 ? {} : { whenToUse }),
    ...(groupBy.length === 0 ? {} : { groupBy }),
  }
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
    // Parsed once, so a malformed declaration warns once rather than once per use.
    const lifecycle = parseLifecycle(decl.lifecycle, name, warnings)
    const fields = asFieldMap(decl.fields)
    const { primaryKey, source } = resolvePrimaryKey(name, decl, requiredFields, warnings)
    const skill = parseSkillDecl(decl.skill, name, fields, lifecycle?.defaultState, warnings)

    objectTypes.set(name, {
      name,
      primaryKey,
      primaryKeySource: source,
      requiredFields,
      fields,
      fileLocation,
      // `file_location` names a file pattern like `objects/patterns/TP-*.yaml`;
      // its directory is what holds the instances. posix.dirname keeps this
      // deterministic regardless of the host platform, since the schema is
      // authored with forward slashes.
      directory: fileLocation.length > 0 ? posix.dirname(fileLocation) : '',
      writtenBy: asStringList(decl.written_by) ?? [],
      // Undefined here is a real answer: the type has no lifecycle, so no state is
      // enforced and nothing pretends otherwise.
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(skill === undefined ? {} : { skill }),
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

  // ── action types ────────────────────────────────────────────────────────────
  // Validated here rather than at call time, so a domain learns at load that an action
  // points at a type that does not exist, or names a field nobody declared. The rules that
  // matter are the ones this module already knows about: the target, and the fields.
  const actions: ActionDecl[] = []
  const rawActionTypes = document.action_types
  if (rawActionTypes !== undefined && !isMapping(rawActionTypes)) {
    warnings.push('"action_types" must be a mapping; ignoring it entirely')
  }
  for (const [name, declaration] of Object.entries(asFieldMap(rawActionTypes))) {
    if (!isMapping(declaration)) {
      warnings.push(`action "${name}" is not a mapping; skipped`)
      continue
    }
    const use = declaration.use
    if (use !== 'create' && use !== 'update') {
      warnings.push(
        `action "${name}" declares use "${String(use)}", which is neither create nor update; skipped`,
      )
      continue
    }
    const target = typeof declaration.target === 'string' ? declaration.target : ''
    const type = objectTypes.get(target)
    if (type === undefined) {
      warnings.push(
        `action "${name}" targets "${target || '(none)'}", which is not a declared object type; skipped`,
      )
      continue
    }

    const declaredFields = asStringList(declaration.fields) ?? []
    const declaredBy = asStringList(declaration.by) ?? []
    // Defaults that follow from the target, so a domain author writes the minimum: who may
    // write the type may invoke actions on it, and an action takes the fields a caller must
    // supply anyway.
    // Defaults differ by intent, because the intent does. A create has to supply a whole
    // valid entity, so it takes the required fields. An update changes some of them, and
    // the write path merges with what is on disk — so it offers every field and requires
    // none. Declaring `fields` explicitly overrides both.
    const fields =
      declaredFields.length > 0
        ? declaredFields
        : use === 'create'
          ? type.requiredFields.filter((field) => field !== type.primaryKey)
          : Object.keys(type.fields).filter((field) => field !== type.primaryKey)
    const by = declaredBy.length > 0 ? declaredBy : type.writtenBy

    const unknownFields = fields.filter((field) => type.fields[field] === undefined)
    if (unknownFields.length > 0) {
      warnings.push(
        `action "${name}" supplies fields ${unknownFields.join(', ')}, which "${type.name}" does not ` +
          'declare; skipped',
      )
      continue
    }
    if (fields.length === 0) {
      warnings.push(
        `action "${name}" supplies no fields: "${type.name}" declares no required fields beyond its ` +
          'identity, so the action would write nothing',
      )
    }
    if (by.length === 0) {
      warnings.push(
        `action "${name}" names no roles and its target declares no written_by, so nobody may ` +
          'invoke it',
      )
    }

    actions.push({ name, use, target, by, fields })
  }

  const version = document.version

  // Top-level `situation`: which object type carries the "what am I making" half of a situation.
  // Names a type that must exist, for the reason every other named field must: a declaration that
  // cannot take effect is the failure this project exists to catch rather than to ship.
  let situationProduct: string | undefined
  const stateTags = new Map<string, Map<string, string>>()
  const rawSituation = document.situation
  if (rawSituation !== undefined && rawSituation !== null) {
    if (!isMapping(rawSituation)) {
      warnings.push('"situation" is not a mapping; ignored')
    } else {
      const declared = rawSituation.product_type
      if (typeof declared === 'string' && declared.length > 0) {
        if (!objectTypes.has(declared)) {
          warnings.push(
            `"situation" names product_type "${declared}", which the schema does not declare; ` +
              'no situation can be computed from it',
          )
        } else {
          situationProduct = declared
        }
      }

      // `state_tags`: which state of which type stands for which situation tag. Both halves are
      // checked against declarations, because a mapping that names a type nobody declared, or a
      // state its lifecycle does not have, is a tag that can never be produced — the failure this
      // project reports rather than ships.
      const rawStateTags = rawSituation.state_tags
      if (rawStateTags !== undefined && rawStateTags !== null) {
        if (!isMapping(rawStateTags)) {
          warnings.push('"situation.state_tags" is not a mapping; ignored')
        } else {
          for (const [typeName, states] of Object.entries(rawStateTags)) {
            const type = objectTypes.get(typeName)
            if (type === undefined) {
              warnings.push(
                `"situation.state_tags" names type "${typeName}", which the schema does not ` +
                  'declare; ignored',
              )
              continue
            }
            if (!isMapping(states)) {
              warnings.push(`"situation.state_tags.${typeName}" is not a mapping; ignored`)
              continue
            }
            const declaredStates = new Set(type.lifecycle?.states ?? [])
            const mapping = new Map<string, string>()
            for (const [state, tag] of Object.entries(states)) {
              if (typeof tag !== 'string' || tag.length === 0) {
                warnings.push(
                  `"situation.state_tags.${typeName}.${state}" is not a tag; ignored`,
                )
                continue
              }
              if (!declaredStates.has(state)) {
                warnings.push(
                  `"situation.state_tags.${typeName}" names state "${state}", which that type's ` +
                    'lifecycle does not declare; ignored — no object can ever be in it',
                )
                continue
              }
              mapping.set(state, tag)
            }
            if (mapping.size > 0) {
              stateTags.set(typeName, mapping)
            }
          }
        }
      }
    }
  }

  // Top-level `tool_grants`: who may call which tool. Data rather than a constant in the guard, so
  // that changing who may run a project's tests is a domain edit rather than a release — and so the
  // policy sits where the rest of this deployment's policy sits, beside `written_by`.
  const toolGrants = new Map<string, string[]>()
  const rawGrants = document.tool_grants
  if (rawGrants !== undefined && rawGrants !== null) {
    if (!isMapping(rawGrants)) {
      warnings.push('"tool_grants" is not a mapping; ignored')
    } else {
      for (const [tool, value] of Object.entries(rawGrants)) {
        if (!Array.isArray(value) || value.some((role) => typeof role !== 'string')) {
          warnings.push(`"tool_grants" entry "${tool}" is not a list of roles; ignored`)
          continue
        }
        const roles = value.filter((role): role is string => typeof role === 'string' && role.length > 0)
        // An empty list is a decision, not an omission: it says nobody may call this, which is what
        // a tool under review should be. Kept rather than dropped, so it cannot be confused with
        // silence — the guard reads the two differently.
        toolGrants.set(tool, roles)
      }
    }
  }

  return {
    root,
    ...(typeof version === 'string' || typeof version === 'number' ? { version: String(version) } : {}),
    objectTypes,
    linkTypes,
    functions: isMapping(document.functions) ? document.functions : {},
    actionTypes: isMapping(document.action_types) ? document.action_types : {},
    actions,
    ...(situationProduct === undefined ? {} : { situationProduct }),
    ...(stateTags.size === 0 ? {} : { situationStateTags: stateTags }),
    ...(toolGrants.size === 0 ? {} : { toolGrants }),
    raw: document,
    warnings,
  }
}
