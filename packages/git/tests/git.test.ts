/**
 * The capability's acceptance cases.
 *
 * Real repositories (a temp directory plus a bare remote), never mocked: the failures here live in git
 * semantics — where a branch starts, who the author is, whether the trunk is pushable, how size is
 * counted — and a mocked version would smooth exactly those over.
 *
 * Eight cases, matching the reasons this package exists:
 *   1. a read changes nothing
 *   2. a branch can start at origin/main — how an agent gets the newest code
 *   3. the commit author is the agent, not a person
 *   4. pushing is off by default, and still refuses the trunk when on
 *   5. a change over the size limit is refused
 *   6. the dangerous actions have no entry point
 *   7. a path outside the repository is refused
 *   8. `apply` registers three tools, one skill, and declares writes only for the writers
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/index.ts'
import { GitRefusal, FORBIDDEN_PATTERNS, diffLineCount, runGit } from '../src/repo.ts'
import { buildGitTools, type GitTool, type GitToolResult } from '../src/tools.ts'

/** A real repository with a bare remote behind it. */
function fixture(): { root: string; remote: string; git: (args: string[]) => string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'dw-git-'))
  const root = join(base, 'repo')
  const remote = join(base, 'remote.git')
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '--bare', '-q', remote])
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  git(['config', 'user.email', 'human@example.com'])
  git(['config', 'user.name', 'human'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['checkout', '-q', '-b', 'main'])
  writeFileSync(join(root, 'a.txt'), 'one\n', 'utf8')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
  git(['remote', 'add', 'origin', remote])
  git(['push', '-q', '-u', 'origin', 'main'])
  return { root, remote, git, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

/** Look one tool up. */
function tool(tools: GitTool[], name: string): GitTool {
  const found = tools.find((candidate) => candidate.name === name)
  assert.ok(found !== undefined, `missing tool ${name}`)
  return found
}

/** Run one action. */
async function act(tools: GitTool[], name: string, args: Record<string, unknown>): Promise<GitToolResult> {
  return (await tool(tools, name).execute(args)) as GitToolResult
}

test('a read changes nothing, and counts the diff', async () => {
  const { root, git, cleanup } = fixture()
  try {
    const tools = buildGitTools({ root })
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n', 'utf8')

    const diff = await act(tools, 'git_read', { action: 'diff' })
    assert.equal(diff.ok, true)
    assert.equal(diff.facts?.['diffLines'], 1, 'one added line is one line')

    // Read the status again: the file is still uncommitted, so the read changed nothing.
    const status = await act(tools, 'git_read', { action: 'status' })
    assert.match(status.output, /M a\.txt/)
    assert.equal(git(['status', '--porcelain']).trim(), 'M a.txt')
  } finally {
    cleanup()
  }
})

test('a branch can start at origin/main — how an agent gets the newest code', async () => {
  const { root, git, cleanup } = fixture()
  try {
    // The remote moves on while local main stays behind: somebody merged something.
    // No second clone here: a clone checks out whatever the bare remote's HEAD points at, which makes
    // the test fail on clone semantics instead of on what it meant to test. One commit pushed to the
    // remote's main has the same meaning and less noise.
    git(['checkout', '-q', '-b', 'advance'])
    git(['-c', 'user.email=o@e.com', '-c', 'user.name=o', 'commit', '-q', '--allow-empty', '-m', 'remote moves on'])
    git(['push', '-q', 'origin', 'advance:main'])
    git(['checkout', '-q', 'main'])

    const tools = buildGitTools({ root })
    await act(tools, 'git_read', { action: 'fetch' })
    const branch = await act(tools, 'git_change', { action: 'branch', name: 'agent/fix', base: 'origin/main' })
    assert.equal(branch.ok, true, branch.output)

    // The new branch must start at origin/main (one commit ahead of local main), not at local HEAD.
    assert.equal(git(['rev-parse', 'HEAD']).trim(), git(['rev-parse', 'origin/main']).trim())
  } finally {
    cleanup()
  }
})

test('the commit author is the agent, not a person', async () => {
  const { root, git, cleanup } = fixture()
  try {
    const tools = buildGitTools({ root })
    writeFileSync(join(root, 'b.txt'), 'new\n', 'utf8')
    await act(tools, 'git_change', { action: 'add', path: '.' })
    const commit = await act(tools, 'git_change', { action: 'commit', message: 'add b with spaces in the message' })
    assert.equal(commit.ok, true, commit.output)
    assert.equal(git(['log', '-1', '--format=%an <%ae>']).trim(), 'deepwork agent <agent@deepwork.local>')
  } finally {
    cleanup()
  }
})

test('pushing is off by default, and the trunk is refused even when it is on', async () => {
  const { root, cleanup } = fixture()
  try {
    const closed = buildGitTools({ root })
    const refused = await act(closed, 'git_publish', { action: 'push', branch: 'agent/x' })
    assert.equal(refused.ok, false)
    assert.match(refused.refusal ?? '', /disabled/i)

    const open = buildGitTools({ root, allowPush: true })
    const main = await act(open, 'git_publish', { action: 'push', branch: 'main' })
    assert.equal(main.ok, false)
    assert.match(main.refusal ?? '', /feature branch/i)
  } finally {
    cleanup()
  }
})

test('a change over the size limit is refused', async () => {
  const { root, git, cleanup } = fixture()
  try {
    const tools = buildGitTools({ root, allowPush: true, maxDiffLines: 5 })
    assert.equal((await act(tools, 'git_change', { action: 'branch', name: 'agent/big' })).ok, true)

    // Ten changed lines against a limit of five.
    writeFileSync(join(root, 'big.txt'), Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n'), 'utf8')
    git(['add', '-A'])
    await act(tools, 'git_change', { action: 'commit', message: 'big change' })

    const push = await act(tools, 'git_publish', { action: 'push', branch: 'agent/big' })
    assert.equal(push.ok, false)
    assert.match(push.refusal ?? '', /over the limit/i)
  } finally {
    cleanup()
  }
})

test('the dangerous actions have no entry point, and the runner refuses them anyway', async () => {
  const { root, cleanup } = fixture()
  try {
    const tools = buildGitTools({ root, allowPush: true })

    // pull / rebase / reset are not in any action table.
    for (const [name, action] of [
      ['git_read', 'pull'],
      ['git_change', 'rebase'],
      ['git_change', 'reset'],
    ] as const) {
      const result = await act(tools, name, { action })
      assert.equal(result.ok, false, `${name}.${action} must not succeed`)
      assert.match(result.refusal ?? '', /unknown/i)
    }

    // Even if an argument were forwarded, the runner refuses it.
    assert.ok(FORBIDDEN_PATTERNS.includes('--force'))
    assert.throws(() => runGit({ root }, ['push', '--force', 'origin', 'main']), GitRefusal)
    assert.throws(() => runGit({ root }, ['reset', '--hard']), GitRefusal)
  } finally {
    cleanup()
  }
})

test('a path outside the repository is refused', async () => {
  const { root, cleanup } = fixture()
  try {
    const tools = buildGitTools({ root })
    const outside = await act(tools, 'git_read', { action: 'blame', path: '../outside.txt' })
    // Out of bounds is a refusal with a reason — not an exception, and not "not found".
    assert.equal(outside.ok, false)
    assert.match(outside.refusal ?? '', /outside the configured repository root/)
  } finally {
    cleanup()
  }
})

test('apply registers three tools and a skill, and declares writes only for the writers', () => {
  const { root, cleanup } = fixture()
  try {
    const registered: string[] = []
    const declared: Array<{ tool: string; access: Record<string, unknown> }> = []
    const skills: string[] = []

    apply(
      {
        tools: { register: (gitTool) => registered.push(gitTool.name) },
        logger: { warn: () => {} },
        inject: ((names: readonly string[], callback: (scoped: never) => void) => {
          const scoped: Record<string, unknown> = {}
          if (names.includes('skills')) {
            scoped['skills'] = { register: (skill: { name: string }) => (skills.push(skill.name), () => {}) }
            scoped['effect'] = (run: () => unknown) => run()
          }
          if (names.includes('deepworkGovernance')) {
            scoped['deepworkGovernance'] = {
              declareTool: (toolName: string, access: Record<string, unknown>) => {
                declared.push({ tool: toolName, access })
                return () => {}
              },
            }
          }
          callback(scoped as never)
        }) as never,
      },
      { root },
    )

    assert.deepEqual(registered.sort(), ['git_change', 'git_publish', 'git_read'])
    assert.deepEqual(skills, ['git-workflow'], 'SKILL.md is what the skill carries')

    // Only the two writing tools declare a path.
    const read = declared.find((entry) => entry.tool === 'git_read')
    const change = declared.find((entry) => entry.tool === 'git_change')
    assert.equal(read?.access['writes'], undefined)
    assert.ok(Array.isArray(change?.access['writes']))
    assert.deepEqual(read?.access['executes'] as string[], ['git'])
  } finally {
    cleanup()
  }
})

test('the diff count ignores file headers', () => {
  const patch = ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '-old', '+new', ' context'].join('\n')
  assert.equal(diffLineCount(patch), 2, 'only - and + lines count, never --- / +++')
})
