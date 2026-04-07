#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import sys

sys.path.insert(0, str((Path(__file__).resolve().parents[1] / "lib")))
from octoclaw_policy import build_decision, route_hint_required


REPO_ROOT = Path(__file__).resolve().parents[1]
POLICY_SCRIPT = REPO_ROOT / "lib" / "octoclaw_policy.py"
ROUTE_SCRIPT = REPO_ROOT / "lib" / "octoclaw_route.py"


class RuntimePolicyTests(unittest.TestCase):
    def write_runtime_config(
        self,
        workspace: str,
        *,
        route_language_packs: Optional[list[str]] = None,
        sticky_lane_enabled: Optional[bool] = None,
    ) -> None:
        runtime_policy: dict[str, object] = {}
        if route_language_packs is not None:
            runtime_policy["route_language_packs"] = {
                "enabled": route_language_packs,
            }
        if sticky_lane_enabled is not None:
            runtime_policy["route_stickiness"] = {
                "enabled": sticky_lane_enabled,
                "ack_followup_enabled": True,
            }
            runtime_policy["switches"] = {
                "route_hint_required": True,
            }
        config: dict[str, object] = {"runtime_policy": runtime_policy} if runtime_policy else {}
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
        sticky_work_contract: str = "",
        sticky_applied_count: int = 0,
        route_language_packs: Optional[list[str]] = None,
        model_policy: Optional[dict[str, object]] = None,
    ) -> dict:
        with tempfile.TemporaryDirectory(prefix="octoclaw-policy-test-") as workspace:
            os.makedirs(Path(workspace) / "tmp" / "octopus", exist_ok=True)
            self.write_runtime_config(
                workspace,
                route_language_packs=route_language_packs,
                sticky_lane_enabled=True if sticky_route else None,
            )
            if model_policy is not None:
                self.write_model_policy(workspace, model_policy)
            if sticky_route:
                payload = {
                    session_key: {
                        "route": sticky_route,
                        "work_type": sticky_work_type,
                        "work_contract": sticky_work_contract,
                        "applied_count": sticky_applied_count,
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
        self.assertEqual(payload["route_decision"]["work_contract"], "deliverable_work")
        self.assertEqual(payload["route_decision"]["work_type"], "research")
        self.assertEqual(payload["route_decision"]["phase"], "report")
        self.assertEqual(payload["route_decision"]["reason"], "route_sticky_lane:spawn_single")
        self.assertTrue(payload["route_hint_policy"]["sticky_applied"])
        self.assertEqual(payload["route_hint_policy"]["source"], "sticky_lane")
        self.assertEqual(payload["route_hint_policy"]["sticky_route"], "spawn_single")
        self.assertEqual(payload["route_hint_policy"]["sticky_work_contract"], "")
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
        self.assertEqual(payload["route_decision"]["work_contract"], "coordinated_work")
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
        self.assertEqual(payload["route_decision"]["work_contract"], "deliverable_work")
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
        self.assertEqual(payload["route_decision"]["work_contract"], "coordinated_work")
        self.assertEqual(payload["route_decision"]["reason"], "route_ack_followup_inherit:spawn_multi")
        self.assertTrue(payload["route_hint_policy"]["sticky_applied"])
        self.assertTrue(payload["route_hint_policy"]["ack_followup_candidate"])
        self.assertTrue(payload["route_hint_policy"]["ack_followup_applied"])

    def test_ack_followup_sticky_lane_suppresses_route_hint_requirement(self) -> None:
        payload = self.run_policy(
            "好",
            session_key="demo",
            sticky_route="spawn_single",
            sticky_work_type="research",
            sticky_work_contract="deliverable_work",
        )
        self.assertFalse(payload["route_hint_policy"]["required"])
        self.assertIn("route_hint_suppressed:sticky_lane", payload["route_hint_policy"]["merge_notes"])

    def test_ack_followup_without_sticky_lane_stays_non_runner_and_unapplied(self) -> None:
        payload = self.run_policy("好")
        self.assertTrue(payload["route_hint_policy"]["ack_followup_candidate"])
        self.assertFalse(payload["route_hint_policy"]["sticky_applied"])
        self.assertFalse(payload["route_hint_policy"]["ack_followup_applied"])
        self.assertNotEqual(payload["route_decision"]["route"], "runner")

    def test_sticky_goal_shift_blocks_inherit_when_contract_changes(self) -> None:
        payload = self.run_policy(
            "继续，补个测试",
            session_key="demo",
            sticky_route="spawn_multi",
            sticky_work_type="research",
            sticky_work_contract="coordinated_work",
        )
        self.assertEqual(payload["route_decision"]["route"], "spawn_single")
        self.assertEqual(payload["route_decision"]["reason"], "route_sticky_goal_shift:coordinated_work_to_deliverable_work")
        self.assertFalse(payload["route_hint_policy"]["sticky_applied"])
        self.assertTrue(payload["route_hint_policy"]["sticky_goal_shift_blocked"])

    def test_sticky_decay_blocks_after_max_apply_count(self) -> None:
        payload = self.run_policy(
            "继续，顺手写一版发布说明",
            session_key="demo",
            sticky_route="spawn_single",
            sticky_work_type="code",
            sticky_work_contract="deliverable_work",
            sticky_applied_count=3,
        )
        self.assertEqual(payload["route_decision"]["route"], "spawn_single")
        self.assertEqual(payload["route_decision"]["reason"], "route_sticky_decay_blocked:spawn_single")
        self.assertFalse(payload["route_hint_policy"]["sticky_applied"])
        self.assertTrue(payload["route_hint_policy"]["sticky_decay_blocked"])

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
        self.assertEqual(payload["work_contract_hint"], "deliverable_work")
        self.assertTrue(payload["features"]["requires_research"])
        self.assertTrue(payload["features"]["requires_writing"])

    def test_github_update_lookup_routes_to_research_instead_of_code(self) -> None:
        payload = self.run_policy(
            "查一下 OctoClaw 项目在 GitHub 上今天（2026-04-07）有更新吗",
            model_policy={
                "generated_at": "2026-04-07T00:00:00Z",
                "main_model": "omniroute/cx/gpt-5.4",
                "worker_pools": {
                    "octoclaw-code": "omniroute/cx/gpt-5.4",
                    "octoclaw-research": "minimax-portal/MiniMax-M2.7-highspeed",
                },
                "worker_pool_phases": {
                    "octoclaw-code": {"implement": "omniroute/cx/gpt-5.4"},
                    "octoclaw-research": {"collect": "minimax-portal/MiniMax-M2.7-highspeed"},
                },
            },
        )
        self.assertEqual(payload["route_decision"]["route"], "spawn_single")
        self.assertEqual(payload["route_decision"]["worker_pool"], "octoclaw-research")
        self.assertEqual(payload["route_decision"]["work_type"], "research")
        self.assertEqual(payload["route_decision"]["phase"], "collect")
        self.assertFalse(payload["request"]["metadata"])
        self.assertEqual(payload["model_policy"]["selected_model"], "minimax-portal/MiniMax-M2.7-highspeed")
        self.assertNotIn("mutation_work", payload["route_decision"]["reason_codes"])
        self.assertEqual(payload["route_recommendation"]["schema_version"], "octoclaw.route_recommendation/v1")
        self.assertTrue(payload["route_recommendation"]["arbitration"]["required"])
        self.assertEqual(payload["route_recommendation"]["arbitration"]["strategy"], "rule_fallback")
        self.assertEqual(payload["route_recommendation"]["arbitration"]["conflict_type"], "repo_activity_lookup")
        self.assertEqual(payload["route_recommendation"]["recommended_route"], "spawn_single")
        self.assertTrue(payload["pre_dispatch_ack"]["required"])
        self.assertIn("查一下", payload["pre_dispatch_ack"]["text"])

    def test_spawn_single_requires_pre_dispatch_ack(self) -> None:
        payload = self.run_policy("调研三个兼容方案并写一版简短建议")
        self.assertTrue(payload["pre_dispatch_ack"]["required"])
        self.assertEqual(payload["pre_dispatch_ack"]["style"], "brief_status")
        self.assertTrue(payload["pre_dispatch_ack"]["channel_delivery_preferred"])

    def test_direct_route_does_not_require_pre_dispatch_ack(self) -> None:
        payload = self.run_policy("八爪鱼状态")
        self.assertFalse(payload["pre_dispatch_ack"]["required"])
        self.assertEqual(payload["pre_dispatch_ack"]["text"], "")

    def test_route_outputs_new_taxonomy_hints(self) -> None:
        payload = self.run_route("调研三个兼容方案并写一版简短建议")
        self.assertEqual(payload["work_contract_hint"], "deliverable_work")
        self.assertEqual(payload["worker_pool_hint"], "octoclaw-research")
        self.assertEqual(payload["work_type_hint"], "research")
        self.assertEqual(payload["phase_hint"], "report")
        self.assertEqual(payload["model_band_hint"], "normal")
        self.assertNotIn("role_hint", payload)
        self.assertNotIn("tier_hint", payload)

    def test_inspect_plus_summary_prefers_spawn_single_over_soft_runner_bias(self) -> None:
        payload = self.run_route("检查一下 nginx 日志里最近有什么异常，并给我一个简短总结")
        self.assertEqual(payload["work_contract_hint"], "inspect_report")
        self.assertEqual(payload["system_preferred_route"], "spawn_single")
        self.assertNotEqual(payload["system_preferred_route"], "runner")

    def test_explicit_log_tail_probe_prefers_runner(self) -> None:
        payload = self.run_route("检查一下 nginx error log 最近 80 行，然后总结问题")
        self.assertEqual(payload["work_contract_hint"], "inspect_report")
        self.assertEqual(payload["system_preferred_route"], "runner")
        self.assertTrue(payload["features"]["tool_observation_only"])

    def test_cron_health_question_prefers_runner(self) -> None:
        payload = self.run_route("我的cron都正常吗")
        self.assertEqual(payload["system_preferred_route"], "runner")
        self.assertEqual(payload["work_contract_hint"], "inspect_report")
        self.assertTrue(payload["features"]["tool_observation_only"])

    def test_octoclaw_status_prefers_direct_control_lane(self) -> None:
        payload = self.run_route("八爪鱼状态")
        self.assertEqual(payload["system_preferred_route"], "direct")
        self.assertEqual(payload["work_contract_hint"], "answer_now")
        self.assertTrue(payload["features"]["observer_control_candidate"])
        self.assertEqual(payload["task_class"], "control_observer")

    def test_short_progress_query_prefers_direct_control_lane(self) -> None:
        payload = self.run_route("好了吗")
        self.assertEqual(payload["system_preferred_route"], "direct")
        self.assertEqual(payload["work_contract_hint"], "answer_now")
        self.assertTrue(payload["features"]["observer_control_candidate"])
        self.assertTrue(payload["features"]["task_progress_candidate"])
        self.assertEqual(payload["task_class"], "control_observer")

    def test_short_ping_stays_plain_direct_answer(self) -> None:
        payload = self.run_route("在吗")
        self.assertEqual(payload["system_preferred_route"], "direct")
        self.assertFalse(payload["features"]["observer_control_candidate"])
        self.assertFalse(payload["features"]["task_progress_candidate"])
        self.assertEqual(payload["task_class"], "direct_answer")

    def test_control_observer_policy_only_allows_control_tools(self) -> None:
        payload = self.run_policy("八爪鱼状态")
        self.assertEqual(payload["route_decision"]["route"], "direct")
        self.assertEqual(payload["route_decision"]["task_class"], "control_observer")
        self.assertFalse(payload["tool_policy"]["allow_direct_tools"])
        self.assertTrue(payload["tool_policy"]["control_observer_only"])
        self.assertEqual(
            payload["tool_policy"]["observer_control_tools"],
            ["octoclaw_policy_decide", "octoclaw_route_hint", "octoclaw_status", "octoclaw_task_action"],
        )

    def test_progress_query_control_policy_only_allows_control_tools(self) -> None:
        payload = self.run_policy("好了吗")
        self.assertEqual(payload["route_decision"]["route"], "direct")
        self.assertEqual(payload["route_decision"]["task_class"], "control_observer")
        self.assertFalse(payload["tool_policy"]["allow_direct_tools"])
        self.assertTrue(payload["tool_policy"]["control_observer_only"])

    def test_task_details_command_prefers_direct_control_lane(self) -> None:
        payload = self.run_route("details task-123")
        self.assertEqual(payload["system_preferred_route"], "direct")
        self.assertTrue(payload["features"]["observer_control_candidate"])
        self.assertFalse(payload["features"]["hard_runner_candidate"])

    def test_task_stop_command_prefers_direct_control_lane(self) -> None:
        payload = self.run_route("stop task-123")
        self.assertEqual(payload["system_preferred_route"], "direct")
        self.assertEqual(payload["task_class"], "control_observer")
        self.assertTrue(payload["features"]["observer_control_candidate"])
        self.assertFalse(payload["features"]["hard_runner_candidate"])

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
        self.assertEqual(payload["route_decision"]["work_contract"], "inspect_report")
        self.assertEqual(payload["model_policy"]["selected_model"], "model/profile-ops")
        self.assertEqual(payload["model_policy"]["profile"], "ops-fast")
        self.assertEqual(payload["model_policy"]["model_band"], "fast")
        self.assertEqual(payload["model_policy"]["selector_band"], "quick")
        self.assertEqual(payload["budget_policy"]["budget_cap"], "low")
        self.assertEqual(payload["budget_policy"]["max_workers"], 1)
        self.assertEqual(payload["prompt_contract"]["merge_contract"], "inspect_report")

    def test_force_route_runner_keeps_runner_as_final_route(self) -> None:
        payload = build_decision("检查接口健康状态和响应头", "printf ok", {}, force_route="runner")
        self.assertEqual(payload["route_decision"]["system_preferred_route"], "runner")
        self.assertEqual(payload["route_decision"]["route"], "runner")
        self.assertEqual(payload["route_decision"]["work_contract"], "inspect_report")
        self.assertEqual(payload["route_decision"]["worker_pool"], "octoclaw-runner")
        self.assertEqual(payload["model_policy"]["model_band"], "fast")

    def test_model_policy_tracks_worker_pool_first_without_legacy_compat_fields(self) -> None:
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
        self.assertEqual(payload["model_policy"]["selector_band"], "heavy")
        self.assertEqual(payload["model_policy"]["model_band"], "heavy")
        self.assertEqual(payload["model_policy"]["selected_model"], "model/profile-writer")
        self.assertEqual(payload["route_decision"]["work_contract"], "deliverable_work")
        self.assertEqual(payload["budget_policy"]["budget_cap"], "medium")
        self.assertEqual(payload["prompt_contract"]["handoff_contract"], "deliverable_handoff")
        self.assertNotIn("legacy_label", payload["model_policy"])

    def test_route_hint_not_required_for_clear_spawn_single_path(self) -> None:
        self.assertFalse(
            route_hint_required(
                {
                    "route": "spawn_single",
                    "system_preferred_route": "spawn_single",
                    "reason_codes": ["work_contract:deliverable_work", "research_work"],
                    "confidence": 0.82,
                    "score_margin": 0.46,
                    "work_contract_hint": "deliverable_work",
                    "needs_semantic_review": False,
                    "features": {"semantic_ambiguity_hits": 0},
                },
                "",
                {"switches": {"route_hint_required": True}},
            )
        )

    def test_route_hint_required_for_semantic_boundary(self) -> None:
        self.assertTrue(
            route_hint_required(
                {
                    "route": "spawn_single",
                    "system_preferred_route": "spawn_single",
                    "reason_codes": ["work_contract:deliverable_work", "research_work"],
                    "confidence": 0.74,
                    "score_margin": 0.18,
                    "work_contract_hint": "deliverable_work",
                    "needs_semantic_review": True,
                    "features": {"semantic_ambiguity_hits": 1},
                },
                "",
                {"switches": {"route_hint_required": True}},
            )
        )


if __name__ == "__main__":
    unittest.main()
