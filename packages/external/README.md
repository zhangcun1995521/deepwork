# @zhangcun123/external

## Install

```sh
dsh plugin --profile web add @zhangcun123/external
```

Then add `@zhangcun123/external` to `dsh.profile.bundles` in the profile's `package.json` (the plugin manager does
both steps). Requires DeepSeek Harness `0.1.7-rc.2` and up within the `0.1` line: the manifest declares
that range as a peer dependency, and the harness refuses a plugin built for a different runtime instead
of loading it into one — which is the failure this package would rather have.

> A DeepWork capability: reach an outside system by the route the deployment's own domain declares.

The connector the ontology's [`examples/outside-systems`](../ontology/examples/outside-systems)
domain was written for. That domain declares the systems this deployment does not own, the routes
that reach them, and a `tool_grants` block whose entries wait for exactly this tool — an entry under
the program a connector starts, and one under `reach_system` which only narrows. This package
declares that tool, and it is one tool rather than four: finding the route, respecting what the
domain says about it, resolving the credential and running the connector are one act.

## Configuration

```yaml
ontologyRoot:   # the same domain root the ontology plugin reads; empty means no tool at all
command:        # node /opt/connectors/reach.mjs {url}; empty means no tool at all
route:          # which of the domain's own names mean what
  type:         # the object type a route is, e.g. AccessRoute
  url:          # the field holding the address to dial
  auth_ref:     # the field holding the credential reference name
  target:       # optional: the field naming what a route reaches, for the view only
timeoutSeconds: # 30
auditLog:       # <ontologyRoot>/.audit.jsonl, beside the ontology's own write trail
```

**Nothing here is a model argument.** The caller names a route id and nothing else: the program, the
address and the credential are all deployment facts, decided before the call. A tool that took a URL
is a tool a model can point anywhere, and the grant it holds would authorise reaching whatever it
liked.

**The program is the grant.** The first word of `command` is what is declared to the governance
channel, so the domain's `tool_grants` entry for it is the whole authority to run it — a config edit
that changed `node` to something else would need a grant nobody wrote. An entry under `reach_system`
is optional and only narrows who may call the tool.

**The connector runs in this process's working directory.** There is no workspace key to configure:
the command is the deployment's, and a connector worth configuring is either on `PATH` or given as
an absolute path.

## One call, in order

1. **The route**, out of the domain. Unknown id → refused, listing the ids that do exist.
2. **The lifecycle's `default_state`.** A route in another state is refused: the state says nobody
   has walked it, and a read hides it for the same reason. A type that declares no lifecycle, or no
   default state, hides nothing and filters nothing.
3. **The address and the credential's name**, out of the fields the deployment named. Either blank →
   refused, naming the field.
4. **The credential**, out of the host's credential seam. No seam mounted, a name the seam cannot
   address, or nothing stored under it → refused. The value never appears in an argument, a result, a
   log line or the trail.
5. **The address into the command**, quoted, and refused outright if it holds a character a shell
   reads as syntax even inside quotes. A route's address is a field of a domain an agent may be able
   to write, and the command is read by a shell.
6. **The program**, run once, on a deadline, with the credential in its environment under
   `DEEPWORK_REACH_CREDENTIAL`. Output is capped, and the cap says so.

The result:

```
route     RT-001
system    SYS-LANTERN
url       https://lantern.operations.example.com/api/v1/visits
program   node
exit      0 after 412ms
reachable yes

output
{"visits":[…]}
```

## It reports the exit status; it does not interpret it

`reachable` is one comparison — the program exited 0 — and that is all this slice claims. A connector
that talks to a device may exit 0 for a device that answered "no"; a connector that follows a
redirect may exit 0 for a page nobody expected. The program's output is handed back as it came, for
whoever knows that system to read. A later slice could ask the domain for a response shape to read
against; inventing one here would be this package deciding what the customer's world means.

A run that is refused is a refusal and an error; a run that happened and could not connect is a
result with `reachable: false`. That is the same distinction the write trail draws between a write
that was refused and a write that failed.

## The trail

One JSON line per call, refusals included, at `auditLog`. It records the route, the program, the
outcome, the exit status and how long the run took. It never records the credential, the program's
output, or the address — the address can carry a token in its query string, and a log is not the
place to find that out.

## The connector view

`GET /connectors` on a web-carrying profile serves what this deployment can reach, read from the same
domain the tool reads:

```json
{
  "routeType": "ConnectionPattern",
  "summary": { "routes": 9, "complete": 9, "callable": 0 },
  "findings": [
    { "code": "program-not-granted", "detail": "tool_grants has no entry for \"curl\" …" }
  ],
  "connectors": [
    {
      "id": "CP-ALIYUN-001",
      "system": "aliyun-observability",
      "address": { "field": "base_url", "set": true },
      "credential": { "field": "auth_ref", "name": "", "addressable": false },
      "callers": { "program": "curl", "programRoles": null, "toolRoles": null },
      "last": null,
      "problems": []
    }
  ]
}
```

Two numbers rather than one, because a deployment can have every route declared correctly and nothing
a call would get through: `complete` counts the routes whose own declaration says nothing against a
call, `callable` counts the ones that would actually go through given the deployment's grants as well.

`problems` are things one route can fix — an empty address, a blank reference, a state a read hides.
`findings` are facts about the composition, reported once because every route inherits them: a program
no `tool_grants` entry names, a field the connector was told to read that the type does not declare, a
target neither a relation nor a configured field answers. A finding marked as blocking sets `callable`
to zero, so the summary cannot claim a capability the guard would refuse.

**What it never shows.** Not the address — only the field's name and whether it is filled. Not the
credential — the name is shown, because it is what a domain declares and what an operator looks up,
and the material is never asked for. And not a "test this route" button: reaching a system is an agent
act behind an approval gate, and a page has no agent identity to ask on behalf of. The view says who
to ask instead — an agent calling `reach_system`.

A route marked complete has a complete declaration, not a known answer: whether the credential is
stored under that name and whether the program exists here are facts only a call settles.

## Approval

A call is a question before it is a dial. When the deployment mounts an approval service — the host
ships one — the caller is asked, on that agent's behalf, whether this route may be dialled:

```
Allow this agent to dial route "CP-DEMO-001" (local-demo) at http://127.0.0.1:4599/health.
This session may dial that route without asking again; every other route asks separately.
```

What the answer covers is deliberately narrow, and narrower than the host's own desktop gate: there,
one grant opens a capability for a session, because "may this agent use the desktop" is a single
standing permission. Here the unit is the *route*, because each system is a separate authority — a
person who approved a health check on a development box has not approved a tap on the payroll system.
The host's own wording for the seam is that grants apply only to the requested action, and the action
a caller requests is one route.

Every ending but `allowed-once` refuses, and nothing is dialled — not even the credential is fetched,
because a refusal that happened after the material was read is one the trail cannot tell apart from a
call that ran. The three endings read differently on purpose: `rejected` is a decision not to repeat
the call unchanged, `cancelled` is a question that can be asked again, and `unavailable` is an
environment that never had anyone to ask. A service that throws is a fourth refusal, `ask-failed`. An
agent the host does not name is never remembered, so it is asked every time.

Asking is on by default and is switched off by configuration, in one spelling:

```
DEEPWORK_EXTERNAL_APPROVAL=off
```

The default is on because the two ways of being wrong are not symmetrical: a deployment that wanted to
be asked and was not has an agent reaching systems unattended, while one that did not want to be asked
and was has a prompt to answer. A deployment that mounts no approval service at all — `dsh headless`
among them — refuses every call rather than dialling unwatched, which is the host's own rule for this
seam: an asker fails closed on `unavailable`.

## What it deliberately does not do

- **It does not write the ontology.** A reach is an observation, and recording it is the domain's
  business: the example domain declares a `RouteCheck` written by a `verifier`, and a `confirm`
  transition that needs a check from somebody other than the person making the move. A connector that
  wrote its own check would walk the route, certify it and close the loop by itself.
- **It does not read the response.** See above.
- **It does not scrub the ambient environment.** The spawn is direct, so the child inherits this
  process's environment — the harness's own key included, if it is in there. The host's scrub belongs
  to the subprocess service that is being bypassed, and the credential name
  (`DEEPWORK_REACH_CREDENTIAL`) is chosen to survive it: names containing `KEY`, `PASSWORD`, `SECRET`
  or `TOKEN` are scrubbed by that service, which is how a deployment ends up with a credential that
  arrives empty and reads as one nobody set.
- **It does not cache the domain.** The graph is re-read per call, so a route confirmed a minute ago
  is dialable now and a refusal never quotes a state the domain has moved on from.

## Verifying

```sh
npm test        # 29 tests: real child processes, a real socket on 127.0.0.1, a real file
```

The scripts build `@zhangcun123/ontology` first (`npm run build --prefix ../ontology`) before testing,
building or packing. This package consumes that package's **built** subpath exports — `loadGraph` and
the audit writer — and `packages/*/lib/` is in `.gitignore`, so a fresh checkout has no `lib/` at all.
CI runs each package's `npm test` on exactly such a checkout, which is how this was found: the suite
passed on a machine where the sibling had been built once and failed on one where it had not.

The suite stands up an HTTP server, copies the fixture domain per test so a route can hold the port
it landed on, and runs a stand-in connector — `node tests/fixtures/reach.mjs {url}` — whose output
and exit status are the only things the connector is allowed to read. It covers a route that answers,
a system that does not (with the attempt still written down), a candidate route refused with nothing
dialled, a route whose state field is empty (which a read calls `candidate`), an unknown id refused
with the ids that exist, a blank address, a credential the seam cannot address, a credential nobody
stored, no seam at all, and the address substitution that keeps shell syntax out of a route's address.

The one seam that is stood in for is the credential provider. Mounting the host's own would mean
booting a runtime, and the contract is one method — the fixture connector sends the value it received
as a bearer token, so the server proves where it ended up.

**Not covered by tests:** the deadline. A hanging connector is killed and reported the way
`@zhangcun123/test-runner` reports one, and the code path is the same one that package runs in
production; there is no test here that makes a connector hang.
