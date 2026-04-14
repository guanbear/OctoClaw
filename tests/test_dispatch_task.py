#!/usr/bin/env python3
import argparse
import contextlib
import io
import importlib
import json
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
    def test_merge_runtime_metadata_into_decision_makes_cli_session_authoritative(self) -> None:
        decision = {
            "request": {
                "session_key": "",
                "metadata": {"session_key": "", "channel": "slack"},
            },
            "route_decision": {"route": "runner"},
        }

        merged = dispatch_task.merge_runtime_metadata_into_decision(
            decision,
            {"session_key": "agent:main:slack:direct:u-main", "channel": "slack"},
            session_key="agent:main:slack:direct:u-main",
        )

        self.assertEqual(merged["request"]["session_key"], "agent:main:slack:direct:u-main")
        self.assertEqual(merged["request"]["metadata"]["session_key"], "agent:main:slack:direct:u-main")
        self.assertEqual(merged["request"]["metadata"]["channel"], "slack")
        self.assertEqual(decision["request"]["session_key"], "")

    def test_run_runner_on_demand_enables_internal_legacy_loop_flag(self) -> None:
        with patch.object(
            dispatch_task.subprocess,
            "run",
            return_value=type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})(),
        ) as run_mock:
            payload = dispatch_task.run_runner_on_demand("runner-ondemand-flag")

        self.assertTrue(payload["triggered"])
        self.assertTrue(payload["ok"])
        env = run_mock.call_args.kwargs["env"]
        self.assertEqual(env["OCTOCLAW_ENABLE_LEGACY_LOOPS"], "1")

    def test_kick_runner_on_demand_background_detects_immediate_exit(self) -> None:
        proc = type("Proc", (), {"pid": 4321, "poll": lambda self: 0})()
        with patch.object(dispatch_task.subprocess, "Popen", return_value=proc):
            payload = dispatch_task.kick_runner_on_demand_background("runner-bootstrap-exit")

        self.assertFalse(payload["triggered"])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["returncode"], 0)
        self.assertIn("exited immediately", payload["error"])

    def test_kick_runner_on_demand_background_sets_preferred_job_env(self) -> None:
        proc = type("Proc", (), {"pid": 4321, "poll": lambda self: None})()
        with patch.object(dispatch_task.subprocess, "Popen", return_value=proc) as popen_mock, patch.object(
            dispatch_task, "load_json", return_value={"jobs": [{"id": "runner-job-42", "status": "running"}]}
        ):
            payload = dispatch_task.kick_runner_on_demand_background("runner-job-42")

        self.assertTrue(payload["ok"])
        env = popen_mock.call_args.kwargs["env"]
        self.assertEqual(env["RUNNER_PREFERRED_JOB_ID"], "runner-job-42")
        self.assertEqual(env["RUNNER_MAX_IDLE_SECONDS"], "30")

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

        with patch.object(
            dispatch_task,
            "runner_dispatch_runtime_resolution",
            return_value={
                "runner_pool_enabled": True,
                "max_queue_size": 20,
                "busy_strategy": "queue_or_progress",
                "legacy_runner_fallback": True,
                "queue_counts": {"queued": 0, "running": 0, "done": 0, "failed": 0, "total": 0, "active": 0},
                "queue_pressure_band": "none",
                "runner_health_snapshot": {"present": True, "healthy": True, "reason": "ok", "worker_id": "runner-a"},
                "dispatch_mode": "daemon",
                "can_dispatch": True,
                "block_reason": "",
                "block_detail": "",
                "fallback_permitted": False,
            },
        ), patch.object(dispatch_task.subprocess, "run", return_value=type("Result", (), {"returncode": 0, "stdout": "{\"id\":\"runner-job-1\"}", "stderr": ""})()):
            payload = dispatch_task.dispatch_runner(args)

        self.assertEqual(payload["materialization"]["lane"], "runner")
        self.assertEqual(payload["materialization"]["kind"], "runner_playbook")
        self.assertEqual(payload["materialization"]["runner_job_id"], "runner-job-1")
        self.assertTrue(payload["materialization"]["executed"])
        self.assertEqual(payload["goal_contract"]["schema_version"], "octoclaw.runner_goal_contract/v1")
        self.assertEqual(payload["goal_contract"]["route"], "runner")
        self.assertEqual(payload["goal_contract"]["command"], "tail -n 20 /var/log/nginx/error.log")
        self.assertEqual(payload["goal_contract"]["runner_job_id"], "runner-job-1")

    def test_dispatch_runner_blocks_when_queue_is_full(self) -> None:
        decision = {
            "request": {"session_key": "agent:main:slack:direct:u1", "metadata": {}},
            "route_decision": {"route": "runner"},
        }
        args = argparse.Namespace(
            task="检查 nginx 日志",
            command="tail -n 20 /var/log/nginx/error.log",
            cwd="/tmp",
            summary="tail nginx log",
            timeout_seconds=30,
            id="runner-queue-full",
            model_band="fast",
            wait=False,
            wait_timeout_seconds=12,
            _policy_decision=decision,
            _runner_playbook=None,
        )

        with patch.object(dispatch_task, "load_octopus_config", return_value={
            "runtime_policy": {
                "runner_pool": {"enabled": True, "max_queue_size": 1, "busy_strategy": "queue_or_progress"},
                "features": {"runner_pool_enabled": True, "legacy_runner_fallback": True},
            }
        }), patch.object(dispatch_task, "load_runner_queue_counts", return_value={"queued": 1, "running": 0, "done": 0, "failed": 0, "total": 1}), patch.object(
            dispatch_task,
            "load_runner_health",
            return_value={"present": True, "healthy": True, "reason": "ok", "worker_id": "runner-a", "age_seconds": 1, "health": {"worker_id": "runner-a"}},
        ), patch.object(dispatch_task.subprocess, "run") as run_mock:
            payload = dispatch_task.dispatch_runner(args)

        run_mock.assert_not_called()
        self.assertFalse(payload["executed"])
        self.assertEqual(payload["runner_execution_mode"], "deferred")
        self.assertEqual(payload["capability_failure"]["reason"], "runner_queue_full")
        self.assertEqual(payload["materialization"]["status"], "materialization_failed")
        self.assertEqual(payload["handoff"]["status"], "failed")
        self.assertEqual(payload["runner_runtime_resolution"]["queue_pressure_band"], "high")

    def test_dispatch_runner_bootstraps_background_worker_when_worker_unhealthy(self) -> None:
        decision = {
            "request": {"session_key": "agent:main:slack:direct:u2", "metadata": {}},
            "route_decision": {"route": "runner"},
        }
        args = argparse.Namespace(
            task="检查 nginx 日志",
            command="tail -n 20 /var/log/nginx/error.log",
            cwd="/tmp",
            summary="tail nginx log",
            timeout_seconds=30,
            id="runner-unhealthy",
            model_band="fast",
            wait=False,
            wait_timeout_seconds=12,
            _policy_decision=decision,
            _runner_playbook=None,
        )

        with patch.object(dispatch_task, "load_octopus_config", return_value={
            "runtime_policy": {
                "runner_pool": {"enabled": True, "max_queue_size": 4, "busy_strategy": "queue_or_progress"},
                "features": {"runner_pool_enabled": True, "legacy_runner_fallback": True},
            }
        }), patch.object(dispatch_task, "load_runner_queue_counts", return_value={"queued": 0, "running": 0, "done": 0, "failed": 0, "total": 0}), patch.object(
            dispatch_task,
            "load_runner_health",
            return_value={"present": True, "healthy": False, "reason": "stale", "worker_id": "runner-a", "age_seconds": 999, "health": {"worker_id": "runner-a"}},
        ), patch.object(dispatch_task.subprocess, "run", return_value=type("Result", (), {"returncode": 0, "stdout": "{\"id\":\"runner-unhealthy\"}", "stderr": ""})()), patch.object(
            dispatch_task,
            "kick_runner_on_demand_background",
            return_value={"triggered": True, "worker_id": "runner-bootstrap-runner-unhealthy", "pid": 123, "ok": True, "mode": "background_bootstrap"},
        ) as kick_mock, patch.object(
            dispatch_task,
            "append_runtime_task_event",
        ):
            payload = dispatch_task.dispatch_runner(args)

        kick_mock.assert_called_once()
        self.assertTrue(payload["executed"])
        self.assertEqual(payload["runner_execution_mode"], "ondemand")
        self.assertTrue(payload["runner_execution"]["triggered"])
        self.assertEqual(payload["runner_runtime_resolution"]["runner_health_snapshot"]["reason"], "stale")

    def test_dispatch_runner_marks_bootstrap_failure_as_materialization_failed(self) -> None:
        decision = {
            "request": {"session_key": "agent:main:slack:direct:u2c", "metadata": {}},
            "route_decision": {"route": "runner"},
        }
        args = argparse.Namespace(
            task="检查 gateway 状态",
            command="openclaw status",
            cwd="/tmp",
            summary="check gateway status",
            timeout_seconds=30,
            id="runner-bootstrap-failed",
            model_band="fast",
            wait=False,
            wait_timeout_seconds=12,
            _policy_decision=decision,
            _runner_playbook=None,
        )

        with patch.object(dispatch_task, "load_octopus_config", return_value={
            "runtime_policy": {
                "runner_pool": {"enabled": True, "max_queue_size": 4, "busy_strategy": "queue_or_progress"},
                "features": {"runner_pool_enabled": True, "legacy_runner_fallback": True},
            }
        }), patch.object(dispatch_task, "load_runner_queue_counts", return_value={"queued": 0, "running": 0, "done": 0, "failed": 0, "total": 0}), patch.object(
            dispatch_task,
            "load_runner_health",
            return_value={"present": True, "healthy": False, "reason": "stale", "worker_id": "runner-a", "age_seconds": 999, "health": {"worker_id": "runner-a"}},
        ), patch.object(
            dispatch_task.subprocess,
            "run",
            return_value=type("Result", (), {"returncode": 0, "stdout": "{\"id\":\"runner-bootstrap-failed\"}", "stderr": ""})(),
        ), patch.object(
            dispatch_task,
            "kick_runner_on_demand_background",
            return_value={
                "triggered": False,
                "worker_id": "runner-bootstrap-runner-bootstrap-failed",
                "pid": 123,
                "ok": False,
                "mode": "background_bootstrap",
                "returncode": 0,
                "error": "runner bootstrap exited immediately with code 0",
            },
        ), patch.object(
            dispatch_task,
            "mark_runner_bootstrap_failed",
        ) as mark_failed_mock, patch.object(
            dispatch_task,
            "append_runtime_task_event",
        ) as event_mock:
            payload = dispatch_task.dispatch_runner(args)

        mark_failed_mock.assert_called_once()
        self.assertFalse(payload["executed"])
        self.assertEqual(payload["reason"], "runner_bootstrap_failed")
        self.assertEqual(payload["capability_failure"]["reason"], "runner_bootstrap_failed")
        self.assertEqual(payload["materialization"]["status"], "materialization_failed")
        self.assertEqual(payload["handoff"]["status"], "failed")
        self.assertEqual(payload["handoff"]["kind"], "plan")
        self.assertEqual(payload["runner_execution_mode"], "ondemand")
        self.assertFalse(payload["runner_execution"]["ok"])
        event_mock.assert_called_once()

    def test_dispatch_runner_blocks_when_worker_unhealthy_without_fallback(self) -> None:
        decision = {
            "request": {"session_key": "agent:main:slack:direct:u2b", "metadata": {}},
            "route_decision": {"route": "runner"},
        }
        args = argparse.Namespace(
            task="检查 nginx 日志",
            command="tail -n 20 /var/log/nginx/error.log",
            cwd="/tmp",
            summary="tail nginx log",
            timeout_seconds=30,
            id="runner-unhealthy-no-fallback",
            model_band="fast",
            wait=False,
            wait_timeout_seconds=12,
            _policy_decision=decision,
            _runner_playbook=None,
        )

        with patch.object(dispatch_task, "load_octopus_config", return_value={
            "runtime_policy": {
                "runner_pool": {"enabled": True, "max_queue_size": 4, "busy_strategy": "queue_or_progress"},
                "features": {"runner_pool_enabled": True, "legacy_runner_fallback": False},
            }
        }), patch.object(dispatch_task, "load_runner_queue_counts", return_value={"queued": 0, "running": 0, "done": 0, "failed": 0, "total": 0}), patch.object(
            dispatch_task,
            "load_runner_health",
            return_value={"present": True, "healthy": False, "reason": "stale", "worker_id": "runner-a", "age_seconds": 999, "health": {"worker_id": "runner-a"}},
        ), patch.object(dispatch_task.subprocess, "run") as run_mock:
            payload = dispatch_task.dispatch_runner(args)

        run_mock.assert_not_called()
        self.assertFalse(payload["executed"])
        self.assertEqual(payload["capability_failure"]["reason"], "runner_worker_unhealthy")
        self.assertEqual(payload["runner_execution_mode"], "deferred")
        self.assertEqual(payload["materialization"]["status"], "materialization_failed")

    def test_dispatch_runner_blocks_when_session_concurrency_is_exhausted(self) -> None:
        decision = {
            "request": {"session_key": "agent:main:slack:direct:u3", "metadata": {}},
            "route_decision": {"route": "runner"},
        }
        args = argparse.Namespace(
            task="检查 gateway 状态",
            command="openclaw status",
            cwd="/tmp",
            summary="check gateway status",
            timeout_seconds=30,
            id="runner-concurrency",
            model_band="fast",
            wait=False,
            wait_timeout_seconds=12,
            _policy_decision=decision,
            _runner_playbook=None,
        )

        with patch.object(dispatch_task, "load_octopus_config", return_value={
            "runtime_policy": {
                "runner_pool": {
                    "enabled": True,
                    "max_queue_size": 4,
                    "per_user_concurrency": 1,
                    "lease_timeout_seconds": 90,
                    "busy_strategy": "queue_or_progress",
                },
                "features": {"runner_pool_enabled": True, "legacy_runner_fallback": True},
            }
        }), patch.object(dispatch_task, "recover_stale_running_jobs", return_value={"recovered_count": 0, "jobs": []}), patch.object(
            dispatch_task,
            "load_runner_queue_counts",
            return_value={"queued": 1, "running": 0, "done": 0, "failed": 0, "total": 1},
        ), patch.object(
            dispatch_task,
            "load_runner_active_jobs",
            return_value=[{"id": "runner-existing", "status": "queued", "session_key": "agent:main:slack:direct:u3", "worker_id": ""}],
        ), patch.object(
            dispatch_task,
            "load_runner_health",
            return_value={"present": True, "healthy": True, "reason": "ok", "worker_id": "runner-a", "age_seconds": 1, "health": {"worker_id": "runner-a"}},
        ), patch.object(dispatch_task.subprocess, "run") as run_mock:
            payload = dispatch_task.dispatch_runner(args)

        run_mock.assert_not_called()
        self.assertFalse(payload["executed"])
        self.assertEqual(payload["capability_failure"]["reason"], "runner_per_user_concurrency_exceeded")
        self.assertEqual(payload["capability_failure"]["missing_capabilities"], ["runner_concurrency_slot"])
        self.assertEqual(payload["runner_runtime_resolution"]["session_active_jobs"][0]["id"], "runner-existing")

    def test_sync_recovered_stale_runner_jobs_updates_task_state(self) -> None:
        with patch.object(dispatch_task.subprocess, "run") as run_mock:
            dispatch_task.sync_recovered_stale_runner_jobs(
                {
                    "jobs": [
                        {"id": "runner-stale-1", "worker_id": "runner-old"},
                    ]
                }
            )

        cmd = run_mock.call_args.args[0]
        self.assertEqual(cmd[:3], ["python3", dispatch_task.TASK_STATE_PY, "failed"])
        self.assertIn("runner-stale-1", cmd)
        self.assertIn("runner_lease_expired", cmd)

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
                "session_key": "",
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

    def test_main_requires_precomputed_policy_decision_by_default(self) -> None:
        stdout = io.StringIO()
        with (
            patch.object(sys, "argv", ["dispatch_task.py", "--task", "检查 gateway 状态"]),
            patch.object(dispatch_task, "legacy_policy_fallback_enabled", return_value=False),
            contextlib.redirect_stdout(stdout),
        ):
            dispatch_task.main()

        payload = json.loads(stdout.getvalue().strip())
        self.assertEqual(payload["reason"], "policy_decision_required")
        self.assertFalse(payload["executed"])
        self.assertFalse(payload["legacy_policy_fallback_used"])
        self.assertEqual(payload["materialization"]["status"], "materialization_failed")

    def test_main_uses_legacy_policy_only_when_explicitly_enabled(self) -> None:
        stdout = io.StringIO()
        legacy_decision = {
            "route_decision": {
                "route": "direct",
                "reason": "legacy_fallback",
            },
            "model_policy": {},
        }
        with (
            patch.object(sys, "argv", ["dispatch_task.py", "--task", "检查 gateway 状态"]),
            patch.object(dispatch_task, "legacy_policy_fallback_enabled", return_value=True),
            patch.object(dispatch_task, "build_legacy_policy_decision", return_value=legacy_decision) as legacy_mock,
            contextlib.redirect_stdout(stdout),
        ):
            dispatch_task.main()

        legacy_mock.assert_called_once()
        payload = json.loads(stdout.getvalue().strip())
        self.assertEqual(payload["route"], "direct")
        self.assertTrue(payload["legacy_policy_fallback_used"])
        self.assertEqual(payload["policy_decision"]["route_decision"]["reason"], "legacy_fallback")

if __name__ == "__main__":
    unittest.main()
