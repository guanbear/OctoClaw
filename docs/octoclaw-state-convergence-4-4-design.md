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

## Read Failure Rules

`task-state.json` is durable truth, so read failures must be explicit:

- Missing file: initialize an empty document.
- Invalid JSON / schema mismatch: do not return an empty task list and write over the file. Surface a recovery error, preserve the corrupt file for operator inspection, and require a bounded repair path.
- Temporary IO failure: fail closed for mutation, record a replay/operator warning, and retry later.
- Partial record corruption: quarantine or skip only the corrupt record when this can be proven safe; never erase unrelated records.

The implementation must not treat “cannot parse durable state” as “there are no tasks”. That would turn a projection read problem into permanent truth loss on the next write.

## Dispatch Evidence Rules

A route seal or WorkContract record is not dispatch evidence.

- `dispatchExecuted=true` requires native task/flow materialization evidence or an equivalent durable dispatch receipt.
- `spawnExecuted=true` requires child session/run evidence. TaskFlow creation alone is not enough.
- `no_dispatch_evidence` means the system may have planned or sealed work, but no execution was proven. Status should render this as registered/planned/anomalous, not running.
- `dispatch_materialized_but_no_spawn_evidence` means a native flow/task exists, but no child run is confirmed. It is queued/anomalous until spawn evidence arrives or recovery marks it failed/blocked.
- User questions about these states are status/provenance follow-ups. They must read task-state/replay/status projection and reply directly; they must not create a new delegate task.

If a dispatch cannot proceed because the main session or host is busy, the durable state must say so explicitly (`queued`, `blocked`, `queued_after`, `parent_session_busy`, etc.). Silent skip is forbidden because it creates a false WorkContract without execution truth.

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
- Corrupt task-state read does not silently become an empty durable document.
- Sealed-but-not-dispatched records are visible as registered/planned/anomalous, never as successful delegation.
- A dispatch failure follow-up such as “为啥没派发成功呢” does not create a new task and can be answered from durable status facts.
- Tests cover missing file, invalid JSON, IO failure, and safe recovery/quarantine behavior.
- Tests cover the above paths and `git diff --check`, focused runtime tests, and workspace test/build pass before deploy.
