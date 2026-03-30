#!/usr/bin/env python3
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from lib.task_display import (
    build_operator_task_surface,
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
        self.assertEqual(anchor["worker_pool_display"], "Runner")
        self.assertEqual(anchor["state"], "running")
        self.assertEqual(anchor["route"], "runner")
        self.assertEqual(anchor["active_models"], ["minimax-portal/MiniMax-M2.7"])
        self.assertEqual(anchor["duration"], "2m")
        self.assertEqual(anchor["resume_state"], "none")

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

    @patch("lib.task_display.resolve_task_artifacts")
    def test_build_task_detail_prefers_artifact_index_rows(self, mock_resolve_task_artifacts) -> None:
        mock_resolve_task_artifacts.return_value = [
            {
                "artifact_id": "report-a",
                "task_id": "task-a",
                "kind": "report",
                "title": "Primary report",
                "path": "/tmp/task-a-report.md",
                "preview": "summarized findings",
                "updated_at": "2026-03-30T10:00:00+00:00",
            },
            {
                "artifact_id": "report-b",
                "task_id": "task-b",
                "kind": "report",
                "title": "Thread review",
                "path": "/tmp/task-b-review.md",
                "preview": "review notes",
                "updated_at": "2026-03-30T10:05:00+00:00",
                "source": "thread_index",
                "related_to_thread": True,
            },
        ]

        detail = build_task_detail(
            {
                "id": "task-a",
                "worker_pool": "octoclaw-research",
                "status": "done",
                "summary": "report ready",
                "route": "spawn_single",
                "session_thread_key": "slack:channel:C123:1712345.000100",
            },
            now=self.now,
        )

        self.assertEqual(detail["artifacts"][0]["artifact_id"], "report-a")
        self.assertEqual(detail["artifacts"][0]["source"], "task_index")
        self.assertEqual(detail["artifacts"][1]["artifact_id"], "report-b")
        self.assertEqual(detail["artifacts"][1]["source"], "thread_index")
        self.assertTrue(detail["artifacts"][1]["related_to_thread"])
        self.assertIn("task-b", detail["artifacts"][1]["title"])

    def test_build_task_detail_prefers_task_event_preview(self) -> None:
        detail = build_task_detail(
            {
                "id": "research-2",
                "worker_pool": "octoclaw-research",
                "status": "blocked",
                "summary": "safe blocked handoff ready",
                "route": "spawn_single",
                "task_event_summary": {"task_event_count": 2, "latest_kind": "handoff_ready"},
                "task_events_preview": [
                    {
                        "time": "2026-03-29T07:59:00+00:00",
                        "kind": "checkpoint",
                        "message": "collected the accessible references",
                        "importance": "normal",
                    },
                    {
                        "time": "2026-03-29T08:00:00+00:00",
                        "kind": "handoff_ready",
                        "message": "safe blocked handoff ready",
                        "importance": "high",
                    },
                ],
            },
            now=self.now,
        )

        self.assertEqual([event["kind"] for event in detail["events"]], ["checkpoint", "handoff_ready"])
        self.assertEqual(detail["task_event_summary"]["latest_kind"], "handoff_ready")

    def test_build_task_anchor_exposes_session_resume_fields(self) -> None:
        anchor = build_task_anchor(
            {
                "id": "research-1",
                "worker_pool": "octoclaw-research",
                "status": "queued",
                "summary": "resume the provider research",
                "route": "spawn_single",
                "session_status": "missing",
                "session_resume": {
                    "resume_state": "stale",
                    "resume_key": "octoclaw:octo-worker-1:sess-1",
                },
            },
            now=self.now,
        )

        self.assertEqual(anchor["session_status"], "missing")
        self.assertEqual(anchor["resume_state"], "stale")
        self.assertEqual(anchor["resume_key"], "octoclaw:octo-worker-1:sess-1")

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

    def test_build_operator_task_surface_contains_interactive_payload(self) -> None:
        surface = build_operator_task_surface(
            {
                "id": "code-1",
                "worker_pool": "octoclaw-code",
                "status": "running",
                "summary": "fix login 401 and add tests",
                "route": "spawn_single",
                "model": "omniroute/cx/gpt-5.4",
            }
        )

        self.assertEqual(surface["interactive"]["blocks"][0]["type"], "text")
        self.assertEqual(surface["interactive"]["blocks"][-1]["type"], "buttons")
        self.assertIn("details code-1", [btn["value"] for btn in surface["interactive"]["blocks"][-1]["buttons"]])

    def test_build_task_queue_view_groups_states(self) -> None:
        queue = build_task_queue_view(
            [
                {"id": "a", "worker_pool": "octoclaw-runner", "status": "running", "summary": "check port", "route": "runner"},
                {"id": "b", "worker_pool": "octoclaw-code", "status": "queued", "summary": "patch code", "route": "spawn_single"},
                {"id": "c", "worker_pool": "octoclaw-review", "status": "needs_approval", "summary": "waiting approval", "route": "spawn_single"},
                {"id": "d", "worker_pool": "octoclaw-research", "status": "done", "summary": "finished report", "route": "spawn_single"},
            ],
            now=self.now,
        )

        self.assertEqual([item["task_id"] for item in queue["running"]], ["a"])
        self.assertEqual([item["task_id"] for item in queue["queued"]], ["b"])
        self.assertEqual([item["task_id"] for item in queue["blocked"]], ["c"])
        self.assertEqual([item["task_id"] for item in queue["recently_completed"]], ["d"])

    def test_final_blocked_task_surfaces_as_recent_completion(self) -> None:
        anchor = build_task_anchor(
            {
                "id": "research-blocked-1",
                "worker_pool": "octoclaw-research",
                "status": "blocked",
                "summary": "source access blocked",
                "route": "spawn_single",
                "completed_at": "2026-03-29T07:58:00+00:00",
                "artifacts": {
                    "worker_result": {
                        "status": "blocked",
                        "summary": "Could not access the article body, but a safe blocked explanation is ready.",
                        "report": "/tmp/research-blocked-1.md",
                    }
                },
            },
            now=self.now,
        )
        queue = build_task_queue_view(
            [
                {
                    "id": "research-blocked-1",
                    "worker_pool": "octoclaw-research",
                    "status": "blocked",
                    "summary": "source access blocked",
                    "route": "spawn_single",
                    "completed_at": "2026-03-29T07:58:00+00:00",
                    "artifacts": {
                        "worker_result": {
                            "status": "blocked",
                            "summary": "Could not access the article body, but a safe blocked explanation is ready.",
                            "report": "/tmp/research-blocked-1.md",
                        }
                    },
                }
            ],
            now=self.now,
        )

        self.assertEqual(anchor["queue_bucket"], "recently_completed")
        self.assertEqual(anchor["state"], "blocked")
        self.assertEqual(anchor["handoff_state"], "user_safe_ready")
        self.assertIn("handoff ready", anchor["state_label"])
        self.assertEqual(queue["blocked"], [])
        self.assertEqual([item["task_id"] for item in queue["recently_completed"]], ["research-blocked-1"])


if __name__ == "__main__":
    unittest.main()
