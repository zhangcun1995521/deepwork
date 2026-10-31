/**
 * Running git: the only place a git process is started.
 *
 * Three rules live here because nothing else can guarantee them:
 *
 * 1. **No shell.** Arguments are passed as an array, never joined into a string. This repository has
 *    already paid for the lesson once: a `--markdown "text with spaces"` call routed through a Windows
 *    shell was split into several positional arguments, the error was buried in stderr, and the last
 *    step of a working pipeline failed silently. Commit messages and paths with spaces are safe here.
 * 2. **An allow-list, twice.** Each tool exposes a fixed set of actions (see `tools.ts`); this layer
 *    refuses any argument on the never-allowed list. Blacklists miss (`reset --hard HEAD~3`, `-q`,
 *    aliases) — the real defence is not offering the action at all.
 * 3. **Paths stay inside.** The repository root is configuration; a tool may not step outside it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** A git action was refused. Carries the reason so the model can read it and choose another shape. */
export class GitRefusal extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'GitRefusal'
  }
}

/**
 * Arguments that are never passed to git.
 *
 * They are not listed so they can be refused — none of them is reachable through any tool's action
 * table. They are listed as a second line of defence: a bug or a misconfiguration that forwards an
 * argument straight to git lands here instead of rewriting history.
 */
export const FORBIDDEN_PATTERNS = [
  '--force',
  '-f',
  '--hard',
  '--no-verify',
  '--mirror',
  '--prune',
  'filter-branch',
  'filter-repo',
  'reflog',
  'expire',
  'gc',
  'clean',
  'submodule',
] as const

/** The outcome of one command. */
export interface GitResult {
  ok: boolean
  /** Standard output; the standard error when the command failed. */
  output: string
  /** Exit code. */
  code: number
}

/** Runner configuration. */
export interface RunnerOptions {
  /** Repository root (absolute). Tools cannot act outside it. */
  root: string
  /** Per-command timeout, milliseconds. */
  timeoutMs?: number
}

/**
 * Resolve a path and refuse it when it leaves the repository.
 *
 * @param root - Repository root.
 * @param path - Path from the tool (relative or absolute).
 * @returns The absolute path, known to be inside the root.
 * @throws GitRefusal when the path escapes.
 */
export function insideRoot(root: string, path: string): string {
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new GitRefusal(`path "${path}" is outside the configured repository root; only this repository may be touched`)
  }
  return target
}

/**
 * Run one git command.
 *
 * @param options - Repository root and timeout.
 * @param argv - The argument array, never through a shell.
 * @returns The result; a non-zero exit does not throw, because "not found" and "failed" have to stay
 *   distinguishable by the caller.
 * @throws GitRefusal when an argument is on the never-allowed list.
 */
export function runGit(options: RunnerOptions, argv: readonly string[]): GitResult {
  for (const arg of argv) {
    if (FORBIDDEN_PATTERNS.includes(arg as (typeof FORBIDDEN_PATTERNS)[number])) {
      throw new GitRefusal(
        `argument "${arg}" is on the never-allowed list (force push, hard reset, clean, filter-branch, ` +
          'submodule, gc) — these rewrite or destroy history, so no tool offers them',
      )
    }
    // Prefixed spellings would otherwise walk around the list: `--force-with-lease` is a force push.
    if (/^--force/.test(arg)) {
      throw new GitRefusal(`argument "${arg}" starts with --force; force pushes are never allowed`)
    }
  }

  try {
    const output = execFileSync('git', argv, {
      cwd: options.root,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
      // The point of the whole module: no shell, so spaces, quotes and non-ASCII stay arguments.
      shell: false,
    })
    return { ok: true, output, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number; killed?: boolean; message?: string }
    const code = failure.status ?? (failure.killed === true ? 124 : 1)
    return {
      ok: false,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() || (failure.message ?? 'git failed'),
      code,
    }
  }
}

/** Whether this directory is a git repository. */
export function isRepository(path: string): boolean {
  return existsSync(resolve(path, '.git'))
}

/** Repository root, with symlinks resolved so Windows junctions cannot defeat a path comparison. */
export function repositoryRoot(path: string): string {
  const result = runGit({ root: path }, ['rev-parse', '--show-toplevel'])
  if (!result.ok) throw new GitRefusal(`not a git repository: ${path} (${result.output.slice(0, 200)})`)
  const root = result.output.trim()
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

/** Current branch; empty on a detached HEAD. */
export function currentBranch(root: string): string {
  const result = runGit({ root }, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return result.ok ? result.output.trim() : ''
}

/** Whether the working tree has no pending change. */
export function isClean(root: string): boolean {
  const result = runGit({ root }, ['status', '--porcelain'])
  return result.ok && result.output.trim().length === 0
}

/** Lines changed by a patch, ignoring the `---` / `+++` file headers. */
export function diffLineCount(patch: string): number {
  return patch
    .split('\n')
    .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
    .length
}
