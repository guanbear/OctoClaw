# BDD: Reply Soft-Budget Progress

Date: 2026-05-28

## Naming

- `RSP-ACK-*`: neutral ACK and timer ownership
- `RSP-REPLY-*`: reply progress behavior
- `RSP-ROUTE-*`: route separation
- `RSP-BUDGET-*`: escalation separation

## RSP-ACK-001: Neutral reaction does not cancel reply progress guard

**Given** a Slack user message has a valid original message anchor
**And** runtime sends a neutral reaction ACK
**When** the same turn remains active on the reply lane
**Then** the reply progress guard remains active
**And** a later timer tier can send visible progress text

## RSP-ACK-002: Neutral text ACK does not block tier progress

**Given** reaction ACK is disabled or unavailable
**And** runtime sends a neutral text ACK
**When** the reply lane remains silent past the progress threshold
**Then** runtime can still send a later tier progress notice
**And** the tier notice uses a different ACK stage/idempotency key

## RSP-REPLY-001: `reply + must_reply` gets visible progress after silence

**Given** policy resolved the turn as `route=reply` and `decision_bucket=must_reply`
**And** no final reply, streaming reply, or delivery receipt is visible
**When** elapsed visible silence exceeds the soft progress threshold
**Then** Slack receives runtime-owned progress text in the original thread

## RSP-REPLY-002: Fast reply does not receive extra progress text

**Given** policy resolved the turn as `route=reply`
**When** the assistant starts visible output before the progress threshold
**Then** runtime suppresses timer progress text

## RSP-ROUTE-001: Delegate route cancels reply progress

**Given** the progress guard was started before route resolution
**When** policy resolves the turn as `delegate` or `observe`
**Then** reply-style progress timers are cancelled
**And** delegate/status runtime output owns user-visible updates

## RSP-ROUTE-002: Reply route-commit suppression does not suppress timer progress

**Given** reply route-commit text ACK is disabled
**And** `sendRouteCommitAck` skips with `reply_route_runtime_text_ack_disabled`
**When** the reply lane remains silent past the progress threshold
**Then** timer progress can still send visible text

## RSP-BUDGET-001: Progress notice is not delegate escalation

**Given** a `must_reply` turn receives a progress notice
**When** no long/write/unsafe/multi-step tool behavior occurs
**Then** runtime does not mark delegate escalation solely because progress text was sent
