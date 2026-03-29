#!/usr/bin/env python3
import unittest
from datetime import datetime, timezone

from lib.task_display import (
    build_task_actions,
    build_task_anchor,
    build_task_detail,
    build_task_queue_view,
    render_task_anchor_slack,
    render_task_anchor_text,
)


class TaskDisplayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = datetime(2026, 3, 29, 8, 0, 0, tzinfo=timezone.utc)

    def test_build_task_anchor_from_runner_record(self) -> None:
        anchor = build_task_anchor(
            {
                "id": "runner-1",
                "worker_pool": "octoclaw-runner",
                "status": "running",
                "summary": "check nginx health and collect recent logs",
                "route": "runner",
                "model": "minimax-portal/MiniMax-M2.7",
                "started_at": "2026-03-29T07:58:00+00:00",
            },
            now=self.now,
        )

        self.assertEqual(anchor["task_id"], "runner-1")
        self.assertEqual(anchor["worker_pool"], "octoclaw-runner")
        self.assertEqual(anchor["worker_pool_display"], "飞鱼腿")
        self.assertEqual(anchor["state"], "running")
        self.assertEqual(anchor["route"], "runner")
        self.assertEqual(anchor["active_models"], ["minimax-portal/MiniMax-M2.7"])
        self.assertEqual(anchor["duration"], "2m")

    def test_build_task_actions_supports_text_fallbacks(self) -> None:
        actions = build_task_actions(
            {
                "id": "task-1",
                "worker_pool": "octoclaw-code",
                "status": "running",
                "summary": "patch login flow",
                "route": "spawn_single",
                "report_path": "/tmp/login-report.md",
            }
        )

        fallback_commands = [item["fallback_command"] for item in actions]
        self.assertIn("details", fallback_commands)
        self.assertIn("queue", fallback_commands)
        self.assertIn("stop", fallback_commands)
        self.assertIn("artifacts", fallback_commands)

    def test_build_task_detail_tracks_lineage_and_artifacts(self) -> None:
        parent = {
            "id": "team-parent",
            "worker_pool": "octoclaw-research",
            "status": "running",
            "summary": "coordinating multi-step research",
            "task_description": "Research OpenClaw recent news",
            "route": "spawn_multi",
            "artifacts": {
                "report_path": "/tmp/parent-report.md",
                "step_task_ids": {"planner": "child-1", "review": "child-2"},
            },
        }
        children = [
            {
                "id": "child-1",
                "parent_id": "team-parent",
                "worker_pool": "octoclaw-research",
                "status": "done",
                "summary": "gathered sources",
                "route": "spawn_single",
            },
            {
                "id": "child-2",
                "parent_id": "team-parent",
                "worker_pool": "octoclaw-review",
                "status": "running",
                "summary": "reviewing the draft",
                "route": "spawn_single",
            },
        ]

        detail = build_task_detail(parent, all_tasks=[parent, *children], now=self.now)

        self.assertEqual(detail["lineage"]["parent_task_id"], "")
        self.assertEqual(detail["lineage"]["child_task_ids"], ["child-1", "child-2"])
        self.assertEqual(detail["lineage"]["active_child_count"], 1)
        self.assertEqual(detail["lineage"]["completed_child_count"], 1)
        self.assertEqual(detail["artifacts"][0]["path"], "/tmp/parent-report.md")

    def test_render_task_anchor_text_includes_commands(self) -> None:
        anchor = build_task_anchor(
            {
                "id": "research-1",
                "worker_pool": "octoclaw-research",
                "status": "queued",
                "summary": "research OpenClaw changelog and news",
                "route": "spawn_single",
                "model": "omniroute/cx/gpt-5.4",
            },
            now=self.now,
        )
        actions = build_task_actions(
            {
                "id": "research-1",
                "worker_pool": "octoclaw-research",
                "status": "queued",
                "summary": "research OpenClaw changelog and news",
                "route": "spawn_single",
                "model": "omniroute/cx/gpt-5.4",
            }
        )
        rendered = render_task_anchor_text(anchor, actions)

        self.assertIn("OctoClaw task", rendered)
        self.assertIn("Route: spawn_single", rendered)
        self.assertIn("Reply with:", rendered)
        self.assertIn("details", rendered)
        self.assertIn("stop", rendered)

    def test_render_task_anchor_slack_returns_blocks(self) -> None:
        anchor = build_task_anchor(
            {
                "id": "code-1",
                "worker_pool": "octoclaw-code",
                "status": "running",
                "summary": "fix login 401 and add tests",
                "route": "spawn_single",
                "model": "omniroute/cx/gpt-5.4",
            },
            now=self.now,
        )
        actions = build_task_actions(
            {
                "id": "code-1",
                "worker_pool": "octoclaw-code",
                "status": "running",
                "summary": "fix login 401 and add tests",
                "route": "spawn_single",
                "model": "omniroute/cx/gpt-5.4",
            }
        )
        payload = render_task_anchor_slack(anchor, actions)

        self.assertIn("text", payload)
        self.assertIn("blocks", payload)
        self.assertTrue(any(block.get("type") == "actions" for block in payload["blocks"]))
        self.assertIn("fix login 401", payload["text"])

    def test_build_task_queue_view_groups_states(self) -> None:
        queue = build_task_queue_view(
            [
                {"id": "a", "worker_pool": "octoclaw-runner", "status": "running", "summary": "check port", "route": "runner"},
                {"id": "b", "worker_pool": "octoclaw-code", "status": "queued", "summary": "patch code", "route": "spawn_single"},
                {"id": "c", "worker_pool": "octoclaw-review", "status": "blocked", "summary": "waiting approval", "route": "spawn_single"},
                {"id": "d", "worker_pool": "octoclaw-research", "status": "done", "summary": "finished report", "route": "spawn_single"},
            ],
            now=self.now,
        )

        self.assertEqual([item["task_id"] for item in queue["running"]], ["a"])
        self.assertEqual([item["task_id"] for item in queue["queued"]], ["b"])
        self.assertEqual([item["task_id"] for item in queue["blocked"]], ["c"])
        self.assertEqual([item["task_id"] for item in queue["recently_completed"]], ["d"])


if __name__ == "__main__":
    unittest.main()
