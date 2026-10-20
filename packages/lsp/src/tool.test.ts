/**
 * The `lsp` tool: what the model is offered, and what it gets back.
 *
 * The contract here is the part that must not drift. A prompt says `operation: "hover"` with a
 * one-based `line`, so the tool name, the operation names, the argument names, the coordinate
 * convention, and the prompt text are all pinned verbatim rather than described.
 *
 * The output schema is pinned structurally as well, and for a reason this repository has already
 * paid for once: the runtime enforces a JSON Schema subset and rejects a schema outside it at
 * registration, which takes the plugin's whole `apply` down and leaves a bundle that is installed
 * and inert. So the two rules the subset imposes — `oneOf` stands alone, and every `required` name is
 * declared in `properties` — are checked here rather than discovered in a deployment.
 *
 * @module @zhangcun123/lsp/tool.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LspError } from './seam.ts'
import type { LspQueryRequest, LspQueryResult, LspService } from './seam.ts'
import { MAX_TIMER_DELAY_MS } from './provider.ts'
import {
  DEFAULT_LSP_TOOL_TIMEOUT_MS,
  LSP_PROMPT_ORDER,
  LSP_PROMPT_SECTION,
  LSP_PROMPT_TEXT,
  registerLspTool,
  sessionCwd,
} from './tool.ts'
import type { LspToolConfig, LspToolContext, LspToolExecution, RegisterableTool } from './tool.ts'

/** What one mounted tool looks like from the outside. */
interface Mount {
  tools: RegisterableTool[]
  sections: { name: string; order: number; text: string }[]
  /** Every query the tool passed to the seam, with the signal it was given. */
  seen: { request: LspQueryRequest; signal: AbortSignal | undefined }[]
}

/** Mount the tool over a scripted seam, with no runtime at all. */
function mount(options: { config?: LspToolConfig; answer?: LspQueryResult } = {}): Mount {
  const mounted: Mount = { tools: [], sections: [], seen: [] }
  const answer: LspQueryResult = options.answer ?? {
    kind: 'locations',
    locations: [],
    resolvedWorkspaceUri: 'file:///work',
  }
  const service: LspService = {
    registerProvider: () => () => {},
    async query(request, signal) {
      mounted.seen.push({ request, signal })
      return answer
    },
  }
  const ctx: LspToolContext = {
    tools: {
      register(definition) {
        mounted.tools.push(definition)
      },
    },
    systemPrompt: {
      section(section) {
        mounted.sections.push(section)
      },
    },
  }
  registerLspTool(ctx, service, options.config ?? {})
  return mounted
}

/** The one registered tool, or a failure saying there is none. */
function tool(mounted: Mount): RegisterableTool {
  assert.equal(mounted.tools.length, 1, 'exactly one tool is registered')
  return mounted.tools[0] as RegisterableTool
}

/** A call from an agent whose session workspace is `cwd`. */
function execution(cwd: string | undefined): LspToolExecution {
  return {
    signal: new AbortController().signal,
    ...cwd === undefined ? {} : { agent: { session: { header: { cwd } } } },
  }
}

/** Check one node against the JSON Schema subset the runtime enforces. */
function assertSubsetOfEnforcedSchema(node: Record<string, unknown>, path: string): void {
  if ('oneOf' in node) {
    assert.deepEqual(Object.keys(node), ['oneOf'], `${path}: oneOf stands alone, with no sibling keyword`)
    const branches = node.oneOf as Record<string, unknown>[]
    assert.ok(branches.length >= 2, `${path}: oneOf needs at least two branches`)
    branches.forEach((branch, index) => assertSubsetOfEnforcedSchema(branch, `${path}.oneOf[${index}]`))
    return
  }
  if ('items' in node) assertSubsetOfEnforcedSchema(node.items as Record<string, unknown>, `${path}[]`)
  const properties = node.properties as Record<string, unknown> | undefined
  for (const [name, child] of Object.entries(properties ?? {})) {
    assertSubsetOfEnforcedSchema(child as Record<string, unknown>, `${path}.${name}`)
  }
  for (const name of (node.required as string[] | undefined) ?? []) {
    assert.ok(
      properties !== undefined && name in properties,
      `${path}: required "${name}" must be declared in properties`,
    )
  }
}

test('the tool is named and described as the prompt already expects', () => {
  const registered = tool(mount())
  assert.equal(registered.name, 'lsp')
  assert.equal(
    registered.description,
    'Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, goToImplementation, hover. line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration.',
  )
})

test('the four operations are the schema’s enum, and all four arguments are required', () => {
  const { properties, required } = tool(mount()).parameters as {
    properties: Record<string, { enum?: string[]; description?: string }>
    required: string[]
  }
  assert.deepEqual(properties.operation?.enum, ['goToDefinition', 'findReferences', 'goToImplementation', 'hover'])
  assert.deepEqual(required, ['operation', 'file_path', 'line', 'character'])
  assert.match(String(properties.character?.description), /One-based UTF-16 column/)
})

test('the prompt section is the slot the host reserves for this tool', () => {
  const sections = mount().sections
  assert.equal(sections.length, 1)
  const section = sections[0] as { name: string; order: number; text: string }
  assert.equal(section.name, LSP_PROMPT_SECTION)
  assert.equal(LSP_PROMPT_ORDER, 2200, 'the host’s own SECTION_ORDERS.TOOL_LSP')
  assert.equal(section.order, LSP_PROMPT_ORDER)
  assert.equal(
    section.text,
    'Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration.',
  )
  assert.equal(LSP_PROMPT_TEXT, section.text)
})

test('the timeout budget is attached to the tool and never appears in the schema', () => {
  assert.equal(tool(mount()).timeoutMs, DEFAULT_LSP_TOOL_TIMEOUT_MS)
  assert.equal(tool(mount({ config: { timeoutMs: 5_000 } })).timeoutMs, 5_000, 'a deployment may change it')
  assert.equal(JSON.stringify(tool(mount()).parameters).includes('timeout'), false)
})

test('execute converts the cursor and asks about the session’s workspace', async () => {
  const mounted = mount()
  const result = await tool(mounted).execute(
    { operation: 'goToDefinition', file_path: 'src/a.ts', line: 12, character: 7 },
    execution('/work'),
  )

  assert.deepEqual(mounted.seen[0]?.request, {
    operation: 'goToDefinition',
    filePath: 'src/a.ts',
    position: { line: 11, character: 6 },
    workspaceRoot: '/work',
  })
  assert.deepEqual(result, { kind: 'locations', locations: [], resolvedWorkspaceUri: 'file:///work' })
})

test('a call with no workspace fails as LSP_WORKSPACE_REQUIRED before the language server is asked', async () => {
  const mounted = mount()
  const failure = await tool(mounted)
    .execute({ operation: 'hover', file_path: 'a.ts', line: 1, character: 1 }, execution(undefined))
    .then(() => undefined, (error: unknown) => error)

  assert.ok(failure instanceof LspError)
  assert.equal(failure.code, 'LSP_WORKSPACE_REQUIRED')
  assert.deepEqual(mounted.seen, [], 'no query is sent without a workspace to resolve it against')
})

test('a cursor the model got wrong fails before the seam is touched', async () => {
  const mounted = mount()
  const failure = await tool(mounted)
    .execute({ operation: 'hover', file_path: 'a.ts', line: 0, character: 1 }, execution('/work'))
    .then(() => undefined, (error: unknown) => error)

  assert.ok(failure instanceof Error)
  assert.match(failure.message, /line must be a positive integer/)
  assert.deepEqual(mounted.seen, [])
})

test('the canonical value carries no key the output schema does not declare', async () => {
  const answered = mount({
    answer: { kind: 'hover', hover: { contents: 'text' } },
  })
  const value = await tool(answered).execute(
    { operation: 'hover', file_path: 'a.ts', line: 1, character: 1 },
    execution('/work'),
  )
  assert.deepEqual(value, { kind: 'hover', hover: { contents: 'text' } })
  assert.equal('range' in ((value as { hover: Record<string, unknown> }).hover), false)
})

test('the renderer turns each answer into one block of text, capped', () => {
  const mounted = mount({ config: { maxLocations: 1 } })
  const registered = tool(mounted)
  const located = registered.output.render(
    { operation: 'goToDefinition', file_path: 'a.ts', line: 1, character: 1 },
    {
      kind: 'locations',
      locations: [
        { uri: 'file:///work/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        { uri: 'file:///work/b.ts', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } } },
      ],
      resolvedWorkspaceUri: 'file:///work',
    },
  )
  const args = { operation: 'hover' as const, file_path: 'a.ts', line: 1, character: 1 }
  assert.deepEqual(located, [{ type: 'text', text: 'a.ts:1:1\n… 1 more location omitted (limit 1).' }])
  assert.deepEqual(registered.output.render(args, { kind: 'hover', hover: null }), [
    { type: 'text', text: 'No hover information.' },
  ])
  assert.deepEqual(
    registered.output.render(args, { kind: 'locations', locations: [], resolvedWorkspaceUri: 'file:///work' }),
    [{ type: 'text', text: 'No results.' }],
  )
})

test('the pending call presents the operation and the one-based cursor', () => {
  const presenter = tool(mount()).presentCall
  assert.deepEqual(presenter?.({ operation: 'hover', file_path: 'a.ts', line: 3, character: 4 }), {
    card: 'generic',
    kind: 'search',
    title: 'LSP hover a.ts:3:4',
    locations: [{ path: 'a.ts', line: 3 }],
  })
})

test('the output schema stays inside the subset the runtime enforces', () => {
  assertSubsetOfEnforcedSchema(tool(mount()).output.schema, 'output.schema')
})

test('a non-positive cap or an out-of-range timeout fails the load, and registers nothing', () => {
  for (const config of [{ maxLocations: 0 }, { maxResultChars: -1 }, { timeoutMs: MAX_TIMER_DELAY_MS + 1 }]) {
    const mounted: Mount = { tools: [], sections: [], seen: [] }
    assert.throws(
      () => registerLspTool(mounting(mounted), serviceStub(), config),
      /lsp: (maxLocations|maxResultChars|timeoutMs)/,
    )
    assert.deepEqual(mounted.tools, [], 'nothing is registered when the settings are wrong')
    assert.deepEqual(mounted.sections, [], 'and the prompt is not contributed either')
  }
})

/** The context of an existing mount, so a second registration attempt can be made against it. */
function mounting(mounted: Mount): LspToolContext {
  return {
    tools: { register: definition => { mounted.tools.push(definition) } },
    systemPrompt: { section: section => { mounted.sections.push(section) } },
  }
}

/** A seam that is never reached in these tests. */
function serviceStub(): LspService {
  return {
    registerProvider: () => () => {},
    query: async () => ({ kind: 'locations', locations: [], resolvedWorkspaceUri: 'file:///work' }),
  }
}

test('the session workspace is read from the agent, and a non-agent caller has none', () => {
  assert.equal(sessionCwd(execution('/work')), '/work')
  assert.equal(sessionCwd(execution(undefined)), undefined)
  assert.equal(
    sessionCwd({ signal: new AbortController().signal, agent: { session: { header: {} } } }),
    undefined,
    'an agent without a workspace header has no workspace, rather than a default one',
  )
})

test('a composition with no prompt registry still gets the tool', () => {
  // The plugin used to declare `systemPrompt` in its own `inject`, so a profile without a prompt
  // registry lost the row entirely — the tool disappeared and nothing said why. A capability is a
  // tool first; the section that advertises it is worth having, not worth the tool's absence.
  const tools: RegisterableTool[] = []
  const service: LspService = {
    registerProvider: () => () => {},
    async query() {
      throw new Error('nothing is queried in this test')
    },
  }
  registerLspTool(
    { tools: { register: (definition) => tools.push(definition) } },
    service,
    { maxLocations: 5, maxResultChars: 1000, timeoutMs: 1000 },
  )

  assert.ok(
    tools.some((tool) => tool.name === 'lsp'),
    'the tool is registered with no prompt registry, and no section is attempted',
  )
})
