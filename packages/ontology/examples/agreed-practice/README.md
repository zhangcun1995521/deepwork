# Example domain: agreed practice

A domain pack for [`@zhangcun123/ontology`](../..), and the thing to point at to watch the rule
injection happen: a team's engineering practices, the products they were written about, and the
work the practices are applied to.

**Entirely synthetic.** Invented practices, invented products, invented work. Nothing here came from
anywhere real.

## What it contains

Three object types — `Practice`, `Deliverable`, `WorkItem` — one relation, and one declared
function. Thirteen instances: nine practices (six `verified`, three still `candidate`), two work
items, and the deliverable each of them is.

Two loops, and this is the smallest shape that holds both:

- a practice arrives as a `candidate` and reaches an agent only after a role that did not write it
  moves it to `verified`;
- a work item can be submitted for review and sent back for rework, and the two moves belong to
  different roles.

## What it demonstrates

| Declared | Gives the agent |
|---|---|
| `skill:` on `Practice` | the vouched-for practices, as loadable skills *and* as lines in the prompt |
| `situation.product_type` | the product half of a situation, read off the relations a practice declares |
| `situation.state_tags` | the tag half, read off the work item's stage instead of typed by hand |
| `governs` + `practices_governing` | "which practices govern this deliverable", both directions |
| `written_by` and the transitions | who may write a practice, who may agree to it, who may send work back |

None of it is code in this directory. The plugin reads these declarations, and the engine was not
changed to read this domain.

## Using it

Point the plugin at this directory:

```sh
export DEEPWORK_ONTOLOGY_ROOT=packages/ontology/examples/agreed-practice
```

Naming the work item is the whole configuration — its stage supplies the tag, so nobody has to
remember the domain's tag vocabulary:

```sh
DEEPWORK_ONTOLOGY_ACTIVE=WI-1042 dsh headless \
  "Quote the section of your prompt headed 'Rules this domain vouches for', then review the change I am working on."
```

`WI-1042` is `in_review`, so that section carries three of the six vouched-for practices:
`PRA-003`, `PRA-004`, `PRA-005`. Name the other work item instead — `WI-1043` is still `draft` — and
the same prompt carries a different two, `PRA-001` and `PRA-002`:

```sh
DEEPWORK_ONTOLOGY_ACTIVE=WI-1043 dsh headless \
  "Quote the section of your prompt headed 'Rules this domain vouches for', then review the change I am working on."
```

Neither command mentions a stage, and neither does the prompt. The section says where the situation
came from (`Situation computed from: WorkItem WI-1042 is in_review, which this domain maps to
stage:review`) and how much of the domain it is showing (`3 of the 6 vouched-for rules apply
here`), because a situation computed from a state has no other way to be checked.

It also names both deliverables (`Working on DLV-WI-1042, DLV-WI-1043`), which is worth knowing
rather than wondering about: a work item resolves to the products that a work item *is*, and that is
a fact about the kind of thing rather than about the one instance. The stage tag is what narrows
what follows from there.

None of the three `candidate` practices appears in any of that. They are not skills the agent can
load, they are not lines in the section, and they are not in the count of six — one `default_state`
declaration decides all three.

### Watching it follow the work

Roles are the gate on writing, and with none configured the deployment is read-only. Configuring
one makes the agent able to make the moves this domain declares:

```sh
export DEEPWORK_ONTOLOGY_ROLES='[{"prefix":"session-","role":"author"}]'
```

As an `author`, ask the agent to submit `WI-1043` for review. Nothing about the prompt was
reconfigured, and the next turn's section carries the three review practices instead of the two
drafting ones, because the prompt is rebuilt for every assembly. Point the deployment at the
reviewer instead and ask it to send the change back — and to fix the one thing it would rather see
changed:

```sh
export DEEPWORK_ONTOLOGY_ROLES='[{"prefix":"session-","role":"reviewer"}]'
```

The move is allowed and the edit is refused, both by name: `send_back` names the reviewer, and
`written_by` does not. That is the whole difference between deciding a change and writing it.

The prefix is matched against the agent id, whose shape depends on the profile the runtime was
booted with. Run once with roles unset to read the agent id out of the refusal, rather than guessing
it.

### Naming the product instead

A product has no state, so it supplies no tag — and the product gate is then the only thing
selecting:

```sh
DEEPWORK_ONTOLOGY_ACTIVE=DLV-WI-1042 dsh headless "..."
```

Five of the six, this time: `PRA-001` is written about `DLV-WI-1043` and naming the other
deliverable leaves it out. That is the difference between a practice that governs the thing being
made and a practice that governs something else — sayable as a query rather than as a convention.

## Declaration forms worth copying

```yaml
situation:
  product_type: Deliverable          # a practice's constraints are its relations into this type
  state_tags:
    WorkItem:
      in_review: stage:review        # the object answers which stage it is at

object_types:
  Practice:
    written_by: [author]             # who may write a practice
    lifecycle:
      default_state: verified        # what a read returns, and what the injection draws from
      transitions:
        agree: { from: [candidate], to: verified, by: [reviewer] }   # who may agree to one

  WorkItem:
    written_by: [author]             # and the reviewer is absent on purpose
    lifecycle:
      transitions:
        submit_for_review: { from: [draft], to: in_review, by: [author] }
        send_back:         { from: [in_review], to: draft, by: [reviewer] }
```

The last two lines are the case worth reading twice. `send_back` is performed by a role that appears
in `written_by` nowhere, and a write carrying nothing but the lifecycle field is authorised by the
move rather than by the type — which is what lets a reviewer decide a change without being able to
rewrite it.
