#!/usr/bin/env python3
import unittest
from datetime import datetime, timezone

from lib.status_render import (
    build_status_snapshot,
    render_main_model_drift_summary,
    render_model_health_summary,
    render_status_task_anchors,
    render_status_lanes,
    render_status_table,
    render_status_text_compact,
    summarize_model_health,
)


class StatusRenderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = datetime(2026, 3, 28, 12, 0, 0, tzinfo=timezone.utc)
        self.tasks = [
            {
                "id": "team-parent",
                "worker_pool": "octoclaw-research",
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
                "worker_pool": "octoclaw-research",
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
                "worker_pool": "octoclaw-review",
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
                "worker_pool": "octoclaw-research",
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
                "worker_pool": "octoclaw-runner",
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

    def test_worker_pool_only_tasks_render_without_legacy_labels(self) -> None:
        tasks = [
            {
                "id": "runner-pool",
                "status": "queued",
                "summary": "check nginx port",
                "task_description": "Check nginx port",
                "route": "runner",
                "runtime": "runner",
                "executor": "runner",
                "worker_pool": "octoclaw-runner",
            },
            {
                "id": "code-pool",
                "status": "running",
                "summary": "patch the flaky release step",
                "task_description": "Patch the flaky release step",
                "route": "spawn_single",
                "runtime": "subagent",
                "executor": "subagent",
                "worker_pool": "octoclaw-code",
                "started_at": "2026-03-28T11:55:00+00:00",
            },
            {
                "id": "research-pool",
                "status": "queued",
                "summary": "compare rollback options",
                "task_description": "Compare rollback options",
                "route": "spawn_single",
                "runtime": "subagent",
                "executor": "subagent",
                "worker_pool": "octoclaw-research",
            },
        ]

        snapshot = build_status_snapshot(tasks, now=self.now)
        table_rendered = render_status_table(snapshot)
        lanes_rendered = render_status_lanes(snapshot)

        self.assertIn("飞鱼腿", table_rendered)
        self.assertIn("螃蟹手", table_rendered)
        self.assertIn("梭鱼眼", table_rendered)
        self.assertIn("check nginx port", lanes_rendered)
        self.assertIn("patch the flaky release", lanes_rendered)
        self.assertIn("compare rollback options", lanes_rendered)

    def test_model_health_summary_renders_cooldown_and_quota_highlights(self) -> None:
        summary = summarize_model_health(
            {
                "models": {
                    "omniroute/cx/gpt-5.4": {
                        "state": "healthy",
                        "quota_pressure": "critical",
                    },
                    "zhipu/GLM-5.1": {
                        "state": "cooldown",
                        "quota_pressure": "high",
                        "last_degraded_at": "2026-03-28T10:00:00Z",
                        "recent_429_count": 2,
                    },
                    "minimax-portal/MiniMax-M2.7": {
                        "state": "degraded",
                    },
                }
            }
        )

        self.assertEqual(summary["cooldown_count"], 1)
        self.assertEqual(summary["degraded_count"], 1)
        self.assertEqual(summary["quota_high_count"], 1)
        self.assertEqual(summary["quota_critical_count"], 1)

        rendered = "\n".join(render_model_health_summary(summary))
        self.assertIn("cooldown 1", rendered)
        self.assertIn("quota high/critical 1/1", rendered)
        self.assertIn("zhipu/GLM-5.1 cooldown quota:high", rendered)

    def test_task_anchor_render_outputs_text_fallback_anchors(self) -> None:
        snapshot = build_status_snapshot(self.tasks, now=self.now)
        rendered = render_status_task_anchors(snapshot)

        self.assertIn("八爪鱼（OctoClaw）任务锚点", rendered)
        self.assertIn("OctoClaw task", rendered)
        self.assertIn("Fix and verify the release pipeline", rendered)
        self.assertIn("Reply with:", rendered)
        self.assertIn("details", rendered)
        self.assertIn("queue", rendered)

    def test_main_model_drift_summary_renders_aligned_and_drifted_states(self) -> None:
        aligned = render_main_model_drift_summary(
            {
                "enabled": True,
                "drift": False,
                "reason": "aligned",
                "expected_model": "omniroute/cx/gpt-5.4",
            }
        )
        drifted = render_main_model_drift_summary(
            {
                "enabled": True,
                "drift": True,
                "reason": "drift_detected",
                "expected_model": "omniroute/cx/gpt-5.4",
                "current_override": "zhipu/GLM-5.1",
            }
        )

        self.assertEqual(aligned, ["🧭 主链漂移：aligned · omniroute/cx/gpt-5.4"])
        self.assertEqual(
            drifted,
            ["🧭 主链漂移：detected · expected omniroute/cx/gpt-5.4 · actual zhipu/GLM-5.1"],
        )


if __name__ == "__main__":
    unittest.main()
