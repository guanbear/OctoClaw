---
phase: 03-native-substrate-and-operator-surfaces
plan: 03
subsystem: ui
tags: [im, runtime, substrate, projections, conversation-grounding, display-contracts]
requires:
  - phase: 03-native-substrate-and-operator-surfaces
    provides: Shared substrate-first operator projections and task surface vocabulary from Plans 03-01 and 03-02
provides:
  - IM/display contracts aligned to the shared substrate projection vocabulary
  - Conversation grounding that cites shared projection-backed ownership, workspace, substrate, queue, delivery, and action facts
  - Regression coverage proving IM follow-up and display paths reuse the same projection truth as operator surfaces
affects: [im-surfaces, operator-surfaces, runtime-followups, display-contracts]
tech-stack:
  added: []
  patterns: [shared projection vocabulary across IM and operator surfaces, projection-backed grounded follow-up facts, explicit forbidden inferred truth fields]
key-files:
  created: []
  modified: [extensions/octoclaw-runtime/conversation-control.js, extensions/octoclaw-runtime/policy/intent.js, lib/im_display_contract.py, lib/runtime_snapshot.py, lib/task_display.py, tests/test_im_display_contract.py, tests/test_im_thread.py, tests/test_octoclaw_runtime_extension.py, .planning/phases/03-native-substrate-and-operator-surfaces/deferred-items.md]
key-decisions:
  - "User-facing IM task surfaces now expose shared projection metadata alongside anchor text instead of inventing an IM-only truth model."
  - "Grounded follow-up facts are assembled from shared task projection fields in the runtime intent path so operator and IM reads stay aligned on one projection truth."
patterns-established:
  - "Shared IM/operator vocabulary pattern: claim_owner, workspace_mode, write_scope_summary, substrate_state, substrate_revision, delivery_state, and action_availability travel together as read-only projection facts."
  - "Grounded follow-up pattern: conversation-control formats projection-backed facts for IM answers but still states when facts are unavailable instead of guessing from memory."
requirements-completed: [SURF-01]
duration: 10 min
completed: 2026-04-16
---

# Phase 3 Plan 3: Rebind IM and display surfaces to the shared projection contracts Summary

**IM display contracts and grounded follow-up responses now reuse the same substrate-first ownership, workspace, queue, delivery, and action projection vocabulary as operator task surfaces.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-04-16T11:22:27Z
- **Completed:** 2026-04-16T11:32:46Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Extended the IM/display contract so shared projection fields for ownership, workspace, substrate, delivery, and action availability are explicit instead of implicit operator-only data.
- Updated IM-facing task surfaces so user and operator payloads reuse projection-backed anchor facts without introducing renderer-authored or guessed truth fields.
- Reworked grounded follow-up fact assembly so conversation-control cites shared projection facts for ownership, workspace, substrate state/revision, queue position, delivery, and available actions.

## Task Commits

Each task was committed atomically:

1. **Task 1: Align IM/display contract definitions to the shared substrate projection vocabulary** - `e054ef0` (feat)
2. **Task 2: Make conversation grounding consume shared substrate projections instead of owning separate truth reconstruction** - `015e1b0` (feat)

**Plan metadata:** `(pending)`

## Files Created/Modified
- `lib/im_display_contract.py` - Adds shared projection optional fields and keeps forbidden inferred truth fields explicit for IM/display payloads.
- `lib/runtime_snapshot.py` - Adjusts projection delivery-state precedence so explicit projection-backed delivery facts win over internal handoff defaults.
- `lib/task_display.py` - Exposes shared projection metadata from IM-facing user surfaces and continues to reuse projection-backed anchors.
- `extensions/octoclaw-runtime/policy/intent.js` - Derives grounded follow-up facts from shared projection-backed task fields in the runtime intent path.
- `extensions/octoclaw-runtime/conversation-control.js` - Formats shared projection facts into grounded follow-up context while preserving no-guess behavior.
- `tests/test_im_display_contract.py` - Verifies shared projection optional fields are part of the IM/display contract.
- `tests/test_im_thread.py` - Verifies IM-facing surfaces expose shared projection fields and forbid inferred truth fields.
- `tests/test_octoclaw_runtime_extension.py` - Verifies grounded follow-up context includes shared projection-backed ownership, workspace, substrate, queue, delivery, and action facts.
- `.planning/phases/03-native-substrate-and-operator-surfaces/deferred-items.md` - Records unrelated pre-existing runtime route-policy failures discovered during plan-level verification.

## Decisions Made
- User-facing IM task surfaces now expose a `projection` block sourced from the same anchor/projection fields used by operator surfaces, avoiding a second IM-owned truth family.
- Shared projection facts are extracted in `policy/intent.js` and rendered in `conversation-control.js` so grounded follow-up answers cite one read model regardless of whether the user asks from IM or operator channels.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preferred explicit projection delivery state over inferred internal handoff state**
- **Found during:** Task 1 (Align IM/display contract definitions to the shared substrate projection vocabulary)
- **Issue:** IM-facing anchors surfaced `internal_only` when explicit projection-backed `delivery_state` existed, which broke alignment between shared task projections and IM rendering.
- **Fix:** Updated `build_substrate_surface_projection()` to prefer explicit `delivery_state` and runtime-truth delivery facts before falling back to `handoff_state`.
- **Files modified:** `lib/runtime_snapshot.py`
- **Verification:** `python3 -m pytest tests/test_im_thread.py -q`
- **Committed in:** `e054ef0`

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** The auto-fix was necessary to keep IM rendering aligned with the shared projection contract. No architectural scope change was introduced.

## Issues Encountered
- Full plan-level verification `python3 -m pytest tests/test_octoclaw_runtime_extension.py tests/test_im_thread.py -q` remains blocked by six unrelated pre-existing runtime route-policy failures in `tests/test_octoclaw_runtime_extension.py`. The new targeted IM/shared-projection grounding tests pass, and the unrelated failures were logged to `deferred-items.md` per scope-boundary rules.

## Verification Results

- `python3 -m pytest tests/test_im_thread.py -q` ✅
- `python3 -m pytest tests/test_octoclaw_runtime_extension.py -q -k "shared_projection_fields_for_followup_facts or includes_task_event_execution_facts or recovers_task_progress_from_task_state or includes_job_disposition_and_final_delivery_facts or recovers_runner_lookup_provenance_from_task_state"` ✅
- `python3 -m pytest tests/test_octoclaw_runtime_extension.py tests/test_im_thread.py -q -k "shared_projection_fields_for_followup_facts or includes_task_event_execution_facts or recovers_task_progress_from_task_state or includes_job_disposition_and_final_delivery_facts or recovers_runner_lookup_provenance_from_task_state or SharedProjectionContractTests"` ✅
- `python3 -m pytest tests/test_octoclaw_runtime_extension.py tests/test_im_thread.py -q` ⚠️ blocked by six unrelated pre-existing route-policy failures recorded in `deferred-items.md`

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 3’s IM/display cutover is complete: operator surfaces and IM follow-up surfaces now consume one shared substrate-first projection vocabulary.
- The project is ready for Phase 3 verification and then Phase 4 planning, with the known out-of-scope runtime route-policy regressions still tracked separately.

## Self-Check: PASSED

---
*Phase: 03-native-substrate-and-operator-surfaces*
*Completed: 2026-04-16*
