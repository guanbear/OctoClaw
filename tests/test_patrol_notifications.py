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

        self.assertFalse(sent["ok"])
        mock_send.assert_not_called()

    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchor_sends_for_session_bound_task(self, mock_send) -> None:
        mock_send.return_value = {"ok": True, "backend": "slack", "messageId": "m-1", "action": "send"}

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

        self.assertTrue(sent["ok"])
        self.assertEqual(sent["message_id"], "m-1")
        mock_send.assert_called_once()

    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchors_dedupes_task_ids_and_persists_ids(self, mock_send) -> None:
        mock_send.side_effect = [
            {"ok": True, "backend": "slack", "messageId": "m-1", "action": "send"},
            {"ok": True, "backend": "slack", "messageId": "m-2", "action": "send"},
        ]

        sent = patrol.send_state_change_task_anchors(
            [
                {"id": "task-1", "session_key": "slack:channel:C123", "status": "running"},
                {"id": "task-1", "session_key": "slack:channel:C123", "status": "running"},
                {"id": "task-2", "session_key": "slack:channel:C123:thread:1", "status": "done"},
            ],
            anchor_messages={"existing": {"message_id": "old"}},
        )

        self.assertEqual(sent["sent"], 2)
        self.assertEqual(sent["task_anchor_messages"]["task-1"]["message_id"], "m-1")
        self.assertEqual(sent["task_anchor_messages"]["task-2"]["message_id"], "m-2")
        self.assertEqual(mock_send.call_count, 2)

    @patch("patrol.send_task_notification")
    def test_send_state_change_task_anchor_passes_existing_anchor_message_id(self, mock_send) -> None:
        mock_send.return_value = {"ok": True, "backend": "slack", "messageId": "m-1", "action": "edit"}

        sent = patrol.send_state_change_task_anchor(
            {
                "id": "task-1",
                "session_key": "agent:main:slack:channel:C123:thread:1712345.000100",
                "worker_pool": "octoclaw-code",
                "status": "running",
                "summary": "fix login issue",
                "route": "spawn_single",
            },
            anchor_state={"message_id": "1712345.000200"},
        )

        self.assertTrue(sent["ok"])
        self.assertEqual(sent["action"], "edit")
        self.assertEqual(mock_send.call_args[1]["existing_message_id"], "1712345.000200")

    def test_get_recent_done_tasks_includes_final_blocked_handoffs(self) -> None:
        now = patrol.now_utc()
        completed_at = (now - patrol.timedelta(minutes=5)).isoformat()
        tasks = [
            {
                "id": "research-blocked-1",
                "status": "blocked",
                "summary": "source boundary ready",
                "completed_at": completed_at,
                "route": "spawn_single",
                "worker_pool": "octoclaw-research",
                "artifacts": {
                    "worker_result": {
                        "status": "blocked",
                        "summary": "The source is inaccessible, but the blocked explanation is ready.",
                    }
                },
            }
        ]

        recent = patrol.get_recent_done_tasks(tasks)

        self.assertEqual([item["id"] for item in recent], ["research-blocked-1"])
        self.assertEqual(recent[0]["_finish_type"], "blocked")


if __name__ == "__main__":
    unittest.main()
