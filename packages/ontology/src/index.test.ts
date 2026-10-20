/**
 * Integration test: does the plugin actually mount the guard?
 *
 * The guard's own tests prove it refuses what it should. This proves the plugin asks
 * it to — a distinction that matters, because a policy that is written and never
 * mounted reads exactly like a policy that works, right up until someone checks.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply, type OntologyContext } from './index.ts'
import type { RegisterableTool, RuntimeToolCall } from './tools/register.ts'

const FIXTURE_SOURCE = resolve(fileURLToPath(import.meta.url), '../../tests/fixtures/project-delivery')

/**
 * A throwaway copy of the fixture, because mounting the plugin has a side effect: the
 * read-only refusal is a guard decision, and a guard decision is audited. Pointing that
 * at the committed fixture would leave a growing trail inside the repository and, worse,
 * make the suite race its own file copies.
 */
function scratchFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-index-'))
  cpSync(FIXTURE_SOURCE, dir, { recursive: true })
  return dir
}

interface Harness {
  /** The scratch domain this harness mounted, so tests can resolve paths inside it. */
  root: string
  ctx: OntologyContext
  registered: string[]
  mounted?: (call: RuntimeToolCall) => string | undefined
  logs: string[]
  /** Every prompt section the plugin registered, as evaluated at registration. */
  sections: Map<string, string>
  /** The same sections as providers, so a test can ask for a fresh assembly. */
  providers: Map<string, () => string>
  /** What each section asked the registry for, which is only readable off the declaration. */
  interpolate: Map<string, boolean | undefined>
  /** Evaluate a section again, which is what the registry does for each assembly. */
  readSection(name: string): string
  /** What the plugin published for other packages to look up, by service name. */
  published: Map<string, unknown>
}

/** A context that records what the plugin does, without a runtime or a domain on disk. */
function harness(): Harness {
  const state: Harness = {
    root: '',
    registered: [],
    logs: [],
    sections: new Map(),
    providers: new Map(),
    interpolate: new Map(),
    published: new Map(),
    readSection: (name) => state.providers.get(name)?.() ?? '',
    ctx: undefined as unknown as OntologyContext,
  }
  state.ctx = {
    tools: {
      register(definition: RegisterableTool): unknown {
        state.registered.push(definition.name)
        return definition
      },
      guard(guard: (call: RuntimeToolCall) => string | undefined): void {
        state.mounted = guard
      },
    },
    provide: (name: string, value: unknown) => {
      state.published.set(name, value)
      return () => state.published.delete(name)
    },
    logger: {
      warn: (message: string) => state.logs.push(`warn: ${message}`),
      info: (message: string) => state.logs.push(`info: ${message}`),
    },
    inject: (names, callback) => {
      // One service is stood up. Everything else the plugin asks for is absent, and the plugin has
      // to work without it — which is exactly what leaving the others empty tests.
      if (!names.includes('systemPrompt')) return
      callback({
        systemPrompt: {
          section: (section) => {
            // Evaluated here, each time, because that is what the registry does: a provider is
            // called per assembly, and a harness that stored the function itself would pass every
            // test while the section never followed the world.
            const provider =
              typeof section.text === 'function' ? section.text : () => section.text as string
            state.interpolate.set(section.name, section.interpolate)
            state.providers.set(section.name, provider)
            state.sections.set(section.name, provider())
            return () => {}
          },
          getSectionOrder: () => 0,
        },
        effect: (callback) => {
          callback()
        },
      } as never)
    },
  }
  return state
}

function mount(roles: { prefix: string; role: string }[]): Harness {
  const h = harness()
  const root = scratchFixture()
  h.root = root
  // The audit sink is named explicitly rather than defaulted, so a future default cannot
  // quietly start writing into the fixture again.
  apply(h.ctx, { ontologyRoot: root, roles, auditLog: join(root, 'audit.jsonl') })
  return h
}

test('the guard is mounted even with no roles configured', () => {
  const h = mount([])
  assert.notEqual(h.mounted, undefined)
  assert.ok(h.logs.some((line) => line.includes('write guard mounted')))
})

test('with no roles, a write is refused as read-only', () => {
  const h = mount([])
  const refusal = h.mounted?.({ name: 'write', arguments: { path: 'anything.md' }, agent: { id: 'x' } })
  assert.match(refusal ?? '', /read-only/)
})

test('the analyst role may write inside a declared directory and nowhere else', () => {
  const h = mount([{ prefix: 'analyst-', role: 'analyst' }])
  const inside = resolve(h.root, 'objects/customers/CUST-NEW.yaml')
  const outside = resolve(h.root, '../elsewhere.md')

  assert.equal(h.mounted?.({ name: 'write', arguments: { path: inside }, agent: { id: 'analyst-1' } }), undefined)
  assert.match(
    h.mounted?.({ name: 'write', arguments: { path: outside }, agent: { id: 'analyst-1' } }) ?? '',
    /outside the directories/,
  )
})

test('a role the schema never names cannot write anything', () => {
  const h = mount([{ prefix: 'ghost-', role: 'ghost' }])
  const refusal = h.mounted?.({
    name: 'write',
    arguments: { path: resolve(h.root, 'objects/customers/CUST-NEW.yaml') },
    agent: { id: 'ghost-1' },
  })
  assert.match(refusal ?? '', /not named in written_by/)
})

test('a shell redirect outside the domain is refused once the guard is mounted', () => {
  const h = mount([{ prefix: 'analyst-', role: 'analyst' }])
  const refusal = h.mounted?.({
    name: 'pwsh',
    arguments: { command: `echo pwned > ${resolve(h.root, '../pwned.md')}` },
    agent: { id: 'analyst-1' },
  })
  assert.match(refusal ?? '', /redirects into/)
})

const LESSONS = resolve(fileURLToPath(import.meta.url), '../../examples/lessons')

/**
 * Mount the lessons example, which is the smallest domain that vouches for anything.
 *
 * The situation is configuration here, and the role is part of it: a deployment states the role it
 * acts as where the plugin that selects rules by it is mounted.
 */
function mountLessons(situation: string): Harness {
  const h = harness()
  h.root = mkdtempSync(join(tmpdir(), 'deepwork-index-lessons-'))
  cpSync(LESSONS, h.root, { recursive: true })
  apply(h.ctx, {
    ontologyRoot: h.root,
    situation,
    auditLog: join(h.root, 'audit.jsonl'),
  })
  return h
}

test('the vouched-for rules reach the prompt, which is what a catalog cannot do', () => {
  const h = mountLessons('artifact:pull_request')
  const text = h.sections.get('deepwork:experience') ?? ''

  assert.match(text, /LES-001/, 'the rule the situation governs')
  assert.doesNotMatch(text, /LES-002/, 'a candidate may not be loaded either')
  assert.doesNotMatch(text, /LES-003/, 'nor a rejected one')
})

test('an unstated situation injects everything rather than nothing', () => {
  const h = mountLessons('')
  assert.match(h.sections.get('deepwork:experience') ?? '', /LES-001/)
})

test('a situation selecting nothing still registers, so the mistake is visible', () => {
  // The failure this pins is a real one that the live run found: registering only when rules were
  // selected meant that a mistyped tag produced no section at all — so the one case where the
  // deployment needs telling was the one case where it was told nothing.
  const h = mountLessons('phase:revenge')

  assert.ok(h.sections.has('deepwork:experience'), 'the section is registered even with no rules')
  assert.match(h.sections.get('deepwork:experience') ?? '', /phase:revenge.*match nothing|match nothing/)
  assert.ok(
    h.logs.some((line) => line.includes('phase:revenge')),
    'and the boot log names the tag, for whoever has to fix it',
  )
})

test('the section is recomputed for each assembly, so a promotion arrives without a restart', (t) => {
  // The claim this pins is the reason the section takes a provider rather than a string. A session
  // names an object; the object's state supplies the tags; and both the rules and the state can
  // move while the agent is working. Reading the same registration twice, with a write in between,
  // is what a per-assembly evaluation looks like from the outside.
  //
  // The fixture maps the two states onto tags the example's rules already use, so that the change
  // is visible in what the platform marks and not only in the sentence describing it.
  const root = mkdtempSync(join(tmpdir(), 'deepwork-live-'))
  cpSync(LESSONS, root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const schema = join(root, 'schema.yaml')
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8').replace(
      /^version:/m,
      'situation:\n  state_tags:\n    Lesson:\n' +
        '      candidate: artifact:integration_client\n      verified: artifact:pull_request\n\nversion:',
    ),
  )

  // LES-002 arrives as a candidate: named by the session, mapped to a tag, and not a rule yet.
  const h = harness()
  apply(h.ctx, { ontologyRoot: root, active: 'LES-002', auditLog: join(root, 'audit.jsonl') })
  const before = h.readSection('deepwork:experience')

  assert.match(before, /Lesson LES-002 is candidate, which this domain maps to artifact:integration_client/)
  assert.match(before, /1 of the 1 vouched-for rules/, 'one rule is vouched for, and it is listed')
  assert.match(
    before,
    /None of them is marked for this situation, because no rule here names what this deployment is working on/,
    'the situation names something no vouched-for rule is about, and says so rather than counting zero',
  )

  // Somebody upholds it. Nothing is restarted, and nothing is re-registered.
  const lesson = join(root, 'objects', 'lessons', 'LES-002.yaml')
  writeFileSync(lesson, readFileSync(lesson, 'utf-8').replace(/^status: candidate$/m, 'status: verified'))

  const after = h.readSection('deepwork:experience')

  assert.match(after, /Lesson LES-002 is verified, which this domain maps to artifact:pull_request/)
  assert.match(after, /2 of the 2 vouched-for rules/, 'a rule that was not vouched for now is')
  assert.match(after, /Marked here, .*: LES-001\./, 'and it is the one whose tag the new state marks')
  assert.match(after, /\*\*LES-001\*\* —/)
  assert.doesNotMatch(after, /is candidate, which this domain maps/)
  assert.notEqual(after, before, 'the two reads are genuinely different text')
})

test('the role a deployment states reaches the situation, because nothing derived can supply it', () => {
  // The role is the one tag no object state can produce: a case says what stage it reached, and
  // nothing in the domain says who is doing the work. So the deployment states it, and it lands in
  // the thing it describes — which rules this agent is here to follow.
  const stated = mountLessons('role:curator')
  assert.match(stated.readSection('deepwork:experience'), /role:curator/)

  const silent = mountLessons('')
  assert.doesNotMatch(silent.readSection('deepwork:experience'), /role:/)
})

test('the rules block asks not to be interpolated', () => {
  // The registry's `{{variable}}` references are strict — an undefined one throws — and this text
  // is domain data: a rule body is prose its author wrote, and nothing stops it containing a brace
  // pair. Interpolation left on would make any such rule a way to take every turn down. What this
  // pins is the flag on the registration, which is the half this package owns; what the registry
  // does with the flag is the host's.
  const h = mountLessons('artifact:pull_request')

  assert.equal(h.interpolate.get('deepwork:experience'), false)
})

test('a domain edited into an unreadable state mid-session is said, not silently smaller', () => {
  // The graph is re-read on every assembly, and its warnings have to travel with it. They were
  // dropped here: a rule file broken after boot took its rule out of the block and the block said
  // nothing, because `trouble` only carried the active object's note. What a reader needs told is
  // exactly what the second read could not read — and this is the only place that read happens.
  const h = mountLessons('artifact:pull_request')
  assert.doesNotMatch(h.readSection('deepwork:experience'), /no longer reads cleanly/)

  const broken = join(h.root, 'objects', 'lessons', 'LES-001.yaml')
  writeFileSync(broken, '{{{{')

  const after = h.readSection('deepwork:experience')
  assert.match(after, /no longer reads cleanly/, 'the block reports what it could not read')
  assert.match(after, /LES-001/, 'and names the file, so a reader can go and look')
})

test('the governance channel is published, and the ontology does not declare its own tools to it', () => {
  // `external` and `test-runner` ask the runtime for `deepworkGovernance` and declare what their
  // tools touch; nothing until now stood the channel up in this suite, so the seam every capability
  // depends on was asserted by nothing — a renamed service would have been green.
  const h = mountLessons('artifact:pull_request')

  const registry = h.published.get('deepworkGovernance') as
    | { declareTool(name: string, access: unknown): () => void; govern(name: string): unknown; declared(): string[] }
    | undefined
  assert.ok(registry !== undefined, 'the channel is published under the name both sides state')

  // The domain's grants reach it, and a capability's declaration is judged through it.
  registry.declareTool('run_suite', { executes: ['pytest'] })
  assert.ok(registry.govern('run_suite') !== undefined)

  // And the ontology's own tools are *not* declared: the guard has never heard of them, which is why
  // an action named in `tool_grants` does nothing. That is documented in the architecture document,
  // and this is the assertion that keeps the document honest.
  assert.deepEqual(
    registry.declared().filter((tool) => tool.startsWith('ontology_')),
    [],
    'the ontology does not declare its own tools, so tool_grants never applies to them',
  )
})

test('a runtime with no service lookup is told what it therefore did not register', () => {
  // `ctx.inject?.()` was right about the optionality and wrong about the silence: no panel route, no
  // skill catalogue and no rules block, with a boot log that looked healthy.
  const h = harness()
  h.root = mkdtempSync(join(tmpdir(), 'deepwork-index-nolookup-'))
  cpSync(LESSONS, h.root, { recursive: true })
  delete (h.ctx as { inject?: unknown }).inject
  apply(h.ctx, { ontologyRoot: h.root, situation: '', auditLog: join(h.root, 'audit.jsonl') })

  const said = h.logs.join(String.fromCharCode(10))
  assert.match(said, /exposes no service lookup/)
  assert.match(said, /rules block/)
})
