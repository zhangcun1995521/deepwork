/**
 * Integration tests for the capability's own `apply`.
 *
 * These exist because of one specific failure. The eight tests beside this one call `runCommand`
 * and `parseJunit` directly, so they cover the work and not the mounting — and the mounting is what
 * broke: the tool's output schema put `required` inside a property, the host rejected the schema,
 * `apply` threw, and the bundle loaded as nothing at all. Every unit test stayed green while the
 * capability was absent from every deployment.
 *
 * So the claims here are the ones only `apply` can make: that the tools reach the registry, that
 * their access is declared to whatever is judging them, and that the manual is offered. Neither the
 * registry nor the governance channel is imported from the host — both are structural, which is
 * what lets this run with no runtime at all.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, type TestRunnerContext } from './index.ts'
import { FAILURE_KINDS } from './junit.ts'

interface Harness {
  ctx: TestRunnerContext
  tools: { name: string; parameters: unknown; output: { schema: unknown } }[]
  declared: { tool: string; access: unknown }[]
  skills: { name: string; description: string; content: string }[]
  logs: string[]
}

function harness(options: { governance?: boolean; skills?: boolean; inject?: boolean } = {}): Harness {
  const state: Harness = {
    tools: [],
    declared: [],
    skills: [],
    logs: [],
    ctx: undefined as unknown as TestRunnerContext,
  }
  const wantsGovernance = options.governance ?? true
  const wantsSkills = options.skills ?? true

  state.ctx = {
    tools: {
      register(tool): void {
        state.tools.push(tool as Harness['tools'][number])
      },
    },
    logger: { warn: (message) => state.logs.push(message) },
    // `inject: false` models a host that exposes no service lookup at all — different from a host
    // that exposes one and has no such service, which is what the other options stand for.
    ...(options.inject === false ? {} : { inject: ((names: readonly string[], callback: (scoped: never) => void) => {
      const scoped: Record<string, unknown> = {}
      if (names.includes('deepworkGovernance')) {
        if (wantsGovernance) {
          scoped.deepworkGovernance = {
            declareTool: (tool: string, access: unknown) => {
              state.declared.push({ tool, access })
              return () => {}
            },
          }
        } else {
          return
        }
      }
      if (names.includes('skills')) {
        if (wantsSkills) {
          scoped.skills = {
            register: (skill: Harness['skills'][number]) => {
              state.skills.push(skill)
              return () => {}
            },
          }
          // The lifetime hook belongs to the context, not to the registry — a fake that put it on
          // the service would let the plugin read the wrong object and still pass.
          scoped.effect = (callback: () => () => void) => callback()
        } else {
          return
        }
      }
      callback(scoped as never)
    }) as TestRunnerContext['inject'] }),
  }
  return state
}

const WORKSPACE = '/work/project'

test('a configured deployment gets its tools, its declaration, and its manual', () => {
  const h = harness()
  apply(h.ctx, { workspace: WORKSPACE })

  assert.deepEqual(
    h.tools.map((tool) => tool.name).sort(),
    ['parse_junit', 'run_tests'],
    'a capability that registers nothing looks exactly like one that failed to load',
  )
  assert.deepEqual(h.declared, [
    { tool: 'run_tests', access: { executes: ['python'] } },
  ])
  assert.deepEqual(h.skills.map((skill) => skill.name), ['run-project-tests'])
})

test('the declared program is the first word of the configured command, not the default forever', () => {
  // The command is deployment configuration, so the program declared to the guard has to follow
  // it — a deployment running its suite through `npm` is judged on `npm`, and one that kept the
  // default would be judged on `python`.
  const h = harness()
  apply(h.ctx, { workspace: WORKSPACE, command: 'npm test {target}' })

  assert.deepEqual(h.declared, [
    { tool: 'run_tests', access: { executes: ['npm'] } },
  ])
})

test('the manual is a skill the registry would accept', () => {
  const h = harness()
  apply(h.ctx, { workspace: WORKSPACE })
  const [manual] = h.skills

  // The registry's own grammar, quoted from its contract. A name outside it is rejected there,
  // silently as far as this package is concerned.
  assert.match(manual?.name ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok((manual?.description.length ?? 0) > 0)
  assert.ok((manual?.content.length ?? 0) > 0)
  // It says how and when, not what — the tool description already answers what.
  assert.match(manual?.content ?? '', /## It reports; it does not record/)
})

test('an unconfigured deployment registers no tool and says why', () => {
  const h = harness()
  apply(h.ctx, {})

  assert.deepEqual(h.tools, [])
  assert.deepEqual(h.skills, [], 'no workspace is no capability, and no manual for one')
  assert.ok(h.logs.some((line) => line.includes('no workspace configured')))
})

test('a profile with no skill registry still gets the tools, and says nothing', () => {
  // The service never appears, which is what `inject` does when nobody provides it — so there is
  // nothing to warn about, because "not yet" and "never" are the same signal from here. The claim
  // that matters is the first one: an optional service being absent must not take the capability
  // with it. The silence is a real limit, and it is named here rather than asserted away.
  const h = harness({ skills: false })
  apply(h.ctx, { workspace: WORKSPACE })

  assert.equal(h.tools.length, 2)
  assert.deepEqual(h.skills, [])
})

test('a profile with no governance channel still gets the tools, and says nothing', () => {
  const h = harness({ governance: false })
  apply(h.ctx, { workspace: WORKSPACE })

  assert.equal(h.tools.length, 2)
  assert.deepEqual(h.declared, [])
})

test('a context with no service lookup at all is reported, because then it is knowable', () => {
  // The one case where the absence *is* knowable: there is no seam to look through, so nothing
  // will ever arrive through it. Said out loud, for both the declaration and the manual.
  const h = harness({ inject: false })
  apply(h.ctx, { workspace: WORKSPACE })

  assert.equal(h.tools.length, 2)
  assert.ok(h.logs.some((line) => line.includes('not governed by the write guard')))
  assert.ok(h.logs.some((line) => line.includes('cannot offer its manual')))
})

test('the manual documents every failure kind the parser can produce', (t) => {
  // The manual is documentation a model will trust, so a claim in it that the code does not support
  // is worse than no manual. This is the one coupling worth pinning: the kinds are a list the test
  // reads, so adding one to `FAILURE_KINDS` without documenting it fails here rather than shipping.
  const h = harness()
  apply(h.ctx, { workspace: WORKSPACE })
  const body = h.skills[0]?.content ?? ''

  for (const kind of FAILURE_KINDS) {
    assert.match(body, new RegExp(`\\*\\*${kind}\\*\\*`), `"${kind}" is not documented`)
  }
  // The distinction the manual got wrong on its first draft: `error` is a status, not a kind — it
  // is the case that never ran, while a kind says how a case that *did* run failed.
  assert.match(body, /`status` says whether the case ran/)
  assert.match(body, /never got as far as its body/)
})

test('a declared command with no target slot is registered anyway, with the narrowing lost', () => {
  const h = harness()
  apply(h.ctx, { workspace: WORKSPACE, command: 'python -m pytest -q' })

  assert.equal(h.tools.length, 2)
  assert.ok(h.logs.some((line) => line.includes('no {target} slot')))
})
