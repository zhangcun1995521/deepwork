# @zhangcun123/session-query

> A DeepWork capability: the session lineage around one session, for a model that needs to pick up
> work another session started.

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Built on DSH, not a fork of it.

One tool:

| Tool | Arguments | What it does |
|---|---|---|
| `session_trace` | `session_id?` | the authorized lineage around one session: the chain of ancestors above it, and every descendant below it |

Omit `session_id` and it traces the session that is asking. The tool answers from the corpus the
deployment already has — the host's own `ctx.sessionQuery` service, which base DSH mounts as a
`session-query-sqlite` row — so nothing new is stored and nothing is indexed twice. A lineage read
does not touch the full-text index, so it works on a stock composition, where content search is off
by default.

The tool name, its one argument, and the exact text it returns are kept unchanged from the
model-facing session-query tool this was ported from, so a prompt already written against
`session_trace` keeps working.

## Why a session's log is not its history

An agent working in a session can read its own log and nothing else. But work is handed on: a
subagent child session belongs to a parent, the parent has a chain above it, and a task that was
delegated has children below. A model asked to continue what somebody else began has no way to see
any of that from inside its own turn, so it either guesses or asks a person — and the answer is
already in the corpus it is running on.

```
Session session-4f2a — Ship the import pipeline
Created: 2026-10-14T09:12:44.108Z
Availability: live, persisted

Ancestors (nearest first):
- session-1c07 — Import pipeline: plan | 2026-10-14T08:40:02.551Z | persisted

Descendants:
- session-9be1 — Draft the CSV mapping | 2026-10-14T09:20:11.004Z | live, persisted
  - session-77d0 — Check the mapping against two files | 2026-10-14T09:31:52.730Z | live, persisted
```

That is the whole result: the target, the chain above it, the tree below it, and where each session
stands. Titles are folded in one observation, so a session whose title cannot be read is still
reported — as `untitled (title unavailable: …)`.

## Who may read what

**The caller comes from the execution, never from the arguments.** The only source of identity is
the agent the call runs on behalf of, so a model cannot name a workspace it would like to read. A
target is admitted only when its own stored `cwd` is *exactly* the caller's, and that check happens
before the corpus is asked about the target at all — so a session that does not exist and a session
in somebody else's workspace produce the same refusal, and neither answers "does this exist".

**A lineage that leaves the workspace is cut, and the cut is marked.** The ancestors stop at the
first session outside the caller's workspace, and descendant subtrees outside it are replaced by a
marker:

```
Ancestors (nearest first):
- session-1c07 — Import pipeline: plan | … | persisted
- [outside workspace boundary]

Descendants:
- session-9be1 — Draft the CSV mapping | … | live, persisted
  - [outside workspace subtree]
```

The marker carries no session id, deliberately. A trace that listed the hidden session would be a
directory of other people's work; one that stopped silently would read as "there is nothing above
this", which is a different and false answer.

## What it deliberately does not do

**It does not search.** The implementation this was ported from carries four more model-facing
session tools — full-text session search, event search, event trace, and exact event read. This
package carries one. Search is a different kind of decision: it depends on a deployment's index, on
whether content search is enabled at all, and on a result cap and a timeout budget, none of which a
lineage read needs or has.

**It contributes no prompt text.** The tool's description says when to call it, which is the whole
of what a model needs in order to choose it. Prompt guidance is a deployment's business here, and a
section written for this family would be describing tools this package does not carry.

**It does not truncate.** A deep or wide lineage is returned complete. A deployment that needs a
bound on inline output mounts the host's own spill policy, which replaces oversized tool text after
execution while keeping the complete result — a truncation invented here would disagree with every
other tool about what a partial answer looks like.

## Install

```sh
dsh plugin --profile web add @zhangcun123/session-query
```

The profile must already mount a provider for `sessionQuery`. Base DSH compositions do — the SQLite
provider is a base row — so this is a dependency to check rather than one to add.

The plugin declares `inject: ['tools', 'sessionQuery']`, which means the loader holds it until both
exist. A deployment without a corpus gets no tool, rather than a tool that fails on every call.

## Known limitations

- **Workspace identity is exact string `cwd` equality.** Two symlinked paths to one directory do
  not share authority. That is conservative on purpose: resolving links at read time inside a tool
  whose job is reading history is the wrong place to be clever.
- **A caller with no `cwd` may inspect only itself.** Sessions created outside a workspace have no
  workspace to be in common with anything.
- **A large corpus means a large trace.** The ancestors and descendants are returned whole; there
  is no pagination and no model-controlled depth.
- **It reads; it never writes.** Nothing here can start, resume, or modify a session, and no
  session it reads becomes live as a side effect.

## Verifying

```sh
npm test        # the boundary and the rendering, against a fake corpus
npm run build   # tsc
```

The suite covers the two refusal paths (another workspace's session, an unbound caller), the
boundary markers and the absence of hidden ids from the output, the exact text of a full lineage,
per-title failure isolation, the translation of service failures into model-safe sentences with the
real diagnostic logged instead, and cancellation arriving as its own reason. It needs no runtime:
the surface this package consumes is three methods, so a fake stands in for the host.

`src/index.test.ts` covers the mounting separately, because a tool that never reaches the registry
leaves every test of the operation green and the model with no tool at all.

## Compatibility

Tested against `@deepseek-ai/dsh` **0.1.7-rc.2**. DSH is on an `0.1.x` alpha/RC line where container
types move quickly, and `engines.dsh` is declarative only — DSH does not enforce it, so a newer host
will not refuse to load this. Re-test after each upstream release.

## License

MIT.
