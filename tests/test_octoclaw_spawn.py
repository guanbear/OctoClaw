#!/usr/bin/env python3
import importlib
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
        self.assertIn("task-state-update.py blocked", spec["task_prompt"])
        self.assertIn("task-state-update.py checklist", spec["task_prompt"])

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
