#!/usr/bin/env python3
import tempfile
import unittest

from lib.eval_state_machine import DEFAULT_CASES_FILE, run_state_machine_eval


class EvalStateMachineTests(unittest.TestCase):
    def test_state_machine_catalog_passes_with_full_coverage(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-state-machine-eval-") as tmpdir:
            report = run_state_machine_eval(
                tasks_file=DEFAULT_CASES_FILE,
                workspace=tmpdir,
                freeze_time="2026-04-02T00:00:00+00:00",
            )

        self.assertEqual(report["summary"]["total_cases"], 3)
        self.assertEqual(report["summary"]["passed_cases"], 3)
        self.assertEqual(report["summary"]["failed_cases"], 0)
        self.assertEqual(report["summary"]["coverage"]["state_coverage_rate"], 1.0)
        self.assertEqual(report["summary"]["coverage"]["transition_coverage_rate"], 1.0)
        self.assertEqual(report["state_transition_matrix"]["unclaimed"]["claimed"], 1)
        self.assertEqual(report["state_transition_matrix"]["claimed"]["stale"], 1)
        self.assertEqual(report["state_transition_matrix"]["stale"]["recovered"], 1)
        self.assertEqual(report["state_transition_matrix"]["running"]["done"], 1)


if __name__ == "__main__":
    unittest.main()
