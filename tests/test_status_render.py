#!/usr/bin/env python3
import unittest
from datetime import datetime, timezone

from lib.status_render import (
    build_status_snapshot,
    render_main_model_drift_summary,
    render_model_health_summary,
    render_status_task_anchors,
    render_status_lanes,
    render_taskflow_substrate_summary,
    render_status_table,
    render_status_text_compact,
    summarize_taskflow_substrate,
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
                "openclaw_taskflow": {
                    "backend": "mirror",
                    "binding_state": "mirrored_bound",
                    "native_binding_state": "bound",
                    "native_status": "running",
                    "native_runtime": "subagent",
                },
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
                "openclaw_taskflow": {
                    "backend": "mirror",
                    "binding_state": "mirrored",
                },
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

        self.assertIn("🐙 八爪鱼（OctoClaw）任务收件箱", rendered)
        self.assertIn("🧩 Substrate：tracked 2 · mirrored 2 · native bound 1 · native active 1 · handoff ready/delivered 0/0", rendered)
        self.assertIn("🕸️ 协作流程（1个）", rendered)
        self.assertIn("Fix and verify the release pipeline", rendered)
        self.assertIn("子步骤：planner(done) · review(queued)", rendered)
        self.assertIn("🔵 运行中（1个）", rendered)
        self.assertIn("⏸️ 排队中（1个）", rendered)
        self.assertIn("Reply with:", rendered)
        self.assertIn("details team-parent", rendered)
        self.assertIn("stop single-research", rendered)

    def test_table_and_lanes_render_include_team_lane(self) -> None:
        snapshot = build_status_snapshot(self.tasks, now=self.now)
        table_rendered = render_status_table(snapshot)
        lanes_rendered = render_status_lanes(snapshot)

        self.assertIn("team: Fix and verify", table_rendered)
        self.assertIn("↳ planner", table_rendered)
        self.assertIn("Team lane", lanes_rendered)
        self.assertIn("planner", lanes_rendered)
        self.assertIn("review", lanes_rendered)
        self.assertIn("clawteam/tmux", lanes_rendered)

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

        self.assertIn("Runner", table_rendered)
        self.assertIn("Code", table_rendered)
        self.assertIn("Research", table_rendered)
        self.assertIn("check nginx port", lanes_rendered)
        self.assertIn("patch the flaky release", lanes_rendered)
        self.assertIn("compare rollback options", lanes_rendered)

    def test_compact_render_deprioritizes_system_maintenance_tasks(self) -> None:
        tasks = [
            {
                "id": "user-task",
                "worker_pool": "octoclaw-research",
                "status": "done",
                "summary": "整理 OpenClaw 最近更新并写简报",
                "task_description": "整理 OpenClaw 最近更新并写简报",
                "route": "spawn_single",
                "runtime": "subagent",
                "executor": "subagent",
                "session_key": "agent:main:slack:channel:C1:thread:1",
                "completed_at": "2026-03-28T11:58:00+00:00",
            },
            {
                "id": "system-task",
                "worker_pool": "octoclaw-runner",
                "status": "done",
                "summary": "同步 Omniroute 套餐状态并刷新 OctoClaw 自动选模策略",
                "task_description": "同步 Omniroute 套餐状态并刷新 OctoClaw 自动选模策略",
                "route": "runner",
                "runtime": "runner",
                "executor": "runner",
                "completed_at": "2026-03-28T11:59:00+00:00",
            },
        ]

        snapshot = build_status_snapshot(tasks, now=self.now)
        rendered = render_status_text_compact(snapshot)

        self.assertIn("✅ 最近完成（1个）", rendered)
        self.assertIn("整理 OpenClaw 最近更新并写简报", rendered)
        self.assertIn("⚙️ 系统维护（1个）", rendered)
        self.assertIn("同步 Omniroute 套餐状态并刷新 OctoClaw 自动选模策略", rendered)

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

    def test_taskflow_substrate_summary_counts_bound_active_and_delivered_tasks(self) -> None:
        summary = summarize_taskflow_substrate(
            [
                {
                    "id": "bound-running",
                    "openclaw_taskflow": {
                        "binding_state": "mirrored_bound",
                        "native_binding_state": "bound",
                        "native_status": "running",
                    },
                },
                {
                    "id": "delivered-done",
                    "openclaw_taskflow": {
                        "binding_state": "mirrored_bound",
                        "native_binding_state": "bound",
                        "native_status": "done",
                    },
                    "handoff_state": "delivered",
                },
                {
                    "id": "mirror-only",
                    "openclaw_taskflow": {
                        "binding_state": "mirrored",
                    },
                    "handoff_state": "user_safe_ready",
                },
            ]
        )

        self.assertEqual(summary["tracked"], 3)
        self.assertEqual(summary["mirrored"], 3)
        self.assertEqual(summary["native_bound"], 2)
        self.assertEqual(summary["native_active"], 1)
        self.assertEqual(summary["handoff_ready"], 1)
        self.assertEqual(summary["delivered"], 1)

        rendered = render_taskflow_substrate_summary(summary)
        self.assertIn("tracked 3", rendered)
        self.assertIn("native bound 2", rendered)
        self.assertIn("native active 1", rendered)
        self.assertIn("handoff ready/delivered 1/1", rendered)

    def test_task_anchor_render_outputs_text_fallback_anchors(self) -> None:
        snapshot = build_status_snapshot(self.tasks, now=self.now)
        rendered = render_status_task_anchors(snapshot)

        self.assertIn("八爪鱼（OctoClaw）任务锚点", rendered)
        self.assertIn("OctoClaw task", rendered)
        self.assertIn("Fix and verify the release pipeline", rendered)
        self.assertIn("Reply with:", rendered)
        self.assertIn("details", rendered)
        self.assertIn("queue", rendered)

    def test_compact_render_shows_empty_sections_when_idle(self) -> None:
        snapshot = build_status_snapshot([], now=self.now)
        rendered = render_status_text_compact(snapshot)

        self.assertIn("🔵 运行中（0个）", rendered)
        self.assertIn("⏸️ 排队中（0个）", rendered)
        self.assertIn("❓ 待确认（0个）", rendered)
        self.assertIn("⚠️ 异常与恢复（0个）", rendered)

    def test_recovery_section_hides_old_requeued_recovery_tasks(self) -> None:
        tasks = [
            {
                "id": "stale-recovered",
                "worker_pool": "octoclaw-code",
                "status": "queued",
                "summary": "多阶段修复方案",
                "task_description": "多阶段修复方案",
                "route": "spawn_single",
                "runtime": "subagent",
                "executor": "subagent",
                "recovery_action": "dead_agent_recovered",
                "updated_at": "2026-03-26T12:00:00+00:00",
            },
            {
                "id": "needs-steer",
                "worker_pool": "octoclaw-code",
                "status": "failed",
                "summary": "需要人工检查",
                "task_description": "需要人工检查",
                "route": "spawn_single",
                "runtime": "subagent",
                "executor": "subagent",
                "recovery_action": "needs_steer",
                "updated_at": "2026-03-28T11:58:00+00:00",
            },
        ]

        snapshot = build_status_snapshot(tasks, now=self.now)

        self.assertEqual([task["id"] for task in snapshot["queued"]], ["stale-recovered"])
        self.assertEqual([task["id"] for task in snapshot["steer_needed"]], ["needs-steer"])

    def test_table_recover_note_includes_resume_state(self) -> None:
        snapshot = build_status_snapshot(
            [
                {
                    "id": "recover-1",
                    "worker_pool": "octoclaw-research",
                    "status": "queued",
                    "summary": "resume provider research",
                    "task_description": "Resume provider research",
                    "route": "spawn_single",
                    "runtime": "subagent",
                    "executor": "subagent",
                    "session_status": "missing",
                    "recovery_action": "dead_agent_recovered",
                    "session_resume": {"resume_state": "recovered"},
                }
            ],
            now=self.now,
        )

        rendered = render_status_table(snapshot)
        self.assertIn("resume:recovered", rendered)

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
        drifted_actual = render_main_model_drift_summary(
            {
                "enabled": True,
                "drift": True,
                "reason": "drift_detected",
                "expected_model": "omniroute/cx/gpt-5.4",
                "actual_model": "zhipu/GLM-5.1",
            }
        )

        self.assertEqual(aligned, ["🧭 主链漂移：aligned · omniroute/cx/gpt-5.4"])
        self.assertEqual(
            drifted,
            ["🧭 主链漂移：detected · expected omniroute/cx/gpt-5.4 · actual zhipu/GLM-5.1"],
        )
        self.assertEqual(
            drifted_actual,
            [
                "🧭 主链漂移：detected · expected omniroute/cx/gpt-5.4 · actual zhipu/GLM-5.1",
                "   session override：none",
            ],
        )

    def test_main_model_drift_summary_marks_stale_override_when_actual_aligned(self) -> None:
        rendered = render_main_model_drift_summary(
            {
                "enabled": True,
                "drift": False,
                "reason": "aligned",
                "expected_model": "omniroute/cx/gpt-5.4",
                "actual_model": "omniroute/cx/gpt-5.4",
                "current_override": "zhipu/GLM-5.1",
                "override_drift": True,
            }
        )

        self.assertEqual(
            rendered,
            [
                "🧭 主链漂移：aligned · omniroute/cx/gpt-5.4",
                "   session override：zhipu/GLM-5.1（stale, actual aligned）",
            ],
        )


if __name__ == "__main__":
    unittest.main()
