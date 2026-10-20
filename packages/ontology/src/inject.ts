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
 * situations it governs — `artifact:handover`, `stage:review`, `role:analyst` — and
 * the deployment states which situation it is in, so the block can say which of the rules are about
 * the work in front of the agent.
 *
 * Of those dimensions only the role decides whether a rule appears at all, and the reason is the
 * difference between declaring and inferring. A role is declared: the mode says which one it acts
 * as. A stage and a product are inferred — the session names an object, the domain maps its state
 * onto a tag, and the product is whatever the domain says that kind of thing is. An inference is
 * useful and it is sometimes wrong, so it ranks and annotates and it removes nothing: a rule the
 * situation is inferred to be about is *marked*, in place, and one it is not inferred to be about
 * is listed all the same. The single thing that keeps a rule out is declaring a role this
 * deployment is not acting as, and how many were left out that way is stated in the framing,
 * because a section that narrowed in silence would be indistinguishable from a domain with less to
 * say. A deployment that states no situation at all gets every vouched-for rule, which is the safe
 * direction to be wrong in.
 *
 * One limit, recorded rather than papered over: a situation tag that matches nothing is reported
 * rather than silently marking nothing, because from inside the block a typo and a situation no
 * rule names look identical.
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
  /** The tags the declaration routes this rule by, in declaration order. */
  tags: string[]
  /** The products this rule's declared relations name, in declaration order. */
  constrains: string[]
  /**
   * Whether the platform asserts this rule applies to the situation right now.
   *
   * Not a filter, and never a reordering: a marked rule is marked where it already sits, and
   * collected a second time into the index line the framing carries.
   */
  marked: boolean
}

/**
 * The mark in front of a rule the platform asserts applies now.
 *
 * A prefix rather than a move, because the block is read in an order that does not change with the
 * world — a reader who has learned where a rule sits must not find it somewhere else because a
 * state moved.
 */
const MARK = '▸ '

/**
 * One line of the rendered list, wrapped so it can be measured in the same form it is written.
 *
 * The line carries the tags it was declared under and what it constrains, because the block lists
 * every rule this role may follow and a reader with no way to tell which of them names the work in
 * front of it would be handed a pile rather than a rule set. Both halves are omitted when empty, so
 * a rule that declares neither renders as it always did.
 */
function lineOf(rule: InjectedRule): string {
  const declared = [
    ...(rule.tags.length === 0 ? [] : [rule.tags.join(', ')]),
    ...(rule.constrains.length === 0 ? [] : [`constrains ${rule.constrains.join(', ')}`]),
  ]
  const facts = declared.length === 0 ? '' : `   [${declared.join('; ')}]`
  return `${rule.marked ? MARK : ''}- **${rule.id}** — ${rule.rule.replace(/\s*\n\s*/g, ' ').trim()}${facts}`
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
  /** Something about the derived situation that the reader should be told. Printed, not judged. */
  trouble?: string
  /** Rules to inject, grouped and in a stable order. */
  rules: InjectedRule[]
  /** Every vouched-for rule, whatever the situation. The denominator of "how many of how many". */
  total: number
  /**
   * Rules this role may follow: every vouched-for rule except the ones that declare another role.
   *
   * The numerator the framing prints, and not the count of rules the situation "matched", which is
   * what it used to be. A rule is available because of what it declares, never because of what was
   * inferred about the work.
   */
  available: number
  /**
   * Rules left out for declaring a role this deployment is not acting as.
   *
   * Counted rather than dropped quietly, and stated in the section, because a rule left out for
   * another role and a rule the domain does not have look identical from inside the prompt. This is
   * the only reason a rule can be absent: nothing inferred from an object's state removes one.
   */
  excluded: number
  /**
   * Rules the budget kept out.
   *
   * Counted rather than dropped quietly, and reported in the section itself, because a rule left
   * out for want of room and a rule that is simply further down the list look identical from inside
   * the prompt. What is left out stays loadable by name — this narrows what is *forced* on the
   * agent, not what it may read.
   */
  dropped: number
  /** The character ceiling the section was written against, when one was declared. */
  budget?: number
  /**
   * Declared tags that no vouched-for rule mentions.
   *
   * Reported, not enforced: a domain may legitimately tag a rule with something no current
   * situation names. It is also, far more often, a typo — and a typo here is silent, because a
   * tag that matches nothing simply marks nothing.
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

/** The dimension of a tag: `stage:review` is a `stage`. */
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
   * Empty means the deployment did not say, and it costs nothing: this half keeps no rule out and
   * lets no rule in, so an unstated product marks nothing rather than marking the wrong thing.
   */
  deliverables: string[]
  /** The tag half: role, phase, and whatever else the domain tags its rules with. */
  tags: string[]
  /** Where those tags came from, when they were computed rather than declared. Printed, not judged. */
  because?: string
  /**
   * Something about this situation that the reader should not have to infer.
   *
   * Carried into the section rather than only warned about at boot, because the situation is now
   * recomputed per assembly: an object that was renamed, or a domain that became unreadable, changes
   * the answer mid-session, and a change nobody is told about is the same as a wrong answer.
   */
  trouble?: string
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

  // Which type carries "what am I making" is the domain's to say, so it is read rather than assumed.
  // A literal here would make `situation.product_type` a setting that only works for a domain that
  // happens to agree with the engine's guessed name — and would disagree quietly, because the two
  // halves of this fail differently: `selectRules` honours the declaration while this function
  // would not. Found by building an example whose product type is named something else and watching
  // half the mechanism work.
  //
  // A domain may declare no product type at all, and that is a choice rather than a mistake: with no
  // product type there is nothing for the product half to mark, and the state tags below still work.
  // So its absence skips the product half and reports nothing — the two declarations are
  // independent, and conflating them would quietly disable one to protest the other.
  const product = graph.schema.situationProduct

  if (product !== undefined && graph.byId.get(`${product}:${id}`) !== undefined) {
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

  const deliverables =
    product === undefined
      ? []
      : (graph.byType.get(product) ?? [])
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

  // Only worth saying when the domain has products to have missed. A domain that declares no product
  // type has answered this question by not asking it, and a note telling it to use a product id would
  // be advice about machinery it deliberately does not have.
  if (product !== undefined && deliverables.length === 0) {
    return {
      ...resolved,
      note:
        `"${id}" is a ${named.type}, and no ${product} in this domain says it is produced as one — ` +
        `give the session a ${product} id instead`,
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
 * One gate decides membership, and it is the only half of a situation that is *declared*: the role.
 *
 *   - a rule that declares a role tag this deployment is not acting as is left out, and counted;
 *   - a rule that declares no role tag belongs to every role, and is included — an unclassified
 *     rule must not be hidden by the absence of a classification;
 *   - a deployment that states no role at all gets everything, the direction every unstated half of
 *     a situation falls.
 *
 * Everything else a situation says ranks and annotates, and decides nothing. The products being
 * worked on and the stage they are at are *inferred* — the session names an object, the domain maps
 * its state onto a tag, and the product is whatever the domain says that kind of thing is — and an
 * inference that is sometimes wrong must not be able to remove a requirement from the block. So a
 * rule is **marked** when it constrains one of the products being worked on, or when it shares a tag
 * with the situation *other than the role's*: the platform asserting that this one applies now. A
 * rule that is not marked is listed all the same, under its own tags, for the reader to judge.
 *
 * The role is named as the exception and it is not a detail. It is the dimension spent on the gate
 * above, so consulting it again here asks a question that has already been answered — and answered
 * the same way for every rule that survived, since sharing this deployment's role is what surviving
 * meant. Counting that as a marker would mark every rule this role may follow, which is a marker
 * that distinguishes nothing, and a count that reads as "all of them" reads as no count at all. A
 * situation that states a role and nothing else therefore marks nothing, and that is the honest
 * answer rather than a shortage: there is no inferred half, so there is nothing for a marker to come
 * from. The framing has a sentence for that case rather than a count of zero, because "0 of 46" is a
 * number a reader goes looking for a mistake behind.
 *
 * The rank is what the budget spends, and it is not the marking. It counts every *dimension* of the
 * rule the situation pins down — the product as one, each tag dimension as another, the role among
 * them — so a rule written for this role is more specific than one that names nobody, and one
 * written for this product, role and phase outranks one that only names the role. A rule the
 * situation pins down in no dimension at all is the first to leave. That ordering is invisible while
 * everything fits, and it never decides the order the block is read in; see below.
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
  const situationRoles: string[] = []
  for (const tag of situation.tags) {
    const dimension = dimensionOf(tag)
    situationDimensions.set(dimension, [...(situationDimensions.get(dimension) ?? []), tag])
    if (dimension === 'role') situationRoles.push(tag)
  }

  const candidates: { rule: InjectedRule; score: number }[] = []
  let excluded = 0

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

    // The gate that survived, and the reason it is the one that did: a role is declared rather than
    // inferred. A rule that names no role is kept whatever role this is, because "nobody said which
    // role this is for" is not a claim that it is for somebody else — that silence is the case a
    // gate would hide a requirement in, and hiding requirements is what this module exists to
    // prevent.
    const declaredRoles = ruleTags.filter((tag) => dimensionOf(tag) === 'role')
    if (situationRoles.length > 0 && declaredRoles.length > 0) {
      if (!declaredRoles.some((tag) => situationRoles.includes(tag))) {
        excluded += 1
        continue
      }
    }

    const products = constrains.get(object.id) ?? []
    const productMarked =
      situation.deliverables.length > 0 &&
      products.some((id) => situation.deliverables.includes(id))

    const rule = text(object, declaration.body)
    if (rule === undefined) continue
    const group =
      declaration.groupBy === undefined ? undefined : text(object, declaration.groupBy)

    const dimensions = new Map<string, string[]>()
    for (const tag of ruleTags) {
      const dimension = dimensionOf(tag)
      dimensions.set(dimension, [...(dimensions.get(dimension) ?? []), tag])
    }
    // Every dimension of the rule the situation pins down. This is the rank the budget spends, and
    // the role counts towards it like any other — a rule written for this role is more specific
    // than one that names nobody.
    const pinned = [...dimensions].filter(([dimension, values]) =>
      (situationDimensions.get(dimension) ?? []).some((tag) => values.includes(tag)),
    )
    // And only the *inferred* dimensions may mark. The role is excluded here and not because it is
    // unimportant: it was spent deciding whether this rule is available at all, so reading it a
    // second time asks a question already answered, and every rule this role may follow answers it
    // yes — a marker on every line is a marker that says nothing, and the reader is handed a count
    // that describes listing rather than attention. What is left is the half that was inferred from
    // an object: the stage the domain read off its state, and the product the domain read off its
    // kind.
    const tagsMarked = pinned.filter(([dimension]) => dimension !== 'role').length

    candidates.push({
      rule: {
        id: object.id,
        ...(group === undefined ? {} : { group }),
        rule,
        tags: ruleTags,
        constrains: products,
        marked: tagsMarked > 0 || productMarked,
      },
      score: pinned.length + (productMarked ? 1 : 0),
    })
  }

  const available = candidates.length

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
    if (ceiling !== undefined && used + size > ceiling) continue
    kept.push(rule)
    used += size
  }

  // The pass above counted lines and not headings, so it can land a few hundred characters over
  // once the headings are in. This is where the ceiling becomes exact — and it pops from the end
  // of the ranked order, so what leaves is the least specific rule, not the alphabetically last.
  if (ceiling !== undefined) {
    while (kept.length > 0 && renderList([...kept].sort(byHeading)).length > ceiling) kept.pop()
  }

  // The ranking decided *which* rules got in; it must not decide the order they are read in, nor
  // may the marking. Sorted by heading then by id, so the same situation renders the same prompt
  // every time — the same reason the loader sorts directory entries and the catalog sorts names.
  kept.sort(byHeading)

  const unknown = situation.tags.filter((tag) => !vocabulary.has(tag))
  return {
    deliverables: [...situation.deliverables],
    tags: [...situation.tags],
    ...(situation.because === undefined ? {} : { because: situation.because }),
    ...(situation.trouble === undefined ? {} : { trouble: situation.trouble }),
    rules: kept,
    total: vouched.length,
    available,
    excluded,
    dropped: available - kept.length,
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
 * It says out loud what the one surviving gate left out, and it says out loud what a marker does
 * and does not mean. A model handed forty rules under a heading reading "the rules you must follow"
 * has no way to know forty was a selection, and would treat an omission as the domain having
 * nothing to say — so the count of rules this role may follow, and the count that declared another
 * role, are both written down. The marked rules are named in an index line of their own, and the
 * rest are stated to be requirements all the same: an earlier version of this section said the
 * unlisted rules "govern situations this deployment is not in", which was false twice over — it
 * described a filter that no longer exists, and it invited a reader to treat a rule it was not
 * shown as somebody else's problem. When nothing is marked the section says so in a sentence that
 * gives the reason instead of printing a zero, since a zero here is a number a reader stops on.
 *
 * @param selection - What {@link selectRules} returned.
 */
export function renderSection(selection: Selection): string {
  // Delimited, so a prompt can refer to this block by name.
  //
  // Nothing in the platform needs the tag — a reader finds the heading. What needs it is the other
  // half of what an agent is given: a role prompt has to be able to say "every rule in <patterns>
  // applies" without quoting an English heading that this repository may reword. The host draws the
  // same line for skill bodies (`<skill_content>`), and for the same reason: text assembled from
  // outside should have a stable name to be referred to by.
  //
  // `patterns` and not `test_patterns`: the word is the domain's own — its rules are `TestPattern`
  // instances with `pattern_id`s — but the tag lives in the platform, and a platform that names one
  // business domain in its markup is a platform that has to be reissued for the next one. A domain
  // whose rules are called something else reads the tag as "the block of reusable rules", which is
  // what it is.
  const lines: string[] = [
    '<patterns>',
    '## Rules this domain vouches for (these are requirements, not suggestions)',
    '',
    'Each entry below has been confirmed by a person and carries an id you can cite. They are',
    'requirements on your work; a deliverable that breaks one of them is not finished, whatever',
    'else is true of it. Each entry carries the tags it was declared under and the products it was',
    'written about, so you can tell which of them name the work in front of you.',
    '',
  ]

  const marked = selection.rules.filter((rule) => rule.marked)

  // Whether the situation states anything a rule could be marked by. A role is the gate; a stage and
  // a product are what a marker comes from, so a deployment that stated only a role has nothing to
  // mark with — and that is a different sentence from "the situation named things no rule is about".
  const named =
    selection.deliverables.length > 0 || selection.tags.some((tag) => dimensionOf(tag) !== 'role')

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
      // The role is the only thing that kept a rule out, so the count is stated where the rules
      // are: a reader shown five of six has to be able to see that the sixth declares somebody
      // else's role, and a reader shown six of six has to be able to see that nothing was withheld.
      `${selection.available} of the ${selection.total} vouched-for rules are available to this role` +
        (selection.excluded === 0
          ? '; none is left out for declaring a different one.'
          : `; the other ${selection.excluded} declare a different role and are not listed here.`),
      // And what the marker means, because a reader who takes "not marked" for "not for me" is the
      // reader this block exists to stop being.
      //
      // Zero markers gets its own sentence rather than a count of zero, and the two reasons it can
      // happen are kept apart. A count of zero reads as a shortfall, and a reader who was given a
      // role and nothing else would go looking for the twenty rules that were not marked when there
      // is nothing to find: no stage and no product were stated, so the situation has no inferred
      // half for a marker to come from.
      ...(marked.length === 0
        ? [
            `None of them is marked for this situation, because ${
              named
                ? 'no rule here names what this deployment is working on'
                : 'this deployment states a role and nothing else, and the role decides which rules ' +
                  'you are given rather than which of them this work is about'
            }.`,
            'Every line below is a requirement on the work it names, exactly as it would be if it',
            'carried a mark.',
          ]
        : [
            `${marked.length} of them are marked for this situation; the rest are requirements whenever`,
            'the work at hand is what they name. Not being marked means this situation is not the one',
            'the platform can see, not that the rule is optional.',
            `Marked here, in the order they are listed below: ${marked.map((rule) => rule.id).join(', ')}.`,
          ]),
    )
  }

  // Said out loud, because a rule left out for want of room and a rule that sits further down the
  // list are the same absence from inside the prompt — and because the reader of a transcript is
  // the one who has to change the number.
  if (selection.dropped > 0) {
    lines.push(
      '',
      `${selection.dropped} of the rules available here are not listed: this deployment caps the`,
      `list at ${selection.budget ?? 0} characters, and the least specific rules are the ones left`,
      'out. They are still in your skill catalog, loadable by name — nothing has been taken away',
      'from you, only moved out of the part you cannot miss.',
    )
  }

  if (selection.trouble !== undefined) {
    lines.push(
      '',
      `Note for whoever configured this deployment: ${selection.trouble}. Treat the rules below as`,
      'possibly incomplete, and tell the user rather than filling the gap yourself.',
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

  // Closed, because the block is named as a delimiter and the host closes its own (`<skill_content>`
  // is wrapped, not merely opened). An opening tag alone says where the block starts and leaves the
  // end to be inferred, which is the one question a reader of the prompt should not have to infer:
  // "the block is missing or empty" is a decision a role prompt makes about it.
  lines.push('</patterns>')

  return lines.join('\n')
}