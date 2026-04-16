---
phase: 02-runtime-core-and-safe-delegation
plan: 03
subsystem: runtime
tags: [typescript, runtime-policy, plugin-registration, routing, safe-delegation]
requires:
  - phase: 02-runtime-core-and-safe-delegation
    provides: Runtime ownership primitives, TS policy judge, and TS runtime plugin seam groundwork from Plans 02-01 and 02-02
provides:
  - Shipped runtime entrypoint now consumes the TypeScript policy judge on the formal live path
  - Phase 2 live-path enforcement blocks compound-plan execution and limits live authority to reply, delegate.single, and observe
  - Runtime package metadata exports and registers the TypeScript plugin seam alongside the legacy wrapper entrypoint
affects: [runtime-core, native-substrate, eval-gates, delegation-safety]
tech-stack:
  added: []
  patterns: [TS judge drives shipped runtime route normalization, compound routing is recorded as blocked metadata instead of executed, package metadata exposes TS plugin seam without changing the formal Phase 2 wrapper]
key-files:
  created: [.planning/phases/02-runtime-core-and-safe-delegation/02-03-SUMMARY.md]
  modified: [extensions/octoclaw-runtime/index.js, extensions/octoclaw-runtime/src/plugin.ts, extensions/octoclaw-runtime/package.json]
key-decisions:
  - "Mapped the TS judge's Phase 2 routes onto the existing live runtime lanes: reply -> direct, delegate.single -> spawn_single, observe -> runner."
  - "Recorded compound-plan requests as blocked or deferred metadata instead of executing them so the formal live path stays within Phase 2 authority."
patterns-established:
  - "Runtime policy enforcement pattern: the shipped JS wrapper may normalize legacy route decisions, but the TS judge is the semantic authority for live routing."
  - "Package registration pattern: preserve the formal wrapper entrypoint while exporting the TS seam explicitly for consumer-visible wiring."
requirements-completed: [POL-01]
duration: 1 min
completed: 2026-04-16
---

# Phase 2 Plan 3: Wire the shipped runtime path to the TS policy judge and gate compound routing Summary

**The shipped runtime now uses the TypeScript policy judge to enforce Phase 2 live routing and records compound-plan requests as blocked metadata instead of executing them.**

## Performance

- **Duration:** 1 min
- **Started:** 2026-04-16T07:00:30Z
- **Completed:** 2026-04-16T07:01:49Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Wired the formal runtime entrypoint to consume the TypeScript policy judge and persist its output in runtime metadata.
- Enforced the Phase 2 live-route allow-list for `reply`, `delegate.single`, and `observe` while preventing compound-plan execution on the shipped live path.
- Exported and registered the TypeScript runtime plugin seam in package metadata without replacing `index.js` as the formal Phase 2 wrapper.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire the shipped runtime entrypoint to the TS policy judge** - `7938dae` (feat)
2. **Task 2: Export and register the TS runtime plugin seam** - `a1c4ff7` (feat)

**Plan metadata:** `(pending)`

## Files Created/Modified
- `extensions/octoclaw-runtime/index.js` - Applies the TS judge on the shipped live path, rewrites live routing to the Phase 2 allow-list, and records blocked compound-plan requests.
- `extensions/octoclaw-runtime/src/plugin.ts` - Exposes the runtime plugin's `judgeRoute()` seam so the plugin uses the same TS policy authority as the live wrapper.
- `extensions/octoclaw-runtime/package.json` - Exports and registers the TS runtime plugin seam while preserving `index.js` as the formal runtime entrypoint.

## Decisions Made
- Kept the legacy JS runtime wrapper as the formal Phase 2 entrypoint, but made it consume the TypeScript policy judge so semantic authority moves to the TS stack immediately.
- Reused existing runtime lanes (`direct`, `spawn_single`, `runner`) as transport mappings for the TS live routes instead of introducing a broader architectural cutover before Phase 3.
- Chose to preserve blocked compound-plan intent in metadata for observability and verification rather than silently dropping those requests.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed direct TypeScript module resolution for the shipped TS policy seam**
- **Found during:** Task 1 (Wire the shipped runtime entrypoint to the TS policy judge)
- **Issue:** The runtime plugin could not be loaded directly under Node ESM because its local adapter import lacked the explicit `.ts` extension required by the repo's current direct-TS loading pattern.
- **Fix:** Updated the plugin seam to use explicit `.ts` import targets for the adapter and runtime-core workflow type path so the shipped TS seam can be imported and smoke-tested.
- **Files modified:** `extensions/octoclaw-runtime/src/plugin.ts`
- **Verification:** `node --input-type=module -e "import('./extensions/octoclaw-runtime/src/plugin.ts').then((m)=>{const plugin=m.createOctoClawRuntimePlugin(); const out=plugin.judgeRoute({workspaceMode:'shared_workspace',queueBudget:2,inflightCount:0,capabilitySatisfied:true,writeConflict:false,requiresDelegation:true}); console.log(JSON.stringify({name:plugin.name,route:out.route,backend:out.backend}));})"`
- **Committed in:** `7938dae` (part of task commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The auto-fix was required to make the TS plugin seam executable as part of the shipped runtime path. No scope creep beyond the planned wiring work.

## Issues Encountered

- The environment did not have `rg` available on PATH, so acceptance checks were completed with equivalent repository grep and Node-based verification instead.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02-04 can now close the remaining runtime-core ownership and delegation metadata gaps on top of a shipped runtime path that already honors the Phase 2 route boundary.
- The Phase 2 verifier can now observe TS judge output and blocked compound-plan metadata directly from the formal live path.

## Self-Check: PASSED
