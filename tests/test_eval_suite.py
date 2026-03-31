#!/usr/bin/env python3
import unittest

from lib.eval_suite import estimate_eval_token_budget, normalize_expected_route, route_matches_expected, summarize_results


class EvalSuiteTests(unittest.TestCase):
    def test_normalize_expected_route_maps_legacy_spawn_to_delegated(self) -> None:
        self.assertEqual(normalize_expected_route("spawn"), "delegated")
        self.assertEqual(normalize_expected_route("runner"), "runner")

    def test_route_matches_expected_accepts_any_delegated_for_legacy_spawn(self) -> None:
        self.assertTrue(route_matches_expected("spawn_single", "spawn"))
        self.assertTrue(route_matches_expected("spawn_multi", "spawn"))
        self.assertFalse(route_matches_expected("runner", "spawn"))

    def test_estimate_eval_token_budget_uses_budget_policy_first(self) -> None:
        self.assertEqual(estimate_eval_token_budget("direct", {"budget_cap": "tiny"}), 1000)
        self.assertEqual(estimate_eval_token_budget("spawn_single", {"budget_cap": "medium"}), 7000)
        self.assertEqual(estimate_eval_token_budget("spawn_multi", {"budget_cap": "high", "max_workers": 3}), 15000)

    def test_summarize_results_reports_cost_spawn_and_budget_counts(self) -> None:
        summary = summarize_results(
            [
                {
                    "route": "runner",
                    "route_match": True,
                    "work_contract_match": True,
                    "elapsed_ms": 400,
                    "spawn_count": 0,
                    "budget_cap": "low",
                    "estimated_cost_usd": 0.01,
                    "expect_route": "runner",
                },
                {
                    "route": "spawn_single",
                    "route_match": True,
                    "work_contract_match": True,
                    "elapsed_ms": 2200,
                    "spawn_count": 1,
                    "budget_cap": "medium",
                    "estimated_cost_usd": 0.12,
                    "expect_route": "spawn_single",
                },
            ]
        )
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["delegated_tasks"], 1)
        self.assertEqual(summary["avg_spawn_count"], 0.5)
        self.assertEqual(summary["budget_cap_counts"], {"low": 1, "medium": 1})


if __name__ == "__main__":
    unittest.main()
