# Example domain: outside systems

A domain pack for [`@zhangcun123/ontology`](../..), and the thing to point at to watch the
enterprise come in: the systems this deployment does not own, the routes that reach them, and the
record that somebody went and walked one.

**Entirely synthetic.** Invented systems, invented interfaces, invented incidents. Nothing here
came from anywhere real, and nothing here is a real product.

## What it contains

Three object types — `OutsideSystem`, `AccessRoute`, `RouteCheck` — two relations, one declared
function, and one `tool_grants` entry. Eight instances: two systems, three routes (two
`confirmed`, one still `candidate`), and three checks.

The shape is the argument. A domain that can only describe its own insides stops at the edge of
the deployment, and the enterprise is mostly on the other side of that edge — so what an
integrator knows about the systems out there is written down where every other kind of knowledge
in this project is written down.

## What it demonstrates

| Declared | Gives the agent |
|---|---|
| `OutsideSystem` as an ordinary type | the same four read tools every type gets, in the same `type` enum, with no state to filter and no branch anywhere that knows it is "external" |
| `interface_ref` | a pointer to where the interface is written down, not a copy of it — a second copy is a second interface |
| `auth_how`, `via_proxy`, `network_segment`, `pitfalls` | what only the last person to hit the problem knows, kept where the next caller can read it |
| `lifecycle` + `default_state` on `AccessRoute` | reads return confirmed routes and say how many candidates they left out |
| `requires_review` on `confirm` | confirming a route needs a `RouteCheck` saying `reachable`, produced by somebody other than the person making the move |
| `routes_reaching` + its `where` | "which routes reach this system", which a traversal does not get the read's state filter for free |
| `tool_grants` | which role may call a tool that reaches outside the deployment — the one example here that declares one |

None of it is code in this directory. The plugin reads these declarations, and the engine was not
changed to read this domain.

`packages/ontology/src/examples.test.ts` runs it for real: an outside system answers a read with
no state filtering and is refused a `state` argument like any other type that declares no
lifecycle; the route nobody has confirmed is not in a read and the read says how many it left
out; and the tool that reaches out is allowed for the role the domain grants and refused with
`tool-not-granted-to-role` for a role it does not.

## Using it

Point the plugin at this directory:

```sh
export DEEPWORK_ONTOLOGY_ROOT=packages/ontology/examples/outside-systems
```

Or watch it derive with no runtime at all — this is the whole domain, read back:

```sh
node packages/ontology/scripts/show-derivation.ts packages/ontology/examples/outside-systems \
  --roles '[{"prefix":"session-","role":"engineer"}]'
```

```
domain   packages/ontology/examples/outside-systems
         3 object types, 8 instances, 2 relations (6 edges)

tools    4 read, 1 write
         ontology_get
         ontology_find
         ontology_links
         ontology_query
         ontology_write   (registered because roles are configured)

objects
         OutsideSystem key=system_id      instances=2   may write: curator
         AccessRoute  key=route_id       instances=3   may write: engineer
                      states: candidate → confirmed   (reads default to "confirmed")
                      confirm: candidate → confirmed   by: curator   needs a RouteCheck (outcome=reachable)
         RouteCheck   key=check_id       instances=3   may write: verifier

grants   who may call a tool this domain does not own
         reach_system           engineer
```

The `grants` block is the line worth finding. It is the only thing in this domain that describes
something which is not in it, and it is printed from the same declaration the guard reads.

## The two things this example is about

**A system outside the deployment is an object type like any other.** `SYS-LANTERN` is a name, a
purpose, a pointer to where its interface is written, and the environments that can see it. Ask
for it with `ontology_get`, list it with `ontology_find`, walk to it with
`ontology_links relation=reaches` — the same three tools, from the same declarations, with no
`kind: external` and nothing in the engine that treats it as a special case. That is the point:
the enterprise enters the same way everything else does.

**A route is a claim, and a read says which claims have been walked.** `RT-003` reaches the
partner's service and is documented in as much detail as the two confirmed routes: how it
authenticates, that it goes through a proxy, the segment, three pitfalls, and the date it was last
attempted. It is still a `candidate`, and a read does not return it — because the one thing it
lacks is a `RouteCheck` with `outcome: reachable`. The check that exists (`RC-003`) says
`unreachable`: the connection was reset and the direct path was refused by the network. A route
somebody tried and could not walk is exactly the route a caller should not be handed as though it
were established.

`last_confirmed_on` is filled in on that candidate on purpose. A date says somebody went and
looked; it does not say the route works. Only the check does that, and only a role that did not
write the route can make the move that turns one into the other — so the difference between "well
documented" and "established" is a declaration rather than a judgement call.

### Confirming one

```sh
export DEEPWORK_ONTOLOGY_ROLES='[{"prefix":"session-","role":"curator"}]'
```

As a `curator`, ask the agent to confirm `RT-003`. It is refused: `confirm` requires a
`RouteCheck` with `outcome: reachable`, and the one check that exists for that route says
`unreachable`. A `RouteCheck` is written by a `verifier`, who is in `written_by` nowhere on
`AccessRoute` — so the role that walks the route cannot rewrite it, and the role that confirms it
cannot walk it. Three grants, three answers.

## What this domain does not do

- **It does not reach anything.** No file here opens a socket, holds a credential, or reads a
  response. `auth_how` names the mechanism and the seam the material is filed under; the material
  itself is in the host's credential seam. Reaching the system is a tool's work — the host's
  shell, an MCP server, a connector somebody else wrote.
- **The tool the grant names is not in this repository.** `reach_system` is what a connector would
  declare through the governance channel; the domain only states who may call it. That is the
  useful half to have in the domain, because it is the half the deployment owns — and the guard
  enforces it the moment a tool by that name declares itself, which is what the test does.
- **Nothing cross-checks a route's `environment` against the system's `reachable_from`.** Two
  declarations, no rule comparing them. Adding one would mean the engine knowing that a system and
  a route are related kinds of thing, which is the special case this example exists to show is
  absent.

## Declaration forms worth copying

```yaml
object_types:
  OutsideSystem:
    written_by: [curator]                    # the register of systems, kept by one role
    fields:
      interface_ref: { type: string, required: true }   # a pointer, never a copy

  AccessRoute:
    written_by: [engineer]                   # who wired it, and who hit its pitfalls
    lifecycle:
      default_state: confirmed               # what a read returns, and what a walk does not
      transitions:
        confirm:
          from: [candidate]
          to: confirmed
          by: [curator]
          requires_review:
            type: RouteCheck
            link: route
            field: outcome
            pass: reachable                  # documented is not the same as walked

  RouteCheck:
    written_by: [verifier]                   # not the engineer, not the curator

functions:
  routes_reaching:
    use: traverse
    relation: reaches
    direction: incoming
    where: { status: confirmed }             # a traversal does not inherit the read's filter

tool_grants:
  reach_system: [engineer]                   # who may call the tool that reaches out
```

The last line is the one to carry to a real domain. A tool that touches something outside the
domain has no directory in it to be judged against, so this grant is the whole of its authority —
and a domain that says nothing refuses it, rather than licensing it by silence.
