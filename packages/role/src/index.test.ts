/**
 * Tests for the plugin's own `apply`.
 *
 * This package registers no tools, so there is no registry and no domain to check. What is left is
 * the two things a mode states about identity: that the role it acts as reaches whoever selects
 * rules by it, and that the prompt for that role is mounted verbatim. Both are structural — the
 * prompt registry is named rather than imported — which is what lets this run with no runtime at
 * all.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, type Config, type RoleContext } from './index.ts'

/**
 * Where the harness puts the host's own persona.
 *
 * Not zero, so that a section ranked relative to it can be told apart from one that ignored it — a
 * fake returning zero would let `+ 1` and a bare `0` pass the same test.
 */
const PERSONA_ORDER = 10

interface Harness {
  ctx: RoleContext
  logs: string[]
  /** Every prompt section the plugin registered, as evaluated at registration. */
  sections: Map<string, string>
  /** How each section was registered, which is the only place its rank and its flag are visible. */
  registrations: Map<string, { order: number; interpolate?: boolean }>
  /** The same sections as providers, so a test can ask for a fresh assembly. */
  providers: Map<string, () => string>
  /** Evaluate a section again, which is what the registry does for each assembly. */
  readSection(name: string): string
}

/** A context that records what the plugin does, without a runtime and without a profile. */
function harness(): Harness {
  const state: Harness = {
    logs: [],
    sections: new Map(),
    registrations: new Map(),
    providers: new Map(),
    readSection: (name) => state.providers.get(name)?.() ?? '',
    ctx: undefined as unknown as RoleContext,
  }
  state.ctx = {
    logger: {
      warn: (message: string) => state.logs.push(message),
    },
    inject: (names, callback) => {
      // Only the prompt registry is stood up, and only when the plugin asks for it. Everything else
      // the plugin might ask for stays absent, which is what the plugin has to work without.
      if (!names.includes('systemPrompt')) return
      callback({
        systemPrompt: {
          section: (section) => {
            const provider =
              typeof section.text === 'function' ? section.text : () => section.text as string
            state.providers.set(section.name, provider)
            state.sections.set(section.name, provider())
            state.registrations.set(section.name, {
              order: section.order,
              ...(section.interpolate === undefined ? {} : { interpolate: section.interpolate }),
            })
            return () => {}
          },
          getSectionOrder: (name: string) => (name === 'DEPLOYMENT_PERSONA_PREFIX' ? PERSONA_ORDER : 0),
        },
        effect: (callback: () => () => void) => {
          callback()
        },
      } as never)
    },
  }
  return state
}

function mount(config: Config): Harness {
  const h = harness()
  apply(h.ctx, config)
  return h
}

test('a mode mounts the prompt its role names, as its own section', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-prompt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const prompt = join(dir, 'curator.txt')
  writeFileSync(prompt, 'You keep the lesson base honest.\n\nYou do not write lessons yourself.\n')

  const h = mount({ role: 'curator', prompts: { curator: prompt } })

  assert.equal(
    h.readSection('deepwork:role-prompt'),
    'You keep the lesson base honest.\n\nYou do not write lessons yourself.\n',
    'mounted verbatim — a prompt is prose, not a template',
  )
  const registration = h.registrations.get('deepwork:role-prompt')
  assert.equal(
    registration?.order,
    PERSONA_ORDER + 1,
    'behind the deployment persona and ahead of the rules it must follow',
  )
  assert.equal(
    registration?.interpolate,
    false,
    'literal, because a prompt is prose and the registry reads braces as references',
  )
})

test('a prompt naming another role is not the one mounted', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-prompt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'curator.txt'), 'curator prompt\n')
  writeFileSync(join(dir, 'contributor.txt'), 'contributor prompt\n')

  const h = mount({
    role: 'contributor',
    prompts: { curator: join(dir, 'curator.txt'), contributor: join(dir, 'contributor.txt') },
  })

  assert.equal(h.readSection('deepwork:role-prompt'), 'contributor prompt\n')
})

test('a prompt file that is not there is reported, and the mode still comes up', (t) => {
  // Refusing to boot over a missing prompt would take the tools down with it, and a prompt is the
  // one part of a mode whose absence degrades manner rather than capability.
  // A scratch directory, so the file is absent by construction rather than by a path that happens
  // not to exist on this machine.
  const dir = mkdtempSync(join(tmpdir(), 'deepwork-role-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = mount({ role: 'curator', prompts: { curator: join(dir, 'absent.txt') } })

  assert.equal(h.sections.has('deepwork:role-prompt'), false)
  assert.ok(
    h.logs.some((line) => line.includes('could not be read') && line.includes('curator')),
    'and it says which role and which file',
  )
})

test('a role with no prompt entry, and an empty prompt, are both said out loud', (t) => {
  const noEntry = mount({ role: 'curator' })
  assert.ok(noEntry.logs.some((line) => line.includes('declares no prompts entry')))

  const dir = mkdtempSync(join(tmpdir(), 'deepwork-prompt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const empty = join(dir, 'curator.txt')
  writeFileSync(empty, '   \n')
  const blank = mount({ role: 'curator', prompts: { curator: empty } })

  assert.equal(blank.sections.has('deepwork:role-prompt'), false)
  assert.ok(blank.logs.some((line) => line.includes('is empty')))
})

test('a mount that states no role mounts nothing, and says which', () => {
  const silent = mount({})
  assert.equal(silent.sections.size, 0)
  assert.ok(silent.logs.some((line) => line.includes('no role configured')))
})
