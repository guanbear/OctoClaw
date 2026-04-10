#!/usr/bin/env python3
import json
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "schemas" / "runtime-policy-replay-event-v1.schema.json"
DECISION_SCHEMA_PATH = REPO_ROOT / "schemas" / "runtime-policy-decision-v1.schema.json"
ROUTE_RECOMMENDATION_SCHEMA_PATH = REPO_ROOT / "schemas" / "route-recommendation-v1.schema.json"
BUDGET_RECOMMENDATION_SCHEMA_PATH = REPO_ROOT / "schemas" / "budget-recommendation-v1.schema.json"
ROUTE_OUTCOME_SCHEMA_PATH = REPO_ROOT / "schemas" / "route-outcome-v1.schema.json"
FIXTURES_PATH = REPO_ROOT / "tests" / "fixtures" / "runtime-policy-replay-events-v1.json"


EVENT_REQUIRED_FIELDS = {
    "policy_resolved": {
        "route",
        "systemPreferredRoute",
        "workerPool",
        "taskClass",
        "protectedLane",
        "routeHintRequired",
        "routeHintSubmitted",
        "stickyApplied",
        "prompt",
    },
    "policy_judged": {
        "route",
        "taskClass",
        "policyJudgeSelected",
        "policyJudgeInvoked",
        "policyJudgeInvocationState",
        "validationOutcome",
    },
    "route_validated": {
        "route",
        "taskClass",
        "routerRequestKind",
        "routerScope",
        "routerDecisionSource",
        "routerDecisionValid",
        "validationOutcome",
    },
    "ack_sent": {
        "route",
        "taskClass",
        "ackKind",
        "ackMode",
        "ackSent",
        "reason",
    },
    "route_hint_submitted": {
        "routeHint",
        "workType",
        "phase",
        "reviewRequired",
        "confidence",
        "reason",
        "systemPreferredRoute",
        "finalRoute",
        "workerPool",
        "taskClass",
        "protectedLane",
        "stickyApplied",
        "stickyPersisted",
    },
    "tool_blocked_before_route_hint": {"route", "toolName", "requiredTool"},
    "tool_blocked_manual_delegation": {"route", "toolName"},
    "tool_blocked_control_observer": {"route", "toolName"},
    "tool_blocked_session_control": {"route", "toolName"},
    "tool_blocked_runner_policy": {"route", "toolName"},
    "tool_blocked_delegation_policy": {"route", "toolName"},
    "tool_used": {"route", "taskClass", "toolName"},
    "direct_tool_called": {"route", "taskClass", "toolName", "latencyAckRequired", "latencyAckSent"},
    "decision_cache_hit": {"route", "taskClass", "decisionCacheState", "usedCachedPolicy", "reason"},
    "decision_cache_miss": {"route", "taskClass", "decisionCacheState", "usedCachedPolicy", "reason"},
    "dispatch_called": {
        "route",
        "systemPreferredRoute",
        "taskClass",
        "executed",
        "usedCachedPolicy",
        "stickyPersisted",
    },
    "agent_end": {
        "route",
        "systemPreferredRoute",
        "workerPool",
        "taskClass",
        "protectedLane",
        "routeHintRequired",
        "routeHintSubmitted",
        "delegated",
        "delegationTool",
        "blockedTools",
    },
}


class RuntimePolicyReplaySchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.decision_schema = json.loads(DECISION_SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.route_recommendation_schema = json.loads(ROUTE_RECOMMENDATION_SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.budget_recommendation_schema = json.loads(BUDGET_RECOMMENDATION_SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.route_outcome_schema = json.loads(ROUTE_OUTCOME_SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.fixtures = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))

    def test_schema_declares_expected_event_enum(self) -> None:
        event_schema = self.schema["properties"]["event"]
        self.assertEqual(sorted(event_schema["enum"]), sorted(EVENT_REQUIRED_FIELDS.keys()))

    def test_fixtures_are_non_empty(self) -> None:
        self.assertTrue(self.fixtures)
        self.assertIsInstance(self.fixtures, list)

    def test_related_contract_schemas_exist_with_expected_versions(self) -> None:
        self.assertIn("route_recommendation", self.decision_schema["properties"])
        self.assertIn("budget_recommendation", self.decision_schema["properties"])
        self.assertIn("auto_router", self.decision_schema["properties"])
        self.assertEqual(
            self.route_recommendation_schema["properties"]["schema_version"]["const"],
            "octoclaw.route_recommendation/v1",
        )
        self.assertEqual(
            self.budget_recommendation_schema["properties"]["schema_version"]["const"],
            "octoclaw.budget_recommendation/v1",
        )
        self.assertEqual(
            self.route_outcome_schema["properties"]["schema_version"]["const"],
            "octoclaw.route_outcome/v1",
        )

    def test_each_fixture_matches_common_and_event_specific_shape(self) -> None:
        common_required = set(self.schema["required"])
        allowed_properties = set(self.schema["properties"].keys())
        for fixture in self.fixtures:
            with self.subTest(event=fixture.get("event")):
                self.assertTrue(common_required.issubset(fixture.keys()))
                self.assertIn(fixture["event"], EVENT_REQUIRED_FIELDS)
                self.assertTrue(EVENT_REQUIRED_FIELDS[fixture["event"]].issubset(fixture.keys()))
                self.assertTrue(set(fixture.keys()).issubset(allowed_properties))


if __name__ == "__main__":
    unittest.main()
