#!/usr/bin/env python3
import json
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HARNESS_GATE = REPO_ROOT / "lib" / "harness_gate.py"


class HarnessGateTests(unittest.TestCase):
    def test_quick_preset_lists_expected_modules(self) -> None:
        result = subprocess.run(
            ["python3", str(HARNESS_GATE), "--preset", "quick", "--list", "--format", "json"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["preset"], "quick")
        self.assertIn("tests.test_router_policy_v2_goldens", payload["modules"])
        self.assertIn("tests.test_route_goldens", payload["modules"])
        self.assertIn("tests.test_policy_judge_shadow_report", payload["modules"])
        self.assertIn("tests.test_replay_validation", payload["modules"])
        self.assertIn("tests.test_acceptance_runtime", payload["modules"])
        self.assertIn("tests.test_runner_runtime", payload["modules"])
        self.assertIn("tests.test_octoclaw_runtime_extension", payload["modules"])

    def test_full_preset_extends_quick_coverage(self) -> None:
        result = subprocess.run(
            ["python3", str(HARNESS_GATE), "--preset", "full", "--list", "--format", "json"],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["preset"], "full")
        self.assertIn("tests.test_replay_automation", payload["modules"])
        self.assertIn("tests.test_replay_validation", payload["modules"])
        self.assertIn("tests.test_delivery_relay_reconcile", payload["modules"])
        self.assertIn("tests.test_acceptance_runtime", payload["modules"])
        self.assertIn("tests.test_task_anchor_commands", payload["modules"])
        self.assertGreater(len(payload["modules"]), 7)


if __name__ == "__main__":
    unittest.main()
