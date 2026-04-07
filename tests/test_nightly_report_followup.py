#!/usr/bin/env python3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib import nightly_report_followup


class NightlyReportFollowupTests(unittest.TestCase):
    def test_build_followup_prompt_mentions_fix_mode_and_report_outputs(self) -> None:
        prompt = nightly_report_followup.build_followup_prompt(
            report_path=Path("/repo/reports/reply-review-validation/2026-04-05.md"),
            output_report_path=Path("/workspace/tmp/octopus/nightly-followup/2026-04-05/followup-report.md"),
            repo_root=Path("/repo"),
            fix_enabled=True,
        )

        self.assertIn("high-confidence, low-risk fix", prompt)
        self.assertIn("followup-report.md", prompt)
        self.assertIn("Changes Made", prompt)

    def test_build_notification_task_includes_changed_files_and_report_path(self) -> None:
        task = nightly_report_followup.build_notification_task(
            day="2026-04-05",
            session_key="agent:main:slack:channel:C123:thread:1",
            report_path=Path("/repo/reports/reply-review-validation/2026-04-05.md"),
            followup_report_path=Path("/workspace/tmp/octopus/nightly-followup/2026-04-05/followup-report.md"),
            wait_result={"wait_seconds": 180},
            agent_result={"ok": True},
            git_summary={"changed": True, "changed_files": ["lib/foo.py", "tests/test_foo.py"]},
        )

        self.assertEqual(task["status"], "done")
        self.assertEqual(task["session_key"], "agent:main:slack:channel:C123:thread:1")
        self.assertIn("Code changed: yes", task["user_safe_summary"])
        self.assertIn("lib/foo.py", task["user_safe_summary"])
        self.assertEqual(task["artifacts"]["report_path"], str(Path("/workspace/tmp/octopus/nightly-followup/2026-04-05/followup-report.md")))

    def test_wait_for_report_returns_timeout_when_report_never_appears(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-nightly-followup-") as tmpdir:
            report_path = Path(tmpdir) / "missing.md"
            result = nightly_report_followup.wait_for_report(
                repo_root=Path(tmpdir),
                branch="main",
                report_path=report_path,
                max_wait_seconds=0,
                poll_seconds=1,
                sync_with_git=False,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "report_timeout")

    @patch("lib.nightly_report_followup.send_task_notification")
    def test_send_notification_uses_task_notification_for_session_key(self, mock_send_task_notification) -> None:
        mock_send_task_notification.return_value = {"ok": True}

        result = nightly_report_followup.send_notification(
            config={"main_session": {"session_key": "agent:main:slack:channel:C123:thread:1"}},
            backend="auto",
            report_day="2026-04-05",
            report_path=Path("/repo/reports/reply-review-validation/2026-04-05.md"),
            followup_report_path=Path("/workspace/tmp/octopus/nightly-followup/2026-04-05/followup-report.md"),
            wait_result={"wait_seconds": 42},
            agent_result={"ok": True},
            git_summary={"changed": False, "changed_files": [], "status_lines": []},
            notify_session_key="",
            notify_channel="",
            notify_target="",
            notify_thread_id="",
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "task_notification")
        sent_task = mock_send_task_notification.call_args[0][0]
        self.assertEqual(sent_task["session_key"], "agent:main:slack:channel:C123:thread:1")

    @patch("lib.nightly_report_followup.send_channel_message")
    def test_send_notification_uses_direct_channel_override_when_target_provided(self, mock_send_channel_message) -> None:
        mock_send_channel_message.return_value = {"ok": True}

        result = nightly_report_followup.send_notification(
            config={},
            backend="slack",
            report_day="2026-04-05",
            report_path=Path("/repo/reports/reply-review-validation/2026-04-05.md"),
            followup_report_path=Path("/workspace/tmp/octopus/nightly-followup/2026-04-05/followup-report.md"),
            wait_result={"wait_seconds": 42},
            agent_result={"ok": False},
            git_summary={"changed": False, "changed_files": [], "status_lines": []},
            notify_session_key="",
            notify_channel="slack",
            notify_target="channel:C456",
            notify_thread_id="1712345.000100",
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "direct_channel")
        args = mock_send_channel_message.call_args[0]
        self.assertEqual(args[0], "slack")
        self.assertEqual(args[1], "channel:C456")
        self.assertIn("Follow-up report", args[2])


if __name__ == "__main__":
    unittest.main()
