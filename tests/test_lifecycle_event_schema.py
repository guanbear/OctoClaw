#!/usr/bin/env python3

from __future__ import annotations

import unittest

try:
    from lib.lifecycle_event_schema import (
        LIFECYCLE_EVENT_SCHEMA_VERSION,
        LIFECYCLE_EVENT_KINDS,
        TERMINAL_TRANSITION_KINDS,
        NATIVE_SYNC_KINDS,
        PROGRESS_KINDS,
        RUNNER_JOB_KINDS,
        MATERIALIZATION_KINDS,
        EVENT_IMPORTANCE,
        now_iso,
        validate_lifecycle_event_kind,
        is_terminal_transition,
        requires_native_sync,
        is_progress_kind,
        event_importance,
        build_lifecycle_event_payload,
    )
except ModuleNotFoundError:
    from lifecycle_event_schema import (
        LIFECYCLE_EVENT_SCHEMA_VERSION,
        LIFECYCLE_EVENT_KINDS,
        TERMINAL_TRANSITION_KINDS,
        NATIVE_SYNC_KINDS,
        PROGRESS_KINDS,
        RUNNER_JOB_KINDS,
        MATERIALIZATION_KINDS,
        EVENT_IMPORTANCE,
        now_iso,
        validate_lifecycle_event_kind,
        is_terminal_transition,
        requires_native_sync,
        is_progress_kind,
        event_importance,
        build_lifecycle_event_payload,
    )


class TestLifecycleEventSchemaConstants(unittest.TestCase):

    def test_schema_version_format(self):
        self.assertEqual(LIFECYCLE_EVENT_SCHEMA_VERSION, "octoclaw.lifecycle_event/v1")

    def test_all_kinds_count(self):
        self.assertEqual(len(LIFECYCLE_EVENT_KINDS), 25)

    def test_kinds_are_frozenset(self):
        self.assertIsInstance(LIFECYCLE_EVENT_KINDS, frozenset)


class TestValidateLifecycleEventKind(unittest.TestCase):

    def test_valid_kinds_recognized(self):
        valid_kinds = [
            "route_selected",
            "dispatch_started",
            "task_started",
            "task_running",
            "task_completed",
            "task_blocked",
            "source_blocked",
            "task_failed",
            "result_ready",
            "handoff_ready",
            "artifact_ready",
            "progress_checkpoint",
            "heartbeat",
            "current_step",
            "last_tool",
            "job_enqueued",
            "job_claimed",
            "job_completed",
            "job_failed",
            "job_timed_out",
            "materialization_succeeded",
            "materialization_failed",
            "native_sync_succeeded",
            "native_sync_failed",
            "dispatch_dedup_hit",
        ]
        for kind in valid_kinds:
            with self.subTest(kind=kind):
                self.assertTrue(validate_lifecycle_event_kind(kind))

    def test_unknown_kind_rejected(self):
        invalid_kinds = ["unknown_event", "task_running_extra", "", "TASK_STARTED"]
        for kind in invalid_kinds:
            with self.subTest(kind=kind):
                self.assertFalse(validate_lifecycle_event_kind(kind))


class TestCategoryMembership(unittest.TestCase):

    def test_terminal_transition_kinds(self):
        expected = ["task_completed", "task_blocked", "source_blocked", "task_failed",
                    "job_completed", "job_failed", "job_timed_out"]
        for kind in expected:
            with self.subTest(kind=kind):
                self.assertTrue(is_terminal_transition(kind))
        self.assertFalse(is_terminal_transition("task_started"))
        self.assertFalse(is_terminal_transition("heartbeat"))

    def test_native_sync_kinds(self):
        expected = ["task_completed", "task_failed"]
        for kind in expected:
            with self.subTest(kind=kind):
                self.assertTrue(requires_native_sync(kind))
        self.assertFalse(requires_native_sync("task_started"))

    def test_progress_kinds(self):
        expected = ["progress_checkpoint", "heartbeat", "current_step", "last_tool"]
        for kind in expected:
            with self.subTest(kind=kind):
                self.assertTrue(is_progress_kind(kind))
        self.assertFalse(is_progress_kind("task_completed"))

    def test_runner_job_kinds(self):
        expected = ["job_enqueued", "job_claimed", "job_completed", "job_failed", "job_timed_out"]
        for kind in expected:
            self.assertIn(kind, RUNNER_JOB_KINDS)

    def test_materialization_kinds(self):
        expected = ["materialization_succeeded", "materialization_failed"]
        for kind in expected:
            self.assertIn(kind, MATERIALIZATION_KINDS)


class TestEventImportance(unittest.TestCase):

    def test_high_importance_kinds(self):
        high_kinds = ["job_timed_out", "task_failed", "task_blocked", "source_blocked",
                      "handoff_ready", "materialization_failed", "native_sync_failed", "dispatch_dedup_hit"]
        for kind in high_kinds:
            with self.subTest(kind=kind):
                self.assertEqual(event_importance(kind), "high")

    def test_normal_importance_kinds(self):
        normal_kinds = ["task_completed", "task_started", "task_running", "result_ready",
                        "artifact_ready", "job_enqueued", "job_claimed", "job_completed",
                        "materialization_succeeded", "native_sync_succeeded", "progress_checkpoint"]
        for kind in normal_kinds:
            with self.subTest(kind=kind):
                self.assertEqual(event_importance(kind), "normal")

    def test_low_importance_kinds(self):
        low_kinds = ["route_selected", "dispatch_started", "heartbeat", "current_step", "last_tool"]
        for kind in low_kinds:
            with self.subTest(kind=kind):
                self.assertEqual(event_importance(kind), "low")

    def test_unknown_kind_defaults_to_normal(self):
        self.assertEqual(event_importance("unknown_event"), "normal")
        self.assertEqual(event_importance(""), "normal")


class TestNowIso(unittest.TestCase):

    def test_now_iso_format(self):
        result = now_iso()
        self.assertIsInstance(result, str)
        self.assertIn("+", result)
        self.assertIn("T", result)


class TestBuildLifecycleEventPayload(unittest.TestCase):

    def setUp(self):
        self.task = {
            "id": "task-123",
            "parent_id": "parent-456",
            "session_key": "slack:channel:C123ABC:thread:T789",
            "route": "helpdesk",
            "worker_pool": "default",
            "status": "running",
            "lifecycle_state": "active",
            "outcome_state": "pending",
            "handoff_state": "none",
        }

    def test_required_fields_present(self):
        payload = build_lifecycle_event_payload(self.task, "task_started")
        required_fields = ["schema_version", "time", "kind", "task_id", "parent_id",
                           "session_key", "route", "worker_pool", "status",
                           "lifecycle_state", "outcome_state", "handoff_state"]
        for field in required_fields:
            with self.subTest(field=field):
                self.assertIn(field, payload)

    def test_schema_version_in_payload(self):
        payload = build_lifecycle_event_payload(self.task, "task_started")
        self.assertEqual(payload["schema_version"], LIFECYCLE_EVENT_SCHEMA_VERSION)

    def test_time_is_iso_format(self):
        payload = build_lifecycle_event_payload(self.task, "task_started")
        self.assertIn("+", payload["time"])
        self.assertIn("T", payload["time"])

    def test_kind_set_correctly(self):
        payload = build_lifecycle_event_payload(self.task, "task_completed")
        self.assertEqual(payload["kind"], "task_completed")

    def test_task_fields_extracted(self):
        payload = build_lifecycle_event_payload(self.task, "task_started")
        self.assertEqual(payload["task_id"], "task-123")
        self.assertEqual(payload["parent_id"], "parent-456")
        self.assertEqual(payload["session_key"], "slack:channel:C123ABC:thread:T789")
        self.assertEqual(payload["route"], "helpdesk")
        self.assertEqual(payload["worker_pool"], "default")
        self.assertEqual(payload["status"], "running")
        self.assertEqual(payload["lifecycle_state"], "active")
        self.assertEqual(payload["outcome_state"], "pending")
        self.assertEqual(payload["handoff_state"], "none")

    def test_extra_kwargs_merged(self):
        payload = build_lifecycle_event_payload(self.task, "task_completed", extra_field="value", count=42)
        self.assertEqual(payload["extra_field"], "value")
        self.assertEqual(payload["count"], 42)

    def test_empty_kwargs_filtered(self):
        payload = build_lifecycle_event_payload(self.task, "task_started", empty_field="", none_field=None)
        self.assertNotIn("empty_field", payload)
        self.assertNotIn("none_field", payload)

    def test_unknown_kind_raises(self):
        with self.assertRaises(ValueError):
            build_lifecycle_event_payload(self.task, "unknown_event")

    def test_empty_task(self):
        payload = build_lifecycle_event_payload({}, "heartbeat")
        self.assertEqual(payload["task_id"], "")
        self.assertEqual(payload["parent_id"], "")
        self.assertEqual(payload["session_key"], "")


if __name__ == "__main__":
    unittest.main()