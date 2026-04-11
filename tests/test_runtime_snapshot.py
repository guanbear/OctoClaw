#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from lib import runtime_snapshot


class RuntimeSnapshotTests(unittest.TestCase):
    @patch("lib.runtime_snapshot.probe_tmux_session", return_value={"required": True, "available": True, "healthy": True, "reason": "ok", "windows": ["runner"]})
    @patch("lib.runtime_snapshot.load_octopus_config", return_value={"workbench": {"supervisor_mode": "tmux", "tmux_session_name": "octoclaw-runtime"}})
    def test_build_runtime_snapshot_separates_runner_lane_from_mode(self, _mock_cfg, _mock_tmux) -> None:
        payload = runtime_snapshot.build_runtime_snapshot(
            workspace="/tmp/octoclaw",
            tasks=[
                {"id": "runner-1", "status": "running", "route": "runner", "executor": "runner"},
                {"id": "spawn-1", "status": "queued", "route": "spawn_single"},
            ],
            runner_health={"present": True, "healthy": False, "age_seconds": 140, "worker_id": "runner-a", "reason": "stale"},
            runner_execution_mode="daemon",
            queue_counts={"queued": 1, "running": 1, "done": 0, "failed": 0, "total": 2},
        )

        self.assertEqual(payload["runner"]["mode"], "daemon")
        self.assertEqual(payload["runner"]["state"], "stale")
        self.assertTrue(payload["runner"]["recovery_suggested"])
        self.assertEqual(payload["counts"]["active"], 2)
        self.assertEqual(payload["queue_counts"]["running"], 1)
        self.assertEqual(payload["workbench"]["role"], "optional_workbench")
        self.assertTrue(payload["workbench"]["optional_backend"])
        self.assertEqual(payload["workbench"]["supervisor_mode"], "tmux")
        self.assertTrue(payload["workbench"]["tmux_healthy"])

    @patch("lib.runtime_snapshot.probe_tmux_session", return_value={"required": True, "available": True, "healthy": False, "reason": "tmux_session_missing", "windows": []})
    @patch("lib.runtime_snapshot.load_octopus_config", return_value={"workbench": {"supervisor_mode": "tmux", "tmux_session_name": "octoclaw-runtime"}})
    def test_build_runtime_snapshot_reports_missing_tmux_workbench(self, _mock_cfg, _mock_tmux) -> None:
        payload = runtime_snapshot.build_runtime_snapshot(
            workspace="/tmp/octoclaw",
            runner_health={"present": False, "healthy": False, "reason": "missing"},
            runner_execution_mode="ondemand",
        )

        self.assertTrue(payload["workbench"]["optional_backend"])
        self.assertFalse(payload["workbench"]["tmux_healthy"])
        self.assertEqual(payload["workbench"]["tmux_reason"], "tmux_session_missing")

    @patch("lib.runtime_snapshot.load_runtime_tasks", return_value=[{"id": "runner-1", "status": "queued", "source": "octoclaw"}])
    @patch("lib.runtime_snapshot.load_runner_health", return_value={"present": False, "healthy": False, "reason": "missing"})
    @patch("lib.runtime_snapshot.load_runner_queue_counts", return_value={"queued": 1, "running": 0, "done": 0, "failed": 0, "total": 1})
    @patch("lib.runtime_snapshot.resolve_runner_mode", return_value="ondemand")
    @patch("lib.runtime_snapshot.load_octopus_config", return_value={})
    def test_observe_runtime_snapshot_reports_on_demand_without_resident_runner(
        self,
        _mock_cfg,
        _mock_mode,
        _mock_queue,
        _mock_health,
        _mock_tasks,
    ) -> None:
        payload = runtime_snapshot.observe_runtime_snapshot(workspace="/tmp/octoclaw")

        self.assertEqual(payload["runner_execution_mode"], "ondemand")
        self.assertEqual(payload["runner"]["state"], "on-demand")
        self.assertFalse(payload["runner"]["present"])
        self.assertEqual(payload["counts"]["queued"], 1)
        self.assertFalse(payload["workbench"]["optional_backend"])

    @patch("lib.runtime_snapshot.load_octopus_config", return_value={"runtime_policy": {"runner_pool": {"worker_unhealthy_after_failures": 2}}})
    @patch("lib.runtime_snapshot.load_json")
    def test_load_runner_health_marks_failure_streak_unhealthy(self, mock_load_json, _mock_cfg) -> None:
        mock_load_json.return_value = {
            "worker_id": "runner-a",
            "last_heartbeat_at": "2026-04-10T00:00:00+00:00",
            "failure_streak": 2,
            "last_job_status": "failed",
        }
        with patch("lib.runtime_snapshot.datetime") as mock_datetime:
            from datetime import datetime, timezone

            mock_datetime.now.return_value = datetime(2026, 4, 10, 0, 0, 30, tzinfo=timezone.utc)
            mock_datetime.fromisoformat = datetime.fromisoformat
            payload = runtime_snapshot.load_runner_health(stale_after_seconds=120)

        self.assertTrue(payload["present"])
        self.assertFalse(payload["healthy"])
        self.assertEqual(payload["reason"], "failure_streak")
        self.assertEqual(payload["failure_streak"], 2)

    @patch("lib.runtime_snapshot.load_octopus_config", return_value={})
    def test_build_runtime_snapshot_normalizes_on_demand_aliases(self, _mock_cfg) -> None:
        payload = runtime_snapshot.build_runtime_snapshot(
            runner_health={"present": False, "healthy": False, "reason": "missing"},
            runner_execution_mode="on_demand",
        )

        self.assertEqual(payload["runner_execution_mode"], "ondemand")
        self.assertEqual(payload["runner"]["mode"], "ondemand")
        self.assertEqual(payload["runner"]["state"], "on-demand")
        self.assertFalse(payload["runner"]["recovery_suggested"])

    @patch("lib.runtime_snapshot.load_octopus_config", return_value={})
    def test_build_runtime_snapshot_does_not_suggest_recovery_for_ondemand_mode(self, _mock_cfg) -> None:
        payload = runtime_snapshot.build_runtime_snapshot(
            workspace="/tmp/octoclaw",
            tasks=[],
            runner_health={"present": False, "healthy": False, "reason": "missing"},
            runner_execution_mode="ondemand",
            queue_counts={},
        )

        self.assertEqual(payload["runner"]["mode"], "ondemand")
        self.assertFalse(payload["runner"]["recovery_suggested"])

    @patch("lib.runtime_snapshot.load_octopus_config", return_value={})
    def test_build_runtime_snapshot_marks_missing_runner_in_daemon_mode_for_recovery(self, _mock_cfg) -> None:
        payload = runtime_snapshot.build_runtime_snapshot(
            workspace="/tmp/octoclaw",
            tasks=[],
            runner_health={"present": False, "healthy": False, "reason": "missing"},
            runner_execution_mode="daemon",
            queue_counts={},
        )

        self.assertEqual(payload["runner"]["state"], "missing")
        self.assertTrue(payload["runner"]["recovery_suggested"])

    @patch("lib.runtime_snapshot.load_octopus_config", return_value={})
    def test_build_runtime_snapshot_uses_event_facts_to_mark_running(self, _mock_cfg) -> None:
        payload = runtime_snapshot.build_runtime_snapshot(
            workspace="/tmp/octoclaw",
            tasks=[{"id": "research-1", "status": "queued", "route": "spawn_single", "source": "octoclaw"}],
            runner_health={"present": False, "healthy": False, "reason": "missing"},
            runner_execution_mode="ondemand",
            queue_counts={},
            task_events=[
                {"task_id": "research-1", "kind": "task_started", "time": "2026-04-08T21:18:30+08:00"},
                {"task_id": "research-1", "kind": "task_running", "time": "2026-04-08T21:18:31+08:00"},
            ],
        )

        task = payload["tasks"][0]
        self.assertEqual(task["projection_status"], "queued")
        self.assertEqual(task["read_model_status"], "running")
        self.assertEqual(task["status"], "running")
        self.assertEqual(task["status_source"], "event_read_model")
        self.assertEqual(task["latest_event_kind"], "task_running")
        self.assertEqual(payload["counts"]["running"], 1)
        self.assertEqual(payload["counts"]["queued"], 0)

    @patch("lib.runtime_snapshot.load_octopus_config", return_value={})
    def test_build_runtime_snapshot_uses_event_facts_to_mark_done(self, _mock_cfg) -> None:
        payload = runtime_snapshot.build_runtime_snapshot(
            workspace="/tmp/octoclaw",
            tasks=[{"id": "research-2", "status": "running", "route": "spawn_single", "source": "octoclaw"}],
            runner_health={"present": False, "healthy": False, "reason": "missing"},
            runner_execution_mode="ondemand",
            queue_counts={},
            task_events=[
                {"task_id": "research-2", "kind": "task_completed", "time": "2026-04-08T21:21:00+08:00"},
                {"task_id": "research-2", "kind": "result_ready", "time": "2026-04-08T21:21:01+08:00"},
                {"task_id": "research-2", "kind": "handoff_ready", "time": "2026-04-08T21:21:02+08:00"},
            ],
        )

        task = payload["tasks"][0]
        self.assertEqual(task["projection_status"], "running")
        self.assertEqual(task["read_model_status"], "done")
        self.assertEqual(task["status"], "done")
        self.assertEqual(task["result_ready_at"], "2026-04-08T21:21:01+08:00")
        self.assertEqual(task["handoff_ready_at"], "2026-04-08T21:21:02+08:00")
        self.assertEqual(payload["counts"]["done"], 1)
        self.assertEqual(payload["counts"]["running"], 0)


if __name__ == "__main__":
    unittest.main()
