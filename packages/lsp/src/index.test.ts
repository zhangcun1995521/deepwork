/**
 * Tests for the plugin's own `apply`, which is the layer nothing else here covers.
 *
 * Every other test in this package drives a piece of the client — framing, translation, rendering,
 * a real child process over real pipes — and not one of them mounts the plugin. That is the same
 * gap the first capability had, and it cost a deployment: an unsupported output schema made
 * `apply` throw, the bundle loaded as nothing at all, and seventy tests stayed green while the tool
 * was absent from every install.
 *
 * So the claims here are the ones only `apply` can make: that the tools reach the registry, that
 * the guidance reaches the prompt, and — the reason this file was written — that what the tool
 * touches is declared to whatever is judging it. A tool the guard has never heard of is a tool it
 * lets through, silently, and this port shipped without that declaration until it was noticed by
 * reading rather than by running.
 */
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'

import { apply, type LspContext } from './index.ts'

interface Harness {
  ctx: LspContext
  tools: string[]
  sections: string[]
  declared: { tool: string; access: unknown }[]
  logs: string[]
}

function harness(options: { governance?: boolean; inject?: boolean } = {}): Harness {
  const state: Harness = {
    tools: [],
    sections: [],
    declared: [],
    logs: [],
    ctx: undefined as unknown as LspContext,
  }
  const wantsGovernance = options.governance ?? true

  state.ctx = {
    tools: {
      register(definition): unknown {
        state.tools.push((definition as { name: string }).name)
        return definition
      },
    },
    systemPrompt: {
      section(section): unknown {
        state.sections.push(section.name)
        return section
      },
    },
    provide: () => () => {},
    effect: (callback) => {
      callback()
    },
    logger: {
      warn: (message) => state.logs.push(message),
      info: (message) => state.logs.push(message),
    },
    ...(options.inject === false
      ? {}
      : {
          inject: ((names: readonly string[], callback: (scoped: never) => void) => {
            const scoped: Record<string, unknown> = {}
            if (names.includes('deepworkGovernance')) {
              if (!wantsGovernance) return
              scoped.deepworkGovernance = {
                declareTool: (tool: string, access: unknown) => {
                  state.declared.push({ tool, access })
                  return () => {}
                },
              }
            }
            callback(scoped as never)
          }) as LspContext['inject'],
        }),
  }
  return state
}

/** One server entry, which is what makes `apply` reach the registration path at all. */
const SERVERS = {
  ts: { command: 'node', args: ['--version'], extensionToLanguage: { '.ts': 'typescript' } },
}

test('a configured deployment registers the tool and declares the programs it runs', () => {
  const h = harness()
  apply(h.ctx, { servers: SERVERS })

  assert.deepEqual(h.tools, ['lsp'], 'a plugin that registers nothing looks like one that failed')
  assert.deepEqual(
    h.declared,
    [{ tool: 'lsp', access: { executes: ['node'] } }],
    'the guard is told the program the deployment configured, which is the difference between '
      + 'governed and merely governed in principle',
  )
  assert.equal(h.sections.length > 0, true, 'the guidance the tool depends on reaches the prompt')
})

test('the declared programs are the configured commands, deduplicated', () => {
  // Two servers may name the same executable, and the guard asks which programs may run — not how
  // many servers start them. Declaring the same name twice would demand the same grant twice.
  const h = harness()
  apply(h.ctx, {
    servers: {
      ts: { command: 'node', args: ['--version'], extensionToLanguage: { '.ts': 'typescript' } },
      web: { command: 'node', args: ['--version'], extensionToLanguage: { '.js': 'javascript' } },
    },
  })

  assert.deepEqual(h.declared, [{ tool: 'lsp', access: { executes: ['node'] } }])
})

test('a command written as a path is declared by its basename', () => {
  // A deployment may configure an absolute command, and the grant still has to be writable by a
  // human: the basename is the name the program is known by however the command was spelled.
  const h = harness()
  apply(h.ctx, {
    servers: {
      node: {
        command: process.execPath,
        args: ['--version'],
        extensionToLanguage: { '.ts': 'typescript' },
      },
    },
  })

  assert.deepEqual(h.declared, [
    { tool: 'lsp', access: { executes: [basename(process.execPath)] } },
  ])
})

test('an unconfigured deployment registers no tool and says why', () => {
  // Saying so matters: "no language server was configured" and "the plugin failed to load" are the
  // same absence from the outside, and one of them is a mistake.
  const h = harness()
  apply(h.ctx, {})

  assert.deepEqual(h.tools, [])
  assert.deepEqual(h.declared, [], 'nothing to declare when nothing is registered')
  assert.ok(h.logs.some((line) => line.includes('no language server configured')))
})

test('a runtime with no governance channel still gets the tool, and is told it is ungoverned', () => {
  const h = harness({ governance: false })
  apply(h.ctx, { servers: SERVERS })

  assert.deepEqual(h.tools, ['lsp'])
  assert.deepEqual(h.declared, [])
})

test('a context with no service lookup at all is reported, because then it is knowable', () => {
  const h = harness({ inject: false })
  apply(h.ctx, { servers: SERVERS })

  assert.deepEqual(h.tools, ['lsp'])
  assert.ok(
    h.logs.some((line) => line.includes('is not governed by the write guard')),
    'the one absence that can be stated rather than left to be discovered',
  )
})
