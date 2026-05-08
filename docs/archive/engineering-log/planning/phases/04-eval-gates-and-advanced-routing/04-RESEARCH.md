# Phase 4: Eval Gates and Advanced Routing - Research

**Researched:** 2026-04-16
**Status:** Complete
**Requirements:** EVAL-01, AUTO-01

## Goal

Turn the existing replay, route-policy, delivery, and acceptance checks into promotion gates, then deepen routing only through shadow/gated contracts that preserve the established truth/projection/artifact/telemetry plane split.

## Existing Baseline

### Runtime and truth contracts already established

- `extensions/octoclaw-runtime/src/plugin.ts` is the formal TypeScript plugin seam.
- `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts` already emits separate `truth`, `projection`, `artifact`, and `telemetry` payload families.
- `extensions/octoclaw-runtime/index.js` already records `runtime_truth`, `route_recommendation`, `budget_recommendation`, replay events, and `compound_plan_blocked` metadata on the live path.
- `packages/octoclaw-policy/src/judge/index.ts` still hard-limits live routing authority to `reply`, `delegate.single`, and `observe`.

### Existing eval/routing artifacts to build on

- Replay and validation coverage already exists in `tests/test_replay_validation.py`, `tests/test_replay_automation.py`, `tests/test_replay_curate.py`, and `tests/test_runtime_policy_replay_schema.py`.
- Golden route contracts already exist in `tests/test_route_goldens.py` and `tests/test_router_policy_v2_goldens.py`.
- Shadow/judge reporting already exists in `tests/test_policy_judge_shadow_report.py`.
- Acceptance and harness scaffolding already exists in `lib/acceptance_runtime.py`, `tests/test_acceptance_runtime.py`, `lib/harness_gate.py`, and `tests/test_harness_gate.py`.
- Advanced-routing seams already exist in `extensions/octoclaw-runtime/policy/compound_plan.js`, `compound_executor.js`, `planner.js`, `recommendation.js`, and `lib/auto_router.py` with boundary tests in `tests/test_auto_router*.py`.

## Recommended Direction

### 1. Make Phase 4 evaluation gates promotion-blocking

Use the existing harness and replay infrastructure instead of inventing a second verification path.

Promotion coverage should explicitly prove:

1. duplicate request or delivery bugs are caught from replay/delivery evidence,
2. stale ownership or recovery failures surface in gate output,
3. write-scope conflicts remain serialized or explicitly blocked,
4. acceptance runtime bootstrapping stays reproducible for black-box checks.

### 2. Keep advanced routing in shadow or gated mode

The repo already exposes recommendation and planner contracts (`route_recommendation`, `budget_recommendation`, `auto_router`, `compound_plan`, `compound_plan_blocked`). Phase 4 should deepen these contracts without granting live authority to bypass the established Phase 2 / Phase 3 runtime path.

That means:

- keep `runtime_truth` as the execution authority,
- treat recommendation, budget, shadow, and optimization data as telemetry/artifact planes,
- allow compound planning/execution only behind explicit gating and validation,
- use replay/shadow evidence to compare recommended vs executed routes.

## Standard Stack

- Node ESM + direct `.ts` imports for runtime and policy modules.
- Python `unittest` / `pytest`-driven regression suites for JS and Python parity checks.
- Existing replay JSONL files under workspace `tmp/octopus/`.
- Existing acceptance runtime bootstrap and harness gate scripts.

## Architecture Patterns To Preserve

1. **Truth-plane separation**
   - Execution truth stays in native-backed runtime payloads.
   - Recommendation, optimization, replay summaries, and auto-router data stay out of the live truth plane.

2. **Shadow-first routing evolution**
   - New route arbitration and optimization logic should emit comparable recommendation/shadow artifacts before affecting live execution.

3. **Promotion-through-gates**
   - The accepted path should be: focused regressions -> replay/golden checks -> harness preset(s) -> acceptance run.

4. **Fail-closed compound routing**
   - If compound plan validation, lane feasibility, or guard evaluation is incomplete, keep blocking/deferred behavior instead of silently executing broader routing.

## Don't Hand-Roll

- Do not invent a new eval runner when `lib/harness_gate.py`, replay validators, and acceptance runtime already exist.
- Do not create a second routing authority outside `buildDecision()`, `resolvePolicyDecisionForContext()`, `route_recommendation`, `budget_recommendation`, and `auto_router` outputs.
- Do not collapse telemetry/recommendation data into `runtime_truth`.

## Common Pitfalls

1. **Telemetry becoming authority**
   - `route_recommendation`, `budget_recommendation`, `auto_router`, and replay summaries are useful, but they must never overwrite `runtime_truth` or actual dispatch facts.

2. **Acceptance gate drift**
   - If harness presets, replay validation, and acceptance bootstrap evolve separately, CI can report green while black-box regressions are still possible.

3. **Compound routing bypassing gate order**
   - Compound execution should consume validated plan objects and lane feasibility checks before any dispatch/materialization path is used.

4. **Route-policy regressions staying invisible**
   - The deferred failures called out by Phase 3 verification must become explicit Phase 4 gate cases, not implicit background debt.

## Architectural Responsibility Map

| Responsibility | Correct Tier | Files |
|---|---|---|
| Live truth authority | Runtime/plugin truth path | `extensions/octoclaw-runtime/src/plugin.ts`, `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts`, `extensions/octoclaw-runtime/index.js` |
| Route and budget recommendations | Policy/recommendation plane | `extensions/octoclaw-runtime/policy/decide.js`, `recommendation.js`, `config.js` |
| Compound planning and execution | Advanced-routing gated plane | `extensions/octoclaw-runtime/policy/planner.js`, `compound_plan.js`, `compound_executor.js` |
| Replay, golden, and acceptance gates | Verification/promote plane | `lib/harness_gate.py`, `lib/acceptance_runtime.py`, `lib/replay_validation.py`, related tests |

## Discovery Verdict

**Discovery Level:** 2 — Standard Research

Reason:

- Existing patterns are strong, but this phase crosses verification, runtime policy, replay, and gated advanced-routing seams.
- The work is not a pure CRUD extension; it coordinates existing contracts into a promotion path.

## Validation Architecture

- **Quick verification lane:**
  - `python3 -m pytest tests/test_replay_validation.py tests/test_harness_gate.py tests/test_acceptance_runtime.py tests/test_delivery_relay_reconcile.py -q`
  - `python3 -m pytest tests/test_router_policy_v2_goldens.py tests/test_policy_judge_shadow_report.py tests/test_route_recommendation.py -q`
  - `python3 -m pytest tests/test_compound_plan.py tests/test_auto_router.py tests/test_auto_router_boundary.py -q`
- **Full verification lane:**
  - `python3 lib/harness_gate.py --preset full --format json`
- **Critical assertions:**
  1. replay and relay evidence reveal duplicate delivery / retry / stale recovery regressions,
  2. route-policy goldens and shadow summaries remain valid under the current runtime contract,
  3. acceptance bootstrap remains reproducible from workspace-local temp roots,
  4. advanced-routing outputs remain gated/shadowed and consume validated runtime/eval contracts.

## Plan Recommendations

Split Phase 4 into **three execute plans**:

1. **Activate promotion-grade eval gates and black-box acceptance coverage**
2. **Stabilize route-policy shadow outputs and optimization telemetry contracts**
3. **Enable gated compound routing and auto-router consumption on validated contracts**

This keeps verification-first work ahead of advanced-routing enablement and matches the roadmap goal ordering.

## Research Output

- Plan 04-01 should cover EVAL-01 through replay, golden, delivery, and acceptance gate strengthening.
- Plan 04-02 should keep AUTO-01 in shadow/gated mode by extending recommendation, replay, and telemetry contracts without changing truth authority.
- Plan 04-03 should use validated compound and auto-router contracts, and must depend on the eval/routing gate work.

---

## RESEARCH COMPLETE
