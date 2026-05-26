# Change: Restart Recovery Delivery Outbox

Date: 2026-05-26
Target release: v0.6.x

## Why

Live Slack use exposed a restart boundary gap. When Gateway restarts while delegated
subagents are active, OctoClaw can lose the user-visible result or leave the task
looking unfinished even when the child run already completed.

The observed failure on 2026-05-26 had two variants:

1. A child run was interrupted by Gateway restart and later pruned as an orphan
   because its backing session was missing.
2. A later child run completed successfully, but final user delivery remained
   `pending`, so the requester saw no clear completion.

Both cases are lifecycle/delivery reconciliation failures, not routing failures.

## Goals

- Persist child completion results before attempting user delivery.
- Reconcile restart-interrupted and delivery-pending task runs after Gateway is
  ready.
- Emit user-visible restart/recovery status when active delegated work is affected.
- Keep native TaskFlow as execution lifecycle truth and WorkContract as semantic
  continuity truth.
- Add focused tests for the exact restart and pending-delivery cases.

## Non-Goals

- Do not introduce a second task engine.
- Do not infer success from model text, hidden transcript, or stale projection
  state.
- Do not inject raw child transcript into parent context.
- Do not broadly rewrite the native subagent registry or OpenClaw Gateway.
- Do not retry arbitrary failed tasks whose failure was not restart-related.

## Acceptance Gate

- A completed subagent with persisted result and `delivery_status=pending` is
  rediscovered after startup and delivered once to the requester.
- A subagent interrupted by Gateway restart with missing backing session is
  marked as `interrupted_by_restart` and the requester receives a clear status
  notification.
- Gateway restart/drain status is visible to affected requester sessions without
  noisy duplicate messages.
- Reconciliation is idempotent: repeated startup ticks do not duplicate final
  result delivery or interruption notices.
- Focused vitest coverage passes for outbox persistence, startup reconciliation,
  and restart transition text.
