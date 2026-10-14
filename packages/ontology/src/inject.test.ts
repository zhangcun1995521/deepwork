/**
 * Tests for writing a domain's vouched-for rules into the prompt.
 *
 * The claims pinned here are the two that separate this from a skill catalog. A rule that is not
 * vouched for is in neither surface — the injected listing is not a bypass of the lifecycle. And
 * which rules are injected is decided by the situation the deployment states, not by the model,
 * so the same prompt under a different situation carries a different set of requirements.
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

test('a situation selects the rules it governs, and nothing else', (t) => {
  const graph = loadGraph(twoRules(t))
  const { rules, total, unknown } = selectRules(graph, situation(['artifact:pull_request']))

  assert.deepEqual(
    rules.map((rule) => rule.id),
    ['LES-001'],
  )
  assert.equal(total, 2, 'the denominator counts every vouched-for rule, not the selected ones')
  assert.deepEqual(unknown, [])
})

test('the same domain under another situation yields another set', (t) => {
  const graph = loadGraph(twoRules(t))

  const billing = selectRules(graph, situation(['phase:billing'])).rules.map((rule) => rule.id)
  const review = selectRules(graph, situation(['artifact:pull_request'])).rules.map((rule) => rule.id)

  assert.deepEqual(billing, ['LES-004'])
  assert.deepEqual(review, ['LES-001'])
})

test('a rule is selected when any one of its tags matches', (t) => {
  // Requiring every tag to match would hide a rule from a deployment that could state only one of
  // them, and hidden is the failure this module exists to prevent.
  const graph = loadGraph(twoRules(t))
  const selected = selectRules(graph, situation(['phase:billing', 'role:nobody'])).rules.map((r) => r.id)

  assert.deepEqual(selected, ['LES-004'])
})

test('no declared situation means every vouched-for rule, never none', (t) => {
  const graph = loadGraph(twoRules(t))
  const selection = selectRules(graph, situation([]))
  const { rules, total, tags } = selection

  assert.equal(rules.length, total)
  assert.equal(selection.matched, total)
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

test('a tag that matches nothing is reported, because a typo deletes rules in silence', (t) => {
  const graph = loadGraph(twoRules(t))
  const selection = selectRules(graph, situation(['phase:biling']))

  assert.deepEqual(selection.unknown, ['phase:biling'])
  assert.deepEqual(selection.rules, [], 'the selection is genuinely empty, which is why it has to be said')
  assert.equal(selection.matched, 0)
  assert.equal(selection.dropped, 0, 'nothing matched, so nothing was left out for want of room')

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
  // Both rules apply to this situation. LES-004 pins two of its dimensions and LES-001 only one,
  // so with room for one rule the ranking is what decides who gets in — and it is the specific one.
  const graph = loadGraph(twoRules(t))
  const situation = { deliverables: [], tags: ['artifact:pull_request', 'phase:billing', 'artifact:invoice'] }

  assert.deepEqual(
    selectRules(graph, situation).rules.map((rule) => rule.id).sort(),
    ['LES-001', 'LES-004'],
    'both apply, so nothing but the budget is doing the selecting',
  )

  const tight = selectRules(graph, situation, { budget: 200 })
  assert.deepEqual(
    tight.rules.map((rule) => rule.id),
    ['LES-004'],
  )
  assert.equal(tight.matched, 2)
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

  assert.match(rendered, /1 of the rules that apply here are not listed/)
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
    'deliverable_id: DLV-GADGET\nname: 小装置\nproduced_as: Widget\n',
  )
  const widgets = join(root, 'objects', 'widgets')
  mkdirSync(widgets, { recursive: true })
  writeFileSync(join(widgets, 'W-1.yaml'), 'widget_id: W-1\n')

  return root
}

test('naming a product keeps the rules that constrain it, and the ones that constrain nothing', (t) => {
  // The second half is the part worth pinning. "Money is compared as integers" is not about any one
  // deliverable, so if naming a product closed the gate on rules with no product, the most general
  // rules would be the first to disappear — the opposite of what a general rule is for.
  const graph = loadGraph(productRules(t))
  const selection = selectRules(graph, { deliverables: ['DLV-GADGET'], tags: [] })

  assert.deepEqual(selection.rules.map((rule) => rule.id).sort(), ['LES-001', 'LES-004'])
  assert.doesNotMatch(
    renderSection(selection),
    /LES-002/,
    'and a candidate still did not come in through the new gate',
  )
})

test('a rule constrained to another product is the one naming a product rules out', (t) => {
  const root = productRules(t)
  writeFileSync(
    join(root, 'objects', 'deliverables', 'DLV-OTHER.yaml'),
    'deliverable_id: DLV-OTHER\nname: 别的东西\n',
  )

  // The same rule set, a different product: nothing constrains it, so only the unconstrained rule
  // is left — and that is what "this rule is not about your deliverable" means.
  const selection = selectRules(loadGraph(root), { deliverables: ['DLV-OTHER'], tags: [] })
  assert.deepEqual(selection.rules.map((rule) => rule.id), ['LES-004'])
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
