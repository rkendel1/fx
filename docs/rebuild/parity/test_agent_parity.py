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
    def results(self, status, diffs, notices=()):
        return {"scenarios": {"s": {"verdict": {"status": status, "differences": diffs}}}, "notices": list(notices)}

    def corpus(self, approvals=None, unsupported=(), accepted=(), notices=()):
        return {
            "approvals": approvals or {},
            "approval_record": {"accepted_as_known_limitations": list(accepted)},
            "unsupported_behaviors": [
                {"id": u, "category": "compatibility", "decision": "unsupported_in_first_release", "when_requested": "refused"}
                if not isinstance(u, tuple) else {"id": u[0], "category": "compatibility"}
                for u in unsupported
            ],
            "categories": {"compatibility": ""},
            "required_notices": [{"file": f, "marker": "M"} for f in notices],
        }

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

    def test_a_decided_unsupported_behavior_stays_visible_but_does_not_block(self):
        g = ap.gate(self.corpus(unsupported=["permission_modes"]), self.results("match", []))
        self.assertEqual(g["unsupported_behaviors"], ["permission_modes"])
        self.assertEqual(g["undecided_unsupported_behaviors"], [])
        self.assertTrue(g["retirement_ready"])

    def test_an_undecided_unsupported_behavior_blocks_retirement(self):
        g = ap.gate(self.corpus(unsupported=[("permission_modes",)]), self.results("match", []))
        self.assertEqual(g["undecided_unsupported_behaviors"], ["permission_modes"])
        self.assertFalse(g["retirement_ready"])

    def test_a_decision_without_a_stated_runtime_behavior_is_not_a_decision(self):
        self.assertFalse(ap.valid_decision({"decision": "unsupported_in_first_release", "when_requested": "  "}))
        self.assertFalse(ap.valid_decision({"when_requested": "refused"}))
        self.assertTrue(ap.valid_decision({"decision": "unsupported_in_first_release", "when_requested": "refused"}))

    def test_an_invalid_scenario_invalidates_the_run(self):
        g = ap.gate(self.corpus(), self.results("unclassified_difference", []))
        self.assertFalse(g["run_is_valid"])

    def test_a_known_limitation_approval_counts_only_while_the_retry_warning_is_verified(self):
        diffs = [{"field": "terminal", "class": "limitation"}]
        corpus = self.corpus({"s.terminal": "approved"}, accepted=["s.terminal"], notices=["README.md"])
        missing = ap.gate(corpus, self.results("classified_differences", diffs, [{"file": "README.md", "marker": "M", "found": False}]))
        self.assertFalse(missing["retirement_ready"])
        self.assertEqual(missing["unapproved_differences"][0]["field"], "terminal")
        none_checked = ap.gate(corpus, self.results("classified_differences", diffs, []))
        self.assertFalse(none_checked["retirement_ready"])
        found = ap.gate(corpus, self.results("classified_differences", diffs, [{"file": "README.md", "marker": "M", "found": True}]))
        self.assertTrue(found["retirement_ready"])
        self.assertTrue(found["release_notices_verified"])

    def test_check_notices_looks_in_the_given_checkout_and_nowhere_else(self):
        import tempfile
        corpus = {"required_notices": [{"file": "README.md", "marker": "WARN"}, {"file": "NOTES.md", "marker": "WARN"}]}
        self.assertEqual([n["found"] for n in ap.check_notices(corpus, None)], [False, False])
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            (root / "README.md").write_text("x WARN y")
            (root / "NOTES.md").write_text("nothing")
            self.assertEqual([n["found"] for n in ap.check_notices(corpus, root)], [True, False])


class Preflight(unittest.TestCase):
    def test_the_runner_refuses_to_run_without_pax_on_path(self):
        import os
        import shutil
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            fake = Path(t, "tool")
            fake.write_text("#!/bin/sh\nexit 0\n")
            fake.chmod(0o755)
            env = {"PATH": t + ":/usr/bin:/bin", "HOME": t}
            self.assertIsNone(shutil.which("pax", path=env["PATH"]), "this test needs a PATH without pax")
            done = subprocess.run(
                [sys.executable, str(Path(ap.__file__)), "run", "--fx-bin", str(fake), "--chip-bin", str(fake),
                 "--turn-tool", str(fake), "--session-tool", str(fake), "--out", str(Path(t, "out.json"))],
                capture_output=True, text=True, env=env,
            )
            self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
            self.assertIn("pax is required", done.stderr)
            self.assertFalse(Path(t, "out.json").exists(), "no result may be written")


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

    def test_every_approval_names_a_declared_difference_and_the_recovery_limitations_are_recorded_as_conditional(self):
        corpus = json.loads(ap.CORPUS.read_text())
        declared = {f"{sc['id']}.{f}" for sc in corpus["scenarios"] for f in sc.get("differences", {})}
        self.assertTrue(set(corpus["approvals"]) <= declared)
        self.assertEqual(set(corpus["approvals"].values()), {"approved"})
        for key in corpus["approval_record"]["accepted_as_known_limitations"]:
            self.assertIn(key, declared)
            self.assertEqual(corpus["approvals"].get(key), "approved")
        # Every approval of a known limitation is conditional on notices that exist.
        self.assertTrue(corpus["required_notices"])

    def test_every_unsupported_behavior_has_a_release_impact_category(self):
        corpus = json.loads(ap.CORPUS.read_text())
        for u in corpus["unsupported_behaviors"]:
            self.assertIn(u["category"], corpus["categories"], u["id"])

    def test_every_unsupported_behavior_has_an_explicit_decision_and_a_stated_runtime_behavior(self):
        corpus = json.loads(ap.CORPUS.read_text())
        self.assertEqual(len(corpus["unsupported_behaviors"]), 10)
        for u in corpus["unsupported_behaviors"]:
            self.assertTrue(ap.valid_decision(u), u["id"])
            self.assertTrue(u["not_a_parity_claim"], u["id"])

    def test_scenario_ids_are_unique(self):
        ids = [s["id"] for s in json.loads(ap.CORPUS.read_text())["scenarios"]]
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()
