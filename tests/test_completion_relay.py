#!/usr/bin/env python3
"""Tests for lib/completion_relay.py."""

from __future__ import annotations

import subprocess
import sys
import os
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from completion_relay import (
    COMPLETION_RELAY_SCHEMA_VERSION,
    build_completion_payload,
    relay_child_completion,
    relay_task_completion,
    _task_state_update_cli,
)


class TestBuildCompletionPayload(unittest.TestCase):
    def test_build_completion_payload(self):
        payload = build_completion_payload(
            task_id="t-1",
            status="done",
            summary="all good",
            report_path="/tmp/report.md",
            failure_type="",
        )
        self.assertEqual(payload["schema_version"], COMPLETION_RELAY_SCHEMA_VERSION)
        self.assertEqual(payload["task_id"], "t-1")
        self.assertEqual(payload["status"], "done")
        self.assertEqual(payload["summary"], "all good")
        self.assertEqual(payload["report_path"], "/tmp/report.md")
        self.assertEqual(payload["failure_type"], "")
        self.assertIn("outcome_state", payload)
        self.assertIn("handoff_state", payload)
        self.assertIn("timestamp", payload)

    def test_build_completion_payload_maps_failure_type(self):
        payload = build_completion_payload(
            task_id="t-2",
            status="failed",
            summary="boom",
            report_path="",
            failure_type="timed_out",
        )
        self.assertEqual(payload["failure_type"], "timed_out")
        self.assertEqual(payload["outcome_state"], "failed")
        self.assertEqual(payload["handoff_state"], "internal_only")


class TestRelayTaskCompletionDone(unittest.TestCase):
    @patch("completion_relay._task_state_update_cli")
    def test_relay_task_completion_done(self, mock_cli):
        mock_cli.return_value = {"ok": True, "stdout": "", "stderr": ""}
        result = relay_task_completion(
            task_id="t-done",
            status="done",
            summary="completed",
            report_path="/tmp/r.md",
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["task_id"], "t-done")
        self.assertEqual(result["status"], "done")
        mock_cli.assert_called_once()
        args = mock_cli.call_args[0][0]
        self.assertIn("done", args)
        self.assertIn("--id", args)
        idx_id = args.index("--id")
        self.assertEqual(args[idx_id + 1], "t-done")


class TestRelayTaskCompletionFailed(unittest.TestCase):
    @patch("completion_relay._task_state_update_cli")
    def test_relay_task_completion_failed(self, mock_cli):
        mock_cli.return_value = {"ok": True, "stdout": "", "stderr": ""}
        result = relay_task_completion(
            task_id="t-fail",
            status="failed",
            summary="error occurred",
            failure_type="timed_out",
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["task_id"], "t-fail")
        self.assertEqual(result["status"], "failed")
        mock_cli.assert_called_once()
        args = mock_cli.call_args[0][0]
        self.assertIn("failed", args)
        self.assertIn("--failure-type", args)
        idx_ft = args.index("--failure-type")
        self.assertEqual(args[idx_ft + 1], "timed_out")


class TestRelayTaskCompletionBlocked(unittest.TestCase):
    @patch("completion_relay._task_state_update_cli")
    def test_relay_task_completion_blocked(self, mock_cli):
        mock_cli.return_value = {"ok": True, "stdout": "", "stderr": ""}
        result = relay_task_completion(
            task_id="t-block",
            status="blocked",
            summary="waiting on dep",
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "blocked")
        mock_cli.assert_called_once()
        args = mock_cli.call_args[0][0]
        self.assertIn("blocked", args)


class TestRelayTaskCompletionInvalidTransition(unittest.TestCase):
    @patch("completion_relay._task_state_update_cli")
    def test_relay_task_completion_invalid_transition(self, mock_cli):
        with patch("completion_relay.validate_transition") as mock_val:
            mock_val.return_value = {
                "valid": False,
                "violations": ["invalid outcome transition: done -> failed"],
            }
            result = relay_task_completion(
                task_id="t-inv",
                status="done",
                summary="x",
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid_transition")
        self.assertIn("violations", result)
        mock_cli.assert_not_called()


class TestRelayChildCompletion(unittest.TestCase):
    @patch("completion_relay._task_state_update_cli")
    def test_relay_child_completion(self, mock_cli):
        mock_cli.return_value = {"ok": True, "stdout": "", "stderr": ""}
        result = relay_child_completion(
            parent_id="p-1",
            child_id="c-1",
            child_status="done",
            child_summary="child done",
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["parent_id"], "p-1")
        self.assertEqual(result["task_id"], "c-1")
        self.assertEqual(result["status"], "done")
        mock_cli.assert_called_once()
        args = mock_cli.call_args[0][0]
        idx_id = args.index("--id")
        self.assertEqual(args[idx_id + 1], "c-1")


class TestTaskStateUpdateCliTimeout(unittest.TestCase):
    @patch("subprocess.run")
    def test_task_state_update_cli_timeout(self, mock_run):
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="python3", timeout=30)
        result = _task_state_update_cli(["python3", "echo", "hi"], timeout=30)
        self.assertFalse(result["ok"])
        self.assertEqual(result.get("error"), "subprocess_timeout")


if __name__ == "__main__":
    unittest.main()
