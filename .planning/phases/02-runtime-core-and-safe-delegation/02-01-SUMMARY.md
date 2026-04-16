---
phase: 02-runtime-core-and-safe-delegation
plan: 01
subsystem: api
tags: [typescript, contracts, policy, routing, delegation]
requires:
  - phase: 01-rebuild-baseline-alignment
    provides: TS rebuild architecture baseline and migration guardrails
provides:
  - Versioned TypeScript contracts for runtime request, task, delivery, telemetry, and scope metadata
  - Guarded policy core for reply, delegate.single, and observe routes
  - Canonical route -> role -> backend -> workspace_mode -> model_profile decision stack
affects: [runtime-core, delegation-safety, native-substrate, eval-gates]
tech-stack:
  added: [TypeScript package scaffolds under packages/octoclaw-contracts, packages/octoclaw-policy]
  patterns: [versioned contract envelopes, separated truth/projection/artifact/telemetry planes, canonical policy decision stack]
key-files:
  created: [packages/octoclaw-contracts/src/schemas.ts, packages/octoclaw-contracts/src/events.ts, packages/octoclaw-contracts/src/artifacts.ts, packages/octoclaw-contracts/src/deliveries.ts, packages/octoclaw-contracts/src/telemetry.ts, packages/octoclaw-policy/src/route/index.ts, packages/octoclaw-policy/src/roles/index.ts, packages/octoclaw-policy/src/model/index.ts, packages/octoclaw-policy/src/admission/index.ts, packages/octoclaw-policy/src/judge/index.ts]
  modified: []
key-decisions:
  - "Contracts separate truth, projection, artifact, and telemetry payload families instead of reusing one generic envelope."
  - "Phase 2 live routing is hard-limited to reply, delegate.single, and observe with admission-aware guards."
patterns-established:
  - "Contract envelope pattern: every shared runtime payload carries schemaVersion and explicit ownership/scope metadata where relevant."
  - "Policy stack pattern: route resolution feeds role selection, then backend, workspace mode, and model profile in one pure TS layer."
requirements-completed: [CTRT-01, POL-01]
duration: 0 min
completed: 2026-04-16
---

# Phase 2 Plan 1: Define TS contracts and guarded policy core Summary

**Versioned TypeScript runtime contracts and a guarded policy core for reply, delegate.single, and observe now exist as the first formal rebuild packages.**

## Performance

- **Duration:** 0 min
- **Started:** 2026-04-16T05:15:46Z
- **Completed:** 2026-04-16T05:15:46Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Created `packages/octoclaw-contracts` with explicit schema, scope, idempotency, ownership, delivery, and telemetry contracts.
- Separated truth, projection, artifact, and telemetry concerns so later runtime work can bind to typed planes instead of generic payload blobs.
- Created `packages/octoclaw-policy` with fixed Phase 2 routes, preset roles, backend/model selection, and admission guards for queue and workspace conflicts.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create shared TypeScript contracts package** - `2e74d62` (feat)
2. **Task 2: Create guarded TypeScript policy package** - `4fed0bc` (feat)

**Plan metadata:** `(pending)`

## Files Created/Modified
- `packages/octoclaw-contracts/src/schemas.ts` - Base contract envelope, schema version, scope, workspace mode, and idempotency types.
- `packages/octoclaw-contracts/src/events.ts` - Task and flow event contracts with claim and lease ownership metadata.
- `packages/octoclaw-contracts/src/artifacts.ts` - Artifact, task packet, and worker brief contracts.
- `packages/octoclaw-contracts/src/deliveries.ts` - Delivery envelope and receipt contracts with request idempotency linkage.
- `packages/octoclaw-contracts/src/telemetry.ts` - Optimization and policy telemetry contracts with deadline and budget fields.
- `packages/octoclaw-policy/src/route/index.ts` - Live-route limiter and route decision helper for reply, delegate.single, and observe.
- `packages/octoclaw-policy/src/roles/index.ts` - Preset role selection for main reply, observer probe, and delegated worker roles.
- `packages/octoclaw-policy/src/model/index.ts` - Backend and model profile selection kept distinct from route selection.
- `packages/octoclaw-policy/src/admission/index.ts` - Admission control for queue budget, capability guard, and shared-workspace write conflict handling.
- `packages/octoclaw-policy/src/judge/index.ts` - Canonical policy stack composition entrypoint.

## Decisions Made
- Used a dedicated contracts package so later runtime code can consume explicit TS types instead of extending Python or legacy JS live-path payloads.
- Kept policy outputs constrained to the plan's live-path routes and surfaced `workspaceMode` and `modelProfile` as separate outputs to preserve the canonical stack.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Runtime ownership and safe delegation primitives can now build on shared contract and policy package boundaries instead of mining legacy live-path modules again.
- No blockers found for Plan 02-02.

## Self-Check: PASSED
