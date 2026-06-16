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

- intent already `delivered`;
- native announce hard evidence for the same state;
- a prior backstop delivery with the same idempotency key.

If any condition is true, it records `skipped` with a reason and does not send.

### Failure Handling

- Missing Slack anchor: do not send; record `failed: missing_inbound_anchor`.
- Empty final text: do not send; record `skipped: empty_final`.
- IM adapter error: record `failed` and keep the final evidence for diagnostics.
- Duplicate evidence: record `skipped` without changing the frozen target.

## Testing

Add focused Vitest coverage around the new module and hooks:

1. `before_message_write` records final text/hash but not delivered.
2. `agent_end` backstop sends a pending final to the frozen Slack target.
3. `agent_end` does not send when native/OpenClaw delivery evidence exists.
4. Close-together Slack turns use distinct delivery intents and targets.
5. Missing anchor fails closed without top-level fallback delivery.

## Migration Strategy

Keep existing anchor and native announce patches during this slice. After this
finalizer is proven by tests and live smoke, remove redundant prompt fuzzy
matching and alias fallback logic in a follow-up cleanup.
