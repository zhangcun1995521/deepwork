# Working with the git tools

This is not a tool list — the tool descriptions carry that. It answers three questions: the default
path, what to do when the action you want is not offered, and where to stop.

## Default path

1. **Open an isolated worktree starting at the remote trunk.**
   `git_change worktree-add` with `name=agent/<task>`, `base=origin/main`, `worktree=<a temp dir outside
   this repository>`. Do not change the branch that is in use.
2. **Read before writing**: `git_read status` → `diff` → `blame` on the lines being changed (who wrote
   them, and in which commit).
3. Change the code.
4. **Run `git_read diff` before committing.** Only the intended lines may appear.
5. Run the tests with the test runner, not by hand-writing a command.
6. Only when they are green: `git_publish push` — a new branch only.
7. Open a change request and put the evidence on it.

## When the action is not offered

| You want | It is not here; do this instead |
|---|---|
| `push --force` | Push a new branch and open a new change request. History does not need erasing |
| `reset --hard` | `git_change restore` to drop working-tree changes, `stash` to keep them |
| edit on `main` directly | `worktree-add` from `origin/main` |
| `pull` once | Not needed: `worktree-add` with `base=origin/main` already starts at the newest code |
| `rebase` | Not offered. Rewriting history is a person's act, at a keyboard |
| `clean -fd` | Not offered. Deleted untracked files do not come back |
| edit `config` / install hooks | Not offered. That is remaking the tool itself |

## Where to stop

- **A merge conflict** → stop. List the conflicting files and hand them over. Resolving a conflict means
  deciding what the other change was for, and that is not a mechanical judgement.
- **A push refused for size** → the change is too large. Split it, or have a person look first.
- **After `git_read fetch`** → **re-run the tests.** Any earlier result describes the code as it was
  before the fetch.
- **A `git_change commit` that failed** → `git_read status` first. Do not re-run the same command.

## One boundary

There is no `pull`, no `force`, no `rebase`, no `reset --hard` here.
**Needing one of them means this is a moment to ask a person — not to find another way around.**
