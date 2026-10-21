# @zhangcun123/ontology

**Declare an enterprise world once, and derive the agent's tools and permissions from it.**

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Built on DSH, not a fork of it.

```yaml
functions:
  open_issues_of:
    description: Issues still open against a given project.
    use: traverse
    relation: reported_on
    direction: incoming
    by: project_id
    where: { status: open }
```

Those eight lines add a tool the agent can call. No TypeScript, no registration, no
rebuild.

## Why

DSH ships a complete agent harness — loop, tools, skills, workflows, plan mode,
approval, subagents, sandboxing. What it does not ship is any notion of *the enterprise
world* the agent is working in. A general agent sees `document_001`, `project_782`,
`user_23891`. An enterprise agent needs to know what a project is, who owns it, which
customer it belongs to, and what it is allowed to touch.

That gap is semantic, not mechanical, and it is what this package fills.

## Install

```sh
dsh plugin --profile web add @zhangcun123/ontology
```

Then point it at a domain pack — a directory holding `schema.yaml` and the instance
files it names:

```sh
DEEPWORK_ONTOLOGY_ROOT=/path/to/domain dsh web
```

## The tool surface

Four tools, and **only one grows with the domain**:

| Tool | Arguments | What it does |
|---|---|---|
| `ontology_get` | `type`, `id` | fetch one entity |
| `ontology_find` | `type`, `field?`, `value?`, `query?` | find entities by exact field and/or substring |
| `ontology_links` | `relation`, `from` | follow a declared relation |
| `ontology_query` | `mode`, plus declared arguments | run the domain's own declared functions |

The first three are parameterized *by* type rather than duplicated *per* type, so a
domain with forty entities still exposes three tools. `type` and `relation` are closed
enums built from the schema, so the model cannot name something that does not exist.
Only `ontology_query`'s `mode` enum grows, and an enum value costs far less than a tool
whose description crowds out the task.

A fourth tool appears when you say who may write:

| Tool | Arguments | What it does |
|---|---|---|
| `ontology_write` | `type`, `id`, `data` | create or update one entity |

Relations need no separate verb because a relation is a field — naming a relation's
field inside `data` asserts the edge.

## Authoring a domain

A domain pack is data. Five declarations, and nothing else is needed:

```yaml
object_types:
  Project:
    primary_key: project_id                   # identity, and the file name
    required_fields: [project_id, status]      # what a write must supply
    file_location: objects/projects/P-*.yaml   # where instances live, and how far a write may reach
    written_by: [delivery-lead]                # who may write this type
    fields:
      status: { type: enum, values: [OnTrack, AtRisk, Delayed] }

link_types:
  reported_on:
    from: Issue
    to: Project
    via: project            # the field carrying the edge; defaults to the relation's name

  depends_on:
    from: Service
    to: Service
    propagation: to_from    # which way a *failure* travels: from_to | to_from | both
    semantics_tag: hard_dep     # what the relation means: one of seven tags, not prose

functions:
  at_risk_projects:
    use: filter_by          # filter_by | traverse | search | walk
    on: Project
    where: { status: [AtRisk, Delayed] }   # a list reads as "either of these"

  projects_for_customer:
    use: filter_by
    on: Project
    by: customer            # the field that becomes an argument, typed from its declaration

  blast_radius:
    use: walk               # walk outward from one id, hop by hop, over declared failures
    by: service_id          # the argument holding the id to start from
    direction: downstream   # downstream | upstream | both; default downstream
    depth: 2                # hops; default 2, hard cap 5
    semantics_tag: [hard_dep, runtime_dep]   # optional narrowing, by tag
    relations: [depends_on]              # optional narrowing, by relation name
```

Eight things worth knowing:

- **A relation is a field.** An edge exists when an instance carries the field its
  relation names, *and* the instance's type is that relation's declared `from`. Both
  halves matter: without the second, a field that happens to share a relation's name
  produces a self-loop.
- **One field name may carry several relations.** An issue and a document both reach
  their project through `project`; the instance's own type decides which relation applies.
- **`where` narrows both kinds of declaration.** On a filter it narrows what you start
  from; on a traversal it narrows what you arrive at.
- **`direction: incoming` walks a relation backwards.** `reported_on` runs Issue →
  Project, but "what is blocking this project" starts at the project. An inverse relation
  cannot be derived from the data, so it is asked for at query time.
- **`propagation` is what makes a relation walkable.** A walk follows failures, not arrows,
  and which way a failure travels along a relation is a fact the data cannot supply: "X
  depends_on Y" is drawn X → Y, and it is Y failing that reaches X, so it is declared
  `to_from`. `from_to` and `both` are the other two answers. A relation that declares no
  direction is not walked at all — and one that declares a direction nothing understands is
  a warning, never a guess. Absent is an ordinary answer, not a defect.
- **`semantics_tag` is a vocabulary, not prose.** Seven tags — `hard_dep`, `runtime_dep`,
  `traffic`, `aggregation`, `redundancy`, `observation`, `annotation` — which a walk reports
  per hop and can be narrowed by. A sentence written in that key is a warning: it reads as a
  declaration and takes effect as nothing.
- **`walk` answers what `traverse` cannot: a path.** One declared function walks outward from
  an id over relations that declare a failure direction, breadth-first, and returns every
  entity reached with its hop count, the relation that reached it and that relation's tag.
  The default direction is `downstream` — what breaks *because* this failed — the default
  depth is 2 hops, and the cap is 5, which a declaration cannot raise. `semantics_tag` and
  `relations` narrow which relations are followed; a narrowing that selects nothing walkable
  warns at load rather than quietly widening to everything.
- **Nothing is asserted by declaring.** A relation no instance carries produces no
  edges, and the loader says which ones those are rather than leaving it to be discovered.

See [`examples/project-delivery`](examples/project-delivery) for a complete pack, and
[`examples/infrastructure`](examples/infrastructure) for a domain that walks one.

## Governance

Permissions are declared, not coded. There is no per-tool check to remember to add.

```sh
DEEPWORK_ONTOLOGY_ROLES='[{"prefix":"session-","role":"delivery-lead"}]'
```

The role map is the gate on the write tool. With none configured, `ontology_write` **is
not registered at all** — an unconfigured deployment is a read-only one, rather than one
that refuses every call. Each write is then checked against the target type's own
declarations: `written_by` for who, `file_location` for how far the path may reach,
`required_fields` for what must be present.

Every attempt is audited to `<ontologyRoot>/.audit.jsonl`, refusals included:

```json
{"at":"2026-09-29T06:38:26.612Z","action":"ontology_write","agentId":"session-1a8b…","role":"analyst","type":"Project","id":"P-003","outcome":"allowed","fields":["customer","owner","status"]}
{"at":"2026-09-29T06:37:58.367Z","action":"ontology_write","agentId":"session-f7fa…","type":"Project","id":"P-003","outcome":"denied","reason":"no-role","detail":"agent … matches no configured role"}
```

Field **names** are recorded; field **values** never are. An audit trail that copies
domain content into a second file doubles the surface that content can leak from, which
inverts what an audit is for. Refusals are recorded because "who tried and was turned
away" is the question asked after something goes wrong.

## What the model sees

Nothing about this package appears in the prompt until a domain is loaded. After that,
the model sees the four tool definitions above and nothing else — no entity listing, no
schema dump. Tool descriptions are generated from the domain's own words: each mode's
description in `ontology_query` is the `description` its declaration supplied.

Arguments are typed from declarations rather than guessed. `by: customer` on a `Project`
function takes the type and description of `Project.customer`, so a `ref` field yields a
string described as "a Customer id".

A capped result always says it was capped. `total`, `returned` and `truncated` are
required fields of every tool's output, because a result that hides its own truncation
invites the model to read a partial answer as the whole one.

## Seeing it as a graph

```bash
node packages/ontology/scripts/export-rdf.ts <domain-directory> -o domain.rdf
node packages/ontology/scripts/export-rdf.ts <domain-directory> --instances --limit 40 -o with-data.rdf
```

Ordinary OWL: types become `owl:Class`, relations become `owl:ObjectProperty` with
`rdfs:domain`/`rdfs:range`, instances become `owl:NamedIndividual`. Any RDF viewer reads it;
[Microsoft's Ontology Playground](https://microsoft.github.io/Ontology-Playground/) is one that
imports a file and draws a clickable graph, which makes it a useful way to *look* at a domain
before arguing about it.

**Schema is the default, and that is the point.** A real domain carries thousands of instances: one
in use here has over four thousand, which a viewer draws as a hairball or silently collapses into a
hierarchy summary. What a reader wants from a picture is the twenty types and the relations between
them, so `--instances` is for the cases that need evidence.

**The picture is a projection, and the file says so.** A graph viewer draws what it can see, and
this domain format has no cardinality, no type hierarchy and no `kind`/`role`/`phase`/`relator`
distinction — so a graph that looks complete is missing exactly what the modelling layer knows.
That is the same loss as reading an exported RDF and concluding the ontology is thin. The export
emits that as a comment in the document rather than leaving it to be rediscovered.

## Known limitations

- **Reads reflect the loaded graph.** A write refreshes it in place, but a domain edited
  by another process is only picked up on the next load or write.
- **Traversal is single-hop; `walk` is bounded.** `ontology_links` and `traverse` follow one
  relation. `walk` follows declared failure directions outward — two hops by default, five at
  most, and only over relations that declare `propagation`. Anything further, or a relation
  nobody declared a direction for, is more calls and more declarations.
- **Writes are not transactional.** A write rewrites its instance file; there is no
  rollback and no concurrent-write protection.
- **Role resolution is prefix-based.** It matches an agent id against the configured map,
  so it inherits whatever the runtime's naming gives — in DSH's `headless` profile an
  agent id is a bare `session-<uuid>` with no config-id prefix. Run once with roles unset
  and read the id out of the refusal rather than guessing.
- **The domain format is ours.** It is not a standard, and there is no migration tool.

## Compatibility

Tested against `@deepseek-ai/dsh` **0.1.7-rc.2**. DSH is on an `0.1.x` alpha/RC line where
container types move quickly, and `engines.dsh` is declarative only — DSH does not enforce
it, so a newer host will not refuse to load this. Re-test after each upstream release.

## License

MIT.
