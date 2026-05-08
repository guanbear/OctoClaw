---
phase: 05-execution-substrate-refactor
plan: 01
subsystem: runtime
tags: [typescript, runtime-core, contracts, lifecycle, taskflow, native-truth]
requires:
  - phase: 02-runtime-core-and-safe-delegation
    provides: Runtime ownership primitives, claim/deadline/outbox semantics, and policy-driven workflow start inputs
  - phase: 03-native-substrate-and-operator-surfaces
    provides: TS-native taskflow adapter seam and native truth/projection separation
  - phase: 04-eval-gates-and-advanced-routing
    provides: Validated routing decisions that feed formal execution intent
provides:
  - Canonical execution identity, provenance, lifecycle, and materialization vocabulary for the execution/workflow plane
  - Runtime-core workflow contracts that consume PolicyDecision output as typed execution authority instead of script-shaped payloads
  - Expanded lifecycle artifact and task packet contracts that preserve truth/projection/artifact/telemetry plane separation
affects: [execution-substrate, runtime-extension, native-substrate, phase-5-cutover]
tech-stack:
  added: []
  patterns: [policy-decision drives execution identity, runtime-core owns lifecycle and checkpoint contracts, adapter truth records derive from identity-backed workflow state]
key-files:
  created: [tests/test_runtime_core_workflow_contracts.py]
  modified: [packages/octoclaw-contracts/src/schemas.ts, packages/octoclaw-contracts/src/artifacts.ts, packages/octoclaw-runtime-core/src/workflow/index.ts, extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts, extensions/octoclaw-runtime/src/plugin.ts, tests/test_openclaw_taskflow_adapter.py]
key-decisions:
  - "Execution/workflow state is now rooted in explicit identity, provenance, lifecycle, and checkpoint contracts instead of top-level script-era request/task/flow fields."
  - "PolicyDecision remains the upstream execution authority, and runtime-core derives route authority and materialization intent from that typed policy output rather than preserving Python CLI payload shapes."
  - "Native adapter truth payloads now read identity-backed runtime workflow state so truth/projection/artifact/telemetry stay separate while sharing one execution vocabulary."
patterns-established:
  - "Execution contract pattern: schemas.ts defines cross-plane execution identity/provenance/lifecycle primitives, while runtime-core specializes them into orchestrator state."
  - "Adapter alignment pattern: runtime-taskflow derives truth records from workflow.identity and workflow.lifecycle rather than inventing a second substrate authority."
requirements-completed: [RT-02]
duration: 19 min
completed: 2026-04-16
---

# Phase 5 Plan 1: Define the canonical execution orchestrator and lifecycle contracts for the refactor Summary

**Execution/workflow contracts now model policy-driven authority, lifecycle provenance, and plane-separated native task packets instead of script-shaped runtime state.**

## Performance

- **Duration:** 19 min
- **Started:** 2026-04-16T22:04:59Z
- **Completed:** 2026-04-16T22:23:40Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Replaced the old script-shaped runtime workflow contract with typed execution identity, provenance, lifecycle, checkpoint, and materialization models in runtime-core.
- Expanded shared artifact contracts so task packets and lifecycle artifacts carry formal execution semantics without collapsing truth, projection, artifact, and telemetry planes.
- Aligned the TS-native taskflow adapter and plugin with identity-backed workflow state and added focused tests proving policy-driven lifecycle authority and native truth delegation.

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace script-shaped workflow state with formal execution orchestrator contracts** - `4f96a4d` (feat)
2. **Task 2: Expand contracts for native lifecycle truth and execution packets** - `5c452f4` (feat)

**Plan metadata:** `(pending)`

## Files Created/Modified
- `packages/octoclaw-contracts/src/schemas.ts` - Defines execution route, authority, backend, provenance, lifecycle, and delivery vocabulary shared across the execution/workflow plane.
- `packages/octoclaw-contracts/src/artifacts.ts` - Expands task packets with acceptance and delivery contracts and adds a formal lifecycle artifact type.
- `packages/octoclaw-runtime-core/src/workflow/index.ts` - Rebuilds runtime workflow state around identity, execution provenance, lifecycle checkpoints, and policy-driven materialization intent.
- `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts` - Reads identity/lifecycle-backed workflow state when shaping native truth, projection, artifact, and telemetry payloads.
- `extensions/octoclaw-runtime/src/plugin.ts` - Binds workflows through the identity-backed adapter session contract instead of assuming top-level request/task fields.
- `tests/test_runtime_core_workflow_contracts.py` - Verifies runtime-core execution authority, provenance, lifecycle, and checkpoint behavior from typed policy input.
- `tests/test_openclaw_taskflow_adapter.py` - Verifies native truth payloads preserve packet references and plane separation with the expanded contracts.

## Decisions Made
- Moved execution/workflow truth into an explicit `identity` + `execution` + `lifecycle` model so later Phase 5 cutover work can replace Python/sh authorities against a canonical TS contract instead of preserving legacy state shapes.
- Derived authority and materialization intent directly from `PolicyDecision` route/backend output, which keeps the trust boundary between policy and execution explicit and mitigates script-surface drift.
- Kept adapter truth shaping dependent on runtime-core state rather than adding adapter-owned lifecycle fields, preventing a second truth family on the native seam.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Split runtime-core contract coverage into its own focused test file**
- **Found during:** Task 1 (Replace script-shaped workflow state with formal execution orchestrator contracts)
- **Issue:** The new workflow contract assertions had been added inside the adapter test file, which obscured whether runtime-core behavior was being verified independently of adapter concerns.
- **Fix:** Created `tests/test_runtime_core_workflow_contracts.py` and moved the runtime-core workflow contract assertions there.
- **Files modified:** `tests/test_runtime_core_workflow_contracts.py`, `tests/test_openclaw_taskflow_adapter.py`
- **Verification:** `python3 -m pytest tests/test_runtime_core_workflow_contracts.py -q`
- **Committed in:** `4f96a4d` (part of task commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The deviation clarified verification boundaries without changing scope; execution remained contract-first and aligned to the plan.

## Issues Encountered
- The broader `test_octoclaw_runtime_extension.py` suite exceeded tool time limits when run whole, so verification used focused runtime-truth delegation cases plus the plan-specified adapter/runtime-core proofs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 5 can now replace live Python/sh execution authorities against a canonical TS execution vocabulary instead of extending script-era state contracts.
- Runtime-core, shared contracts, and the native taskflow seam now agree on execution identity, lifecycle, packet, and provenance terminology.
- Remaining work is the live-path cutover itself: replacing runtime extension dispatch/spawn/runner/task-state authorities with TS-native orchestration on top of these contracts.

## Self-Check: PASSED
