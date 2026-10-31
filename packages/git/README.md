# @zhangcun123/git

Operate one repository from an agent, with the risk levels kept apart.

```bash
dsh plugin --profile web add @zhangcun123/git
```

## Why a capability and not "let the agent run git"

An agent can already run `git` through a shell. It does, and that is the problem: in one shell tool,
`git log` and `git push --force` have the same authority. Every governance question — who may publish,
what gets audited, what can be refused — is answered by a tool name, so the actions have to be separate
tool names.

Three tools, split by what a mistake would cost:

| Tool | Actions | Declares | Authority |
|---|---|---|---|
| `git_read` | status, diff, log, show, blame, ls-files, rev-parse, describe, reflog, **fetch** | `executes: [git]` | everyone |
| `git_change` | branch (with `base`), switch, add, commit, restore, stash, revert, cherry-pick, merge, worktree-add/remove | `executes: [git]`, `writes: [root]` | grantable |
| `git_publish` | push (never the default branch), tag | `executes: [git]` | off by default |

`fetch` sits in the read tool because it downloads objects and moves `origin/*` without touching the
working tree. **There is no `pull`.** To work on the latest code, create a worktree from `origin/main`:
`worktree-add` with `base=origin/main` gives the newest code, a separate directory and a separate branch,
and leaves the branch you are using untouched.

## What has no tool at all

`push --force` (`-f`, `--force-with-lease`), `reset --hard`, `clean`, `rebase`, `filter-branch`,
`submodule`, writing `config`, installing hooks.

These are not "forbidden and require approval" — they have no entry point, so no role map, no approval
policy and no guard bug can reach them. The last two are there because they are **privilege paths**:
`core.hooksPath` plus a committed script is arbitrary code execution on the next commit, and
`url.<x>.insteadOf` can point a push at another repository. A capability that offers those has
offered a way around itself.

The argument for the rest is that a safe path exists: to replace a bad branch, push a new one; to undo
working-tree damage, `restore` and `stash`. Where no safe path exists (`clean -fd` deletes untracked
files for good), an agent simply does not get the action.

## Two limits that are enforced, not documented

- **Pushing is off unless the deployment turns it on.** A capability that can publish the moment it is
  installed is one whose default has to be "no". `DEEPWORK_GIT_ALLOW_PUSH=on` is that sentence.
- **A change larger than `maxDiffLines` (default 400) is refused.** A diff too large to read is one
  nobody reviews properly. The limit fails closed: if the size cannot be measured (no upstream, no
  `origin/HEAD`, no parent commit) the push is refused rather than counted as zero.

## Skill

`SKILL.md` ships with the package and is registered as `git-workflow`. Tools describe what one action
does; they cannot describe order, the substitute for an action that is not offered, or where to stop.
Those are three paragraphs of judgement, and prose is the only form they fit in.

## Configuration

```yaml
root:        # the repository. Empty means no tool is registered — a capability that picks a repository by itself is one nobody reviewed
allowPush:   # false
maxDiffLines: # 400
timeoutMs:   # 60000
```

## Verifying

```bash
node --test   # 9 cases on real repositories with a real bare remote
```

The cases that matter: a read changes nothing; a branch can start at `origin/main`; the commit author is
`deepwork agent`; pushing is refused by default and refused for `main` even when enabled; a diff over the
limit is refused; `pull` / `rebase` / `reset` are not actions; a path outside the repository is refused;
`apply` registers three tools plus the skill and declares `writes` only for the two that write.
