#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib import session_ops


class SessionOpsMessageSendTests(unittest.TestCase):
    @patch("lib.session_ops.has_openclaw_cli", return_value=True)
    @patch("lib.session_ops.subprocess.run")
    def test_gateway_call_uses_gateway_token_from_env(self, mock_run, _mock_cli) -> None:
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = json.dumps({"ok": True})
        mock_run.return_value.stderr = ""

        with patch.dict("os.environ", {"OPENCLAW_GATEWAY_TOKEN": "tok-1"}, clear=False):
            result = session_ops.gateway_call("health", {"scope": "local"})

        self.assertTrue(result["ok"])
        args = mock_run.call_args[0][0]
        self.assertIn("--token", args)
        self.assertIn("tok-1", args)

    @patch("lib.session_ops.has_openclaw_cli", return_value=True)
    @patch("lib.session_ops.subprocess.run")
    def test_gateway_call_uses_gateway_token_from_config_when_env_missing(self, mock_run, _mock_cli) -> None:
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = json.dumps({"ok": True})
        mock_run.return_value.stderr = ""

        with tempfile.TemporaryDirectory(prefix="octoclaw-gateway-token-") as tmpdir:
            fake_home = Path(tmpdir)
            cfg = fake_home / ".openclaw" / "openclaw.json"
            cfg.parent.mkdir(parents=True, exist_ok=True)
            cfg.write_text(
                json.dumps({"gateway": {"auth": {"mode": "token", "token": "tok-from-config"}}}, ensure_ascii=False),
                encoding="utf-8",
            )
            with patch.dict("os.environ", {"HOME": str(fake_home)}, clear=False):
                result = session_ops.gateway_call("health", {"scope": "local"})

        self.assertTrue(result["ok"])
        args = mock_run.call_args[0][0]
        self.assertIn("--token", args)
        self.assertIn("tok-from-config", args)

    @patch("lib.session_ops.has_openclaw_cli", return_value=True)
    @patch("lib.session_ops.subprocess.run")
    def test_gateway_call_respects_openclaw_home_override(self, mock_run, _mock_cli) -> None:
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = json.dumps({"ok": True})
        mock_run.return_value.stderr = ""

        with tempfile.TemporaryDirectory(prefix="octoclaw-gateway-token-home-") as tmpdir:
            acceptance_home = Path(tmpdir) / "acceptance-home"
            cfg = acceptance_home / "openclaw.json"
            cfg.parent.mkdir(parents=True, exist_ok=True)
            cfg.write_text(
                json.dumps({"gateway": {"auth": {"mode": "token", "token": "tok-from-acceptance-home"}}}, ensure_ascii=False),
                encoding="utf-8",
            )
            with patch.dict("os.environ", {"OPENCLAW_HOME": str(acceptance_home)}, clear=False):
                result = session_ops.gateway_call("health", {"scope": "local"})

        self.assertTrue(result["ok"])
        args = mock_run.call_args[0][0]
        self.assertIn("--token", args)
        self.assertIn("tok-from-acceptance-home", args)

    def test_resolve_message_target_from_slack_thread_session(self) -> None:
        result = session_ops.resolve_message_target_from_session_key("agent:main:slack:channel:C123:thread:1712345.000100")
        self.assertTrue(result["ok"])
        self.assertEqual(result["origin"], "slack")
        self.assertEqual(result["target"], "channel:C123")
        self.assertEqual(result["thread_id"], "1712345.000100")

    def test_resolve_message_target_from_discord_thread_session(self) -> None:
        result = session_ops.resolve_message_target_from_session_key("agent:main:discord:channel:123:thread:456")
        self.assertTrue(result["ok"])
        self.assertEqual(result["origin"], "discord")
        self.assertEqual(result["target"], "channel:456")
        self.assertEqual(result["thread_id"], "")

    def test_resolve_message_target_from_telegram_topic_session(self) -> None:
        result = session_ops.resolve_message_target_from_session_key("agent:main:telegram:group:-1001234567890:topic:42")
        self.assertTrue(result["ok"])
        self.assertEqual(result["origin"], "telegram")
        self.assertEqual(result["target"], "-1001234567890")
        self.assertEqual(result["thread_id"], "42")

    def test_resolve_message_target_uses_generic_im_fallback_for_wechat(self) -> None:
        result = session_ops.resolve_message_target_from_session_key("wechat:dm:ou_123")
        self.assertTrue(result["ok"])
        self.assertEqual(result["origin"], "wechat")
        self.assertEqual(result["target"], "user:ou_123")
        self.assertEqual(result["thread_id"], "")

    def test_resolve_message_target_uses_generic_thread_fallback_for_webchat(self) -> None:
        result = session_ops.resolve_message_target_from_session_key("webchat:thread:alpha")
        self.assertTrue(result["ok"])
        self.assertEqual(result["origin"], "webchat")
        self.assertEqual(result["target"], "thread:alpha")

    @patch("lib.session_ops.has_openclaw_cli", return_value=False)
    def test_send_channel_message_fails_without_cli(self, _mock_cli) -> None:
        result = session_ops.send_channel_message("slack", "channel:C123", "hello")
        self.assertFalse(result["ok"])
        self.assertIn("unavailable", result["error"])

    @patch("lib.session_ops.has_openclaw_cli", return_value=True)
    @patch("lib.session_ops.subprocess.run")
    def test_send_channel_message_builds_expected_cli_args(self, mock_run, _mock_cli) -> None:
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = json.dumps({"messageId": "m-1"})
        mock_run.return_value.stderr = ""

        result = session_ops.send_channel_message(
            "slack",
            "channel:C123",
            "hello",
            reply_to="1712345.000200",
            thread_id="1712345.000100",
            interactive={"blocks": [{"type": "buttons", "buttons": [{"label": "View", "value": "details code-1"}]}]},
            components={"blocks": [{"type": "actions"}]},
        )

        self.assertTrue(result["ok"])
        args = mock_run.call_args[0][0]
        self.assertEqual(args[:7], ["openclaw", "message", "send", "--channel", "slack", "--target", "channel:C123"])
        self.assertIn("--message", args)
        self.assertIn("--reply-to", args)
        self.assertIn("--thread-id", args)
        self.assertIn("--interactive", args)
        self.assertIn("--components", args)
        self.assertIn("--json", args)

    @patch("lib.session_ops.has_openclaw_cli", return_value=True)
    @patch("lib.session_ops.subprocess.run")
    def test_send_channel_message_handles_nonzero_exit(self, mock_run, _mock_cli) -> None:
        mock_run.return_value.returncode = 1
        mock_run.return_value.stdout = ""
        mock_run.return_value.stderr = "boom"

        result = session_ops.send_channel_message("slack", "channel:C123", "hello")

        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "error")
        self.assertIn("boom", result["error"])

    @patch("lib.session_ops.has_openclaw_cli", return_value=True)
    @patch("lib.session_ops.subprocess.run")
    def test_send_channel_message_retries_once_on_timeout(self, mock_run, _mock_cli) -> None:
        mock_run.side_effect = [
            subprocess.TimeoutExpired(cmd=["openclaw", "message", "send"], timeout=20),
            type("Proc", (), {"returncode": 0, "stdout": json.dumps({"messageId": "m-2"}), "stderr": ""})(),
        ]

        result = session_ops.send_channel_message("slack", "channel:C123", "hello")

        self.assertTrue(result["ok"])
        self.assertEqual(result["retry_count"], 1)
        self.assertEqual(mock_run.call_count, 2)

    @patch("lib.session_ops.has_openclaw_cli", return_value=True)
    @patch("lib.session_ops.subprocess.run")
    def test_edit_channel_message_builds_expected_cli_args(self, mock_run, _mock_cli) -> None:
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = json.dumps({"ok": True})
        mock_run.return_value.stderr = ""

        result = session_ops.edit_channel_message("slack", "channel:C123", "1712345.000100", "updated")

        self.assertTrue(result["ok"])
        args = mock_run.call_args[0][0]
        self.assertEqual(
            args[:11],
            [
                "openclaw",
                "message",
                "edit",
                "--channel",
                "slack",
                "--target",
                "channel:C123",
                "--message-id",
                "1712345.000100",
                "--message",
                "updated",
            ],
        )
        self.assertIn("--json", args)


if __name__ == "__main__":
    unittest.main()
