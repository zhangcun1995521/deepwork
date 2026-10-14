/**
 * A scriptable language server over stdio, for the client's end-to-end tests.
 *
 * It speaks the real `Content-Length`-framed base protocol, so a test exercises the actual client —
 * framing, the initialize handshake, transient open and close, request mapping, the answers to
 * requests a server sends back, and teardown — with no language server installed and nothing from
 * the host.
 *
 * The framing here is deliberately written out again rather than imported: a fixture that framed its
 * messages with the client's own encoder would agree with the client about a mistake.
 *
 * Behavior is driven by environment variables, so one file backs every scenario:
 * - LSP_FIXTURE_ENCODING: advertised `positionEncoding` (default `utf-16`; `utf-8` forces a mismatch).
 * - LSP_FIXTURE_SYNC: `textDocumentSync` as JSON (default `1`, the legacy Full form).
 * - LSP_FIXTURE_CAPS: extra capabilities as JSON, merged over the defaults (to switch one off).
 * - LSP_FIXTURE_DEF / _REFS / _IMPL / _HOVER: JSON result per operation.
 * - LSP_FIXTURE_ERROR: `1` answers every `textDocument/*` request with a JSON-RPC error.
 * - LSP_FIXTURE_REQUESTS: path to append one JSON line per received method, its params, and the
 *   reply the client gave to a server-initiated request. This is how a test sees what was on the
 *   wire rather than only what came back.
 * - LSP_FIXTURE_ON_OPEN: emit a server→client request when a document opens, one of
 *   `configuration` | `applyEdit` | `unknown`.
 * - LSP_FIXTURE_EXIT_MARKER: path to append `shutdown` / `exit` when those arrive.
 *
 * Run: node fixture-server.mjs
 */

import { appendFileSync } from 'node:fs'

const encoding = process.env.LSP_FIXTURE_ENCODING ?? 'utf-16'
const sync = process.env.LSP_FIXTURE_SYNC === undefined ? 1 : JSON.parse(process.env.LSP_FIXTURE_SYNC)
const extraCapabilities = process.env.LSP_FIXTURE_CAPS === undefined
  ? {}
  : JSON.parse(process.env.LSP_FIXTURE_CAPS)
const errorReply = process.env.LSP_FIXTURE_ERROR === '1'
const requests = process.env.LSP_FIXTURE_REQUESTS
const onOpen = process.env.LSP_FIXTURE_ON_OPEN
const exitMarker = process.env.LSP_FIXTURE_EXIT_MARKER

let buffer = Buffer.alloc(0)
let serverRequestId = 10_000
let openDocument

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const separator = buffer.indexOf('\r\n\r\n')
    if (separator < 0) break
    const header = buffer.toString('ascii', 0, separator)
    const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1])
    const start = separator + 4
    if (!Number.isFinite(length) || buffer.length < start + length) break
    const body = buffer.toString('utf8', start, start + length)
    buffer = buffer.subarray(start + length)
    handle(JSON.parse(body))
  }
})

function handle(message) {
  const { id, method, params } = message

  // A frame with an id and no method is the client's reply to a request this server sent.
  if (method === undefined && id !== undefined) {
    record({ serverRequestReply: { id, result: message.result, error: message.error } })
    return
  }

  // The open document is what most assertions are about, so it is updated before the request itself
  // is recorded: the `didOpen` line carries the document that line opened.
  if (method === 'textDocument/didOpen') openDocument = params?.textDocument
  if (method === 'textDocument/didClose') openDocument = undefined
  record({ method, params })

  if (method === 'initialize') {
    send({
      id,
      result: {
        capabilities: {
          positionEncoding: encoding,
          textDocumentSync: sync,
          definitionProvider: true,
          referencesProvider: true,
          implementationProvider: true,
          hoverProvider: true,
          ...extraCapabilities,
        },
      },
    })
    return
  }
  if (method === 'initialized') return
  if (method === 'shutdown') {
    markExit('shutdown')
    send({ id, result: null })
    return
  }
  if (method === 'exit') {
    markExit('exit')
    process.exit(0)
  }
  if (method === 'textDocument/didOpen') {
    if (onOpen !== undefined) emitServerRequest(onOpen)
    return
  }
  if (method === 'textDocument/didClose') return
  if (method === '$/cancelRequest') return
  if (typeof method === 'string' && method.startsWith('textDocument/')) {
    if (errorReply) {
      send({ id, error: { code: -32000, message: 'the server refused this request' } })
      return
    }
    send({ id, result: resultFor(method) })
    return
  }
  // Anything else with an id gets a null result, so a client can never be left waiting.
  if (id !== undefined) send({ id, result: null })
}

function resultFor(method) {
  switch (method) {
    case 'textDocument/definition': return json('LSP_FIXTURE_DEF', null)
    case 'textDocument/references': return json('LSP_FIXTURE_REFS', null)
    case 'textDocument/implementation': return json('LSP_FIXTURE_IMPL', null)
    case 'textDocument/hover': return json('LSP_FIXTURE_HOVER', { contents: { kind: 'markdown', value: 'hi' } })
    default: return null
  }
}

function json(name, fallback) {
  const raw = process.env[name]
  return raw === undefined ? fallback : JSON.parse(raw)
}

/** Send a request this server initiates, to be answered (or refused) by the client. */
function emitServerRequest(kind) {
  const id = serverRequestId++
  if (kind === 'configuration') {
    send({ id, method: 'workspace/configuration', params: { items: [{ section: 'a' }, { section: 'b' }] } })
    return
  }
  if (kind === 'applyEdit') {
    send({ id, method: 'workspace/applyEdit', params: { edit: {} } })
    return
  }
  send({ id, method: 'window/showMessageRequest', params: {} })
}

function record(entry) {
  if (requests === undefined) return
  appendFileSync(requests, `${JSON.stringify({ ...entry, document: openDocument })}\n`)
}

function markExit(event) {
  if (exitMarker !== undefined) appendFileSync(exitMarker, `${event}\n`)
}

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}

// Keep the event loop alive while the client holds the pipes open.
process.stdin.resume()
