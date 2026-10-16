"""Unit tests for the parity harness itself: it must flag what it is meant to flag. No binaries."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import agent_parity as ap  # noqa: E402

SIDE = {"terminal": "completed", "answer": "x", "inference_requests": 1, "tool_executions": [], "followup_carries_tool_result": False,
        "side_effects": {"outside_write": False, "shell_marker": False}}


class Judge(unittest.TestCase):
    def test_equal_sides_match(self):
        v = ap.judge({"compare": ["terminal", "answer"], "differences": {}}, SIDE, dict(SIDE))
        self.assertEqual(v["status"], "match")

    def test_an_undeclared_difference_is_never_accepted(self):
        v = ap.judge({"compare": ["answer"], "differences": {}}, SIDE, {**SIDE, "answer": "y"})
        self.assertEqual(v["status"], "unclassified_difference")

    def test_a_declared_difference_is_classified_not_hidden(self):
        sc = {"compare": ["terminal"], "differences": {"answer": {"class": "defect", "why": "w"}}}
        v = ap.judge(sc, SIDE, {**SIDE, "answer": "y"})
        self.assertEqual(v["status"], "classified_differences")
        self.assertEqual(v["differences"][0]["class"], "defect")

    def test_a_declared_difference_that_did_not_occur_is_an_error(self):
        sc = {"compare": ["terminal"], "differences": {"answer": {"class": "defect", "why": "w"}}}
        self.assertEqual(ap.judge(sc, SIDE, dict(SIDE))["status"], "stale_declared_difference")

    def test_terminal_not_completed_is_coarse(self):
        sc = {"compare": ["terminal_not_completed"], "differences": {}}
        a, b = {**SIDE, "terminal": "not_completed"}, {**SIDE, "terminal": "not_completed"}
        self.assertEqual(ap.judge(sc, a, b)["status"], "match")
        self.assertEqual(ap.judge(sc, a, SIDE)["status"], "unclassified_difference")


class Gate(unittest.TestCase):
    def results(self, status, diffs):
        return {"scenarios": {"s": {"verdict": {"status": status, "differences": diffs}}}}

    def corpus(self, approvals=None, unsupported=()):
        return {"approvals": approvals or {}, "unsupported_behaviors": [{"id": u, "category": "compatibility"} for u in unsupported], "categories": {"compatibility": ""}}

    def test_clean_run_with_nothing_open_is_ready(self):
        g = ap.gate(self.corpus(), self.results("match", []))
        self.assertTrue(g["retirement_ready"])

    def test_an_unapproved_difference_blocks_retirement_but_not_the_run(self):
        g = ap.gate(self.corpus(), self.results("classified_differences", [{"field": "terminal", "class": "defect"}]))
        self.assertTrue(g["run_is_valid"])
        self.assertFalse(g["retirement_ready"])

    def test_an_approval_clears_only_its_own_difference(self):
        diffs = [{"field": "terminal", "class": "intentional_change_requires_approval"}]
        g = ap.gate(self.corpus({"s.terminal": "approved"}), self.results("classified_differences", diffs))
        self.assertTrue(g["retirement_ready"])
        g = ap.gate(self.corpus({"s.other": "approved"}), self.results("classified_differences", diffs))
        self.assertFalse(g["retirement_ready"])

    def test_unsupported_behaviors_block_retirement(self):
        g = ap.gate(self.corpus(unsupported=["permission_modes"]), self.results("match", []))
        self.assertFalse(g["retirement_ready"])

    def test_an_invalid_scenario_invalidates_the_run(self):
        g = ap.gate(self.corpus(), self.results("unclassified_difference", []))
        self.assertFalse(g["run_is_valid"])


class Corpus(unittest.TestCase):
    def test_every_declared_difference_has_a_known_class_and_a_reason(self):
        corpus = json.loads(ap.CORPUS.read_text())
        for sc in corpus["scenarios"]:
            for field, d in sc.get("differences", {}).items():
                self.assertIn(d["class"], corpus["classes"], f"{sc['id']}.{field}")
                self.assertTrue(d["why"].strip(), f"{sc['id']}.{field}")
                self.assertNotEqual(d["class"], "match")

    def test_the_required_behaviors_are_all_covered(self):
        corpus = json.loads(ap.CORPUS.read_text())
        covered = {sc["requirement"] for sc in corpus["scenarios"]}
        for required in ("Basic turn", "Tool execution", "Unauthorized tool", "Provider failure", "Cancellation", "Recovery", "Persistence failure"):
            self.assertIn(required, covered)

    def test_every_approval_names_a_declared_difference_and_crash_recovery_is_not_approved(self):
        corpus = json.loads(ap.CORPUS.read_text())
        declared = {f"{sc['id']}.{f}" for sc in corpus["scenarios"] for f in sc.get("differences", {})}
        self.assertTrue(set(corpus["approvals"]) <= declared)
        self.assertEqual(set(corpus["approvals"].values()), {"approved"})
        for key in corpus["approval_record"]["deliberately_not_approved"]:
            self.assertIn(key, declared)
            self.assertNotIn(key, corpus["approvals"])

    def test_every_unsupported_behavior_has_a_release_impact_category(self):
        corpus = json.loads(ap.CORPUS.read_text())
        for u in corpus["unsupported_behaviors"]:
            self.assertIn(u["category"], corpus["categories"], u["id"])

    def test_scenario_ids_are_unique(self):
        ids = [s["id"] for s in json.loads(ap.CORPUS.read_text())["scenarios"]]
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()
