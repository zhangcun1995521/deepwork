/**
 * Rendering and the coordinate convention.
 *
 * The conversion is the part worth pinning: a model asks for a position one-based, the protocol
 * answers zero-based, and an off-by-one here would send every navigation question to the wrong line
 * while every test that only checked a return type stayed green.
 *
 * @module @zhangcun123/lsp/render.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { LspLocation } from './seam.ts'
import {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatHover,
  formatLocations,
  LSP_OPERATIONS,
  parseLspArgs,
  presentLspCall,
  renderUri,
} from './render.ts'

/** A location at a zero-based position, in the workspace the tests share. */
function location(path: string, line: number, character: number): LspLocation {
  return {
    uri: `file:///work/${path}`,
    range: { start: { line, character }, end: { line, character: character + 1 } },
  }
}

test('the model’s one-based cursor becomes the protocol’s zero-based position', () => {
  assert.deepEqual(
    parseLspArgs({ operation: 'goToDefinition', file_path: 'src/a.ts', line: 3, character: 5 }),
    {
      operation: 'goToDefinition',
      filePath: 'src/a.ts',
      position: { line: 2, character: 4 },
    },
  )
})

test('the four operations are the whole surface, and no other name is accepted', () => {
  assert.deepEqual(LSP_OPERATIONS, ['goToDefinition', 'findReferences', 'goToImplementation', 'hover'])
  assert.throws(
    () => parseLspArgs({ operation: 'rename', file_path: 'a.ts', line: 1, character: 1 }),
    /operation must be one of goToDefinition, findReferences, goToImplementation, hover/,
  )
})

test('an empty file path and a non-positive or fractional cursor are refused before anything is queried', () => {
  assert.throws(() => parseLspArgs({ operation: 'hover', file_path: '  ', line: 1, character: 1 }), /file_path/)
  assert.throws(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 0, character: 1 }), /line must be a positive integer/)
  assert.throws(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 1, character: 1.5 }), /character must be a positive integer/)
})

test('locations render one per line as path:line:character, converted back to one-based', () => {
  const text = formatLocations([location('a.ts', 0, 0), location('b.ts', 41, 2)], 'file:///work', 100, 1000)
  assert.equal(text, 'a.ts:1:1\nb.ts:42:3')
})

test('no locations is a distinct answer, not an empty string', () => {
  assert.equal(formatLocations([], 'file:///work', 100, 1000), 'No results.')
})

test('a capped result says how much it left out', () => {
  const text = formatLocations(
    [location('a.ts', 0, 0), location('a.ts', 1, 0), location('a.ts', 2, 0)],
    'file:///work',
    2,
    1000,
  )
  assert.equal(text, 'a.ts:1:1\na.ts:2:1\n… 1 more location omitted (limit 2).')
  const many = formatLocations(
    Array.from({ length: 5 }, (_unused, index) => location('a.ts', index, 0)),
    'file:///work',
    1,
    1000,
  )
  assert.match(many, /… 4 more locations omitted \(limit 1\)\.$/, 'and it counts properly in the plural')
})

test('the character cap includes the truncation notice it appends', () => {
  const many = Array.from({ length: 20 }, (_unused, index) => location(`directory/with/a/long/name-${index}.ts`, index, 0))
  const text = formatLocations(many, 'file:///work', 100, 60)
  assert.equal(text.length, 60, 'the complete result, notice included, is exactly the cap')
  assert.match(text, /… locations truncated \(limit 60 characters\)\.$/)
})

test('a hover renders its content, and no hover renders a distinct answer', () => {
  assert.equal(formatHover({ contents: 'const answer: number' }, 1000), 'const answer: number')
  assert.equal(formatHover(null, 1000), 'No hover information.')
  const capped = formatHover({ contents: 'y'.repeat(200) }, 60)
  assert.equal(capped.length, 60)
  assert.match(capped, /… hover truncated \(limit 60 characters\)\.$/)
})

test('a file URI inside the workspace renders relative, in the workspace’s own path style', () => {
  assert.equal(renderUri('file:///work/src/a.ts', 'file:///work'), 'src/a.ts')
  assert.equal(renderUri('file:///work', 'file:///work'), '.')
  // The URI does not carry its world’s OS, so a drive letter decides it — the same reading for both.
  assert.equal(renderUri('file:///C:/work/src/a.ts', 'file:///C:/work'), 'src/a.ts')
  assert.equal(renderUri('file:///C:/work/src/a.ts', 'file:///c:/work'), 'src/a.ts')
})

test('a file URI outside the workspace renders absolute, and a foreign URI verbatim', () => {
  assert.equal(renderUri('file:///C:/other/b.ts', 'file:///C:/work'), 'C:/other/b.ts')
  assert.equal(renderUri('file:///other/b.ts', 'file:///work'), '/other/b.ts')
  assert.equal(renderUri('https://example.test/a.ts', 'file:///work'), 'https://example.test/a.ts')
  assert.equal(renderUri('untitled:Untitled-1', 'file:///work'), 'untitled:Untitled-1')
})

test('a URI that cannot be decoded is shown as the server wrote it, not dropped', () => {
  assert.equal(renderUri('file:///work/%ZZ', 'file:///work'), 'file:///work/%ZZ')
  assert.equal(renderUri('file:///work/a.ts', 'not a url'), 'file:///work/a.ts')
})

test('the pending call presents the operation, the one-based cursor, and the file', () => {
  assert.deepEqual(
    presentLspCall({ operation: 'findReferences', file_path: 'src/a.ts', line: 7, character: 3 }),
    {
      card: 'generic',
      kind: 'search',
      title: 'LSP findReferences src/a.ts:7:3',
      locations: [{ path: 'src/a.ts', line: 7 }],
    },
  )
})

test('the defaults are the documented caps', () => {
  assert.equal(DEFAULT_MAX_LOCATIONS, 100)
  assert.equal(DEFAULT_MAX_RESULT_CHARS, 16_000)
})
