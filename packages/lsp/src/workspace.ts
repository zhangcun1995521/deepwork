/**
 * Reading a query's source off the local filesystem, and canonicalizing the workspace it is in.
 *
 * Two facts this establishes are load-bearing for everything downstream. A `file:` URI is built from
 * the **resolved** path, so a workspace reached through a symlink is reported to the server under the
 * name the server will see when it indexes; and the same URI is what a location is rendered relative
 * to, so a query answered through an alias does not produce paths pointing at the alias.
 *
 * Containment is checked on resolved paths rather than on the caller's string, and the check is what
 * keeps a **query source** inside the workspace. A location the server returns may be outside it —
 * that is ordinary for a dependency — but a caller cannot make this client open a file elsewhere by
 * asking about it.
 *
 * @module @zhangcun123/lsp/workspace
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { throwIfAborted } from './deadline.ts'

/** A canonical workspace: the identity a server session is pooled on, and the URI it is told. */
export interface HostWorkspace {
  /** Stable filesystem identity used for pooling one server process per workspace. */
  readonly targetKey: string
  /** Canonical absolute path, accepted as a subprocess cwd and as a base for relative sources. */
  readonly canonicalPath: string
  /** Canonical file URI sent to the language server and used to relativize its locations. */
  readonly fileUrl: string
}

/** A validated source and the exact URI sent to the language server. */
export interface HostSource {
  /** Canonical file URI of the source. */
  readonly fileUrl: string
  /** Current complete UTF-8 text. */
  readonly text: string
}

/**
 * Resolve and validate one workspace root.
 * @param workspaceRoot - the caller-supplied workspace path.
 * @param signal - optional cancellation.
 * @returns the canonical identity, path, and file URI.
 * @throws Error when the root cannot be resolved or is not a directory.
 */
export async function canonicalizeWorkspace(workspaceRoot: string, signal?: AbortSignal): Promise<HostWorkspace> {
  throwIfAborted(signal)
  let canonicalPath: string
  try {
    canonicalPath = await realpath(resolve(workspaceRoot))
  } catch (error) {
    throwIfAborted(signal)
    throw new Error(`workspace root "${workspaceRoot}" cannot be resolved: ${messageOf(error)}`, { cause: error })
  }
  throwIfAborted(signal)
  const info = await stat(canonicalPath).catch((error: unknown) => {
    throwIfAborted(signal)
    throw error
  })
  throwIfAborted(signal)
  if (!info.isDirectory()) {
    throw new Error(`workspace root "${workspaceRoot}" is not a directory`)
  }
  return {
    targetKey: canonicalPath,
    canonicalPath,
    fileUrl: pathToFileURL(canonicalPath).href,
  }
}

/**
 * Resolve, contain, validate, and read one query source.
 * @param filePath - the source: relative to the workspace or absolute.
 * @param workspace - an already-canonicalized workspace.
 * @param maxDocumentBytes - the largest source this client will open.
 * @param signal - optional cancellation.
 * @returns the canonical file URI and the current text.
 * @throws Error when the source cannot be resolved, sits outside the workspace, is not a regular
 *   file, is over the byte limit, or is not valid UTF-8.
 */
export async function readHostSource(
  filePath: string,
  workspace: HostWorkspace,
  maxDocumentBytes: number,
  signal?: AbortSignal,
): Promise<HostSource> {
  throwIfAborted(signal)
  let target: string
  try {
    target = await realpath(isAbsolute(filePath) ? filePath : resolve(workspace.canonicalPath, filePath))
  } catch (error) {
    throwIfAborted(signal)
    throw new Error(`source "${filePath}" cannot be resolved: ${messageOf(error)}`, { cause: error })
  }
  throwIfAborted(signal)
  if (!contains(workspace.canonicalPath, target)) {
    throw new Error(`source "${filePath}" resolves outside the workspace`)
  }

  const info = await stat(target).catch((error: unknown) => {
    throwIfAborted(signal)
    throw error
  })
  throwIfAborted(signal)
  if (!info.isFile()) {
    throw new Error(`source "${filePath}" is not a regular file`)
  }
  if (info.size > maxDocumentBytes) {
    throw new Error(
      `source "${filePath}" is ${info.size} bytes, over the ${maxDocumentBytes}-byte limit this client will open`,
    )
  }

  let bytes: Buffer
  try {
    bytes = await readFile(target)
  } catch (error) {
    throwIfAborted(signal)
    throw new Error(`source "${filePath}" could not be read: ${messageOf(error)}`, { cause: error })
  }
  throwIfAborted(signal)
  return { fileUrl: pathToFileURL(target).href, text: decodeUtf8(bytes, filePath) }
}

/**
 * Validate UTF-8 rather than letting Node substitute replacement characters. A mis-decoded document
 * would shift every position the model then counts on, and the failure would look like a wrong answer
 * rather than like a wrong read.
 */
function decodeUtf8(bytes: Buffer, filePath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    throw new Error(`source "${filePath}" is not valid UTF-8: ${messageOf(error)}`, { cause: error })
  }
}

/** Whether a resolved target lies inside a resolved root. */
function contains(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
