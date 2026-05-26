# Tasks: Restart Recovery Delivery Outbox

## Phase A — Contract Documentation

- [x] Add `proposal.md`.
- [x] Add `design.md`.
- [x] Add `bdd.md`.
- [x] Add `tasks.md`.

## Phase B — Impact Analysis

- [x] Run `npx gitnexus impact checkActiveTaskRecovery --repo OctoClaw-detached-conflict-backup-20260512-155353 --direction upstream` — LOW, 0 direct callers, 0 affected processes.
- [x] Run `npx gitnexus impact emitExecutionTransitionNotification --repo OctoClaw-detached-conflict-backup-20260512-155353 --direction upstream` — LOW, 0 direct callers, 0 affected processes.
- [x] Run `npx gitnexus impact applyNativeAnnounceCompletionState --repo OctoClaw-detached-conflict-backup-20260512-155353 --direction upstream` — LOW, 0 direct callers, 0 affected processes.
- [x] Report blast radius before editing production symbols.

## Phase C — Delivery Outbox

- [x] Add failing tests for safe result persistence, delivered marking, and
  duplicate-result dedupe.
- [x] Implement the minimal delivery outbox module.
- [x] Add file-backed outbox reload test for restart persistence.
- [x] Implement JSON-backed delivery outbox storage at
  `tmp/octopus/restart-delivery-outbox.json` with
  `OCTOCLAW_DELIVERY_OUTBOX_PATH` override.
- [x] Run focused outbox tests.

## Phase D — Startup Reconciliation

- [x] Add failing tests for completed pending result delivery after startup.
- [x] Add failing tests for restart-interrupted orphan reporting.
- [x] Add failing tests proving reconciliation idempotency.
- [x] Implement bounded startup reconciliation using durable outbox/task evidence.
- [x] Run focused reconciliation tests.

## Phase E — Restart/Recovery User Status

- [x] Add failing tests for restart/recovery transition text.
- [x] Add transition kinds for restart draining, restart recovered, and
  interrupted-by-restart.
- [x] Persist native announce child results to the delivery outbox before
  direct delivery; mark the same outbox item delivered only after successful
  send.
- [ ] Wire deduped status notifications for affected requester sessions. Skipped in this slice: transition kinds and pure recovery outputs are in place, but live Gateway drain observation needs a separate OpenClaw boundary hook.
- [x] Run focused notification tests.

## Phase F — Verification

- [x] Run targeted vitest commands listed in the implementation plan.
- [x] Run `pnpm --filter @octoclaw/runtime run check`.
- [x] Run `pnpm check`.
- [x] Run `pnpm test`.
- [x] Run `npx gitnexus detect-changes --repo OctoClaw-detached-conflict-backup-20260512-155353 --scope all`.
- [x] Update this task list with completed checkboxes and any skipped live-smoke
  notes.

## Phase G — Gateway Start Native Run Bridge

- [x] Update design/BDD/tasks for `gateway_start` and `runs.sqlite` bridge.
- [x] Run GitNexus impact for startup hook registration and recovery symbols.
- [x] Add failing tests for reading pending native `task_runs` rows from
  `runs.sqlite`.
- [x] Add failing tests for gateway-start delivery of
  `succeeded + delivery_status=pending + terminal_summary`.
- [x] Implement bounded `runs.sqlite` reader using structured task columns only.
- [x] Implement gateway-start recovery bridge that writes outbox before IM send.
- [x] Mark outbox and native row delivered only after send success.
- [x] Register recovery on OpenClaw `gateway_start`.

## Phase H — Verification After Gateway Start Bridge

- [x] Run focused bridge/recovery/native announce tests.
- [x] Run Slack adapter abort regression test after full-suite unhandled
  rejection exposed an existing uncaught channel-resolution failure.
- [x] Run `pnpm --filter @octoclaw/runtime run check`.
- [x] Run `pnpm check`.
- [x] Run `pnpm test`.
- [x] Run `npx gitnexus detect-changes --repo OctoClaw-detached-conflict-backup-20260512-155353 --scope all` — HIGH, 8 files, 24 symbols, 8 affected execution flows; expected high-level flows include `extension-entry.register`, `executeSlackApiSend`, and execution transition notification text/dedupe.
