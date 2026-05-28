# Tasks: Reply Soft-Budget Progress

## Phase A — Contract Documentation

- [x] Add `proposal.md`.
- [x] Add `design.md`.
- [x] Add `bdd.md`.
- [x] Add `tasks.md`.

## Phase B — Regression Coverage

- [x] Add a regression proving neutral reaction ACK does not cancel the reply progress guard.
- [x] Add a regression proving `reply + must_reply` can receive timer progress text after silence.
- [x] Preserve existing reply route-commit ACK suppression coverage.

## Phase C — Runtime Fix

- [x] Keep neutral inbound ACK ownership from cancelling timer progress.
- [x] Ensure unresolved route guards can become reply progress guards when the route resolves to `reply`.
- [x] Ensure delegate/observe decisions still cancel reply progress timers.

## Phase D — Verification

- [x] Run targeted ACK tests.
- [x] Run impacted runtime tests if targeted coverage shows adjacent failures.
- [x] Run GitNexus detect-changes before commit.
