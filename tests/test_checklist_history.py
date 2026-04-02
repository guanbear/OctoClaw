#!/usr/bin/env python3
import tempfile
import unittest

from lib.checklist_history import append_checklist_event, load_checklist_history


class ChecklistHistoryTests(unittest.TestCase):
    def test_append_and_load_checklist_history_dedupes_identical_events(self) -> None:
        snapshot = {
            "kind": "explicit",
            "items": [{"id": "read", "title": "Read sources", "state": "done", "source": "test"}],
            "open_count": 0,
            "completed_count": 1,
        }
        with tempfile.TemporaryDirectory(prefix="octoclaw-checklist-history-") as tmpdir:
            first = append_checklist_event("task-1", "snapshot", "", "", "", "task_dispatch", tmpdir, snapshot=snapshot)
            second = append_checklist_event("task-1", "snapshot", "", "", "", "task_dispatch", tmpdir, snapshot=snapshot)
            events = load_checklist_history("task-1", tmpdir)

        self.assertEqual(first["event_key"], second["event_key"])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["snapshot"]["items"][0]["state"], "done")


if __name__ == "__main__":
    unittest.main()
