# @zhangcun123/lsp

> A DeepWork capability: ask a language server where something is defined, instead of guessing from
> a text match.

A **capability** in this platform's sense is one plugin that gives an agent an ability. Here the
ability is precise code navigation — the answer to "where is this declared" comes from a compiler's
own model of the code rather than from a search that happens to look right.

It registers one tool, because one is what the question needs:

| Operation | Asks |
|---|---|
| `goToDefinition` | where is this defined |
| `findReferences` | who else uses this, declaration included |
| `goToImplementation` | which types implement this |
| `hover` | what is this, according to the compiler |

`lsp` takes `file_path`, `line`, and `character` — **one-based UTF-16 cursor coordinates**, the way a
person counts them, not the way the protocol does. The plugin converts to the protocol's zero-based
positions and converts every location back, so a prompt that says "line 12, column 7" means the line
and column a person would point at.

## Configuration

```yaml
servers:
  # the key is the provider id; every entry is one language server
  ts:
    command: typescript-language-server      # absolute, or found on PATH at load
    args: [--stdio]
    extensionToLanguage: { '.ts': typescript, '.tsx': typescriptreact }
maxLocations:    # 100, the cap before an omission marker
maxResultChars:  # 16000, the cap on the complete rendered result
timeoutMs:       # 60000, covering the queued read, open, query, and close
```

`servers` empty means **no tool is registered at all**, and the plugin says so once at load. An
unconfigured deployment should read as unconfigured rather than as one whose every navigation
question fails.

**The server command is deployment configuration, never a model argument.** A tool that ran what it
was handed would be a shell wearing a tool's name; a caller chooses a file and a cursor, and nothing
else. The executable is resolved at load, so a mistyped command fails the plugin's boot rather than
the first question somebody asks.

## What a deployment still has to supply

A language server, installed and on `PATH` — or named by absolute path. This package does not carry
one and does not install one: which server, which version, and which languages is a deployment's
decision, and the mapping in `extensionToLanguage` is where a deployment states it.

Without that, the plugin loads and registers the tool only when it is configured, and its calls fail
for want of a server. Nothing here invents a fallback: a text search is already available, and
dressing one up as a language server would make the model unable to tell them apart.

## What it deliberately does not do

**No mutation.** Rename, code actions, and formatting are not operations here, and the client
**refuses** `workspace/applyEdit` when a server asks. A server is a third-party binary the model
reached for by asking a question; answering one with a file edit would be a second write path into
the workspace, arriving from somewhere the write guard has no reason to be looking.

**No generic JSON-RPC escape hatch.** Exactly four semantic operations are exposed. A protocol
payload the model could shape itself is a capability nobody reviewed, and a provider swap would
change what the model can ask.

**No diagnostics.** They need their own freshness and accumulation rules, so they are a different
feature rather than another value in this tool's enum.

**No credential-shaped environment variables.** The server is handed a PATH and a compiler, not the
keys the harness runs on: variables whose names look like keys, passwords, secrets, or tokens are
dropped before the child starts. A deployment that does want one passes it explicitly under that
server's `env`.

## How a query runs

**One transient open per query.** The file's current bytes go to the server in a `didOpen`, the
request is made, and `didClose` runs in `finally`. There is no content cache and no `didChange`, so
the answer is about the file as it is now rather than as it was when some earlier call opened it.

**One process per workspace, created on first use.** A language server indexes a workspace, so
sharing one across two roots would answer from the wrong index. Queries against one workspace
serialize through that process; different workspaces run in parallel.

**A query source stays inside the workspace.** The path is resolved, and the resolved path must be
inside the resolved root — so an alias, a symlink, or a path full of `..` cannot make the client open
a file elsewhere. A *location* the server returns may be outside the workspace, which is ordinary for
a dependency; that direction is not restricted.

**A source is read as UTF-8 or not at all.** Mis-decoded bytes would shift every position the model
then counts on, and a failure that looks like a wrong answer is worse than one that looks like a
failure.

**A capped result says it was capped.** `maxLocations` first, with a marker counting what was left
out, then `maxResultChars` over the complete text including that marker.

**Torn down, not abandoned.** Unloading the plugin asks each server to `shutdown`, then to `exit`,
then kills its process tree — `taskkill /T` on Windows, the process group elsewhere, because a node
host keeps its children and killing the launcher alone leaves them holding the pipes.

## Verifying

```sh
npm test        # 70 tests, no runtime and no language server
```

The suite runs against a **scriptable language server** in `tests/fixture-server.mjs` — a real child
process speaking the real `Content-Length`-framed protocol over real pipes, driven by environment
variables. It frames its own messages rather than reusing this client's encoder, so that a mistake in
framing cannot be agreed with.

What the tests pin: the model-facing names, parameters, coordinate convention, and prompt text
verbatim, because a prompt is already written against them; the output schema against the two rules
the runtime's JSON Schema subset imposes; the file on disk being what the server is told about; the
document closing after every query; an operation or a document-sync mode the server does not
advertise being refused before a document is opened; `workspace/configuration` being answered and
`workspace/applyEdit` refused; a source outside the workspace, mis-encoded, or over the byte limit
being refused before a server starts; and teardown reaching `shutdown` then `exit` and refusing later
queries.

## Where this came from

It began as a port of the harness's own language-server support — three packages there (the seam, a
stdio backend, and the model-facing tool) and one here, because a capability in this project is one
plugin. The seam survives the merge: the plugin publishes it as `ctx.lsp`, so a backend written as
its own plugin can register against the same interface this one's provider uses. What did not survive
is the host's filesystem and subprocess seams — this reads with `node:fs` and launches with
`node:child_process`, which is what lets the whole client be tested with no runtime at all and is
also the port's first limitation below.

## Known limitations

- **The local world, and only it.** Sources are read with `node:fs` and servers are launched with
  `node:child_process`, so the files a query resolves are the ones this process can see. A deployment
  whose agent works in a remote or differently-sandboxed world needs the host's own filesystem and
  subprocess seams, which is exactly what the ported version used and this one does not.
- **No confinement.** The server runs as an ordinary child process with no sandbox; a deployment that
  needs one must supply it around this plugin.
- **A hard-killed harness orphans its servers.** `initialize.processId` is `null` on purpose — the
  harness PID would let a server on another machine monitor an unrelated process — so servers are
  cleaned up by plugin unload, and a `SIGKILL`ed harness leaves them running until they exit on their
  own.
- **Servers that do not open and close documents are unsupported.** A server whose `textDocumentSync`
  omits open/close is refused, even if a closed-document query would have worked. The transient-open
  sequence is the whole document story, and pretending otherwise would mean a cache this client does
  not have.
- **Long-lived processes hold memory.** One process per server per workspace is pooled until unload,
  and parallel callers sharing one workspace queue behind one process.
- **`tsx` and other npm-installed servers are shell-launched on Windows.** A `.cmd` or `.bat` shim is
  the only launch that goes through a shell, because Windows will not execute one without it;
  everything else passes its arguments directly.

## Compatibility

Tested against `@deepseek-ai/dsh` **0.1.7-rc.2**, which is where `SECTION_ORDERS.TOOL_LSP` — the
prompt slot this tool registers in — exists. `engines.dsh` is declarative only: the host does not
enforce it, so a newer DSH will not refuse to load this. Re-test after each upstream release.

## License

MIT.
