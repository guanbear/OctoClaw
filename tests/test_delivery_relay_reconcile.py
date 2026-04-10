#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib.delivery_relay_reconcile import reconcile_pending_deliveries, unresolved_pending_deliveries


def _ready_task(task_id: str, session_key: str) -> dict:
    return {
        "id": task_id,
        "status": "completed",
        "route": "spawn_single",
        "session_key": session_key,
        "summary": "任务完成",
        "user_safe_summary": "任务完成",
        "report_path": "/tmp/report.md",
        "artifacts": {
            "worker_result": {
                "schema_version": "octoclaw.worker_result/v1",
                "status": "done",
                "summary": "任务完成",
                "user_safe_summary": "任务完成",
                "report": "/tmp/report.md",
                "artifacts": ["/tmp/report.md"],
                "risks": [],
                "next_step": "none",
            }
        },
    }


class DeliveryRelayReconcileTests(unittest.TestCase):
    def test_unresolved_pending_deliveries_excludes_observed_and_compensated(self) -> None:
        events = [
            {"event": "delivery_pending", "deliveryId": "delivery-1", "sessionKey": "s1", "at": "2026-04-10T01:00:00Z"},
            {"event": "delivery_observed", "deliveryId": "delivery-1", "sessionKey": "s1", "at": "2026-04-10T01:01:00Z"},
            {"event": "delivery_pending", "deliveryId": "delivery-2", "sessionKey": "s1", "at": "2026-04-10T01:02:00Z"},
            {"event": "delivery_compensated", "deliveryId": "delivery-2", "sessionKey": "s1", "at": "2026-04-10T01:03:00Z"},
            {"event": "delivery_pending", "deliveryId": "delivery-3", "sessionKey": "s1", "at": "2026-04-10T01:04:00Z"},
        ]

        pending = unresolved_pending_deliveries(events, session_key="s1")

        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["deliveryId"], "delivery-3")

    @patch("lib.delivery_relay_reconcile.send_task_completion_notification")
    def test_reconcile_pending_deliveries_compensates_ready_task(self, mock_send) -> None:
        mock_send.return_value = {"ok": True, "message_id": "m-1"}
        with tempfile.TemporaryDirectory(prefix="octoclaw-delivery-reconcile-") as tmpdir:
            root = Path(tmpdir)
            relay_path = root / "delivery-relay.jsonl"
            relay_path.write_text(
                json.dumps({
                    "schema_version": "octoclaw.delivery_relay.event/v1",
                    "event": "delivery_pending",
                    "deliveryId": "delivery-1",
                    "sessionKey": "agent:main:slack:direct:u1",
                    "taskId": "task-1",
                    "runnerJobId": "runner-1",
                    "at": "2026-04-10T01:00:00Z",
                }) + "\n",
                encoding="utf-8",
            )
            task_state_path = root / "task-state.json"
            task_state_path.write_text(
                json.dumps({"tasks": [_ready_task("task-1", "agent:main:slack:direct:u1")]}, ensure_ascii=False),
                encoding="utf-8",
            )

            payload = reconcile_pending_deliveries(
                relay_path=str(relay_path),
                task_state_path=str(task_state_path),
                session_key="agent:main:slack:direct:u1",
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["pending_count"], 1)
        self.assertEqual(payload["items"][0]["status"], "compensated")
        self.assertEqual(payload["items"][0]["messageId"], "m-1")

    @patch("lib.delivery_relay_reconcile.send_task_completion_notification")
    def test_reconcile_pending_deliveries_keeps_not_ready_task_pending(self, mock_send) -> None:
        mock_send.return_value = {"ok": True, "message_id": "m-1"}
        with tempfile.TemporaryDirectory(prefix="octoclaw-delivery-reconcile-pending-") as tmpdir:
            root = Path(tmpdir)
            relay_path = root / "delivery-relay.jsonl"
            relay_path.write_text(
                json.dumps({
                    "schema_version": "octoclaw.delivery_relay.event/v1",
                    "event": "delivery_pending",
                    "deliveryId": "delivery-2",
                    "sessionKey": "agent:main:slack:direct:u2",
                    "taskId": "task-2",
                    "at": "2026-04-10T01:00:00Z",
                }) + "\n",
                encoding="utf-8",
            )
            task_state_path = root / "task-state.json"
            task_state_path.write_text(
                json.dumps({
                    "tasks": [{
                        "id": "task-2",
                        "status": "running",
                        "route": "spawn_single",
                        "session_key": "agent:main:slack:direct:u2",
                        "summary": "仍在执行中",
                    }]
                }, ensure_ascii=False),
                encoding="utf-8",
            )

            payload = reconcile_pending_deliveries(
                relay_path=str(relay_path),
                task_state_path=str(task_state_path),
                session_key="agent:main:slack:direct:u2",
            )

        self.assertEqual(payload["items"][0]["status"], "task_not_ready")
        mock_send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
