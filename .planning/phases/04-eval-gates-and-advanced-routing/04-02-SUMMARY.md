---
phase: 04-eval-gates-and-advanced-routing
plan: 02
subsystem: runtime
tags: [routing, telemetry, replay, shadow-report, policy, goldens]
requires:
  - phase: 03-native-substrate-and-operator-surfaces
    provides: Native-backed runtime truth delegation plus deferred runtime route-policy expectations carried into Phase 4
provides:
  - Stable route and budget recommendation telemetry contracts for policy decisions
  - Replay payload evidence for recommendation conflicts without merging telemetry into runtime truth
  - Shadow drift assertions for policy judge reports and targeted runtime verification coverage
affects: [eval-gates, advanced-routing, replay-analysis, promotion-gates]
tech-stack:
  added: []
  patterns: [non-authoritative recommendation telemetry, replay conflict evidence separate from runtime truth, targeted shadow drift verification]
key-files:
  created: [.planning/phases/04-eval-gates-and-advanced-routing/04-02-SUMMARY.md, .planning/phases/04-eval-gates-and-advanced-routing/deferred-items.md]
  modified: [extensions/octoclaw-runtime/policy/decide.js, extensions/octoclaw-runtime/index.js, tests/test_router_policy_v2_goldens.py, tests/test_route_recommendation.py, tests/test_policy_judge_shadow_report.py, tests/test_octoclaw_runtime_extension.py]
key-decisions:
  - "Recommendation and budget payloads remain observational telemetry with schema-stable arbitration and consistency fields, never runtime truth."
  - "Replay evidence exposes recommendation conflicts and runtime-truth enrichment failures as side-band metadata instead of mutating authoritative truth payloads."
patterns-established:
  - "Recommendation telemetry pattern: route_recommendation, budget_recommendation, and auto_router stay attached to decisions as comparable optimization signals only."
  - "Replay evidence pattern: conflict and shadow drift fields are emitted on replay/report payloads while runtime_truth remains a separate authoritative channel."
requirements-completed: [EVAL-01, AUTO-01]
duration: 13 min
completed: 2026-04-16
---

# Phase 4 Plan 2: Stabilize route-policy goldens, shadow drift reporting, and optimization telemetry contracts Summary

**Route-policy recommendation telemetry, replay conflict evidence, and shadow drift reporting now expose promotion-grade routing signals without letting optimization data overwrite runtime truth.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-04-16T13:18:53Z
- **Completed:** 2026-04-16T13:32:12Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Tightened golden and helper tests so route and budget recommendation payloads assert explicit schema, arbitration, and consistency fields while staying non-authoritative.
- Corrected direct control-observer latency-ack behavior so route-policy goldens stay stable for status/follow-up prompts.
- Exposed replay payload builders and targeted runtime/shadow coverage for recommendation conflict evidence, with runtime-truth failures recorded as observational metadata instead of execution truth.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Tighten route-policy golden contracts and recommendation telemetry fields** - `6d5dda4` (test)
2. **Task 1 GREEN: Tighten route-policy golden contracts and recommendation telemetry fields** - `8d763c0` (feat)
3. **Task 2 RED: Expose shadow drift and replay recommendation evidence on the runtime path** - `364a5f3` (test)
4. **Task 2 GREEN: Expose shadow drift and replay recommendation evidence on the runtime path** - `b7106b6` (feat)

**Plan metadata:** `(pending)`

## Files Created/Modified
- `extensions/octoclaw-runtime/policy/decide.js` - Keeps recommendation telemetry attached to decisions while fixing control-observer latency-ack behavior for goldens.
- `extensions/octoclaw-runtime/index.js` - Exports replay payload builders for targeted verification and guards runtime-truth enrichment failures as observational metadata.
- `tests/test_router_policy_v2_goldens.py` - Verifies route/budget recommendation schemas and arbitration/consistency fields alongside router decision goldens.
- `tests/test_route_recommendation.py` - Adds focused contract tests for recommendation conflict metadata and budget consistency behavior.
- `tests/test_policy_judge_shadow_report.py` - Verifies shadow compared/matched/drifted counts and route drift details from the shadow report payload.
- `tests/test_octoclaw_runtime_extension.py` - Adds targeted replay/runtime-wrapper assertions proving recommendation conflict evidence stays outside `runtime_truth`.
- `.planning/phases/04-eval-gates-and-advanced-routing/deferred-items.md` - Records broader pre-existing runtime route-policy regressions left out of scope for this plan.

## Decisions Made
- Kept `route_recommendation`, `budget_recommendation`, and `auto_router` as schema-stable comparison signals on the decision payload instead of introducing any second authority path.
- Exported replay payload builders from the runtime test surface so targeted runtime tests can assert conflict evidence directly without depending on unrelated full-suite route-policy behavior.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected control-observer latency ack drift in route-policy goldens**
- **Found during:** Task 1 (Tighten route-policy golden contracts and recommendation telemetry fields)
- **Issue:** The `八爪鱼状态` golden was incorrectly emitting `latency_ack.required = true`, breaking the expected direct status-followup contract.
- **Fix:** Adjusted `latencyAckPolicy()` so control-observer prompts only require latency acks when direct state-lookup signals are actually present.
- **Files modified:** `extensions/octoclaw-runtime/policy/decide.js`
- **Verification:** `python3 -m pytest tests/test_router_policy_v2_goldens.py tests/test_route_recommendation.py -q`
- **Committed in:** `8d763c0`

**2. [Rule 3 - Blocking] Made runtime replay evidence testable without turning runtime-truth failures into hard aborts**
- **Found during:** Task 2 (Expose shadow drift and replay recommendation evidence on the runtime path)
- **Issue:** Targeted runtime verification could not assert replay evidence because replay payload builders were not exported to the test seam, and runtime-truth helper failures could abort policy resolution before replay metadata was recorded.
- **Fix:** Exported replay payload builders via `__octoclawTest` and guarded runtime-truth enrichment failures as observational metadata so replay evidence remains available without mutating authoritative truth.
- **Files modified:** `extensions/octoclaw-runtime/index.js`, `tests/test_octoclaw_runtime_extension.py`
- **Verification:** `python3 -m pytest tests/test_octoclaw_runtime_extension.py -q -k "test_runtime_wrapper_exports_ts_native_truth_delegation_metadata or test_runtime_wrapper_records_ts_native_truth_on_policy_decision_metadata or test_runtime_replay_payload_surfaces_recommendation_conflict_without_merging_runtime_truth or test_runtime_replay_dispatch_metadata_keeps_runtime_truth_separate_from_conflict_fields or test_runtime_policy_resolution_records_runtime_truth_failures_as_observational_metadata"`
- **Committed in:** `b7106b6`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes were required to keep routing telemetry observable and contract-stable without changing runtime truth authority. No architectural scope expansion was introduced.

## Issues Encountered
- The broader acceptance command for `tests/test_octoclaw_runtime_extension.py -q -k "policy_judge or replay or runtime_wrapper"` still includes pre-existing or wider-scope route-policy expectations around execution followup and policy-judge override behavior. Per scope-boundary rules these were logged to `deferred-items.md` instead of being expanded into unrelated routing rewrites inside this plan.

## Verification Results

- `python3 -m pytest tests/test_router_policy_v2_goldens.py tests/test_route_recommendation.py -q` ✅
- `python3 -m pytest tests/test_policy_judge_shadow_report.py tests/test_octoclaw_runtime_extension.py -q -k "test_runtime_wrapper_exports_ts_native_truth_delegation_metadata or test_runtime_wrapper_records_ts_native_truth_on_policy_decision_metadata or test_runtime_replay_payload_surfaces_recommendation_conflict_without_merging_runtime_truth or test_runtime_replay_dispatch_metadata_keeps_runtime_truth_separate_from_conflict_fields or test_runtime_policy_resolution_records_runtime_truth_failures_as_observational_metadata"` ✅
- `python3 -m pytest tests/test_policy_judge_shadow_report.py tests/test_octoclaw_runtime_extension.py -q -k "policy_judge or replay or runtime_wrapper"` ⚠️ partially blocked by broader runtime route-policy expectations recorded in `deferred-items.md`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Recommendation telemetry, replay conflict evidence, and shadow drift summaries are now explicit enough for deeper routing work to compare suggested versus executed behavior without confusing telemetry for truth.
- Plan 04-03 can consume these stabilized contracts while the broader deferred runtime route-policy expectations remain tracked separately for follow-up routing work.

## Self-Check: PASSED

- FOUND: `.planning/phases/04-eval-gates-and-advanced-routing/04-02-SUMMARY.md`
- FOUND: `6d5dda4`
- FOUND: `8d763c0`
- FOUND: `364a5f3`
- FOUND: `b7106b6`
