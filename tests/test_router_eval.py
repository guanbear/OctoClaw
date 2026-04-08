#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ROUTER_EVAL_SCRIPT = REPO_ROOT / "lib" / "router_eval.py"


class RouterEvalTests(unittest.TestCase):
    def run_eval(self, events_path: Path, *extra_args: str) -> dict:
        result = subprocess.run(
            ["python3", str(ROUTER_EVAL_SCRIPT), "--events", str(events_path), "--format", "json", *extra_args],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_router_eval_summarizes_recommendation_and_budget_consistency(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "policy_resolved",
                "at": "2026-04-08T12:00:00.000Z",
                "sessionKey": "s1",
                "sessionId": "s1",
                "route": "runner",
                "systemPreferredRoute": "runner",
                "prompt": "check whether port 8080 is open",
                "budgetPolicy": {
                    "budget_cap": "low",
                    "latency_target": "interactive",
                    "max_workers": 1,
                    "retry_cap": 1,
                },
                "routeRecommendation": {
                    "recommended_route": "runner",
                },
                "routeOutcome": {
                    "execution_contract": "runner",
                    "resolved_execution_contract": "runner",
                    "recommended_model": "model/runner",
                    "resolved_model": "model/runner",
                    "queue_pressure_band": "none",
                    "quota_pressure_band": "none",
                    "fallback_taken": False,
                },
                "autoRouter": {
                    "budgetPlanner": {
                        "consistency": {"route_budget_consistent": True}
                    }
                },
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "policy_resolved",
                "at": "2026-04-08T12:01:00.000Z",
                "sessionKey": "s2",
                "sessionId": "s2",
                "route": "spawn_single",
                "systemPreferredRoute": "spawn_single",
                "prompt": "调研 release 并总结",
                "budgetPolicy": {
                    "budget_cap": "low",
                    "latency_target": "background",
                    "max_workers": 1,
                    "retry_cap": 1,
                },
                "routeRecommendation": {
                    "recommended_route": "runner",
                },
                "routeOutcome": {
                    "execution_contract": "runner",
                    "resolved_execution_contract": "spawn_single",
                    "recommended_model": "model/runner",
                    "resolved_model": "model/fallback",
                    "queue_pressure_band": "high",
                    "quota_pressure_band": "high",
                    "fallback_taken": True,
                },
                "autoRouter": {
                    "budgetPlanner": {
                        "consistency": {"route_budget_consistent": False}
                    }
                },
            },
        ]
        with tempfile.TemporaryDirectory(prefix="octoclaw-router-eval-") as tmpdir:
            path = Path(tmpdir) / "events.jsonl"
            path.write_text("\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n", encoding="utf-8")
            payload = self.run_eval(path)

        self.assertEqual(payload["schema_version"], "octoclaw.router_eval/v1")
        self.assertEqual(payload["summary"]["total_cases"], 2)
        self.assertEqual(payload["summary"]["recommendation_present"], 2)
        self.assertEqual(payload["summary"]["recommendation_matches_expected_route"], 1)
        self.assertEqual(payload["summary"]["route_budget_consistent_cases"], 1)
        self.assertEqual(payload["summary"]["drift_cases"], 1)
        self.assertEqual(payload["summary"]["route_drift_breakdown"]["match"], 1)
        self.assertEqual(payload["summary"]["route_drift_breakdown"]["route_mismatch"], 1)
        self.assertEqual(payload["summary"]["budget_drift_breakdown"]["budget_mismatch"], 1)
        self.assertEqual(payload["summary"]["resolution_drift_breakdown"]["execution_contract_mismatch"], 1)
        self.assertEqual(payload["summary"]["overall_drift_breakdown"]["route_and_budget_mismatch"], 1)
        self.assertEqual(payload["summary"]["fallback_taken_count"], 1)
        self.assertEqual(payload["drift_cases"][0]["expected_route"], "spawn_single")
        self.assertEqual(payload["drift_cases"][0]["recommended_route"], "runner")
        self.assertEqual(payload["drift_cases"][0]["resolution_drift_class"], "execution_contract_mismatch")
        self.assertEqual(payload["drift_cases"][0]["overall_drift_class"], "route_and_budget_mismatch")
        self.assertEqual(
            payload["drift_cases"][0]["calibration_evidence"]["schema_version"],
            "octoclaw.router_eval.calibration_evidence/v1",
        )
        self.assertEqual(
            payload["tuning_inputs"]["route_transition_counts"],
            [
                {"expected_route": "runner", "recommended_route": "runner", "count": 1},
                {"expected_route": "spawn_single", "recommended_route": "runner", "count": 1},
            ],
        )
        self.assertEqual(
            payload["tuning_inputs"]["route_resolution_transitions"],
            [
                {"expected_route": "runner", "resolved_execution_contract": "runner", "count": 1},
                {"expected_route": "spawn_single", "resolved_execution_contract": "spawn_single", "count": 1},
            ],
        )
        kinds = [item["kind"] for item in payload["tuning_suggestions"]]
        self.assertEqual(payload["tuning_suggestions"][0]["kind"], "budget_ladder_review")
        self.assertIn("route_ladder_review", kinds)
        self.assertIn("model_resolution_review", kinds)
        self.assertIn("quota_pressure_review", kinds)
        self.assertIn("queue_pressure_review", kinds)

    def test_router_eval_treats_missing_recommendation_as_unknown_not_drift(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "policy_resolved",
                "at": "2026-04-08T12:00:00.000Z",
                "sessionKey": "s1",
                "sessionId": "s1",
                "route": "runner",
                "systemPreferredRoute": "runner",
                "prompt": "check runner health",
                "budgetPolicy": {
                    "budget_cap": "low",
                    "latency_target": "interactive",
                    "max_workers": 1,
                    "retry_cap": 1,
                },
            }
        ]
        with tempfile.TemporaryDirectory(prefix="octoclaw-router-eval-") as tmpdir:
            path = Path(tmpdir) / "events.jsonl"
            path.write_text("\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n", encoding="utf-8")
            payload = self.run_eval(path)

        self.assertEqual(payload["summary"]["recommendation_missing"], 1)
        self.assertEqual(payload["summary"]["drift_cases"], 0)
        self.assertEqual(payload["summary"]["route_drift_breakdown"]["missing_recommendation"], 1)
        self.assertEqual(payload["summary"]["overall_drift_breakdown"]["missing_recommendation"], 1)
        self.assertEqual(payload["summary"]["calibration_ready_cases"], 0)
        self.assertEqual(payload["summary"]["resolution_drift_breakdown"]["match"], 1)


if __name__ == "__main__":
    unittest.main()
