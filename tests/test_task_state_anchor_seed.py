#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

SPEC = importlib.util.spec_from_file_location(
    "task_state_update_module",
    REPO_ROOT / "lib" / "task-state-update.py",
)
task_state_update = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(task_state_update)


class TaskStateAnchorSeedTests(unittest.TestCase):
    def test_should_sync_only_for_session_bound_non_direct_tasks(self) -> None:
        self.assertTrue(
            task_state_update._should_sync_task_anchor(
                {
                    "id": "task-1",
                    "session_key": "slack:channel:C123",
                    "status": "dispatched",
                    "route": "spawn_single",
                },
                "",
                {},
            )
        )
        self.assertFalse(
            task_state_update._should_sync_task_anchor(
                {
                    "id": "task-1",
                    "session_key": "slack:channel:C123",
                    "status": "dispatched",
                    "route": "direct",
                },
                "",
                {},
            )
        )
        self.assertFalse(
            task_state_update._should_sync_task_anchor(
                {
                    "id": "task-1",
                    "session_key": "",
                    "status": "dispatched",
                    "route": "spawn_single",
                },
                "",
                {},
            )
        )

    def test_sync_task_anchor_seeds_message_id_for_new_task(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-anchor-seed-") as tmpdir:
            notify_path = Path(tmpdir) / "patrol-notify-state.json"
            with (
                patch.object(task_state_update, "PATROL_NOTIFY_STATE_FILE", str(notify_path)),
                patch.object(
                    task_state_update,
                    "send_task_notification",
                    return_value={"ok": True, "backend": "slack", "messageId": "m-1", "action": "send"},
                ),
            ):
                result = task_state_update._sync_task_anchor(
                    {
                        "id": "task-1",
                        "session_key": "slack:channel:C123",
                        "status": "dispatched",
                        "route": "spawn_single",
                    },
                    "",
                )

            self.assertTrue(result["ok"])
            saved = json.loads(notify_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["task_anchor_messages"]["task-1"]["message_id"], "m-1")

    def test_sync_task_anchor_updates_existing_anchor_for_status_change(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-anchor-seed-") as tmpdir:
            notify_path = Path(tmpdir) / "patrol-notify-state.json"
            notify_path.write_text(
                json.dumps({"task_ids": {}, "task_anchor_messages": {"task-1": {"message_id": "old"}}, "updated_at": ""}),
                encoding="utf-8",
            )
            with (
                patch.object(task_state_update, "PATROL_NOTIFY_STATE_FILE", str(notify_path)),
                patch.object(
                    task_state_update,
                    "send_task_notification",
                    return_value={"ok": True, "backend": "slack", "messageId": "old", "action": "edit"},
                ) as mock_send,
            ):
                result = task_state_update._sync_task_anchor(
                    {
                        "id": "task-1",
                        "session_key": "slack:channel:C123",
                        "status": "done",
                        "route": "spawn_single",
                    },
                    "running",
                )

            self.assertTrue(result["ok"])
            self.assertEqual(result["action"], "edit")
            self.assertEqual(mock_send.call_args[1]["existing_message_id"], "old")

    def test_sync_task_anchor_does_not_reuse_bound_message_id_when_local_state_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-anchor-seed-") as tmpdir:
            notify_path = Path(tmpdir) / "patrol-notify-state.json"
            with (
                patch.object(task_state_update, "PATROL_NOTIFY_STATE_FILE", str(notify_path)),
                patch.object(
                    task_state_update,
                    "send_task_notification",
                    return_value={"ok": True, "backend": "slack", "messageId": "m-3", "action": "send"},
                ) as mock_send,
            ):
                result = task_state_update._sync_task_anchor(
                    {
                        "id": "task-1",
                        "session_key": "slack:channel:C123",
                        "status": "done",
                        "route": "spawn_single",
                    },
                    "running",
                )

            self.assertTrue(result["ok"])
            self.assertEqual(result["action"], "send")
            self.assertEqual(mock_send.call_args[1]["existing_message_id"], "")

    def test_sync_task_anchor_skips_when_nothing_to_do(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-anchor-seed-") as tmpdir:
            notify_path = Path(tmpdir) / "patrol-notify-state.json"
            with (
                patch.object(task_state_update, "PATROL_NOTIFY_STATE_FILE", str(notify_path)),
                patch.object(task_state_update, "send_task_notification") as mock_send,
            ):
                result = task_state_update._sync_task_anchor(
                    {
                        "id": "task-1",
                        "session_key": "slack:channel:C123",
                        "status": "running",
                        "route": "spawn_single",
                    },
                    "running",
                )

            self.assertFalse(result["ok"])
            self.assertTrue(result["skipped"])
            mock_send.assert_not_called()

    def test_sync_task_anchor_force_bypasses_status_gate_for_completion_relay(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-anchor-seed-") as tmpdir:
            notify_path = Path(tmpdir) / "patrol-notify-state.json"
            with (
                patch.object(task_state_update, "PATROL_NOTIFY_STATE_FILE", str(notify_path)),
                patch.object(
                    task_state_update,
                    "send_task_notification",
                    return_value={"ok": True, "backend": "slack", "messageId": "m-2", "action": "send"},
                ) as mock_send,
            ):
                result = task_state_update._sync_task_anchor(
                    {
                        "id": "task-2",
                        "session_key": "slack:channel:C234",
                        "status": "done",
                        "route": "spawn_single",
                    },
                    "done",
                    force=True,
                )

            self.assertTrue(result["ok"])
            mock_send.assert_called_once()

    def test_sync_task_completion_relay_uses_anchor_message_as_reply_reference(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-completion-relay-") as tmpdir:
            notify_path = Path(tmpdir) / "patrol-notify-state.json"
            notify_path.write_text(
                json.dumps(
                    {
                        "task_ids": {},
                        "task_anchor_messages": {"task-3": {"message_id": "anchor-1"}},
                        "task_completion_messages": {},
                        "updated_at": "",
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.object(task_state_update, "PATROL_NOTIFY_STATE_FILE", str(notify_path)),
                patch.object(
                    task_state_update,
                    "send_task_completion_notification",
                    return_value={"ok": True, "backend": "slack", "messageId": "relay-1", "action": "send"},
                ) as mock_send,
            ):
                result = task_state_update._sync_task_completion_relay(
                    {
                        "id": "task-3",
                        "session_key": "slack:channel:C123",
                        "status": "done",
                        "route": "spawn_single",
                        "handoff_state": "user_safe_ready",
                        "user_safe_summary": "完成总结。",
                    },
                    "running",
                    force=True,
                )

            self.assertTrue(result["ok"])
            self.assertEqual(mock_send.call_args[1]["reply_to_message_id"], "anchor-1")
            saved = json.loads(notify_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["task_completion_messages"]["task-3"]["message_id"], "relay-1")

    def test_sync_task_completion_relay_records_delivery_relay_result(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-completion-relay-ledger-") as tmpdir:
            notify_path = Path(tmpdir) / "patrol-notify-state.json"
            relay_path = Path(tmpdir) / "tmp" / "octopus" / "delivery-relay.jsonl"
            relay_path.parent.mkdir(parents=True, exist_ok=True)
            relay_path.write_text(
                json.dumps(
                    {
                        "schema_version": "octoclaw.delivery_relay.event/v1",
                        "event": "delivery_pending",
                        "deliveryId": "delivery-task-4",
                        "sessionKey": "slack:channel:C123",
                        "taskId": "task-4",
                        "runnerJobId": "runner-4",
                        "at": "2026-04-10T01:00:00Z",
                    }
                ) + "\n",
                encoding="utf-8",
            )
            with (
                patch.dict(os.environ, {"WORKSPACE": tmpdir}, clear=False),
                patch.object(task_state_update, "PATROL_NOTIFY_STATE_FILE", str(notify_path)),
                patch.object(
                    task_state_update,
                    "send_task_completion_notification",
                    return_value={"ok": True, "backend": "slack", "messageId": "relay-4", "action": "send"},
                ),
            ):
                result = task_state_update._sync_task_completion_relay(
                    {
                        "id": "task-4",
                        "session_key": "slack:channel:C123",
                        "status": "done",
                        "route": "spawn_single",
                        "handoff_state": "user_safe_ready",
                        "user_safe_summary": "完成总结。",
                        "runner_job_id": "runner-4",
                    },
                    "running",
                    force=True,
                )

            self.assertTrue(result["ok"])
            lines = [json.loads(line) for line in relay_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertEqual(lines[-1]["event"], "delivery_compensated")
            self.assertEqual(lines[-1]["deliveryId"], "delivery-task-4")
            self.assertEqual(lines[-1]["messageId"], "relay-4")
            task_events_path = Path(tmpdir) / "tmp" / "octopus" / "task-events.jsonl"
            events = [json.loads(line) for line in task_events_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertEqual(events[-1]["kind"], "delivery_sent")
            self.assertEqual(events[-1]["delivery_id"], "delivery-task-4")


if __name__ == "__main__":
    unittest.main()
