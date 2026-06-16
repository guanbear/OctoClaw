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
