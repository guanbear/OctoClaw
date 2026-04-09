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


if __name__ == "__main__":
    unittest.main()
