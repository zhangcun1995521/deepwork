/**
 * The domain's vouched-for experience, written into the prompt instead of offered to the model.
 *
 * This is the half a skill catalog cannot do. A catalog is a list of names the model has to
 * remember to consult; a section of the system prompt is in front of it whether it thought to
 * look or not. For know-how the difference is a matter of taste — the model can be trusted to
 * reach for a procedure. For *rules* it is the whole question: a rule the model may load is a
 * rule it may miss, and "the codebase must use `Decimal` for money" is not advice.
 *
 * What makes it more than a hard-coded block is `applies_to`. The domain tags each rule with the
 * situations it governs — `artifact:handover`, `stage:review`, `role:checker` — and
 * the deployment states which situation it is in. So the answer to "what must I follow" is
 * computed from the world rather than chosen by the model, and it changes when the world does.
 * A deployment that states no situation is not left with nothing: it gets every vouched-for rule,
 * which is the safe direction to be wrong in.
 *
 * Two limits, recorded rather than papered over. The listing is built once, at load, so a rule
 * promoted mid-process is not in it until the next boot — the same limit the skill catalog has,
 * for the same reason (promotion is the rare event). And a situation tag that matches nothing is
 * reported rather than silently yielding an empty section, because a typo in a deployment's
 * config must not be able to delete the rules it was meant to select.
 *
 * @module @zhangcun123/ontology/inject
 */

import type { OntologyGraph, OntologyObject } from './engine/graph.ts'
import { text, vouchedInstances } from './skills.ts'

/** One rule, as the prompt will carry it. */
export interface InjectedRule {
  /** The instance's id, kept so the model can name the rule it is following. */
  id: string
  /** Heading it is filed under, when the declaration names a grouping field. */
  group?: string
  /** The rule itself. */
  rule: string
}

/** One line of the rendered list, wrapped so it can be measured in the same form it is written. */
function lineOf(rule: InjectedRule): string {
  return `- **${rule.id}** — ${rule.rule.replace(/\s*\n\s*/g, ' ').trim()}`
}

/** The heading a rule is filed under. */
function headingOf(rule: InjectedRule): string {
  return rule.group ?? 'Uncategorised'
}

/**
 * The listed rules alone, without the framing around them.
 *
 * Extracted because the budget measures this and {@link renderSection} writes it: a budget that
 * measured something adjacent to what gets written would be a number nobody could check.
 */
function renderList(rules: readonly InjectedRule[]): string {
  const lines: string[] = []
  let current: string | undefined
  let started = false
  for (const rule of rules) {
    // Grouped, because a flat run of forty rules is a list nobody follows. A rule with no declared
    // heading goes under one of its own rather than being folded into a group it was never filed
    // under — which is why the first heading is emitted whatever it turns out to be.
    if (!started || rule.group !== current) {
      started = true
      current = rule.group
      lines.push('', `### ${headingOf(rule)}`)
    }
    lines.push(lineOf(rule))
  }
  return lines.join('\n')
}

/** What the situation selected, and what a reader should be told about the selection. */
export interface Selection {
  /** The products being worked on, as `Deliverable` ids, in declaration order. */
  deliverables: string[]
  /** The tag half of the situation, in declaration order. */
  tags: string[]
  /**
   * Where the situation came from, when it was computed rather than declared.
   *
   * Carried through to the section for the reason the section states what it left out: a wrong
   * answer has to be checkable from the prompt, and a tag derived from an object's state carries no
   * record of that state unless it is written down beside it.
   */
  because?: string
  /** Rules to inject, grouped and in a stable order. */
  rules: InjectedRule[]
  /** Every vouched-for rule, whatever the situation. The denominator of "how many of how many". */
  total: number
  /** How many rules the situation matched, before any budget was applied. */
  matched: number
  /**
   * Rules the budget kept out.
   *
   * Counted rather than dropped quietly, and reported in the section itself, because a rule left
   * out for want of room and a rule that does not apply look identical from inside the prompt.
   * What is left out stays loadable by name — this narrows what is *forced* on the agent, not
   * what it may read.
   */
  dropped: number
  /** The character ceiling the section was written against, when one was declared. */
  budget?: number
  /**
   * Declared tags that no vouched-for rule mentions.
   *
   * Reported, not enforced: a domain may legitimately tag a rule with something no current
   * situation names. It is also, far more often, a typo — and a typo here is silent, because a
   * tag that matches nothing simply selects nothing.
   */
  unknown: string[]
}

/** Options for one selection. */
export interface SelectOptions {
  /**
   * Ceiling on the listed rules, in characters.
   *
   * A backstop, not a target. It exists because a domain grows and a prompt does not, so the day
   * a deployment's domain outgrows its context this has to already be in place rather than
   * discovered. Below it nothing changes; above it the least specific rules are the ones left out.
   *
   * It measures the list and not the section around it, deliberately. Counting the framing would
   * make the note that reports what was left out itself compete for room with the rules it
   * describes — and at a small enough ceiling the two would drive each other to nothing, which is
   * a budget that deletes rules in order to explain that it deleted rules.
   */
  budget?: number
}

/** The dimension of a tag: `stage:review` is a `phase`. */
function dimensionOf(tag: string): string {
  const at = tag.indexOf(':')
  return at === -1 ? tag : tag.slice(0, at)
}

/**
 * Read a declared situation's tag half.
 *
 * Comma-separated `key:value` tags rather than JSON, because that is the grammar the domain
 * already tags its rules with, and because a config that has to survive a shell does not need
 * another quoting rule to get wrong.
 */
export function parseSituation(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const tag = part.trim()
    if (tag.length > 0) seen.add(tag)
  }
  return [...seen]
}

/** What a deployment says it is doing, and what it is doing it to. */
export interface Situation {
  /**
   * The products being worked on, as `Deliverable` ids.
   *
   * Empty means the deployment did not say, and the product gate opens rather than closing on
   * everything — the same direction every other unstated half of a situation falls.
   */
  deliverables: string[]
  /** The tag half: role, phase, and whatever else the domain tags its rules with. */
  tags: string[]
  /** Where those tags came from, when they were computed rather than declared. Printed, not judged. */
  because?: string
}

/** What resolving a named thing produced, and what to tell whoever named it. */
export interface ActiveResolution {
  /** Products the named thing is, as `Deliverable` ids. */
  deliverables: string[]
  /**
   * Situation tags the named thing's own state stands for.
   *
   * The half a person used to write by hand. The domain declares which state of which type means
   * which tag, so a state is asked of the object rather than remembered by whoever starts the
   * session — and the tag that used to be the easiest thing to get wrong in silence is now a fact.
   */
  tags: string[]
  /**
   * Where those tags came from, for the section to print.
   *
   * Written out because an automatically derived situation has no other way to be checked. A
   * person who typed a tag can see it in the prompt; a tag computed from a state has to carry the
   * state with it, or a wrong answer looks exactly like a right one.
   */
  because?: string
  /**
   * Why nothing was resolved, when nothing was.
   *
   * Reported rather than defaulted, because an id that matches no object and an id that matches an
   * object no product covers select the same empty set — and only one of them is a mistake.
   */
  note?: string
}

/**
 * Resolve what a session says it is working on into the products it is working on, and the stage
 * that thing is at.
 *
 * Two ways to name it, because a product does not always have an object behind it. A deliverable
 * id names the product directly — a generated report never enters the ontology, since the domain
 * stores a pointer rather than a copy, so there is no object to point at, and no state either. An
 * object id names the thing, and both halves are read off it: the product is whatever the domain
 * says that kind of thing is (`produced_as`), and the tags are whatever the domain says that
 * state means (`state_tags`).
 *
 * This is the whole of v2. The situation used to be a string a person wrote, which meant a person
 * had to remember the domain's tag vocabulary and got silence when they got it wrong. Naming the
 * object is something they can see and copy, and the tags are computed from it.
 */
export function resolveActive(graph: OntologyGraph, activeId: string): ActiveResolution {
  const id = activeId.trim()
  if (id.length === 0) return { deliverables: [], tags: [] }

  if (graph.byId.get(`Deliverable:${id}`) !== undefined) {
    // A product with no object behind it has no state, so it contributes no tag. Said rather than
    // guessed: inventing a stage for it would be the person-typed guess this replaces.
    return { deliverables: [id], tags: [] }
  }

  // An object id is bare, and `byId` is keyed by `${type}:${id}`, so the type has to be found
  // rather than assumed — the same reason the skill catalog derives its names instead of trusting
  // an id to be unique across types.
  const named = graph.objects.find((candidate) => candidate.id === id)
  if (named === undefined) {
    return { deliverables: [], tags: [], note: `nothing in this domain is identified as "${id}"` }
  }

  const state = stateOf(graph, named)
  const tag = state === undefined ? undefined : graph.schema.situationStateTags?.get(named.type)?.get(state)

  const deliverables = (graph.byType.get('Deliverable') ?? [])
    .filter((deliverable) => deliverable.data.produced_as === named.type)
    .map((deliverable) => deliverable.id)

  const resolved: ActiveResolution = {
    deliverables,
    tags: tag === undefined ? [] : [tag],
    ...(state === undefined
      ? {}
      : {
          because:
            `${named.type} ${named.id} is ${state}` +
            (tag === undefined ? ', which this domain maps to no tag' : `, which this domain maps to ${tag}`),
        }),
  }

  if (deliverables.length === 0) {
    return {
      ...resolved,
      note:
        `"${id}" is a ${named.type}, and no product in this domain says it is produced as one — ` +
        'give the session a product id from objects/deliverables instead',
    }
  }
  return resolved
}

/** The state an instance is in, from its type's lifecycle declaration. */
function stateOf(graph: OntologyGraph, object: OntologyObject): string | undefined {
  const lifecycle = graph.schema.objectTypes.get(object.type)?.lifecycle
  if (lifecycle === undefined) return undefined
  const value = object.data[lifecycle.field]
  return typeof value === 'string' && value.length > 0 ? value : lifecycle.initial
}

/** The routing tags an instance carries, when its declaration names the field and it holds any. */
function tagsOf(declaration: { whenToUse?: string }, data: Record<string, unknown>): string[] {
  const field = declaration.whenToUse
  if (field === undefined) return []
  const value = data[field]
  // One tag or several. The routing dimension is naturally a set, but a domain whose rules each
  // name a single situation declares a plain string, and reading only the list shape would make
  // every rule in that domain match nothing — the silent empty selection this module reports on.
  if (typeof value === 'string') return value.trim().length > 0 ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * Select the rules a situation governs.
 *
 * A rule applies when it clears two gates, each of which opens rather than closes on what its
 * side did not state:
 *
 *   - **the product gate** — the rule constrains one of the products being worked on, or it
 *     constrains nothing in particular and so applies whatever is being made. "Money is compared as
 *     integers" is not about any one deliverable and must survive naming one.
 *   - **the tag gate** — the rule shares any one tag with the situation, or it declares none.
 *
 * Requiring every tag to match instead would hide a rule from a deployment that could state only
 * one of them, and hidden is the failure this whole module exists to prevent. Two gates rather
 * than one long tag list, because a product is a *thing* and a tag is a word: the first is
 * queryable in both directions — ask the ontology which rules govern the case you are writing —
 * and the second is a vocabulary two sides have to agree on.
 *
 * What the gates do *not* do is rank. Nearly every rule carries a role tag, so a three-tag
 * situation matches most of the domain, and at scale "matches" stops meaning anything. The rank is
 * how many *dimensions* of the rule the situation actually pins down — the product counts as one,
 * each tag dimension as another — so a rule written for this product, role and phase outranks one
 * that only names the role. That ordering is invisible while everything fits, and decides who gets
 * in once the budget binds.
 *
 * @param graph - A loaded domain.
 * @param situation - What the deployment says it is doing, and to what.
 * @param options - The ceiling to write against, when one is declared.
 */
export function selectRules(
  graph: OntologyGraph,
  situation: Situation,
  options: SelectOptions = {},
): Selection {
  const vouched = vouchedInstances(graph)
  const vocabulary = new Set<string>()
  const situationDimensions = new Map<string, string[]>()
  for (const tag of situation.tags) {
    const dimension = dimensionOf(tag)
    situationDimensions.set(dimension, [...(situationDimensions.get(dimension) ?? []), tag])
  }

  const candidates: { rule: InjectedRule; score: number }[] = []

  // What each rule constrains, read off the relations the domain declares rather than off a field
  // name the engine would have to know. A domain that renames `constrains` to `governs` needs no
  // change here; one that points that relation elsewhere changes what it means, which is the point.
  const product = graph.schema.situationProduct
  const constrains = new Map<string, string[]>()
  if (product !== undefined) {
    for (const link of graph.links) {
      if (link.toType !== product) continue
      constrains.set(link.from, [...(constrains.get(link.from) ?? []), link.to])
    }
  }

  for (const { declaration, object } of vouched) {
    const ruleTags = tagsOf(declaration, object.data)
    for (const tag of ruleTags) vocabulary.add(tag)

    const products = constrains.get(object.id) ?? []
    const productPinned =
      situation.deliverables.length > 0 &&
      products.some((id) => situation.deliverables.includes(id))
    // A rule that constrains nothing applies whatever is being made — "money is compared as
    // integers" is not about any one product, and naming a product must not hide it.
    if (situation.deliverables.length > 0 && products.length > 0 && !productPinned) continue
    if (
      situation.tags.length > 0 &&
      ruleTags.length > 0 &&
      !ruleTags.some((tag) => situation.tags.includes(tag))
    ) {
      continue
    }

    const rule = text(object, declaration.body)
    if (rule === undefined) continue
    const group =
      declaration.groupBy === undefined ? undefined : text(object, declaration.groupBy)

    const dimensions = new Map<string, string[]>()
    for (const tag of ruleTags) {
      const dimension = dimensionOf(tag)
      dimensions.set(dimension, [...(dimensions.get(dimension) ?? []), tag])
    }
    const tagsMatched = [...dimensions].filter(([dimension, values]) =>
      (situationDimensions.get(dimension) ?? []).some((tag) => values.includes(tag)),
    ).length

    candidates.push({
      rule: { id: object.id, ...(group === undefined ? {} : { group }), rule },
      score: tagsMatched + (productPinned ? 1 : 0),
    })
  }

  const matched = candidates.length

  // Most specific first, so that when room runs out what is left out is the most general advice
  // rather than whichever rule happened to be read last.
  candidates.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    return left.rule.id < right.rule.id ? -1 : left.rule.id > right.rule.id ? 1 : 0
  })

  const ceiling = options.budget
  const byHeading = (left: InjectedRule, right: InjectedRule): number => {
    const leftGroup = left.group ?? ''
    const rightGroup = right.group ?? ''
    if (leftGroup !== rightGroup) return leftGroup < rightGroup ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  }

  const kept: InjectedRule[] = []
  let used = 0
  for (const { rule } of candidates) {
    const size = lineOf(rule).length + 1
    if (ceiling !== undefined && used + size > ceiling) break
    kept.push(rule)
    used += size
  }

  // The pass above counted lines and not headings, so it can land a few hundred characters over
  // once the headings are in. This is where the ceiling becomes exact — and it pops from the end
  // of the ranked order, so what leaves is the least specific rule, not the alphabetically last.
  if (ceiling !== undefined) {
    while (kept.length > 0 && renderList([...kept].sort(byHeading)).length > ceiling) kept.pop()
  }

  // Ranking decided *which* rules got in; it must not decide the order they are read in. Sorted by
  // heading then by id, so the same situation renders the same prompt every time — the same reason
  // the loader sorts directory entries and the catalog sorts names.
  kept.sort(byHeading)

  const unknown = situation.tags.filter((tag) => !vocabulary.has(tag))
  return {
    deliverables: [...situation.deliverables],
    tags: [...situation.tags],
    ...(situation.because === undefined ? {} : { because: situation.because }),
    rules: kept,
    total: vouched.length,
    matched,
    dropped: matched - kept.length,
    ...(ceiling === undefined ? {} : { budget: ceiling }),
    unknown,
  }
}

/**
 * Render a selection as the prompt section.
 *
 * The framing is in English and the rules are in whatever language the domain wrote them in, for
 * the same reason the loader's notes are: the machinery has one voice and the data keeps its own.
 *
 * It says out loud that the list is filtered. A model handed forty rules under a heading reading
 * "the rules you must follow" has no way to know forty was a selection, and would treat an
 * omission as the domain having nothing to say — which is exactly the failure mode this module
 * reports on rather than hides.
 *
 * @param selection - What {@link selectRules} returned.
 */
export function renderSection(selection: Selection): string {
  const lines: string[] = [
    '## Rules this domain vouches for (these are requirements, not suggestions)',
    '',
    'Each entry below has been confirmed by a person and carries an id you can cite. They are',
    'requirements on your work in the situation described here; a deliverable that breaks one of',
    'them is not finished, whatever else is true of it.',
    '',
  ]

  if (selection.deliverables.length === 0 && selection.tags.length === 0) {
    lines.push(
      `No situation was declared for this deployment, so every rule the domain vouches for is`,
      `listed: ${selection.total} in all.`,
    )
  } else {
    // The product is named first, because it is the half a reader can check: the tags were derived
    // from it, and a wrong product explains a wrong tag where a wrong tag explains nothing.
    const working =
      selection.deliverables.length === 0
        ? 'Situation'
        : `Working on ${selection.deliverables.join(', ')}`
    const tags = selection.tags.length === 0 ? '' : `; ${selection.tags.join(', ')}`
    lines.push(
      `${working}${tags}.`,
      ...(selection.because === undefined ? [] : [`Situation computed from: ${selection.because}.`]),
      `${selection.matched} of the ${selection.total} vouched-for rules apply here; the rest`,
      'govern situations this deployment is not in, and are not withheld from you for any other',
      'reason.',
    )
  }

  // Said out loud, because a rule left out for want of room and a rule that does not apply are
  // the same absence from inside the prompt — and because the reader of a transcript is the one
  // who has to change the number.
  if (selection.dropped > 0) {
    lines.push(
      '',
      `${selection.dropped} of the rules that apply here are not listed: this deployment caps the`,
      `list at ${selection.budget ?? 0} characters, and the least specific rules are the ones left`,
      'out. They are still in your skill catalog, loadable by name — nothing has been taken away',
      'from you, only moved out of the part you cannot miss.',
    )
  }

  if (selection.unknown.length > 0) {
    lines.push(
      '',
      `Note for whoever configured this deployment: the tag(s) ${selection.unknown.join(', ')} ` +
        `match nothing in this domain, which is almost always a spelling mistake.`,
    )
  }

  const list = renderList(selection.rules)
  if (list.length > 0) lines.push(list)

  return lines.join('\n')
}