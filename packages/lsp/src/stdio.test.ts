/**
 * The client, end to end, against a real language server process.
 *
 * "Real" here means a real child process speaking the real base protocol over real pipes. The
 * fixture is a server this repository owns rather than a compiler somebody has to install, and
 * nothing in this file touches the host — which is what lets the whole client, including the parts
 * that only exist as a running process, be tested on any machine.
 *
 * Two rules this file follows, both learned by breaking them:
 *
 * - **Every test tears the server down in a `finally`**, so an assertion that fails on the way leaves
 *   no process behind. A leaked child holds its workspace directory open, which turns the next
 *   cleanup into a Windows `EBUSY` and hangs the run rather than failing it.
 * - **An assertion about what the server received waits for the server to have read it.** The client
 *   awaits the *write* of a notification, not the server's handling of it, so a marker file read
 *   immediately after a query is a race. Waiting is what makes the claim about a decision instead of
 *   about timing.
 *
 * @module @zhangcun123/lsp/stdio.test
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { LspError } from './seam.ts'
import type { LspService } from './seam.ts'
import { createLspRegistry } from './seam.ts'
import { createLocalProvider, resolveServerConfig } from './provider.ts'
import type { LocalProvider, LspServerConfig } from './provider.ts'

const FIXTURE = fileURLToPath(new URL('../tests/fixture-server.mjs', import.meta.url))

/** A mounted registry with one fixture-backed server, and the scratch directories it works in. */
interface Harness {
  registry: LspService
  provider: LocalProvider
  /** The workspace a query resolves against: holds `a.ts` and nothing else. */
  root: string
  /** The parent of the workspace, holding the markers and a source deliberately outside it. */
  scratch: string
  /** The resolved path of the workspace source, made the same way the client resolves it. */
  source: string
  /** Every message the server has read so far, in order. */
  requests: () => Promise<Record<string, unknown>[]>
  /** Stop the server, then remove the scratch directories. Safe to call twice. */
  dispose: () => Promise<void>
}

/**
 * Mount the client over the fixture, in a fresh scratch directory holding one readable source file.
 * @param env - fixture behavior for this test.
 * @param config - server configuration overrides, merged over the mapping and bounds every test needs.
 */
async function mount(env: Record<string, string>, config: Partial<LspServerConfig> = {}): Promise<Harness> {
  const scratch = await mkdtemp(join(tmpdir(), 'lsp-stdio-'))
  const root = join(scratch, 'workspace')
  await mkdir(root)
  await writeFile(join(root, 'a.ts'), 'const answer = 42\nexport { answer }\n', 'utf8')
  await writeFile(join(scratch, 'outside.ts'), 'export {}\n', 'utf8')
  const marker = join(scratch, 'requests.jsonl')
  const exitMarker = join(scratch, 'exit.jsonl')

  const resolved = resolveServerConfig('fixture', {
    command: process.execPath,
    args: [FIXTURE],
    extensionToLanguage: { '.ts': 'typescript' },
    env: { LSP_FIXTURE_REQUESTS: marker, LSP_FIXTURE_EXIT_MARKER: exitMarker, ...env },
    ...config,
  })
  const provider = createLocalProvider('fixture', resolved, process.execPath)
  const registry = createLspRegistry()
  const disposer = registry.registerProvider(provider)

  return {
    registry,
    provider,
    root,
    scratch,
    source: await realpath(join(root, 'a.ts')),
    requests: async () => {
      const text = await readFile(marker, 'utf8').catch(() => '')
      return text.trim() === ''
        ? []
        : text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    },
    dispose: async () => {
      disposer()
      await provider.disposeAll()
      await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

/**
 * Wait until the server has read enough to make a claim about, and return what it has read.
 * @param harness - the mounted server.
 * @param describe - what the test is waiting for, named in the failure.
 * @param done - whether the recorded messages now support the claim.
 */
async function until(
  harness: Harness,
  describe: string,
  done: (received: Record<string, unknown>[]) => boolean,
): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const received = await harness.requests()
    if (done(received)) return received
    await delay(10)
  }
  throw new Error(`the server never ${describe}`)
}

/** Whether the server has read one message of a method. */
function has(received: Record<string, unknown>[], method: string): boolean {
  return received.some(entry => entry.method === method)
}

/** The one request of a method, or a failure naming what did arrive instead. */
function only(received: Record<string, unknown>[], method: string): Record<string, unknown> {
  const matches = received.filter(entry => entry.method === method)
  assert.equal(matches.length, 1, `expected one ${method}; received ${received.map(e => e.method).join(', ')}`)
  return matches[0] as Record<string, unknown>
}

/** A query against the harness workspace, with only what a test cares about filled in. */
function query(harness: Harness, overrides: Record<string, unknown> = {}): Parameters<LspService['query']>[0] {
  return {
    operation: 'hover',
    filePath: 'a.ts',
    position: { line: 0, character: 1 },
    workspaceRoot: harness.root,
    ...overrides,
  } as Parameters<LspService['query']>[0]
}

/** Turn a rejection into a value, so a test can assert on the failure itself. */
function failed(error: unknown): Error {
  assert.ok(error instanceof Error, `expected an Error; received ${String(error)}`)
  return error
}

test('the source on disk is what the server is told about, and the document closes after', async () => {
  const harness = await mount({
    LSP_FIXTURE_DEF: JSON.stringify({
      uri: 'file:///nowhere.ts',
      range: { start: { line: 3, character: 2 }, end: { line: 3, character: 8 } },
    }),
  })
  try {
    const result = await harness.registry.query(query(harness, { operation: 'goToDefinition', position: { line: 0, character: 6 } }))

    assert.equal(result.kind, 'locations')
    assert.deepEqual(
      result.kind === 'locations' ? result.locations : [],
      [{ uri: 'file:///nowhere.ts', range: { start: { line: 3, character: 2 }, end: { line: 3, character: 8 } } }],
    )

    const received = await until(harness, 'closed the document it opened', seen => has(seen, 'textDocument/didClose'))
    const document = only(received, 'textDocument/didOpen').document as Record<string, unknown>
    assert.equal(document.languageId, 'typescript', 'the language id comes from the extension mapping')
    assert.equal(document.version, 1)
    assert.equal(document.text, 'const answer = 42\nexport { answer }\n', 'the current bytes, not a cached copy')
    assert.equal(fileURLToPath(document.uri as string), harness.source, 'the canonical path, not the path as asked')
    assert.deepEqual(only(received, 'textDocument/definition').params, {
      textDocument: { uri: document.uri },
      position: { line: 0, character: 6 },
    })
  } finally {
    await harness.dispose()
  }
})

test('findReferences always asks for the declaration', async () => {
  const harness = await mount({ LSP_FIXTURE_REFS: JSON.stringify([]) })
  try {
    await harness.registry.query(query(harness, { operation: 'findReferences', position: { line: 2, character: 7 } }))
    const received = await until(harness, 'received the references request', seen => has(seen, 'textDocument/references'))
    const params = only(received, 'textDocument/references').params as Record<string, unknown>
    assert.deepEqual(params.context, { includeDeclaration: true })
    assert.deepEqual(params.position, { line: 2, character: 7 })
  } finally {
    await harness.dispose()
  }
})

test('hover content comes back normalized, fenced and joined', async () => {
  const harness = await mount({
    LSP_FIXTURE_HOVER: JSON.stringify({ contents: [{ language: 'ts', value: 'const x: number' }, 'and a note'] }),
  })
  try {
    const result = await harness.registry.query(query(harness))
    assert.deepEqual(result, { kind: 'hover', hover: { contents: '```ts\nconst x: number\n```\n\nand a note' } })
  } finally {
    await harness.dispose()
  }
})

test('an operation the server does not advertise is refused before a document is opened', async () => {
  const harness = await mount({ LSP_FIXTURE_CAPS: JSON.stringify({ hoverProvider: false }) })
  try {
    const failure = failed(await harness.registry.query(query(harness)).then(() => undefined, (error: unknown) => error))
    assert.ok(failure instanceof LspError)
    assert.equal(failure.code, 'LSP_UNSUPPORTED_OPERATION')
    const received = await harness.requests()
    assert.equal(has(received, 'textDocument/didOpen'), false)
  } finally {
    await harness.dispose()
  }
})

test('a server that will not open and close documents is refused', async () => {
  const harness = await mount({ LSP_FIXTURE_SYNC: JSON.stringify({ openClose: false, change: 2 }) })
  try {
    const failure = failed(await harness.registry.query(query(harness)).then(() => undefined, (error: unknown) => error))
    assert.ok(failure instanceof LspError)
    assert.equal(failure.code, 'LSP_UNSUPPORTED_OPERATION')
  } finally {
    await harness.dispose()
  }
})

test('a server that negotiates anything but utf-16 fails rather than shifting every position', async () => {
  const harness = await mount({ LSP_FIXTURE_ENCODING: 'utf-8' })
  try {
    const failure = failed(await harness.registry.query(query(harness)).then(() => undefined, (error: unknown) => error))
    assert.match(failure.message, /unsupported position encoding "utf-8"/)
  } finally {
    await harness.dispose()
  }
})

test('an error response surfaces the server’s own message', async () => {
  const harness = await mount({ LSP_FIXTURE_ERROR: '1' })
  try {
    const failure = failed(await harness.registry.query(query(harness)).then(() => undefined, (error: unknown) => error))
    assert.match(failure.message, /the server refused this request/)
  } finally {
    await harness.dispose()
  }
})

test('workspace/configuration is answered from the configured value', async () => {
  const harness = await mount(
    { LSP_FIXTURE_ON_OPEN: 'configuration' },
    { configuration: { setting: 'from the deployment' } },
  )
  try {
    await harness.registry.query(query(harness))
    const received = await until(harness, 'been answered', seen => seen.some(entry => entry.serverRequestReply !== undefined))
    const reply = received.find(entry => entry.serverRequestReply !== undefined)?.serverRequestReply
    assert.deepEqual(reply, {
      id: 10_000,
      result: [{ setting: 'from the deployment' }, { setting: 'from the deployment' }],
    })
  } finally {
    await harness.dispose()
  }
})

test('workspace/applyEdit is refused: answering a server is not a second write path', async () => {
  const harness = await mount({ LSP_FIXTURE_ON_OPEN: 'applyEdit' })
  try {
    await harness.registry.query(query(harness))
    const received = await until(harness, 'been answered', seen => seen.some(entry => entry.serverRequestReply !== undefined))
    const reply = received.find(entry => entry.serverRequestReply !== undefined)?.serverRequestReply as Record<string, unknown>
    assert.match(String((reply.error as Record<string, unknown> | undefined)?.message), /applyEdit is not permitted/)
  } finally {
    await harness.dispose()
  }
})

test('a source outside the workspace is refused before any server starts', async () => {
  const harness = await mount({})
  try {
    const failure = failed(
      await harness.registry
        .query(query(harness, { filePath: join(harness.scratch, 'outside.ts') }))
        .then(() => undefined, (error: unknown) => error),
    )
    assert.match(failure.message, /resolves outside the workspace/)
    assert.deepEqual(await harness.requests(), [], 'no server process should have been started')
  } finally {
    await harness.dispose()
  }
})

test('a source that is not UTF-8 is refused rather than read as replacement characters', async () => {
  const harness = await mount({})
  try {
    await writeFile(join(harness.root, 'latin.ts'), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0xe9]))
    const failure = failed(
      await harness.registry
        .query(query(harness, { filePath: 'latin.ts' }))
        .then(() => undefined, (error: unknown) => error),
    )
    assert.match(failure.message, /is not valid UTF-8/)
  } finally {
    await harness.dispose()
  }
})

test('a source over the configured limit is refused', async () => {
  const harness = await mount({}, { maxDocumentBytes: 8 })
  try {
    const failure = failed(await harness.registry.query(query(harness)).then(() => undefined, (error: unknown) => error))
    assert.match(failure.message, /over the 8-byte limit/)
  } finally {
    await harness.dispose()
  }
})

test('a workspace root that is not a directory is refused', async () => {
  const harness = await mount({})
  try {
    const failure = failed(
      await harness.registry
        .query(query(harness, { workspaceRoot: harness.source }))
        .then(() => undefined, (error: unknown) => error),
    )
    assert.match(failure.message, /is not a directory/)
  } finally {
    await harness.dispose()
  }
})

test('a missing workspace root fails with the root named', async () => {
  const harness = await mount({})
  try {
    const failure = failed(
      await harness.registry
        .query(query(harness, { workspaceRoot: join(harness.scratch, 'no-such-directory') }))
        .then(() => undefined, (error: unknown) => error),
    )
    assert.match(failure.message, /cannot be resolved/)
  } finally {
    await harness.dispose()
  }
})

test('one process serves a second query, and every document it opens is closed', async () => {
  const harness = await mount({})
  try {
    await harness.registry.query(query(harness))
    await harness.registry.query(query(harness))
    const received = await until(
      harness,
      'closed both documents',
      seen => seen.filter(entry => entry.method === 'textDocument/didClose').length === 2,
    )
    assert.equal(received.filter(entry => entry.method === 'initialize').length, 1, 'one workspace, one process')
    assert.equal(received.filter(entry => entry.method === 'textDocument/didOpen').length, 2)
  } finally {
    await harness.dispose()
  }
})

test('teardown asks the server to shut down and then to exit, and afterwards refuses to query', async () => {
  const harness = await mount({})
  try {
    await harness.registry.query(query(harness))
    await harness.provider.disposeAll()
    const exit = await readFile(join(harness.scratch, 'exit.jsonl'), 'utf8')
    assert.deepEqual(exit.trim().split('\n'), ['shutdown', 'exit'], 'a graceful stop, in the protocol’s order')

    const after = failed(await harness.provider.query(query(harness)).then(() => undefined, (error: unknown) => error))
    assert.ok(after instanceof LspError)
    assert.equal(after.code, 'LSP_DISPOSED')
  } finally {
    await harness.dispose()
  }
})
