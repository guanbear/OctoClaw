#!/usr/bin/env python3
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

SPEC = importlib.util.spec_from_file_location(
    "task_state_update_module",
    REPO_ROOT / "lib" / "task-state-update.py",
)
task_state_update = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(task_state_update)


class TaskStateAnchorSeedTests(unittest.TestCase):
    def test_should_seed_only_for_new_non_direct_session_tasks(self) -> None:
        self.assertTrue(
            task_state_update._should_seed_task_anchor(
                {
                    "id": "task-1",
                    "session_key": "slack:channel:C123",
                    "status": "dispatched",
                    "route": "spawn_single",
                },
                "",
                {},
            )
        )
        self.assertFalse(
            task_state_update._should_seed_task_anchor(
                {
                    "id": "task-1",
                    "session_key": "slack:channel:C123",
                    "status": "done",
                    "route": "spawn_single",
                },
                "",
                {},
            )
        )
        self.assertFalse(
            task_state_update._should_seed_task_anchor(
                {
                    "id": "task-1",
                    "session_key": "slack:channel:C123",
                    "status": "dispatched",
                    "route": "direct",
                },
                "",
                {},
            )
        )
        self.assertFalse(
            task_state_update._should_seed_task_anchor(
                {
                    "id": "task-1",
                    "session_key": "slack:channel:C123",
                    "status": "dispatched",
                    "route": "spawn_single",
                },
                "queued",
                {},
            )
        )

    def test_seed_task_anchor_persists_message_id(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-anchor-seed-") as tmpdir:
            notify_path = Path(tmpdir) / "patrol-notify-state.json"
            with (
                patch.object(task_state_update, "PATROL_NOTIFY_STATE_FILE", str(notify_path)),
                patch.object(
                    task_state_update,
                    "send_task_notification",
                    return_value={"ok": True, "backend": "slack", "messageId": "m-1", "action": "send"},
                ),
            ):
                result = task_state_update._seed_task_anchor(
                    {
                        "id": "task-1",
                        "session_key": "slack:channel:C123",
                        "status": "dispatched",
                        "route": "spawn_single",
                    },
                    "",
                )

            self.assertTrue(result["ok"])
            saved = json.loads(notify_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["task_anchor_messages"]["task-1"]["message_id"], "m-1")

    def test_seed_task_anchor_skips_when_anchor_already_exists(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-anchor-seed-") as tmpdir:
            notify_path = Path(tmpdir) / "patrol-notify-state.json"
            notify_path.write_text(
                json.dumps({"task_ids": {}, "task_anchor_messages": {"task-1": {"message_id": "old"}}, "updated_at": ""}),
                encoding="utf-8",
            )
            with (
                patch.object(task_state_update, "PATROL_NOTIFY_STATE_FILE", str(notify_path)),
                patch.object(task_state_update, "send_task_notification") as mock_send,
            ):
                result = task_state_update._seed_task_anchor(
                    {
                        "id": "task-1",
                        "session_key": "slack:channel:C123",
                        "status": "dispatched",
                        "route": "spawn_single",
                    },
                    "",
                )

            self.assertFalse(result["ok"])
            self.assertTrue(result["skipped"])
            mock_send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
