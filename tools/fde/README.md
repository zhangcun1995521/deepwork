# FDE Toolkit

> A working toolkit for forward-deployed work: decide what to build, structure what the customer said, and prove the result.
>
> **I abstracted six years of solution architecture and forward-deployed delivery into a toolkit.**

Most AI delivery failures are not engineering failures. They are decisions made too early: a use case that was never worth doing, requirements that were never structured, a "we'll measure it later" that never happened. This repo is the tooling for those three moments.

## The delivery loop this serves

| # | Stage | What it decides | Toolkit |
|---|---|---|---|
| 1 | **Qualify** | Is this use case worth doing at all? | `usecase` ✅ |
| 2 | **Discover** | What did the customer actually say? | `tools/discovery` — roadmap |
| 3 | **Model** | What is the enterprise world here? | [DeepWork](https://github.com/zhangcun1995521/deepwork) |
| 4 | **Build** | What is the smallest thing that proves it? | roadmap |
| 5 | **Prove** | How do we know it works? | `tools/eval` — roadmap |
| 6 | **Hand over** | Can the customer run it without us? | roadmap |

The shape of this toolkit is deliberate: **one framework, a few tools that actually run.** A repo of thirteen template files proves nothing; a tool that takes an input, produces an output, and can be wrong proves something.

## The rule every tool here must satisfy

1. **Input in, artifact out.** No tool is a document. It reads a file and writes a report, a scorecard, or a checklist.
2. **Its output can be judged.** A score, a pass/fail, a list of missing items — not "considerations to think about".
3. **I used it on real work before shipping it.** If I have not run it against a real situation, it stays on the roadmap.

## Tools

### `usecase` — use case qualification

Scores a candidate use case across five dimensions, applies hard caps, and returns a decision: **go**, **validate first**, or **decline** — with the missing evidence named.

```sh
python tools/fde/usecase/score.py tools/usecase/examples/sample-service.yaml
```

It refuses to call something ready when its evidence is missing: a dimension with no evidence is counted as *unknown*, and any unknown caps the decision at "validate first". Degrading silently is how a pilot becomes a promise nobody can keep.

Rubric, weights and thresholds live in [`tools/fde/usecase/rubric.yaml`](tools/fde/usecase/rubric.yaml) and are meant to be edited per organisation.

### Roadmap

Not built yet. Listed here so the gap is visible, and so nothing gets scaffolded before it is used twice.

- `tools/discovery` — turn a customer conversation transcript into structured output: actors, scenarios, data sources, constraints, success criteria
- `tools/eval` — an evaluation harness for agent and RAG work: build the case set, run it, report regressions
- `tools/poc` — POC scaffolding and the checklist that decides whether a demo is a demo or a deliverable
- `playbook/` — per stage: what the artifact is, what "done" means, what usually goes wrong

## Running it

Requires Python 3.11+ and PyYAML.

```sh
pip install -r requirements.txt

# score a use case
python tools/fde/usecase/score.py tools/usecase/examples/sample-service.yaml

# start a blank one
python tools/fde/usecase/score.py --new UC-007 > uc-007.yaml

# tests
python -m unittest discover -s tests -t .
```

Exit code is 0 for **go** and **validate first**, and 1 for **decline** — so the
scorer can gate a pipeline rather than only inform a meeting.

## Status

Early. One tool, tested, used.

| Item | State |
|---|---|
| `usecase` | ✅ working, 3 worked examples, 13 tests pass |
| Rubric | ✅ editable YAML, weights sum enforced by a test |
| Everything else | roadmap |

## Licence

MIT. See [LICENSE](LICENSE).
