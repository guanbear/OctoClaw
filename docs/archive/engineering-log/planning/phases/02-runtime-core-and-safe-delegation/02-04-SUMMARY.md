---
phase: 02-runtime-core-and-safe-delegation
plan: 04
subsystem: runtime
tags: [typescript, runtime-core, delegation, admission-control, esm, workflow-ownership]
requires:
  - phase: 02-runtime-core-and-safe-delegation
    provides: Runtime ownership primitives and initial delegation seams from Plan 02-02
provides:
  - Executable runtime-core workflow ownership with explicit task materialization and same-owner transitions
  - Delegation launch packets carrying SAFE-01 metadata and admission outcomes before launch
  - Worker briefs that preserve delivery receipt and ownership obligations through delegated execution
affects: [native-substrate, operator-surfaces, delegation-safety, runtime-verification]
tech-stack:
  added: []
  patterns: [explicit Node ESM file imports for TS modules, runtime-core-owned task packet materialization, admission-gated delegation packets]
key-files:
  created: [packages/octoclaw-runtime-core/src/workflow/index.test.mjs, extensions/octoclaw-delegation/src/materialize/index.test.mjs]
  modified: [packages/octoclaw-runtime-core/src/workflow/index.ts, packages/octoclaw-runtime-core/src/ack/index.ts, packages/octoclaw-runtime-core/src/delivery/outbox.ts, packages/octoclaw-runtime-core/src/tasks/claims.ts, packages/octoclaw-contracts/src/deliveries.ts, packages/octoclaw-contracts/src/events.ts, packages/octoclaw-policy/src/admission/index.ts, packages/octoclaw-policy/src/judge/index.ts, packages/octoclaw-policy/src/model/index.ts, packages/octoclaw-policy/src/roles/index.ts, packages/octoclaw-policy/src/route/index.ts, extensions/octoclaw-delegation/src/materialize/index.ts, extensions/octoclaw-delegation/src/brief/index.ts, extensions/octoclaw-delegation/src/conflicts/index.ts, extensions/octoclaw-delegation/src/profiles/index.ts]
key-decisions:
  - "Runtime workflow start now materializes task ownership metadata inside runtime-core rather than leaving task packets implicit."
  - "Same-owner transitions renew the active claim lease instead of treating the current owner as a conflict."
  - "Delegation materialization evaluates admission before launch and binds idempotency, receipt, and lease metadata into the returned packet."
patterns-established:
  - "ESM safety pattern: use explicit file imports for TypeScript modules that are executed directly under Node ESM."
  - "Delegation safety pattern: launch-ready worker packets must include admission, idempotency, receipt, claim, lease, and scope metadata together."
requirements-completed: [RT-01, SAFE-01, SAFE-02]
duration: 5 min
completed: 2026-04-16
---

# Phase 2 Plan 4: Close runtime-core ownership and delegation metadata gaps Summary

**Runtime-core now loads under Node ESM, materializes task ownership explicitly, and emits admission-gated delegation packets with claim, lease, idempotency, and receipt metadata.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-16T06:52:55Z
- **Completed:** 2026-04-16T06:58:28Z
- **Tasks:** 2
- **Files modified:** 17

## Accomplishments
- Fixed runtime-core workflow execution under Node ESM and moved task packet materialization into workflow start.
- Preserved valid same-owner workflow advancement by renewing the current claim lease instead of self-conflicting.
- Extended delegation materialization to carry SAFE-01 metadata and an admission decision before launch, with worker briefs documenting receipt and ownership obligations.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Fix runtime-core task materialization and single-owner workflow transitions** - `ebeeee3` (test)
2. **Task 1 GREEN: Fix runtime-core task materialization and single-owner workflow transitions** - `8b10797` (feat)
3. **Task 2 RED: Carry SAFE-01 metadata and admission checks through delegation materialization** - `ec5e50f` (test)
4. **Task 2 GREEN: Carry SAFE-01 metadata and admission checks through delegation materialization** - `49e77d7` (feat)

**Plan metadata:** `(pending)`

_Note: This plan used TDD-style RED → GREEN commits per task._

## Files Created/Modified
- `packages/octoclaw-runtime-core/src/workflow/index.ts` - Adds explicit runtime task materialization and same-owner claim renewal for running transitions.
- `packages/octoclaw-runtime-core/src/workflow/index.test.mjs` - Verifies ESM loading, task materialization, and same-owner advancement.
- `packages/octoclaw-runtime-core/src/ack/index.ts` - Aligns runtime-core ACK imports with executable Node ESM paths.
- `packages/octoclaw-runtime-core/src/delivery/outbox.ts` - Aligns delivery imports with executable Node ESM paths.
- `packages/octoclaw-runtime-core/src/tasks/claims.ts` - Provides the renewed-claim path consumed by workflow transitions under ESM-safe imports.
- `packages/octoclaw-contracts/src/deliveries.ts` - Aligns contract imports for direct Node ESM execution.
- `packages/octoclaw-contracts/src/events.ts` - Aligns contract imports for direct Node ESM execution.
- `packages/octoclaw-policy/src/admission/index.ts` - Remains the admission API and is now imported through an executable ESM file path.
- `packages/octoclaw-policy/src/judge/index.ts` - Aligns policy composition imports with Node ESM execution rules.
- `packages/octoclaw-policy/src/model/index.ts` - Aligns model-selection imports with Node ESM execution rules.
- `packages/octoclaw-policy/src/roles/index.ts` - Aligns role imports with Node ESM execution rules.
- `packages/octoclaw-policy/src/route/index.ts` - Aligns route imports with Node ESM execution rules.
- `extensions/octoclaw-delegation/src/materialize/index.ts` - Adds idempotency, receipt, claim, lease, and admission metadata to delegated launch packets.
- `extensions/octoclaw-delegation/src/materialize/index.test.mjs` - Verifies SAFE-01 metadata and admission results on delegated work.
- `extensions/octoclaw-delegation/src/brief/index.ts` - Makes worker constraints and done criteria explicitly preserve ownership and delivery receipt obligations.
- `extensions/octoclaw-delegation/src/conflicts/index.ts` - Aligns scope imports with Node ESM execution rules.
- `extensions/octoclaw-delegation/src/profiles/index.ts` - Aligns role imports with Node ESM execution rules.

## Decisions Made
- Kept task materialization in runtime-core so workflow start owns executable packet identity and ownership state instead of relying on downstream implicit behavior.
- Treated same-owner workflow advancement as a lease-renewal path to satisfy the single-owner execution model without deadlocking valid work.
- Bound admission evaluation directly into delegated materialization so backpressure and workspace conflict checks are part of launch readiness rather than an external convention.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Converted touched TypeScript module imports to explicit ESM file paths**
- **Found during:** Task 1 and Task 2 verification
- **Issue:** Direct Node ESM execution still failed after the primary workflow fix because touched runtime, policy, contract, and delegation modules used directory or extensionless imports that Node could not resolve consistently.
- **Fix:** Updated the task-touched dependency chain to explicit `index.ts` or `.ts` file imports so the workflow and delegation tests could execute under the target Node ESM path.
- **Files modified:** `packages/octoclaw-runtime-core/src/workflow/index.ts`, `packages/octoclaw-runtime-core/src/ack/index.ts`, `packages/octoclaw-runtime-core/src/delivery/outbox.ts`, `packages/octoclaw-runtime-core/src/tasks/claims.ts`, `packages/octoclaw-contracts/src/deliveries.ts`, `packages/octoclaw-contracts/src/events.ts`, `packages/octoclaw-policy/src/admission/index.ts`, `packages/octoclaw-policy/src/judge/index.ts`, `packages/octoclaw-policy/src/model/index.ts`, `packages/octoclaw-policy/src/roles/index.ts`, `packages/octoclaw-policy/src/route/index.ts`, `extensions/octoclaw-delegation/src/brief/index.ts`, `extensions/octoclaw-delegation/src/materialize/index.ts`, `extensions/octoclaw-delegation/src/conflicts/index.ts`, `extensions/octoclaw-delegation/src/profiles/index.ts`
- **Verification:** `node packages/octoclaw-runtime-core/src/workflow/index.test.mjs`; `node --input-type=module -e "import('./packages/octoclaw-runtime-core/src/workflow/index.ts')..."`; `node extensions/octoclaw-delegation/src/materialize/index.test.mjs`
- **Committed in:** `8b10797`, `49e77d7`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The auto-fix was required to make the planned runtime and delegation changes executable under the target Node ESM environment. No architectural scope change was introduced.

## Issues Encountered

- The repository environment did not have `rg` installed, so acceptance verification for content presence used the dedicated search tool instead of the shell command in the plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Runtime-core ownership semantics are now executable and verifiable under the target Node ESM path.
- Delegation launch packets now surface the metadata and admission results that later native substrate and operator work can consume directly.
- Phase 2 still requires Plan 02-03 completion before the full phase live-path goal is satisfied end-to-end.

## Self-Check: PASSED
