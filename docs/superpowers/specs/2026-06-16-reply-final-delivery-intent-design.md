---
comet_change: reply-final-delivery-intent-06x
role: technical-design
canonical_spec: openspec
---

# Reply Final Delivery Intent Design

## Context

OpenSpec change: `openspec/changes/reply-final-delivery-intent-06x`

The current runtime has target-freezing fixes and native child announce delivery,
but normal main-agent final replies still depend on OpenClaw's automatic Slack
send. If that send does not happen or leaves no evidence, OctoClaw records final
state but has no final delivery backstop.

## Design

Add a focused `reply-final-delivery-intent` module behind a small interface:

- create/update an intent from anchored Slack inbound turns;
- record final assistant text and a stable final hash;
- resolve the frozen delivery target;
- decide whether a final needs backstop delivery;
- mark delivered, skipped, or failed.

Initial persistence can be `policyState`. The module owns field shape and
idempotency so callers do not spread more aliases through hooks.

## Hook Changes

`message_received` creates the intent when an inbound Slack anchor is present.
Unanchored Slack turns fail closed.

`before_message_write` records `finalText` and `finalHash` when it sees a
non-empty non-`NO_REPLY` assistant final. It must not mark the final as
delivered. `formal_reply_visible` remains only an ACK/footer suppression hint.

`agent_end` calls the finalizer. If the intent has final text, a frozen target,
and no hard delivery evidence, it sends through `sendIMMessage` using the frozen
target. It marks delivered only after adapter success.

## Idempotency

The finalizer idempotency key is:

`finalHash + sessionKey + replyToMessageId`

It skips send when:

- intent status is already `delivered`;
- native announce hard delivery evidence exists;
- a previous backstop delivery idempotency key matches.

## Failure Modes

- Missing inbound anchor: `failed/missing_inbound_anchor`, no fallback send.
- Empty final: `skipped/empty_final`.
- Adapter send failure: `failed/<adapter error>`, final evidence retained.
- Duplicate evidence: `skipped/duplicate_delivery`.

## Tests

Use TDD with focused Vitest coverage:

- delivery intent unit tests for creation, final capture, idempotency key, and
  missing target handling;
- `before_message_write` hook test that final text is recorded but delivery is
  not marked;
- `agent_end` hook test that a pending final is sent to the frozen target;
- duplicate-suppression test with hard native/OpenClaw delivery evidence;
- close-turn test proving distinct Slack timestamps keep distinct targets.

## Cleanup Boundary

Do not delete existing anchor/native announce patches in this slice. After live
and test evidence proves the finalizer, follow-up cleanup can remove redundant
prompt-fuzzy target fallback and repeated alias repair paths.
