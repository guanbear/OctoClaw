---
phase: 03-native-substrate-and-operator-surfaces
plan: 04
subsystem: runtime
tags: [typescript, openclaw, native-helper, runtime, plugin, wrapper]
requires:
  - phase: 03-native-substrate-and-operator-surfaces
    provides: Plans 03-01 through 03-03 runtime truth seams, substrate projections, and shared display contracts
provides:
  - Native-helper-backed managed flow and task execution truth for the TypeScript runtime adapter
  - Wrapper runtime_truth metadata delegated through helper-backed plugin bindings instead of synthetic revision defaults
  - Regression coverage proving helper-derived ids state sync mode and revision flow through adapter and wrapper surfaces
affects: [runtime-verification, native-substrate, operator-surfaces, im-surfaces]
tech-stack:
  added: []
  patterns: [native helper bridge for TS adapter, fail-closed helper normalization, injectable helper invoker for deterministic wrapper tests]
key-files:
  created: [extensions/octoclaw-runtime/src/adapter/native-helper.ts]
  modified: [extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts, extensions/octoclaw-runtime/src/plugin.ts, extensions/octoclaw-runtime/index.js, tests/test_openclaw_taskflow_adapter.py, tests/test_octoclaw_runtime_extension.py]
key-decisions:
  - "The TS adapter now shells out through one native-helper bridge and rejects malformed helper responses instead of fabricating native truth defaults."
  - "Plugin and wrapper seams accept helper invoker injection so tests can assert native-backed truth delegation without introducing a second truth authority."
patterns-established:
  - "Native helper seam pattern: adapter createManaged/runTask map helper-provided flow/task ids state sync mode and revision into truth/projection/artifact/telemetry families."
  - "Wrapper delegation pattern: runtime_truth metadata keeps authority on ts-native-adapter while preserving helper-backed binding fields end to end."
requirements-completed: [NATIVE-01]
duration: 5 min
completed: 2026-04-16
---

# Phase 3 Plan 4: Close the native-helper truth gap for the TS runtime adapter Summary

**The TypeScript runtime adapter now gets managed-flow and task truth from the OpenClaw native helper, and wrapper runtime metadata preserves those helper-backed ids, state, sync mode, and revisions end to end.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-16T12:32:16Z
- **Completed:** 2026-04-16T12:37:14Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Added a dedicated TypeScript native-helper bridge that invokes `lib/openclaw_taskflow_runtime_helper.mjs`, parses stdout as JSON, and fails closed when required truth fields are missing.
- Replaced the remaining synthetic adapter shaping so `createManaged()`, `runTask()`, and `bindWorkflow()` now emit helper-derived flow/task ids, substrate state, sync mode, and substrate revision.
- Updated wrapper metadata tests so `runtime_truth.binding` and policy-decision metadata prove the `ts-native-adapter` authority path now carries native-backed truth instead of placeholder revision `0` data.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Replace synthetic adapter shaping with native-helper-backed bind/create/run operations** - `f0a12fb` (test)
2. **Task 1 GREEN: Replace synthetic adapter shaping with native-helper-backed bind/create/run operations** - `61eed12` (feat)
3. **Task 2: Rewire wrapper runtime_truth metadata and extension tests to prove native-backed delegation end to end** - `227b863` (feat)

**Plan metadata:** `(pending)`

_Note: Task 1 followed a TDD RED → GREEN sequence._

## Files Created/Modified
- `extensions/octoclaw-runtime/src/adapter/native-helper.ts` - Invokes the native runtime helper CLI, normalizes stdout payloads, and rejects malformed helper responses.
- `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts` - Builds managed-flow and run-task records from helper outputs instead of synthetic workflow-only defaults.
- `extensions/octoclaw-runtime/src/plugin.ts` - Threads helper invoker injection through adapter creation and reuses helper-backed task truth in `bindWorkflow()`.
- `extensions/octoclaw-runtime/index.js` - Allows `buildRuntimeTruthMetadata()` to pass helper invokers into the plugin while preserving wrapper authority metadata.
- `tests/test_openclaw_taskflow_adapter.py` - Asserts helper-derived revisions and states for create, run, and bind adapter paths.
- `tests/test_octoclaw_runtime_extension.py` - Asserts wrapper runtime truth metadata and policy decisions preserve helper-backed binding ids, state, and revision.

## Decisions Made
- Centralized helper process execution in one TS-side bridge so adapter code never parses raw subprocess output directly and can fail closed per the threat model.
- Kept `authority: "ts-native-adapter"` unchanged while moving binding values to helper-backed plugin output, preserving truth ownership separation between wrapper compatibility glue and native truth data.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Verification Results

- `python3 -m pytest tests/test_openclaw_taskflow_adapter.py -q` ✅
- `python3 -m pytest tests/test_octoclaw_runtime_extension.py -q -k "runtime_wrapper_exports_ts_native_truth_delegation_metadata or runtime_wrapper_records_ts_native_truth_on_policy_decision_metadata"` ✅
- `python3 -m pytest tests/test_openclaw_taskflow_adapter.py tests/test_octoclaw_runtime_extension.py -q -k "runtime_wrapper_exports_ts_native_truth_delegation_metadata or runtime_wrapper_records_ts_native_truth_on_policy_decision_metadata or ts_runtime_plugin_binding"` ✅

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 3’s remaining verification gap is closed: the formal TS-native truth seam now consumes helper-backed native flow/task state instead of placeholder revision defaults.
- The repo is ready for refreshed phase verification and then Phase 4 planning with runtime truth, operator surfaces, and IM surfaces aligned on one native-backed authority path.

## Self-Check: PASSED

- FOUND: `.planning/phases/03-native-substrate-and-operator-surfaces/03-04-SUMMARY.md`
- FOUND: `f0a12fb`
- FOUND: `61eed12`
- FOUND: `227b863`

---
*Phase: 03-native-substrate-and-operator-surfaces*
*Completed: 2026-04-16*
