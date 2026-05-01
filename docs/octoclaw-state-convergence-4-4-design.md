# OctoClaw 4.4 State Convergence Design

Date: 2026-04-29
Branch: `refactor/0.4.0-stable`
Source requirement: `docs/octoclaw-architecture-diagnosis-and-refactor-plan-2026-04-29.md` section 4.4.

## Target Authority Model

```text
OpenClaw Native TaskFlow / TaskRun DBs   lifecycle authority
        ↓ read/sync only
OctoClaw runtime ledger                 WorkContract / scheduler / attempt / completion binding authority
        ↓ projection
task-state.json                         compatibility read-model snapshot
        ↓ read only
policyState                             per-turn cache, TTL only, not durable truth
```

N1 refines the original 4.4 storage model: `task-state.json` remains the compact status/read-model projection, but it is no longer the only durable OctoClaw business-state store for concurrent scheduling. WorkContract, delegation ticket, queue/lease, attempt, completion binding, delivery outbox, amendment, and recovery verdict need transactional semantics and should live in an OctoClaw-owned runtime ledger, preferably SQLite.

OpenClaw native DBs such as `~/.openclaw/flows/registry.sqlite` (`flow_runs`) and `~/.openclaw/tasks/runs.sqlite` (`task_runs`) remain substrate-owned lifecycle truth. OctoClaw should reference them by `flowId` / `nativeTaskId` / `childSessionKey` and update them only via OpenClaw APIs/bridges. Direct DB reads are allowed only as bounded read-only diagnostics with schema guards while OpenClaw bridge coverage is incomplete. OctoClaw must not privately add columns or store WorkContract fields inside native tables.

## Canonical Task Record

The canonical OctoClaw ledger record is keyed by `workContractId`; the `task-state.json` projection should preserve the same key for compatibility:

- `id = workContractId` for WorkContract-backed tasks.
- `taskId` / `nativeTaskId` store native TaskFlow task identity.
- `flowId` / `nativeFlowId` store native TaskFlow flow identity.
- `workContract` embeds the complete WorkContract object for lossless continuity.
- Flattened fields (`route`, `intentClass`, `judgeRoute`, `workerPool`, `modelProfile`, `dispatchExecuted`, `spawnExecuted`, `resultMaterialized`, `completion`, `delivery`) are duplicated as the status/read-model surface so `octoclaw_status` needs one file read.
- Legacy snake_case aliases are retained in the same record for existing projections, but they are aliases of the same record, not a separate source.

## Runtime Flow

1. Policy resolution seals a WorkContract and writes it to the OctoClaw runtime ledger.
2. The ledger issues a delegation ticket and scheduler row when delegate materialization is authorized.
3. Dispatch validates the ticket/WorkContract from the ledger, then materializes or queues the attempt.
4. Native TaskFlow/TaskRun materialization writes native task/flow/session ids into the ledger and can be cross-checked against OpenClaw DBs.
5. Child completion finalization validates deterministic completion binding, writes result/delivery state into the ledger, then emits replay and delivery outbox events.
6. `task-state.json` is regenerated or incrementally projected from the ledger + native DB snapshot for status compatibility.
7. `policyState` can cache the current turn decision, but no cross-turn status or dispatch truth depends on it.

## Read Failure Rules

`task-state.json` is a durable projection, so read failures must be explicit and must not corrupt ledger truth:

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

- No second *competing* WorkContract truth on the live path; N1 introduces a single OctoClaw-owned runtime ledger as the canonical WorkContract/scheduler store, with `task-state.json` as projection.
- No raw child transcript injection into parent context.
- No interpretation that TaskFlow creation implies `spawnExecuted`.
- No status projection that treats policy cache/replay as execution proof.

## Acceptance Criteria

- Saving/loading/updating/listing WorkContracts uses the OctoClaw runtime ledger as canonical storage and projects to `task-state.json`.
- Dispatch validation works from the ledger and can rebuild a status projection if `task-state.json` is missing.
- Dispatch writes WorkContract-backed ledger records using `workContractId` as the primary key and task-state records as projection.
- Completion finalization preserves the inline WorkContract in the ledger and projects completion/delivery fields into `task-state.json`.
- Status can read task-state records for speed, but repair/rebuild reads the ledger + OpenClaw native DBs.
- Corrupt task-state read does not silently become an empty durable document.
- Sealed-but-not-dispatched records are visible as registered/planned/anomalous, never as successful delegation.
- A dispatch failure follow-up such as “为啥没派发成功呢” does not create a new task and can be answered from durable status facts.
- Tests cover missing file, invalid JSON, IO failure, and safe recovery/quarantine behavior.
- Tests cover the above paths and `git diff --check`, focused runtime tests, and workspace test/build pass before deploy.
