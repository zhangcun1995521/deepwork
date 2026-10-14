/**
 * Integration test: does the plugin actually mount the guard?
 *
 * The guard's own tests prove it refuses what it should. This proves the plugin asks
 * it to — a distinction that matters, because a policy that is written and never
 * mounted reads exactly like a policy that works, right up until someone checks.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
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
  /** Every prompt section the plugin registered, as `name -> text`. */
  sections: Map<string, string>
}

/** A context that records what the plugin does, without a runtime or a domain on disk. */
function harness(): Harness {
  const state: Harness = {
    root: '',
    registered: [],
    logs: [],
    sections: new Map(),
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
      // Only the prompt registry is stood up. Everything else the plugin asks for is absent, and
      // the plugin has to work without it — which is exactly what leaving the others empty tests.
      if (!names.includes('systemPrompt')) return
      callback({
        systemPrompt: {
          section: (section) => {
            state.sections.set(section.name, section.text)
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

/** Mount the lessons example, which is the smallest domain that vouches for anything. */
function mountLessons(situation: string): Harness {
  const h = harness()
  h.root = mkdtempSync(join(tmpdir(), 'deepwork-index-lessons-'))
  cpSync(LESSONS, h.root, { recursive: true })
  apply(h.ctx, { ontologyRoot: h.root, situation, auditLog: join(h.root, 'audit.jsonl') })
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
