#!/usr/bin/env python3
import argparse
import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

dispatch_task = importlib.import_module("dispatch_task")


class DispatchTaskTaxonomyTests(unittest.TestCase):
    def test_recommend_spawn_forwards_taxonomy_first_fields(self) -> None:
        decision = {
            "route_decision": {
                "route": "spawn_single",
                "worker_pool": "octoclaw-code",
                "work_type": "code",
                "phase": "implement",
                "protocol": "normal",
            },
            "model_policy": {
                "model_band": "strong",
                "selector_band": "strong",
                "profile": "code",
            },
            "route_recommendation": {
                "recommended_route": "spawn_single",
                "recommended_worker_pool": "octoclaw-code",
            },
            "budget_recommendation": {
                "output_budget": "medium",
                "reasoning_mode": "high",
            },
        }
        args = argparse.Namespace(
            model_band="",
            id="parent-1",
            _policy_decision=decision,
        )

        with patch.object(dispatch_task, "build_spawn_spec", return_value={
            "model_band": "strong",
            "selector_band": "strong",
            "model": "model/code",
            "profile": "code",
            "worker_pool": "octoclaw-code",
            "work_type": "code",
            "phase": "implement",
            "handoff": {"kind": "plan", "status": "planned", "reply_text": "", "summary": "", "report_path": "", "user_safe": True},
            "executed": False,
        }) as spawn_mock:
            dispatch_task.recommend_spawn(args, "Fix the login API bug")

        self.assertEqual(
            spawn_mock.call_args.kwargs,
            {
                "route": "spawn_single",
                "model_band": "strong",
                "selector_band": "strong",
                "worker_pool": "octoclaw-code",
                "work_type": "code",
                "phase": "implement",
                "profile": "code",
                "parent_id": "parent-1",
                "register": True,
                "execute": None,
                "policy_decision": decision,
                "metadata": {
                    "route_recommendation": decision["route_recommendation"],
                    "budget_recommendation": decision["budget_recommendation"],
                },
            },
        )

    def test_recommend_multi_spawn_plan_uses_taxonomy_fields_as_primary(self) -> None:
        primary_decision = {
            "route_decision": {
                "route": "spawn_multi",
                "worker_pool": "octoclaw-code",
                "work_type": "code",
                "phase": "implement",
                "protocol": "normal",
            },
            "model_policy": {
                "model_band": "heavy",
                "selector_band": "heavy",
                "selected_model": "model/primary",
                "profile": "code",
            },
            "review_policy": {
                "required": True,
            },
        }
        planner_decision = {
            "route_decision": {
                "route": "spawn_single",
                "worker_pool": "octoclaw-research",
                "work_type": "research",
                "phase": "inspect",
            },
            "model_policy": {
                "model_band": "normal",
                "selector_band": "standard",
                "selected_model": "model/planner",
                "profile": "research",
            },
        }
        review_decision = {
            "route_decision": {
                "route": "spawn_single",
                "worker_pool": "octoclaw-review",
                "work_type": "review",
                "phase": "verify",
            },
            "model_policy": {
                "model_band": "strong",
                "selector_band": "strong",
                "selected_model": "model/review",
                "profile": "review",
            },
        }
        args = argparse.Namespace(
            model_band="",
            id="parent-2",
            _policy_decision=primary_decision,
        )
        primary_spawn = {
            "task_id": "team-root",
            "model_band": "heavy",
            "selector_band": "heavy",
            "model": "model/primary",
            "profile": "code",
            "worker_pool": "octoclaw-code",
            "work_type": "code",
            "phase": "implement",
            "report_path": "/tmp/team-root.md",
            "handoff": {"kind": "plan", "status": "planned", "reply_text": "", "summary": "", "report_path": "", "user_safe": True},
        }

        with (
            patch.object(dispatch_task, "build_spawn_spec", return_value=primary_spawn),
            patch.object(dispatch_task, "build_decision", side_effect=[planner_decision, review_decision]),
            patch.object(dispatch_task, "execute_multi_spawn_plan", return_value={"executed": False, "steps": [], "handoff": {"kind": "plan", "status": "planned", "reply_text": "", "summary": "", "report_path": "", "user_safe": True}}),
            patch.object(dispatch_task, "register_multi_parent_task"),
        ):
            payload = dispatch_task.recommend_multi_spawn(args, "Fix and verify a failing workflow")

        plan = payload["plan"]
        self.assertEqual(plan["planner"]["worker_pool"], "octoclaw-research")
        self.assertEqual(plan["planner"]["work_type"], "research")
        self.assertEqual(plan["planner"]["phase"], "inspect")
        self.assertEqual(plan["planner"]["profile"], "research")
        self.assertEqual(plan["planner"]["model_band"], "normal")
        self.assertEqual(plan["worker"]["worker_pool"], "octoclaw-code")
        self.assertEqual(plan["worker"]["work_type"], "code")
        self.assertEqual(plan["worker"]["phase"], "implement")
        self.assertEqual(plan["worker"]["profile"], "code")
        self.assertEqual(plan["worker"]["model_band"], "heavy")
        self.assertEqual(plan["review"]["worker_pool"], "octoclaw-review")
        self.assertEqual(plan["review"]["work_type"], "review")
        self.assertEqual(plan["review"]["phase"], "verify")
        self.assertEqual(plan["review"]["profile"], "review")
        self.assertEqual(plan["review"]["model_band"], "strong")

    def test_execute_multi_spawn_plan_runs_under_native_backend(self) -> None:
        args = argparse.Namespace()
        plan = {
            "planner": {"worker_pool": "octoclaw-research", "model_band": "normal"},
            "worker": {"worker_pool": "octoclaw-code", "model_band": "strong"},
        }

        with (
            patch.object(dispatch_task, "configured_spawn_backend", return_value="native"),
            patch.object(dispatch_task, "build_spawn_spec", side_effect=[
                {
                    "model": "model/planner",
                    "model_band": "normal",
                    "selector_band": "normal",
                    "worker_pool": "octoclaw-research",
                    "work_type": "research",
                    "phase": "inspect",
                    "task_id": "planner-1",
                    "executed": True,
                    "report_path": "/tmp/planner-1.md",
                    "task_kind": "team_step",
                    "spawn_execution": {"backend": "native"},
                },
                {
                    "model": "model/worker",
                    "model_band": "strong",
                    "selector_band": "strong",
                    "worker_pool": "octoclaw-code",
                    "work_type": "code",
                    "phase": "implement",
                    "task_id": "worker-1",
                    "executed": True,
                    "report_path": "/tmp/worker-1.md",
                    "task_kind": "team_step",
                    "spawn_execution": {"backend": "native"},
                },
            ]),
        ):
            result = dispatch_task.execute_multi_spawn_plan(args, "Fix the workflow", plan, parent_task_id="team-root")

        self.assertTrue(result["executed"])
        self.assertEqual([step["task_id"] for step in result["steps"]], ["planner-1", "worker-1"])
        self.assertIn("OpenClaw 原生后台", result["handoff"]["summary"])

if __name__ == "__main__":
    unittest.main()
