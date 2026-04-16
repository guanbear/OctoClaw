---
phase: 03-native-substrate-and-operator-surfaces
plan: 01
subsystem: runtime
tags: [typescript, openclaw, runtime, native-truth, plugin, contracts]
requires:
  - phase: 02-runtime-core-and-safe-delegation
    provides: Runtime-core workflow state, TS plugin seam groundwork, and Phase 2 route guard semantics
provides:
  - Formal TS-native truth records for runtime bind/create/run operations
  - Wrapper metadata delegation through the TS runtime plugin instead of a competing JS-owned truth record
  - Shared truth/projection/artifact/telemetry contract helpers for downstream substrate surfaces
affects: [operator-surfaces, im-surfaces, native-substrate, runtime-verification]
tech-stack:
  added: []
  patterns: [TS-native truth delegation, explicit truth/projection/artifact/telemetry plane records, wrapper metadata anchored to plugin authority]
key-files:
  created: []
  modified: [extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts, extensions/octoclaw-runtime/src/plugin.ts, extensions/octoclaw-runtime/index.js, packages/octoclaw-contracts/src/artifacts.ts, packages/octoclaw-contracts/src/telemetry.ts, tests/test_openclaw_taskflow_adapter.py, tests/test_octoclaw_runtime_extension.py]
key-decisions:
  - "The TS adapter now emits structured truth, projection, artifact, and telemetry payloads instead of placeholder bind/create/run returns."
  - "The shipped runtime wrapper records TS plugin-derived runtime_truth metadata as the formal native truth authority instead of reconstructing a second truth model."
patterns-established:
  - "Native truth seam pattern: wrapper and downstream surfaces consume plugin-produced runtime truth metadata keyed by explicit flow/task/runtime/sync/substrate fields."
  - "Plane separation pattern: truth, projection, artifact, and telemetry remain distinct payload families even when returned together from one adapter operation."
requirements-completed: [NATIVE-01]
duration: 8 min
completed: 2026-04-16
---

# Phase 3 Plan 1: Cut over the formal runtime truth path to the TS-native OpenClaw adapter Summary

**The runtime now exposes TS-native OpenClaw truth records for bind/create/run operations and the shipped wrapper delegates formal native truth metadata to the TypeScript plugin seam.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-16T10:59:09Z
- **Completed:** 2026-04-16T11:07:14Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Replaced placeholder TS adapter outputs with explicit native truth, projection, artifact, and telemetry records carrying flow/task/runtime/sync/substrate/ownership/scope metadata.
- Exposed those records through the runtime plugin so workflow binding and adapter creation now share one formal TypeScript-native truth seam.
- Updated the shipped runtime wrapper to attach `runtime_truth` metadata derived from the TS plugin rather than synthesizing a separate wrapper-owned authority path.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Promote the TypeScript runtime adapter into the formal native truth seam** - `84fd58d` (test)
2. **Task 1 GREEN: Promote the TypeScript runtime adapter into the formal native truth seam** - `fc83dca` (feat)
3. **Task 2: Rewire the shipped runtime entrypoint to delegate formal truth-path authority to the TS-native adapter** - `d19516d` (feat)

**Plan metadata:** `(pending)`

_Note: Task 1 used a TDD RED → GREEN sequence._

## Files Created/Modified
- `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts` - Expands the adapter from placeholders into structured native truth/projection/artifact/telemetry payload generation for bind/create/run operations.
- `extensions/octoclaw-runtime/src/plugin.ts` - Re-exports truth-plane helpers and binds workflow metadata through the formal TS-native adapter seam.
- `extensions/octoclaw-runtime/index.js` - Builds `runtime_truth` metadata from the TS plugin and stores wrapper-facing truth authority on that seam.
- `packages/octoclaw-contracts/src/artifacts.ts` - Adds explicit truth/projection/artifact/telemetry payload helpers and native truth artifact kind enumeration.
- `packages/octoclaw-contracts/src/telemetry.ts` - Aligns telemetry imports with direct TS execution paths used by the seam.
- `tests/test_openclaw_taskflow_adapter.py` - Adds RED/GREEN assertions that the TS seam exposes native truth metadata and preserves plane separation.
- `tests/test_octoclaw_runtime_extension.py` - Adds runtime-facing assertions that wrapper metadata exposes TS-native truth delegation.
- `.planning/phases/03-native-substrate-and-operator-surfaces/deferred-items.md` - Records unrelated pre-existing route-policy test failures discovered while executing Task 2.

## Decisions Made
- Reused the existing `bindSession`, `createManaged`, and `runTask` TS seam instead of introducing a parallel adapter abstraction, so the native truth cutover remains incremental but authoritative.
- Modeled wrapper-facing truth as `runtime_truth` metadata with `authority`, `pluginName`, and plugin-produced binding payloads so compatibility glue can remain while semantic authority moves to TypeScript.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed direct TypeScript contract imports needed by the native truth seam**
- **Found during:** Task 1 (Promote the TypeScript runtime adapter into the formal native truth seam)
- **Issue:** `packages/octoclaw-contracts/src/artifacts.ts` and `packages/octoclaw-contracts/src/telemetry.ts` still used extensionless relative imports, which broke the direct Node/TS execution path used by the new seam tests.
- **Fix:** Updated those imports to explicit `.ts` paths while adding the new truth/projection/artifact/telemetry payload helpers.
- **Files modified:** `packages/octoclaw-contracts/src/artifacts.ts`, `packages/octoclaw-contracts/src/telemetry.ts`
- **Verification:** `python3 -m pytest tests/test_openclaw_taskflow_adapter.py -q`
- **Committed in:** `fc83dca`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The auto-fix was required to make the planned TS-native truth seam executable under the repo's direct TS loading path. No architectural scope change beyond the plan.

## Issues Encountered

- `tests/test_octoclaw_runtime_extension.py` contains six unrelated pre-existing route-policy expectation failures (`direct` vs `runner` / `spawn_single`) outside the new native-truth delegation scope. The new targeted delegation tests pass, and the failures were recorded in `deferred-items.md` instead of being auto-fixed out of scope.

## Known Stubs

- `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts:122` - `substrateRevision` is currently seeded as `0` from the TS seam because this plan formalizes the truth contract shape and wrapper delegation, while later Phase 3 work will connect live native revision refresh to downstream substrate projections.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: truth-authority-metadata | `extensions/octoclaw-runtime/index.js` | The wrapper now emits `runtime_truth` metadata consumed by downstream surfaces; later plans must ensure only plugin-produced truth data can populate this field. |

## Verification Results

- `python3 -m pytest tests/test_openclaw_taskflow_adapter.py -q` ✅
- `python3 -m pytest tests/test_octoclaw_runtime_extension.py -q -k "runtime_wrapper_exports_ts_native_truth_delegation_metadata or runtime_wrapper_records_ts_native_truth_on_policy_decision_metadata"` ✅
- `python3 -m pytest tests/test_openclaw_taskflow_adapter.py tests/test_octoclaw_runtime_extension.py -q` ⚠️ blocked by six unrelated pre-existing route-policy failures recorded in `deferred-items.md`
- `node --input-type=module -e "import('./extensions/octoclaw-runtime/src/plugin.ts').then((m)=>{const p=m.createOctoClawRuntimePlugin(); console.log(JSON.stringify({name:p.name,hasAdapter:Boolean(p.createAdapter),hasBind:Boolean(p.bindWorkflow)}));})"` ✅

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The formal native truth path now exists in TypeScript and is exposed to the shipped runtime surface, so Plan 03-02 can consume stable truth/projection plane data for status, queue, details, and timeline projections.
- Deferred route-policy expectation failures should be handled separately if they block upcoming runtime-policy work, but they do not block substrate projection cutover.

## Self-Check: PASSED

---
*Phase: 03-native-substrate-and-operator-surfaces*
*Completed: 2026-04-16*
