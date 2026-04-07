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
    @patch("lib.runtime_snapshot.load_octopus_config", return_value={"workbench": {"supervisor_mode": "tmux", "tmux_session_name": "octoclaw-runtime"}})
    def test_build_runtime_snapshot_separates_runner_lane_from_mode(self, _mock_cfg) -> None:
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


if __name__ == "__main__":
    unittest.main()
