#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from lib.replay_summary import infer_runtime_policy_phase, render_text


REPO_ROOT = Path(__file__).resolve().parents[1]
REPLAY_SUMMARY_SCRIPT = REPO_ROOT / "lib" / "replay_summary.py"
FIXTURES_PATH = REPO_ROOT / "tests" / "fixtures" / "runtime-policy-replay-events-v1.json"


class ReplaySummaryTests(unittest.TestCase):
    def run_summary(self, events_path: Path, *extra_args: str) -> dict:
        result = subprocess.run(
            ["python3", str(REPLAY_SUMMARY_SCRIPT), "--events", str(events_path), "--format", "json", *extra_args],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_json_array_fixture_reports_core_counts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-task-state-") as tmpdir:
            task_state_path = Path(tmpdir) / "task-state.json"
            task_state_path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "spawn-1",
                                "status": "running",
                                "handoff_state": "user_safe_ready",
                                "task_event_summary": {"kind_counts": {"checkpoint": 1, "artifact_ready": 1}},
                                "openclaw_taskflow": {
                                    "binding_state": "mirrored_bound",
                                    "native_binding_state": "bound",
                                    "native_status": "running",
                                },
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            payload = self.run_summary(
                FIXTURES_PATH,
                "--task-state",
                str(task_state_path),
                "--phase",
                "conservative",
                "--min-policy-events",
                "1",
                "--min-runner-events",
                "0",
                "--min-delegated-events",
                "1",
                "--max-blocked-session-rate",
                "1.0",
            )
        self.assertEqual(payload["source"]["format"], "json_array")
        self.assertEqual(payload["events"]["total"], 13)
        self.assertEqual(payload["events"]["by_type"]["policy_resolved"], 1)
        self.assertEqual(payload["task_metrics"]["route_counts"], {"spawn_single": 1})
        self.assertEqual(payload["task_metrics"]["work_contract_counts"], {"deliverable_work": 1})
        self.assertEqual(payload["task_metrics"]["worker_pool_counts"], {"octoclaw-code": 1})
        self.assertEqual(payload["tool_metrics"]["blocked_event_count"], 2)
        self.assertEqual(payload["route_outcome_metrics"]["execution_contract_counts"], {"spawn_single": 1})
        self.assertEqual(payload["substrate_metrics"]["tracked"], 1)
        self.assertEqual(payload["substrate_metrics"]["native_bound"], 1)
        self.assertEqual(payload["substrate_metrics"]["native_active"], 1)
        self.assertEqual(payload["substrate_metrics"]["checkpointed"], 1)
        self.assertEqual(payload["substrate_metrics"]["artifact_ready"], 1)
        self.assertEqual(payload["substrate_metrics"]["handoff_ready"], 1)
        self.assertTrue(payload["promotion"]["ready"])
        rendered = render_text(payload)
        self.assertIn("Worker pool counts", rendered)
        self.assertIn("Economics", rendered)
        self.assertIn("Substrate Snapshot", rendered)

    def test_guided_phase_requires_route_hint_coverage(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "policy_resolved",
                "at": "2026-03-28T09:00:00.000Z",
                "sessionKey": "s1",
                "sessionId": "s1",
                "trigger": "message",
                "route": "runner",
                "systemPreferredRoute": "runner",
                "workerPool": "octoclaw-runner",
                "workContract": "inspect_report",
                "budgetPolicy": {"budget_cap": "low", "retry_cap": 1, "max_workers": 1, "latency_target": "interactive", "interruptibility": "high", "upgrade_allowed": True},
                "routeOutcome": {
                    "schema_version": "octoclaw.route_outcome/v1",
                    "execution_contract": "runner",
                    "resolved_execution_contract": "runner",
                    "agent_scope": "runner_lane",
                    "route_class": "delegated_runner"
                },
                "routeHintRequired": False,
                "routeHintSubmitted": False,
                "stickyApplied": False,
                "prompt": "check port 8080",
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "policy_resolved",
                "at": "2026-03-28T09:01:00.000Z",
                "sessionKey": "s2",
                "sessionId": "s2",
                "trigger": "message",
                "route": "spawn_single",
                "systemPreferredRoute": "spawn_single",
                "workerPool": "octoclaw-research",
                "workContract": "deliverable_work",
                "workContractHint": "deliverable_work",
                "budgetPolicy": {"budget_cap": "low", "retry_cap": 1, "max_workers": 1, "latency_target": "background", "interruptibility": "medium", "upgrade_allowed": True},
                "routeOutcome": {
                    "schema_version": "octoclaw.route_outcome/v1",
                    "execution_contract": "spawn_single",
                    "resolved_execution_contract": "spawn_single",
                    "agent_scope": "subagent_lane",
                    "route_class": "delegated_single"
                },
                "routeHintRequired": True,
                "routeHintSubmitted": True,
                "stickyApplied": False,
                "prompt": "research gateways",
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "route_hint_submitted",
                "at": "2026-03-28T09:01:05.000Z",
                "sessionKey": "s2",
                "sessionId": "s2",
                "routeHint": "spawn_single",
                "workType": "research",
                "phase": "collect",
                "reviewRequired": False,
                "confidence": 0.8,
                "reason": "needs research",
                "systemPreferredRoute": "spawn_single",
                "finalRoute": "spawn_single",
                "workerPool": "octoclaw-research",
                "stickyApplied": False,
                "stickyPersisted": False,
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "dispatch_called",
                "at": "2026-03-28T09:01:10.000Z",
                "sessionKey": "s2",
                "sessionId": "s2",
                "route": "spawn_single",
                "systemPreferredRoute": "spawn_single",
                "executed": True,
                "usedCachedPolicy": False,
                "stickyPersisted": False,
            },
        ]

        with tempfile.TemporaryDirectory(prefix="octoclaw-replay-summary-") as tmpdir:
            events_path = Path(tmpdir) / "runtime-policy-replay.jsonl"
            with open(events_path, "w", encoding="utf-8") as fh:
                for event in events:
                    fh.write(json.dumps(event, ensure_ascii=False) + "\n")

            payload = self.run_summary(
                events_path,
                "--phase",
                "guided",
                "--min-policy-events",
                "2",
                "--min-runner-events",
                "1",
                "--min-delegated-events",
                "1",
                "--max-blocked-session-rate",
                "0.5",
                "--min-route-hint-submission-rate",
                "0.8",
            )

        self.assertEqual(payload["source"]["format"], "jsonl")
        self.assertEqual(payload["task_metrics"]["runner_task_count"], 1)
        self.assertEqual(payload["task_metrics"]["delegated_task_count"], 2)
        self.assertEqual(payload["economics_metrics"]["budget_cap_counts"], {"low": 2})
        self.assertEqual(payload["route_outcome_metrics"]["route_class_counts"], {"delegated_runner": 1, "delegated_single": 1})
        self.assertEqual(payload["route_hint_metrics"]["required_count"], 1)
        self.assertEqual(payload["route_hint_metrics"]["submitted_count"], 1)
        self.assertEqual(payload["route_hint_metrics"]["submission_rate"], 1.0)
        self.assertTrue(payload["promotion"]["ready"])
        self.assertEqual(payload["promotion"]["target"], "enforced")

    def test_summary_reports_protected_lane_dispatch_and_misroute(self) -> None:
        events = [
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "policy_resolved",
                "at": "2026-04-08T09:00:00.000Z",
                "sessionKey": "meta-1",
                "sessionId": "meta-1",
                "route": "direct",
                "systemPreferredRoute": "direct",
                "workerPool": "octoclaw-main",
                "workContract": "answer_now",
                "protectedLane": "control_observer",
                "prompt": "你现在是啥模型",
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "dispatch_called",
                "at": "2026-04-08T09:00:01.000Z",
                "sessionKey": "meta-1",
                "sessionId": "meta-1",
                "route": "spawn_single",
                "systemPreferredRoute": "direct",
                "protectedLane": "control_observer",
                "executed": True,
            },
            {
                "schema_version": "octoclaw.runtime_policy.replay_event/v1",
                "event": "policy_resolved",
                "at": "2026-04-08T09:01:00.000Z",
                "sessionKey": "meta-2",
                "sessionId": "meta-2",
                "route": "direct",
                "systemPreferredRoute": "direct",
                "workerPool": "octoclaw-main",
                "workContract": "answer_now",
                "protectedLane": "control_observer",
                "prompt": "这次有没有走 dispatch",
            },
        ]

        with tempfile.TemporaryDirectory(prefix="octoclaw-protected-summary-") as tmpdir:
            events_path = Path(tmpdir) / "runtime-policy-replay.jsonl"
            with open(events_path, "w", encoding="utf-8") as fh:
                for event in events:
                    fh.write(json.dumps(event, ensure_ascii=False) + "\n")

            payload = self.run_summary(
                events_path,
                "--phase",
                "guided",
                "--min-policy-events",
                "2",
                "--min-runner-events",
                "0",
                "--min-delegated-events",
                "0",
                "--max-blocked-session-rate",
                "1.0",
                "--min-route-hint-submission-rate",
                "0.0",
            )

        self.assertEqual(payload["task_metrics"]["protected_lane_counts"], {"control_observer": 2})
        self.assertEqual(payload["protected_lane_metrics"]["session_count"], 2)
        self.assertEqual(payload["protected_lane_metrics"]["dispatch_session_count"], 1)
        self.assertEqual(payload["protected_lane_metrics"]["misroute_session_count"], 1)
        self.assertEqual(payload["policy_diff"]["protected_lane_misroute_count"], 1)
        rendered = render_text(payload)
        self.assertIn("Protected Lanes", rendered)
        self.assertIn("Protected-lane misroutes", rendered)

    def test_infer_runtime_policy_phase_prefers_conservative_guided_and_enforced(self) -> None:
        self.assertEqual(infer_runtime_policy_phase(None), "conservative")
        self.assertEqual(
            infer_runtime_policy_phase(
                {
                    "switches": {
                        "hard_runner_only": True,
                        "route_hint_required": False,
                        "direct_model_override": False,
                        "delegation_enforcement": False,
                    },
                    "hooks": {
                        "before_model_resolve": False,
                        "before_tool_call": False,
                    },
                    "route_stickiness": {"enabled": False},
                }
            ),
            "conservative",
        )
        self.assertEqual(
            infer_runtime_policy_phase(
                {
                    "switches": {
                        "route_hint_required": False,
                        "delegation_enforcement": True,
                    },
                    "hooks": {
                        "before_model_resolve": False,
                        "before_tool_call": True,
                    },
                    "route_stickiness": {"enabled": True},
                }
            ),
            "guided",
        )
        self.assertEqual(
            infer_runtime_policy_phase(
                {
                    "switches": {
                        "route_hint_required": True,
                        "delegation_enforcement": True,
                        "direct_model_override": False,
                    },
                    "hooks": {
                        "before_model_resolve": False,
                        "before_tool_call": True,
                    },
                    "route_stickiness": {"enabled": True},
                }
            ),
            "enforced",
        )
        self.assertEqual(
            infer_runtime_policy_phase(
                {
                    "switches": {
                        "delegation_enforcement": True,
                        "direct_model_override": False,
                    },
                    "hooks": {
                        "before_model_resolve": False,
                    },
                }
            ),
            "guided",
        )
        self.assertEqual(
            infer_runtime_policy_phase(
                {
                    "switches": {
                        "direct_model_override": True,
                        "delegation_enforcement": True,
                    },
                    "hooks": {
                        "before_model_resolve": True,
                    },
                }
            ),
            "enforced",
        )


if __name__ == "__main__":
    unittest.main()
