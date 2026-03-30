#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

from lib.task_events import (
    SESSION_THREAD_MAP_SCHEMA_VERSION,
    TASK_EVENT_SCHEMA_VERSION,
    append_task_event,
    load_session_thread_map,
    load_task_events,
    register_session_binding,
    resolve_session_binding,
    summarize_task_events,
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


if __name__ == "__main__":
    unittest.main()
