#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "index.js"
FIXTURES_PATH = REPO_ROOT / "tests" / "fixtures" / "router-policy-goldens-v2.json"
TEST_ENV = {"OCTOCLAW_POLICY_JUDGE_DISABLE_NETWORK": "1"}


def _run_node_decisions(tasks: list[str]) -> list[dict]:
    script = f"""
import {{ __octoclawTest }} from {json.dumps(str(EXTENSION_PATH))};
const tasks = {json.dumps(tasks, ensure_ascii=False)};
const payload = await Promise.all(tasks.map(async (task) => {{
  const decision = await __octoclawTest.resolveStatelessPolicyDecision(task);
  return {{
    task,
    route: decision.route_decision.route,
    task_class: decision.route_decision.task_class,
    work_contract: decision.route_decision.work_contract,
    policy_router_mode: decision.policy_router.mode,
    policy_router_source: decision.policy_router.decision_source,
    policy_judge_selected: decision.policy_router.judge.selected,
    policy_judge_invoked: decision.policy_router.judge.invoked,
    policy_judge_tools: decision.policy_router.judge.tools,
    intent_class: decision.intent_packet.intent_class,
    judge_eligible: decision.intent_packet.judge.eligible,
    latency_ack_required: decision.latency_ack.required,
    router_schema: decision.router_decision_v2.schema_version,
    request_kind: decision.router_decision_v2.request_kind,
    scope: decision.router_decision_v2.scope,
    target: decision.router_decision_v2.target,
    evidence_required: decision.router_decision_v2.evidence_required,
    ack_required: decision.router_decision_v2.ack.required,
    validation_passed: decision.router_decision_v2.validation.passed,
    validation_problems: decision.router_decision_v2.validation.problems,
    turn_id: decision.correlation.turn_id,
    decision_id: decision.correlation.decision_id
  }};
}}));
console.log(JSON.stringify(payload));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, **TEST_ENV},
        check=True,
    )
    return json.loads(result.stdout)


class RouterPolicyV2GoldensTests(unittest.TestCase):
    def test_router_policy_v2_contract_goldens(self) -> None:
        cases = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))
        decisions = _run_node_decisions([case["task"] for case in cases])
        for case, decision in zip(cases, decisions):
            expected = case["expected"]
            with self.subTest(task=case["task"]):
                self.assertEqual(decision["route"], expected["route"])
                self.assertEqual(decision["task_class"], expected["task_class"])
                self.assertEqual(decision["work_contract"], expected["work_contract"])
                self.assertEqual(decision["intent_class"], expected["intent_class"])
                self.assertEqual(decision["judge_eligible"], expected.get("judge_eligible", True))

                self.assertEqual(decision["policy_router_mode"], "model_first")
                self.assertEqual(
                    decision["policy_router_source"],
                    expected.get("policy_router_source", "legacy_planner_until_stateless_judge_live"),
                )
                self.assertEqual(decision["policy_judge_selected"], "main_grade_model")
                self.assertFalse(decision["policy_judge_invoked"])
                self.assertEqual(decision["policy_judge_tools"], "none")

                self.assertEqual(decision["router_schema"], "octoclaw.router_decision/v2")
                self.assertEqual(decision["request_kind"], expected["request_kind"])
                self.assertEqual(decision["scope"], expected["scope"])
                self.assertEqual(decision["target"], expected["target"])
                self.assertEqual(decision["evidence_required"], expected["evidence_required"])
                self.assertEqual(decision["ack_required"], expected["ack_required"])
                self.assertEqual(decision["latency_ack_required"], expected.get("latency_ack_required", False))
                self.assertTrue(decision["validation_passed"], decision["validation_problems"])
                self.assertTrue(decision["turn_id"].startswith("turn-"))
                self.assertTrue(decision["decision_id"].startswith("decision-"))


if __name__ == "__main__":
    unittest.main()
