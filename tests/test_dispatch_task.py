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


if __name__ == "__main__":
    unittest.main()
