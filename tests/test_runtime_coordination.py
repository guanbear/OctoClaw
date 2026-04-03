#!/usr/bin/env python3
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import lib.runtime_coordination as runtime_coordination
from lib.checklist_history import load_checklist_history

from lib.runtime_coordination import (
    artifact_entries_for_task,
    build_recovery_event,
    mark_task_for_reassignment,
    ownership_snapshot,
    recover_stale_ownership,
    resolve_task_checklist,
    resolve_task_artifacts,
    resolve_worker_session,
    sync_runtime_surfaces,
    upsert_artifact_index,
    upsert_checklist,
    upsert_worker_session,
)


def _configure_runtime_workspace(module, workspace: str) -> None:
    module.WORKSPACE = workspace
    module.ARTIFACT_INDEX_FILE = str(Path(workspace) / "tmp" / "octopus" / "artifact-index.json")
    module.OWNERSHIP_STORE_FILE = str(Path(workspace) / "tmp" / "octopus" / "task-ownership.json")
    module.WORKER_SESSION_STORE_FILE = str(Path(workspace) / "tmp" / "octopus" / "worker-session-store.json")
    module.TASK_CHECKLIST_STORE_FILE = str(Path(workspace) / "tmp" / "octopus" / "task-checklists.json")
    module.upsert_artifact_index.__kwdefaults__["path"] = module.ARTIFACT_INDEX_FILE
    module.upsert_ownership.__kwdefaults__["path"] = module.OWNERSHIP_STORE_FILE
    module.upsert_worker_session.__kwdefaults__["path"] = module.WORKER_SESSION_STORE_FILE
    module.resolve_task_checklist.__kwdefaults__["path"] = module.TASK_CHECKLIST_STORE_FILE
    module.upsert_checklist.__kwdefaults__["path"] = module.TASK_CHECKLIST_STORE_FILE


class RuntimeCoordinationTests(unittest.TestCase):
    def test_resolve_task_artifacts_includes_thread_related_entries(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-artifact-index-") as tmpdir:
            index_path = Path(tmpdir) / "artifact-index.json"
            task_a = {
                "id": "task-a",
                "worker_pool": "octoclaw-research",
                "status": "done",
                "summary": "drafted report",
                "report_path": "/tmp/task-a-report.md",
                "session_thread_key": "slack:channel:C123:1712345.000100",
                "updated_at": "2026-03-30T10:00:00+00:00",
            }
            task_b = {
                "id": "task-b",
                "worker_pool": "octoclaw-review",
                "status": "done",
                "summary": "review notes ready",
                "artifacts": {"report_path": "/tmp/task-b-review.md"},
                "session_thread_key": "slack:channel:C123:1712345.000100",
                "updated_at": "2026-03-30T10:05:00+00:00",
            }

            upsert_artifact_index(task_a, path=str(index_path))
            upsert_artifact_index(task_b, path=str(index_path))

            artifacts = resolve_task_artifacts(task_a, path=str(index_path))

            self.assertEqual([item["task_id"] for item in artifacts], ["task-a", "task-b"])
            self.assertEqual(artifacts[0]["source"], "task_index")
            self.assertFalse(artifacts[0]["related_to_thread"])
            self.assertEqual(artifacts[1]["source"], "thread_index")
            self.assertTrue(artifacts[1]["related_to_thread"])

    def test_ownership_snapshot_marks_recovered_tasks(self) -> None:
        snapshot = ownership_snapshot(
            {
                "id": "task-1",
                "status": "queued",
                "agent_id": "octo-worker-1",
                "session_id": "sess-1",
                "run_id": "run-1",
                "session_status": "lost",
                "recovery_action": "dead_agent_recovered",
            }
        )

        self.assertEqual(snapshot["state"], "recovered")
        self.assertEqual(snapshot["owner_id"], "octo-worker-1")

    def test_recover_stale_ownership_requeues_missing_session_tasks(self) -> None:
        recovered = recover_stale_ownership(
            [
                {
                    "id": "task-1",
                    "status": "running",
                    "route": "spawn_single",
                    "runtime": "subagent",
                    "agent_id": "octo-worker-1",
                    "session_id": "sess-1",
                    "run_id": "run-1",
                    "session_status": "missing",
                    "summary": "research provider docs",
                }
            ],
            stale_after_seconds=900,
        )

        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]["status"], "queued")
        self.assertEqual(recovered[0]["recovery_action"], "dead_agent_recovered")
        self.assertEqual(recovered[0]["session_status"], "missing")
        self.assertEqual(recovered[0]["ownership"]["state"], "recovered")
        self.assertTrue(recovered[0]["last_recovered_at"])

    def test_resolve_worker_session_returns_latest_snapshot_for_task(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-worker-session-") as tmpdir:
            store_path = Path(tmpdir) / "worker-session-store.json"
            upsert_worker_session(
                {
                    "id": "task-1",
                    "agent_id": "octo-worker-1",
                    "agent_namespace": "octoclaw",
                    "session_id": "sess-1",
                    "run_id": "run-1",
                    "session_status": "active",
                    "last_observed_at": "2026-03-30T10:00:00+00:00",
                },
                path=str(store_path),
            )

            resolved = resolve_worker_session("task-1", path=str(store_path))

            self.assertEqual(resolved["agent_id"], "octo-worker-1")
            self.assertEqual(resolved["session_id"], "sess-1")
            self.assertEqual(resolved["resume_state"], "active")

    def test_artifact_entries_for_task_collects_worker_result(self) -> None:
        entries = artifact_entries_for_task(
            {
                "id": "task-1",
                "worker_pool": "octoclaw-code",
                "status": "done",
                "summary": "patched login",
                "artifacts": {
                    "worker_result": {
                        "task_id": "task-1",
                        "status": "done",
                        "summary": "login patch landed",
                        "report": "/tmp/task-1-result.md",
                    }
                },
            }
        )

        self.assertTrue(any(entry["kind"] == "worker_result" for entry in entries))

    def test_resolve_task_checklist_preserves_persisted_progress(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-task-checklist-") as tmpdir:
            checklist_path = Path(tmpdir) / "task-checklists.json"
            upsert_checklist(
                {
                    "id": "task-1",
                    "updated_at": "2026-03-30T10:00:00+00:00",
                    "checklist": {
                        "kind": "explicit",
                        "items": [
                            {"id": "read", "title": "Read sources", "state": "done"},
                            {"id": "write", "title": "Write summary", "state": "in_progress"},
                        ],
                    },
                },
                path=str(checklist_path),
            )

            resolved = resolve_task_checklist(
                {
                    "id": "task-1",
                    "updated_at": "2026-03-30T10:05:00+00:00",
                    "checklist": {
                        "kind": "explicit",
                        "items": [
                            {"id": "read", "title": "Read sources"},
                            {"id": "write", "title": "Write summary"},
                        ],
                    },
                },
                path=str(checklist_path),
            )

            self.assertEqual(resolved["completed_count"], 1)
            self.assertEqual(resolved["open_count"], 1)
            self.assertEqual(resolved["items"][0]["state"], "done")
            self.assertEqual(resolved["items"][1]["state"], "in_progress")

    def test_build_recovery_event_is_deterministic(self) -> None:
        first = build_recovery_event("task-1", "agent-1", "heartbeat_stale")
        second = build_recovery_event("task-1", "agent-1", "heartbeat_stale")

        self.assertEqual(first, second)
        self.assertEqual(first["event_type"], "reassignment")
        self.assertEqual(first["old_owner_id"], "agent-1")

    def test_mark_task_for_reassignment_is_idempotent(self) -> None:
        task = {
            "id": "task-1",
            "status": "running",
            "lifecycle_state": "running",
            "outcome_state": "failed",
            "handoff_state": "user_safe_ready",
            "owner": "agent-1",
            "agent_id": "agent-1",
            "session_id": "sess-1",
            "run_id": "run-1",
            "recovery_reason": "heartbeat_stale",
        }

        first = mark_task_for_reassignment(task)
        first_history = list(first["recovery_history"])
        first_recovered_at = first["last_recovered_at"]
        second = mark_task_for_reassignment(task)

        self.assertEqual(second["status"], "queued")
        self.assertEqual(second["lifecycle_state"], "queued")
        self.assertEqual(second["outcome_state"], "pending")
        self.assertEqual(second["owner"], "")
        self.assertEqual(second["session_id"], "")
        self.assertEqual(second["run_id"], "")
        self.assertEqual(second["recovery_action"], "queued_for_reassignment")
        self.assertEqual(second["recovery_history"], first_history)
        self.assertEqual(second["last_recovered_at"], first_recovered_at)

    def test_sync_runtime_surfaces_only_writes_checklist_history_on_changes(self) -> None:
        original_workspace = os.environ.get("WORKSPACE")
        with tempfile.TemporaryDirectory(prefix="octoclaw-runtime-surfaces-") as tmpdir:
            with patch.dict(os.environ, {"WORKSPACE": tmpdir}, clear=False):
                reloaded = importlib.reload(runtime_coordination)
                _configure_runtime_workspace(reloaded, tmpdir)
                task = {
                    "id": "task-1",
                    "status": "queued",
                    "route": "spawn_single",
                    "runtime": "subagent",
                    "worker_pool": "octoclaw-code",
                    "updated_at": "2026-04-02T00:00:00+00:00",
                    "checklist": {
                        "kind": "explicit",
                        "items": [
                            {"id": "read", "title": "Read sources", "state": "pending"},
                            {"id": "write", "title": "Write summary", "state": "pending"},
                        ],
                    },
                }

                reloaded.sync_runtime_surfaces(dict(task))
                first_history = load_checklist_history("task-1", tmpdir)

                reloaded.sync_runtime_surfaces(dict(task))
                second_history = load_checklist_history("task-1", tmpdir)

                updated = dict(task)
                updated["updated_at"] = "2026-04-02T00:10:00+00:00"
                updated["checklist"] = {
                    "kind": "explicit",
                    "items": [
                        {"id": "read", "title": "Read sources", "state": "done"},
                        {"id": "write", "title": "Write summary", "state": "pending"},
                    ],
                }
                reloaded.sync_runtime_surfaces(updated)
                third_history = load_checklist_history("task-1", tmpdir)

        if original_workspace is None:
            os.environ.pop("WORKSPACE", None)
        else:
            os.environ["WORKSPACE"] = original_workspace
        importlib.reload(runtime_coordination)

        self.assertEqual([event["event_type"] for event in first_history], ["item_added", "item_added", "snapshot"])
        self.assertEqual(len(second_history), len(first_history))
        self.assertTrue(any(event["event_type"] == "item_done" and event["item_id"] == "read" for event in third_history))


if __name__ == "__main__":
    unittest.main()
