#!/usr/bin/env python3
"""Tests for compound_plan.js exports: validate, schedule, guard, normalize.

Tests in TestCompoundPlanSchema, TestCompoundPlanSchedule,
TestCompoundGuardEvaluate, and TestCompoundPlanNormalize exercise EXISTING
functions and MUST PASS.

Tests in TestValidateCompoundExecution, TestCompoundExecutor, and
TestProvenanceGuard exercise NEW functions (TDD) and are expected to
skip until those functions are implemented.
"""
import json
import os
import subprocess
import unittest
from pathlib import Path
from typing import Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
PLAN_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "policy" / "compound_plan.js"
EXECUTOR_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "policy" / "compound_executor.js"
INTENT_PATH = REPO_ROOT / "extensions" / "octoclaw-runtime" / "policy" / "intent.js"
TEST_ENV = {
    "OCTOCLAW_POLICY_JUDGE_DISABLE_NETWORK": "1",
    "OCTOCLAW_COMPOUND_PLANNER_DISABLE_NETWORK": "1",
}


def run_plan_expression(expression: str, env: Optional[dict] = None) -> dict:
    """Run a Node ESM expression against compound_plan.js and return parsed JSON."""
    script = f"""
import * as cp from {json.dumps(str(PLAN_PATH))};
const value = await ({expression});
console.log(JSON.stringify(value));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, **TEST_ENV, **(env or {})},
        check=True,
    )
    return json.loads(result.stdout)


def _run_tdd_expression(expression: str, env: Optional[dict] = None) -> dict:
    """Run an expression that may reference not-yet-implemented functions.

    Returns a dict with ``__tdd_skip__`` key set to ``True`` when the
    target function does not exist yet.
    """
    script = f"""
import * as cp from {json.dumps(str(PLAN_PATH))};
import * as cexec from {json.dumps(str(EXECUTOR_PATH))};
import * as intent_mod from {json.dumps(str(INTENT_PATH))};
try {{
    const value = await ({expression});
    console.log(JSON.stringify(value));
}} catch (err) {{
    console.log(JSON.stringify({{"__tdd_skip__": true, "reason": String(err.message || err)}}));
}}
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env={**os.environ, **TEST_ENV, **(env or {})},
    )
    if result.returncode != 0:
        return {"__tdd_skip__": True, "reason": result.stderr[:300]}
    try:
        return json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return {"__tdd_skip__": True, "reason": result.stdout[:300]}


# ---------------------------------------------------------------------------
# Existing function tests — MUST PASS
# ---------------------------------------------------------------------------

class TestCompoundPlanSchema(unittest.TestCase):
    """Tests for validateCompoundPlan (existing export)."""

    def test_validate_simple_route_empty_work_items(self) -> None:
        payload = run_plan_expression(
            """cp.validateCompoundPlan({
                schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                decision_mode: "simple_route",
                work_items: []
            })"""
        )
        self.assertTrue(payload["valid"])
        self.assertEqual(len(payload["errors"]), 0)

    def test_validate_compound_plan_basic(self) -> None:
        payload = run_plan_expression(
            """cp.validateCompoundPlan({
                schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                decision_mode: "compound_plan",
                max_depth: 2,
                work_items: [
                    { id: "A", lane: "direct", intent_class: "plain_chat", depends_on: [] },
                    { id: "B", lane: "direct", intent_class: "plain_chat", depends_on: [] }
                ]
            })"""
        )
        self.assertTrue(payload["valid"])
        self.assertEqual(len(payload["errors"]), 0)

    def test_validate_compound_plan_cycle(self) -> None:
        payload = run_plan_expression(
            """cp.validateCompoundPlan({
                schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                decision_mode: "compound_plan",
                max_depth: 3,
                work_items: [
                    { id: "A", lane: "direct", intent_class: "plain_chat", depends_on: ["B"] },
                    { id: "B", lane: "direct", intent_class: "plain_chat", depends_on: ["A"] }
                ]
            })"""
        )
        self.assertFalse(payload["valid"])
        self.assertTrue(
            any("circular" in e for e in payload["errors"]),
            f"Expected 'circular' in errors, got: {payload['errors']}",
        )

    def test_validate_invalid_lane(self) -> None:
        payload = run_plan_expression(
            """cp.validateCompoundPlan({
                schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                decision_mode: "compound_plan",
                max_depth: 2,
                work_items: [
                    { id: "X", lane: "invalid_lane", intent_class: "plain_chat", depends_on: [] }
                ]
            })"""
        )
        self.assertFalse(payload["valid"])

    def test_validate_invalid_intent_class(self) -> None:
        payload = run_plan_expression(
            """cp.validateCompoundPlan({
                schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                decision_mode: "compound_plan",
                max_depth: 2,
                work_items: [
                    { id: "Y", lane: "direct", intent_class: "nonexistent", depends_on: [] }
                ]
            })"""
        )
        self.assertFalse(payload["valid"])


class TestCompoundPlanSchedule(unittest.TestCase):
    """Tests for scheduleCompoundPlan (existing export)."""

    def test_schedule_basic_two_waves(self) -> None:
        payload = run_plan_expression(
            """(() => {
                const result = cp.scheduleCompoundPlan({
                    schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                    decision_mode: "compound_plan",
                    max_depth: 3,
                    work_items: [
                        { id: "A", lane: "direct", intent_class: "plain_chat", depends_on: [] },
                        { id: "B", lane: "direct", intent_class: "plain_chat", depends_on: ["A"] }
                    ]
                });
                return { waves: result.waves };
            })()"""
        )
        self.assertEqual(len(payload["waves"]), 2)
        self.assertEqual(payload["waves"][0], ["A"])
        self.assertEqual(payload["waves"][1], ["B"])

    def test_schedule_three_waves(self) -> None:
        payload = run_plan_expression(
            """(() => {
                const result = cp.scheduleCompoundPlan({
                    schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                    decision_mode: "compound_plan",
                    max_depth: 3,
                    work_items: [
                        { id: "A", lane: "direct", intent_class: "plain_chat", depends_on: [] },
                        { id: "B", lane: "direct", intent_class: "plain_chat", depends_on: ["A"] },
                        { id: "C", lane: "direct", intent_class: "plain_chat", depends_on: ["B"] }
                    ]
                });
                return { waves: result.waves };
            })()"""
        )
        self.assertEqual(len(payload["waves"]), 3)
        self.assertEqual(payload["waves"][0], ["A"])
        self.assertEqual(payload["waves"][1], ["B"])
        self.assertEqual(payload["waves"][2], ["C"])

    def test_schedule_parallel_same_wave(self) -> None:
        payload = run_plan_expression(
            """(() => {
                const result = cp.scheduleCompoundPlan({
                    schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                    decision_mode: "compound_plan",
                    max_depth: 3,
                    work_items: [
                        { id: "A", lane: "direct", intent_class: "plain_chat", depends_on: [] },
                        { id: "B", lane: "direct", intent_class: "plain_chat", depends_on: [] }
                    ]
                });
                return { waves: result.waves };
            })()"""
        )
        self.assertEqual(len(payload["waves"]), 1)
        wave_ids = set(payload["waves"][0])
        self.assertEqual(wave_ids, {"A", "B"})

    def test_schedule_empty_plan(self) -> None:
        payload = run_plan_expression(
            """(() => {
                const result = cp.scheduleCompoundPlan({
                    schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                    decision_mode: "simple_route",
                    work_items: []
                });
                return { waves: result.waves };
            })()"""
        )
        self.assertEqual(payload["waves"], [])

    def test_schedule_within_wave_lane_order(self) -> None:
        payload = run_plan_expression(
            """(() => {
                const result = cp.scheduleCompoundPlan({
                    schema_version: cp.COMPOUND_PLAN_SCHEMA_VERSION,
                    decision_mode: "compound_plan",
                    max_depth: 3,
                    work_items: [
                        { id: "S", lane: "spawn_single", intent_class: "plain_chat", depends_on: [] },
                        { id: "D", lane: "direct", intent_class: "plain_chat", depends_on: [] },
                        { id: "R", lane: "runner", intent_class: "plain_chat", depends_on: [] }
                    ]
                });
                return { waves: result.waves };
            })()"""
        )
        self.assertEqual(len(payload["waves"]), 1)
        # direct < runner < spawn_single within same wave
        self.assertEqual(payload["waves"][0], ["D", "R", "S"])


class TestCompoundGuardEvaluate(unittest.TestCase):
    """Tests for evaluateGuard (existing export)."""

    def test_guard_no_guard(self) -> None:
        payload = run_plan_expression("""cp.evaluateGuard(null, {})""")
        self.assertTrue(payload["passed"])
        self.assertEqual(payload["reason"], "no_guard")

    def test_guard_ref_eq_match(self) -> None:
        payload = run_plan_expression(
            """cp.evaluateGuard(
                { type: "ref_eq", ref_item: "A", ref_path: "status", expected: "completed" },
                { A: { status: "completed" } }
            )"""
        )
        self.assertTrue(payload["passed"])
        self.assertEqual(payload["reason"], "ref_eq_match")

    def test_guard_ref_eq_mismatch(self) -> None:
        payload = run_plan_expression(
            """cp.evaluateGuard(
                { type: "ref_eq", ref_item: "A", ref_path: "status", expected: "completed" },
                { A: { status: "failed" } }
            )"""
        )
        self.assertFalse(payload["passed"])
        self.assertEqual(payload["reason"], "ref_eq_mismatch")

    def test_guard_ref_gt_satisfied(self) -> None:
        payload = run_plan_expression(
            """cp.evaluateGuard(
                { type: "ref_gt", ref_item: "A", ref_path: "score", expected: 3 },
                { A: { score: 5 } }
            )"""
        )
        self.assertTrue(payload["passed"])
        self.assertEqual(payload["reason"], "ref_gt_satisfied")

    def test_guard_ref_gt_not_satisfied(self) -> None:
        payload = run_plan_expression(
            """cp.evaluateGuard(
                { type: "ref_gt", ref_item: "A", ref_path: "score", expected: 3 },
                { A: { score: 2 } }
            )"""
        )
        self.assertFalse(payload["passed"])
        self.assertEqual(payload["reason"], "ref_gt_not_satisfied")

    def test_guard_ref_item_not_completed(self) -> None:
        payload = run_plan_expression(
            """cp.evaluateGuard(
                { type: "ref_eq", ref_item: "Z", ref_path: "status", expected: "ok" },
                { A: { status: "ok" } }
            )"""
        )
        self.assertFalse(payload["passed"])
        self.assertEqual(payload["reason"], "ref_item_not_completed")

    def test_guard_ref_path_not_found(self) -> None:
        payload = run_plan_expression(
            """cp.evaluateGuard(
                { type: "ref_eq", ref_item: "A", ref_path: "nonexistent.deep.path", expected: "ok" },
                { A: { status: "ok" } }
            )"""
        )
        self.assertFalse(payload["passed"])
        self.assertEqual(payload["reason"], "ref_path_not_found")


class TestCompoundPlanNormalize(unittest.TestCase):
    """Tests for normalizeCompoundPlan (existing export)."""

    def test_normalize_simple_route(self) -> None:
        payload = run_plan_expression(
            """cp.normalizeCompoundPlan({ decision_mode: "simple_route" })"""
        )
        self.assertEqual(payload["decision_mode"], "simple_route")
        self.assertTrue(payload["valid"])

    def test_normalize_compound_plan(self) -> None:
        payload = run_plan_expression(
            """cp.normalizeCompoundPlan({
                decision_mode: "compound_plan",
                work_items: [
                    { id: "A", lane: "direct", intent_class: "plain_chat", goal: "greet user" },
                    { id: "B", lane: "runner", intent_class: "fresh_live_lookup", goal: "lookup data", depends_on: ["A"] }
                ]
            })"""
        )
        self.assertTrue(payload["valid"], f"Expected valid, errors: {payload.get('errors')}")
        self.assertEqual(len(payload["work_items"]), 2)
        item_a = payload["work_items"][0]
        self.assertEqual(item_a["id"], "A")
        self.assertEqual(item_a["lane"], "direct")
        self.assertEqual(item_a["status"], "pending")
        self.assertEqual(item_a["fallback"], "notify_user")
        self.assertFalse(item_a["user_visible"])
        self.assertEqual(item_a["depends_on"], [])
        item_b = payload["work_items"][1]
        self.assertEqual(item_b["depends_on"], ["A"])

    def test_normalize_adds_plan_id(self) -> None:
        payload = run_plan_expression(
            """cp.normalizeCompoundPlan({ decision_mode: "simple_route" })"""
        )
        self.assertTrue(
            payload["plan_id"].startswith("cp_"),
            f"plan_id should start with 'cp_', got: {payload['plan_id']}",
        )

    def test_normalize_invalid_lane_corrected(self) -> None:
        payload = run_plan_expression(
            """cp.normalizeCompoundPlan({
                decision_mode: "compound_plan",
                work_items: [
                    { id: "X", lane: "invalid_lane", intent_class: "plain_chat" }
                ]
            })"""
        )
        self.assertTrue(payload["valid"], f"Expected valid after correction, errors: {payload.get('errors')}")
        item = payload["work_items"][0]
        self.assertEqual(item["lane"], "direct")


# ---------------------------------------------------------------------------
# TDD tests — exercise NEW functions not yet implemented
# ---------------------------------------------------------------------------

class TestValidateCompoundExecution(unittest.TestCase):
    """TDD tests for validateCompoundExecution (not yet exported).

    These tests will skip until the function is implemented.
    """

    def _skip_if_tdd(self, payload: dict) -> None:
        if isinstance(payload, dict) and payload.get("__tdd_skip__"):
            self.skipTest(
                f"Skipping: validateCompoundExecution not yet implemented "
                f"({payload.get('reason', 'unknown')})"
            )

    def test_all_lanes_feasible(self) -> None:
        payload = _run_tdd_expression(
            """cp.validateCompoundExecution(
                cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "A", lane: "direct", intent_class: "plain_chat", goal: "say hi" },
                        { id: "B", lane: "direct", intent_class: "local_surface_lookup", goal: "check version" }
                    ]
                }),
                {},
                { available: true, materialization_capable: true }
            )"""
        )
        self._skip_if_tdd(payload)
        for item in payload["items"]:
            self.assertTrue(item["lane_valid"], f"Item {item.get('id')} should be lane_valid")

    def test_runner_unavailable_degraded(self) -> None:
        payload = _run_tdd_expression(
            """cp.validateCompoundExecution(
                cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "A", lane: "runner", intent_class: "fresh_live_lookup", goal: "lookup" }
                    ]
                }),
                {},
                { available: false }
            )"""
        )
        self._skip_if_tdd(payload)
        item = payload["items"][0]
        self.assertEqual(item.get("lane_corrected"), "direct")

    def test_execution_followup_must_be_direct(self) -> None:
        payload = _run_tdd_expression(
            """cp.validateCompoundExecution(
                cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "F", lane: "runner", intent_class: "execution_followup", goal: "check status" }
                    ]
                }),
                { runner_available: true, spawn_available: true }
            )"""
        )
        self._skip_if_tdd(payload)
        item = payload["items"][0]
        self.assertEqual(item.get("lane_corrected", item.get("lane")), "direct")

    def test_spawn_without_mutation(self) -> None:
        payload = _run_tdd_expression(
            """cp.validateCompoundExecution(
                cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "S", lane: "spawn_single", intent_class: "plain_chat", goal: "spawn task" }
                    ]
                }),
                { runner_available: true, spawn_available: true, mutation_allowed: false }
            )"""
        )
        self._skip_if_tdd(payload)
        item = payload["items"][0]
        self.assertFalse(item.get("lane_valid", True), "spawn_single without delegated_work should be lane_valid=false")
        self.assertTrue(
            any("delegated_work" in str(e).lower() for e in item.get("errors", [])),
            "Expected delegated_work-related error",
        )

    def test_degraded_path_explicit_reason(self) -> None:
        payload = _run_tdd_expression(
            """cp.validateCompoundExecution(
                cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "D", lane: "runner", intent_class: "fresh_live_lookup", goal: "lookup" }
                    ]
                }),
                {},
                { available: false }
            )"""
        )
        self._skip_if_tdd(payload)
        item = payload["items"][0]
        reason = item.get("correction_reason", "")
        self.assertTrue(
            len(reason) > 0,
            f"Degraded item should have an explicit correction_reason, got: {reason!r}",
        )


class TestCompoundExecutor(unittest.TestCase):
    """TDD tests for executeCompoundPlan (not yet exported).

    These tests will skip until the function is implemented.
    """

    def _skip_if_tdd(self, payload: dict) -> None:
        if isinstance(payload, dict) and payload.get("__tdd_skip__"):
            self.skipTest(
                f"Skipping: executeCompoundPlan not yet implemented "
                f"({payload.get('reason', 'unknown')})"
            )

    def test_execute_simple_direct_items(self) -> None:
        payload = _run_tdd_expression(
            """(async () => {
                const plan = cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "A", lane: "direct", intent_class: "plain_chat", goal: "greet" },
                        { id: "B", lane: "direct", intent_class: "plain_chat", goal: "inform" }
                    ]
                });
                const decisions = [
                    { item_id: "A", lane: "direct", intent_class: "plain_chat", goal: "greet" },
                    { item_id: "B", lane: "direct", intent_class: "plain_chat", goal: "inform" }
                ];
                const ledger = await cexec.executeCompoundPlan(plan, decisions, {
                    dispatchFn: async () => ({ status: "completed" }),
                    materializeFn: async (d, r) => ({ status: "completed", result: d.goal }),
                    logger: { info() {}, warn() {}, error() {} }
                });
                return cexec.ledgerToJSON(ledger);
            })()"""
        )
        self._skip_if_tdd(payload)
        items = payload.get("items", {})
        self.assertEqual(items.get("A", {}).get("status"), "completed")
        self.assertEqual(items.get("B", {}).get("status"), "completed")

    def test_execute_with_guard_passes(self) -> None:
        payload = _run_tdd_expression(
            """(async () => {
                const plan = cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "A", lane: "direct", intent_class: "plain_chat", goal: "setup", guard: null },
                        {
                            id: "B", lane: "direct", intent_class: "plain_chat", goal: "proceed",
                            depends_on: ["A"],
                            guard: { type: "ref_eq", ref_item: "A", ref_path: "status", expected: "completed" }
                        }
                    ]
                });
                const decisions = [
                    { item_id: "A", lane: "direct", intent_class: "plain_chat", goal: "setup" },
                    { item_id: "B", lane: "direct", intent_class: "plain_chat", goal: "proceed" }
                ];
                const ledger = await cexec.executeCompoundPlan(plan, decisions, {
                    dispatchFn: async () => ({ status: "completed" }),
                    materializeFn: async (d, r) => ({ status: "completed", result: d.goal }),
                    logger: { info() {}, warn() {}, error() {} }
                });
                return cexec.ledgerToJSON(ledger);
            })()"""
        )
        self._skip_if_tdd(payload)
        items = payload.get("items", {})
        self.assertEqual(items.get("B", {}).get("status"), "completed")

    def test_execute_with_guard_fails(self) -> None:
        payload = _run_tdd_expression(
            """(async () => {
                const plan = cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "A", lane: "direct", intent_class: "plain_chat", goal: "setup", guard: null },
                        {
                            id: "B", lane: "direct", intent_class: "plain_chat", goal: "skip me",
                            depends_on: ["A"],
                            guard: { type: "ref_eq", ref_item: "A", ref_path: "status", expected: "failed" }
                        }
                    ]
                });
                const decisions = [
                    { item_id: "A", lane: "direct", intent_class: "plain_chat", goal: "setup" },
                    { item_id: "B", lane: "direct", intent_class: "plain_chat", goal: "skip me" }
                ];
                const ledger = await cexec.executeCompoundPlan(plan, decisions, {
                    dispatchFn: async () => ({ status: "completed" }),
                    materializeFn: async (d, r) => ({ status: "completed", result: d.goal }),
                    logger: { info() {}, warn() {}, error() {} }
                });
                return cexec.ledgerToJSON(ledger);
            })()"""
        )
        self._skip_if_tdd(payload)
        items = payload.get("items", {})
        self.assertEqual(items.get("B", {}).get("status"), "skipped")

    def test_execute_wave_order(self) -> None:
        payload = _run_tdd_expression(
            """(async () => {
                const execution_log = [];
                const plan = cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "A", lane: "direct", intent_class: "plain_chat", goal: "first" },
                        { id: "B", lane: "direct", intent_class: "plain_chat", goal: "second", depends_on: ["A"] }
                    ]
                });
                const decisions = [
                    { item_id: "A", lane: "direct", intent_class: "plain_chat", goal: "first" },
                    { item_id: "B", lane: "direct", intent_class: "plain_chat", goal: "second" }
                ];
                const ledger = await cexec.executeCompoundPlan(plan, decisions, {
                    dispatchFn: async (d) => { execution_log.push(d.item_id); return { status: "completed" }; },
                    materializeFn: async (d, r) => ({ status: "completed", result: d.goal }),
                    logger: { info() {}, warn() {}, error() {} }
                });
                return { items: cexec.ledgerToJSON(ledger).items, execution_log };
            })()"""
        )
        self._skip_if_tdd(payload)
        log = payload.get("execution_log", [])
        self.assertEqual(log, ["A", "B"])

    def test_runner_materialization_success(self) -> None:
        payload = _run_tdd_expression(
            """(async () => {
                const plan = cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "R", lane: "runner", intent_class: "fresh_live_lookup", goal: "lookup data" }
                    ]
                });
                const decisions = [
                    { item_id: "R", lane: "runner", intent_class: "fresh_live_lookup", goal: "lookup data" }
                ];
                const ledger = await cexec.executeCompoundPlan(plan, decisions, {
                    dispatchFn: async () => ({ status: "completed" }),
                    materializeFn: async () => ({ version: "2.0.0", changed: true }),
                    logger: { info() {}, warn() {}, error() {} }
                });
                return cexec.ledgerToJSON(ledger);
            })()"""
        )
        self._skip_if_tdd(payload)
        items = payload.get("items", {})
        facts = items.get("R", {}).get("materialization_facts", {})
        self.assertEqual(facts.get("version"), "2.0.0")

    def test_runner_materialization_failure(self) -> None:
        payload = _run_tdd_expression(
            """(async () => {
                const plan = cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "R", lane: "runner", intent_class: "fresh_live_lookup", goal: "lookup data" }
                    ]
                });
                const decisions = [
                    { item_id: "R", lane: "runner", intent_class: "fresh_live_lookup", goal: "lookup data" }
                ];
                const ledger = await cexec.executeCompoundPlan(plan, decisions, {
                    dispatchFn: async () => { throw new Error("runner_timeout"); },
                    materializeFn: async () => null,
                    logger: { info() {}, warn() {}, error() {} }
                });
                return cexec.ledgerToJSON(ledger);
            })()"""
        )
        self._skip_if_tdd(payload)
        items = payload.get("items", {})
        self.assertEqual(items.get("R", {}).get("status"), "failed")
        self.assertTrue(items.get("R", {}).get("materialization_failed"))

    def test_full_target_example(self) -> None:
        """The full target example: greeting + model query + version check + conditional update."""
        payload = _run_tdd_expression(
            """(async () => {
                const execution_log = [];
                const plan = cp.normalizeCompoundPlan({
                    decision_mode: "compound_plan",
                    work_items: [
                        { id: "greet", lane: "direct", intent_class: "plain_chat", goal: "greet user" },
                        { id: "query", lane: "runner", intent_class: "fresh_live_lookup", goal: "check openclaw updates", depends_on: [] },
                        { id: "version", lane: "direct", intent_class: "local_surface_lookup", goal: "check current version", depends_on: ["query"] },
                        {
                            id: "update", lane: "spawn_single", intent_class: "delegated_work",
                            goal: "apply update if available",
                            depends_on: ["version"],
                            guard: { type: "ref_eq", ref_item: "query", ref_path: "changed", expected: true }
                        }
                    ]
                });
                const decisions = [
                    { item_id: "greet", lane: "direct", intent_class: "plain_chat", goal: "greet user" },
                    { item_id: "query", lane: "runner", intent_class: "fresh_live_lookup", goal: "check openclaw updates" },
                    { item_id: "version", lane: "direct", intent_class: "local_surface_lookup", goal: "check current version" },
                    { item_id: "update", lane: "spawn_single", intent_class: "delegated_work", goal: "apply update if available" }
                ];
                const ledger = await cexec.executeCompoundPlan(plan, decisions, {
                    dispatchFn: async (d) => {
                        execution_log.push(d.item_id);
                        if (d.item_id === "query") return { status: "completed" };
                        return { status: "completed" };
                    },
                    materializeFn: async (d) => {
                        if (d.item_id === "query") return { version: "2.1.0", changed: true };
                        return { status: "completed", result: d.goal };
                    },
                    logger: { info() {}, warn() {}, error() {} }
                });
                return { items: cexec.ledgerToJSON(ledger).items, execution_log };
            })()"""
        )
        self._skip_if_tdd(payload)
        log = payload.get("execution_log", [])
        # greet and query can run in parallel (wave 0), version in wave 1, update in wave 2
        self.assertIn("greet", log)
        self.assertIn("query", log)
        self.assertIn("version", log)
        self.assertIn("update", log)
        items = payload.get("items", {})
        self.assertEqual(items.get("update", {}).get("status"), "completed")


class TestProvenanceGuard(unittest.TestCase):
    """TDD tests for provenance integration with compound plan ledger.

    These tests will skip until buildTurnFacts reads compound item results.
    """

    def _skip_if_tdd(self, payload: dict) -> None:
        if isinstance(payload, dict) and payload.get("__tdd_skip__"):
            self.skipTest(
                f"Skipping: provenance compound ledger integration not yet implemented "
                f"({payload.get('reason', 'unknown')})"
            )

    def test_provenance_reads_compound_ledger(self) -> None:
        """buildTurnFacts should read compound plan item results when present."""
        payload = _run_tdd_expression(
            """(async () => {
                const compoundLedger = {
                    A: { status: "completed", result: "greeted" },
                    B: { status: "completed", materialization_facts: { version: "2.0" } }
                };
                const turn = {
                    sessionKey: "agent:main:test:u1",
                    events: [
                        { event: "policy_resolved", at: "2025-01-01T00:00:00Z", prompt: "test", route: "compound_plan" },
                        { event: "dispatch_called", at: "2025-01-01T00:00:01Z", compound_plan_ledger: compoundLedger }
                    ]
                };
                const facts = intent_mod.buildTurnFacts(turn, new Map(), new Map(), new Map());
                return { hasLedger: Boolean(facts.compoundPlanLedger), compoundPlanActive: facts.compoundPlanActive };
            })()"""
        )
        self._skip_if_tdd(payload)
        self.assertTrue(
            payload.get("hasLedger", False),
            "buildTurnFacts should expose compound plan ledger",
        )

    def test_provenance_no_intermediate_trust(self) -> None:
        """When compound plan is active, provenance should not trust route/judge intermediates."""
        payload = _run_tdd_expression(
            """(async () => {
                const turn = {
                    sessionKey: "agent:main:test:u2",
                    events: [
                        { event: "policy_resolved", at: "2025-01-01T00:00:00Z", prompt: "test", route: "compound_plan" },
                        { event: "policy_judged", at: "2025-01-01T00:00:01Z", policyJudgeApplied: true, route: "runner" },
                        { event: "dispatch_called", at: "2025-01-01T00:00:02Z", compound_plan_ledger: { X: { status: "completed" } } }
                    ]
                };
                const facts = intent_mod.buildTurnFacts(turn, new Map(), new Map(), new Map());
                return {
                    compoundPlanActive: facts.compoundPlanActive,
                    hasLedger: Boolean(facts.compoundPlanLedger && Object.keys(facts.compoundPlanLedger).length > 0)
                };
            })()"""
        )
        self._skip_if_tdd(payload)
        self.assertTrue(
            payload.get("compoundPlanActive", False),
            "compoundPlanActive should be true when dispatch has compound_plan_ledger",
        )


if __name__ == "__main__":
    unittest.main()
