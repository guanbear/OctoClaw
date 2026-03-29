#!/usr/bin/env python3
import json
import unittest
from unittest.mock import patch

from lib import session_ops


class SessionOpsMessageSendTests(unittest.TestCase):
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
            components={"blocks": [{"type": "actions"}]},
        )

        self.assertTrue(result["ok"])
        args = mock_run.call_args[0][0]
        self.assertEqual(args[:7], ["openclaw", "message", "send", "--channel", "slack", "--target", "channel:C123"])
        self.assertIn("--message", args)
        self.assertIn("--reply-to", args)
        self.assertIn("--thread-id", args)
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


if __name__ == "__main__":
    unittest.main()
