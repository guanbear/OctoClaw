#!/usr/bin/env python3
import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

patrol = importlib.import_module("patrol")


class PatrolNotificationTests(unittest.TestCase):
    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchor_skips_tasks_without_session_key(self, mock_send) -> None:
        sent = patrol.send_state_change_task_anchor(
            {
                "id": "task-1",
                "status": "running",
                "summary": "fix login issue",
            }
        )

        self.assertFalse(sent)
        mock_send.assert_not_called()

    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchor_sends_for_session_bound_task(self, mock_send) -> None:
        mock_send.return_value = {"ok": True, "backend": "slack", "messageId": "m-1"}

        sent = patrol.send_state_change_task_anchor(
            {
                "id": "task-1",
                "session_key": "agent:main:slack:channel:C123:thread:1712345.000100",
                "worker_pool": "octoclaw-code",
                "status": "running",
                "summary": "fix login issue",
                "route": "spawn_single",
            }
        )

        self.assertTrue(sent)
        mock_send.assert_called_once()

    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchors_dedupes_task_ids(self, mock_send) -> None:
        mock_send.return_value = {"ok": True}

        sent = patrol.send_state_change_task_anchors(
            [
                {"id": "task-1", "session_key": "slack:channel:C123", "status": "running"},
                {"id": "task-1", "session_key": "slack:channel:C123", "status": "running"},
                {"id": "task-2", "session_key": "slack:channel:C123:thread:1", "status": "done"},
            ]
        )

        self.assertEqual(sent, 2)
        self.assertEqual(mock_send.call_count, 2)


if __name__ == "__main__":
    unittest.main()
