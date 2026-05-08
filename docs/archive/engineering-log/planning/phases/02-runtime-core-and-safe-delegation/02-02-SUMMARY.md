---
phase: 02-runtime-core-and-safe-delegation
plan: 02
subsystem: runtime
tags: [typescript, runtime-core, delegation, openclaw, outbox, workspace-safety]
requires:
  - phase: 02-runtime-core-and-safe-delegation
    provides: Versioned TS contracts and guarded policy outputs from Plan 02-01
provides:
  - TypeScript runtime-core modules for ACK, claim leases, deadline enforcement, outbox delivery, and workflow ownership
  - A TypeScript-first runtime adapter seam pointing at OpenClaw native bind/create/run taskflow operations
  - Delegation materialization and conflict helpers with explicit scope metadata and shared-workspace serialization defaults
affects: [native-substrate, operator-surfaces, eval-gates, delegation-safety]
tech-stack:
  added: [packages/octoclaw-runtime-core, extensions/octoclaw-runtime/src, extensions/octoclaw-delegation/src]
  patterns: [runtime-core owns claims and delivery state, TS adapter seam wraps native taskflow bind/create/run calls, delegated work carries explicit scope and workspace conflict metadata]
key-files:
  created: [packages/octoclaw-runtime-core/src/ack/index.ts, packages/octoclaw-runtime-core/src/tasks/claims.ts, packages/octoclaw-runtime-core/src/tasks/deadlines.ts, packages/octoclaw-runtime-core/src/delivery/outbox.ts, packages/octoclaw-runtime-core/src/workflow/index.ts, extensions/octoclaw-runtime/src/plugin.ts, extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts, extensions/octoclaw-delegation/src/brief/index.ts, extensions/octoclaw-delegation/src/materialize/index.ts, extensions/octoclaw-delegation/src/profiles/index.ts, extensions/octoclaw-delegation/src/conflicts/index.ts]
  modified: []
key-decisions:
  - "Runtime ownership state is centralized in the new TypeScript runtime-core package instead of extending Python dispatch or task-event helpers."
  - "The formal adapter seam exposes bindSession, createManaged, and runTask in TypeScript so future native integration grows from the OpenClaw taskflow runtime rather than Python glue."
  - "Delegation materialization always carries readScope, writeScope, and workspaceMode, and shared_workspace overlaps serialize by default."
patterns-established:
  - "Runtime core pattern: ACK, deadlines, claims, outbox delivery, and recovery state live together as typed workflow state."
  - "Delegation safety pattern: worker profile + brief + materialization + conflict policy are separate TS modules with explicit scope contracts."
requirements-completed: [RT-01, SAFE-01, SAFE-02]
duration: 4 min
completed: 2026-04-16
---

# Phase 2 Plan 2: Build runtime ownership and safe delegation primitives Summary

**TypeScript runtime ownership primitives now govern claims, deadlines, ACK and outbox delivery, while delegation carries explicit scope metadata and shared-workspace conflict serialization defaults.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-16T05:21:40Z
- **Completed:** 2026-04-16T05:26:00Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- Created `packages/octoclaw-runtime-core` as the first runtime ownership package for ACK, lease claims, deadlines, outbox delivery, and workflow orchestration state.
- Added a TypeScript runtime plugin and native-taskflow adapter seam centered on `bindSession`, `createManaged`, and `runTask` instead of extending the Python adapter as the formal path.
- Added delegation brief, materialization, profile, and conflict modules so delegated work now carries explicit read/write scope and defaults to serializing overlapping writes in `shared_workspace`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create runtime ownership primitives** - `46f0388` (feat)
2. **Task 2: Create runtime adapter and delegation safety seams** - `c0a075b` (feat)

**Plan metadata:** `(pending)`

## Files Created/Modified
- `packages/octoclaw-runtime-core/src/ack/index.ts` - ACK ledger and delivery receipt acknowledgement helpers.
- `packages/octoclaw-runtime-core/src/tasks/claims.ts` - Single-owner claim, claim token, lease expiry, and heartbeat renewal logic.
- `packages/octoclaw-runtime-core/src/tasks/deadlines.ts` - Queue, start, progress, runtime, and delivery deadline modeling.
- `packages/octoclaw-runtime-core/src/delivery/outbox.ts` - Outbox queue entries and delivery receipt attachment flow.
- `packages/octoclaw-runtime-core/src/workflow/index.ts` - Unified ingress orchestration, workflow orchestration, and reconcile/recovery runtime state.
- `extensions/octoclaw-runtime/src/plugin.ts` - TypeScript runtime plugin seam that binds workflow state to the adapter.
- `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts` - Native-facing TS adapter contract exposing `bindSession`, `createManaged`, and `runTask`.
- `extensions/octoclaw-delegation/src/brief/index.ts` - Minimal worker brief generation for delegated roles.
- `extensions/octoclaw-delegation/src/materialize/index.ts` - Delegation materialization with `readScope`, `writeScope`, `workspaceMode`, and write-scope summaries.
- `extensions/octoclaw-delegation/src/profiles/index.ts` - Baseline worker profiles for research, code, and review roles.
- `extensions/octoclaw-delegation/src/conflicts/index.ts` - Shared-workspace serialization and queue-aware conflict policy.

## Decisions Made
- Kept runtime ownership in a dedicated TS package so later native substrate work can compose typed workflow state instead of widening the existing Python live path.
- Made the adapter seam explicitly OpenClaw-native by centering it on taskflow bind/create/run concepts already present in the runtime helper path.
- Split delegation safety into profile, brief, materialization, and conflict modules so scope policy is first-class and not implicit in worker prompts.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 3 can now bind these TypeScript runtime and delegation seams to OpenClaw native task and flow truth without introducing new ownership concepts.
- Operator and evaluation surfaces can consume explicit claim, deadline, receipt, and workspace conflict metadata from the new TS modules.

## Self-Check: PASSED
