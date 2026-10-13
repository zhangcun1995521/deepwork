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

/**
 * A declared precondition on a move: a passing verdict must exist for the subject.
 *
 * The platform owns this mechanism, the domain owns the object that carries the verdict.
 * That split is the whole point — the same three lines of YAML can require a sign-off on
 * a delivery, an approval on a contract, or a review on a piece of knowledge, and the
 * engine never learns what any of them mean.
 *
 * Independence is checked against provenance the platform recorded itself, not against a
 * field the model filled in: a reviewer that can name its own id as the producer is not a
 * control, it is a form.
 */
export interface ReviewRequirement {
  /** Object type whose instances are verdicts about the subject. */
  type: string
  /** Field on that type holding the reviewed object's id. */
  link: string
  /** Field on that type holding the verdict. */
  field: string
  /** Value of that field that means the verdict passed. */
  pass: string
}

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
  /** A passing, independently produced verdict this move requires, when it requires one. */
  review?: ReviewRequirement
}

/** A declared lifecycle, normalised. */
export interface LifecycleDecl {
  /** Field that holds the state. */
  field: string
  /** State an instance is considered to be in before anything sets the field. */
  initial: string
  /** Every declared state. */
  states: string[]
  /**
   * State a read assumes when the caller does not ask for one.
   *
   * This is how "use only what somebody vouched for" becomes the default without
   * becoming a silent filter: the read tools report how many entities they left out and
   * how to see them, the same way a capped result reports its own cap.
   */
  defaultState?: string
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
/**
 * Read a transition's `requires_review` declaration.
 *
 * All four parts are required: a requirement missing its verdict field or its passing
 * value would be a rule that can never be satisfied, and silently enforcing one of those
 * is worse than not declaring it at all — the domain would believe a control exists.
 */
function parseReviewRequirement(
  raw: unknown,
  typeName: string,
  transition: string,
  warnings: string[],
): ReviewRequirement | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isMapping(raw)) {
    warnings.push(
      `object type "${typeName}": transition "${transition}" requires_review is not a mapping; ignored`,
    )
    return undefined
  }
  const type = typeof raw.type === 'string' ? raw.type : ''
  const link = typeof raw.link === 'string' ? raw.link : ''
  const field = typeof raw.field === 'string' ? raw.field : ''
  const pass = typeof raw.pass === 'string' ? raw.pass : ''
  const missing = [
    type.length === 0 ? 'type' : '',
    link.length === 0 ? 'link' : '',
    field.length === 0 ? 'field' : '',
    pass.length === 0 ? 'pass' : '',
  ].filter((part) => part.length > 0)

  if (missing.length > 0) {
    warnings.push(
      `object type "${typeName}": transition "${transition}" requires_review declares no ` +
        `${missing.join(', ')}; the requirement is ignored and the move goes unchecked`,
    )
    return undefined
  }
  return { type, link, field, pass }
}

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
      const review = parseReviewRequirement(value.requires_review, typeName, name, warnings)
      transitions.push({
        name,
        from,
        to,
        by,
        ...(review === undefined ? {} : { review }),
      })
    }
  }

  const defaultState = typeof raw.default_state === 'string' ? raw.default_state : ''
  if (defaultState.length > 0 && !states.includes(defaultState)) {
    warnings.push(
      `object type "${typeName}": lifecycle default_state "${defaultState}" is not a declared ` +
        'state; reads will not filter by state',
    )
  }

  return {
    field,
    initial,
    states,
    transitions,
    ...(defaultState.length > 0 && states.includes(defaultState) ? { defaultState } : {}),
  }
}
