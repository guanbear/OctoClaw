#!/usr/bin/env python3
import unittest
from datetime import datetime, timezone

from lib.status_render import (
    build_status_snapshot,
    render_status_lanes,
    render_status_table,
    render_status_text_compact,
)


class StatusRenderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = datetime(2026, 3, 28, 12, 0, 0, tzinfo=timezone.utc)
        self.tasks = [
            {
                "id": "team-parent",
                "label": "octopus-power",
                "status": "running",
                "summary": "spawn_multi running: planner done · review queued",
                "task_description": "Fix and verify the release pipeline",
                "route": "spawn_multi",
                "runtime": "clawteam",
                "executor": "team",
                "task_kind": "team_parent",
                "child_ids": ["step-plan", "step-review"],
                "artifacts": {
                    "step_order": ["planner", "review"],
                    "step_task_ids": {
                        "planner": "step-plan",
                        "review": "step-review",
                    },
                    "operator_hint": "clawteam/tmux octopus-validation",
                },
                "started_at": "2026-03-28T11:55:00+00:00",
            },
            {
                "id": "step-plan",
                "label": "octopus-analyze",
                "status": "done",
                "summary": "planner completed the analysis",
                "task_description": "Break down the failure",
                "route": "spawn_single",
                "runtime": "subagent",
                "executor": "subagent",
                "task_kind": "team_step",
                "parent_id": "team-parent",
                "completed_at": "2026-03-28T11:58:00+00:00",
            },
            {
                "id": "step-review",
                "label": "octopus-test",
                "status": "queued",
                "summary": "review is waiting",
                "task_description": "Verify the final patch",
                "route": "spawn_single",
                "runtime": "subagent",
                "executor": "subagent",
                "task_kind": "team_step",
                "parent_id": "team-parent",
            },
            {
                "id": "single-research",
                "label": "octopus-scout",
                "status": "running",
                "summary": "researching rollback options",
                "task_description": "Research rollback options",
                "route": "spawn_single",
                "runtime": "subagent",
                "executor": "subagent",
                "started_at": "2026-03-28T11:50:00+00:00",
            },
            {
                "id": "runner-1",
                "label": "octopus-runner",
                "status": "queued",
                "summary": "check nginx health",
                "task_description": "Check nginx health",
                "route": "runner",
                "runtime": "runner",
                "executor": "runner",
                "artifacts": {
                    "operator_hint": "tmux octoclaw-runtime:runner",
                },
            },
        ]

    def test_snapshot_groups_lineages_and_removes_team_steps_from_generic_active_lists(self) -> None:
        snapshot = build_status_snapshot(self.tasks, now=self.now)

        self.assertEqual(len(snapshot["active_lineages"]), 1)
        self.assertEqual(snapshot["active_lineages"][0]["parent"]["id"], "team-parent")
        self.assertEqual([task["id"] for task in snapshot["running"]], ["single-research"])
        self.assertEqual([task["id"] for task in snapshot["queued"]], ["runner-1"])
        self.assertNotIn("step-plan", [task["id"] for task in snapshot["running"] + snapshot["queued"]])
        self.assertNotIn("step-review", [task["id"] for task in snapshot["running"] + snapshot["queued"]])
        self.assertNotIn("team-parent", [task["id"] for task in snapshot["running"] + snapshot["queued"]])

    def test_compact_render_shows_lineage_section_and_child_steps(self) -> None:
        snapshot = build_status_snapshot(self.tasks, now=self.now)
        rendered = render_status_text_compact(snapshot)

        self.assertIn("🕸️ 多子任务流程（1个）", rendered)
        self.assertIn("Fix and verify the release pipeline", rendered)
        self.assertIn("planner", rendered)
        self.assertIn("[done", rendered)
        self.assertIn("review", rendered)
        self.assertIn("[queued", rendered)
        self.assertIn("clawteam/tmux", rendered)
        self.assertIn("tmux octoclaw-runtime:runner", rendered)

    def test_table_and_lanes_render_include_team_lane(self) -> None:
        snapshot = build_status_snapshot(self.tasks, now=self.now)
        table_rendered = render_status_table(snapshot)
        lanes_rendered = render_status_lanes(snapshot)

        self.assertIn("team: Fix and verify", table_rendered)
        self.assertIn("↳ planner", table_rendered)
        self.assertIn("Team lane", lanes_rendered)
        self.assertIn("planner", lanes_rendered)
        self.assertIn("review", lanes_rendered)
        self.assertIn("tmux octoclaw-run", lanes_rendered)


if __name__ == "__main__":
    unittest.main()
