---
phase: 05-execution-substrate-refactor
plan: 02
subsystem: runtime
tags: [typescript, runtime-core, openclaw-native, spawn, runner, lifecycle]
requires:
  - phase: 05-01
    provides: execution orchestrator workflow contracts and runtime truth packet vocabulary
  - phase: 03-04
    provides: native helper bridge, plugin binding injection, and substrate truth contracts
  - phase: 04-03
    provides: validated route decisions and fail-closed delegated routing rules
provides:
  - TS-native dispatch orchestration in the runtime extension without dispatch_task.py authority
  - TS-native spawn_single and spawn_multi materialization through plugin and adapter seams
  - TS-owned watchdog timeout and runner heartbeat lifecycle transitions without task-state-update.py authority
affects: [execution-substrate-refactor, runtime extension, native taskflow adapter, lifecycle truth]
tech-stack:
  added: []
  patterns: [runtime-core workflow as live execution authority, plugin and adapter native materialization, TS-owned watchdog lifecycle transitions]
key-files:
  created: [.planning/phases/05-execution-substrate-refactor/05-02-SUMMARY.md]
  modified: [extensions/octoclaw-runtime/index.js, extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts, packages/octoclaw-runtime-core/src/workflow/index.ts, tests/test_octoclaw_runtime_extension.py, tests/test_openclaw_taskflow_adapter.py, tests/test_runtime_core_workflow_contracts.py]
key-decisions:
  - "Dispatch now starts runtime-core workflow state before any direct, runner, or spawn materialization and returns TS-owned fail-closed payloads instead of Python wrapper errors."
  - "Spawn materialization uses the plugin and adapter seam directly for both task and managed-flow creation, with helper-derived ids and substrate revision preserved in runtime truth."
  - "Watchdog lifecycle handling now emits timeout and runner heartbeat transitions from runtime-core contracts rather than shelling out to task-state-update.py."
patterns-established:
  - "Execution pattern: validated route decision -> runtime-core workflow state -> plugin/adapter native materialization"
  - "Lifecycle pattern: timeout and heartbeat transitions are modeled in runtime-core first, then exposed as logs/read models rather than Python file writes"
requirements-completed: [RT-02]
duration: 55min
completed: 2026-04-16
---

# Phase 5 Plan 2: Execution Substrate Refactor Summary

**TS-native dispatch, spawn, and watchdog lifecycle authority now flow through runtime-core workflow contracts and native plugin bindings instead of Python live-path helpers.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-04-16T22:00:00Z
- **Completed:** 2026-04-16T22:55:03Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- Replaced `dispatch_task.py` authority in `octoclaw_dispatch` with runtime-core workflow orchestration that starts, advances, checkpoints, completes, and fails dispatch in TypeScript.
- Replaced `octoclaw_spawn.py` and `/octospawn` live materialization with TS-native spawn helpers built on the existing plugin and adapter seam for both `spawn_single` and `spawn_multi`.
- Replaced watchdog lifecycle authority writes to `task-state-update.py` with runtime-core timeout and heartbeat transitions so runner and spawn lifecycle truth stay in the TS execution plane.

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace `dispatch_task.py` authority with a TS runtime dispatch orchestrator** - `17ae6f8` (feat)
2. **Task 2: Replace `octoclaw_spawn.py` wrapper generation with TS-native spawn materialization** - `43d7a35` (feat)
3. **Task 3: Move lifecycle writes and runner ownership into TS runtime-core seams** - `3c17ca2` (feat)

**Plan metadata:** pending final docs commit

## Files Created/Modified
- `extensions/octoclaw-runtime/index.js` - Replaced dispatch, spawn, and watchdog live-path authority with runtime-core and plugin-backed TS execution helpers.
- `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts` - Fixed adapter identity usage so managed flow and task creation honor workflow identity instead of missing top-level fields.
- `packages/octoclaw-runtime-core/src/workflow/index.ts` - Added heartbeat renewal and timeout lifecycle helpers for TS-owned runner and watchdog transitions.
- `tests/test_octoclaw_runtime_extension.py` - Added dispatch, spawn, and watchdog authority coverage proving TS-native materialization and fail-closed lifecycle handling.
- `tests/test_openclaw_taskflow_adapter.py` - Added coverage for helper-derived spawn_multi flow identity preservation.
- `tests/test_runtime_core_workflow_contracts.py` - Added lifecycle timeout contract coverage alongside heartbeat renewal assertions.

## Decisions Made
- Dispatch now consumes validated route output exactly once and turns it into runtime-core workflow state before any materialization path executes.
- `spawn_multi` remains inside TS runtime code as a thin managed-flow materializer rather than recreating a Python or shell wrapper boundary.
- Watchdog reconciliation remains observational in logs for now, but its authority source is runtime-core lifecycle state, not Python state mutation scripts.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed adapter identity lookups for native spawn materialization**
- **Found during:** Task 2 (Replace `octoclaw_spawn.py` wrapper generation with TS-native spawn materialization)
- **Issue:** The adapter read `workflow.taskId` and `workflow.flowId` from non-existent top-level fields, causing native helper calls to fail against the formal workflow contract.
- **Fix:** Switched adapter task and flow access to the workflow identity contract via `workflowIdentity(workflow)`.
- **Files modified:** `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts`
- **Verification:** `python3 -m pytest tests/test_openclaw_taskflow_adapter.py tests/test_octoclaw_runtime_extension.py -q -k "spawn or runtime_wrapper or ts_runtime_plugin_binding"`
- **Committed in:** `43d7a35`

**2. [Rule 3 - Blocking] Added a dedicated test wrapper export for TS spawn helper coverage**
- **Found during:** Task 2 (Replace `octoclaw_spawn.py` wrapper generation with TS-native spawn materialization)
- **Issue:** Tests invoked the raw spawn helper with the wrong callable shape, blocking verification of the TS-native spawn path.
- **Fix:** Added a test-facing wrapper that forwards `(task, options)` into the object-based helper signature used internally.
- **Files modified:** `extensions/octoclaw-runtime/index.js`, `tests/test_octoclaw_runtime_extension.py`
- **Verification:** `python3 -m pytest tests/test_openclaw_taskflow_adapter.py tests/test_octoclaw_runtime_extension.py -q -k "spawn or runtime_wrapper or ts_runtime_plugin_binding"`
- **Committed in:** `43d7a35`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes were required to keep the new TS authority path correct and testable. No architectural scope creep was introduced.

## Issues Encountered
- Spawn-path verification initially failed because the adapter still depended on script-era top-level workflow fields instead of the newer runtime-core identity contract.
- Watchdog lifecycle refactor initially used the lightweight runtime truth stub, but runtime-core lifecycle helpers required a full workflow state and were updated to start real runtime workflows first.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- The shipped runtime extension no longer uses Python live-path authority for dispatch, spawn, or watchdog lifecycle writes covered by this plan.
- Runtime-core, plugin, and adapter seams now carry the live execution authority needed for downstream verification and cleanup work.
- Remaining unrelated local working tree changes outside this plan were left untouched.

## Self-Check: PASSED
