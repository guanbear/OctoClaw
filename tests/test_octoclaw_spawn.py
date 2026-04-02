#!/usr/bin/env python3
import importlib
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

octoclaw_spawn = importlib.import_module("octoclaw_spawn")


class OctoClawSpawnTests(unittest.TestCase):
    def test_derive_spawn_session_keys_prefers_clawteam_session(self) -> None:
        keys = octoclaw_spawn.derive_spawn_session_keys("octoclaw-validation", "octo-research-1")
        self.assertEqual(
            keys,
            [
                "agent:main:clawteam-octoclaw-validation-octo-research-1",
                "agent:main:octo-research-1",
                "clawteam-octoclaw-validation-octo-research-1",
            ],
        )

    def test_build_clawteam_spawn_command_omits_unsupported_spawn_options(self) -> None:
        with patch.object(octoclaw_spawn, "clawteam_spawn_supports_option", return_value=False):
            command = octoclaw_spawn.build_clawteam_spawn_command(
                team_name="octoclaw-validation",
                agent_name="octo-research-1",
                prompt="do the work",
                profile="writer",
                thinking="medium",
            )

        self.assertNotIn("--profile", command)
        self.assertNotIn("--thinking", command)
        self.assertIn("--task", command)
        task_prompt = command[command.index("--task") + 1]
        self.assertIn("preferred_profile: writer", task_prompt)
        self.assertIn("reasoning_effort: medium", task_prompt)

    def test_register_failed_spawn_task_writes_failure_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            report_path = str(Path(tmpdir) / "spawn-failure.md")
            with (
                patch.object(octoclaw_spawn, "register_dispatched_task"),
                patch.object(octoclaw_spawn.subprocess, "run"),
            ):
                octoclaw_spawn.register_failed_spawn_task(
                    task_id="research-123",
                    model="zhipu/GLM-4.7",
                    model_band="heavy",
                    task="Summarize the delegated research results",
                    route="spawn_single",
                    runtime="subagent",
                    parent_id="",
                    report_path=report_path,
                    context_path="",
                    context_summary="",
                    worker_pool="octoclaw-research",
                    work_type="research",
                    phase="report",
                    protocol="heavy",
                    profile="writer",
                    review_required=True,
                    task_kind="subtask",
                    summary="spawn启动失败：No such option: --profile",
                )

            content = Path(report_path).read_text(encoding="utf-8")
            self.assertIn("# OctoClaw Spawn Failure", content)
            self.assertIn("research-123", content)
            self.assertIn("No such option: --profile", content)

    def test_build_spawn_spec_keeps_worker_pool_first_metadata(self) -> None:
        policy = {
            "route_decision": {
                "route": "spawn_single",
                "worker_pool": "octoclaw-research",
                "work_type": "research",
                "phase": "report",
                "protocol": "normal",
            },
            "model_policy": {
                "model_band": "normal",
                "selector_band": "standard",
                "profile": "writer",
            },
            "skill_policy": {
                "default_skill_bundle": [],
            },
            "review_policy": {
                "required": False,
            },
        }

        with (
            patch.object(octoclaw_spawn, "resolve_model_and_thinking", return_value=("model/writer", "minimal")),
            patch.object(octoclaw_spawn, "should_execute_spawn", return_value=False),
        ):
            spec = octoclaw_spawn.build_spawn_spec(
                "Write a concise release summary for the latest patch",
                route="spawn_single",
                register=False,
                execute=False,
                policy_decision=policy,
            )

        self.assertEqual(spec["worker_pool"], "octoclaw-research")
        self.assertEqual(spec["work_type"], "research")
        self.assertEqual(spec["phase"], "report")
        self.assertEqual(spec["profile"], "writer")
        self.assertEqual(spec["model_band"], "normal")
        self.assertEqual(spec["selector_band"], "standard")
        self.assertEqual(spec["brief"]["schema_version"], "octoclaw.brief/v1")
        self.assertEqual(spec["brief"]["expected_output"]["schema_version"], "octoclaw.worker_result/v1")
        self.assertEqual(spec["brief"]["context_pack"]["schema_version"], "octoclaw.context_pack/v1")
        self.assertEqual(spec["result_contract"]["status"], "done")
        self.assertIn("\"next_step\":", spec["task_prompt"])
        self.assertIn("\"risks\": []", spec["task_prompt"])
        self.assertIn(str(octoclaw_spawn.TASK_STATE_PY), spec["task_prompt"])
        self.assertIn(" blocked --id ", spec["task_prompt"])
        self.assertIn(" checklist --id ", spec["task_prompt"])
        self.assertNotIn("/workspace/openclaw/skills/octopus/lib/task-state-update.py", spec["task_prompt"])
        self.assertEqual(spec["spawn_prompt_path"], "")

    def test_prepare_spawn_prompt_externalizes_long_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            long_prompt = "A" * 2500
            with patch.object(octoclaw_spawn, "CONTEXT_DIR", tmpdir):
                bootstrap, prompt_path = octoclaw_spawn.prepare_spawn_prompt(
                    task_id="research-1",
                    prompt=long_prompt,
                    report_path="/tmp/report.md",
                    context_path="/tmp/context.md",
                )
                self.assertTrue(prompt_path.endswith("research-1.spawn-prompt.md"))
                self.assertIn("First read the full task contract", bootstrap)
                self.assertIn(prompt_path, bootstrap)
                self.assertIn("/tmp/report.md", bootstrap)
                self.assertEqual(Path(prompt_path).read_text(encoding="utf-8"), long_prompt)

    def test_execute_clawteam_spawn_applies_session_model_override(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["clawteam"],
            returncode=0,
            stdout='{"sessionKey":"agent:main:octo-research-1","sessionId":"child-sess-1","runId":"run-1","taskId":"native-task-1","parentFlowId":"flow-1"}',
            stderr="",
        )
        with (
            patch.object(octoclaw_spawn.shutil, "which", return_value="/usr/bin/mock"),
            patch.object(octoclaw_spawn, "build_clawteam_spawn_command", return_value=["clawteam", "spawn"]),
            patch.object(octoclaw_spawn.subprocess, "run", return_value=completed),
            patch.object(
                octoclaw_spawn,
                "apply_spawn_session_model_override",
                return_value={
                    "applied": True,
                    "session_key": "agent:main:clawteam-octoclaw-validation-octo-research-1",
                    "status_code": 200,
                    "error": "",
                },
            ) as override_mock,
        ):
            payload = octoclaw_spawn.execute_clawteam_spawn(
                task_id="research-1",
                worker_pool="octoclaw-research",
                model="zhipu/GLM-4.7",
                model_band="normal",
                prompt="do the work",
                thinking="medium",
                profile_override="research",
            )

        self.assertTrue(payload["model_override_applied"])
        self.assertEqual(payload["session_key"], "agent:main:clawteam-octoclaw-validation-octo-research-1")
        self.assertEqual(payload["child_session_key"], "agent:main:octo-research-1")
        self.assertEqual(payload["session_id"], "child-sess-1")
        self.assertEqual(payload["run_id"], "run-1")
        self.assertEqual(payload["native_task_id"], "native-task-1")
        self.assertEqual(payload["native_flow_id"], "flow-1")
        self.assertEqual(payload["model_override_status"], 200)
        override_mock.assert_called_once_with(
            team_name="octoclaw-validation",
            agent_name="octo-research-1",
            model="zhipu/GLM-4.7",
        )

    def test_build_spawn_spec_backfills_child_session_facts_after_spawn(self) -> None:
        policy = {
            "route_decision": {
                "route": "spawn_single",
                "worker_pool": "octoclaw-research",
                "work_type": "research",
                "phase": "collect",
                "protocol": "normal",
            },
            "model_policy": {
                "profile": "research",
            },
            "skill_policy": {
                "default_skill_bundle": [],
            },
            "review_policy": {
                "required": False,
            },
        }
        subprocess_calls = []

        def _fake_run(cmd, *args, **kwargs):
            subprocess_calls.append(cmd)
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with (
            patch.object(octoclaw_spawn, "resolve_model_and_thinking", return_value=("model/research", "medium")),
            patch.object(octoclaw_spawn, "should_execute_spawn", return_value=True),
            patch.object(octoclaw_spawn, "prepare_spawn_prompt", return_value=("prompt", "")),
            patch.object(
                octoclaw_spawn,
                "execute_clawteam_spawn",
                return_value={
                    "backend": "clawteam",
                    "team_name": "octoclaw-validation",
                    "agent_name": "octo-research-1",
                    "profile": "research",
                    "thinking": "medium",
                    "session_key": "agent:main:clawteam-octoclaw-validation-octo-research-1",
                    "child_session_key": "agent:main:octo-research-1",
                    "session_id": "child-sess-2",
                    "run_id": "run-2",
                    "native_task_id": "native-task-2",
                    "native_flow_id": "flow-2",
                    "model_override_applied": True,
                    "model_override_status": 200,
                    "model_override_error": "",
                },
            ),
            patch.object(octoclaw_spawn.subprocess, "run", side_effect=_fake_run),
        ):
            spec = octoclaw_spawn.build_spawn_spec(
                "Research provider docs and summarize the key changes",
                route="spawn_single",
                register=False,
                execute=True,
                policy_decision=policy,
            )

        self.assertEqual(spec["spawn_execution"]["session_id"], "child-sess-2")
        self.assertEqual(spec["spawn_execution"]["run_id"], "run-2")
        self.assertEqual(spec["spawn_execution"]["native_task_id"], "native-task-2")
        upsert_cmd = subprocess_calls[-1]
        self.assertIn("--session-id", upsert_cmd)
        self.assertIn("child-sess-2", upsert_cmd)
        self.assertIn("--run-id", upsert_cmd)
        self.assertIn("run-2", upsert_cmd)

    def test_build_spawn_spec_does_not_need_legacy_inputs_when_taxonomy_exists(self) -> None:
        policy = {
            "route_decision": {
                "route": "spawn_single",
                "worker_pool": "octoclaw-code",
                "work_type": "code",
                "phase": "implement",
                "protocol": "normal",
            },
            "model_policy": {
                "profile": "code",
            },
            "skill_policy": {
                "default_skill_bundle": [],
            },
            "review_policy": {
                "required": False,
            },
        }

        with (
            patch.object(octoclaw_spawn, "resolve_model_and_thinking", return_value=("model/code", "medium")) as resolve_mock,
            patch.object(octoclaw_spawn, "should_execute_spawn", return_value=False),
        ):
            spec = octoclaw_spawn.build_spawn_spec(
                "Fix the login API bug and add a regression test",
                route="spawn_single",
                register=False,
                execute=False,
                policy_decision=policy,
            )

        self.assertEqual(spec["worker_pool"], "octoclaw-code")
        self.assertEqual(spec["work_type"], "code")
        self.assertEqual(spec["phase"], "implement")
        self.assertEqual(spec["profile"], "code")
        self.assertEqual(spec["model_band"], "strong")
        self.assertEqual(spec["selector_band"], "strong")
        self.assertEqual(spec["model"], "model/code")
        self.assertEqual(
            resolve_mock.call_args.kwargs,
            {
                "worker_pool": "octoclaw-code",
                "phase": "implement",
                "route": "spawn_single",
                "profile": "code",
            },
        )


if __name__ == "__main__":
    unittest.main()
