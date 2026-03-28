#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
POLICY_SCRIPT = REPO_ROOT / "lib" / "octoclaw_policy.py"
ROUTE_SCRIPT = REPO_ROOT / "lib" / "octoclaw_route.py"


class RuntimePolicyTests(unittest.TestCase):
    def run_policy(self, task: str, *, session_key: str = "", sticky_route: str = "", sticky_work_type: str = "") -> dict:
        with tempfile.TemporaryDirectory(prefix="octoclaw-policy-test-") as workspace:
            os.makedirs(Path(workspace) / "tmp" / "octopus", exist_ok=True)
            if sticky_route:
                payload = {
                    session_key: {
                        "route": sticky_route,
                        "work_type": sticky_work_type,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }
                }
                with open(Path(workspace) / "tmp" / "octopus" / "route-stickiness.json", "w", encoding="utf-8") as fh:
                    json.dump(payload, fh)
            env = {**os.environ, "WORKSPACE": workspace}
            cmd = ["python3", str(POLICY_SCRIPT), "--task", task]
            if session_key:
                cmd.extend(["--session-key", session_key])
            result = subprocess.run(cmd, capture_output=True, text=True, env=env, check=True)
            return json.loads(result.stdout)

    def run_route(self, task: str) -> dict:
        result = subprocess.run(
            ["python3", str(ROUTE_SCRIPT), "--task", task],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_sticky_same_lane_marks_sticky_but_keeps_current_semantics(self) -> None:
        payload = self.run_policy(
            "继续，顺手写一版发布说明",
            session_key="demo",
            sticky_route="spawn_single",
            sticky_work_type="code",
        )
        self.assertEqual(payload["route_decision"]["route"], "spawn_single")
        self.assertEqual(payload["route_decision"]["work_type"], "research")
        self.assertEqual(payload["route_decision"]["phase"], "report")
        self.assertEqual(payload["route_decision"]["reason"], "route_sticky_lane:spawn_single")
        self.assertTrue(payload["route_hint_policy"]["sticky_applied"])
        self.assertEqual(payload["route_hint_policy"]["source"], "sticky_lane")
        self.assertEqual(payload["route_hint_policy"]["sticky_route"], "spawn_single")
        self.assertEqual(payload["route_hint_policy"]["sticky_work_type"], "")

    def test_sticky_different_lane_only_changes_route(self) -> None:
        payload = self.run_policy(
            "继续，补个测试",
            session_key="demo",
            sticky_route="spawn_multi",
            sticky_work_type="research",
        )
        self.assertEqual(payload["route_decision"]["system_preferred_route"], "spawn_single")
        self.assertEqual(payload["route_decision"]["route"], "spawn_multi")
        self.assertEqual(payload["route_decision"]["work_type"], "code")
        self.assertEqual(payload["route_decision"]["phase"], "implement")
        self.assertEqual(payload["route_decision"]["reason"], "route_sticky_lane:spawn_multi")
        self.assertTrue(payload["route_hint_policy"]["sticky_applied"])
        self.assertEqual(payload["route_hint_policy"]["source"], "sticky_lane")
        self.assertEqual(payload["route_hint_policy"]["sticky_route"], "spawn_multi")

    def test_release_notes_are_not_high_risk_but_production_release_is(self) -> None:
        notes_payload = self.run_route("继续，顺手写一版发布说明")
        self.assertFalse(notes_payload["features"]["high_risk"])
        self.assertNotIn("high_risk", notes_payload["reason_codes"])

        prod_payload = self.run_route("发布到生产环境前再检查一下鉴权配置")
        self.assertTrue(prod_payload["features"]["high_risk"])
        self.assertIn("high_risk", prod_payload["reason_codes"])

    def test_japanese_read_only_probe_routes_to_runner(self) -> None:
        payload = self.run_route("8080番ポートが開いているか確認して")
        self.assertEqual(payload["system_preferred_route"], "runner")
        self.assertTrue(payload["features"]["hard_runner_candidate"])

    def test_spanish_research_and_writing_routes_to_spawn_single(self) -> None:
        payload = self.run_route("Investiga tres gateways compatibles con OpenAI y escribe una recomendación breve")
        self.assertEqual(payload["system_preferred_route"], "spawn_single")
        self.assertTrue(payload["features"]["requires_research"])
        self.assertTrue(payload["features"]["requires_writing"])


if __name__ == "__main__":
    unittest.main()
