/**
 * The domain's experience, as skills an agent can load.
 *
 * A skill is know-how — how to do a thing. The ontology is know-*what*: which objects this
 * enterprise has, how they relate, and what may be done to them. The two meet here, and the
 * direction matters. The ontology does not describe skills; it decides **which** of them exist.
 *
 * The domain declares which of its fields carry an experience (`skill:` on the type), and the set
 * exposed is the set a read would return — the lifecycle's `default_state`, the one the domain
 * called vouched-for. That is the part a skill catalog cannot do on its own: a catalog offers
 * everything and lets the model choose, while this offers what somebody upheld, from the same
 * declaration that already decides what a reader is shown. One answer, asked twice.
 *
 * Two things this deliberately does not claim. It does not decide whether the agent *uses* what it
 * is handed — routing stays with the model — and it does not make any of it enforceable: a skill
 * is advice, and the guard refuses exactly the writes it refused before. What a skill cannot do
 * is grow hands. An instruction to run a regression does not survive a role that may not.
 *
 * @module @zhangcun123/ontology/skills
 */

import type { OntologyGraph, OntologyObject } from './engine/graph.ts'

/** A contribution in the shape the host's skill registry accepts. */
export interface ExperienceSkill {
  /** Kebab-case, because the registry's names are (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). */
  name: string
  description: string
  whenToUse?: string
  content: string
  source: 'runtime'
}

/** What the domain's experience became, and what it could not. */
export interface ExperienceMapping {
  skills: ExperienceSkill[]
  /**
   * Objects that are in the vouched-for state and still produced no skill, because a field the
   * declaration names is absent from the instance.
   *
   * Reported rather than skipped quietly, and kept apart from the skills for the same reason the
   * loader keeps notes apart from problems: the declaration is sound, the data has not caught up.
   */
  notes: string[]
}

/**
 * A skill name from a type name and an object id.
 *
 * Prefixed with the type even though ids are usually distinctive, because nothing makes them
 * unique across types — and a silent collision would be a skill that stops existing when
 * somebody else's data arrives.
 *
 * One limit, recorded rather than guarded: an id with no alphanumerics in it at all collapses to
 * the type name alone, so two such ids under one type would want the same name and the registry
 * keeps one. That needs a primary key like `--`, which is pathological, and refusing it would be
 * machinery for something that cannot arise in a domain anybody writes.
 */
export function toSkillName(typeName: string, id: string): string {
  return `${typeName}-${id}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A declared field's value as text, when it holds one. */
function text(object: OntologyObject, field: string): string | undefined {
  const value = object.data[field]
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * Build the skills a domain exposes.
 *
 * @param graph - A loaded domain.
 * @returns the skills, and the vouched-for objects that could not become one.
 */
export function experienceSkills(graph: OntologyGraph): ExperienceMapping {
  const skills: ExperienceSkill[] = []
  const notes: string[] = []

  for (const type of graph.schema.objectTypes.values()) {
    const declaration = type.skill
    const lifecycle = type.lifecycle
    // A type may declare `skill` and still have no state to draw from; `parseSchema` reports that
    // as a problem already, so there is nothing to say here.
    if (declaration === undefined || lifecycle?.defaultState === undefined) continue

    for (const object of graph.byType.get(type.name) ?? []) {
      const state = object.data[lifecycle.field]
      const current = typeof state === 'string' && state.length > 0 ? state : lifecycle.initial
      if (current !== lifecycle.defaultState) continue

      const description = text(object, declaration.description)
      const content = text(object, declaration.body)
      if (description === undefined || content === undefined) {
        const absent = [
          description === undefined ? declaration.description : '',
          content === undefined ? declaration.body : '',
        ]
          .filter((field) => field.length > 0)
          .join(', ')
        notes.push(
          `${type.name} ${object.id} is in "${lifecycle.defaultState}" but its ${absent} ${
            absent.includes(',') ? 'are' : 'is'
          } empty, so it exposes no skill`,
        )
        continue
      }

      const whenToUse =
        declaration.whenToUse === undefined ? undefined : text(object, declaration.whenToUse)
      skills.push({
        name: toSkillName(type.name, object.id),
        description,
        ...(whenToUse === undefined ? {} : { whenToUse }),
        content,
        source: 'runtime',
      })
    }
  }

  // Sorted, so a catalog read twice reads the same — the same reason the loader sorts directory
  // entries before reading them.
  skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { skills, notes }
}
