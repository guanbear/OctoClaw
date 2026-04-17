#!/usr/bin/env python3
import json
import os
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
JUDGE_PATH = REPO_ROOT / "packages" / "octoclaw-policy" / "src" / "judge" / "index.ts"
ROUTE_PATH = REPO_ROOT / "packages" / "octoclaw-policy" / "src" / "route" / "index.ts"
ADMISSION_PATH = REPO_ROOT / "packages" / "octoclaw-policy" / "src" / "admission" / "index.ts"
CAPS_PATH = REPO_ROOT / "packages" / "octoclaw-policy" / "src" / "caps" / "index.ts"


def run_policy_expression(expression: str) -> dict:
    script = f"""
import * as judge from {json.dumps(str(JUDGE_PATH))};
import * as route from {json.dumps(str(ROUTE_PATH))};
import * as admission from {json.dumps(str(ADMISSION_PATH))};
import * as caps from {json.dumps(str(CAPS_PATH))};
const value = await ({expression});
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, "OCTOCLAW_POLICY_JUDGE_DISABLE_NETWORK": "1"},
        check=True,
    )
    return json.loads(result.stdout)


class TsPolicyCoreTests(unittest.TestCase):
    def test_judge_fast_golden_delegate_code_path(self) -> None:
        payload = run_policy_expression(
            """judge.judgeFast({
                workspaceMode: 'shared_workspace',
                queueBudget: 2,
                inflightCount: 0,
                capabilitySatisfied: true,
                writeConflict: false,
                requiresDelegation: true,
                workType: 'code',
                intent: { delegatedWork: true }
            })"""
        )
        self.assertEqual(payload["intent"]["intentClass"], "delegated_work")
        self.assertEqual(payload["decision"]["route"], "delegate.single")
        self.assertEqual(payload["decision"]["role"], "worker_code")
        self.assertEqual(payload["decision"]["caps"]["workerPool"], "octoclaw-code")
        self.assertEqual(payload["decision"]["caps"]["latencyTarget"], "background")
        self.assertEqual(payload["decision"]["admission"]["admission"], "allow")
        self.assertEqual(payload["compound"]["reason"], "phase1_compound_disabled")

    def test_judge_fast_golden_observe_path(self) -> None:
        payload = run_policy_expression(
            """judge.judgeFast({
                workspaceMode: 'read_only_workspace',
                queueBudget: 1,
                inflightCount: 0,
                capabilitySatisfied: true,
                writeConflict: false,
                requiresObservation: true,
                workType: 'research',
                intent: { executionFollowup: true }
            })"""
        )
        self.assertEqual(payload["intent"]["intentClass"], "execution_followup")
        self.assertEqual(payload["decision"]["route"], "observe")
        self.assertEqual(payload["decision"]["role"], "observer_probe")
        self.assertEqual(payload["decision"]["caps"]["workerPool"], "octoclaw-observer")
        self.assertEqual(payload["decision"]["caps"]["latencyTarget"], "interactive")

    def test_invalid_requested_route_raises(self) -> None:
        script = f"""
import * as route from {json.dumps(str(ROUTE_PATH))};
try {{
  route.decideRoute({{ requestedRoute: 'spawn_multi', workspaceMode: 'shared_workspace' }});
  console.log(JSON.stringify({{ ok: true }}));
}} catch (error) {{
  console.log(JSON.stringify({{ ok: false, message: String(error.message || error) }}));
}}
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("Unsupported live route", payload["message"])

    def test_capability_guard_falls_back_to_reply(self) -> None:
        payload = run_policy_expression(
            """judge.judgeFast({
                workspaceMode: 'shared_workspace',
                queueBudget: 2,
                inflightCount: 0,
                capabilitySatisfied: false,
                writeConflict: false,
                requiresDelegation: true,
                workType: 'review',
                intent: { delegatedWork: true }
            })"""
        )
        self.assertEqual(payload["decision"]["route"], "reply")
        self.assertEqual(payload["decision"]["admission"]["admission"], "reject")
        self.assertEqual(payload["decision"]["admission"]["reason"], "capability_guard_failed")

    def test_queue_budget_invalid_case_defers(self) -> None:
        payload = run_policy_expression(
            """judge.judgeFast({
                workspaceMode: 'shared_workspace',
                queueBudget: 1,
                inflightCount: 1,
                capabilitySatisfied: true,
                writeConflict: false,
                requiresDelegation: true,
                workType: 'research',
                intent: { delegatedWork: true }
            })"""
        )
        self.assertEqual(payload["decision"]["route"], "delegate.single")
        self.assertEqual(payload["decision"]["admission"]["admission"], "defer")
        self.assertEqual(payload["decision"]["admission"]["reason"], "queueBudget_exhausted")

    def test_shared_workspace_write_conflict_invalid_case_defers(self) -> None:
        payload = run_policy_expression(
            """judge.judgeFast({
                workspaceMode: 'shared_workspace',
                queueBudget: 2,
                inflightCount: 0,
                capabilitySatisfied: true,
                writeConflict: true,
                requiresDelegation: true,
                workType: 'research',
                intent: { delegatedWork: true }
            })"""
        )
        self.assertEqual(payload["decision"]["admission"]["admission"], "defer")
        self.assertEqual(payload["decision"]["admission"]["reason"], "shared_workspace_write_conflict")


if __name__ == "__main__":
    unittest.main()
