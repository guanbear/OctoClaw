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
    def test_dispatch_runner_includes_materialization_fact(self) -> None:
        decision = {
            "request": {"session_key": "agent:main:slack:direct:u1", "metadata": {}},
            "route_decision": {
                "route": "runner",
                "work_contract": "inspect_report",
            },
        }
        args = argparse.Namespace(
            task="检查 nginx 日志",
            command="tail -n 20 /var/log/nginx/error.log",
            cwd="/tmp",
            summary="tail nginx log",
            timeout_seconds=30,
            id="runner-1",
            model_band="fast",
            wait=False,
            wait_timeout_seconds=12,
            _policy_decision=decision,
            _runner_playbook=None,
        )

        with patch.object(dispatch_task.subprocess, "run", return_value=type("Result", (), {"returncode": 0, "stdout": "{\"id\":\"runner-job-1\"}", "stderr": ""})()):
            payload = dispatch_task.dispatch_runner(args)

        self.assertEqual(payload["materialization"]["lane"], "runner")
        self.assertEqual(payload["materialization"]["kind"], "runner_playbook")
        self.assertEqual(payload["materialization"]["runner_job_id"], "runner-job-1")
        self.assertTrue(payload["materialization"]["executed"])

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
            "materialization": {"schema_version": "octoclaw.delegated_materialization/v1", "lane": "spawn_single", "kind": "spawn_child_task", "status": "materialized", "execution_contract": "deliverable_work", "task_id": "code-1", "runner_job_id": "", "child_spec_id": "code-1", "session_key": "", "executed": False, "capability_failure": {}},
            "executed": False,
        }) as spawn_mock:
            payload = dispatch_task.recommend_spawn(args, "Fix the login API bug")

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
        self.assertEqual(payload["materialization"]["kind"], "spawn_child_task")

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
        self.assertEqual(payload["materialization"]["lane"], "spawn_multi")
        self.assertEqual(payload["materialization"]["kind"], "spawn_team_flow")

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
        self.assertEqual(result["materialization"]["status"], "materialized")

    def test_execute_multi_spawn_plan_reports_materialization_failure_without_backend(self) -> None:
        args = argparse.Namespace()
        with patch.object(dispatch_task, "configured_spawn_backend", return_value=""):
            result = dispatch_task.execute_multi_spawn_plan(args, "Fix the workflow", {"worker": {"worker_pool": "octoclaw-code"}}, parent_task_id="team-root")

        self.assertFalse(result["executed"])
        self.assertEqual(result["materialization"]["status"], "materialization_failed")
        self.assertEqual(result["materialization"]["task_id"], "team-root")
        self.assertEqual(result["capability_failure"]["reason"], "spawn_backend_unavailable")
        self.assertEqual(result["handoff"]["status"], "failed")

if __name__ == "__main__":
    unittest.main()
