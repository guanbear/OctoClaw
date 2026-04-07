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
    @patch("lib.runtime_observer.observe_runtime_read_model")
    def test_observe_runtime_once_runs_observation_pipeline(
        self,
        mock_observe,
    ) -> None:
        mock_observe.return_value = {
            "observed_at": "2026-04-04T11:00:00+08:00",
            "workspace": "/tmp/octoclaw",
            "runner_health": {"present": True, "healthy": True, "reason": "ok"},
            "runner": {"state": "healthy", "mode": "daemon", "present": True, "healthy": True},
            "runner_execution_mode": "daemon",
            "tasks": [
                {
                    "id": "task-1",
                    "status": "running",
                    "route": "spawn_single",
                    "summary": "investigate release",
                    "openclaw_taskflow": {
                        "task_id": "native-task-1",
                        "flow_id": "flow-1",
                        "backend": "mirror",
                        "binding_state": "mirrored_bound",
                        "task_runtime": "openclaw_task",
                        "flow_runtime": "openclaw_flow",
                        "native_binding_state": "bound",
                        "create_preference": "native_preferred",
                        "create_status": "native_bound",
                    },
                }
            ],
            "changes": {"progress_hydrated": 0, "results_hydrated": 0, "heartbeat_reassigned": 0, "dead_agent_recovered": 0},
            "counts": {"active": 1, "queued": 0, "running": 1, "pending": 0, "final": 0},
            "recovered_task_ids": [],
            "heartbeat_reassigned_task_ids": [],
        }

        payload = runtime_observer.observe_runtime_once(workspace="/tmp/octoclaw")

        self.assertEqual(payload["observed_at"], "2026-04-04T11:00:00+08:00")
        self.assertEqual(payload["counts"]["active"], 1)
        self.assertEqual(payload["runner_execution_mode"], "daemon")
        self.assertEqual(payload["surface_status"]["display"], "substrate_first")
        self.assertEqual(payload["active_substrate_tasks"][0]["taskflow_target"], "flow flow-1")
        mock_observe.assert_called_once_with(workspace="/tmp/octoclaw")

    def test_render_runner_status_text_uses_observer_payload(self) -> None:
        text = runtime_observer.render_runner_status_text(
            {
                "observed_at": "2026-04-07T18:00:00+08:00",
                "runner": {"state": "on-demand", "mode": "ondemand", "present": False, "healthy": False},
                "runner_execution_mode": "ondemand",
                "queue_counts": {"queued": 2, "running": 0, "done": 5, "failed": 1, "total": 8},
            }
        )

        self.assertIn("Mode: ondemand", text)
        self.assertIn("State: on-demand", text)
        self.assertIn("Queue: queued 2", text)

    def test_render_observer_text_includes_runner_and_change_summary(self) -> None:
        text = runtime_observer.render_observer_text(
            {
                "observed_at": "2026-04-03T10:00:00+08:00",
                "runner": {"state": "stale", "mode": "daemon", "present": True, "healthy": False, "age_seconds": 91},
                "counts": {"active": 3, "queued": 1, "running": 2, "pending": 0, "final": 4},
                "changes": {"progress_hydrated": 2, "results_hydrated": 1, "heartbeat_reassigned": 0, "dead_agent_recovered": 1},
            }
        )

        self.assertIn("Runner: stale age=91s", text)
        self.assertIn("mode=daemon", text)
        self.assertIn("Counts: active 3", text)
        self.assertIn("Changes: progress 2", text)
        self.assertIn("Surfaces:", text)

    def test_render_observer_text_marks_missing_runner_as_on_demand(self) -> None:
        text = runtime_observer.render_observer_text(
            {
                "observed_at": "2026-04-03T10:00:00+08:00",
                "runner": {"state": "on-demand", "mode": "on_demand", "present": False, "healthy": False},
                "runner_execution_mode": "on_demand",
                "counts": {"active": 0, "queued": 0, "running": 0, "pending": 0, "final": 0},
                "changes": {"progress_hydrated": 0, "results_hydrated": 0, "heartbeat_reassigned": 0, "dead_agent_recovered": 0},
            }
        )

        self.assertIn("Runner: on-demand mode=on_demand", text)

    def test_render_observer_text_surfaces_substrate_tasks_and_review(self) -> None:
        text = runtime_observer.render_observer_text(
            {
                "observed_at": "2026-04-07T10:00:00+08:00",
                "runner_health": {"present": True, "healthy": True},
                "runner_execution_mode": "daemon",
                "counts": {"active": 1, "queued": 1, "running": 0, "pending": 0, "final": 0},
                "changes": {"progress_hydrated": 1, "results_hydrated": 0, "heartbeat_reassigned": 0, "dead_agent_recovered": 0},
                "substrate": {"tracked": 3, "managed": 1, "native_bound": 2},
                "surface_status": {
                    "display": "substrate_first",
                    "retrieve": "substrate_first",
                    "observer": "substrate_aware",
                    "review": "substrate_aware",
                },
                "workbench": {
                    "role": "optional_workbench",
                    "optional_backend": True,
                    "tmux_session_name": "octoclaw-runtime",
                },
                "active_substrate_tasks": [
                    {
                        "task_id": "task-1",
                        "state": "running",
                        "route": "spawn_single",
                        "taskflow_target": "flow flow-1",
                        "substrate_summary": "mirror bound to native · running · flow flow-1",
                        "create_path": "preference native_preferred | status native_bound",
                        "task_summary": {"child_count": 1, "active_child_count": 1, "completed_child_count": 0},
                    }
                ],
                "review_surfaces": [
                    {
                        "task_id": "task-1",
                        "state_label": "Review required",
                        "review_task_id": "review-1",
                        "substrate_summary": "mirror bound to native · queued · task native-review-1",
                        "action_hint": "details review-1",
                    }
                ],
            }
        )

        self.assertIn("Active substrate tasks:", text)
        self.assertIn("Optional workbench: tmux octoclaw-runtime", text)
        self.assertIn("flow flow-1", text)
        self.assertIn("Review surfaces:", text)
        self.assertIn("details review-1", text)

    @patch("lib.runtime_observer.observe_runtime_read_model")
    def test_observe_runtime_once_prefers_surface_state_for_counts(
        self,
        mock_observe,
    ) -> None:
        mock_observe.return_value = {
            "observed_at": "2026-04-07T23:33:10+08:00",
            "workspace": "/tmp/octoclaw",
            "runner_health": {"present": True, "healthy": True, "reason": "ok"},
            "runner_execution_mode": "ondemand",
            "tasks": [
                {
                    "id": "task-managed",
                    "status": "running",
                    "route": "spawn_single",
                    "summary": "native flow still queued",
                    "openclaw_taskflow": {
                        "backend": "managed",
                        "sync_mode": "managed",
                        "substrate_state": "queued",
                        "flow_id": "flow-1",
                        "create_preference": "native_preferred",
                        "create_status": "native_unavailable_fallback_mirror",
                    },
                }
            ],
        }

        payload = runtime_observer.observe_runtime_once(workspace="/tmp/octoclaw")

        self.assertEqual(payload["counts"]["queued"], 1)
        self.assertEqual(payload["counts"]["running"], 0)
        self.assertEqual(payload["counts"]["active"], 1)
        self.assertEqual(payload["active_substrate_tasks"][0]["state"], "queued")


if __name__ == "__main__":
    unittest.main()
