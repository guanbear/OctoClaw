#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

from lib.task_events import (
    SESSION_THREAD_MAP_SCHEMA_VERSION,
    TASK_EVENT_SCHEMA_VERSION,
    _fallback_route_from_session_key,
    append_task_event,
    load_session_thread_map,
    load_task_events,
    register_session_binding,
    resolve_session_binding,
    summarize_task_events,
    task_event_payload,
    task_event_snapshot,
)


class TaskEventsTests(unittest.TestCase):
    def test_append_task_event_writes_event_log(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-task-events-") as tmpdir:
            events_path = Path(tmpdir) / "task-events.jsonl"
            payload = append_task_event(
                {
                    "id": "research-1",
                    "session_key": "agent:main:slack:channel:C123:thread:1712345.000100",
                    "route": "spawn_single",
                    "worker_pool": "octoclaw-research",
                    "status": "blocked",
                    "lifecycle_state": "finished",
                    "outcome_state": "blocked",
                    "handoff_state": "user_safe_ready",
                    "summary": "Evidence boundary summary ready",
                },
                "handoff_ready",
                message="safe blocked explanation ready",
                path=str(events_path),
            )

            self.assertEqual(payload["schema_version"], TASK_EVENT_SCHEMA_VERSION)
            self.assertEqual(payload["kind"], "handoff_ready")
            self.assertEqual(payload["session_thread_key"], "slack:channel:C123:1712345.000100")

            events = load_task_events(str(events_path))
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["task_id"], "research-1")
            summary = summarize_task_events(events)
            self.assertEqual(summary["task_event_count"], 1)
            self.assertEqual(summary["session_count"], 1)
            self.assertEqual(summary["thread_count"], 1)
            snapshot = task_event_snapshot("research-1", path=str(events_path))
            self.assertEqual(snapshot["task_event_count"], 1)
            self.assertEqual(snapshot["latest_kind"], "handoff_ready")
            self.assertEqual(snapshot["preview"][0]["importance"], "high")

    def test_register_session_binding_persists_thread_index(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-map-") as tmpdir:
            mapping_path = Path(tmpdir) / "session-thread-map.json"
            binding = register_session_binding(
                "agent:main:slack:channel:C123:thread:1712345.000100",
                {
                    "ok": True,
                    "origin": "slack",
                    "target": "channel:C123",
                    "thread_id": "1712345.000100",
                },
                task={"id": "task-1", "route": "spawn_single", "worker_pool": "octoclaw-code"},
                source="anchor_send",
                message_id="m-1",
                action="send",
                path=str(mapping_path),
            )

            self.assertEqual(binding["thread_key"], "slack:channel:C123:1712345.000100")
            payload = load_session_thread_map(str(mapping_path))
            self.assertEqual(payload["schema_version"], SESSION_THREAD_MAP_SCHEMA_VERSION)
            self.assertIn("agent:main:slack:channel:C123:thread:1712345.000100", payload["bindings"])
            self.assertIn("slack:channel:C123:1712345.000100", payload["threads"])
            self.assertEqual(payload["threads"]["slack:channel:C123:1712345.000100"]["message_id"], "m-1")

    def test_resolve_session_binding_reuses_latest_active_thread_for_same_binding_key(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-session-map-") as tmpdir:
            mapping_path = Path(tmpdir) / "session-thread-map.json"
            register_session_binding(
                "agent:main:slack:channel:C123:thread:1712345.000100",
                {
                    "ok": True,
                    "origin": "slack",
                    "target": "channel:C123",
                    "thread_id": "1712345.000100",
                },
                task={"id": "task-1", "route": "spawn_single", "worker_pool": "octoclaw-code"},
                source="anchor_send",
                message_id="m-1",
                action="send",
                path=str(mapping_path),
            )

            resolved = resolve_session_binding(
                "agent:main:slack:channel:C123",
                path=str(mapping_path),
            )

            self.assertEqual(resolved["target"], "channel:C123")
            self.assertEqual(resolved["thread_id"], "1712345.000100")
            self.assertEqual(resolved["last_message_id"], "m-1")

    def test_fallback_route_uppercases_slack_user_id(self) -> None:
        route = _fallback_route_from_session_key("agent:main:slack:default:direct:u0al9t5u89z")
        self.assertEqual(route["origin"], "slack")
        self.assertEqual(route["target"], "user:U0AL9T5U89Z")

    def test_fallback_route_uppercases_slack_channel_id(self) -> None:
        route = _fallback_route_from_session_key("agent:main:slack:channel:c1a2b3c4d")
        self.assertEqual(route["origin"], "slack")
        self.assertEqual(route["target"], "channel:C1A2B3C4D")

    def test_fallback_route_does_not_uppercase_non_slack_ids(self) -> None:
        route = _fallback_route_from_session_key("agent:main:discord:channel:123456")
        self.assertEqual(route["origin"], "discord")
        self.assertEqual(route["target"], "channel:123456")

    def test_task_event_payload_persists_ack_fields_from_task_and_extra(self) -> None:
        payload = task_event_payload(
            {
                "id": "task-ack-1",
                "session_key": "agent:main:slack:channel:C123:thread:1712345.000100",
                "ack_owner": "timer_ack",
                "ack_kind": "pre_dispatch",
            },
            "delivery_sent",
            extra={
                "ack_mode": "channel_message",
                "ack_target_resolution_state": "resolved",
                "ack_delivery_state": "skipped",
            },
        )

        self.assertEqual(payload["ack_owner"], "timer_ack")
        self.assertEqual(payload["ack_kind"], "pre_dispatch")
        self.assertEqual(payload["ack_mode"], "channel_message")
        self.assertEqual(payload["ack_target_resolution_state"], "resolved")
        self.assertEqual(payload["ack_delivery_state"], "skipped")


if __name__ == "__main__":
    unittest.main()
