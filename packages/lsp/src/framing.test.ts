/**
 * The base-protocol framing, against the shapes a real server produces: one message split arbitrarily
 * across reads, several in one read, and the two ways a broken server can be refused.
 *
 * @module @zhangcun123/lsp/framing.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { encodeMessage, MessageDecoder } from './framing.ts'

test('one framed message round-trips', () => {
  const decoder = new MessageDecoder(1024)
  assert.deepEqual(decoder.push(encodeMessage({ jsonrpc: '2.0', id: 1, result: null })), [
    { jsonrpc: '2.0', id: 1, result: null },
  ])
})

test('a message split across reads is returned only once it is complete', () => {
  const framed = encodeMessage({ id: 7, result: { ok: true } })
  const decoder = new MessageDecoder(1024)

  assert.deepEqual(decoder.push(framed.subarray(0, 10)), [], 'part of a header is not a message')
  assert.deepEqual(decoder.push(framed.subarray(10, framed.length - 1)), [], 'part of a body is not a message')
  assert.deepEqual(decoder.push(framed.subarray(framed.length - 1)), [{ id: 7, result: { ok: true } }])
})

test('two messages in one read both come back, in arrival order', () => {
  const decoder = new MessageDecoder(1024)
  const chunk = Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 })])
  assert.deepEqual(decoder.push(chunk), [{ id: 1 }, { id: 2 }])
})

test('Content-Length counts bytes, so a multi-byte body is decoded whole', () => {
  const decoder = new MessageDecoder(1024)
  const framed = encodeMessage({ text: 'héllo — 世界' })
  // Split inside the multi-byte character to prove the decoder slices bytes, not characters.
  assert.deepEqual(decoder.push(framed.subarray(0, framed.length - 4)), [])
  assert.deepEqual(decoder.push(framed.subarray(framed.length - 4)), [{ text: 'héllo — 世界' }])
})

test('Content-Length is found whatever its case, and other headers are ignored', () => {
  const body = Buffer.from(JSON.stringify({ id: 3 }), 'utf8')
  const framed = Buffer.concat([
    Buffer.from(`content-length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`, 'ascii'),
    body,
  ])
  assert.deepEqual(new MessageDecoder(1024).push(framed), [{ id: 3 }])
})

test('a header block without Content-Length is an error', () => {
  const decoder = new MessageDecoder(1024)
  assert.throws(
    () => decoder.push(Buffer.from('X-Other: 1\r\n\r\n{}', 'ascii')),
    /missing Content-Length/,
  )
})

test('a body larger than the limit is refused without buffering it', () => {
  const decoder = new MessageDecoder(16)
  const framed = encodeMessage({ text: 'x'.repeat(64) })
  assert.throws(() => decoder.push(framed.subarray(0, 30)), /exceeds the 16-byte limit/)
})

test('a header that never terminates is bounded', () => {
  const decoder = new MessageDecoder(1024)
  assert.throws(() => decoder.push(Buffer.alloc(65_537, 0x41)), /header exceeded/)
})

test('a body that is not JSON is an error naming the body', () => {
  const framed = Buffer.concat([Buffer.from('Content-Length: 5\r\n\r\n', 'ascii'), Buffer.from('{oops', 'ascii')])
  assert.throws(() => new MessageDecoder(1024).push(framed), /not valid JSON/)
})
