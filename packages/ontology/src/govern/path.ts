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

/**
 * Redirect targets, e.g. `echo x > notes.md` or `echo x >> notes.md`.
 *
 * Every spelling that writes a file has to be in the alternatives, and `>|` is the one that was
 * missing: it is bash's "clobber even under noclobber", and because `|` was excluded from the
 * target class below, `echo x >|/outside/f` matched nothing at all — no target, no refusal, and the
 * write happened. `&>` and `&>>` (both streams to one file, bash and pwsh) were missing for the same
 * kind of reason: a shorter alternative that happened to cover the common case.
 */
const REDIRECT = /(?:&>>|&>|>>|>\||>)\s*([^\s|;&]+)/g

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
