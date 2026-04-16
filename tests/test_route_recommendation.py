#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LIB_DIR = REPO_ROOT / "lib"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from lib import budget_recommendation, route_recommendation


class RouteRecommendationTests(unittest.TestCase):
    def test_budget_recommendation_unknown_route_is_not_marked_consistent(self) -> None:
        payload = budget_recommendation.build_budget_recommendation(
            budget_policy={
                "budget_cap": "medium",
                "latency_target": "background",
                "max_workers": 0,
                "retry_cap": 1,
            },
            model_policy={"selected_model": "zhipu/GLM-5.1"},
            route="mystery_route",
        )

        self.assertFalse(payload["consistency"]["route_matches_worker_budget"])
        self.assertFalse(payload["consistency"]["route_budget_consistent"])

    def test_route_recommendation_reports_reason_code_truncation_metadata(self) -> None:
        payload = route_recommendation.build_route_recommendation(
            {
                "route": "spawn_single",
                "scores": {"spawn_single": 0.91, "runner": 0.45},
                "reason_codes": [f"reason_{index}" for index in range(10)],
            },
            {
                "route": "spawn_single",
                "worker_pool": "octoclaw-research",
                "work_type": "research",
                "phase": "collect",
                "model_band": "normal",
            },
        )

        self.assertEqual(payload["reason_code_count"], 10)
        self.assertTrue(payload["reason_codes_truncated"])
        self.assertEqual(len(payload["reason_codes"]), 8)
        self.assertEqual(payload["reason_codes"][0], "reason_0")

    def test_route_recommendation_exposes_conflict_and_consistency_metadata_without_becoming_truth(self) -> None:
        payload = route_recommendation.build_route_recommendation(
            {
                "route": "spawn_single",
                "work_contract_hint": "deliverable_work",
                "scores": {"spawn_single": 0.82, "runner": 0.74, "direct": 0.22},
                "score_margin": 0.08,
                "needs_semantic_review": True,
                "semantic_review_reason": "ambiguous_goal_boundary",
                "reason_codes": ["semantic_gray_zone", "needs_review"],
                "features": {
                    "repo_activity_hits": 0,
                    "fresh_live_lookup": False,
                },
            },
            {
                "route": "spawn_single",
                "worker_pool": "octoclaw-code",
                "work_type": "code",
                "phase": "implement",
                "model_band": "strong",
            },
        )

        self.assertEqual(payload["schema_version"], "octoclaw.route_recommendation/v1")
        self.assertEqual(payload["recommended_route"], "spawn_single")
        self.assertEqual(payload["work_contract_hint"], "deliverable_work")
        self.assertTrue(payload["arbitration"]["required"])
        self.assertEqual(payload["arbitration"]["strategy"], "route_hint_or_future_tiny_judge")
        self.assertEqual(payload["arbitration"]["conflict_type"], "ambiguous_goal_boundary")
        self.assertEqual(payload["arbitration"]["resolved_by"], "base_policy")
        self.assertFalse(payload["bypass_delegated_optimization"])
        self.assertEqual(payload["top_candidates"][0]["route"], "spawn_single")
        self.assertNotIn("runtime_truth", payload)

    def test_budget_recommendation_tracks_consistency_for_known_route(self) -> None:
        payload = budget_recommendation.build_budget_recommendation(
            budget_policy={
                "budget_cap": "medium",
                "latency_target": "background",
                "max_workers": 2,
                "retry_cap": 1,
                "upgrade_allowed": True,
            },
            model_policy={
                "selected_model": "zhipu/GLM-5.1",
                "fallbacks": ["openai/gpt-4.1-mini"],
                "reasoning_effort": "high",
            },
            route="spawn_multi",
        )

        self.assertEqual(payload["schema_version"], "octoclaw.budget_recommendation/v1")
        self.assertEqual(payload["target_model"], "zhipu/GLM-5.1")
        self.assertEqual(payload["fallback_model"], "openai/gpt-4.1-mini")
        self.assertEqual(payload["consistency"]["route"], "spawn_multi")
        self.assertTrue(payload["consistency"]["route_matches_output_budget"])
        self.assertTrue(payload["consistency"]["route_matches_latency_target"])
        self.assertTrue(payload["consistency"]["route_matches_worker_budget"])
        self.assertTrue(payload["consistency"]["route_budget_consistent"])


if __name__ == "__main__":
    unittest.main()
