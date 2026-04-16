---
phase: 04-eval-gates-and-advanced-routing
plan: 01
subsystem: testing
tags: [python, replay, acceptance, harness, routing, eval-gates]
requires:
  - phase: 03-native-substrate-and-operator-surfaces
    provides: Native truth delegation, substrate-first projections, and deferred route-policy follow-up work for Phase 4 gates
provides:
  - Promotion-oriented replay summaries that expose delivery failures, stale recovery, fallback, and contract mismatch counts
  - Quick/full harness presets that explicitly include replay and acceptance gate modules for Phase 4 promotion runs
  - Regression coverage that locks acceptance bootstrap outputs to workspace-local temp roots and deterministic gateway settings
affects: [phase-4-routing, promotion-gates, acceptance-runtime, replay-validation]
tech-stack:
  added: []
  patterns: [json-friendly replay gate metrics, explicit eval preset listing, workspace-local acceptance bootstrap verification]
key-files:
  created: [.planning/phases/04-eval-gates-and-advanced-routing/04-01-SUMMARY.md]
  modified: [lib/replay_validation.py, lib/harness_gate.py, tests/test_replay_validation.py, tests/test_harness_gate.py, tests/test_acceptance_runtime.py]
key-decisions:
  - "Replay validation remains an eval-only summary layer: new counters expose stale recovery, fallback, delivery, and contract mismatch evidence without changing runtime truth authority."
  - "Phase 4 promotion presets now list replay validation and acceptance bootstrap modules explicitly so quick and full gate outputs match the validation strategy."
patterns-established:
  - "Promotion summary pattern: replay gates report route, budget, delivery, fallback, and stale-recovery evidence together in one JSON-friendly payload."
  - "Acceptance gate pattern: workspace-local temp homes and deterministic gateway bind/port are asserted directly in focused bootstrap tests."
requirements-completed: [EVAL-01]
duration: 2 min
completed: 2026-04-16
---

# Phase 4 Plan 1: Activate promotion-grade replay, delivery, harness, and acceptance gates Summary

**Replay gate summaries now expose stale recovery, fallback, delivery-failure, and contract-mismatch evidence while harness presets explicitly route Phase 4 acceptance checks through the promotion path.**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-16T13:20:47Z
- **Completed:** 2026-04-16T13:22:53Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Expanded replay validation summaries so promotion checks can see unresolved fallback, stale recovery, delivery failure, and execution-contract mismatch classes in one payload.
- Added focused regression coverage that keeps replay summary counters grep-visible and preserves delivery relay reconciliation expectations for compensated, deferred, and task-not-ready states.
- Promoted replay validation and acceptance bootstrap modules into the quick/full harness presets and strengthened acceptance bootstrap tests around copied files, workspace-local temp roots, and deterministic gateway settings.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Strengthen replay and delivery gate summaries around duplicate, stale, and fallback outcomes** - `9254f8a` (test)
2. **Task 1 GREEN: Strengthen replay and delivery gate summaries around duplicate, stale, and fallback outcomes** - `a01c02e` (feat)
3. **Task 2 RED: Promote harness presets and acceptance bootstrap into the eval gate path** - `377d559` (test)
4. **Task 2 GREEN: Promote harness presets and acceptance bootstrap into the eval gate path** - `641ea20` (feat)

**Plan metadata:** `(pending)`

_Note: Both tasks were marked `tdd="true"` and executed as RED → GREEN commit pairs._

## Files Created/Modified
- `lib/replay_validation.py` - Adds promotion-oriented replay counters for delivery failures, unresolved fallback, stale recovery, and execution-contract mismatches while preserving the JSON-friendly summary contract.
- `tests/test_replay_validation.py` - Covers route coverage, delivery correctness, stale recovery, fallback, and mismatch counters in the replay summary payload.
- `lib/harness_gate.py` - Extends quick/full presets so replay validation and acceptance bootstrap modules are part of the machine-listed eval gate path.
- `tests/test_harness_gate.py` - Locks the expected Phase 4 replay, shadow, acceptance, and delivery modules into the preset JSON output.
- `tests/test_acceptance_runtime.py` - Verifies copied config and agent files, workspace-local temp roots, and deterministic gateway settings after acceptance bootstrap.

## Decisions Made
- Replay validation was kept on the eval plane only: the new counters are derived from replay events and findings instead of changing runtime truth or delivery authority.
- Harness preset JSON output remains the contract for gate selection, so Phase 4 coverage was added by expanding preset module lists rather than creating a separate gate runner.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 4 promotion gates now expose replay and acceptance evidence needed before routing depth increases.
- Plan 04-02 can build on these strengthened gate outputs to stabilize route-policy shadow reporting and optimization telemetry contracts.

## Verification Results

- `python3 -m pytest tests/test_replay_validation.py tests/test_delivery_relay_reconcile.py -q` ✅
- `python3 -m pytest tests/test_harness_gate.py tests/test_acceptance_runtime.py -q` ✅
- `python3 -m pytest tests/test_replay_validation.py tests/test_delivery_relay_reconcile.py tests/test_harness_gate.py tests/test_acceptance_runtime.py -q` ✅

## Self-Check: PASSED

- FOUND: `.planning/phases/04-eval-gates-and-advanced-routing/04-01-SUMMARY.md`
- FOUND: `9254f8a`
- FOUND: `a01c02e`
- FOUND: `377d559`
- FOUND: `641ea20`

---
*Phase: 04-eval-gates-and-advanced-routing*
*Completed: 2026-04-16*
