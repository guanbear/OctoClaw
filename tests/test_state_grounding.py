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

from lib import state_grounding


class StateGroundingTests(unittest.TestCase):
    @patch("lib.state_grounding.observe_runtime_read_model")
    def test_build_state_grounding_prefers_running_recent_task(self, mock_read_model) -> None:
        mock_read_model.return_value = {
            "tasks": [
                {
                    "id": "research-old",
                    "status": "done",
                    "projection_status": "done",
                    "read_model_status": "done",
                    "route": "spawn_single",
                    "worker_pool": "octoclaw-research",
                    "latest_event_at": "2026-04-08T10:00:00+08:00",
                },
                {
                    "id": "research-new",
                    "status": "running",
                    "projection_status": "queued",
                    "read_model_status": "running",
                    "route": "spawn_single",
                    "worker_pool": "octoclaw-research",
                    "latest_event_kind": "task_running",
                    "latest_event_at": "2026-04-08T10:05:00+08:00",
                    "summary": "checking local time",
                },
            ]
        }

        payload = state_grounding.build_state_grounding(
            "刚才那个任务还在 queued 吗",
            protected_lane="control_observer",
            scope="task_status_or_provenance",
        )

        self.assertTrue(payload["required"])
        self.assertTrue(payload["found"])
        self.assertEqual(payload["packet"]["task_id"], "research-new")
        self.assertEqual(payload["packet"]["display_status"], "running")
        self.assertEqual(payload["packet"]["projection_status"], "queued")
        self.assertEqual(payload["packet"]["read_model_status"], "running")
        self.assertIn("Do not guess", payload["prompt_context"])

    @patch("lib.state_grounding.assess_main_model_drift")
    def test_build_state_grounding_supports_session_model_queries(self, mock_drift) -> None:
        mock_drift.return_value = {
            "actual_model": "zhipu/GLM-5.1",
            "expected_model": "omniroute/cx/gpt-5.4",
            "reason": "drift_detected",
            "current_override": "",
            "drift": True,
        }

        payload = state_grounding.build_state_grounding(
            "你现在是啥模型",
            protected_lane="control_observer",
            scope="task_status_or_provenance",
        )

        self.assertTrue(payload["required"])
        self.assertTrue(payload["found"])
        self.assertEqual(payload["packet_type"], "session_model")
        self.assertEqual(payload["packet"]["current_model"], "zhipu/GLM-5.1")

    @patch("lib.state_grounding.observe_runtime_read_model")
    def test_build_state_grounding_prefers_current_turn_task_id(self, mock_read_model) -> None:
        mock_read_model.return_value = {
            "tasks": [
                {
                    "id": "research-old",
                    "status": "running",
                    "projection_status": "running",
                    "read_model_status": "running",
                    "route": "spawn_single",
                    "worker_pool": "octoclaw-research",
                    "latest_event_at": "2026-04-08T10:05:00+08:00",
                },
                {
                    "id": "research-current",
                    "status": "done",
                    "projection_status": "done",
                    "read_model_status": "done",
                    "route": "spawn_single",
                    "worker_pool": "octoclaw-research",
                    "latest_event_at": "2026-04-08T10:00:00+08:00",
                },
            ]
        }

        payload = state_grounding.build_state_grounding(
            "刚才那个任务还在 queued 吗",
            protected_lane="control_observer",
            scope="task_status_or_provenance",
            preferred_task_id="research-current",
        )

        self.assertTrue(payload["required"])
        self.assertTrue(payload["found"])
        self.assertEqual(payload["packet"]["task_id"], "research-current")


if __name__ == "__main__":
    unittest.main()
