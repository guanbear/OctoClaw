# Phase 4 Pattern Map

## Pattern Summary

Phase 4 should reuse the repo's existing verification and policy seams instead of creating new orchestration layers.

## File Patterns

### 1. Promotion gate / harness pattern

- **Primary files:** `lib/harness_gate.py`, `lib/acceptance_runtime.py`, `lib/replay_validation.py`
- **Test analogs:** `tests/test_harness_gate.py`, `tests/test_acceptance_runtime.py`, `tests/test_replay_validation.py`, `tests/test_delivery_relay_reconcile.py`
- **Pattern:** small Python helpers expose JSON-friendly results, and tests verify structure with focused `subprocess.run(...)` or direct function calls.

### 2. Route-policy golden + shadow pattern

- **Primary files:** `extensions/octoclaw-runtime/policy/decide.js`, `recommendation.js`, `config.js`, `index.js`
- **Test analogs:** `tests/test_router_policy_v2_goldens.py`, `tests/test_route_recommendation.py`, `tests/test_policy_judge_shadow_report.py`, `tests/test_octoclaw_runtime_extension.py`
- **Pattern:** JS outputs are exercised through Node subprocess helpers from Python tests; contracts are asserted as explicit schema/version/value fields.

### 3. Advanced-routing gated execution pattern

- **Primary files:** `extensions/octoclaw-runtime/policy/compound_plan.js`, `compound_executor.js`, `planner.js`, `lib/auto_router.py`
- **Test analogs:** `tests/test_compound_plan.py`, `tests/test_auto_router.py`, `tests/test_auto_router_boundary.py`, `tests/test_eval_suite.py`
- **Pattern:** normalize -> validate -> schedule -> execute, with safe fallback to non-execution when contracts are invalid or unavailable.

## Concrete Conventions

1. **Schema-first outputs**
   - Recommendation and planner payloads always carry explicit `schema_version` strings.

2. **Python test harness over JS internals**
   - Prefer exercising runtime JS modules through Node subprocesses from Python tests, matching existing `run_runtime_helper(...)` and related helpers.

3. **Shadow data stays observational**
   - Fields like `route_recommendation`, `budget_recommendation`, `auto_router`, and replay summaries are compared and reported, not treated as execution truth.

4. **Fail-open vs fail-closed rules are explicit**
   - Compound planner currently fails open to `simple_route`; truth-path helper ingestion fails closed. Phase 4 should preserve those explicit behaviors instead of hiding them.
