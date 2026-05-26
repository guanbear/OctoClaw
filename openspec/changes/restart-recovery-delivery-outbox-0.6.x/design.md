# Design: Restart Recovery Delivery Outbox

## Invariants

- Native TaskFlow remains execution lifecycle truth.
- WorkContract remains semantic, delegation, handoff, and continuity truth.
- Delivery state is a projection over persisted result evidence and channel
  receipt evidence.
- A completed child result must be durable before Slack/IM delivery starts.
- Restart recovery must never treat a failed, timed out, interrupted, or orphaned
  run as a successful final result.

## Root Cause

`checkActiveTaskRecovery()` currently returns an empty result and does not inspect
active native runs. The watchdog handles old queued/running task-state entries,
but it does not reconcile OpenClaw `task_runs` rows that are already terminal or
delivery-pending. Native announce state can represent `delivery_status=pending`,
but there is no durable outbox and startup reconciler that replays pending final
delivery after Gateway restart.

## Architecture

### Delivery Outbox

Add a small runtime-owned delivery outbox for native child completions.

Each outbox item stores only structured, user-safe delivery material:

- `outboxId`
- `taskId`
- `runId`
- `childSessionKey`
- `requesterSessionKey`
- `requesterOrigin`
- `workContractId`
- `delegateTaskId`
- `attemptId`
- `resultText`
- `resultHash`
- `status`: `pending | delivered | failed | interrupted`
- `reason`
- `createdAt`
- `updatedAt`
- `deliveredAt`
- `attemptCount`

The outbox must not store raw hidden transcript, chain-of-thought, internal route
rationale, auth tokens, or provider request bodies.

### Startup Reconciler

On Gateway/plugin startup, run a bounded reconciler over recent native task rows
and delivery outbox rows.

OpenClaw exposes a `gateway_start` plugin hook after gateway sidecars are ready.
OctoClaw should register this hook and use it as the authoritative startup
boundary for restart recovery. Plugin-load side effects may remain as a
best-effort fallback, but the designed integration point is `gateway_start`.

The startup bridge reads `~/.openclaw/tasks/runs.sqlite` table `task_runs` as
structured native lifecycle evidence. It must not scrape transcripts. It may use:

- `task_id`
- `run_id`
- `status`
- `delivery_status`
- `child_session_key`
- `requester_session_key`
- `terminal_summary`
- `terminal_outcome`
- `error`

The reconciler handles three cases:

1. **Completed result pending delivery**
   - Inputs: task/run is `succeeded`, result text exists in outbox or frozen task
     result, and delivery status is `pending`.
   - Action: deliver exactly once to requester, then mark delivered.

2. **Restart-interrupted child**
   - Inputs: task/run is `failed` or `lost`, error includes Gateway restart,
     service restart, abnormal close, missing backing session, or orphan prune.
   - Action: mark interrupted and notify requester that the subtask was stopped
     by Gateway restart and should be retried if still needed.

3. **No durable result**
   - Inputs: run has no result text and no valid completion evidence.
   - Action: do not synthesize a result; surface interrupted/unknown state only.

### Restart Status Notification

When Gateway drain/restart is observed with active delegated runs, emit a compact
status notification to affected requester sessions:

`Gateway 正在重启，正在保护 N 个子任务；完成结果会在恢复后补投递。`

After startup reconciliation:

- delivered result: normal final result delivery;
- interrupted run: `Gateway 重启打断了子任务，结果未生成；可以重试。`;
- pending but not yet deliverable: `Gateway 已恢复，正在继续检查子任务结果。`

Notifications are deduped by `workContractId + transitionKind`.

## Data Flow

1. Native subagent completes.
2. Runtime extracts a safe result packet and persists it to outbox.
3. Runtime attempts direct final delivery.
4. Delivery success marks outbox and task projection delivered.
5. If Gateway restarts before or during delivery, startup reconciler reloads the
   outbox/task rows and resumes from durable state.
6. Requester sees either the final result or an explicit restart-interrupted
   status.

### OpenClaw Native Delivery Boundary

OpenClaw has its own outbound delivery queue recovery. OctoClaw must not replace
that queue or blindly replay entries that OpenClaw already owns. This change only
bridges native `task_runs` rows that represent completed child work but were not
converted into an OctoClaw/native-announce final delivery:

- `status=succeeded`
- `delivery_status=pending`
- a user-safe terminal result exists in `terminal_summary` or existing outbox
  state
- `requester_session_key` points at the original requester session

The bridge first writes an OctoClaw delivery outbox item, then sends through the
existing IM delivery port, then marks both the outbox and task-run delivery state
delivered when the send succeeds.

## Failure Handling

- Delivery send failure increments `attemptCount` and leaves status `pending`
  unless the failure is permanent target resolution failure.
- Missing requester target marks `failed` with reason `missing_requester_target`.
- Restart-interrupted rows are not retried as execution; they are surfaced as
  interrupted state.
- Duplicate reconciler runs are safe because `resultHash` and notification keys
  dedupe delivery.

## Observability

Add sanitized replay events:

- `restart_recovery_scan`
- `restart_recovery_result_delivered`
- `restart_recovery_interrupted`
- `restart_recovery_gateway_start`
- `delivery_outbox_persisted`
- `delivery_outbox_delivery_failed`

Events include IDs, statuses, reason codes, and delivery outcome. They do not
include secrets or raw transcripts.
