# infrastructure

> The machines and services, and what is wired to what — the layer a question about impact needs.

Four object types, four relations, eleven synthetic instances. The point of the example is not the
data: it is which questions become askable once these types exist, and which one does not.

## A node is an ordinary object type

There is no `Node`, no node-kind column, no graph table. `Service`, `Cluster`, `Device` and `Rack`
are types like any other, they derive the same read tools, and they appear in the same `type` enum
as everything else a deployment declares. A graph layer of its own would be a second place where
"what exists" is written down, and the second one is the one that goes stale.

## The arrow and the failure do not always point the same way

This is the part worth reading the schema for.

| relation | drawn | a failure travels |
|---|---|---|
| `depends_on` | dependent → dependency | **against** the arrow: the dependency fails and the dependent is affected |
| `hosted_by` | service → cluster | **with** the arrow: the cluster fails and its services go with it |
| `in_cluster` | device → cluster | with the arrow |
| `in_rack` | device → rack | with the arrow |

`depends_on` is the one that catches people: the edge points from `checkout` to `payments`, and the
failure travels from `payments` back to `checkout`. A reader looking for impact has to know which
way each edge goes, which is why every relation states it in its own description rather than
leaving it to be guessed from the name.

The other thing the data shows on its own: `payments` and `checkout` have nothing declared in
common, and they still go down together — because both are `hosted_by` the same cluster. That is
the whole value of having the machines in the same world as the work.

## A retired service reads out, and the read says so

`SVC-LEDGER-EXPORT` is `retired`. It still depends on `payments`, and a default read does not return
it:

```
ontology_find({ type: "Service" })
  → 3 returned, "excludedByState": 1
```

That is the same vouched-for-state rule the other examples use, doing here what it does there: a
service nobody runs any more is not part of "what is running", and the count is stated rather than
the list being quietly shortened.

## The limit: the direction of a failure is written down, not computed

Nothing in this repository walks a failure outward from an object. Reads follow one relation, one
hop, **forwards**. So of the two halves of the impact question, only one is answerable:

```
ontology_links({ relation: "depends_on", from: "SVC-CHECKOUT" })
  → SVC-PAYMENTS                      ← "what does this need"          works

ontology_links({ relation: "depends_on", from: "SVC-PAYMENTS" })
  → []                                ← "who needs this"               empty
```

The second call is the question an incident actually asks — *payments is failing, what else is
affected* — and it returns nothing, because the traversal only goes with the arrow. It is also one
hop: a rack losing power reaches services only through rack → device → cluster → service.

Both halves are therefore absent today: `direction` (follow a relation incoming, outgoing or both)
and depth. Until they exist, impact is a fact a person reads off these relations, and the relations
say so.

## Regenerating

```
node packages/ontology/scripts/validate-domain.ts packages/ontology/examples/infrastructure
node packages/ontology/scripts/show-derivation.ts packages/ontology/examples/infrastructure
```

Everything here is synthetic: invented services, invented clusters, invented racks.
