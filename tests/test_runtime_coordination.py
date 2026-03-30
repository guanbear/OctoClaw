#!/usr/bin/env python3
import tempfile
import unittest
from pathlib import Path

from lib.runtime_coordination import (
    artifact_entries_for_task,
    ownership_snapshot,
    recover_stale_ownership,
    resolve_task_checklist,
    resolve_task_artifacts,
    resolve_worker_session,
    upsert_artifact_index,
    upsert_checklist,
    upsert_worker_session,
)


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


if __name__ == "__main__":
    unittest.main()
