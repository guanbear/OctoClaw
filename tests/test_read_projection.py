#!/usr/bin/env python3
import json
import os
import tempfile
import unittest

from lib.read_projection import (
    READ_PROJECTION_SCHEMA_VERSION,
    read_active_tasks,
    read_queue_snapshot,
    read_task,
    read_task_with_lineage,
    read_tasks,
)


SAMPLE_TASKS = [
    {
        "id": "task-1",
        "status": "running",
        "route": "runner",
        "session_key": "sess-alpha",
        "dispatch_key": "dispatch-1",
        "lane_key": "lane-1",
        "capacity_group": "default",
        "task_kind": "ops",
        "parent_id": "",
        "summary": "running task",
    },
    {
        "id": "task-2",
        "status": "done",
        "route": "spawn_single",
        "session_key": "sess-beta",
        "dispatch_key": "dispatch-2",
        "lane_key": "lane-2",
        "capacity_group": "heavy",
        "task_kind": "code",
        "parent_id": "task-1",
        "summary": "done task",
        "completed_at": "2026-04-14T00:00:00+00:00",
    },
    {
        "id": "task-3",
        "status": "queued",
        "route": "direct",
        "session_key": "sess-alpha",
        "dispatch_key": "dispatch-3",
        "lane_key": "lane-1",
        "capacity_group": "default",
        "task_kind": "research",
        "parent_id": "",
        "summary": "queued task",
    },
    {
        "id": "task-4",
        "status": "failed",
        "route": "runner",
        "session_key": "sess-gamma",
        "dispatch_key": "dispatch-4",
        "lane_key": "lane-3",
        "capacity_group": "fast",
        "task_kind": "ops",
        "parent_id": "task-1",
        "summary": "failed task",
    },
    {
        "id": "task-5",
        "status": "cancelled",
        "route": "direct",
        "session_key": "sess-alpha",
        "summary": "cancelled task",
    },
]

SAMPLE_QUEUE = {
    "jobs": [
        {"id": "j-1", "status": "queued", "capacity_group": "default"},
        {"id": "j-2", "status": "queued", "capacity_group": "default"},
        {"id": "j-3", "status": "running", "capacity_group": "heavy"},
        {"id": "j-4", "status": "done", "capacity_group": "default"},
        {"id": "j-5", "status": "failed", "capacity_group": "fast"},
    ],
    "updated_at": "2026-04-14T00:00:00+00:00",
}


def _write_task_state(workspace: str, tasks: list) -> None:
    path = os.path.join(workspace, "tmp", "octopus", "task-state.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"tasks": tasks, "updated_at": "2026-04-14T00:00:00+00:00"}, f)


def _write_runner_queue(workspace: str, data: dict) -> None:
    path = os.path.join(workspace, "tmp", "octopus", "runner-queue.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


class ReadProjectionTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name
        _write_task_state(self.workspace, SAMPLE_TASKS)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_read_task_found(self):
        result = read_task("task-1", workspace=self.workspace)
        self.assertIsNotNone(result)
        self.assertEqual(result["id"], "task-1")

    def test_read_task_not_found(self):
        result = read_task("nonexistent", workspace=self.workspace)
        self.assertIsNone(result)

    def test_read_tasks_no_filter_returns_all(self):
        results = read_tasks(workspace=self.workspace)
        ids = [r["id"] for r in results]
        self.assertEqual(len(ids), 5)
        self.assertIn("task-1", ids)

    def test_read_tasks_filter_by_status(self):
        results = read_tasks(filters={"status": "running"}, workspace=self.workspace)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["id"], "task-1")

    def test_read_tasks_filter_by_session_key(self):
        results = read_tasks(filters={"session_key": "sess-alpha"}, workspace=self.workspace)
        self.assertEqual(len(results), 3)
        self.assertTrue(all(r["session_key"] == "sess-alpha" for r in results))

    def test_read_tasks_filter_by_dispatch_key(self):
        results = read_tasks(filters={"dispatch_key": "dispatch-2"}, workspace=self.workspace)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["id"], "task-2")

    def test_read_tasks_multiple_filters(self):
        results = read_tasks(
            filters={"session_key": "sess-alpha", "route": "direct"},
            workspace=self.workspace,
        )
        ids = [r["id"] for r in results]
        self.assertIn("task-3", ids)
        self.assertIn("task-5", ids)
        self.assertNotIn("task-1", ids)

    def test_read_active_tasks_excludes_terminal(self):
        results = read_active_tasks(workspace=self.workspace)
        ids = [r["id"] for r in results]
        self.assertNotIn("task-2", ids)
        self.assertNotIn("task-4", ids)
        self.assertNotIn("task-5", ids)

    def test_read_active_tasks_filters_by_session_key(self):
        results = read_active_tasks(session_key="sess-alpha", workspace=self.workspace)
        ids = [r["id"] for r in results]
        self.assertIn("task-1", ids)
        self.assertIn("task-3", ids)
        self.assertNotIn("task-2", ids)

    def test_read_task_with_lineage_includes_children(self):
        result = read_task_with_lineage("task-1", workspace=self.workspace)
        child_ids = [c["id"] for c in result["children"]]
        self.assertIn("task-2", child_ids)
        self.assertIn("task-4", child_ids)

    def test_read_task_with_lineage_includes_parent(self):
        result = read_task_with_lineage("task-2", workspace=self.workspace)
        self.assertIsNotNone(result["parent"])
        self.assertEqual(result["parent"]["id"], "task-1")

    def test_read_task_with_lineage_not_found(self):
        result = read_task_with_lineage("nonexistent", workspace=self.workspace)
        self.assertIsNone(result["task"])
        self.assertEqual(result["children"], [])
        self.assertIsNone(result["parent"])

    def test_read_queue_snapshot(self):
        _write_runner_queue(self.workspace, SAMPLE_QUEUE)
        snapshot = read_queue_snapshot(workspace=self.workspace)
        self.assertEqual(snapshot["queued"], 2)
        self.assertEqual(snapshot["running"], 1)
        self.assertEqual(snapshot["done"], 1)
        self.assertEqual(snapshot["failed"], 1)
        self.assertEqual(snapshot["total"], 5)
        self.assertIn("capacity_groups", snapshot)

    def test_read_queue_snapshot_empty_file(self):
        path = os.path.join(self.workspace, "tmp", "octopus", "runner-queue.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("")
        snapshot = read_queue_snapshot(workspace=self.workspace)
        self.assertEqual(snapshot["queued"], 0)
        self.assertEqual(snapshot["running"], 0)
        self.assertEqual(snapshot["done"], 0)
        self.assertEqual(snapshot["failed"], 0)
        self.assertEqual(snapshot["total"], 0)


if __name__ == "__main__":
    unittest.main()
