#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
REPLAY_CURATE_SCRIPT = REPO_ROOT / "lib" / "replay_curate.py"


class ReplayCurateTests(unittest.TestCase):
    def run_curate(self, events_path: Path, *extra_args: str) -> dict:
        result = subprocess.run(
            ["python3", str(REPLAY_CURATE_SCRIPT), "--events", str(events_path), "--format", "json", *extra_args],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_curate_dedupes_by_prompt(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "agent_end",
                "at": "2026-03-28T10:00:00.000Z",
                "sessionKey": "s1",
                "sessionId": "s1",
                "route": "spawn_single",
                "systemPreferredRoute": "spawn_single",
                "prompt": "Research DeerFlow and summarize tradeoffs",
                "delegated": True,
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "agent_end",
                "at": "2026-03-28T10:01:00.000Z",
                "sessionKey": "s2",
                "sessionId": "s2",
                "route": "spawn_single",
                "systemPreferredRoute": "spawn_single",
                "prompt": "Research DeerFlow and summarize tradeoffs",
                "delegated": True,
            },
        ]
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-curate-") as tmpdir:
            path = Path(tmpdir) / "events.json"
            path.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
            payload = self.run_curate(path, "--dedupe-by", "prompt")

        self.assertEqual(payload["counts"]["records_selected"], 2)
        self.assertEqual(payload["counts"]["cases_selected"], 1)
        self.assertEqual(payload["cases"][0]["expected_route"], "spawn_single")
        self.assertEqual(payload["schema_version"], "octoclaw.replay_curate/v1")
        self.assertTrue(payload["cases"][0]["prompt_hash"])
        self.assertTrue(payload["cases"][0]["normalized_prompt"])

    def test_curate_can_include_review_metadata(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "agent_end",
                "at": "2026-03-28T10:00:00.000Z",
                "sessionKey": "s3",
                "sessionId": "s3",
                "route": "runner",
                "systemPreferredRoute": "runner",
                "routeHintRequired": False,
                "routeHintSubmitted": False,
                "stickyApplied": True,
                "prompt": "check whether port 8080 is open",
                "delegated": True,
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "tool_blocked_before_route_hint",
                "at": "2026-03-28T10:00:01.000Z",
                "sessionKey": "s3",
                "sessionId": "s3",
                "route": "runner",
                "toolName": "exec",
                "requiredTool": "octoclaw_route_hint",
            },
        ]
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-curate-") as tmpdir:
            path = Path(tmpdir) / "events.jsonl"
            with open(path, "w", encoding="utf-8") as fh:
                for event in events:
                    fh.write(json.dumps(event, ensure_ascii=False) + "\n")
            payload = self.run_curate(path, "--include-events", "--focus", "blocked")

        self.assertEqual(payload["counts"]["cases_selected"], 1)
        self.assertIn("review", payload["cases"][0])
        self.assertTrue(payload["cases"][0]["review"]["sticky_applied"])
        self.assertEqual(payload["cases"][0]["review"]["blocked_events"], ["tool_blocked_before_route_hint"])
        self.assertEqual(payload["cases"][0]["candidate_severity"], "high")

    def test_curate_surfaces_budget_and_recommendation_fields(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "policy_resolved",
                "at": "2026-04-08T11:10:00.000Z",
                "sessionKey": "s4",
                "sessionId": "s4",
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
                    "arbitration": {"strategy": "rule_fallback"},
                },
                "routeOutcome": {
                    "schema_version": "octoclaw.route_outcome/v1",
                    "execution_contract": "runner",
                    "resolved_execution_contract": "runner",
                    "agent_scope": "runner_lane",
                    "route_class": "delegated_runner",
                    "recommended_model": "model/runner",
                    "resolved_model": "model/runner",
                    "route_source": "rule",
                    "fallback_taken": False
                },
                "autoRouter": {
                    "budgetPlanner": {
                        "consistency": {"route_budget_consistent": True}
                    }
                },
            }
        ]
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-curate-") as tmpdir:
            path = Path(tmpdir) / "events.jsonl"
            with open(path, "w", encoding="utf-8") as fh:
                for event in events:
                    fh.write(json.dumps(event, ensure_ascii=False) + "\n")
            payload = self.run_curate(path, "--include-events")

        case = payload["cases"][0]
        self.assertEqual(case["budget"]["budget_cap"], "low")
        self.assertEqual(case["budget"]["latency_target"], "interactive")
        self.assertEqual(case["recommendation"]["recommended_route"], "runner")
        self.assertTrue(case["recommendation"]["route_budget_consistent"])
        self.assertTrue(case["review"]["route_budget_consistent"])
        self.assertEqual(case["outcome"]["execution_contract"], "runner")
        self.assertEqual(case["outcome"]["route_class"], "delegated_runner")
        self.assertEqual(case["outcome"]["recommended_model"], "model/runner")
        self.assertEqual(case["review"]["resolved_model"], "model/runner")
        self.assertEqual(case["review"]["route_source"], "rule")


if __name__ == "__main__":
    unittest.main()
