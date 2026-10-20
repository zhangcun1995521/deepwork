/**
 * Tests for writing a domain's vouched-for rules into the prompt.
 *
 * The claims pinned here are the three that separate this from a skill catalog. A rule that is not
 * vouched for is in neither surface — the injected listing is not a bypass of the lifecycle. The
 * block lists every rule the deployment's role may follow, so nothing is missing from it. And what
 * the situation does is mark and order: the rules it is inferred to be about are marked, and a
 * wrong inference cannot take a requirement away.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph } from './engine/graph.ts'
import { parseSituation, renderSection, resolveActive, selectRules } from './inject.ts'

const example = (name: string): string =>
  fileURLToPath(new URL(`../examples/${name}`, import.meta.url))

/** A situation that names no product, for the tests about the tag half alone. */
const situation = (tags: string[]): { deliverables: string[]; tags: string[] } => ({
  deliverables: [],
  tags,
})

/**
 * A copy of the `lessons` example carrying a second vouched-for rule.
 *
 * Two rules is the smallest domain in which "the situation selected something" and "the
 * situation selected the other thing" are different answers, and copied rather than committed so
 * the example itself stays the minimal one a reader meets first.
 */
function twoRules(t: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'deepwork-inject-'))
  cpSync(example('lessons'), root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(
    join(root, 'objects', 'lessons', 'LES-004.yaml'),
    [
      'lesson_id: LES-004',
      'status: verified',
      'kind: money',
      'rule: >-',
      '  Compare money as integers in the smallest unit; a float equals nothing exactly.',
      'applies_to: [phase:billing, artifact:invoice]',
      'source_kind: review',
      'source_ref: REV-2026-0501',
      'applied_count: 0',
      '',
    ].join('\n'),
  )
  return root
}

test('a situation marks the rules it governs, and the block lists every one of them', (t) => {
  const graph = loadGraph(twoRules(t))
  const selection = selectRules(graph, situation(['artifact:pull_request']))
  const { rules, total, unknown } = selection

  assert.deepEqual(
    rules.map((rule) => rule.id),
    ['LES-004', 'LES-001'],
    'one tag naming one rule does not take the other out of the block',
  )
  assert.deepEqual(
    rules.filter((rule) => rule.marked).map((rule) => rule.id),
    ['LES-001'],
  )
  assert.equal(total, 2, 'the denominator counts every vouched-for rule, not the marked ones')
  assert.equal(selection.available, 2, 'and every one of them is available to this role')
  assert.deepEqual(unknown, [])
})

test('the same domain under another situation marks another set, and lists the same one', (t) => {
  const graph = loadGraph(twoRules(t))

  const billing = selectRules(graph, situation(['phase:billing']))
  const review = selectRules(graph, situation(['artifact:pull_request']))

  const ids = (selection: typeof billing): string[] => selection.rules.map((rule) => rule.id)
  const marked = (selection: typeof billing): string[] =>
    selection.rules.filter((rule) => rule.marked).map((rule) => rule.id)

  assert.deepEqual(marked(billing), ['LES-004'])
  assert.deepEqual(marked(review), ['LES-001'])
  assert.deepEqual(ids(billing), ids(review), 'what is listed is what this role may follow, not what matched')
})

test('a rule is marked when any one of its tags matches', (t) => {
  // Requiring every tag to match would mark nothing for a deployment that could state only one of
  // them, and marking nothing is the failure this module exists to prevent.
  const graph = loadGraph(twoRules(t))
  const selection = selectRules(graph, situation(['phase:billing', 'role:nobody']))

  assert.deepEqual(
    selection.rules.filter((rule) => rule.marked).map((rule) => rule.id),
    ['LES-004'],
  )
})

test('no declared situation means every vouched-for rule, never none', (t) => {
  const graph = loadGraph(twoRules(t))
  const selection = selectRules(graph, situation([]))
  const { rules, total, tags } = selection

  assert.equal(rules.length, total)
  assert.equal(selection.available, total)
  assert.equal(selection.excluded, 0)
  assert.equal(selection.dropped, 0, 'no budget, so nothing is left out')
  assert.equal(selection.budget, undefined)
  // Heading order, not id order: a selection renders in the order it will be read, and `money`
  // sorts before `review_discipline`.
  assert.deepEqual(
    rules.map((rule) => rule.id),
    ['LES-004', 'LES-001'],
  )
  assert.deepEqual(tags, [])

  const rendered = renderSection(selection)
  assert.match(rendered, /No situation was declared/)
  assert.match(rendered, /LES-001/)
  assert.match(rendered, /LES-004/)
  assert.doesNotMatch(rendered, /not listed here/, 'nothing was left out, so nothing says it was')
})

test('a candidate is in neither answer, so the injection is not a bypass', (t) => {
  const graph = loadGraph(twoRules(t))
  const rendered = renderSection(selectRules(graph, situation([])))

  assert.doesNotMatch(rendered, /LES-002/, 'a candidate is not vouched for')
  assert.doesNotMatch(rendered, /LES-003/, 'a rejected lesson is not vouched for')
})

test('a tag that matches nothing is reported, because a typo marks nothing in silence', (t) => {
  const graph = loadGraph(twoRules(t))
  const selection = selectRules(graph, situation(['phase:biling']))

  assert.deepEqual(selection.unknown, ['phase:biling'])
  assert.equal(selection.available, 2, 'the typo cannot delete a rule — nothing infers membership')
  assert.equal(selection.dropped, 0, 'nothing was left out for want of room either')
  assert.equal(
    selection.rules.filter((rule) => rule.marked).length,
    0,
    'what the typo cost is the marking, which is why the typo has to be said out loud',
  )

  assert.match(renderSection(selection), /match nothing in this domain/)
})

test('rules are grouped under the heading the declaration names, in a stable order', (t) => {
  const graph = loadGraph(twoRules(t))
  const rendered = renderSection(selectRules(graph, situation([])))

  // Alphabetical by heading, `money` after `review_discipline`, and the heading comes before the
  // rule it files.
  assert.match(rendered, /### money\n- \*\*LES-004\*\*/)
  assert.match(rendered, /### review_discipline\n- \*\*LES-001\*\*/)
  assert.ok(
    rendered.indexOf('### money') < rendered.indexOf('### review_discipline'),
    'headings sort, so the same selection renders the same prompt every turn',
  )
})

test('a situation is read as the tags the domain already uses', () => {
  // Comma-separated `key:value`, which is the grammar of the tags themselves — a config that has
  // to survive a shell does not need another quoting rule to get wrong.
  assert.deepEqual(parseSituation(' phase:billing , artifact:pull_request '), [
    'phase:billing',
    'artifact:pull_request',
  ])
  assert.deepEqual(parseSituation(''), [])
  assert.deepEqual(parseSituation(' , '), [])
  assert.deepEqual(parseSituation('phase:a,phase:a'), ['phase:a'], 'a repeat is one tag')
})

test('a multi-line rule is one line in the prompt', (t) => {
  // A rule written as a folded YAML block arrives with its newlines intact; broken across lines
  // inside a bullet it would read as several rules, and the count in the framing would be wrong.
  const graph = loadGraph(twoRules(t))
  const rendered = renderSection(selectRules(graph, situation(['artifact:pull_request'])))

  assert.match(rendered, /- \*\*LES-001\*\* — An interface change and the tests that cover it belong in the same change; split across two, the second one is what gets dropped when the first is abandoned\./)
})

test('a budget that binds keeps the most specific rules', (t) => {
  // Both rules are in the block, and the ranking that decides which one survives the ceiling is how
  // many of its dimensions the situation pins down. LES-004 pins two and LES-001 one, so with room
  // for one rule the specific one stays.
  const graph = loadGraph(twoRules(t))
  const situation = { deliverables: [], tags: ['artifact:pull_request', 'phase:billing', 'artifact:invoice'] }

  assert.deepEqual(
    selectRules(graph, situation).rules.map((rule) => rule.id).sort(),
    ['LES-001', 'LES-004'],
    'both are available, so nothing but the budget is doing the selecting',
  )

  const tight = selectRules(graph, situation, { budget: 200 })
  assert.deepEqual(
    tight.rules.map((rule) => rule.id),
    ['LES-004'],
  )
  assert.equal(tight.available, 2)
  assert.equal(tight.dropped, 1)
  assert.equal(tight.budget, 200)

  // The same situation with room to spare, so the loss is the budget's and not the ranking's.
  assert.equal(selectRules(graph, situation, { budget: 1000 }).rules.length, 2)
})

test('what the budget left out is stated, not implied by a smaller number', (t) => {
  const graph = loadGraph(twoRules(t))
  const rendered = renderSection(
    selectRules(graph, situation(['artifact:pull_request', 'phase:billing', 'artifact:invoice']), {
      budget: 200,
    }),
  )

  assert.match(rendered, /1 of the rules available here are not listed/)
  assert.match(rendered, /caps the\n?list at 200 characters/)
  // And where they still are, because "left out" must not read as "gone".
  assert.match(rendered, /still in your skill catalog, loadable by name/)
})

test('nothing is said about a budget that never bound', (t) => {
  const graph = loadGraph(twoRules(t))
  const rendered = renderSection(selectRules(graph, situation([]), { budget: 100_000 }))

  assert.doesNotMatch(rendered, /not listed/)
  assert.doesNotMatch(rendered, /caps the/)
})

test('a budget that never binds changes nothing about what is injected', (t) => {
  const graph = loadGraph(twoRules(t))
  const generous = selectRules(graph, situation([]), { budget: 100_000 })

  assert.deepEqual(
    generous.rules.map((rule) => rule.id),
    selectRules(graph, situation([])).rules.map((rule) => rule.id),
  )
  assert.equal(generous.dropped, 0)
})

test('a type that declares no grouping field still renders, under one heading', (t) => {
  const root = twoRules(t)
  const schema = join(root, 'schema.yaml')
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8').replace(/^ *group_by: kind\n/m, ''),
  )

  const rendered = renderSection(selectRules(loadGraph(root), situation([])))
  assert.match(rendered, /### Uncategorised/)
  assert.match(rendered, /LES-001/)
  assert.match(rendered, /LES-004/)
})

/**
 * The same two rules, in a domain that also says what a rule constrains.
 *
 * Which products exist, and which rule constrains which, is the half of a situation a person can
 * name — so it needs a domain where naming one is possible at all. Appended to `twoRules` rather
 * than committed as a fourth example, because the example a reader meets first should stay the
 * smallest one that shows the declaration.
 */
function productRules(t: { after(callback: () => void): void }): string {
  const root = twoRules(t)

  const schema = join(root, 'schema.yaml')
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8').replace(
      /^object_types:/m,
      [
        'situation:',
        '  product_type: Deliverable',
        '',
        'object_types:',
        '  Deliverable:',
        '    primary_key: deliverable_id',
        '    required_fields: [deliverable_id, name]',
        '    file_location: objects/deliverables/DLV-*.yaml',
        '    written_by: [curator]',
        '    fields:',
        '      deliverable_id: { type: string }',
        '      name: { type: string }',
        '      produced_as: { type: string }      # which object type carries this product',
        '  Widget:',
        '    primary_key: widget_id',
        '    required_fields: [widget_id]',
        '    file_location: objects/widgets/W-*.yaml',
        '    written_by: [curator]',
        '    fields:',
        '      widget_id: { type: string }',
      ].join('\n'),
    ),
  )
  // The rule's constraint is a declared relation, so the engine reads it off the edges rather than
  // off a field name it would have to know.
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8')
      .replace(/^      applies_to: \{ type: string \}$/m, '      applies_to: { type: string }\n      constrains: { type: "list[string]" }')
      .replace(/^link_types:$/m, 'link_types:\n  constrains:\n    from: Lesson\n    to: Deliverable'),
  )

  writeFileSync(
    join(root, 'objects', 'lessons', 'LES-001.yaml'),
    readFileSync(join(root, 'objects', 'lessons', 'LES-001.yaml'), 'utf-8') +
      'constrains: [DLV-GADGET]\n',
  )

  const dir = join(root, 'objects', 'deliverables')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'DLV-GADGET.yaml'),
    'deliverable_id: DLV-GADGET\nname: The gadget under test\nproduced_as: Widget\n',
  )
  const widgets = join(root, 'objects', 'widgets')
  mkdirSync(widgets, { recursive: true })
  writeFileSync(join(widgets, 'W-1.yaml'), 'widget_id: W-1\n')

  return root
}

/**
 * The same two rules, plus one per role, in a domain where a rule can say who it is for.
 *
 * The role is the only half of a situation that is declared rather than inferred, so testing it
 * needs a domain where all three answers exist at once: a rule that declares the role this
 * deployment acts as, a rule that declares another one, and the two from `twoRules` that declare no
 * role at all.
 */
function roleRules(t: { after(callback: () => void): void }): string {
  const root = twoRules(t)
  const lesson = (id: string, tag: string): void => {
    writeFileSync(
      join(root, 'objects', 'lessons', `${id}.yaml`),
      [
        `lesson_id: ${id}`,
        'status: verified',
        'kind: tooling',
        'rule: >-',
        `  Written for whoever acts as ${tag}, and binding on nobody else.`,
        `applies_to: ${tag}`,
        'source_kind: review',
        'source_ref: REV-2026-0600',
        'applied_count: 0',
        '',
      ].join('\n'),
    )
  }
  lesson('LES-005', 'role:reviewer')
  lesson('LES-006', 'role:executor')
  return root
}

test('naming a product marks the rules that constrain it, and lists the ones that constrain nothing', (t) => {
  // The second half is the part worth pinning. "Money is compared as integers" is not about any one
  // deliverable, so if naming a product were a gate on rules with no product, the most general rules
  // would be the first to disappear — the opposite of what a general rule is for. Naming one now
  // changes what is marked and nothing else.
  const graph = loadGraph(productRules(t))
  const selection = selectRules(graph, { deliverables: ['DLV-GADGET'], tags: [] })

  assert.deepEqual(selection.rules.map((rule) => rule.id).sort(), ['LES-001', 'LES-004'])
  assert.deepEqual(
    selection.rules.filter((rule) => rule.marked).map((rule) => rule.id),
    ['LES-001'],
    'the constraining rule is the marked one, and it is named in the index line',
  )
  assert.match(renderSection(selection), /Marked here, .*: LES-001\./)
  assert.doesNotMatch(
    renderSection(selection),
    /LES-002/,
    'and a candidate still did not come in through the new gate',
  )
})

test('a rule constrained to another product is the one a named product does not mark', (t) => {
  const root = productRules(t)
  writeFileSync(
    join(root, 'objects', 'deliverables', 'DLV-OTHER.yaml'),
    'deliverable_id: DLV-OTHER\nname: Something else entirely\n',
  )

  // The same rule set, a different product: nothing constrains it, so nothing is marked — and both
  // rules are listed all the same, because "this rule is not about your deliverable" is a statement
  // about attention rather than about obligation.
  const selection = selectRules(loadGraph(root), { deliverables: ['DLV-OTHER'], tags: [] })
  assert.deepEqual(selection.rules.map((rule) => rule.id).sort(), ['LES-001', 'LES-004'])
  assert.deepEqual(
    selection.rules.filter((rule) => rule.marked).map((rule) => rule.id),
    [],
  )
  assert.doesNotMatch(renderSection(selection), /Marked here/)
})

test('an object id resolves to the product the domain says that kind of thing is', (t) => {
  const graph = loadGraph(productRules(t))

  assert.deepEqual(resolveActive(graph, 'W-1'), { deliverables: ['DLV-GADGET'], tags: [] })
  assert.deepEqual(resolveActive(graph, 'DLV-GADGET'), { deliverables: ['DLV-GADGET'], tags: [] })
})

test('an id nothing answers to is reported rather than silently selecting nothing', (t) => {
  const graph = loadGraph(productRules(t))

  const missing = resolveActive(graph, 'W-404')
  assert.deepEqual(missing.deliverables, [])
  assert.match(missing.note ?? '', /nothing in this domain is identified as "W-404"/)
})

test('an object answers which stage it is in, and says what it answered from', (t) => {
  // The half a person used to type. The domain declares which state means which tag, so the tag
  // that is easiest to get wrong in silence becomes a fact read off the object.
  const root = productRules(t)
  const schema = join(root, 'schema.yaml')
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8')
      .replace(
        '  product_type: Deliverable',
        '  product_type: Deliverable\n  state_tags:\n    Widget:\n      new: phase:building',
      )
      .replace(
        /^  Widget:$/m,
        '  Widget:\n    lifecycle:\n      field: state\n      initial: new\n      states: [new, done]',
      )
      .replace('      widget_id: { type: string }', '      widget_id: { type: string }\n      state: { type: string }'),
  )
  writeFileSync(join(root, 'objects', 'widgets', 'W-1.yaml'), 'widget_id: W-1\nstate: new\n')

  const resolved = resolveActive(loadGraph(root), 'W-1')

  assert.deepEqual(resolved.tags, ['phase:building'])
  assert.match(resolved.because ?? '', /Widget W-1 is new, which this domain maps to phase:building/)
  // And the section carries it, because a computed situation has no other way to be checked.
  assert.match(
    renderSection(selectRules(loadGraph(root), { deliverables: resolved.deliverables, tags: resolved.tags, because: resolved.because })),
    /Situation computed from: Widget W-1 is new/,
  )
})

test('a state the domain maps to nothing yields no tag, and says so rather than guessing', (t) => {
  const root = productRules(t)
  const schema = join(root, 'schema.yaml')
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8')
      .replace('  product_type: Deliverable', '  product_type: Deliverable\n  state_tags:\n    Widget:\n      new: phase:building')
      .replace(
        /^  Widget:$/m,
        '  Widget:\n    lifecycle:\n      field: state\n      initial: new\n      states: [new, done]',
      )
      .replace('      widget_id: { type: string }', '      widget_id: { type: string }\n      state: { type: string }'),
  )
  // `done` is a declared state with no mapping — a gap in the domain, not a tag to invent.
  writeFileSync(join(root, 'objects', 'widgets', 'W-1.yaml'), 'widget_id: W-1\nstate: done\n')

  const resolved = resolveActive(loadGraph(root), 'W-1')
  assert.deepEqual(resolved.tags, [])
  assert.match(resolved.because ?? '', /which this domain maps to no tag/)
})

test('a declared tag and a computed one are merged, not one replacing the other', (t) => {
  // A role is who the caller is, which is not a fact about the deliverable, so the deployment still
  // states that half — and both halves must survive.
  const graph = loadGraph(productRules(t))
  const resolved = resolveActive(graph, 'DLV-GADGET')

  assert.deepEqual([...new Set(['role:engineer', ...resolved.tags])], ['role:engineer'])
})

test('the product is named in the section, before the tags derived from it', (t) => {
  const graph = loadGraph(productRules(t))
  const rendered = renderSection(
    selectRules(graph, { deliverables: ['DLV-GADGET'], tags: ['artifact:pull_request'] }),
  )

  assert.match(rendered, /Working on DLV-GADGET; artifact:pull_request\./)
})

test('the product type is whatever the domain says it is, not a name the engine knows', (t) => {
  // The engine had `Deliverable` written into two places while `selectRules` read the declared name.
  // Both halves looked right in isolation and disagreed only for a domain that named its product
  // type anything else — where the constraints would be read and the resolution would not, which is
  // half a mechanism and no error. Found by building an example that names it something else.
  const root = productRules(t)
  const schema = join(root, 'schema.yaml')
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8')
      .replace('  product_type: Deliverable', '  product_type: Artifact')
      .replace(/^  Deliverable:$/m, '  Artifact:')
      .replace('    to: Deliverable', '    to: Artifact'),
  )

  const graph = loadGraph(root)
  assert.equal(graph.schema.situationProduct, 'Artifact', 'the declaration was read')
  assert.deepEqual(resolveActive(graph, 'W-1'), { deliverables: ['DLV-GADGET'], tags: [] })
  assert.deepEqual(resolveActive(graph, 'DLV-GADGET'), { deliverables: ['DLV-GADGET'], tags: [] })
})

test('a domain that declares no product type still gets its state tags', (t) => {
  // The two declarations are independent, and the first draft of the fix above conflated them: it
  // returned early when there was no product type, which silently disabled the tags as well. A
  // domain may use one without the other, so the absence of a product type skips the product half
  // and reports nothing.
  const root = productRules(t)
  const schema = join(root, 'schema.yaml')
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8').replace('  product_type: Deliverable\n', ''),
  )

  const resolved = resolveActive(loadGraph(root), 'W-1')

  assert.deepEqual(resolved.deliverables, [], 'no product type, so no product to name')
  assert.equal(resolved.note, undefined, 'and that is a choice, not something to report')
})

test('the block is closed, so where it ends is not left to be inferred', (t) => {
  // The commit that named the block said it wraps the output, and the host wraps its own
  // `<skill_content>`. Only opening it would name a start and leave the end to the reader, and one
  // reader of this text decides on it: a role prompt tests "is the block missing or empty".
  const rendered = renderSection(selectRules(loadGraph(twoRules(t)), situation([])))

  assert.match(rendered, /^<patterns>\n/)
  assert.match(rendered, /\n<\/patterns>$/)
})

// ── the one gate that survived ──────────────────────────────────────────────────
//
// A role is declared: the mode says which one it acts as. A stage and a product are inferred from
// an object's state, and an inference that is sometimes wrong must not decide what a prompt
// carries. So the role is the only thing that keeps a rule out, and the situation marks and orders.

test('a rule that declares another role is left out, and the section counts it', (t) => {
  const graph = loadGraph(roleRules(t))
  const selection = selectRules(graph, situation(['role:executor']))

  assert.deepEqual(selection.rules.map((rule) => rule.id), ['LES-004', 'LES-001', 'LES-006'])
  assert.equal(selection.total, 4)
  assert.equal(selection.available, 3)
  assert.equal(selection.excluded, 1, 'LES-005 is declared for role:reviewer')

  const rendered = renderSection(selection)
  assert.doesNotMatch(rendered, /LES-005/)
  assert.match(
    rendered,
    /3 of the 4 vouched-for rules are available to this role; the other 1 declare a different role and are not listed here\./,
    'the narrowing is visible, so a reader can do the arithmetic',
  )
})

test('a rule that declares no role belongs to every role', (t) => {
  // Fail-open on the silence, which is the half that matters: "nobody said who this is for" is not
  // a claim that it is for somebody else, and a gate that read the silence as a claim would hide
  // exactly the rules whose author never thought about routing at all.
  const graph = loadGraph(roleRules(t))

  for (const role of ['role:executor', 'role:reviewer', 'role:nobody']) {
    const ids = selectRules(graph, situation([role])).rules.map((rule) => rule.id)
    assert.ok(ids.includes('LES-001'), `a rule with no role tag reaches ${role}`)
    assert.ok(ids.includes('LES-004'), `a rule with no role tag reaches ${role}`)
  }
})

test('no rule of this role is ever missing, whatever the situation sees', (t) => {
  // What "the situation ranks and annotates" has to mean in practice: the block's membership is a
  // function of the role alone. Four situations, one role, one set of rules — and the marked set is
  // the only thing that moves.
  const graph = loadGraph(roleRules(t))
  const forThisRole = ['LES-004', 'LES-001', 'LES-006']
  const situations = [
    ['role:executor'],
    ['role:executor', 'artifact:pull_request'],
    ['role:executor', 'phase:billing', 'artifact:invoice'],
    ['role:executor', 'artifact:nobody_declares_this', 'stage:nowhere'],
  ]

  const selections = situations.map((tags) => selectRules(graph, situation(tags)))

  assert.deepEqual(
    selections.map((selection) => selection.rules.map((rule) => rule.id)),
    situations.map(() => forThisRole),
    'not one of them loses a rule the inferred half does not recognise',
  )
  assert.deepEqual(
    selections.at(-1)?.rules.filter((rule) => rule.marked).map((rule) => rule.id),
    [],
    'a situation naming nothing any rule is about marks none of them, and still loses none',
  )
  assert.deepEqual(
    selections[1]?.rules.filter((rule) => rule.marked).map((rule) => rule.id),
    ['LES-001'],
    'and the marks are the only thing the situation changed',
  )
})

test('the same situation renders the same text, marker and all', (t) => {
  // The stability the block had before it marked anything, which the marking must not cost. Two
  // assemblies of one situation are the same string, so a diff of two prompts is a diff of the
  // world rather than of the order a set happened to be read in.
  const graph = loadGraph(roleRules(t))
  const tags = ['role:executor', 'artifact:pull_request']
  const first = renderSection(selectRules(graph, situation(tags)))
  const second = renderSection(selectRules(graph, situation(tags)))

  assert.equal(first, second)
  assert.match(first, /Marked here, in the order they are listed below: LES-001\./)
  // And the marking does not reorder the block: the unmarked rule is still first, under its own
  // heading, because headings sort and ids sort within them.
  assert.match(first, /### money\n- \*\*LES-004\*\*/)
})

test('a line carries the tags it was declared under and the products it constrains', (t) => {
  // The premise of listing everything: without the tags and the products on the line, a reader
  // handed forty rules has nothing to tell which of them names the work in front of it, and "here
  // is the whole set" is a pile rather than a rule set.
  const graph = loadGraph(productRules(t))
  const rendered = renderSection(
    selectRules(graph, { deliverables: ['DLV-GADGET'], tags: ['artifact:pull_request'] }),
  )

  assert.match(
    rendered,
    /^▸ - \*\*LES-001\*\* — [^\n]*\[artifact:pull_request; constrains DLV-GADGET\]$/m,
  )
  assert.match(rendered, /^- \*\*LES-004\*\* — [^\n]*\[phase:billing, artifact:invoice\]$/m)

  // And a rule that declares neither renders as it did before, with no empty bracket.
  const bare = twoRules(t)
  const file = join(bare, 'objects', 'lessons', 'LES-001.yaml')
  writeFileSync(file, readFileSync(file, 'utf-8').replace(/^applies_to: .*$/m, ''))
  assert.match(
    renderSection(selectRules(loadGraph(bare), situation([]))),
    /^- \*\*LES-001\*\* — [^\n]*abandoned\.$/m,
  )
})

/**
 * A domain where a situation can be complete: a role, a stage, and a product.
 *
 * All three at once, because the claim these two tests pin is about what the role must *not* do
 * once it has decided membership. `LES-005` is the sharp case — it declares the role this
 * deployment acts as and a stage it is not at — and it exists only to be listed unmarked.
 */
function roleAndProductRules(t: { after(callback: () => void): void }): string {
  const root = productRules(t)
  const lesson = (id: string, tags: string): void => {
    writeFileSync(
      join(root, 'objects', 'lessons', `${id}.yaml`),
      [
        `lesson_id: ${id}`,
        'status: verified',
        'kind: tooling',
        'rule: >-',
        `  Written for ${tags}, and about the stage it names rather than every stage.`,
        `applies_to: [${tags}]`,
        'source_kind: review',
        'source_ref: REV-2026-0700',
        'applied_count: 0',
        '',
      ].join('\n'),
    )
  }
  lesson('LES-005', 'role:executor, stage:accepted')
  lesson('LES-006', 'role:executor, stage:review')
  return root
}

test('the role decides who is listed, and never what is marked', (t) => {
  // The failure this pins is a marker that is on every line. The role is a tag in the situation like
  // any other, so reading "the rule shares a tag with the situation" as evidence about the work made
  // the condition true for every rule that had got through the role gate — a marker that
  // distinguished nothing, and a count that described the listing rather than the work. The two
  // halves are read separately now, and this is the situation that shows it: a role, a stage and a
  // product, all three stated at once.
  const graph = loadGraph(roleAndProductRules(t))
  const selection = selectRules(graph, {
    deliverables: ['DLV-GADGET'],
    tags: ['role:executor', 'stage:review'],
  })

  assert.equal(selection.available, 4)
  assert.deepEqual(
    selection.rules.map((rule) => rule.id),
    ['LES-004', 'LES-001', 'LES-005', 'LES-006'],
    'every rule this role may follow, whatever the inferred half makes of it',
  )
  assert.deepEqual(
    selection.rules.filter((rule) => rule.marked).map((rule) => rule.id),
    ['LES-001', 'LES-006'],
    'the product constraint and the stage, and not the role all three of them share',
  )
  assert.ok(
    selection.rules.filter((rule) => rule.marked).length < selection.available,
    'a marker that is on every line is not a marker',
  )
  // The sharp one, named rather than only counted: it declares this deployment's role, and the stage
  // it declares is a different one, and it constrains nothing, so nothing about it is about this work.
  assert.equal(selection.rules.find((rule) => rule.id === 'LES-005')?.marked, false)
})

test('a situation that states only a role marks nothing, and gives the reason rather than a zero', (t) => {
  // The boundary the marking rule creates. A role is the gate and a marker comes from the inferred
  // half, so a deployment that stated a role and nothing else has nothing to mark with and nothing
  // has gone wrong. A count of zero would say otherwise: it is a number a reader stops on, and the
  // reader here would go looking behind it for the rules that went unmarked.
  const graph = loadGraph(roleRules(t))
  const selection = selectRules(graph, situation(['role:executor']))
  const rendered = renderSection(selection)

  assert.equal(selection.available, 3, 'the role still decided membership')
  assert.deepEqual(
    selection.rules.filter((rule) => rule.marked),
    [],
    'and there is no inferred half for a marker to come from',
  )
  assert.match(
    rendered,
    /None of them is marked for this situation, because this deployment states a role and nothing else/,
  )
  assert.match(rendered, /Every line below is a requirement on the work it names/)
  assert.doesNotMatch(rendered, /0 of them are marked/)
  assert.doesNotMatch(rendered, /Marked here/)
  // And the lines themselves are unchanged: unmarked is not excluded, and not marked is not optional.
  assert.match(rendered, /^- \*\*LES-001\*\*/m)
  assert.match(rendered, /^- \*\*LES-006\*\*/m)
})

test('the numbers and the index the block states are read back out of it, not asserted beside it', (t) => {
  // The block makes four claims about its own lines: how many rules this role may follow, how many
  // were left out for declaring another role, how many are marked, and which ids those are in order.
  // Each one can drift from the lines below it, and a reader inside the prompt cannot catch that — a
  // model is given the text, not the selection behind it. A projection that disagrees with its own
  // detail is the failure this repository keeps refusing one level down (a rule silently absent), so
  // the claims are parsed back out of the rendered text and compared with what it actually contains.
  //
  // It is also the check a model cannot make for itself. Asked to count the rules by kind, one
  // reported 46 at the top and then listed 43, two of its own groups contradicting their own
  // headings. Nothing here reads why a rule is marked: these are set and sum comparisons.
  const withAnotherRole = (): string => {
    const root = roleAndProductRules(t)
    writeFileSync(
      join(root, 'objects', 'lessons', 'LES-007.yaml'),
      [
        'lesson_id: LES-007',
        'status: verified',
        'kind: tooling',
        'rule: >-',
        '  Written for whoever reviews, and binding on nobody who executes.',
        'applies_to: [role:reviewer]',
        'source_kind: review',
        'source_ref: REV-2026-0701',
        'applied_count: 0',
        '',
      ].join('\n'),
    )
    return root
  }

  const check = (rendered: string, expectedExcluded: number): void => {
    const stated = (pattern: RegExp, group = 1): string => {
      const found = rendered.match(pattern)
      assert.ok(found, `the block must state this, and did not: ${String(pattern)}`)
      return found[group]
    }
    const available = Number(stated(/(\d+) of the (\d+) vouched-for rules are available to this role/))
    const total = Number(stated(/(\d+) of the (\d+) vouched-for rules are available to this role/, 2))
    // Nothing withheld takes the other sentence, because a count of zero reads as a shortfall.
    const excluded =
      expectedExcluded === 0
        ? (assert.ok(rendered.includes('none is left out for declaring a different one')), 0)
        : Number(stated(/the other (\d+) declare a different role/))

    const markedCount = Number(stated(/(\d+) of them are marked for this situation/))
    const index = stated(/Marked here, in the order they are listed below: (.+)\./).split(', ')
    const ids = (prefix: string): string[] =>
      [...rendered.matchAll(new RegExp(`^${prefix}- \\*\\*([^*]+)\\*\\*`, 'gm'))].map((m) => m[1])
    const entries = ids('(?:▸ )?')
    const markers = ids('▸ ')

    assert.equal(excluded, expectedExcluded, 'the fixture withheld what it was built to withhold')
    assert.equal(entries.length, available, 'the stated count is the number of lines below it')
    assert.equal(available + excluded, total, 'and the two halves add up to the whole it names')
    assert.equal(markers.length, markedCount, 'the stated marker count is the number of markers')
    assert.deepEqual(index, markers, 'the index is the marked lines, in the order they appear')
    assert.ok(
      markers.length > 0 && markers.length < entries.length,
      'this fixture has to be one where the listed and the marked differ, or none of this is tested',
    )
  }

  const situation = { deliverables: ['DLV-GADGET'], tags: ['role:executor', 'stage:review'] }
  check(renderSection(selectRules(loadGraph(withAnotherRole()), situation)), 1)
  check(renderSection(selectRules(loadGraph(roleAndProductRules(t)), situation)), 0)
})
test('a rule too large for the budget does not take the smaller ones down with it', (t) => {
  // The ceiling used to be enforced with `break`: the first rule that did not fit stopped the walk,
  // so every later - possibly much smaller - rule was dropped too, and `dropped` over-reported against
  // the documented promise that what leaves is the *least specific* rule. Ranking is by how many
  // dimensions the situation pins, so the order is specific-first: LES-004 (two dimensions), then a
  // deliberately long LES-005, then a one-line LES-006. A budget that fits LES-004 and LES-006 but not
  // LES-005 is the case that tells `break` from `continue`.
  const root = twoRules(t)
  writeFileSync(
    join(root, 'objects', 'lessons', 'LES-005.yaml'),
    [
      'lesson_id: LES-005',
      'status: verified',
      'kind: process',
      'rule: >-',
      `  ${'A long rule that must not fit: it exists to occupy the ceiling. '.repeat(40)}`,
      'applies_to: [artifact:invoice]',
      'source_kind: review',
      'source_ref: REV-2026-0502',
      'applied_count: 0',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(root, 'objects', 'lessons', 'LES-006.yaml'),
    [
      'lesson_id: LES-006',
      'status: verified',
      'kind: process',
      'rule: Small.',
      'applies_to: [artifact:invoice]',
      'source_kind: review',
      'source_ref: REV-2026-0503',
      'applied_count: 0',
      '',
    ].join('\n'),
  )

  const graph = loadGraph(root)
  const situation = { deliverables: [], tags: ['artifact:purchase_order', 'phase:billing', 'artifact:invoice'] }
  const selection = selectRules(graph, situation, { budget: 220 })

  const ids = selection.rules.map((rule) => rule.id)
  assert.ok(ids.includes('LES-004'), 'the specific rule fits')
  assert.ok(ids.includes('LES-006'), 'and so does the small one behind the oversized rule')
  assert.equal(ids.includes('LES-005'), false, 'the oversized rule is the one that leaves')
})
