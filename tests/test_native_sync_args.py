#!/usr/bin/env python3
"""Regression tests for native terminal sync arg format.

Verifies that sync_terminal_transition calls _run_runtime_helper with correct
--session-key, --flow-id, --expected-revision, --state-json flag arguments.
"""

from __future__ import annotations

import sys
import os
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

from openclaw_taskflow_adapter import sync_terminal_transition


BOUND_TASK = {
    "id": "task-1",
    "status": "done",
    "session_key": "sess-abc",
    "openclaw_taskflow": {
        "native_binding_state": "bound",
        "backend": "managed",
        "flow_id": "flow-123",
        "session_key": "sess-abc",
        "substrate_revision": 5,
    },
}

UNBOUND_TASK = {
    "id": "task-2",
    "openclaw_taskflow": {
        "native_binding_state": "none",
        "backend": "mirror",
    },
}


class TestFinishFlowArgs(unittest.TestCase):
    @patch("openclaw_taskflow_adapter._run_runtime_helper")
    def test_finish_flow_uses_flag_args(self, mock_helper):
        mock_helper.return_value = {"ok": True}
        result = sync_terminal_transition(BOUND_TASK, "finished")
        self.assertTrue(result["synced"])
        mock_helper.assert_called_once()
        args = mock_helper.call_args[0][0]
        self.assertIn("--flow-id", args)
        self.assertEqual(args[args.index("--flow-id") + 1], "flow-123")
        self.assertIn("--session-key", args)
        self.assertEqual(args[args.index("--session-key") + 1], "sess-abc")
        self.assertIn("--expected-revision", args)
        self.assertEqual(args[args.index("--expected-revision") + 1], "5")
        self.assertIn("--state-json", args)
        self.assertEqual(args[0], "finish-flow")


class TestFailFlowArgs(unittest.TestCase):
    @patch("openclaw_taskflow_adapter._run_runtime_helper")
    def test_fail_flow_uses_flag_args(self, mock_helper):
        mock_helper.return_value = {"ok": True}
        result = sync_terminal_transition(BOUND_TASK, "failed")
        self.assertTrue(result["synced"])
        mock_helper.assert_called_once()
        args = mock_helper.call_args[0][0]
        self.assertEqual(args[0], "fail-flow")
        self.assertIn("--flow-id", args)
        self.assertIn("--session-key", args)
        self.assertIn("--expected-revision", args)
        self.assertIn("--state-json", args)


class TestCancelFlowArgs(unittest.TestCase):
    @patch("openclaw_taskflow_adapter._run_runtime_helper")
    def test_cancel_flow_uses_flag_args_no_state_json(self, mock_helper):
        mock_helper.return_value = {"ok": True}
        result = sync_terminal_transition(BOUND_TASK, "cancelled")
        self.assertTrue(result["synced"])
        mock_helper.assert_called_once()
        args = mock_helper.call_args[0][0]
        self.assertEqual(args[0], "cancel-flow")
        self.assertIn("--flow-id", args)
        self.assertIn("--session-key", args)
        self.assertNotIn("--state-json", args)
        self.assertNotIn("--expected-revision", args)


class TestUnboundTaskSkips(unittest.TestCase):
    @patch("openclaw_taskflow_adapter._run_runtime_helper")
    def test_unbound_task_no_sync(self, mock_helper):
        result = sync_terminal_transition(UNBOUND_TASK, "finished")
        self.assertFalse(result["synced"])
        mock_helper.assert_not_called()


class TestMissingFlowIdSkips(unittest.TestCase):
    @patch("openclaw_taskflow_adapter._run_runtime_helper")
    def test_missing_flow_id_no_sync(self, mock_helper):
        task = dict(BOUND_TASK)
        task["openclaw_taskflow"] = dict(task["openclaw_taskflow"])
        task["openclaw_taskflow"]["flow_id"] = ""
        result = sync_terminal_transition(task, "finished")
        self.assertFalse(result["synced"])
        mock_helper.assert_not_called()


class TestNoPositionalFlowId(unittest.TestCase):
    """Regression: verify we never pass flow_id as a positional arg."""

    @patch("openclaw_taskflow_adapter._run_runtime_helper")
    def test_no_positional_flow_id_in_finish(self, mock_helper):
        mock_helper.return_value = {"ok": True}
        sync_terminal_transition(BOUND_TASK, "finished")
        args = mock_helper.call_args[0][0]
        self.assertNotEqual(args[1], "flow-123")
        self.assertNotEqual(args[-1], "flow-123")

    @patch("openclaw_taskflow_adapter._run_runtime_helper")
    def test_no_positional_flow_id_in_cancel(self, mock_helper):
        mock_helper.return_value = {"ok": True}
        sync_terminal_transition(BOUND_TASK, "cancelled")
        args = mock_helper.call_args[0][0]
        self.assertNotEqual(args[1], "flow-123")


if __name__ == "__main__":
    unittest.main()
