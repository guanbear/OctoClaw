# Requirements: OctoClaw TS Rebuild

**Defined:** 2026-04-16
**Core Value:** Keep the OctoClaw live path fast, stable, and cost-aware by rebuilding around a TypeScript-first execution policy and delegation harness with OpenClaw native task and flow truth.

## v1 Requirements

### Rebuild Baseline

- [ ] **BASE-01**: Planning and execution artifacts treat the 2026-04-15 TS rebuild design as the active product architecture baseline.
- [ ] **BASE-02**: The rebuild explicitly forbids extending Python or oversized legacy JS live-path modules as the formal long-term architecture.

### Contracts and Policy

- [x] **CTRT-01**: Shared contracts define request, task, flow, telemetry, delivery, idempotency, claim and lease, scope, and task packet structures with schema versioning.
- [x] **POL-01**: The live path uses judge-first policy decisions for only `reply`, `delegate.single`, and `observe`, with capability-aware route guards and no keyword-based semantic routing.

### Runtime Ownership

- [x] **RT-01**: The runtime core owns ACK, task materialization, deadline checks, outbox delivery, and single-owner execution semantics.
- [ ] **RT-02**: Execution truth, projections, artifacts, and telemetry are treated as separate planes so optimization and display data cannot overwrite live truth.

### Delegation Safety

- [x] **SAFE-01**: Delegated work carries idempotency keys, delivery receipts, claim and lease metadata, and backpressure-aware admission control.
- [x] **SAFE-02**: Delegated work carries read scope, write scope, and workspace mode, and overlapping shared-workspace writes are serialized by default.

### Native Runtime and Surfaces

- [x] **NATIVE-01**: OpenClaw native task and flow APIs become the formal execution truth path instead of the Python taskflow adapter.
- [x] **SURF-01**: Status, details, queue, and timeline surfaces render substrate-first projections that expose ownership and workspace state.

### Eval and Routing Deepening

- [ ] **EVAL-01**: Preflight, golden, replay, and black-box acceptance gates detect duplicate request or delivery bugs, stale recovery failures, and write-scope conflict regressions.
- [ ] **AUTO-01**: Advanced routing and optimization features consume stable runtime and evaluation contracts in shadow or gated mode before taking live authority.

## v2 Requirements

### Future Deepening

- **AUTO-02**: Compound routing and heavier multi-agent execution build on the same task packet, telemetry, and native truth contracts instead of adding a second orchestration model.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Continuing to evolve `lib/feedback_loop.py`, `lib/dispatch_task.py`, or other Python live-path modules as the formal rebuild target | The rebuild design explicitly moves formal product code to TypeScript |
| Treating telemetry, projections, or IM payloads as execution truth | The latest design explicitly separates truth, projection, artifact, and telemetry planes |
| Reintroducing keyword tables as the primary semantic route mechanism | The rebuild baseline is judge-first with hard-boundary rules only |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| BASE-01 | Phase 1 | Pending |
| BASE-02 | Phase 1 | Pending |
| CTRT-01 | Phase 2 | Complete |
| POL-01 | Phase 2 | Complete |
| RT-01 | Phase 2 | Complete |
| RT-02 | Phase 2 | Pending |
| SAFE-01 | Phase 2 | Complete |
| SAFE-02 | Phase 2 | Complete |
| NATIVE-01 | Phase 3 | Complete |
| SURF-01 | Phase 3 | Complete |
| EVAL-01 | Phase 4 | Pending |
| AUTO-01 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 12 total
- Mapped to phases: 12
- Unmapped: 0

---
*Requirements defined: 2026-04-16*
*Last updated: 2026-04-16 after TS rebuild re-planning against the latest remote docs*
