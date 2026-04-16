---
phase: 03-native-substrate-and-operator-surfaces
plan: 02
subsystem: ui
tags: [python, operator-surfaces, substrate, projections, status, timeline]
requires:
  - phase: 03-native-substrate-and-operator-surfaces
    provides: TS-native runtime truth records and wrapper metadata from Plan 03-01
provides:
  - Shared substrate-first projection assembly for task operator surfaces
  - Projection-backed task anchors, queue views, and timeline views with ownership and workspace state
  - Status summaries that count managed/native activity from the shared substrate projection path
affects: [operator-surfaces, im-surfaces, status-rendering, task-anchor-commands]
tech-stack:
  added: []
  patterns: [shared substrate projection builder, projection-backed task anchor vocabulary, status rendering from projection fields]
key-files:
  created: []
  modified: [lib/runtime_snapshot.py, lib/task_display.py, lib/status_render.py, tests/test_task_display.py, tests/test_status_render.py, tests/test_task_anchor_commands.py]
key-decisions:
  - "Operator surfaces now read ownership, workspace mode, queue position, delivery state, and substrate revision from one shared projection builder in runtime_snapshot.py."
  - "Status summaries treat projection-backed substrate ids and delivery state as authoritative read-model inputs instead of reconstructing truth only from legacy taskflow mirror fields."
patterns-established:
  - "Shared surface vocabulary pattern: anchors, queue, and timeline expose claim_owner, workspace_mode, write_scope_summary, substrate_state, substrate_revision, and action_availability from the same projection bundle."
  - "Substrate-first status pattern: operator summaries count tracked/native activity from projection-backed substrate task ids, sync mode, and delivery state when legacy binding fields are absent."
requirements-completed: [SURF-01]
duration: 4 min
completed: 2026-04-16
---

# Phase 3 Plan 2: Build shared substrate projections and rebind operator surfaces Summary

**Shared substrate-first projections now drive task anchors, queue and timeline views, and operator status summaries with ownership, workspace, and delivery facts coming from one read model.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-16T11:16:31Z
- **Completed:** 2026-04-16T11:19:51Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Added a shared substrate surface projection builder in `lib/runtime_snapshot.py` that normalizes ownership, workspace, delivery, queue, and substrate revision facts for operator surfaces.
- Rebound `build_task_anchor()`, `build_task_queue_view()`, and `build_task_timeline()` to one projection vocabulary so details, queue, and timeline stop re-deriving incompatible truth.
- Updated substrate status summaries and command-surface regression tests so operator text output remains substrate-first while preserving text-friendly affordances.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Add shared substrate-first projection assembly for operator surfaces** - `d7b2938` (test)
2. **Task 1 GREEN: Add shared substrate-first projection assembly for operator surfaces** - `b717857` (feat)
3. **Task 2 RED: Rebind status, details, queue, and timeline commands to the shared substrate projections** - `5a57800` (test)
4. **Task 2 GREEN: Rebind status, details, queue, and timeline commands to the shared substrate projections** - `21dd9cf` (feat)

**Plan metadata:** `(pending)`

_Note: Both tasks followed a TDD RED → GREEN sequence._

## Files Created/Modified
- `lib/runtime_snapshot.py` - Adds `build_substrate_surface_projection()` to normalize substrate ids, sync mode, ownership, workspace mode, queue position, delivery state, and action availability.
- `lib/task_display.py` - Reuses the shared projection bundle for anchor, queue, detail, and timeline surfaces and exposes a single projection vocabulary.
- `lib/status_render.py` - Counts tracked, managed, native-active, and delivery states from shared projection fields when legacy binding fields are incomplete.
- `tests/test_task_display.py` - Adds regression coverage for projection-backed ownership/workspace/substrate fields across anchor, queue, and timeline outputs.
- `tests/test_status_render.py` - Verifies substrate summaries count projection-backed managed/native activity and delivery state.
- `tests/test_task_anchor_commands.py` - Verifies details, queue, and timeline command JSON outputs expose projection-backed ownership, workspace mode, and substrate revision.

## Decisions Made
- Centralized operator-surface truth shaping in `build_substrate_surface_projection()` instead of expanding per-renderer enrichment helpers, so queue, details, and timeline all consume the same contract.
- Let status summaries treat projection-backed substrate task ids as tracked/native-bound evidence so operator reporting remains correct even when legacy `openclaw_taskflow` mirror fields are absent.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Existing task normalization seeded `openclaw_taskflow_substrate_revision` as `0`, which initially masked projection-backed revision values in the new tests; the implementation was corrected inline so explicit projected revisions win when present.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 03-03 can now bind IM/display consumers to the same projection vocabulary already exposed to CLI/operator surfaces.
- Shared ownership, workspace, delivery, and substrate revision fields are now available as stable read-model inputs for follow-up display-contract work.

## Self-Check: PASSED
