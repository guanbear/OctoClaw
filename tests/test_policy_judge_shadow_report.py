#!/usr/bin/env python3
import json
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "lib" / "policy_judge_shadow_report.py"
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "policy-judge-shadow-report-v1.json"


class PolicyJudgeShadowReportTests(unittest.TestCase):
    def test_shadow_report_builds_summary_and_drift_counts(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--shadow-fixture",
                str(FIXTURE),
                "--format",
                "json",
            ],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "octoclaw.policy_judge.shadow_report/v1")
        self.assertEqual(payload["summary"]["total_cases"], 6)
        self.assertEqual(payload["summary"]["shadow_compared"], 2)
        self.assertEqual(payload["summary"]["shadow_matched"], 1)
        self.assertEqual(payload["summary"]["shadow_drifted"], 1)
        self.assertEqual(payload["summary"]["missing_shadow_cases"], 4)
        self.assertIn("route", payload["summary"]["drift_fields"])
        drifted = [item for item in payload["records"] if not item["matches_main"]]
        self.assertEqual(len(drifted), 1)
        self.assertEqual(drifted[0]["task"], "帮我改下代码并跑测试")


if __name__ == "__main__":
    unittest.main()
