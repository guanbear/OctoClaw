#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import sys

REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from octoclaw_policy import build_decision
from auto_router import build_auto_router_payload, infer_policy_phase


AUTO_ROUTER_SCRIPT = REPO_ROOT / "lib" / "auto_router.py"


class AutoRouterTests(unittest.TestCase):
    def test_build_decision_includes_internal_auto_router_payload(self) -> None:
        decision = build_decision("检查一下 nginx error log 最近 80 行，然后总结问题")
        payload = decision["auto_router"]

        self.assertEqual(payload["schema_version"], "octoclaw.auto_router.recommendation/v1")
        self.assertTrue(payload["internal_first"])
        self.assertEqual(payload["router_core"]["route"], decision["route_decision"]["route"])
        self.assertIn(payload["router_core"]["route_class"], {"main_direct", "delegated_runner", "delegated_single", "delegated_multi", "control_observer", "session_control"})
        self.assertIn(payload["router_core"]["agent_scope"], {"main_agent", "runner_lane", "subagent_lane", "team_lane"})
        self.assertEqual(payload["router_core"]["work_contract"], decision["route_decision"]["work_contract"])
        self.assertEqual(payload["budget_planner"]["target_model"], decision["model_policy"]["selected_model"])
        self.assertEqual(payload["budget_planner"]["reasoning_mode"], decision["model_policy"]["reasoning_effort"])
        self.assertEqual(payload["adapter"]["policy_phase"], infer_policy_phase(decision["runtime_switches"]))
        self.assertEqual(payload["adapter"]["policy_phase"], payload["signal"]["feedback_signals"]["policy_phase"])
        self.assertTrue(payload["signal"]["request"]["task"])
        self.assertIn(payload["signal"]["contract"]["risk_level"], {"low", "medium", "high"})
        self.assertIn(decision["model_policy"]["selected_model"], payload["model_intel"]["candidate_models"])
        self.assertEqual(
            payload["model_intel"]["facts_plane"]["source_status_file"],
            payload["model_intel"]["source_files"]["source_status"],
        )
        self.assertIn("runtime", payload["model_intel"]["facts_plane"]["source_precedence"])

    def test_auto_router_cli_renders_recommendation_payload(self) -> None:
        result = subprocess.run(
            ["python3", str(AUTO_ROUTER_SCRIPT), "--task", "检查一下 nginx error log 最近 80 行，然后总结问题"],
            capture_output=True,
            text=True,
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["schema_version"], "octoclaw.auto_router.recommendation/v1")
        self.assertEqual(payload["router_core"]["route"], "runner")
        self.assertEqual(payload["router_core"]["work_contract"], "inspect_report")

    def test_auto_router_signal_preserves_route_hint_and_session_key(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-auto-router-") as workspace:
            env = {"WORKSPACE": workspace}
            result = subprocess.run(
                [
                    "python3",
                    str(AUTO_ROUTER_SCRIPT),
                    "--task",
                    "继续，补个测试",
                    "--metadata-json",
                    json.dumps({"session_key": "agent:main:slack:direct:u1", "channel": "slack"}),
                    "--route-hint-json",
                    json.dumps({"route_hint": "spawn_single", "work_type": "code", "phase": "implement"}),
                ],
                capture_output=True,
                text=True,
                check=True,
                env={**os.environ, **env},
            )
        payload = json.loads(result.stdout)
        self.assertEqual(payload["signal"]["request"]["session_key"], "agent:main:slack:direct:u1")
        self.assertEqual(payload["signal"]["continuity"]["route_hint"], "spawn_single")

    def test_auto_router_payload_stays_read_only_consumer_of_internal_decision_contracts(self) -> None:
        decision = build_decision("检查一下 nginx error log 最近 80 行，然后总结问题")
        decision["runtime_truth"] = {"route": "spawn_multi", "authority": "fake"}
        decision["route_decision"] = {
            **decision["route_decision"],
            "route": "runner",
            "work_contract": "inspect_report",
        }

        payload = build_auto_router_payload(decision)

        self.assertEqual(payload["schema_version"], "octoclaw.auto_router.recommendation/v1")
        self.assertEqual(payload["router_core"]["route"], "runner")
        self.assertEqual(payload["router_core"]["work_contract"], "inspect_report")
        self.assertNotIn("runtime_truth", payload)
        self.assertNotIn("dispatch", payload)


if __name__ == "__main__":
    unittest.main()
