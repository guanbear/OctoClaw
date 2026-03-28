#!/usr/bin/env python3
import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

dispatch_task = importlib.import_module("dispatch_task")

TASK_STATE_UPDATE = REPO_ROOT / "lib" / "task-state-update.py"


class UnifiedRuntimeLineageTests(unittest.TestCase):
    def upsert(self, env: dict, *args: str) -> None:
        subprocess.run(
            ["python3", str(TASK_STATE_UPDATE), "upsert", *args],
            capture_output=True,
            text=True,
            env=env,
            check=True,
        )

    def finish(self, env: dict, status: str, task_id: str, summary: str) -> None:
        subprocess.run(
            ["python3", str(TASK_STATE_UPDATE), status, "--id", task_id, "--summary", summary],
            capture_output=True,
            text=True,
            env=env,
            check=True,
        )

    def test_register_multi_parent_task_writes_team_parent_record(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-team-parent-") as workspace:
            parent_spec = {
                "task_id": "team-root-1",
                "label": "octopus-power",
                "model": "openai/gpt-5.4",
                "tier": "hard",
                "expected_done": "+15min",
                "report_path": "/tmp/team-root-1.md",
                "context_path": "/tmp/team-root-1-context.md",
                "context_summary": "recent context",
                "profile": "research",
            }
            decision = {
                "route_decision": {
                    "worker_pool": "octoclaw-research",
                    "work_type": "research",
                    "phase": "collect",
                    "protocol": "normal",
                },
                "model_policy": {
                    "profile": "research",
                },
                "review_policy": {
                    "required": True,
                },
            }
            plan = {
                "planner": {"label": "octopus-analyze", "tier": "normal", "model": "planner-model"},
                "worker": {"label": "octopus-fix", "tier": "hard", "model": "worker-model"},
                "review": {"label": "octopus-test", "tier": "normal", "model": "review-model"},
            }
            execution = {
                "executed": True,
                "steps": [
                    {"step": "planner", "task_id": "team-step-1", "report_path": "/tmp/team-step-1.md", "task_kind": "team_step"},
                    {"step": "worker", "task_id": "team-step-2", "report_path": "/tmp/team-step-2.md", "task_kind": "team_step"},
                    {"step": "review", "task_id": "team-step-3", "report_path": "/tmp/team-step-3.md", "task_kind": "team_step"},
                ],
                "handoff": {"status": "pending"},
            }

            with patch.dict(os.environ, {"WORKSPACE": workspace}, clear=False):
                dispatch_task.register_multi_parent_task(
                    task="Investigate the failing release workflow, implement a fix, and verify it.",
                    parent_spec=parent_spec,
                    decision=decision,
                    plan=plan,
                    execution=execution,
                    backend="clawteam",
                    parent_parent_id="session-root-1",
                )

            state_path = Path(workspace) / "tmp" / "octopus" / "task-state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            task = state["tasks"][0]

        self.assertEqual(task["id"], "team-root-1")
        self.assertEqual(task["executor"], "team")
        self.assertEqual(task["executor_type"], "team")
        self.assertEqual(task["route"], "spawn_multi")
        self.assertEqual(task["runtime"], "clawteam")
        self.assertEqual(task["task_kind"], "team_parent")
        self.assertEqual(task["parent_id"], "session-root-1")
        self.assertEqual(task["child_ids"], ["team-step-1", "team-step-2", "team-step-3"])
        self.assertTrue(task["review_required"])
        self.assertEqual(task["artifacts"]["execution_backend"], "clawteam")
        self.assertEqual(task["artifacts"]["child_task_ids"], ["team-step-1", "team-step-2", "team-step-3"])
        self.assertEqual(task["artifacts"]["step_order"], ["planner", "worker", "review"])
        self.assertEqual(task["artifacts"]["step_task_ids"]["planner"], "team-step-1")
        self.assertEqual(task["artifacts"]["step_task_kinds"]["planner"], "team_step")
        self.assertEqual(task["artifacts"]["step_models"]["planner"]["worker_pool"], "octoclaw-research")
        self.assertEqual(task["artifacts"]["step_models"]["worker"]["work_type"], "code")
        self.assertEqual(task["artifacts"]["step_models"]["review"]["phase"], "verify")

    def test_bridge_board_includes_parent_child_lineage(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-lineage-board-") as workspace:
            env = {**os.environ, "WORKSPACE": workspace}
            config_path = Path(workspace) / "tmp" / "octopus-config.json"
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(
                json.dumps(
                    {
                        "clawteam_bridge": {
                            "enabled": True,
                            "backend": "mirror",
                            "emit_result_mail": False,
                        }
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

            self.upsert(
                env,
                "--id", "team-root",
                "--label", "octopus-power",
                "--status", "running",
                "--summary", "multi-step task in progress",
                "--task-description", "Investigate, fix, and verify the failing workflow",
                "--route", "spawn_multi",
                "--runtime", "clawteam",
                "--executor", "team",
                "--task-kind", "team_parent",
                "--worker-pool", "octoclaw-research",
                "--work-type", "research",
                "--phase", "collect",
                "--protocol", "normal",
                "--profile", "research",
                "--child-ids", "team-step-a,team-step-b",
                "--artifacts-json", json.dumps({"step_order": ["planner", "review"], "step_task_ids": {"planner": "team-step-a", "review": "team-step-b"}}),
                "--report-path", "/tmp/team-root.md",
            )
            self.upsert(
                env,
                "--id", "team-step-a",
                "--label", "octopus-analyze",
                "--status", "running",
                "--summary", "planner step",
                "--task-description", "Break down the workflow failure into a plan",
                "--route", "spawn_single",
                "--runtime", "subagent",
                "--executor", "subagent",
                "--task-kind", "team_step",
                "--parent-id", "team-root",
                "--worker-pool", "octoclaw-research",
                "--work-type", "research",
                "--phase", "inspect",
                "--protocol", "normal",
                "--profile", "research",
                "--report-path", "/tmp/team-step-a.md",
            )
            self.upsert(
                env,
                "--id", "team-step-b",
                "--label", "octopus-test",
                "--status", "queued",
                "--summary", "review step",
                "--task-description", "Verify the final fix and call out regressions",
                "--route", "spawn_single",
                "--runtime", "subagent",
                "--executor", "subagent",
                "--task-kind", "team_step",
                "--parent-id", "team-root",
                "--worker-pool", "octoclaw-review",
                "--work-type", "review",
                "--phase", "verify",
                "--protocol", "normal",
                "--profile", "review",
                "--report-path", "/tmp/team-step-b.md",
            )

            board_path = Path(workspace) / "tmp" / "octopus" / "clawteam-bridge" / "board.json"
            board = json.loads(board_path.read_text(encoding="utf-8"))

        self.assertEqual(board["task_kind_counts"]["team_parent"], 1)
        self.assertEqual(board["task_kind_counts"]["team_step"], 2)
        self.assertTrue(board["lineages"])
        self.assertEqual(board["workbench"]["supervisor_mode"], "auto")
        lineage = next(item for item in board["lineages"] if item["parent"]["id"] == "team-root")
        self.assertEqual(lineage["child_count"], 2)
        self.assertEqual(set(lineage["child_ids"]), {"team-step-a", "team-step-b"})
        self.assertEqual(lineage["open_task_count"], 2)
        self.assertEqual(lineage["status_counts"]["running"], 1)
        self.assertEqual(lineage["status_counts"]["queued"], 1)
        self.assertEqual(lineage["parent"]["owner"], "梭鱼眼")
        self.assertEqual(lineage["parent"]["worker_pool_display"], "梭鱼眼")
        self.assertEqual(lineage["children"][0]["worker_pool_display"], "梭鱼眼")
        self.assertEqual(lineage["children"][1]["worker_pool_display"], "海胆手")
        self.assertEqual({child["task_kind"] for child in lineage["children"]}, {"team_step"})

    def test_parent_auto_aggregates_child_progress_and_completion(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-parent-aggregate-") as workspace:
            env = {**os.environ, "WORKSPACE": workspace}

            self.upsert(
                env,
                "--id", "team-parent",
                "--label", "octopus-power",
                "--status", "dispatched",
                "--summary", "spawn_multi planned",
                "--task-description", "Investigate, fix, and verify a flaky release flow",
                "--route", "spawn_multi",
                "--runtime", "clawteam",
                "--executor", "team",
                "--task-kind", "team_parent",
                "--worker-pool", "octoclaw-research",
                "--work-type", "research",
                "--phase", "collect",
                "--protocol", "normal",
                "--profile", "research",
                "--child-ids", "step-plan,step-review",
                "--artifacts-json", json.dumps(
                    {
                        "step_order": ["planner", "review"],
                        "step_task_ids": {"planner": "step-plan", "review": "step-review"},
                    }
                ),
            )
            self.upsert(
                env,
                "--id", "step-plan",
                "--label", "octopus-analyze",
                "--status", "running",
                "--summary", "planner is working",
                "--task-description", "Plan the investigation",
                "--route", "spawn_single",
                "--runtime", "subagent",
                "--executor", "subagent",
                "--task-kind", "team_step",
                "--parent-id", "team-parent",
                "--worker-pool", "octoclaw-research",
                "--work-type", "research",
                "--phase", "inspect",
                "--protocol", "normal",
                "--profile", "research",
                "--report-path", "/tmp/step-plan.md",
            )
            self.upsert(
                env,
                "--id", "step-review",
                "--label", "octopus-test",
                "--status", "queued",
                "--summary", "review is waiting",
                "--task-description", "Verify the final result",
                "--route", "spawn_single",
                "--runtime", "subagent",
                "--executor", "subagent",
                "--task-kind", "team_step",
                "--parent-id", "team-parent",
                "--worker-pool", "octoclaw-review",
                "--work-type", "review",
                "--phase", "verify",
                "--protocol", "normal",
                "--profile", "review",
                "--report-path", "/tmp/step-review.md",
            )

            self.finish(env, "done", "step-plan", "planner completed the root-cause analysis")
            state_path = Path(workspace) / "tmp" / "octopus" / "task-state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            parent = next(task for task in state["tasks"] if task["id"] == "team-parent")
            self.assertEqual(parent["status"], "running")
            self.assertIn("planner done", parent["summary"])
            self.assertEqual(parent["artifacts"]["step_statuses"]["planner"], "done")
            self.assertEqual(parent["artifacts"]["step_statuses"]["review"], "queued")
            self.assertEqual(parent["artifacts"]["step_summaries"]["planner"], "planner completed the root-cause analysis")
            self.assertEqual(parent["artifacts"]["completed_child_ids"], ["step-plan"])
            self.assertEqual(parent["artifacts"]["open_child_ids"], ["step-review"])

            self.finish(env, "done", "step-review", "review confirmed the final result")
            state = json.loads(state_path.read_text(encoding="utf-8"))
            parent = next(task for task in state["tasks"] if task["id"] == "team-parent")
            self.assertEqual(parent["status"], "done")
            self.assertTrue(parent["completed_at"])
            self.assertIn("spawn_multi complete", parent["summary"])
            self.assertEqual(parent["artifacts"]["completed_child_count"], 2)
            self.assertEqual(parent["artifacts"]["open_child_count"], 0)
            self.assertEqual(parent["artifacts"]["step_statuses"]["review"], "done")

    def test_parent_failure_emits_parent_result_mail(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-parent-failed-") as workspace:
            env = {**os.environ, "WORKSPACE": workspace}
            config_path = Path(workspace) / "tmp" / "octopus-config.json"
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(
                json.dumps(
                    {
                        "clawteam_bridge": {
                            "enabled": True,
                            "backend": "mirror",
                            "emit_result_mail": True,
                        }
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

            self.upsert(
                env,
                "--id", "team-root",
                "--label", "octopus-power",
                "--status", "running",
                "--summary", "spawn_multi running",
                "--task-description", "Repair and verify the deployment pipeline",
                "--route", "spawn_multi",
                "--runtime", "clawteam",
                "--executor", "team",
                "--task-kind", "team_parent",
                "--worker-pool", "octoclaw-code",
                "--work-type", "code",
                "--phase", "implement",
                "--protocol", "normal",
                "--profile", "code",
                "--child-ids", "step-worker",
                "--artifacts-json", json.dumps(
                    {
                        "step_order": ["worker"],
                        "step_task_ids": {"worker": "step-worker"},
                    }
                ),
            )
            self.upsert(
                env,
                "--id", "step-worker",
                "--label", "octopus-fix",
                "--status", "running",
                "--summary", "worker is patching",
                "--task-description", "Patch the deployment pipeline",
                "--route", "spawn_single",
                "--runtime", "subagent",
                "--executor", "subagent",
                "--task-kind", "team_step",
                "--parent-id", "team-root",
                "--worker-pool", "octoclaw-code",
                "--work-type", "code",
                "--phase", "implement",
                "--protocol", "normal",
                "--profile", "code",
                "--report-path", "/tmp/step-worker.md",
            )

            self.finish(env, "failed", "step-worker", "worker hit a migration conflict")

            state_path = Path(workspace) / "tmp" / "octopus" / "task-state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            parent = next(task for task in state["tasks"] if task["id"] == "team-root")
            self.assertEqual(parent["status"], "failed")
            self.assertIn("worker failed", parent["summary"])
            self.assertEqual(parent["artifacts"]["failed_child_ids"], ["step-worker"])
            self.assertEqual(parent["artifacts"]["step_statuses"]["worker"], "failed")

            inbox_path = Path(workspace) / "tmp" / "octopus" / "clawteam-bridge" / "inbox" / "main.jsonl"
            inbox_entries = [
                json.loads(line)
                for line in inbox_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            parent_entry = next(entry for entry in inbox_entries if entry["task_id"] == "team-root" and entry["status"] == "failed")
            self.assertEqual(parent_entry["artifacts"]["failed_child_count"], 1)
            self.assertEqual(parent_entry["artifacts"]["step_statuses"]["worker"], "failed")


if __name__ == "__main__":
    unittest.main()
