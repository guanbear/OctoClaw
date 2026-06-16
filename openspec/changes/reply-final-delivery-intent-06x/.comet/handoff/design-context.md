# Comet Design Handoff

- Change: reply-final-delivery-intent-06x
- Phase: design
- Mode: compact
- Context hash: b6d76e987b4d851d1c7923866e2edb99af512edab45fa0903a5aeed3167e2f82

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/reply-final-delivery-intent-06x/proposal.md

- Source: openspec/changes/reply-final-delivery-intent-06x/proposal.md
- Lines: 1-52
- SHA256: 7dafa87010fef1d54c9f6aef73e737d85e6c85bb20b506eee1b49ff0072b1395

```md
# Change: Reply Final Delivery Intent

Date: 2026-06-16
Target release: v0.6.x

## Why

Recent live Slack runs exposed a final-reply delivery gap that is separate from
native child final delivery. The model can produce a final answer, but OpenClaw's
automatic Slack delivery may not emit a visible message or may not leave
delivery evidence. OctoClaw currently records turn state, anchors, footer
projection, and native announce delivery, but it does not own a final delivery
backstop for normal main-agent replies.

Existing fixes improved frozen Slack anchors and native child result delivery.
They do not close the general path where a normal final answer exists and the
Slack requester sees no message.

## Goals

- Create one turn-scoped delivery intent for each inbound Slack turn.
- Freeze the Slack delivery target at message receipt and reuse it across
  prompt build, dispatch, final write, and agent end.
- Capture final answer text/hash when the main agent writes a final assistant
  message, without treating that as delivery success.
- Backstop-send the final answer once through the IM adapter at `agent_end` when
  no reliable delivery evidence exists.
- Suppress duplicates when OpenClaw/native delivery already sent the final.
- Add focused regression tests for close-together Slack turns, missing native
  delivery evidence, and duplicate suppression.

## Non-Goals

- Do not replace OpenClaw's native Slack delivery path.
- Do not rewrite native child announce delivery.
- Do not reintroduce the old child-finalizer, transcript scanner, or JSON
  delivery outbox as a task engine.
- Do not infer delivery success from footer projection, `formal_reply_visible`,
  hidden transcript writes, or ACK text.
- Do not send unanchored Slack replies.

## Acceptance Gate

- A final assistant answer with a frozen Slack target and no delivery evidence is
  delivered once at `agent_end`.
- A final assistant answer that already has native/OpenClaw delivery evidence is
  not resent.
- Three close-together Slack DM turns keep separate delivery intents and do not
  steal each other's thread target.
- `formal_reply_visible` no longer means delivered; delivery status is recorded
  only after adapter success or hard native evidence.
- Regression tests cover the finalizer red/green path and idempotency.
```

## openspec/changes/reply-final-delivery-intent-06x/design.md

- Source: openspec/changes/reply-final-delivery-intent-06x/design.md
- Lines: 1-108
- SHA256: 919c9bbd1310077a2d70786057301d5c32510c8fa5912f6994b317ed164e5d6d

[TRUNCATED]

```md
# Design: Reply Final Delivery Intent

## Root Cause

OctoClaw currently has multiple partial sources for final reply delivery state:

- inbound anchor fields in hook context;
- `policyState` aliases such as `ackGuardKey`, `latestTurnStateKey`, and
  `deliveryTarget`;
- WorkContract delivery targets;
- `formal_reply_visible` and ACK tracking state;
- native announce delivery telemetry.

These sources help route and decorate messages, but none of them is the single
authority for the normal main-agent final delivery lifecycle. `before_message_write`
can see final text and mark `formal_reply_visible`; `message_sending` can guard a
message that OpenClaw is already sending; `agent_end` can record a receipt. No
module currently says: "this final answer exists, this is the frozen target, this
target has not been delivered, send it exactly once now."

## Invariants

- The inbound Slack turn owns the delivery target.
- Final text visibility is not delivery success.
- Adapter success or hard native delivery evidence is required before marking a
  final answer delivered.
- Slack final replies require an explicit inbound anchor.
- Backstop delivery is idempotent by final text hash and frozen target.
- Native child announce delivery remains a separate specialized path, but it can
  share delivery evidence checks.

## Architecture

### Delivery Intent

Add a small runtime module that treats a Slack turn as the durable delivery
intent for final replies.

Fields:

- `intentId`
- `stateKey`
- `sessionId`
- `sessionKey`
- `deliveryTarget`
- `promptHash`
- `finalText`
- `finalHash`
- `finalSeenAt`
- `deliveryStatus`: `pending | delivered | skipped | failed`
- `deliveryMessageId`
- `deliveryError`
- `deliveredAt`

The initial storage can live in `policyState` because this slice only needs to
survive the current managed run. It must be wrapped by a focused module so later
work can move it into SQLite without changing every hook.

### Hook Responsibilities

- `message_received`: create or refresh a turn delivery intent when an inbound
  Slack anchor exists. Do not create an intent for unanchored Slack turns.
- `before_prompt_build` and dispatch: read the frozen target through the intent
  module instead of re-solving delivery from ad hoc aliases where possible.
- `before_message_write`: when a non-`NO_REPLY` final assistant message is
  written, record `finalText` and `finalHash` on the intent. This is `final_seen`,
  not delivered.
- `message_sending`: if OpenClaw is sending a visible final, record hard delivery
  evidence only if the event exposes it. Otherwise leave the intent pending.
- `agent_end`: if `final_seen` exists and the intent is not delivered, call the
  IM adapter with the frozen target and mark delivered only after send success.

### Duplicate Suppression

The finalizer computes an idempotency key:

`finalHash + sessionKey + replyToMessageId`

Before sending, it checks:

```

Full source: openspec/changes/reply-final-delivery-intent-06x/design.md

## openspec/changes/reply-final-delivery-intent-06x/tasks.md

- Source: openspec/changes/reply-final-delivery-intent-06x/tasks.md
- Lines: 1-44
- SHA256: da270068e553347457b510c1e385138d94ac1b62ae64d3561b3feecff8a53487

```md
# Tasks: Reply Final Delivery Intent

## Phase A - OpenSpec and Design

- [x] Create OpenSpec change directory and Comet state.
- [x] Add `proposal.md`.
- [x] Add `design.md`.
- [x] Add `bdd.md`.
- [x] Add `tasks.md`.

## Phase B - Impact Analysis

- [ ] Run GitNexus impact for `makeMessageReceivedHook`.
- [ ] Run GitNexus impact for `makeBeforeMessageWriteHook`.
- [ ] Run GitNexus impact for `makeAgentEndHook`.
- [ ] Run GitNexus impact for any new/modified final delivery symbols before editing.
- [ ] Report blast radius before production code edits.

## Phase C - Delivery Intent Module

- [ ] Add failing tests for intent creation, final capture, missing anchor, and
  duplicate key calculation.
- [ ] Implement the minimal delivery intent module over `policyState`.
- [ ] Run focused intent tests.

## Phase D - Hook Integration

- [ ] Add failing hook tests for `before_message_write` recording final evidence.
- [ ] Add failing hook tests for `agent_end` backstop delivery.
- [ ] Add failing hook tests for duplicate suppression when native/OpenClaw
  delivery evidence exists.
- [ ] Wire `message_received`, `before_message_write`, and `agent_end` through
  the delivery intent module.
- [ ] Run focused hook tests.

## Phase E - Verification

- [ ] Run targeted Vitest files for delivery intent and agent-end hooks.
- [ ] Run `pnpm --filter @octoclaw/runtime run check`.
- [ ] Run `pnpm check` or the smallest repo aggregate required by current
  package scripts.
- [ ] Run `gitnexus detect-changes` before commit.
- [ ] Update this task list with completed checkboxes and skipped live-smoke
  notes.
```

## openspec/changes/reply-final-delivery-intent-06x/specs/reply-final-delivery/spec.md

- Source: openspec/changes/reply-final-delivery-intent-06x/specs/reply-final-delivery/spec.md
- Lines: 1-78
- SHA256: 3c02a19e42678b992d67b60493c7f338fa3e6b702042c77640aedefd522be72f

```md
# Spec Delta: Reply Final Delivery

## ADDED Requirements

### Requirement: Final Reply Uses Frozen Delivery Intent

OctoClaw SHALL create a turn-scoped delivery intent for anchored Slack inbound
turns and SHALL use that intent as the authority for final reply delivery target
selection.

#### Scenario: inbound Slack turn creates intent

- WHEN a Slack inbound message has a session key and inbound message timestamp
- THEN OctoClaw SHALL create a delivery intent with a frozen session key and
  reply-to message id
- AND later prompt, dispatch, final write, and agent-end logic SHALL read the
  same frozen target.

#### Scenario: unanchored Slack turn fails closed

- WHEN a Slack turn has no inbound timestamp and no frozen delivery target
- THEN OctoClaw SHALL NOT send a final reply using a top-level or latest-message
  fallback
- AND SHALL record the reason as `missing_inbound_anchor`.

### Requirement: Final Visibility Is Not Delivery Success

OctoClaw SHALL distinguish final text visibility from user-visible delivery
success.

#### Scenario: final text is written

- WHEN `before_message_write` observes a non-empty assistant final
- THEN OctoClaw SHALL record final text/hash on the delivery intent
- AND SHALL NOT mark the final as delivered solely because the text was written
  or a footer was appended.

#### Scenario: adapter send succeeds

- WHEN OctoClaw sends a pending final through the IM adapter and the adapter
  reports success
- THEN OctoClaw SHALL mark the delivery intent as delivered
- AND SHALL record delivery message evidence when available.

### Requirement: Agent End Backstops Pending Finals

OctoClaw SHALL backstop-deliver a final answer at `agent_end` when a final was
seen and hard delivery evidence is missing.

#### Scenario: pending final at agent end

- WHEN a delivery intent has final text/hash and a frozen Slack target
- AND no hard delivery evidence exists
- THEN `agent_end` SHALL send the final through the IM adapter exactly once
- AND SHALL use the frozen target from the intent.

#### Scenario: hard delivery evidence exists

- WHEN hard native or OpenClaw delivery evidence exists for the same final turn
- THEN `agent_end` SHALL NOT send a duplicate final
- AND SHALL record a skipped duplicate reason.

### Requirement: Delivery Backstop Is Idempotent

OctoClaw SHALL dedupe final reply backstop delivery by final hash and frozen
delivery target.

#### Scenario: repeated agent end

- WHEN `agent_end` runs more than once for the same final hash and target
- THEN OctoClaw SHALL send at most one final reply through the IM adapter.

#### Scenario: close Slack turns

- WHEN multiple Slack DM turns arrive close together with different inbound
  timestamps
- THEN each turn SHALL keep its own delivery intent
- AND final delivery for one turn SHALL NOT use the other turn's target.
```

