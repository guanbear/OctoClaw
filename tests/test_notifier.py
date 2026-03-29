#!/usr/bin/env python3
import unittest

from lib.notifier import build_task_notification_payload


class NotifierTaskPayloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.task = {
            "id": "code-1",
            "worker_pool": "octoclaw-code",
            "status": "running",
            "summary": "fix login 401 and add tests",
            "route": "spawn_single",
            "model": "omniroute/cx/gpt-5.4",
        }

    def test_build_task_notification_payload_uses_slack_renderer(self) -> None:
        payload = build_task_notification_payload(self.task, backend="slack")

        self.assertEqual(payload["schema_version"], "octoclaw.notification.task/v1")
        self.assertEqual(payload["backend"], "slack")
        self.assertEqual(payload["transport"]["kind"], "slack")
        self.assertTrue(payload["transport"]["supports_rich"])
        self.assertIn("slack", payload)
        self.assertIn("blocks", payload["slack"])
        self.assertIn("fix login 401", payload["text"])

    def test_build_task_notification_payload_keeps_feishu_text_fallback(self) -> None:
        payload = build_task_notification_payload(self.task, backend="feishu")

        self.assertEqual(payload["backend"], "feishu")
        self.assertEqual(payload["transport"]["kind"], "feishu")
        self.assertIn("feishu", payload)
        self.assertEqual(payload["feishu"]["text"], payload["text"])
        self.assertIn("fix login 401", payload["text"])

    def test_build_task_notification_payload_defaults_to_text_fallback_for_text_only_channels(self) -> None:
        payload = build_task_notification_payload(self.task, backend="whatsapp")

        self.assertEqual(payload["backend"], "whatsapp")
        self.assertEqual(payload["transport"]["kind"], "whatsapp")
        self.assertFalse(payload["transport"]["supports_rich"])
        self.assertNotIn("slack", payload)
        self.assertIn("Route: spawn_single", payload["text"])

    def test_build_task_notification_payload_preserves_operator_surface(self) -> None:
        task = {
            **self.task,
            "artifacts": {
                "operator_surface": {
                    "operator_hint": "clawteam/tmux octoclaw-validation",
                }
            },
        }

        payload = build_task_notification_payload(task, backend="slack")

        self.assertEqual(payload["operator_surface"]["schema_version"], "octoclaw.task_display/v1")
        self.assertEqual(payload["task_anchor"]["task_id"], "code-1")
        self.assertEqual(payload["task_actions"][0]["fallback_command"], "details")


if __name__ == "__main__":
    unittest.main()
