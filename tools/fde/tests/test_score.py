"""Tests for the use-case scorer.

Run: python -m unittest discover -s tests -t .
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "usecase"))

import score as scorer  # noqa: E402

RUBRIC = scorer.load_yaml(ROOT / "usecase" / "rubric.yaml")
EXAMPLES = ROOT / "usecase" / "examples"


def make_use_case(**overrides) -> dict:
    """A fully evidenced, high-scoring use case, to be broken one field at a time."""
    dimensions = {
        key: {"score": 5, "evidence": "a number and where it came from"}
        for key in RUBRIC["dimensions"]
    }
    use_case = {
        "id": "UC-TEST",
        "name": "test case",
        "owner": "someone",
        "dimensions": dimensions,
        "blockers": [],
        "unknowns": [],
    }
    use_case.update(overrides)
    return use_case


class TestRubric(unittest.TestCase):
    def test_weights_sum_to_one(self):
        total = sum(float(d["weight"]) for d in RUBRIC["dimensions"].values())
        self.assertAlmostEqual(total, 1.0, places=6)

    def test_every_dimension_has_a_low_action(self):
        for key, spec in RUBRIC["dimensions"].items():
            with self.subTest(dimension=key):
                self.assertTrue(str(spec.get("low_action", "")).strip())


class TestDecision(unittest.TestCase):
    def test_full_marks_is_go(self):
        result = scorer.score_use_case(make_use_case(), RUBRIC)
        self.assertEqual(result["decision"], "go")
        self.assertEqual(result["total"], 5.0)

    def test_missing_evidence_is_unknown_and_caps_at_validate(self):
        use_case = make_use_case()
        use_case["dimensions"]["data"] = {"score": 5}  # no evidence
        result = scorer.score_use_case(use_case, RUBRIC)
        self.assertTrue(result["dimensions"]["data"]["unknown"])
        self.assertEqual(result["decision"], "validate-first")
        self.assertTrue(any("missing evidence" in cap for cap in result["caps"]))

    def test_floor_forces_decline(self):
        use_case = make_use_case()
        use_case["dimensions"]["data"] = {"score": 1, "evidence": "no sample obtainable"}
        result = scorer.score_use_case(use_case, RUBRIC)
        self.assertEqual(result["decision"], "decline")
        self.assertTrue(any("floor" in cap for cap in result["caps"]))

    def test_declared_blocker_caps_at_validate(self):
        result = scorer.score_use_case(make_use_case(blockers=["no lawful access"]), RUBRIC)
        self.assertEqual(result["decision"], "validate-first")

    def test_no_owner_caps_at_validate(self):
        result = scorer.score_use_case(make_use_case(owner=""), RUBRIC)
        self.assertEqual(result["decision"], "validate-first")
        self.assertTrue(any("owner" in cap for cap in result["caps"]))

    def test_no_business_value_floor_forces_decline(self):
        use_case = make_use_case()
        use_case["dimensions"]["value"] = {"score": 0, "evidence": "nobody will name a number"}
        result = scorer.score_use_case(use_case, RUBRIC)
        self.assertEqual(result["decision"], "decline")
        self.assertTrue(any("floor" in cap for cap in result["caps"]))

    def test_a_cap_never_raises_a_decision(self):
        # A blocker on an otherwise weak case must not lift it out of decline.
        use_case = make_use_case(blockers=["no lawful access"])
        use_case["dimensions"] = {
            key: {"score": 0, "evidence": "nothing works yet"}
            for key in RUBRIC["dimensions"]
        }
        result = scorer.score_use_case(use_case, RUBRIC)
        self.assertEqual(result["decision"], "decline")


class TestExamples(unittest.TestCase):
    def test_aiops_reaches_go(self):
        result = scorer.score_use_case(scorer.load_yaml(EXAMPLES / "aiops-triage.yaml"), RUBRIC)
        self.assertEqual(result["decision"], "go")

    def test_memory_service_needs_validation(self):
        result = scorer.score_use_case(scorer.load_yaml(EXAMPLES / "sample-service.yaml"), RUBRIC)
        self.assertEqual(result["decision"], "validate-first")

    def test_contract_review_is_declined(self):
        result = scorer.score_use_case(scorer.load_yaml(EXAMPLES / "contract-review.yaml"), RUBRIC)
        self.assertEqual(result["decision"], "decline")

    def test_every_example_renders(self):
        for path in sorted(EXAMPLES.glob("*.yaml")):
            with self.subTest(example=path.name):
                text = scorer.render(scorer.score_use_case(scorer.load_yaml(path), RUBRIC))
                self.assertIn("## Scorecard", text)


if __name__ == "__main__":
    unittest.main()
