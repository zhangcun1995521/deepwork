# Example domain: project delivery

A domain pack for [`@zhangcun123/ontology`](../..), and the thing to point a demo at.

**Entirely synthetic.** Invented customers, invented people, invented projects. Nothing
here came from anywhere real.

## What it contains

Five object types — `Customer`, `Project`, `Person`, `Issue`, `Document` — six relations,
and **seven declared functions**. Sixteen instances in total, arranged so that one
project (`P-2026-001`) carries a plausible risk story and another shares its accountable
owner, which is the kind of cross-project conflict a single-project view would miss.

## What it demonstrates

Everything the agent can do with this domain is declared in `schema.yaml`. No code
knows what a project is, so this directory is the entire cost of adding the domain:

| Declared | Gives the agent |
|---|---|
| `object_types` | the `type` enum on every structural tool, and what may be written |
| `link_types` | the `relation` enum, and how fields become edges |
| `functions` | modes on `ontology_query`, with arguments derived from `by` |
| `written_by` | who may write each type |
| `required_fields` | what a write must supply |

Add a type here and the agent can query it. Delete a function and the mode disappears.
Neither touches the plugin.

## Using it

```sh
DEEPWORK_ONTOLOGY_ROOT=<this directory> dsh headless "Analyse the risk on project P-2026-001 and give me a management briefing."
```

To let the agent write as well, say who may write — the role map is the gate, and with
none configured the write tool is not registered at all:

```sh
DEEPWORK_ONTOLOGY_ROLES='[{"prefix":"session-","role":"delivery-lead"}]'
```

The prefix is matched against the agent id, whose shape depends on the profile the
runtime was booted with. Run once with roles unset to read the agent id out of the
refusal, rather than guessing it.

## Declaration forms worth copying

```yaml
functions:
  at_risk_projects:
    use: filter_by
    on: Project
    where: { status: [AtRisk, Delayed] }   # a list reads as "either of these"

  open_issues_of:
    use: traverse
    relation: reported_on
    direction: incoming                     # the relation points the other way
    by: project_id
    where: { status: open }                 # narrows what the traversal arrives at
```

`about`, `reported_on` and `assigned_to` all read a field named by `via`, which is what
lets the data keep natural field names instead of being renamed after its relations.
