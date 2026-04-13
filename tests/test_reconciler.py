#!/usr/bin/env python3
"""Tests for lib/reconciler.py — reconciler core."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from lib.reconciler import (
    RECONCILER_SCHEMA_VERSION,
    reconcile_all,
    reconcile_delivery_failed,
    reconcile_lost_tasks,
    reconcile_notification_retry,
    reconcile_stale_tasks,
)


def _write_task_state(workspace: str, tasks: list) -> None:
    path = os.path.join(workspace, "tmp", "octopus", "task-state.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"tasks": tasks, "updated_at": "2026-04-14T00:00:00+00:00"}, f)


def _old_timestamp(minutes_ago: int) -> str:
    ts = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return ts.isoformat()


def _recent_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Sample tasks
# ---------------------------------------------------------------------------

STALE_RUNNING_TASK = {
    "id": "stale-running-1",
    "status": "running",
    "route": "runner",
    "session_key": "sess-test",
    "summary": "stale running task",
    "updated_at": _old_timestamp(60),
    "started_at": _old_timestamp(90),
}

STALE_QUEUED_TASK = {
    "id": "stale-queued-1",
    "status": "queued",
    "route": "direct",
    "session_key": "sess-test",
    "summary": "stale queued task",
    "updated_at": _old_timestamp(45),
}

RECENT_RUNNING_TASK = {
    "id": "recent-running-1",
    "status": "running",
    "route": "runner",
    "session_key": "sess-test",
    "summary": "recent running task",
    "updated_at": _recent_timestamp(),
    "started_at": _recent_timestamp(),
}

TERMINAL_DONE_TASK = {
    "id": "terminal-done-1",
    "status": "done",
    "route": "runner",
    "session_key": "sess-test",
    "summary": "completed task",
    "updated_at": _old_timestamp(60),
    "completed_at": _old_timestamp(50),
}

TERMINAL_FAILED_TASK = {
    "id": "terminal-failed-1",
    "status": "failed",
    "route": "runner",
    "session_key": "sess-test",
    "summary": "failed task",
    "updated_at": _old_timestamp(60),
    "completed_at": _old_timestamp(50),
}

TERMINAL_CANCELLED_TASK = {
    "id": "terminal-cancelled-1",
    "status": "cancelled",
    "route": "direct",
    "session_key": "sess-test",
    "summary": "cancelled task",
    "updated_at": _old_timestamp(60),
}

LOST_RUNNING_TASK = {
    "id": "lost-running-1",
    "status": "running",
    "route": "runner",
    "session_key": "sess-test",
    "summary": "lost running task",
    "updated_at": _old_timestamp(180),
    "started_at": _old_timestamp(200),
}

DELIVERY_FAILED_TASK = {
    "id": "delivery-failed-1",
    "status": "done",
    "route": "runner",
    "session_key": "sess-test",
    "summary": "delivery failed task",
    "updated_at": _old_timestamp(5),
    "retry_count": 1,
}

NO_TIMESTAMP_TASK = {
    "id": "no-ts-1",
    "status": "running",
    "route": "runner",
    "session_key": "sess-test",
    "summary": "task with no timestamps",
}


class ReconcileStaleTasksTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_reconcile_stale_tasks_detects_stale_running(self):
        import lib.reconciler as reconciler_mod
        _write_task_state(self.workspace, [STALE_RUNNING_TASK, RECENT_RUNNING_TASK])

        mock_relay = MagicMock(return_value={"ok": True, "task_id": "stale-running-1"})
        mock_event = MagicMock()
        with patch.object(reconciler_mod, "relay_task_completion", mock_relay), \
             patch.object(reconciler_mod, "append_task_event", mock_event):
            result = reconcile_stale_tasks(
                max_stale_minutes=30,
                workspace=self.workspace,
                dry_run=False,
            )

        self.assertEqual(result["reconciled_count"], 1)
        self.assertEqual(result["items"][0]["task_id"], "stale-running-1")
        self.assertEqual(result["items"][0]["action"], "timed_out")
        mock_relay.assert_called_once()

    def test_reconcile_stale_tasks_skips_terminal(self):
        _write_task_state(self.workspace, [TERMINAL_DONE_TASK, TERMINAL_FAILED_TASK, TERMINAL_CANCELLED_TASK])

        with patch("lib.reconciler.relay_task_completion") as mock_relay:
            result = reconcile_stale_tasks(
                max_stale_minutes=30,
                workspace=self.workspace,
                dry_run=False,
            )

        self.assertEqual(result["reconciled_count"], 0)
        mock_relay.assert_not_called()

    def test_reconcile_stale_tasks_dry_run_no_mutation(self):
        _write_task_state(self.workspace, [STALE_RUNNING_TASK])

        with patch("lib.reconciler.relay_task_completion") as mock_relay, \
             patch("lib.reconciler.append_task_event") as mock_event:
            result = reconcile_stale_tasks(
                max_stale_minutes=30,
                workspace=self.workspace,
                dry_run=True,
            )

        self.assertEqual(result["reconciled_count"], 1)
        self.assertEqual(result["items"][0]["action"], "would_timeout")
        self.assertEqual(result["items"][0]["result"], "dry_run")
        mock_relay.assert_not_called()
        mock_event.assert_not_called()

    def test_reconcile_stale_tasks_nothing_stale(self):
        _write_task_state(self.workspace, [RECENT_RUNNING_TASK])

        result = reconcile_stale_tasks(
            max_stale_minutes=30,
            workspace=self.workspace,
            dry_run=False,
        )

        self.assertEqual(result["reconciled_count"], 0)
        self.assertEqual(result["items"], [])

    def test_reconcile_stale_detects_stale_queued(self):
        _write_task_state(self.workspace, [STALE_QUEUED_TASK])

        with patch("lib.reconciler.relay_task_completion") as mock_relay:
            mock_relay.return_value = {"ok": True}
            result = reconcile_stale_tasks(
                max_stale_minutes=30,
                workspace=self.workspace,
                dry_run=False,
            )

        self.assertEqual(result["reconciled_count"], 1)
        self.assertEqual(result["items"][0]["task_id"], "stale-queued-1")

    def test_reconcile_stale_expected_done_past(self):
        task = {
            "id": "expected-done-past",
            "status": "running",
            "route": "runner",
            "session_key": "sess-test",
            "summary": "task past expected completion",
            "updated_at": _recent_timestamp(),
            "started_at": _recent_timestamp(),
            "expected_done_at": _old_timestamp(5),
        }
        _write_task_state(self.workspace, [task])

        with patch("lib.reconciler.relay_task_completion") as mock_relay:
            mock_relay.return_value = {"ok": True}
            result = reconcile_stale_tasks(
                max_stale_minutes=30,
                workspace=self.workspace,
                dry_run=False,
            )

        self.assertEqual(result["reconciled_count"], 1)


class ReconcileLostTasksTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_reconcile_lost_tasks_detects_lost(self):
        import lib.reconciler as reconciler_mod
        _write_task_state(self.workspace, [LOST_RUNNING_TASK, RECENT_RUNNING_TASK])

        mock_relay = MagicMock(return_value={"ok": True, "task_id": "lost-running-1"})
        mock_event = MagicMock()
        with patch.object(reconciler_mod, "relay_task_completion", mock_relay), \
             patch.object(reconciler_mod, "append_task_event", mock_event):
            result = reconcile_lost_tasks(
                max_lost_minutes=120,
                workspace=self.workspace,
                dry_run=False,
            )

        self.assertEqual(result["reconciled_count"], 1)
        self.assertEqual(result["items"][0]["task_id"], "lost-running-1")
        self.assertEqual(result["items"][0]["action"], "marked_lost")
        mock_relay.assert_called_once()

    def test_reconcile_lost_tasks_skips_recent(self):
        _write_task_state(self.workspace, [RECENT_RUNNING_TASK])

        result = reconcile_lost_tasks(
            max_lost_minutes=120,
            workspace=self.workspace,
            dry_run=False,
        )

        self.assertEqual(result["reconciled_count"], 0)

    def test_reconcile_lost_tasks_skips_terminal(self):
        _write_task_state(self.workspace, [TERMINAL_DONE_TASK])

        result = reconcile_lost_tasks(
            max_lost_minutes=120,
            workspace=self.workspace,
            dry_run=False,
        )

        self.assertEqual(result["reconciled_count"], 0)

    def test_reconcile_lost_tasks_dry_run(self):
        _write_task_state(self.workspace, [LOST_RUNNING_TASK])

        with patch("lib.reconciler.relay_task_completion") as mock_relay:
            result = reconcile_lost_tasks(
                max_lost_minutes=120,
                workspace=self.workspace,
                dry_run=True,
            )

        self.assertEqual(result["reconciled_count"], 1)
        self.assertEqual(result["items"][0]["action"], "would_mark_lost")
        mock_relay.assert_not_called()


class ReconcileAllTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_reconcile_all_runs_all_reconcilers(self):
        _write_task_state(self.workspace, [
            STALE_RUNNING_TASK,
            RECENT_RUNNING_TASK,
            TERMINAL_DONE_TASK,
        ])

        with patch("lib.reconciler.relay_task_completion") as mock_relay, \
             patch("lib.reconciler.append_task_event"):
            mock_relay.return_value = {"ok": True}
            result = reconcile_all(
                workspace=self.workspace,
                dry_run=False,
            )

        self.assertIn("stale", result)
        self.assertIn("delivery", result)
        self.assertIn("notification", result)
        self.assertIn("lost", result)
        self.assertIn("total_reconciled", result)
        self.assertIn("errors", result)
        self.assertGreaterEqual(result["total_reconciled"], 1)
        self.assertEqual(
            result["total_reconciled"],
            result["stale"]["reconciled_count"]
            + result["delivery"]["reconciled_count"]
            + result["notification"]["reconciled_count"]
            + result["lost"]["reconciled_count"],
        )


class ErrorsDontBlockOtherItemsTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_errors_dont_block_other_items(self):
        tasks = [
            STALE_RUNNING_TASK,
            {
                "id": "stale-running-2",
                "status": "running",
                "route": "runner",
                "session_key": "sess-test",
                "summary": "another stale task",
                "updated_at": _old_timestamp(60),
                "started_at": _old_timestamp(90),
            },
        ]
        _write_task_state(self.workspace, tasks)

        call_count = [0]

        def flaky_relay(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                raise RuntimeError("transient error on first call")
            return {"ok": True}

        with patch("lib.reconciler.relay_task_completion", side_effect=flaky_relay), \
             patch("lib.reconciler.append_task_event"):
            result = reconcile_stale_tasks(
                max_stale_minutes=30,
                workspace=self.workspace,
                dry_run=False,
            )

        self.assertEqual(result["reconciled_count"], 2)
        self.assertEqual(len(result["errors"]), 0)
        first_result = result["items"][0]["result"]
        second_result = result["items"][1]["result"]
        has_error = first_result.get("ok") is False or second_result.get("ok") is False
        has_success = first_result.get("ok") is True or second_result.get("ok") is True
        self.assertTrue(has_error or has_success)


class ExitCodeTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_exit_code_0_when_nothing_to_reconcile(self):
        _write_task_state(self.workspace, [RECENT_RUNNING_TASK])

        result = subprocess.run(
            [sys.executable, "lib/reconciler.py", "stale", "--workspace", self.workspace],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        self.assertEqual(result.returncode, 0)

    def test_exit_code_2_when_items_reconciled(self):
        _write_task_state(self.workspace, [STALE_RUNNING_TASK])

        result = subprocess.run(
            [sys.executable, "lib/reconciler.py", "stale", "--apply", "--workspace", self.workspace],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        self.assertEqual(result.returncode, 2)


class SchemaVersionTest(unittest.TestCase):
    def test_schema_version(self):
        self.assertEqual(RECONCILER_SCHEMA_VERSION, "octoclaw.reconciler/v1")


if __name__ == "__main__":
    unittest.main()
