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

from lib import runtime_observer


class RuntimeObserverTests(unittest.TestCase):
    @patch("lib.runtime_observer.observe_runtime_state_once")
    def test_observe_runtime_once_runs_observation_pipeline(
        self,
        mock_observe,
    ) -> None:
        mock_observe.return_value = {
            "runner_health": {"present": True, "healthy": True, "reason": "ok"},
            "runner_execution_mode": "daemon",
            "tasks": [{"id": "task-1", "status": "running"}],
            "progress_hydrated": 1,
            "results_hydrated": 1,
            "heartbeat_reassigned": [{"id": "task-heartbeat"}],
            "recovered": [{"id": "task-recovered"}],
        }

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
