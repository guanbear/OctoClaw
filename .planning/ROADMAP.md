# Roadmap: OctoClaw TS Rebuild

## Overview

OctoClaw is being re-baselined around a TypeScript-first, harness-first architecture that keeps the live path short, uses OpenClaw native task and flow truth as the execution source of truth, and treats runtime safety primitives such as idempotency, claim and lease ownership, delivery outbox, backpressure, and workspace conflict policy as early-phase requirements instead of later hardening work.

## Phases

- [ ] **Phase 1: Rebuild Baseline Alignment** - Capture the TS rebuild design baseline and freeze the migration guardrails that all follow-up phases must obey.
- [x] **Phase 2: Runtime Core and Safe Delegation** - Build the TS contracts, guarded policy core, runtime ownership model, and delegation safety primitives for `reply`, `delegate.single`, and `observe`. (completed 2026-04-16)
- [ ] **Phase 3: Native Substrate and Operator Surfaces** - Converge execution and read paths on OpenClaw native task and flow truth, then restore status and IM surfaces on substrate-first projections.
- [ ] **Phase 4: Eval Gates and Advanced Routing** - Turn preflight, golden, replay, and acceptance gates into the promotion path, then add advanced routing capabilities only after the core runtime is stable.

## Phase Details

### Phase 1: Rebuild Baseline Alignment
**Goal**: Align project planning to the 2026-04-15 TS rebuild design so future implementation work follows one explicit architecture instead of the older runtime-improvement roadmap.
**Depends on**: Nothing (first phase)
**Requirements**: [BASE-01, BASE-02]
**Success Criteria** (what must be TRUE):
  1. Planning artifacts identify the TS rebuild design and implementation plan as the active baseline for future work.
  2. Migration guardrails explicitly forbid continuing to evolve Python and oversized JS live-path modules as the formal product architecture.
  3. Follow-up phases can plan against the rebuild workstreams without re-arguing the architecture direction.
**Plans**: 1 plan

Plans:
- [ ] 01-01: Rebase roadmap and requirements onto the TS rebuild design

### Phase 2: Runtime Core and Safe Delegation
**Goal**: Deliver the first executable TS rebuild slice by defining shared contracts, guarded policy decisions, runtime ownership and delivery primitives, and safe delegation boundaries for the minimal live path.
**Depends on**: Phase 1
**Requirements**: [CTRT-01, POL-01, RT-01, SAFE-01, SAFE-02]
**Success Criteria** (what must be TRUE):
  1. The formal live path supports only `reply`, `delegate.single`, and `observe`, with compound routing reserved for a later phase.
  2. Runtime contracts include idempotency, claim and lease ownership, delivery receipts, telemetry, and workspace scope metadata.
  3. The runtime core owns ACK, task materialization, deadlines, outbox delivery, and single-owner execution semantics.
  4. Delegated tasks carry read scope, write scope, and workspace mode so overlapping shared-workspace writes do not execute concurrently by default.
**Plans**: 4 plans

Plans:
- [x] 02-01: Define TS contracts and guarded policy core
- [x] 02-02: Build runtime ownership and safe delegation primitives
- [x] 02-03: Wire the shipped runtime path to the TS policy judge and gate compound routing
- [x] 02-04: Close runtime-core ownership and delegation metadata gaps

### Phase 3: Native Substrate and Operator Surfaces
**Goal**: Replace the formal Python runtime path with TypeScript runtime adapters that bind to OpenClaw native task and flow truth, then rebuild operator and IM surfaces on top of substrate-first projections.
**Depends on**: Phase 2
**Requirements**: [NATIVE-01, SURF-01]
**Success Criteria** (what must be TRUE):
  1. OpenClaw native task and flow state is the formal truth plane for execution status.
  2. Status, details, queue, and timeline surfaces read substrate-first projections instead of inferring truth from legacy JSON chains.
  3. IM adapters share the same projection contracts rather than owning their own truth model.
**Plans**: 3 plans

Plans:
- [x] 03-01: Cut over the formal runtime truth path to the TS-native OpenClaw adapter
- [x] 03-02: Build shared substrate projections and rebind operator surfaces
- [x] 03-03: Rebind IM and display surfaces to the shared projection contracts

### Phase 4: Eval Gates and Advanced Routing
**Goal**: Put preflight, golden, replay, and black-box acceptance gates on the critical path, then add richer routing and optimization capabilities only after the rebuild core is measurable and safe.
**Depends on**: Phase 3
**Requirements**: [EVAL-01, AUTO-01]
**Success Criteria** (what must be TRUE):
  1. CI-grade gates can catch duplicate request or delivery bugs, stale ownership recovery failures, and write-scope conflict regressions.
  2. Optimization telemetry is available at request, task, and flow levels without becoming a live truth source.
  3. Auto-router and compound routing extensions consume stable runtime and evaluation contracts instead of bypassing them.
**Plans**: TBD

Plans:
- [ ] 04-01: Activate eval gates and shadow advanced routing hooks

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Rebuild Baseline Alignment | 0/1 | Not started | - |
| 2. Runtime Core and Safe Delegation | 4/4 | Complete   | 2026-04-16 |
| 3. Native Substrate and Operator Surfaces | 0/3 | Not started | - |
| 4. Eval Gates and Advanced Routing | 0/TBD | Not started | - |
