# What it looks like when an agent uses the ontology

A real turn against the bundled example domain, on DSH 0.1.7-rc.2, headless. Nothing about the
question or the answer is hard-coded anywhere: the tools the agent could call were derived from
the domain's YAML, and so were the descriptions it read to decide how to call them.

**The question**

> Which projects are at risk or delayed? For each one, tell me who is accountable and which open
> high-severity issues it has. Answer using the ontology.

**What it called** — every one of these is a query the domain declared, not a tool anyone wrote:

| Called | Declared as |
|---|---|
| `at_risk_projects` | `filter_by` on `Project` where status is `AtRisk` or `Delayed` |
| `accountable_for` (×3) | a `traverse` along the accountability relation |
| `open_issues_of` | a `traverse` along the issue relation, filtered to open |
| `high_severity_open_issues` | `filter_by` on `Issue` where status is open and severity is high |

**What it answered**

Using the ontology, there are **two** projects that are at risk or delayed.

## 1. P-2026-001 — AtRisk
- **Customer:** CUST-NORTHWIND
- **Due date:** 2026-11-30 · **Contracted value:** €480,000
- **Accountable:** Wei Lin (EMP-LIN), Delivery Lead *(also the project owner)*
- **Open high-severity issues (2):**
  - **ISSUE-101** (raised 2026-08-12) — "Stable interface for the customs feed still not agreed, blocking integration" · assignee: EMP-OKAFOR
  - **ISSUE-103** (raised 2026-09-18) — "Customer network team has not opened the required firewall range" · assignee: EMP-LIN

## 2. P-2026-003 — Delayed
- **Customer:** CUST-HELIOS
- **Due date:** 2026-10-15 · **Contracted value:** €610,000
- **Accountable:** Wei Lin (EMP-LIN), Delivery Lead *(also the project owner)*
- **Open high-severity issues (1):**
  - **ISSUE-105** (raised 2026-09-08) — "Replacement inverter units slipped two weeks at the supplier" · assignee: EMP-PETROV

**Note:** Wei Lin is accountable for both projects, so the delivery risk is concentrated on one person. No other project appears in the at-risk/delayed shortlist, and no other open high-severity issues exist outside these two projects.

**Two things worth noticing**

The last line — *"the delivery risk is concentrated on one person"* — is not a lookup. It is a
conclusion that needs the graph: accountability is a relation here, not a field, so "the same
person is accountable for both at-risk projects" is something the domain makes answerable.

The earlier line — *"The Project entities have no name field, just id"* — is the other half. The
schema does not declare a project name, so the agent reported ids. A model left to itself would
have invented plausible project names; a model reading a declared world reports what that world
contains. That is the difference between a schema and a suggestion.

**Reproducing it**

```sh
export DSH_HOME=/path/to/a/profile
export DEEPWORK_ONTOLOGY_ROOT=packages/ontology/examples/project-delivery
dsh rescue "Which projects are at risk or delayed? For each one, tell me who is accountable and   which open high-severity issues it has. Answer using the ontology."
```
