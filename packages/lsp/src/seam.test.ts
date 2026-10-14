/**
 * The seam: extension routing and the atomicity of registration.
 *
 * Registration is all-or-nothing, and that is what these tests are mostly about. A provider that
 * cannot be registered must publish nothing at all — not its id, not the extensions it did not
 * conflict on — because a half-registered provider is a route pointing at something whose owner was
 * told it failed.
 *
 * @module @zhangcun123/lsp/seam.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createLspRegistry, finalExtension, LspError, LspProviderId } from './seam.ts'
import type { LspProvider, LspProviderQuery, LspQueryResult } from './seam.ts'

/** A provider that records the queries it was given and answers with no locations. */
function provider(id: string, extensionToLanguage: Record<string, string>): LspProvider & { seen: LspProviderQuery[] } {
  const seen: LspProviderQuery[] = []
  return {
    id: LspProviderId(id),
    extensionToLanguage,
    seen,
    async query(request: LspProviderQuery): Promise<LspQueryResult> {
      seen.push(request)
      return { kind: 'locations', locations: [], resolvedWorkspaceUri: 'file:///work' }
    },
  }
}

/** The stable code of the error a thunk throws, or undefined if it threw something else. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof LspError ? error.code : undefined
  }
  return undefined
}

/** A query for one path, with everything else filled in. */
function request(filePath: string): Parameters<ReturnType<typeof createLspRegistry>['query']>[0] {
  return { operation: 'goToDefinition', filePath, position: { line: 0, character: 0 }, workspaceRoot: '/work' }
}

test('a file’s final extension is normalized to a lowercase, leading-dot key', () => {
  assert.equal(finalExtension('src/a.ts'), '.ts')
  assert.equal(finalExtension('Foo.TS'), '.ts')
  assert.equal(finalExtension('types/index.d.ts'), '.ts', 'the last dot wins, so declaration files route as source')
  assert.equal(finalExtension('a\\b\\c.tsx'), '.tsx', 'either separator')
  assert.equal(finalExtension('Makefile'), '', 'no extension')
  assert.equal(finalExtension('.bashrc'), '', 'a dotfile has no extension')
  assert.equal(finalExtension(''), '')
})

test('a query routes by extension, and the provider is told the language id it mapped', async () => {
  const ts = provider('ts', { '.ts': 'typescript', '.tsx': 'typescriptreact' })
  const py = provider('py', { '.py': 'python' })
  const registry = createLspRegistry()
  registry.registerProvider(ts)
  registry.registerProvider(py)

  await registry.query(request('src/a.tsx'))
  await registry.query(request('src/b.py'))

  assert.equal(ts.seen.length, 1)
  assert.deepEqual(ts.seen[0], {
    operation: 'goToDefinition',
    filePath: 'src/a.tsx',
    position: { line: 0, character: 0 },
    workspaceRoot: '/work',
    languageId: 'typescriptreact',
  })
  assert.equal(py.seen[0]?.languageId, 'python')
})

test('a file no provider handles is unavailable, by code rather than by message', async () => {
  const registry = createLspRegistry()
  registry.registerProvider(provider('ts', { '.ts': 'typescript' }))
  const failure = await registry.query(request('a.md')).then(() => undefined, (error: unknown) => error)
  assert.ok(failure instanceof LspError)
  assert.equal(failure.code, 'LSP_UNAVAILABLE')
  assert.match(failure.message, /no LSP provider handles "a\.md"/)
})

test('the caller’s cancellation reaches the provider', async () => {
  const ts = provider('ts', { '.ts': 'typescript' })
  const controller = new AbortController()
  const registry = createLspRegistry()
  registry.registerProvider(ts)
  await registry.query(request('a.ts'), controller.signal)
  assert.equal(ts.seen.length, 1, 'the signal is forwarded, not dropped')
})

test('a provider with no usable identity or mapping is refused before anything is reserved', async () => {
  const registry = createLspRegistry()
  assert.equal(codeOf(() => registry.registerProvider(provider('   ', { '.ts': 'typescript' }))), 'LSP_INVALID_PROVIDER')
  assert.equal(codeOf(() => registry.registerProvider(provider('none', {}))), 'LSP_INVALID_PROVIDER')
  assert.equal(codeOf(() => registry.registerProvider(provider('bad', { '.': 'typescript' }))), 'LSP_INVALID_PROVIDER')
  assert.equal(codeOf(() => registry.registerProvider(provider('empty', { '.ts': '  ' }))), 'LSP_INVALID_PROVIDER')
  assert.equal(codeOf(() => registry.registerProvider(provider('dup', { '.TS': 'typescript', '.ts': 'typescript' }))), 'LSP_INVALID_PROVIDER')
  assert.equal(await registry.query(request('a.ts')).then(() => 'routed', () => 'unavailable'), 'unavailable')
})

test('a second provider cannot take an extension another one owns, and publishes nothing when it tries', async () => {
  const first = provider('first', { '.ts': 'typescript' })
  const second = provider('second', { '.ts': 'typescriptreact', '.js': 'javascript' })
  const registry = createLspRegistry()
  registry.registerProvider(first)

  assert.equal(codeOf(() => registry.registerProvider(second)), 'LSP_CONFLICT')
  await registry.query(request('a.ts'))
  assert.equal(first.seen.length, 1, 'the first provider still owns what it registered')
  assert.equal(
    await registry.query(request('a.js')).then(() => 'routed', () => 'unavailable'),
    'unavailable',
    'and the failed registration did not leave its other extension reserved',
  )
})

test('one provider id cannot be registered twice', () => {
  const registry = createLspRegistry()
  registry.registerProvider(provider('ts', { '.ts': 'typescript' }))
  assert.equal(codeOf(() => registry.registerProvider(provider('ts', { '.tsx': 'typescriptreact' }))), 'LSP_CONFLICT')
})

test('disposing a provider releases its id and every extension it reserved', async () => {
  const registry = createLspRegistry()
  const first = provider('ts', { '.ts': 'typescript', '.tsx': 'typescriptreact' })
  const dispose = registry.registerProvider(first)

  dispose()
  assert.equal(await registry.query(request('a.ts')).then(() => 'routed', () => 'unavailable'), 'unavailable')

  // The same id and the same extensions can be taken again, which is what proves the release.
  const second = provider('ts', { '.ts': 'typescript', '.tsx': 'typescriptreact' })
  registry.registerProvider(second)
  await registry.query(request('a.tsx'))
  assert.equal(second.seen.length, 1)
})
