#!/usr/bin/env python3
"""Qualify a candidate AI use case before anything gets built.

Reads a use-case file, applies the rubric in rubric.yaml, prints a report, and
exits non-zero only when the decision is to decline.

    python tools/usecase/score.py tools/usecase/examples/sample-service.yaml
    python tools/usecase/score.py --json path/to/usecase.yaml
    python tools/usecase/score.py --new UC-007 > uc-007.yaml
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

RUBRIC_PATH = Path(__file__).with_name("rubric.yaml")

# Ordered worst to best. A cap can only move a decision down this list.
DECISIONS = ["decline", "validate-first", "go"]
DECISION_LABEL = {
    "go": "GO",
    "validate-first": "VALIDATE FIRST",
    "decline": "DECLINE",
}


def load_yaml(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def decision_cap(base: str, cap: str) -> str:
    """Return the lower of two decisions."""
    return base if DECISIONS.index(base) <= DECISIONS.index(cap) else cap


def score_use_case(use_case: dict, rubric: dict) -> dict:
    """Score one use case against the rubric.

    A dimension counts as unknown when it has no score or no written evidence.
    Unknown is not zero: it means the input cannot support a decision, which is
    why it caps the outcome rather than simply lowering it.
    """
    declared = use_case.get("dimensions") or {}
    dimensions = {}

    for key, spec in rubric["dimensions"].items():
        entry = declared.get(key) or {}
        raw_score = entry.get("score")
        evidence = (entry.get("evidence") or "").strip()
        unknown = raw_score is None or not evidence
        dimensions[key] = {
            "label": spec["label"],
            "weight": float(spec["weight"]),
            "question": spec["question"],
            "low_action": " ".join(str(spec.get("low_action", "")).split()),
            "floor": spec.get("floor"),
            "requires_baseline": bool(spec.get("requires_baseline")),
            "evidence": evidence,
            "score": None if unknown else float(raw_score),
            "unknown": unknown,
        }

    scored = [d for d in dimensions.values() if d["score"] is not None]
    weight_scored = sum(d["weight"] for d in scored)
    total = (
        sum(d["score"] * d["weight"] for d in scored) / weight_scored
        if weight_scored
        else 0.0
    )

    caps: list[str] = []
    if not scored:
        base = "validate-first"
        caps.append("no dimension could be scored — nothing here is evidence-backed yet")
    elif total >= float(rubric["thresholds"]["go"]):
        base = "go"
    elif total >= float(rubric["thresholds"]["validate"]):
        base = "validate-first"
    else:
        base = "decline"

    decision = base

    unknowns = [d["label"] for d in dimensions.values() if d["unknown"]]
    if unknowns:
        decision = decision_cap(decision, "validate-first")
        caps.append("missing evidence on: " + ", ".join(unknowns))

    for key, dim in dimensions.items():
        floor = dim["floor"]
        if floor is not None and dim["score"] is not None and dim["score"] <= float(floor):
            decision = decision_cap(decision, "decline")
            caps.append(f"{dim['label']} scored {dim['score']:g}, at or below its floor of {floor:g}")

    blockers = [str(b) for b in (use_case.get("blockers") or [])]
    if blockers:
        decision = decision_cap(decision, "validate-first")
        caps.append("declared blockers: " + "; ".join(blockers))

    if not (use_case.get("owner") or "").strip():
        decision = decision_cap(decision, "validate-first")
        caps.append("no named owner")

    actions: list[str] = []
    for key, dim in dimensions.items():
        if dim["unknown"]:
            actions.append(f"**{dim['label']}** — score it and write the evidence: {dim['question']}")
        elif dim["score"] is not None and dim["score"] <= 3:
            actions.append(f"**{dim['label']}** — {dim['low_action']}")
        elif dim["requires_baseline"]:
            actions.append(f"**{dim['label']}** — confirm the baseline is recorded before building")

    return {
        "id": use_case.get("id") or "(no id)",
        "name": use_case.get("name") or "(unnamed use case)",
        "owner": use_case.get("owner") or "",
        "decision": decision,
        "base_decision": base,
        "total": round(total, 2),
        "caps": caps,
        "blockers": blockers,
        "unknowns": [str(u) for u in (use_case.get("unknowns") or [])],
        "actions": actions,
        "dimensions": dimensions,
    }


def render(result: dict) -> str:
    lines = [
        f"# Use case assessment — {result['name']}",
        "",
        f"**Decision: {DECISION_LABEL[result['decision']]}**  "
        f"(weighted score {result['total']} / 5.0)",
        "",
        f"- id: `{result['id']}`",
        f"- owner: {result['owner'] or '*none named*'}",
        "",
        "## Scorecard",
        "",
        "| Dimension | Weight | Score | Evidence |",
        "|---|---|---|---|",
    ]
    for dim in result["dimensions"].values():
        score = "unknown" if dim["score"] is None else f"{dim['score']:g}"
        evidence = dim["evidence"] or "—"
        lines.append(f"| {dim['label']} | {dim['weight']:.2f} | {score} | {evidence} |")

    if result["caps"]:
        lines += ["", "## Why not higher", ""]
        lines += [f"- {cap}" for cap in result["caps"]]

    if result["blockers"] or result["unknowns"]:
        lines += ["", "## Declared blockers and unknowns", ""]
        lines += [f"- BLOCKER: {b}" for b in result["blockers"]]
        lines += [f"- UNKNOWN: {u}" for u in result["unknowns"]]

    if result["actions"]:
        lines += ["", "## Next actions", ""]
        lines += [f"{i}. {action}" for i, action in enumerate(result["actions"], 1)]

    lines += [
        "",
        "---",
        "",
        f"_Scored against `{RUBRIC_PATH.name}`. A dimension without evidence counts as "
        "unknown and caps the decision — unknown is not the same as zero._",
    ]
    return "\n".join(lines)


TEMPLATE = """id: {uc_id}
name: <one line, in the customer's words>
owner: <the person who loses the work today>
context: >
  What happens today, how often, and who feels the pain. Numbers if you have them.

dimensions:
  value:
    score:            # 0-5
    evidence:         # the number and where it came from
  feasibility:
    score:
    evidence:
  data:
    score:
    evidence:         # prove access with a real query, not a promise
  verifiability:
    score:
    evidence:         # the case set, the baseline, the number that means success
  adoption:
    score:
    evidence:

blockers: []
unknowns: []
"""


def main(argv: list[str] | None = None) -> int:
    # Reports carry non-ASCII text; a Windows console defaults to a legacy code
    # page and would raise on the first character it cannot encode.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("use_case", nargs="?", help="path to a use-case YAML file")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of markdown")
    parser.add_argument("--new", metavar="ID", help="print a blank template and exit")
    args = parser.parse_args(argv)

    if args.new:
        print(TEMPLATE.format(uc_id=args.new), end="")
        return 0

    if not args.use_case:
        parser.error("give a use-case file, or --new ID to start one")

    rubric = load_yaml(RUBRIC_PATH)
    result = score_use_case(load_yaml(Path(args.use_case)), rubric)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(render(result))

    return 1 if result["decision"] == "decline" else 0


if __name__ == "__main__":
    sys.exit(main())
