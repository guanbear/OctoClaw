# Tasks: Reply Final Delivery Intent

## Phase A - OpenSpec and Design

- [x] Create OpenSpec change directory and Comet state.
- [x] Add `proposal.md`.
- [x] Add `design.md`.
- [x] Add `bdd.md`.
- [x] Add `tasks.md`.

## Phase B - Impact Analysis

- [x] Run GitNexus impact for `makeMessageReceivedHook`.
- [x] Run GitNexus impact for `makeBeforeMessageWriteHook`.
- [x] Run GitNexus impact for `makeAgentEndHook`.
- [x] Run GitNexus impact for any new/modified final delivery symbols before editing.
- [x] Report blast radius before production code edits.

Notes: `PolicyStateEntry` returned LOW risk with no direct callers/processes
reported. Hook and new final-delivery helper symbols returned UNKNOWN/not found
in the current GitNexus index, so the runtime hook changes were treated as
unknown-risk lifecycle hot-path changes and kept narrowly scoped.

## Phase C - Delivery Intent Module

- [x] Add failing tests for intent creation, final capture, missing anchor, and
  duplicate key calculation.
- [x] Implement the minimal delivery intent module over `policyState`.
- [x] Run focused intent tests.

## Phase D - Hook Integration

- [x] Add failing hook tests for `before_message_write` recording final evidence.
- [x] Add failing hook tests for `agent_end` backstop delivery.
- [x] Add failing hook tests for duplicate suppression when native/OpenClaw
  delivery evidence exists.
- [x] Wire `message_received`, `before_message_write`, and `agent_end` through
  the delivery intent module.
- [x] Run focused hook tests.

## Phase E - Verification

- [x] Run targeted Vitest files for delivery intent and agent-end hooks.
- [x] Run `pnpm --filter @octoclaw/runtime run check`.
- [x] Run `pnpm check` or the smallest repo aggregate required by current
  package scripts.
- [x] Run `gitnexus detect-changes` before commit.
- [x] Update this task list with completed checkboxes and skipped live-smoke
  notes.

Notes: `gitnexus detect-changes --repo OctoClaw --scope all` returned
`No changes detected.` Live Slack smoke was not run before commit; verification
is covered by focused hook tests, runtime typecheck, full `pnpm check`, and
OpenSpec validation.
