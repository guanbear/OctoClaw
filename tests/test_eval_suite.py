#!/usr/bin/env python3
import unittest

from lib.eval_suite import (
    DEFAULT_ROUTE_TASKS_FILE,
    DEFAULT_STATE_MACHINE_TASKS_FILE,
    _taskflow_fields_for_eval,
    estimate_eval_token_budget,
    normalize_expected_route,
    resolve_tasks_path,
    route_matches_expected,
    summarize_results,
)


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

    def test_resolve_tasks_path_defaults_per_mode(self) -> None:
        self.assertEqual(resolve_tasks_path("route"), DEFAULT_ROUTE_TASKS_FILE.resolve())
        self.assertEqual(resolve_tasks_path("state_machine"), DEFAULT_STATE_MACHINE_TASKS_FILE.resolve())

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
                    "taskflow_state": "mirrored",
                    "taskflow_task_runtime": "openclaw_task",
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
                    "taskflow_state": "mirrored_bound",
                    "taskflow_native_binding_state": "bound",
                    "taskflow_native_status": "running",
                    "taskflow_handoff_state": "delivered",
                },
            ]
        )
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["delegated_tasks"], 1)
        self.assertEqual(summary["avg_spawn_count"], 0.5)
        self.assertEqual(summary["budget_cap_counts"], {"low": 1, "medium": 1})
        self.assertEqual(summary["taskflow_tracked_tasks"], 2)
        self.assertEqual(summary["taskflow_native_bound_tasks"], 1)
        self.assertEqual(summary["taskflow_native_active_tasks"], 1)
        self.assertEqual(summary["taskflow_handoff_ready_tasks"], 0)
        self.assertEqual(summary["taskflow_delivered_tasks"], 1)

    def test_taskflow_fields_for_eval_extracts_substrate_fact_snapshot(self) -> None:
        fields = _taskflow_fields_for_eval(
            {
                "openclaw_taskflow_state": "mirrored_bound",
                "openclaw_task_runtime": "openclaw_task",
                "openclaw_flow_runtime": "openclaw_flow",
                "openclaw_native_binding_state": "bound",
                "openclaw_native_status": "running",
                "openclaw_native_runtime": "subagent",
                "openclaw_task_id": "native-task-1",
                "openclaw_flow_id": "flow-1",
                "handoff_state": "user_safe_ready",
            }
        )

        self.assertEqual(fields["taskflow_state"], "mirrored_bound")
        self.assertEqual(fields["taskflow_task_runtime"], "openclaw_task")
        self.assertEqual(fields["taskflow_flow_runtime"], "openclaw_flow")
        self.assertEqual(fields["taskflow_native_binding_state"], "bound")
        self.assertEqual(fields["taskflow_native_status"], "running")
        self.assertEqual(fields["taskflow_native_runtime"], "subagent")
        self.assertEqual(fields["taskflow_task_id"], "native-task-1")
        self.assertEqual(fields["taskflow_flow_id"], "flow-1")
        self.assertEqual(fields["taskflow_handoff_state"], "user_safe_ready")


if __name__ == "__main__":
    unittest.main()
