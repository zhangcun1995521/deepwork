/**
 * Three tools, split by what a mistake would cost.
 *
 * Why not one tool with a `command` argument: then `git log` and `git push --force` have the same
 * authority. A capability's first act of governance is separating the risk levels, because authority,
 * audit and refusal are all keyed on the tool name.
 *
 *   git_read     status / diff / log / show / blame / ls-files / rev-parse / describe / reflog / fetch
 *   git_change   branch(base) / switch / add / commit / restore / stash / revert / cherry-pick / merge / worktree
 *   git_publish  push (never the default branch, size-limited) / tag
 *
 * **There is no `pull`, and no "sync" group.** Grouping fetch with pull as "sync" was a mistake:
 *   - `fetch` downloads objects and moves `origin/*`. It does not touch the working tree, so it is a read.
 *   - `pull` merges somebody else's commits into the branch you are using. An agent should not have that.
 * To work on the latest code: `worktree add -b agent/x <path> origin/main` — newest code, separate
 * directory, separate branch, and the branch in use is untouched.
 *
 * Several actions have **no entry point at all** (not "forbidden and require approval"): push --force,
 * reset --hard, clean, rebase, filter-branch, submodule, writing config, installing hooks. The first
 * group is irreversible; the last two are **privilege paths** — `core.hooksPath` plus a committed
 * script is arbitrary code on the next commit, which would walk around everything else here.
 */

import type { RunnerOptions } from './repo.ts'
import { GitRefusal, currentBranch, diffLineCount, insideRoot, runGit } from './repo.ts'

/** A JSON Schema subset, enough for the host to validate arguments. */
export interface JsonSchemaNode {
  type?: string
  description?: string
  enum?: readonly string[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: readonly string[]
}

/** A tool as the runtime's registry accepts it. */
export interface GitTool {
  name: string
  description: string
  parameters: JsonSchemaNode
  output: {
    schema: JsonSchemaNode
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

/** What the tools return to the model. */
export interface GitToolResult {
  /** Which tool and action ran. */
  action: string
  ok: boolean
  /** git's own output. */
  output: string
  /** Derived facts: branch, diff size, cleanliness. */
  facts?: Record<string, string | number | boolean>
  /** Why it was refused, always with what to do instead. */
  refusal?: string
}

/** Shared by all three tools. */
const RESULT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'Which tool and action ran.' },
    ok: { type: 'boolean', description: 'Whether git exited 0.' },
    output: { type: 'string', description: 'What git printed.' },
    facts: { type: 'object', description: 'Derived facts: branch, diffLines, conflicts.' },
    refusal: { type: 'string', description: 'Why it was refused, and what to do instead.' },
  },
  required: ['action', 'ok', 'output'],
}

/** Render a result as the prose the model reads. */
function render(tool: string, value: unknown): Array<{ type: 'text'; text: string }> {
  const result = value as GitToolResult
  const lines = [`${result.action || tool}  ${result.ok ? 'ok' : 'FAILED'}`]
  if (result.refusal !== undefined) lines.push('', `refused: ${result.refusal}`)
  if (result.facts !== undefined && Object.keys(result.facts).length > 0) {
    lines.push('', ...Object.entries(result.facts).map(([key, fact]) => `  ${key}=${String(fact)}`))
  }
  if (result.output.length > 0) lines.push('', result.output.slice(0, 8000))
  return [{ type: 'text', text: lines.join('\n') }]
}

/** A required string argument. A missing one is an error, never a default — a typo in the argument
 * name must not silently run a different action. */
function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitRefusal(`argument "${name}" is required and must be a non-empty string`)
  }
  return value
}

/** An optional string argument. */
function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Construction options. */
export interface ToolOptions extends RunnerOptions {
  /** Allow pushing. Default **false**: a capability that can publish the moment it is installed is
   * one whose default has to be "no". */
  allowPush?: boolean
  /** Refuse a push whose pending diff exceeds this many lines. Default 400 — a change too large to
   * read is one nobody reviews properly. */
  maxDiffLines?: number
}

/** Branch names that are never pushed by this tool. */
const DEFAULT_BRANCHES = ['main', 'master', 'trunk', 'develop']

/** Build the three tools. */
export function buildGitTools(options: ToolOptions): GitTool[] {
  const root = options.root

  /** Run one command and attach the facts a caller needs. */
  const exec = (
    action: string,
    argv: readonly string[],
    extra: Record<string, string | number | boolean> = {},
  ): GitToolResult => {
    const result = runGit({ root, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, argv)
    const isDiff = argv[0] === 'diff'
    const facts: Record<string, string | number | boolean> = {
      branch: currentBranch(root),
      ...(isDiff ? { diffLines: diffLineCount(result.output) } : {}),
      ...extra,
    }
    return { action, ok: result.ok, output: result.output, facts }
  }

  /** A refusal that says what to do instead — "no" on its own invites the same attempt again. */
  const refuse = (action: string, reason: string): GitToolResult => ({
    action,
    ok: false,
    output: '',
    refusal: reason,
  })

  /**
   * How large the pending change is, in changed lines.
   *
   * Three fallbacks, each naming its base explicitly. The first version derived the base by splitting
   * the range string, which broke on `HEAD~1..HEAD` (two dots): `rev-parse --verify` then failed, and
   * the function returned 0 — so the size limit did not exist, and 0 is exactly what "no problem"
   * looks like. A size that cannot be measured is `undefined`, and a caller must treat that as a
   * refusal rather than as zero.
   */
  const pendingLines = (): number | undefined => {
    const attempts: Array<readonly [string, string]> = [
      ['@{u}', '@{u}...HEAD'],
      ['origin/HEAD', 'origin/HEAD...HEAD'],
      ['HEAD~1', 'HEAD~1..HEAD'],
    ]
    for (const [base, range] of attempts) {
      if (!runGit({ root }, ['rev-parse', '--verify', '--quiet', base]).ok) continue
      const diff = runGit({ root }, ['diff', range])
      if (diff.ok) return diffLineCount(diff.output)
    }
    return undefined
  }

  const tools: GitTool[] = [
    {
      name: 'git_read',
      description:
        'Read a repository: status, diff, log, show, blame, ls-files, rev-parse, describe, reflog, fetch. ' +
        'Nothing here changes the working tree — `fetch` downloads objects and moves the remote-tracking ' +
        'pointer, which is why it lives here. There is no `pull`: to work on the latest code, create a ' +
        'worktree from `origin/main` instead.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'describe', 'reflog', 'fetch'],
            description: 'Which read.',
          },
          path: { type: 'string', description: 'Narrow to one file (diff / blame / show). Optional.' },
          rev: { type: 'string', description: 'Revision or range: HEAD~1, main...feature. Optional.' },
          lines: { type: 'string', description: 'For blame: a line range like "10,20". Optional.' },
          remote: { type: 'string', description: 'For fetch: remote name, e.g. origin. Optional.' },
        },
        required: ['action'],
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => render('git_read', value) },
      async execute(args) {
        const action = requireString(args, 'action')
        const path = optionalString(args, 'path')
        const rev = optionalString(args, 'rev')
        const file = path === undefined ? undefined : insideRoot(root, path)
        const lines = optionalString(args, 'lines')
        switch (action) {
          case 'status':
            return exec('git_read.status', ['status', '--porcelain=v1', '--branch'])
          case 'diff':
            return exec('git_read.diff', ['diff', ...(rev === undefined ? [] : [rev]), '--', ...(file === undefined ? [] : [file])])
          case 'log':
            return exec('git_read.log', ['log', '--oneline', '--decorate', '-n', '30', ...(rev === undefined ? [] : [rev])])
          case 'show':
            return exec('git_read.show', ['show', '--stat', '--patch', ...(rev === undefined ? ['HEAD'] : [rev])])
          case 'blame':
            if (file === undefined) throw new GitRefusal('blame needs "path"')
            return exec('git_read.blame', ['blame', '--date=short', ...(lines === undefined ? [] : ['-L', lines]), '--', file])
          case 'ls-files':
            return exec('git_read.ls-files', ['ls-files', ...(file === undefined ? [] : ['--', file])])
          case 'rev-parse':
            return exec('git_read.rev-parse', ['rev-parse', rev ?? 'HEAD'])
          case 'describe':
            return exec('git_read.describe', ['describe', '--tags', '--always', rev ?? 'HEAD'])
          case 'reflog':
            // Read-only: after a branch is deleted by accident this is the only lead. The write side
            // (`reflog expire`) is on the never-allowed list.
            return exec('git_read.reflog', ['reflog', '--date=iso', '-n', '30'])
          case 'fetch':
            // Downloads and moves `origin/*` only — no working-tree change, hence this tool.
            return exec('git_read.fetch', ['fetch', ...(optionalString(args, 'remote') === undefined ? [] : [optionalString(args, 'remote') as string])])
          default:
            return refuse(
              `git_read.${action}`,
              `unknown read action "${action}"; allowed: status, diff, log, show, blame, ls-files, rev-parse, describe, reflog, fetch`,
            )
        }
      },
    },

    {
      name: 'git_change',
      description:
        'Change the working tree or local history: branch (with an optional base such as origin/main), switch, ' +
        'add, commit, restore, stash, revert, cherry-pick, merge, worktree-add, worktree-remove. Never touches a ' +
        'remote. There is no reset --hard and no rebase: rewriting history needs a human at a keyboard. A merge ' +
        'that conflicts stops and reports the files — resolving a conflict means deciding what the other change ' +
        'was for, and that is not a mechanical act.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['branch', 'switch', 'add', 'commit', 'restore', 'stash', 'revert', 'cherry-pick', 'merge', 'worktree-add', 'worktree-remove'],
            description: 'Which change.',
          },
          name: { type: 'string', description: 'Branch name, or the worktree path for worktree-remove.' },
          base: { type: 'string', description: 'For branch: where the new branch starts, e.g. origin/main. Defaults to HEAD.' },
          path: { type: 'string', description: 'File to stage or restore.' },
          message: { type: 'string', description: 'Commit message, or stash message.' },
          rev: { type: 'string', description: 'For revert / cherry-pick / merge: the commit or branch.' },
          worktree: { type: 'string', description: 'For worktree-add: absolute path for the new working copy, outside this repository.' },
        },
        required: ['action'],
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => render('git_change', value) },
      async execute(args) {
        const action = requireString(args, 'action')
        const path = optionalString(args, 'path')
        const message = optionalString(args, 'message')
        switch (action) {
          case 'branch': {
            const branch = requireString(args, 'name')
            const base = optionalString(args, 'base') ?? 'HEAD'
            return exec('git_change.branch', ['switch', '-c', branch, base], { base })
          }
          case 'switch':
            return exec('git_change.switch', ['switch', requireString(args, 'name')])
          case 'add':
            return exec('git_change.add', ['add', '--', insideRoot(root, path ?? '.')])
          case 'commit': {
            const body = requireString(args, 'message')
            // The author is the agent, passed with `-c` so no global configuration is touched: an audit
            // has to be able to tell "who changed it" from "who approved it".
            return exec('git_change.commit', ['-c', 'user.name=deepwork agent', '-c', 'user.email=agent@deepwork.local', 'commit', '-m', body])
          }
          case 'restore':
            return exec('git_change.restore', ['restore', '--worktree', '--', insideRoot(root, requireString(args, 'path'))])
          case 'stash':
            return exec('git_change.stash', ['stash', 'push', ...(message === undefined ? [] : ['-m', message])])
          case 'revert':
            return exec('git_change.revert', ['revert', '--no-edit', requireString(args, 'rev')])
          case 'cherry-pick':
            return exec('git_change.cherry-pick', ['cherry-pick', requireString(args, 'rev')])
          case 'merge': {
            const target = requireString(args, 'rev')
            const result = exec('git_change.merge', ['merge', '--no-edit', target])
            // A conflict is a stop signal, not a puzzle: the model has no way to know what the other
            // side was trying to do.
            if (!result.ok) {
              const conflicts = runGit({ root }, ['diff', '--name-only', '--diff-filter=U'])
              const list = conflicts.ok ? conflicts.output.trim() : ''
              return {
                ...result,
                facts: { ...result.facts, ...(list.length === 0 ? {} : { conflicts: list.split('\n').length }) },
                refusal:
                  'merge did not complete. If there are conflicts, stop and hand them to a person: resolving a ' +
                  'conflict means deciding what the other change was for. ' +
                  (list.length === 0 ? '' : `Conflicting files:\n${list}`),
              }
            }
            return result
          }
          case 'worktree-add': {
            const target = requireString(args, 'worktree')
            const branch = requireString(args, 'name')
            // The worktree may live outside the repository (a temp directory would), but never inside
            // it: a nested copy makes it impossible to tell which of the two changes one is looking at.
            if (insideRootOrNull(root, target) !== null) {
              return refuse('git_change.worktree-add', 'the worktree path is inside this repository; put it somewhere else so the two copies cannot be confused')
            }
            return exec('git_change.worktree-add', ['worktree', 'add', '-b', branch, target, optionalString(args, 'base') ?? 'HEAD'], { path: target })
          }
          case 'worktree-remove': {
            const target = requireString(args, 'name')
            return exec('git_change.worktree-remove', ['worktree', 'remove', '--force', target], { path: target })
          }
          default:
            return refuse(
              `git_change.${action}`,
              `unknown change action "${action}"; allowed: branch, switch, add, commit, restore, stash, revert, cherry-pick, merge, worktree-add, worktree-remove`,
            )
        }
      },
    },

    {
      name: 'git_publish',
      description:
        'Publish: push a feature branch, or tag a commit. Refused unless the deployment enabled pushing; refused ' +
        'for the default branch; refused when the pending change is larger than the configured limit, or when its ' +
        'size cannot be measured. There is no force push — to replace a broken branch, push a new one.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['push', 'tag'], description: 'Which publish.' },
          branch: { type: 'string', description: 'For push: the branch. Must not be a default branch.' },
          name: { type: 'string', description: 'For tag: tag name.' },
          message: { type: 'string', description: 'For tag: annotation.' },
        },
        required: ['action'],
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => render('git_publish', value) },
      async execute(args) {
        const action = requireString(args, 'action')

        if (options.allowPush !== true) {
          return refuse(
            `git_publish.${action}`,
            'pushing is disabled in this deployment (allowPush is not true). A capability that can publish the ' +
              'moment it is installed is one whose default has to be "no" — the deployment says yes, the tool ' +
              'does not assume it.',
          )
        }

        switch (action) {
          case 'push': {
            const branch = requireString(args, 'branch')
            if (DEFAULT_BRANCHES.includes(branch)) {
              return refuse(
                'git_publish.push',
                `refusing to push "${branch}" directly. Push a feature branch and open a change request — the ` +
                  'default branch is the one place a mistake reaches everyone.',
              )
            }
            const lines = pendingLines()
            const limit = options.maxDiffLines ?? 400
            if (lines === undefined) {
              return refuse(
                'git_publish.push',
                'cannot tell how large this change is (no upstream, no origin/HEAD, no parent commit). A publish ' +
                  'whose size cannot be measured is one nobody sized — fetch the remote, or push from a branch ' +
                  'that has history.',
              )
            }
            if (lines > limit) {
              return refuse(
                'git_publish.push',
                `the pending change is ${lines} lines, over the limit of ${limit}. Split it, or have a person look ` +
                  'at it first: a change too large to read is one nobody will review properly.',
              )
            }
            return exec('git_publish.push', ['push', '-u', 'origin', branch], { diffLines: lines })
          }
          case 'tag': {
            const tag = requireString(args, 'name')
            return exec('git_publish.tag', ['tag', '-a', tag, '-m', optionalString(args, 'message') ?? tag])
          }
          default:
            return refuse(`git_publish.${action}`, `unknown publish action "${action}"; allowed: push, tag`)
        }
      },
    },
  ]

  /**
   * Turn an argument-level refusal into a result rather than an exception.
   *
   * The model has to read "why not, and what instead"; an exception does not reliably carry that
   * refusal text through every host. Genuine internal errors (git missing, say) still throw — that is
   * a broken implementation, not a policy decision.
   */
  return tools.map((tool) => ({
    ...tool,
    execute: async (args: Record<string, unknown>) => {
      try {
        return await tool.execute(args)
      } catch (error) {
        if (error instanceof GitRefusal) return refuse(tool.name, error.message)
        throw error
      }
    },
  }))
}

/** The path when it is inside the repository, otherwise null. Used for the "not inside" check. */
function insideRootOrNull(root: string, path: string): string | null {
  try {
    return insideRoot(root, path)
  } catch {
    return null
  }
}
