#!/usr/bin/env python3
"""Serialize per-parent notifications for spawn_multi/team_parent tasks.

When multiple children complete, we batch notifications to the parent
instead of sending N separate messages.
"""

from __future__ import annotations

import fcntl
import json
import os
from datetime import datetime, timezone

NOTIFICATION_SERIALIZER_SCHEMA_VERSION = "octoclaw.notification_serializer/v1"

_default_serializer: NotificationSerializer | None = None


class NotificationSerializer:
    def __init__(self, workspace: str = ""):
        self.workspace = workspace or os.environ.get("WORKSPACE", "/workspace")
        self.state_path = os.path.join(self.workspace, "tmp", "octopus", "notification-serializer-state.json")
        self._lock_path = self.state_path + ".lock"

    def should_serialize_notification(self, task: dict, parent_id: str = "") -> bool:
        """Check if this notification should be serialized (deferred to batch)."""
        group_key = self._notification_group_key(task, parent_id)
        if not group_key:
            return False
        state = self._load_state()
        group = state.get(group_key, {})
        pending = group.get("pending_children", [])
        return len(pending) > 0  # Serialize if there are pending siblings

    def register_pending_child(self, parent_id: str, child_id: str, total_expected: int = 0) -> None:
        """Register a child task that will eventually need notification."""
        with self._with_lock():
            state = self._load_state()
            group_key = f"parent:{parent_id}"
            if group_key not in state:
                state[group_key] = {"pending_children": [], "notified_children": [], "total_expected": 0, "last_notification_at": ""}
            if child_id not in state[group_key]["pending_children"]:
                state[group_key]["pending_children"].append(child_id)
            if total_expected > 0:
                state[group_key]["total_expected"] = total_expected
            self._save_state(state)

    def record_child_notification_sent(self, parent_id: str, child_id: str) -> None:
        """Track that a child's notification has been sent."""
        with self._with_lock():
            state = self._load_state()
            group_key = f"parent:{parent_id}"
            if group_key not in state:
                return
            if child_id not in state[group_key]["notified_children"]:
                state[group_key]["notified_children"].append(child_id)
            if child_id in state[group_key]["pending_children"]:
                state[group_key]["pending_children"].remove(child_id)
            state[group_key]["last_notification_at"] = datetime.now(timezone.utc).isoformat()
            self._save_state(state)

    def flush_parent_notification(self, parent_id: str) -> dict | None:
        """If all children complete, return consolidated notification payload."""
        state = self._load_state()
        group_key = f"parent:{parent_id}"
        if group_key not in state:
            return None
        group = state[group_key]
        total = group.get("total_expected", 0)
        notified = group.get("notified_children", [])
        if total > 0 and len(notified) >= total:
            return {
                "parent_id": parent_id,
                "total_children": total,
                "notified_children": notified,
                "status": "all_children_notified",
            }
        return None

    def _notification_group_key(self, task: dict, parent_id: str = "") -> str:
        """Derive notification group key from task."""
        pid = parent_id or (task.get("parent_id") if isinstance(task, dict) else "")
        if not pid:
            return ""
        task_kind = str(task.get("task_kind", "") if isinstance(task, dict) else "")
        # Short term: only serialize for team_parent
        if task_kind == "team_parent":
            return f"parent:{pid}"
        return ""

    def _with_lock(self):
        """Context manager: hold exclusive lock file across read-modify-write."""
        import contextlib

        @contextlib.contextmanager
        def _lock():
            os.makedirs(os.path.dirname(self._lock_path), exist_ok=True)
            lock_fd = open(self._lock_path, "w")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            try:
                yield lock_fd
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                lock_fd.close()

        return _lock()

    def _load_state(self) -> dict:
        """Load state from JSON file."""
        path = self.state_path
        if not os.path.exists(path):
            return {}
        try:
            with open(path, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}

    def _save_state(self, state: dict) -> None:
        """Save state to JSON file."""
        path = self.state_path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
            f.flush()


def get_notification_serializer(workspace: str = "") -> NotificationSerializer:
    """Singleton-like factory for NotificationSerializer."""
    global _default_serializer
    if _default_serializer is None:
        _default_serializer = NotificationSerializer(workspace)
    return _default_serializer
