# BDD: Restart Recovery Delivery Outbox

Date: 2026-05-26

## Naming

- `RRDO-OUTBOX-*`: durable result outbox behavior
- `RRDO-RECONCILE-*`: startup reconciliation behavior
- `RRDO-STATUS-*`: user-visible restart/recovery status

## RRDO-OUTBOX-001: Completed child result is persisted before delivery

**Given** a native subagent completion with a requester origin and safe final text
**When** OctoClaw prepares final delivery
**Then** it writes a pending delivery outbox item before sending the message
**And** the outbox item contains run/task/work-contract IDs and result hash
**And** it does not contain raw transcript or auth material

## RRDO-OUTBOX-002: Delivered result is marked idempotently

**Given** a pending outbox item
**When** final delivery succeeds
**Then** the outbox item is marked delivered
**And** a repeated delivery attempt with the same result hash is skipped

## RRDO-RECONCILE-001: Startup delivers completed pending result

**Given** Gateway restarts after a child run completes
**And** the run has a persisted final result
**And** user delivery is still pending
**When** startup reconciliation runs
**Then** the final result is delivered to the requester
**And** the delivery state becomes delivered

## RRDO-RECONCILE-002: Startup reports restart-interrupted orphan

**Given** Gateway restarts while a child run is active
**And** the run later has error `service restart`, `backing session missing`, or
`missing-session-entry`
**And** no durable final result exists
**When** startup reconciliation runs
**Then** the requester receives an interrupted-by-restart status
**And** the run is not reported as completed

## RRDO-RECONCILE-003: Reconciliation is idempotent

**Given** startup reconciliation already delivered a pending result or reported an
interrupted run
**When** reconciliation runs again
**Then** no duplicate final result or duplicate restart warning is sent

## RRDO-RECONCILE-004: Gateway start scans native task runs

**Given** OpenClaw fires the `gateway_start` hook after restart
**And** `runs.sqlite` contains a native `task_runs` row with `status=succeeded`,
`delivery_status=pending`, requester session, child session, and terminal result
summary
**When** OctoClaw handles `gateway_start`
**Then** it persists a delivery outbox item
**And** it sends the terminal result through the existing IM delivery port
**And** it marks the outbox item and native row delivered after send success

## RRDO-RECONCILE-005: Gateway start does not replay delivered or resultless rows

**Given** `runs.sqlite` contains already delivered rows or succeeded rows without
durable terminal result text
**When** OctoClaw handles `gateway_start`
**Then** it does not send a duplicate final result
**And** it records only sanitized recovery evidence

## RRDO-STATUS-001: Active restart is visible to affected requester

**Given** Gateway starts draining for restart
**And** there are active delegated child runs for a requester
**When** OctoClaw observes the restart transition
**Then** the requester sees a compact status that Gateway is restarting and
results will be recovered after startup

## RRDO-STATUS-002: Pending completed result is shown as delivery-pending

**Given** a child result has completed but delivery has not succeeded
**When** status is projected to the requester
**Then** the user-facing status says execution completed and delivery is pending
**And** it does not look like the child is still running

## RRDO-STATUS-003: Gateway start hook is the restart recovery boundary

**Given** OpenClaw supports `gateway_start`
**When** OctoClaw runtime plugin loads
**Then** it registers restart recovery on `gateway_start`
**And** plugin-load startup reconcile remains best-effort only
