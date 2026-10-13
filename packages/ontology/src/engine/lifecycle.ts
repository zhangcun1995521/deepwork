/**
 * A declared lifecycle: which states an object may be in, and who may move it between
 * them.
 *
 * Knowledge that accumulates is knowledge somebody vouched for. The reference
 * implementation kept that idea in code — a `candidate`/`verified` pair wired into its
 * own actions, with a promotion path that wrote the file directly and bypassed its own
 * permission layer. Declaring it in the schema instead means a new lifecycle costs
 * YAML, the promotion is a normal write that the ACL and the audit already cover, and
 * "who may verify this" is answerable from the domain rather than from the code.
 *
 * @module @zhangcun123/ontology/engine/lifecycle
 */

/** One declared move between states. */
export interface TransitionDecl {
  /** Transition name, as declared under `transitions`. */
  name: string
  /** States this move may start from. */
  from: string[]
  /** State this move ends in. */
  to: string
  /** Roles permitted to perform it. */
  by: string[]
}

/** A declared lifecycle, normalised. */
export interface LifecycleDecl {
  /** Field that holds the state. */
  field: string
  /** State an instance is considered to be in before anything sets the field. */
  initial: string
  /** Every declared state. */
  states: string[]
  /** Declared moves, in declaration order. */
  transitions: TransitionDecl[]
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * Read a type's `lifecycle` declaration.
 *
 * Malformed pieces are reported and dropped rather than thrown on: a domain with a
 * broken lifecycle still has instances worth loading, and the warning says exactly
 * which part was ignored. A lifecycle that cannot be understood is left undefined,
 * which means writes to that type behave as they did before — no enforcement, and no
 * pretence of it.
 */
export function parseLifecycle(
  raw: unknown,
  typeName: string,
  warnings: string[],
): LifecycleDecl | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isMapping(raw)) {
    warnings.push(`object type "${typeName}": "lifecycle" is not a mapping; ignoring it`)
    return undefined
  }

  const field = typeof raw.field === 'string' ? raw.field : ''
  if (field.length === 0) {
    warnings.push(`object type "${typeName}": lifecycle declares no field; ignoring it`)
    return undefined
  }

  const states = stringList(raw.states) ?? []
  if (states.length === 0) {
    warnings.push(`object type "${typeName}": lifecycle declares no states; ignoring it`)
    return undefined
  }

  const initial = typeof raw.initial === 'string' ? raw.initial : ''
  if (initial.length === 0 || !states.includes(initial)) {
    warnings.push(
      `object type "${typeName}": lifecycle initial state "${initial || '(none)'}" is not one of ` +
        `[${states.join(', ')}]; lifecycle ignored`,
    )
    return undefined
  }

  const transitions: TransitionDecl[] = []
  const declared = raw.transitions
  if (declared !== undefined && !isMapping(declared)) {
    warnings.push(`object type "${typeName}": lifecycle transitions are not a mapping; ignoring them`)
  } else if (isMapping(declared)) {
    for (const [name, value] of Object.entries(declared)) {
      if (!isMapping(value)) {
        warnings.push(`object type "${typeName}": transition "${name}" is not a mapping; skipped`)
        continue
      }
      const to = typeof value.to === 'string' ? value.to : ''
      const from = stringList(value.from) ?? []
      const by = stringList(value.by) ?? []

      if (to.length === 0 || !states.includes(to)) {
        warnings.push(
          `object type "${typeName}": transition "${name}" targets "${to || '(none)'}", ` +
            `which is not a declared state; skipped`,
        )
        continue
      }
      const unknownFrom = from.filter((state) => !states.includes(state))
      if (from.length === 0 || unknownFrom.length > 0) {
        warnings.push(
          `object type "${typeName}": transition "${name}" starts from ` +
            `${from.length === 0 ? 'nothing' : unknownFrom.join(', ')}, which are not declared ` +
            'states; skipped',
        )
        continue
      }
      if (by.length === 0) {
        // Not dropped: the transition is real, it simply cannot be performed. Saying so
        // is more useful than making it disappear, because a reader can see what is
        // missing rather than wonder where the move went.
        warnings.push(
          `object type "${typeName}": transition "${name}" names no roles, so nobody may perform it`,
        )
      }
      transitions.push({ name, from, to, by })
    }
  }

  return { field, initial, states, transitions }
}
