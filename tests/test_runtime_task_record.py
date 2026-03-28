#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from lib.runtime_task_record import TASK_RECORD_SCHEMA_VERSION, normalize_task_record


REPO_ROOT = Path(__file__).resolve().parents[1]
TASK_STATE_UPDATE = REPO_ROOT / "lib" / "task-state-update.py"
TASK_RECORD_SCHEMA = REPO_ROOT / "schemas" / "runtime-task-record-v1.schema.json"


class RuntimeTaskRecordTests(unittest.TestCase):
    def test_normalize_runner_task_defaults(self) -> None:
        payload = normalize_task_record(
            {
                "id": "runner-1",
                "label": "octopus-runner",
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

    def test_normalize_preserves_custom_artifacts_and_code_metadata(self) -> None:
        payload = normalize_task_record(
            {
                "id": "spawn-1",
                "label": "octopus-fix",
                "status": "dispatched",
                "route": "spawn_single",
                "runtime": "subagent",
                "summary": "fix auth bug",
                "report_path": "/tmp/report.md",
                "context_path": "/tmp/context.md",
                "files_changed": ["lib/auth.py"],
                "artifacts": {"custom": "keep-me"},
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
                    "--label",
                    "octopus-scout",
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
