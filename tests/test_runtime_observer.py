#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from lib import runtime_observer


class RuntimeObserverTests(unittest.TestCase):
    @patch("lib.runtime_observer.recover_dead_agent_tasks")
    @patch("lib.runtime_observer.patrol_heartbeat_check")
    @patch("lib.runtime_observer.hydrate_completed_session_results")
    @patch("lib.runtime_observer.hydrate_session_progress_markers")
    @patch("lib.runtime_observer.refresh_openclaw_taskflow_bindings")
    @patch("lib.runtime_observer.annotate_tasks_with_session_state")
    @patch("lib.runtime_observer.load_tasks")
    @patch("lib.runtime_observer.check_runner_health")
    def test_observe_runtime_once_runs_observation_pipeline(
        self,
        mock_runner_health,
        mock_load_tasks,
        mock_annotate,
        mock_refresh,
        mock_progress,
        mock_results,
        mock_heartbeat,
        mock_recover,
    ) -> None:
        task = {"id": "task-1", "status": "running"}
        mock_runner_health.return_value = {"present": True, "healthy": True, "reason": "ok"}
        mock_load_tasks.side_effect = [[task], [task], [task], [task], [task]]
        mock_annotate.side_effect = lambda tasks: tasks
        mock_refresh.return_value = False
        mock_progress.return_value = 1
        mock_results.return_value = 1
        mock_heartbeat.return_value = [{"id": "task-heartbeat"}]
        mock_recover.return_value = [{"id": "task-recovered"}]

        payload = runtime_observer.observe_runtime_once(workspace="/tmp/octoclaw")

        self.assertEqual(payload["changes"]["progress_hydrated"], 1)
        self.assertEqual(payload["changes"]["results_hydrated"], 1)
        self.assertEqual(payload["changes"]["heartbeat_reassigned"], 1)
        self.assertEqual(payload["changes"]["dead_agent_recovered"], 1)
        self.assertEqual(payload["counts"]["active"], 1)
        self.assertEqual(payload["recovered_task_ids"], ["task-recovered"])
        self.assertEqual(payload["runner_execution_mode"], "daemon")

    def test_render_observer_text_includes_runner_and_change_summary(self) -> None:
        text = runtime_observer.render_observer_text(
            {
                "observed_at": "2026-04-03T10:00:00+08:00",
                "runner_health": {"present": True, "healthy": False, "reason": "stale", "age_seconds": 91},
                "counts": {"active": 3, "queued": 1, "running": 2, "pending": 0, "final": 4},
                "changes": {"progress_hydrated": 2, "results_hydrated": 1, "heartbeat_reassigned": 0, "dead_agent_recovered": 1},
            }
        )

        self.assertIn("Runner: stale age=91s", text)
        self.assertIn("mode=daemon", text)
        self.assertIn("Counts: active 3", text)
        self.assertIn("Changes: progress 2", text)

    def test_render_observer_text_marks_missing_runner_as_on_demand(self) -> None:
        text = runtime_observer.render_observer_text(
            {
                "observed_at": "2026-04-03T10:00:00+08:00",
                "runner_health": {"present": False, "healthy": False, "reason": "missing"},
                "runner_execution_mode": "on_demand",
                "counts": {"active": 0, "queued": 0, "running": 0, "pending": 0, "final": 0},
                "changes": {"progress_hydrated": 0, "results_hydrated": 0, "heartbeat_reassigned": 0, "dead_agent_recovered": 0},
            }
        )

        self.assertIn("Runner: on-demand mode=on_demand", text)


if __name__ == "__main__":
    unittest.main()
