#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

from lib.checklist_history import load_checklist_history
from lib.checklist_middleware import on_agent_message, on_task_dispatch, on_task_recovery


class ChecklistMiddlewareTests(unittest.TestCase):
    def test_on_task_dispatch_snapshots_current_checklist_once(self) -> None:
        task_record = {
            "id": "task-1",
            "updated_at": "2026-04-02T00:00:00+00:00",
            "checklist": {
                "kind": "explicit",
                "items": [{"id": "read", "title": "Read sources", "state": "pending"}],
            },
        }
        with tempfile.TemporaryDirectory(prefix="octoclaw-checklist-middleware-") as tmpdir:
            snapshot = on_task_dispatch(task_record, tmpdir)
            snapshot_again = on_task_dispatch(task_record, tmpdir)
            history = load_checklist_history("task-1", tmpdir)

        self.assertEqual(snapshot["items"][0]["id"], "read")
        self.assertEqual(snapshot_again["items"][0]["id"], "read")
        self.assertEqual([event["event_type"] for event in history], ["snapshot"])

    def test_on_agent_message_applies_add_done_and_block_idempotently(self) -> None:
        task_record = {
            "id": "task-1",
            "updated_at": "2026-04-02T00:00:00+00:00",
            "checklist": {
                "kind": "explicit",
                "items": [{"id": "read", "title": "Read sources", "state": "pending"}],
            },
        }
        with tempfile.TemporaryDirectory(prefix="octoclaw-checklist-middleware-") as tmpdir:
            on_task_dispatch(task_record, tmpdir)
            first = on_agent_message("task-1", "[ADD: Draft summary] [DONE: read] [BLOCK: draft-summary waiting-on-review]", tmpdir)
            second = on_agent_message("task-1", "[ADD: Draft summary] [DONE: read] [BLOCK: draft-summary waiting-on-review]", tmpdir)

            store_path = Path(tmpdir) / "tmp" / "octopus" / "task-checklists.json"
            payload = json.loads(store_path.read_text(encoding="utf-8"))
            snapshot = payload["tasks"]["task-1"]
            history = load_checklist_history("task-1", tmpdir)

        item_by_id = {item["id"]: item for item in snapshot["items"]}
        self.assertEqual(first["applied"], 3)
        self.assertEqual(second["applied"], 0)
        self.assertEqual(item_by_id["read"]["state"], "done")
        self.assertEqual(item_by_id["draft-summary"]["state"], "blocked")
        self.assertEqual(item_by_id["draft-summary"]["blocked_reason"], "waiting-on-review")
        self.assertIn("item_added", [event["event_type"] for event in history])
        self.assertIn("item_done", [event["event_type"] for event in history])
        self.assertIn("item_blocked", [event["event_type"] for event in history])

    def test_on_task_recovery_merges_latest_snapshot_back_into_store(self) -> None:
        task_record = {
            "id": "task-1",
            "updated_at": "2026-04-02T00:00:00+00:00",
            "checklist": {
                "kind": "explicit",
                "items": [{"id": "read", "title": "Read sources", "state": "pending"}],
            },
        }
        with tempfile.TemporaryDirectory(prefix="octoclaw-checklist-middleware-") as tmpdir:
            on_task_dispatch(task_record, tmpdir)
            on_agent_message("task-1", "[ADD: Draft summary] [DONE: read] [BLOCK: draft-summary waiting-on-review]", tmpdir)

            store_path = Path(tmpdir) / "tmp" / "octopus" / "task-checklists.json"
            store = json.loads(store_path.read_text(encoding="utf-8"))
            store["tasks"]["task-1"] = {
                "kind": "explicit",
                "items": [{"id": "read", "title": "Read sources", "state": "pending", "source": "manual"}],
                "open_count": 1,
                "completed_count": 0,
                "updated_at": "2026-04-02T01:00:00+00:00",
            }
            store_path.write_text(json.dumps(store, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

            recovered = on_task_recovery("task-1", tmpdir)

        item_by_id = {item["id"]: item for item in recovered["items"]}
        self.assertEqual(item_by_id["read"]["state"], "done")
        self.assertEqual(item_by_id["draft-summary"]["state"], "blocked")


if __name__ == "__main__":
    unittest.main()
