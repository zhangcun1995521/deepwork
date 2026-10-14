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

/** What the harness stands up beside the plugin. */
interface HarnessOptions {
  /** The role the role plugin published, if one is mounted and it states one. */
  role?: string
  /**
   * Hold the role back until {@link Harness.stateRole} is called.
   *
   * The two packages are separate mounts, so a service that appears after this plugin loaded is the
   * ordinary case rather than a corner, and this is how the harness produces it.
   */
  lateRole?: boolean
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
  /** Hand the role service over now, as a plugin loading after this one would. */
  stateRole(role: string): void
}

/** A context that records what the plugin does, without a runtime or a domain on disk. */
function harness(options: HarnessOptions = {}): Harness {
  // The role plugin's channel, as this plugin sees it: a callback to be called when the service
  // exists, which may be later than the call that registered it.
  let deliver: ((scoped: never) => void) | undefined
  const state: Harness = {
    root: '',
    registered: [],
    logs: [],
    sections: new Map(),
    providers: new Map(),
    interpolate: new Map(),
    readSection: (name) => state.providers.get(name)?.() ?? '',
    stateRole: (role) => deliver?.({ deepworkRole: { role } } as never),
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
    logger: {
      warn: (message: string) => state.logs.push(`warn: ${message}`),
      info: (message: string) => state.logs.push(`info: ${message}`),
    },
    inject: (names, callback) => {
      // Two services are stood up. Everything else the plugin asks for is absent, and the plugin has
      // to work without it — which is exactly what leaving the others empty tests.
      if (names.includes('deepworkRole')) {
        if (options.lateRole === true) {
          deliver = callback
          return
        }
        if (options.role === undefined) return
        callback({ deepworkRole: { role: options.role } } as never)
        return
      }
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
 * The role the deployment acts as is the role plugin's to state, so it is supplied through the
 * service channel rather than as configuration here.
 */
function mountLessons(situation: string, options: HarnessOptions = {}): Harness {
  const h = harness(options)
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

test('the role the mode acts as reaches the situation without anyone typing the tag', () => {
  // The role was a tag somebody had to remember, or an id-prefix map for the write path. It arrives
  // from the plugin whose job it is now, and lands in the thing it actually describes: which rules
  // this agent is here to follow.
  const withRole = mountLessons('', { role: 'curator' })
  assert.match(withRole.readSection('deepwork:experience'), /role:curator/)

  const without = mountLessons('')
  assert.doesNotMatch(without.readSection('deepwork:experience'), /role:/)
})

test('a role published after this plugin loaded still reaches the situation', () => {
  // The two packages are separate mounts, so which of them loads first is the composition's
  // business. Reading the role per assembly, rather than resolving it once at load, is what makes
  // that order not matter.
  const h = mountLessons('', { lateRole: true })

  assert.doesNotMatch(h.readSection('deepwork:experience'), /role:curator/)

  h.stateRole('curator')

  assert.match(h.readSection('deepwork:experience'), /role:curator/)
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
