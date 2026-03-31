#!/usr/bin/env python3
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from lib.task_anchor_commands import execute_task_anchor_command, parse_task_anchor_command


class TaskAnchorCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.state_file = os.path.join(self.tmpdir.name, "task-state.json")
        with open(self.state_file, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "tasks": [
                        {
                            "id": "task-1",
                            "worker_pool": "octoclaw-code",
                            "status": "running",
                            "summary": "fix login 401 and add tests",
                            "route": "spawn_single",
                            "model": "omniroute/cx/gpt-5.4",
                            "started_at": "2026-03-31T10:00:00Z",
                            "updated_at": "2026-03-31T10:05:00Z",
                            "session_key": "agent:main:slack:channel:C123:thread:1712345.000100",
                            "artifacts": {"report_path": "/tmp/task-1.md", "context_pack_path": "/tmp/task-1-context.json"},
                            "task_events_preview": [
                                {
                                    "time": "2026-03-31T10:05:00Z",
                                    "kind": "checkpoint",
                                    "message": "checkpoint saved",
                                    "importance": "normal",
                                }
                            ],
                        },
                        {
                            "id": "task-2",
                            "worker_pool": "octoclaw-runner",
                            "status": "queued",
                            "summary": "check nginx health",
                            "route": "runner",
                            "parent_id": "task-1",
                            "started_at": "2026-03-31T10:01:00Z",
                            "updated_at": "2026-03-31T10:02:00Z",
                        },
                        {
                            "id": "task-3",
                            "worker_pool": "octoclaw-review",
                            "status": "needs_approval",
                            "summary": "awaiting operator approval",
                            "route": "spawn_single",
                            "session_key": "agent:main:slack:channel:C123:thread:1712345.000100",
                        },
                    ]
                },
                fh,
                ensure_ascii=False,
            )

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def test_parse_task_anchor_command_supports_aliases(self) -> None:
        self.assertEqual(parse_task_anchor_command("details task-1")["action"], "details")
        self.assertEqual(parse_task_anchor_command("view task-1")["action"], "details")
        self.assertEqual(parse_task_anchor_command("queue")["action"], "queue")

    def test_execute_details_returns_rendered_detail(self) -> None:
        result = execute_task_anchor_command("details task-1", state_file=self.state_file)
        self.assertTrue(result["ok"])
        self.assertIn("fix login 401", result["text"])
        self.assertIn("Artifacts:", result["text"])

    def test_execute_queue_returns_grouped_text(self) -> None:
        result = execute_task_anchor_command("queue", state_file=self.state_file)
        self.assertTrue(result["ok"])
        self.assertIn("[running]", result["text"])
        self.assertIn("[queued]", result["text"])

    def test_execute_artifacts_returns_paths(self) -> None:
        result = execute_task_anchor_command("artifacts task-1", state_file=self.state_file)
        self.assertTrue(result["ok"])
        self.assertIn("/tmp/task-1.md", result["text"])

    def test_execute_retrieve_returns_summary_and_report(self) -> None:
        result = execute_task_anchor_command("retrieve task-1", state_file=self.state_file)
        self.assertTrue(result["ok"])
        self.assertIn("Primary report: /tmp/task-1.md", result["text"])
        self.assertIn("Summary:", result["text"])

    def test_execute_graph_returns_lineage(self) -> None:
        result = execute_task_anchor_command("graph task-1", state_file=self.state_file)
        self.assertTrue(result["ok"])
        self.assertIn("task-1 -> task-2", result["text"])

    def test_execute_timeline_returns_checkpoint_and_child_started(self) -> None:
        result = execute_task_anchor_command("timeline task-1", state_file=self.state_file)
        self.assertTrue(result["ok"])
        self.assertIn("checkpoint", result["text"])
        self.assertIn("child_started", result["text"])

    def test_execute_explorer_returns_context_pack(self) -> None:
        result = execute_task_anchor_command("explorer task-1", state_file=self.state_file)
        self.assertTrue(result["ok"])
        self.assertIn("/tmp/task-1-context.json", result["text"])

    @patch("lib.task_anchor_commands._run_task_state_upsert")
    @patch("lib.task_anchor_commands.send_agent_message")
    def test_execute_stop_requests_session_stop_and_updates_state(self, mock_send, mock_upsert) -> None:
        mock_send.return_value = {"ok": True}
        mock_upsert.return_value = {"ok": True}
        result = execute_task_anchor_command("stop task-1", state_file=self.state_file)

        self.assertTrue(result["ok"])
        mock_send.assert_called_once()
        self.assertEqual(mock_send.call_args[0][1], "/stop")
        self.assertEqual(mock_upsert.call_args[1]["status"], "deferred")

    @patch("lib.task_anchor_commands._run_task_state_upsert")
    def test_execute_retry_requeues_task(self, mock_upsert) -> None:
        mock_upsert.return_value = {"ok": True}
        result = execute_task_anchor_command("retry task-1", state_file=self.state_file)

        self.assertTrue(result["ok"])
        self.assertEqual(mock_upsert.call_args[1]["status"], "queued")
        self.assertEqual(mock_upsert.call_args[1]["recovery_action"], "manual_retry_request")

    @patch("lib.task_anchor_commands._run_task_state_upsert")
    @patch("lib.task_anchor_commands.send_agent_message")
    def test_execute_approve_updates_status_and_notifies_session(self, mock_send, mock_upsert) -> None:
        mock_send.return_value = {"ok": True}
        mock_upsert.return_value = {"ok": True}
        result = execute_task_anchor_command("approve task-3", state_file=self.state_file)

        self.assertTrue(result["ok"])
        self.assertEqual(mock_upsert.call_args[1]["status"], "queued")
        self.assertIn("Approved", mock_send.call_args[0][1])

    @patch("lib.task_anchor_commands._run_task_state_upsert")
    @patch("lib.task_anchor_commands.send_agent_message")
    def test_execute_reject_defers_task(self, mock_send, mock_upsert) -> None:
        mock_send.return_value = {"ok": True}
        mock_upsert.return_value = {"ok": True}
        result = execute_task_anchor_command("reject task-3", state_file=self.state_file)

        self.assertTrue(result["ok"])
        self.assertEqual(mock_upsert.call_args[1]["status"], "deferred")

    def test_missing_task_returns_not_found(self) -> None:
        result = execute_task_anchor_command("details missing", state_file=self.state_file)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "not_found")


if __name__ == "__main__":
    unittest.main()
