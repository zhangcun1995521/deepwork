# infrastructure

> The machines and services, and what is wired to what — the layer a question about impact needs.

Four object types, four relations, eleven synthetic instances. The point of the example is not the
data: it is which questions become askable once these types exist — and which one of them turned out
to need a new primitive rather than a new type.

## A node is an ordinary object type

There is no `Node`, no node-kind column, no graph table. `Service`, `Cluster`, `Device` and `Rack`
are types like any other, they derive the same read tools, and they appear in the same `type` enum
as everything else a deployment declares. A graph layer of its own would be a second place where
"what exists" is written down, and the second one is the one that goes stale.

## The arrow and the failure are two different facts

A relation is drawn from one end to the other, and where a **failure** travels along it is a separate
fact that nothing about the arrow tells you. Three of the four here run against their arrow, and one
runs both ways — because on a device-cluster pair both directions are real:

| relation | drawn | `propagation` | a failure travels |
|---|---|---|---|
| `depends_on` | dependent → dependency | `to_from` | **against** the arrow: the dependency fails and the dependent is affected |
| `hosted_by` | service → cluster | `to_from` | against the arrow: the cluster fails and its services go with it |
| `in_cluster` | device → cluster | `both` | both ways: the control plane fails and its machines go out of service; enough machines fail and the cluster has no quorum left — which is why a rack losing power is a cluster event and not only a hardware one |
| `in_rack` | device → rack | `to_from` | against the arrow: the rack fails and the machines on it are gone |

`depends_on` is the one that catches people: the edge points from `checkout` to `payments`, and the
failure travels from `payments` back to `checkout`. Nothing in the arrow says so, and nothing in the
relation's name says so either — which is why the direction is now a *declaration* rather than
something a reader, or the engine, is expected to recover from the shape of the edge.

`in_cluster` is the one that catches people twice: it is the only relation here whose failure travels
*both* ways, and declaring it that way is what lets a walk start at a rack and end at a service — rack
to the machines on it, machines to the cluster that needs them, cluster to the services it hosts.

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

## What a failure reaches

`blast_radius` is the question this example was built around: what does a failure on this object
reach. It is a walk rather than a read — **three hops, because that is how long this pack's physical
chain is** (rack → machine → cluster → service), and five at most, following the direction each
relation declares and nothing else:

```
ontology_query({ mode: "blast_radius", object_id: "SVC-PAYMENTS" })
  → SVC-CHECKOUT-STAGING   hop 1 via depends_on (hard_dep)
    SVC-CHECKOUT           hop 1 via depends_on (hard_dep)
    SVC-LEDGER-EXPORT      hop 1 via depends_on (hard_dep)
```

That is the call the read tools cannot answer: `ontology_links({ relation: "depends_on", from:
"SVC-PAYMENTS" })` returns nothing, because every `depends_on` edge in this pack points *at*
payments.

Starting at the cluster is where the second hop earns its place:

```
ontology_query({ mode: "blast_radius", object_id: "CL-PROD-01" })
  → SVC-CHECKOUT, SVC-LEDGER-EXPORT, SVC-PAYMENTS   hop 1 via hosted_by (runtime_dep)
    DEV-01, DEV-02, DEV-03                          hop 1 via in_cluster (runtime_dep)
    SVC-CHECKOUT-STAGING                            hop 2 via depends_on (hard_dep)
```

The last line is the one worth noticing: a *staging* service is inside a production cluster's blast
radius, because it depends on a service that is served there. No relation in this pack says that;
two hops of declared failure directions do. Every reached object also carries the hop it was reached
at, the relation that reached it and that relation's semantics, because a blast radius is a shape:
a flat list of seven ids would not distinguish "all of these are wired to the cluster" from "one of
these is two steps out, through another one in the same list". The walk names the relation each
entity was reached by and not the entity it came through, so the hop count is measured from the
start rather than being a path drawn back to it.

The third hop is where the physical end of the pack earns its place, and it is the reason the depth
is declared rather than left at a default:

```
ontology_query({ mode: "blast_radius", object_id: "RK-01" })
  → DEV-01, DEV-02                 hop 1 via in_rack (hard_dep)
    CL-PROD-01                     hop 2 via in_cluster (runtime_dep)
    SVC-CHECKOUT, SVC-LEDGER-EXPORT, SVC-PAYMENTS   hop 3 via hosted_by (runtime_dep)
```

A rack losing power is one fact and the services on it are the consequence — which is a claim about
the third hop, not the first, and a walk declared at two would have returned the machines and the
cluster and looked finished.

`failure_sources` is the same walk with the direction reversed, and it is a second *declaration*
rather than an argument on the first: what could take this down is a different question from what
this takes down, and folding both into one mode would answer with a set nobody can read either way.

Three limits, all of them declared rather than discovered:

- **Two hops by default, five at most.** A declaration asking for more is clamped, and the clamp is
  reported rather than applied in silence. The depth is stated in the tool description, so the model
  can see the bound before it concludes that the list it has is everything.
- **Only relations that declare `propagation` are walked.** `semantics_tag` is a tag — what a relation
  means — and it is not a direction, so a relation carrying one and no direction is not followed at
  all. A walk that read meaning as direction would be reporting an invention.
- **The start is an identity, not a type.** The walk has no `on` to filter by, so it does not apply
  a type's default state. `SVC-LEDGER-EXPORT` is `retired` and still appears in `SVC-PAYMENTS`'
  blast radius: something really does depend on it, the edge is in the graph, and the walk reports
  what is there rather than what is running.

## Regenerating

```
node packages/ontology/scripts/validate-domain.ts packages/ontology/examples/infrastructure
node packages/ontology/scripts/show-derivation.ts packages/ontology/examples/infrastructure
```

Everything here is synthetic: invented services, invented clusters, invented racks.
