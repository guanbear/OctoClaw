#!/usr/bin/env python3
import json
import unittest
from pathlib import Path

from lib.runtime_protocol import (
    BRIEF_SCHEMA_VERSION,
    WORKER_RESULT_SCHEMA_VERSION,
    build_result_contract,
    build_task_brief,
    normalize_worker_result,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
BRIEF_SCHEMA = REPO_ROOT / "schemas" / "runtime-brief-v1.schema.json"
RESULT_SCHEMA = REPO_ROOT / "schemas" / "worker-result-v1.schema.json"


class RuntimeProtocolTests(unittest.TestCase):
    def test_build_task_brief_contains_expected_output_contract(self) -> None:
        brief = build_task_brief(
            task_id="task-1",
            goal="Investigate flaky auth failures and summarize the fix path",
            route="spawn_single",
            worker_pool="octoclaw-code",
            work_type="code",
            phase="implement",
            profile="code",
            protocol="normal",
            review_required=True,
            report_path="/tmp/task-1.md",
            context_summary="recent auth middleware refactor introduced regressions",
            context_path="/tmp/task-1-context.md",
            skill_bundle=["git", "tests"],
            expected_done="+8min",
            summary_hint="2-5句结论，必要时指出风险",
        )
        self.assertEqual(brief["schema_version"], BRIEF_SCHEMA_VERSION)
        self.assertEqual(brief["expected_output"]["schema_version"], WORKER_RESULT_SCHEMA_VERSION)
        self.assertTrue(brief["review_required"])
        self.assertIn("详细报告默认写到 /tmp/task-1.md", brief["constraints"])

    def test_normalize_worker_result_maps_legacy_status_and_report(self) -> None:
        payload = normalize_worker_result(
            {
                "status": "success",
                "summary": "Found the root cause and prepared a patch.",
                "report": "/tmp/task-1.md",
                "files": ["lib/auth.py"],
                "risks": ["Need to verify refresh token compatibility"],
                "next_step": "hand to review worker",
            },
            task_id="task-1",
        )
        self.assertEqual(payload["schema_version"], WORKER_RESULT_SCHEMA_VERSION)
        self.assertEqual(payload["status"], "done")
        self.assertEqual(payload["artifacts"], ["/tmp/task-1.md"])
        self.assertEqual(payload["files"], ["lib/auth.py"])
        self.assertEqual(payload["next_step"], "hand to review worker")

    def test_schema_required_fields_match_protocol_helpers(self) -> None:
        brief_schema = json.loads(BRIEF_SCHEMA.read_text(encoding="utf-8"))
        result_schema = json.loads(RESULT_SCHEMA.read_text(encoding="utf-8"))
        brief = build_task_brief(
            task_id="task-2",
            goal="Draft release notes",
            route="spawn_single",
            worker_pool="octoclaw-research",
            work_type="research",
            phase="report",
            profile="writer",
            protocol="normal",
            review_required=False,
            report_path="/tmp/task-2.md",
            summary_hint="输出一版可直接发给用户的说明",
        )
        result = build_result_contract("输出一版可直接发给用户的说明")
        for field in brief_schema["required"]:
            with self.subTest(field=field):
                self.assertIn(field, brief)
        for field in result_schema["required"]:
            with self.subTest(field=field):
                self.assertIn(field, result)


if __name__ == "__main__":
    unittest.main()
