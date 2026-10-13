/**
 * Pure helpers for the write guard: where a call would write, and whether that
 * place is inside a directory the caller's role may touch.
 *
 * Nothing here knows about the runtime or about any business domain. The guard
 * built on top of it is the only place that sees *every* tool call, which is what
 * makes it the right home for this check: a permission rule that only covers the
 * tools we wrote ourselves is a rule the model can walk around by calling the
 * filesystem tool it was given for free.
 *
 * @module @zhangcun123/ontology/govern/path
 */

import { isAbsolute, relative, resolve } from 'node:path'

/** Tools that write to a path they name in their arguments. */
export const WRITE_TOOLS: readonly string[] = ['edit', 'write']

/**
 * Tools that can write without ever naming a path argument.
 *
 * Both shells are listed because the platform ships a bash tool and a PowerShell
 * tool and disables one per platform: checking only the one that happens to be
 * enabled today is how a guard ends up covering nothing on the other OS.
 */
export const SHELL_TOOLS: readonly string[] = ['bash', 'pwsh']

/**
 * Pull the target path out of a write tool's arguments.
 *
 * The field name is not guaranteed by anything, so every name the shipped tools
 * have used is tried. Returning `undefined` is meaningful rather than convenient:
 * the caller treats "a write tool with no discoverable path" as a denial, because
 * the alternative is a guard that silently stops guarding the moment a field is
 * renamed.
 */
export function extractPathFromArgs(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const field of ['path', 'file_path', 'filename', 'file', 'content_path']) {
    const value = record[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Redirect targets, e.g. `echo x > notes.md` or `echo x >> notes.md`. */
const REDIRECT = /(?:>>|>)\s*([^\s|;&]+)/g

/** `tee` targets, e.g. `echo x | tee notes.md`. */
const TEE = /\btee\s+(?:-[a-zA-Z]+\s+)*([^\s|;&]+)/g

/**
 * Device files are not workspace writes: `2>/dev/null` is not an escape.
 *
 * Checked on the token as written, before resolution, because on Windows
 * `resolve(cwd, '/dev/null')` becomes `D:/dev/null` and no longer looks like a
 * device path at all.
 */
function isDevicePath(token: string): boolean {
  return token.startsWith('/dev/') || /^[A-Za-z]:\/dev\//.test(token)
}

/**
 * Extract every path a shell command would write through redirection.
 *
 * This covers `>` and `>>` and `tee`. It does not cover a command that writes
 * through its own logic — `python -c "open(...)"`, `cp`, `mv`, `sed -i` all write
 * files without a redirection character. Treating those as covered would be a
 * claim the code cannot support, so it is documented as a gap instead; see
 * `guard.ts` for how the guard reports what it does not cover.
 *
 * Paths come back in the platform's own form, because every consumer compares
 * them with `node:path` rather than as strings.
 */
export function extractPathsFromShell(command: unknown, cwd: string): string[] {
  if (typeof command !== 'string' || command.length === 0) return []
  const found: string[] = []
  for (const pattern of [REDIRECT, TEE]) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(command)) !== null) {
      const raw = match[1]
      if (raw === undefined || isDevicePath(raw)) continue
      found.push(resolve(cwd, raw))
    }
  }
  return found
}

/**
 * True when `target` sits inside `base`.
 *
 * A path equal to the base is not "inside" it: the base is a directory the caller
 * may write *into*, not a file it may overwrite. `relative` is used rather than a
 * string prefix so that `.../cases-extra` is not mistaken for a child of `.../cases`.
 */
export function isInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}
