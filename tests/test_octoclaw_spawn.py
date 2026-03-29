#!/usr/bin/env python3
import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

octoclaw_spawn = importlib.import_module("octoclaw_spawn")


class OctoClawSpawnTests(unittest.TestCase):
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
        self.assertEqual(spec["result_contract"]["status"], "done")
        self.assertIn("\"next_step\":", spec["task_prompt"])
        self.assertIn("\"risks\": []", spec["task_prompt"])

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
