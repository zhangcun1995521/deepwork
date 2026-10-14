/**
 * Protocol translation: what a server's advertised capabilities permit, and how its payloads
 * normalize.
 *
 * The malformed cases carry as much weight as the well-formed ones. "The server said something this
 * client did not understand" must not arrive at the model looking like "there is nothing here".
 *
 * @module @zhangcun123/lsp/translate.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LspError } from './seam.ts'
import {
  negotiatePositionEncoding,
  normalizeHover,
  normalizeLocations,
  requestMethod,
  supportsOperation,
  supportsTransientOpen,
} from './translate.ts'

/** The stable code of the error a thunk throws, or undefined if it threw something else. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof LspError ? error.code : undefined
  }
  return undefined
}

test('each operation maps to its protocol method', () => {
  assert.equal(requestMethod('goToDefinition'), 'textDocument/definition')
  assert.equal(requestMethod('findReferences'), 'textDocument/references')
  assert.equal(requestMethod('goToImplementation'), 'textDocument/implementation')
  assert.equal(requestMethod('hover'), 'textDocument/hover')
})

test('an operation is supported by its own capability, in either the boolean or the options form', () => {
  const capabilities = {
    definitionProvider: true,
    referencesProvider: {},
    implementationProvider: false,
  }
  assert.equal(supportsOperation(capabilities, 'goToDefinition'), true)
  assert.equal(supportsOperation(capabilities, 'findReferences'), true, 'an options object means supported')
  assert.equal(supportsOperation(capabilities, 'goToImplementation'), false)
  assert.equal(supportsOperation(capabilities, 'hover'), false, 'absent is not supported')
})

test('transient open is implied by the legacy enum and required explicitly by the options form', () => {
  assert.equal(supportsTransientOpen(1), true, 'Full')
  assert.equal(supportsTransientOpen(2), true, 'Incremental')
  assert.equal(supportsTransientOpen(0), false, 'None')
  assert.equal(supportsTransientOpen({ openClose: true }), true)
  assert.equal(supportsTransientOpen({ openClose: false, change: 2 }), false)
  assert.equal(supportsTransientOpen({ change: 1 }), false, 'an omitted openClose defaults to false')
  assert.equal(supportsTransientOpen(undefined), false)
})

test('an omitted position encoding defaults to utf-16 and anything else is refused', () => {
  assert.equal(negotiatePositionEncoding(undefined), 'utf-16')
  assert.equal(negotiatePositionEncoding('utf-16'), 'utf-16')
  assert.throws(() => negotiatePositionEncoding('utf-8'), /unsupported position encoding "utf-8"/)
})

test('a single Location, an array, and null all normalize', () => {
  const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
  assert.deepEqual(normalizeLocations({ uri: 'file:///a.ts', range }), [{ uri: 'file:///a.ts', range }])
  assert.deepEqual(
    normalizeLocations([{ uri: 'file:///a.ts', range }, { uri: 'file:///b.ts', range }]),
    [{ uri: 'file:///a.ts', range }, { uri: 'file:///b.ts', range }],
  )
  assert.deepEqual(normalizeLocations(null), [])
  assert.deepEqual(normalizeLocations([]), [])
})

test('a LocationLink focuses its selection range, not the whole target', () => {
  const targetRange = { start: { line: 0, character: 0 }, end: { line: 40, character: 0 } }
  const targetSelectionRange = { start: { line: 4, character: 6 }, end: { line: 4, character: 12 } }
  assert.deepEqual(
    normalizeLocations([{ targetUri: 'file:///a.ts', targetRange, targetSelectionRange }]),
    [{ uri: 'file:///a.ts', range: targetSelectionRange }],
  )
})

test('a navigation payload this client cannot read is a structured failure, not an empty result', () => {
  assert.equal(codeOf(() => normalizeLocations(undefined)), 'LSP_MALFORMED_RESPONSE')
  assert.equal(codeOf(() => normalizeLocations([42])), 'LSP_MALFORMED_RESPONSE')
  assert.equal(codeOf(() => normalizeLocations({ uri: 'file:///a.ts' })), 'LSP_MALFORMED_RESPONSE')
  assert.equal(
    codeOf(() => normalizeLocations({ uri: 'file:///a.ts', range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } })),
    'LSP_MALFORMED_RESPONSE',
    'a negative coordinate is not a position',
  )
  assert.equal(
    codeOf(() => normalizeLocations({ uri: 'file:///a.ts', range: { start: { line: 0, character: 1.5 }, end: { line: 0, character: 0 } } })),
    'LSP_MALFORMED_RESPONSE',
    'a fractional coordinate is not a position',
  )
})

test('hover normalizes all three content encodings', () => {
  assert.deepEqual(
    normalizeHover({ contents: { kind: 'markdown', value: '**bold**' } }),
    { contents: '**bold**' },
  )
  assert.deepEqual(normalizeHover({ contents: 'plain' }), { contents: 'plain' })
  assert.deepEqual(
    normalizeHover({ contents: { language: 'ts', value: 'const x = 1' } }),
    { contents: '```ts\nconst x = 1\n```' },
  )
  assert.deepEqual(
    normalizeHover({ contents: ['first', { language: 'ts', value: 'second' }] }),
    { contents: 'first\n\n```ts\nsecond\n```' },
  )
})

test('a hover range is carried through, and its absence is absence', () => {
  const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }
  assert.deepEqual(normalizeHover({ contents: 'x', range }), { contents: 'x', range })
  assert.equal('range' in (normalizeHover({ contents: 'x' }) ?? {}), false)
})

test('no hover is null, and a hover that says nothing is no hover', () => {
  assert.equal(normalizeHover(null), null)
  assert.equal(normalizeHover({ contents: { kind: 'plaintext', value: '' } }), null)
})

test('a hover payload this client cannot read is a structured failure', () => {
  assert.equal(codeOf(() => normalizeHover(undefined)), 'LSP_MALFORMED_RESPONSE')
  assert.equal(codeOf(() => normalizeHover('nonsense')), 'LSP_MALFORMED_RESPONSE')
  assert.equal(codeOf(() => normalizeHover({})), 'LSP_MALFORMED_RESPONSE')
  assert.equal(codeOf(() => normalizeHover({ contents: { kind: 'markdown' } })), 'LSP_MALFORMED_RESPONSE')
  assert.equal(codeOf(() => normalizeHover({ contents: ['ok', 7] })), 'LSP_MALFORMED_RESPONSE')
  assert.equal(
    codeOf(() => normalizeHover({ contents: 'x', range: { start: { line: 0 }, end: { line: 0, character: 0 } } })),
    'LSP_MALFORMED_RESPONSE',
  )
})
