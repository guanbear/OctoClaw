# OctoClaw 4.4 State Convergence Design

Date: 2026-04-29
Branch: `refactor/0.4.0-stable`
Source requirement: `docs/octoclaw-architecture-diagnosis-and-refactor-plan-2026-04-29.md` section 4.4.

## Target Authority Model

```text
OpenClaw Native TaskFlow          lifecycle authority
        ↓ read/sync only
task-state.json                   OctoClaw business-state authority
        ↓ read only
policyState                       per-turn cache, TTL only, not durable truth
```

`task-state.json` is the only durable OctoClaw business-state store. It owns the durable projection for route, dispatch/spawn/result evidence, completion, delivery, and the inline WorkContract. Status, dispatch validation, continuation, and child finalization must be recoverable from this file without reading a separate WorkContract ledger.

## Canonical Task Record

The canonical task-state record is keyed by `workContractId`:

- `id = workContractId` for WorkContract-backed tasks.
- `taskId` / `nativeTaskId` store native TaskFlow task identity.
- `flowId` / `nativeFlowId` store native TaskFlow flow identity.
- `workContract` embeds the complete WorkContract object for lossless continuity.
- Flattened fields (`route`, `intentClass`, `judgeRoute`, `workerPool`, `modelProfile`, `dispatchExecuted`, `spawnExecuted`, `resultMaterialized`, `completion`, `delivery`) are duplicated as the status/read-model surface so `octoclaw_status` needs one file read.
- Legacy snake_case aliases are retained in the same record for existing projections, but they are aliases of the same record, not a separate source.

## Runtime Flow

1. Policy resolution seals a WorkContract and calls `saveWorkContract`.
2. `saveWorkContract` writes only `task-state.json`, creating/updating the canonical record.
3. Dispatch loads the WorkContract from `task-state.json` and validates route/status before materialization.
4. Native TaskFlow materialization updates the same record with native task/flow ids and dispatch/spawn evidence.
5. Child completion finalization writes `completion` and `delivery` into the same record, then materializes the embedded WorkContract as completed.
6. `policyState` can cache the current turn decision, but no cross-turn status or dispatch truth depends on it.

## Non-Goals

- No second WorkContract ledger on the live path.
- No raw child transcript injection into parent context.
- No interpretation that TaskFlow creation implies `spawnExecuted`.
- No status projection that treats policy cache/replay as execution proof.

## Acceptance Criteria

- Saving/loading/updating/listing WorkContracts uses `task-state.json` as durable storage.
- Dispatch validation works when only `task-state.json` exists.
- Dispatch writes WorkContract-backed task-state records using `workContractId` as the primary key.
- Completion finalization preserves the inline WorkContract and writes completion/delivery fields into the same record.
- Status reads task-state records directly and does not require the old WorkContract ledger.
- Tests cover the above paths and `git diff --check`, focused runtime tests, and workspace test/build pass before deploy.
