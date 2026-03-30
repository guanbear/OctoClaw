#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib.runtime_task_record import TASK_RECORD_SCHEMA_VERSION, normalize_task_record


REPO_ROOT = Path(__file__).resolve().parents[1]
TASK_STATE_UPDATE = REPO_ROOT / "lib" / "task-state-update.py"
TASK_RECORD_SCHEMA = REPO_ROOT / "schemas" / "runtime-task-record-v1.schema.json"


class RuntimeTaskRecordTests(unittest.TestCase):
    def test_normalize_runner_task_defaults(self) -> None:
        payload = normalize_task_record(
            {
                "id": "runner-1",
                "worker_pool": "octoclaw-runner",
                "status": "queued",
                "summary": "check redis port",
                "route": "runner",
            }
        )
        self.assertEqual(payload["schema_version"], TASK_RECORD_SCHEMA_VERSION)
        self.assertEqual(payload["executor"], "runner")
        self.assertEqual(payload["executor_type"], "runner")
        self.assertEqual(payload["runtime"], "runner")
        self.assertEqual(payload["worker_pool"], "octoclaw-runner")
        self.assertEqual(payload["work_type"], "ops")
        self.assertEqual(payload["phase"], "inspect")
        self.assertEqual(payload["protocol"], "normal")
        self.assertEqual(payload["artifacts"], {})
        self.assertEqual(payload["source"], "octoclaw")
        self.assertTrue(payload["managed_by_octoclaw"])
        self.assertEqual(payload["agent_namespace"], "octoclaw")

    def test_normalize_preserves_custom_artifacts_and_code_metadata(self) -> None:
        payload = normalize_task_record(
            {
                "id": "spawn-1",
                "worker_pool": "octoclaw-code",
                "status": "dispatched",
                "route": "spawn_single",
                "runtime": "subagent",
                "summary": "fix auth bug",
                "report_path": "/tmp/report.md",
                "context_path": "/tmp/context.md",
                "files_changed": ["lib/auth.py"],
                "artifacts": {"custom": "keep-me", "operator_surface": {"operator_hint": "clawteam/tmux test-team"}},
            }
        )
        self.assertEqual(payload["executor"], "subagent")
        self.assertEqual(payload["executor_type"], "subagent")
        self.assertEqual(payload["worker_pool"], "octoclaw-code")
        self.assertEqual(payload["work_type"], "code")
        self.assertEqual(payload["phase"], "implement")
        self.assertEqual(payload["artifacts"]["custom"], "keep-me")
        self.assertEqual(payload["artifacts"]["report_path"], "/tmp/report.md")
        self.assertEqual(payload["artifacts"]["context_path"], "/tmp/context.md")
        self.assertEqual(payload["artifacts"]["files_changed"], ["lib/auth.py"])
        self.assertEqual(payload["artifacts"]["operator_surface"]["schema_version"], "octoclaw.task_display/v1")
        self.assertEqual(payload["artifacts"]["operator_surface"]["operator_hint"], "clawteam/tmux test-team")
        self.assertEqual(payload["artifacts"]["operator_surface"]["task_anchor"]["task_id"], "spawn-1")
        self.assertIn("OctoClaw task", payload["artifacts"]["display_text"])

    def test_normalize_can_infer_from_worker_pool_without_legacy_label(self) -> None:
        payload = normalize_task_record(
            {
                "id": "report-1",
                "worker_pool": "octoclaw-research",
                "profile": "writer",
                "route": "spawn_single",
                "runtime": "subagent",
                "status": "dispatched",
                "summary": "draft the release summary",
            }
        )
        self.assertEqual(payload["executor"], "subagent")
        self.assertEqual(payload["worker_pool"], "octoclaw-research")
        self.assertEqual(payload["work_type"], "research")
        self.assertEqual(payload["phase"], "report")

    def test_normalize_drops_legacy_label_but_keeps_final_worker_result(self) -> None:
        payload = normalize_task_record(
            {
                "id": "done-1",
                "status": "done",
                "summary": "verified the release notes output",
                "route": "spawn_single",
                "runtime": "subagent",
                "worker_pool": "octoclaw-review",
                "report_path": "/tmp/review-report.md",
                "files_changed": ["README.md"],
            }
        )
        self.assertNotIn("legacy_label", payload)
        self.assertNotIn("label", payload)
        self.assertEqual(payload["artifacts"]["worker_result"]["schema_version"], "octoclaw.worker_result/v1")
        self.assertEqual(payload["artifacts"]["worker_result"]["status"], "done")
        self.assertEqual(payload["artifacts"]["worker_result"]["report"], "/tmp/review-report.md")
        self.assertEqual(payload["artifacts"]["worker_result"]["files"], ["README.md"])
        self.assertEqual(payload["artifacts"]["worker_result"]["next_step"], "none")

    def test_normalize_records_session_identity_fields(self) -> None:
        payload = normalize_task_record(
            {
                "id": "session-1",
                "status": "running",
                "summary": "investigate webhook failure",
                "route": "spawn_single",
                "runtime": "subagent",
                "worker_pool": "octoclaw-code",
                "session_key": "wechat:dm:abc",
                "session_id": "sess-123",
                "agent_id": "octo-worker-1",
            }
        )
        self.assertEqual(payload["session_key"], "wechat:dm:abc")
        self.assertEqual(payload["session_origin"], "wechat")
        self.assertEqual(payload["session_target"], "user:abc")
        self.assertEqual(payload["session_thread_key"], "wechat:user:abc:root")
        self.assertEqual(payload["session_id"], "sess-123")
        self.assertEqual(payload["agent_id"], "octo-worker-1")
        self.assertEqual(payload["agent_namespace"], "octoclaw")
        self.assertTrue(payload["managed_by_octoclaw"])

    @patch("lib.runtime_task_record.task_event_snapshot")
    def test_normalize_attaches_task_event_summary_and_preview(self, mock_snapshot) -> None:
        mock_snapshot.return_value = {
            "task_event_count": 2,
            "kind_counts": {"checkpoint": 1, "handoff_ready": 1},
            "degraded_event_count": 0,
            "latest_kind": "handoff_ready",
            "latest_time": "2026-03-29T09:12:38+00:00",
            "preview": [
                {"time": "2026-03-29T09:10:00+00:00", "kind": "checkpoint", "message": "checkpoint", "importance": "normal"},
                {"time": "2026-03-29T09:12:38+00:00", "kind": "handoff_ready", "message": "ready", "importance": "high"},
            ],
        }
        payload = normalize_task_record(
            {
                "id": "evented-1",
                "status": "blocked",
                "summary": "safe summary ready",
                "route": "spawn_single",
                "runtime": "subagent",
                "worker_pool": "octoclaw-research",
            }
        )

        self.assertEqual(payload["task_event_summary"]["task_event_count"], 2)
        self.assertEqual(payload["task_event_summary"]["latest_kind"], "handoff_ready")
        self.assertEqual(len(payload["task_events_preview"]), 2)
        self.assertEqual(payload["task_events_preview"][0]["kind"], "checkpoint")

    def test_normalize_final_blocked_result_tracks_handoff_readiness(self) -> None:
        payload = normalize_task_record(
            {
                "id": "blocked-1",
                "status": "blocked",
                "summary": "source access blocked",
                "route": "spawn_single",
                "runtime": "subagent",
                "worker_pool": "octoclaw-research",
                "completed_at": "2026-03-29T09:12:38+00:00",
                "report_path": "/tmp/blocked-report.md",
                "artifacts": {
                    "worker_result": {
                        "status": "blocked",
                        "summary": "Could not access the article body, but a safe boundary summary is ready.",
                        "report": "/tmp/blocked-report.md",
                        "next_step": "ask for an accessible source mirror",
                    }
                },
            }
        )

        self.assertEqual(payload["lifecycle_state"], "finished")
        self.assertEqual(payload["outcome_state"], "blocked")
        self.assertEqual(payload["handoff_state"], "user_safe_ready")
        self.assertEqual(payload["deliverable_kind"], "blocked_explanation")
        self.assertIn("safe boundary summary", payload["user_safe_summary"])
        self.assertEqual(payload["result_ready_at"], "2026-03-29T09:12:38+00:00")
        self.assertEqual(payload["handoff_ready_at"], "2026-03-29T09:12:38+00:00")

    def test_task_state_update_writes_unified_runtime_fields(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-task-record-") as workspace:
            env = {**os.environ, "WORKSPACE": workspace}
            subprocess.run(
                [
                    "python3",
                    str(TASK_STATE_UPDATE),
                    "upsert",
                    "--id",
                    "spawn-2",
                    "--status",
                    "dispatched",
                    "--summary",
                    "research gateways",
                    "--task-description",
                    "research three gateways and summarize",
                    "--route",
                    "spawn_single",
                    "--runtime",
                    "subagent",
                    "--executor",
                    "subagent",
                    "--worker-pool",
                    "octoclaw-research",
                    "--work-type",
                    "research",
                    "--phase",
                    "collect",
                    "--protocol",
                    "normal",
                    "--profile",
                    "research",
                    "--review-required",
                    "true",
                    "--report-path",
                    "/tmp/gateway-report.md",
                ],
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )

            state_path = Path(workspace) / "tmp" / "octopus" / "task-state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            task = state["tasks"][0]

        self.assertEqual(task["schema_version"], TASK_RECORD_SCHEMA_VERSION)
        self.assertEqual(task["worker_pool"], "octoclaw-research")
        self.assertEqual(task["work_type"], "research")
        self.assertEqual(task["phase"], "collect")
        self.assertEqual(task["profile"], "research")
        self.assertTrue(task["review_required"])
        self.assertNotIn("label", task)
        self.assertEqual(task["artifacts"]["report_path"], "/tmp/gateway-report.md")

    def test_task_state_update_infers_executor_from_worker_pool_first(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-task-record-runner-") as workspace:
            env = {**os.environ, "WORKSPACE": workspace}
            subprocess.run(
                [
                    "python3",
                    str(TASK_STATE_UPDATE),
                    "upsert",
                    "--id",
                    "runner-pool-only",
                    "--status",
                    "queued",
                    "--summary",
                    "check queue depth",
                    "--route",
                    "runner",
                    "--runtime",
                    "runner",
                    "--worker-pool",
                    "octoclaw-runner",
                ],
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )

            state_path = Path(workspace) / "tmp" / "octopus" / "task-state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            task = state["tasks"][0]

        self.assertEqual(task["executor"], "runner")
        self.assertEqual(task["executor_type"], "runner")
        self.assertEqual(task["worker_pool"], "octoclaw-runner")
        self.assertEqual(task["work_type"], "ops")
        self.assertEqual(task["phase"], "inspect")

    def test_schema_required_fields_match_normalized_output(self) -> None:
        schema = json.loads(TASK_RECORD_SCHEMA.read_text(encoding="utf-8"))
        payload = normalize_task_record(
            {
                "id": "task-1",
                "status": "queued",
                "summary": "demo",
            }
        )
        for field in schema["required"]:
            with self.subTest(field=field):
                self.assertIn(field, payload)


if __name__ == "__main__":
    unittest.main()
