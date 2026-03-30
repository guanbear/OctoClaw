#!/usr/bin/env python3
import tempfile
import unittest
from pathlib import Path

from lib.runtime_coordination import ownership_snapshot, recover_stale_ownership, resolve_worker_session, upsert_worker_session


class RuntimeCoordinationTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
