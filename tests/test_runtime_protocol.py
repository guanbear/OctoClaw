#!/usr/bin/env python3
import json
import unittest
from pathlib import Path

from lib.runtime_protocol import (
    BRIEF_SCHEMA_VERSION,
    CAPABILITY_BOUND_FAILURE_SCHEMA_VERSION,
    DELEGATED_MATERIALIZATION_SCHEMA_VERSION,
    WORKER_RESULT_SCHEMA_VERSION,
    build_capability_bound_failure,
    build_delegated_materialization,
    build_result_contract,
    build_task_brief,
    normalize_delegated_materialization,
    normalize_worker_result,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
BRIEF_SCHEMA = REPO_ROOT / "schemas" / "runtime-brief-v1.schema.json"
RESULT_SCHEMA = REPO_ROOT / "schemas" / "worker-result-v1.schema.json"
MATERIALIZATION_SCHEMA = REPO_ROOT / "schemas" / "delegated-materialization-v1.schema.json"
FAILURE_SCHEMA = REPO_ROOT / "schemas" / "capability-bound-failure-v1.schema.json"


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
            context_pack={
                "schema_version": "octoclaw.context_pack/v1",
                "related_task_count": 1,
                "summary": "auth-refactor task is blocked with report ready",
            },
            context_budget={"prefer_context_pack": True},
            skill_bundle=["git", "tests"],
            expected_done="+8min",
            summary_hint="2-5句结论，必要时指出风险",
        )
        self.assertEqual(brief["schema_version"], BRIEF_SCHEMA_VERSION)
        self.assertEqual(brief["expected_output"]["schema_version"], WORKER_RESULT_SCHEMA_VERSION)
        self.assertTrue(brief["review_required"])
        self.assertIn("详细报告默认写到 /tmp/task-1.md", brief["constraints"])
        self.assertIn("follow-up 优先使用 context_pack", " ".join(brief["constraints"]))
        self.assertEqual(brief["context_pack"]["schema_version"], "octoclaw.context_pack/v1")
        self.assertTrue(brief["context_budget"]["prefer_context_pack"])
        self.assertEqual(brief["work_contract"], "")
        self.assertIn("repo", brief["allowed_tools"])
        self.assertIn("test", brief["allowed_tools"])
        self.assertTrue(brief["expected_artifacts"][0].endswith("/tmp/task-1.md"))
        self.assertTrue(brief["retrieval_hints"]["prefer_context_pack"])
        self.assertEqual(brief["retrieval_hints"]["followup_command_hint"], "retrieve task-1")
        self.assertEqual(brief["budget_policy"], {})
        self.assertEqual(brief["merge_contract"], "")
        self.assertEqual(brief["handoff_contract"], "")

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
        self.assertEqual(payload["verification"], [])
        self.assertEqual(payload["user_safe_summary"], "Found the root cause and prepared a patch.")

    def test_schema_required_fields_match_protocol_helpers(self) -> None:
        brief_schema = json.loads(BRIEF_SCHEMA.read_text(encoding="utf-8"))
        result_schema = json.loads(RESULT_SCHEMA.read_text(encoding="utf-8"))
        materialization_schema = json.loads(MATERIALIZATION_SCHEMA.read_text(encoding="utf-8"))
        failure_schema = json.loads(FAILURE_SCHEMA.read_text(encoding="utf-8"))
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
        failure = build_capability_bound_failure(
            "runner",
            "runner_playbook_missing",
            detail="no registered playbook",
            missing_capabilities=["registered_runner_playbook"],
        )
        materialization = build_delegated_materialization(
            lane="runner",
            kind="runner_playbook",
            status="materialization_failed",
            execution_contract="inspect_report",
            runner_job_id="",
            capability_failure=failure,
        )
        for field in brief_schema["required"]:
            with self.subTest(field=field):
                self.assertIn(field, brief)
        for field in result_schema["required"]:
            with self.subTest(field=field):
                self.assertIn(field, result)
        for field in failure_schema["required"]:
            with self.subTest(field=field):
                self.assertIn(field, failure)
        for field in materialization_schema["required"]:
            with self.subTest(field=field):
                self.assertIn(field, materialization)

    def test_build_delegated_materialization_keeps_lane_and_failure(self) -> None:
        failure = build_capability_bound_failure(
            "spawn_single",
            "spawn_backend_execution_failed",
            detail="openclaw not found",
            missing_capabilities=["spawn_backend_execution"],
        )
        materialization = build_delegated_materialization(
            lane="spawn_single",
            kind="spawn_child_task",
            execution_contract="deliverable_work",
            task_id="research-1",
            child_spec_id="research-1",
            session_key="agent:main:slack:direct:u1",
            executed=False,
            capability_failure=failure,
        )
        self.assertEqual(materialization["schema_version"], DELEGATED_MATERIALIZATION_SCHEMA_VERSION)
        self.assertEqual(materialization["lane"], "spawn_single")
        self.assertEqual(materialization["kind"], "spawn_child_task")
        self.assertEqual(materialization["status"], "materialized")
        self.assertEqual(materialization["task_id"], "research-1")
        self.assertEqual(materialization["capability_failure"]["schema_version"], CAPABILITY_BOUND_FAILURE_SCHEMA_VERSION)

    def test_normalize_delegated_materialization_marks_failure_when_reason_present(self) -> None:
        normalized = normalize_delegated_materialization(
            {
                "lane": "runner",
                "kind": "runner_playbook",
                "capability_failure": {
                    "reason": "runner_playbook_missing",
                    "detail": "no playbook",
                },
            }
        )
        self.assertEqual(normalized["status"], "materialization_failed")
        self.assertEqual(normalized["capability_failure"]["reason"], "runner_playbook_missing")


if __name__ == "__main__":
    unittest.main()
