#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
POLICY_SCRIPT = REPO_ROOT / "lib" / "octoclaw_policy.py"
ROUTE_SCRIPT = REPO_ROOT / "lib" / "octoclaw_route.py"


class RuntimePolicyTests(unittest.TestCase):
    def write_runtime_config(self, workspace: str, *, route_language_packs: Optional[list[str]] = None) -> None:
        config: dict[str, object] = {}
        if route_language_packs is not None:
            config = {
                "runtime_policy": {
                    "route_language_packs": {
                        "enabled": route_language_packs,
                    }
                }
            }
        if config:
            with open(Path(workspace) / "tmp" / "octopus-config.json", "w", encoding="utf-8") as fh:
                json.dump(config, fh)

    def write_model_policy(self, workspace: str, payload: dict[str, object]) -> None:
        policy_path = Path(workspace) / "tmp" / "octopus" / "model-policy.json"
        policy_path.parent.mkdir(parents=True, exist_ok=True)
        with open(policy_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)

    def run_policy(
        self,
        task: str,
        *,
        session_key: str = "",
        sticky_route: str = "",
        sticky_work_type: str = "",
        route_language_packs: Optional[list[str]] = None,
        model_policy: Optional[dict[str, object]] = None,
    ) -> dict:
        with tempfile.TemporaryDirectory(prefix="octoclaw-policy-test-") as workspace:
            os.makedirs(Path(workspace) / "tmp" / "octopus", exist_ok=True)
            self.write_runtime_config(workspace, route_language_packs=route_language_packs)
            if model_policy is not None:
                self.write_model_policy(workspace, model_policy)
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

    def run_route(self, task: str, *, route_language_packs: Optional[list[str]] = None) -> dict:
        with tempfile.TemporaryDirectory(prefix="octoclaw-route-test-") as workspace:
            os.makedirs(Path(workspace) / "tmp" / "octopus", exist_ok=True)
            self.write_runtime_config(workspace, route_language_packs=route_language_packs)
            env = {**os.environ, "WORKSPACE": workspace}
            result = subprocess.run(
                ["python3", str(ROUTE_SCRIPT), "--task", task],
                capture_output=True,
                text=True,
                env=env,
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

    def test_ack_followup_short_confirmation_inherits_spawn_single_lane(self) -> None:
        payload = self.run_policy(
            "好",
            session_key="demo",
            sticky_route="spawn_single",
            sticky_work_type="code",
        )
        self.assertEqual(payload["route_decision"]["route"], "spawn_single")
        self.assertEqual(payload["route_decision"]["reason"], "route_ack_followup_inherit:spawn_single")
        self.assertTrue(payload["route_hint_policy"]["sticky_applied"])
        self.assertTrue(payload["route_hint_policy"]["ack_followup_candidate"])
        self.assertTrue(payload["route_hint_policy"]["ack_followup_applied"])
        self.assertEqual(payload["route_hint_policy"]["source"], "sticky_lane")

    def test_ack_followup_english_confirmation_inherits_spawn_multi_lane(self) -> None:
        payload = self.run_policy(
            "go ahead",
            session_key="demo",
            sticky_route="spawn_multi",
            sticky_work_type="research",
        )
        self.assertEqual(payload["route_decision"]["route"], "spawn_multi")
        self.assertEqual(payload["route_decision"]["reason"], "route_ack_followup_inherit:spawn_multi")
        self.assertTrue(payload["route_hint_policy"]["sticky_applied"])
        self.assertTrue(payload["route_hint_policy"]["ack_followup_candidate"])
        self.assertTrue(payload["route_hint_policy"]["ack_followup_applied"])

    def test_ack_followup_without_sticky_lane_stays_non_runner_and_unapplied(self) -> None:
        payload = self.run_policy("好")
        self.assertTrue(payload["route_hint_policy"]["ack_followup_candidate"])
        self.assertFalse(payload["route_hint_policy"]["sticky_applied"])
        self.assertFalse(payload["route_hint_policy"]["ack_followup_applied"])
        self.assertNotEqual(payload["route_decision"]["route"], "runner")

    def test_release_notes_are_not_high_risk_but_production_release_is(self) -> None:
        notes_payload = self.run_route("继续，顺手写一版发布说明")
        self.assertFalse(notes_payload["features"]["high_risk"])
        self.assertNotIn("high_risk", notes_payload["reason_codes"])

        prod_payload = self.run_route("发布到生产环境前再检查一下鉴权配置")
        self.assertTrue(prod_payload["features"]["high_risk"])
        self.assertIn("high_risk", prod_payload["reason_codes"])

    def test_default_language_packs_are_zh_and_en_only(self) -> None:
        payload = self.run_route("8080番ポートが開いているか確認して")
        self.assertEqual(payload["route_language_packs"], ["zh", "en"])
        self.assertFalse(payload["features"]["hard_runner_candidate"])
        self.assertNotEqual(payload["system_preferred_route"], "runner")

    def test_japanese_read_only_probe_routes_to_runner_when_ja_pack_enabled(self) -> None:
        payload = self.run_route("8080番ポートが開いているか確認して", route_language_packs=["zh", "en", "ja"])
        self.assertEqual(payload["route_language_packs"], ["zh", "en", "ja"])
        self.assertEqual(payload["system_preferred_route"], "runner")
        self.assertTrue(payload["features"]["hard_runner_candidate"])

    def test_spanish_research_and_writing_routes_to_spawn_single(self) -> None:
        payload = self.run_route(
            "Investiga tres gateways compatibles con OpenAI y escribe una recomendación breve",
            route_language_packs=["zh", "en", "es"],
        )
        self.assertEqual(payload["route_language_packs"], ["zh", "en", "es"])
        self.assertEqual(payload["system_preferred_route"], "spawn_single")
        self.assertTrue(payload["features"]["requires_research"])
        self.assertTrue(payload["features"]["requires_writing"])

    def test_route_outputs_new_taxonomy_hints(self) -> None:
        payload = self.run_route("调研三个兼容方案并写一版简短建议")
        self.assertEqual(payload["worker_pool_hint"], "octoclaw-research")
        self.assertEqual(payload["work_type_hint"], "research")
        self.assertEqual(payload["phase_hint"], "report")
        self.assertEqual(payload["model_band_hint"], "normal")
        self.assertEqual(payload["role_hint"], "octopus-writer")
        self.assertEqual(payload["tier_hint"], "normal")

    def test_runner_policy_uses_workspace_local_model_policy(self) -> None:
        payload = self.run_policy(
            "看下 8080 端口开了没",
            model_policy={
                "generated_at": "2026-03-29T00:00:00Z",
                "main_model": "model/main",
                "profiles": {"ops-fast": "model/profile-ops"},
                "worker_pools": {"octoclaw-runner": "model/runner"},
                "worker_pool_phases": {"octoclaw-runner": {"inspect": "model/runner-inspect"}},
            },
        )
        self.assertEqual(payload["route_decision"]["route"], "runner")
        self.assertEqual(payload["route_decision"]["worker_pool"], "octoclaw-runner")
        self.assertEqual(payload["model_policy"]["selected_model"], "model/profile-ops")
        self.assertEqual(payload["model_policy"]["profile"], "ops-fast")
        self.assertEqual(payload["model_policy"]["tier"], "fast")
        self.assertEqual(payload["model_policy"]["selector_tier"], "trivial")

    def test_model_policy_tracks_worker_pool_first_with_legacy_label_as_compat(self) -> None:
        payload = self.run_policy(
            "调研三个兼容方案并写一版简短建议",
            model_policy={
                "generated_at": "2026-03-29T00:00:00Z",
                "main_model": "model/main",
                "profiles": {"writer": "model/profile-writer"},
                "worker_pools": {"octoclaw-research": "model/research"},
                "worker_pool_phases": {"octoclaw-research": {"report": "model/research-report"}},
            },
        )
        self.assertEqual(payload["route_decision"]["worker_pool"], "octoclaw-research")
        self.assertEqual(payload["model_policy"]["worker_pool"], "octoclaw-research")
        self.assertEqual(payload["model_policy"]["model_selector_role"], "writer")
        self.assertEqual(payload["model_policy"]["selector_tier"], "deep")
        self.assertEqual(payload["model_policy"]["tier"], "heavy")
        self.assertEqual(payload["model_policy"]["selected_model"], "model/profile-writer")
        self.assertEqual(payload["model_policy"]["legacy_label"], "octopus-writer")


if __name__ == "__main__":
    unittest.main()
