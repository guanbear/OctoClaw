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
runner_dispatch = importlib.import_module("runner_dispatch")
runner_playbooks = importlib.import_module("runner_playbooks")

RUNNER_DISPATCH = REPO_ROOT / "lib" / "runner_dispatch.py"
RUNNER_LOOP = REPO_ROOT / "lib" / "runner_loop.sh"


class RunnerRuntimeTests(unittest.TestCase):
    def _find_task(self, workspace: str, task_id: str) -> dict:
        state_path = Path(workspace) / "tmp" / "octopus" / "task-state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        return next(task for task in state["tasks"] if task["id"] == task_id)

    def test_runner_loop_writes_unified_report_and_artifacts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-runner-runtime-") as workspace:
            env = {**os.environ, "WORKSPACE": workspace}
            session_key = "agent:main:slack:direct:u-runner"
            dispatch = subprocess.run(
                [
                    "python3",
                    str(RUNNER_DISPATCH),
                    "--id",
                    "runner-test-1",
                    "--command",
                    "printf 'hello runner\\n'",
                    "--summary",
                    "check runner output",
                    "--cwd",
                    workspace,
                    "--timeout-seconds",
                    "15",
                    "--task-description",
                    "Check runner output",
                    "--session-key",
                    session_key,
                    "--session-id",
                    "sess-runner-1",
                    "--agent-id",
                    "agent:main:main",
                    "--agent-namespace",
                    "octoclaw",
                    "--managed-by-octoclaw",
                    "true",
                ],
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )
            payload = json.loads(dispatch.stdout.strip())
            self.assertEqual(payload["id"], "runner-test-1")
            self.assertEqual(payload["status"], "queued")
            self.assertEqual(payload["route"], "runner")
            self.assertEqual(payload["runtime"], "runner")
            self.assertEqual(payload["openclaw_taskflow_backend"], "mirror")
            self.assertEqual(payload["openclaw_taskflow_state"], "mirrored")
            self.assertEqual(payload["openclaw_task_runtime"], "openclaw_task")
            self.assertEqual(payload["artifacts"]["openclaw_taskflow"]["binding_state"], "mirrored")

            queued_task = self._find_task(workspace, "runner-test-1")
            self.assertEqual(queued_task["status"], "queued")
            self.assertEqual(queued_task["openclaw_taskflow_backend"], "mirror")
            self.assertEqual(queued_task["openclaw_taskflow_state"], "mirrored")
            self.assertEqual(queued_task["openclaw_task_runtime"], "openclaw_task")
            self.assertEqual(queued_task["artifacts"]["openclaw_taskflow"]["task_runtime"], "openclaw_task")

            loop = subprocess.run(
                ["bash", str(RUNNER_LOOP)],
                capture_output=True,
                text=True,
                env={
                    **env,
                    "RUNNER_MAX_JOBS_PER_WORKER": "1",
                    "RUNNER_MAX_IDLE_SECONDS": "1",
                    "RUNNER_POLL_INTERVAL_SECONDS": "1",
                    "RUNNER_WORKER_ID": "test-runner",
                },
                check=True,
            )
            self.assertEqual(loop.returncode, 0)

            task = self._find_task(workspace, "runner-test-1")
            self.assertEqual(task["status"], "done")
            self.assertEqual(task["route"], "runner")
            self.assertEqual(task["runtime"], "runner")
            self.assertEqual(task["executor"], "runner")
            self.assertEqual(task["worker_pool"], "octoclaw-runner")
            self.assertEqual(task["session_key"], session_key)
            self.assertEqual(task["session_id"], "sess-runner-1")
            self.assertEqual(task["agent_id"], "agent:main:main")
            self.assertEqual(task["agent_namespace"], "octoclaw")
            self.assertTrue(task["report_path"])
            self.assertTrue(Path(task["report_path"]).exists())
            self.assertEqual(task["artifacts"]["execution_backend"], "runner_queue")
            self.assertEqual(task["artifacts"]["worker_id"], "test-runner")
            self.assertEqual(task["artifacts"]["session_key"], session_key)
            self.assertEqual(task["artifacts"]["exit_code"], 0)
            self.assertEqual(task["artifacts"]["timeout_seconds"], 15)
            self.assertEqual(task["artifacts"]["report_path"], task["report_path"])
            self.assertEqual(task["artifacts"]["operator_hint"], "auto runner-daemon")
            self.assertNotIn("label", task)
            self.assertNotIn("legacy_label", task)
            self.assertEqual(task["model_band"], "fast")
            self.assertEqual(task["artifacts"]["worker_result"]["schema_version"], "octoclaw.worker_result/v1")
            self.assertEqual(task["artifacts"]["worker_result"]["status"], "done")
            self.assertEqual(task["artifacts"]["worker_result"]["report"], task["report_path"])
            self.assertEqual(task["artifacts"]["worker_result"]["next_step"], "none")
            self.assertTrue(Path(task["artifacts"]["stdout_file"]).exists())
            self.assertTrue(Path(task["artifacts"]["stderr_file"]).exists())
            self.assertTrue(Path(task["artifacts"]["result_path"]).exists())

            meta_path = Path(workspace) / "tmp" / "octopus" / "runner-results" / "runner-test-1.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            self.assertEqual(meta["status"], "done")
            self.assertEqual(meta["summary"], "Runner completed · hello runner")
            self.assertEqual(meta["report_path"], task["report_path"])
            self.assertEqual(meta["result_path"], str(meta_path))
            self.assertEqual(meta["worker_id"], "test-runner")
            self.assertEqual(meta["session_key"], session_key)
            self.assertEqual(meta["timeout_seconds"], 15)
            self.assertEqual(meta["worker_result"]["schema_version"], "octoclaw.worker_result/v1")
            self.assertEqual(meta["worker_result"]["status"], "done")
            self.assertEqual(meta["worker_result"]["report"], task["report_path"])

            report_text = Path(task["report_path"]).read_text(encoding="utf-8")
            self.assertIn("# Runner Result: runner-test-1", report_text)
            self.assertIn("printf 'hello runner", report_text)
            self.assertIn("hello runner", report_text)

    def test_wait_and_handoff_prefer_runner_meta_report(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-runner-handoff-") as workspace:
            env = {**os.environ, "WORKSPACE": workspace}
            subprocess.run(
                [
                    "python3",
                    str(RUNNER_DISPATCH),
                    "--id",
                    "runner-test-2",
                    "--command",
                    "printf 'runner handoff\\n'",
                    "--summary",
                    "handoff runner output",
                    "--cwd",
                    workspace,
                    "--timeout-seconds",
                    "9",
                    "--task-description",
                    "Check runner handoff output",
                ],
                capture_output=True,
                text=True,
                env=env,
                check=True,
            )
            subprocess.run(
                ["bash", str(RUNNER_LOOP)],
                capture_output=True,
                text=True,
                env={
                    **env,
                    "RUNNER_MAX_JOBS_PER_WORKER": "1",
                    "RUNNER_MAX_IDLE_SECONDS": "1",
                    "RUNNER_POLL_INTERVAL_SECONDS": "1",
                    "RUNNER_WORKER_ID": "test-runner-2",
                },
                check=True,
            )

            runner_results_dir = str(Path(workspace) / "tmp" / "octopus" / "runner-results")
            runner_queue_file = str(Path(workspace) / "tmp" / "octopus" / "runner-queue.json")
            shared_dir = str(Path(workspace) / "tmp" / "octopus" / "shared")
            with (
                patch.object(dispatch_task, "RUNNER_RESULTS_DIR", runner_results_dir),
                patch.object(dispatch_task, "RUNNER_QUEUE_FILE", runner_queue_file),
                patch.object(dispatch_task, "SHARED_DIR", shared_dir),
            ):
                wait = dispatch_task.wait_for_runner_result("runner-test-2", 2)
                handoff = dispatch_task.build_runner_handoff(
                    "Check runner handoff output",
                    {"job": {"id": "runner-test-2"}},
                    wait,
                )

            self.assertTrue(wait["completed"])
            self.assertEqual(wait["status"], "done")
            self.assertEqual(wait["summary"], "Runner completed · runner handoff")
            self.assertEqual(wait["execution_backend"], "runner_queue")
            self.assertTrue(wait["report_path"])
            self.assertTrue(Path(wait["report_path"]).exists())
            self.assertEqual(wait["worker_result"]["status"], "done")
            self.assertEqual(wait["worker_result"]["report"], wait["report_path"])
            self.assertEqual(handoff["status"], "success")
            self.assertEqual(handoff["report_path"], wait["report_path"])
            self.assertEqual(handoff["execution_backend"], "runner_queue")
            self.assertEqual(handoff["worker_result"]["status"], "done")
            self.assertIn("Runner completed", handoff["summary"])
            self.assertIn("runner handoff", handoff["reply_text"])

    def test_explicit_log_file_probe_keeps_tail_command_and_count(self) -> None:
        payload = runner_playbooks.infer_runner_playbook("tail -80 /var/log/nginx/error.log")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["kind"], "local_file_probe")
        self.assertEqual(payload["command"], "tail -n 80 /var/log/nginx/error.log")

    def test_implicit_nginx_error_log_probe_uses_file_tail(self) -> None:
        payload = runner_playbooks.infer_runner_playbook("检查一下 nginx error log 最近 80 行，然后总结问题")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["kind"], "local_file_probe")
        self.assertEqual(payload["command"], "tail -n 80 /var/log/nginx/error.log")
        self.assertEqual(payload["probe_spec"]["path"], "/var/log/nginx/error.log")
        self.assertEqual(payload["probe_spec"]["line_count"], 80)

    def test_scheduler_health_probe_handles_cron_question(self) -> None:
        payload = runner_playbooks.infer_runner_playbook("我的cron都正常吗")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["kind"], "scheduler_health")
        self.assertIn("crontab -l", payload["command"])
        self.assertIn("systemctl list-timers", payload["command"])
        self.assertEqual(payload["probe_spec"]["checks"], ["crontab", "systemd_timers"])

    def test_dispatch_runner_reuses_precomputed_runner_plan(self) -> None:
        args = importlib.import_module("argparse").Namespace(
            task="检查一下 nginx error log 最近 80 行，然后总结问题",
            command="",
            summary="",
            cwd="/tmp",
            timeout_seconds=30,
            id="runner-precomputed-1",
            model_band="fast",
            wait=False,
            wait_timeout_seconds=12,
            _policy_decision={
                "request": {"metadata": {}, "session_key": "agent:main:slack:direct:u999"},
                "route_decision": {"route": "runner"},
            },
            _runner_playbook={
                "kind": "local_file_probe",
                "summary": "查看 nginx error log 最近 80 行",
                "command": "tail -n 80 /var/log/nginx/error.log",
                "probe_spec": {
                    "kind": "local_file_probe",
                    "path": "/var/log/nginx/error.log",
                    "mode": "tail",
                    "line_count": 80,
                },
            },
        )

        proc = type("Proc", (), {"returncode": 0, "stdout": json.dumps({"id": "runner-precomputed-1", "status": "queued"}), "stderr": ""})()
        with patch.object(dispatch_task, "infer_runner_playbook", side_effect=AssertionError("should not infer twice")), patch.object(
            dispatch_task.subprocess,
            "run",
            return_value=proc,
        ):
            payload = dispatch_task.dispatch_runner(args)

        self.assertEqual(payload["job"]["id"], "runner-precomputed-1")
        self.assertEqual(payload["runner_plan"]["probe_spec"]["path"], "/var/log/nginx/error.log")
        self.assertEqual(payload["playbook"]["command"], "tail -n 80 /var/log/nginx/error.log")

    def test_find_reusable_job_requires_same_command_not_same_description(self) -> None:
        with patch.object(
            runner_dispatch,
            "load_json",
            return_value={
                "jobs": [
                    {
                        "id": "runner-old",
                        "status": "done",
                        "finished_at": "2026-04-01T20:55:09+08:00",
                        "command": "journalctl -u nginx -n 40 --no-pager || true",
                        "task_description": "检查一下 nginx error log 最近 80 行，然后总结问题",
                    }
                ]
            },
        ), patch.object(
            runner_dispatch,
            "recent_minutes",
            return_value=1.0,
        ):
            reusable = runner_dispatch.find_reusable_job("tail -n 80 /var/log/nginx/error.log")

        self.assertIsNone(reusable)


if __name__ == "__main__":
    unittest.main()
