# Spec Delta: 0.5.0 Planner/Confirm Delegation

## ADDED Requirements

### Requirement: Planner Output Does Not Execute

When `OCTOCLAW_SPAWN_BACKEND=planner`, `octoclaw_dispatch` SHALL produce a compact native spawn intent and SHALL NOT spawn, materialize legacy execution, write running state, or send delegate accepted ACK.

#### Scenario: planner creates spawn intent

- WHEN judge/admission selects delegate
- AND the planner backend is enabled
- THEN `octoclaw_dispatch` SHALL return `status=requires_native_spawn`
- AND SHALL include `spawnIntentId`, `workContractId`, `nextTool=sessions_spawn`, `confirmTool=octoclaw_dispatch_confirm`, and compact `sessionsSpawnArgs`
- AND SHALL NOT create completion binding, scheduler queue, child finalizer work, or delivery outbox work.

### Requirement: Native Spawn Requires Matching Intent

OctoClaw SHALL gate `sessions_spawn` calls with a pending `NativeSpawnIntent` bound to the current session, TTL, and canonical args hash.

#### Scenario: no pending intent

- WHEN the main agent calls `sessions_spawn`
- AND no pending intent exists for the current session
- THEN OctoClaw SHALL block the tool call
- AND SHALL report that `octoclaw_dispatch` is required first.

#### Scenario: args mismatch

- WHEN the main agent calls `sessions_spawn`
- AND the canonical hash of the tool args differs from the pending intent hash
- THEN OctoClaw SHALL block the tool call
- AND SHALL NOT update WorkContract native refs.

#### Scenario: intent expired

- WHEN the pending intent TTL has expired
- THEN OctoClaw SHALL block `sessions_spawn`
- AND SHALL require a fresh `octoclaw_dispatch`.

### Requirement: Confirm Requires Native Run Evidence

`octoclaw_dispatch_confirm` SHALL require native accepted run evidence before recording a successful delegation.

#### Scenario: accepted with runId

- WHEN native `sessions_spawn` returns accepted
- AND `octoclaw_dispatch_confirm` receives a matching `spawnIntentId`, `workContractId`, and non-empty `runId`
- THEN OctoClaw SHALL write WorkContract native refs
- AND SHALL mark the intent accepted
- AND SHALL send at most one delegate accepted ACK.

#### Scenario: accepted without runId

- WHEN confirm input has `sessionsSpawnStatus=accepted`
- AND `runId` is missing or empty
- THEN confirm SHALL fail closed
- AND SHALL NOT write native refs
- AND SHALL NOT send delegate accepted ACK.

#### Scenario: duplicate confirm

- WHEN the same intent is confirmed again with the same `runId`
- THEN confirm SHALL return idempotent success
- AND SHALL NOT send duplicate ACK.

#### Scenario: conflicting confirm

- WHEN an already accepted intent is confirmed with a different `runId`
- THEN confirm SHALL return conflict
- AND SHALL preserve the first accepted native refs.

### Requirement: Delegate ACK Is Truthful

OctoClaw SHALL NOT tell the user that work has been handed to a sub-agent until confirm has accepted native run evidence.

#### Scenario: delegate candidate before spawn

- WHEN judge/admission selects delegate
- AND native `sessions_spawn` has not been accepted and confirmed
- THEN user-visible ACK SHALL NOT say handed off, running, completed, or successful.

#### Scenario: native spawn error

- WHEN native `sessions_spawn` returns error
- THEN OctoClaw SHALL record failed confirm or failed intent state
- AND SHALL NOT send delegate accepted ACK.

### Requirement: Completion Uses Native Announce On Planner Path

Planner path SHALL rely on OpenClaw native subagent announce/delivery for child completion.

#### Scenario: child does not write completion file

- WHEN a planner-spawned child run completes
- AND no `.completion.json` is written
- THEN completion SHALL still return through native announce/delivery
- AND OctoClaw SHALL NOT send a duplicate final message from completion binding or delivery outbox.

### Requirement: WorkContract Stores Metadata Only

WorkContract SHALL store native refs and semantic contract fields, but SHALL NOT become the execution lifecycle truth source.

#### Scenario: status projection

- WHEN WorkContract has `openclawRunId`
- THEN status projection SHALL query OpenClaw native runs/flows/subagent registry
- AND SHALL NOT infer running/succeeded/failed solely from WorkContract fields.

### Requirement: Worker Slices Are Bounded By OpenSpec

Parallel implementation work SHALL be split into bounded OpenSpec task slices with explicit ownership and tests.

#### Scenario: worker claims a slice

- WHEN a GLM-5.1 or cheaper worker starts an implementation slice
- THEN the slice SHALL declare owned files, forbidden files, truth source, expected tests, and acceptance evidence
- AND the worker SHALL NOT modify hot-path files outside the slice.

#### Scenario: leader-owned hot path

- WHEN a change affects spawn authorization, `before_tool_call`, dispatch planner output, confirm semantics, judge admission, or user-visible delegate ACK
- THEN Codex leader or a strong-model review SHALL own or approve the change before merge.

### Requirement: Context Pollution Is Bounded

Planner/confirm packets SHALL keep parent context compact and sanitized.

#### Scenario: planner output

- WHEN `octoclaw_dispatch` returns planner output
- THEN it SHALL NOT include raw child transcript, full judge packet, policy traces, ledger rows, or execution logs
- AND large context SHALL be passed by attachment or workspace reference instead of parent tool-result payload.
