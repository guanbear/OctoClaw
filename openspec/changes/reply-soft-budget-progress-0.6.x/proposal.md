# Change: Reply Soft-Budget Progress

Date: 2026-05-28
Target release: v0.6.x

## Why

Recent Slack transcripts showed a confusing failure mode: the main agent stayed on the `reply` route for several minutes, Slack only received a reaction ACK, and no visible progress or timeout text was posted. In another run, budget escalation evidence was recorded, but the user still saw main-agent wording instead of a clear runtime-owned transition.

This should not depend on the model deciding to send a courtesy update. Slack users need deterministic runtime progress when the main reply lane is taking too long.

## Problems

1. A neutral reaction ACK can satisfy or cancel ACK state in a way that prevents later timer-based progress text.
2. `reply + must_reply` is treated like a normal reply for user-visible progress, so long main-agent work can stay silent.
3. Route-commit text ACK is intentionally disabled for reply routes, but that must not disable later elapsed-time progress reminders.
4. Budget escalation and user-visible progress are conflated in behavior and evidence, making it hard to tell whether runtime should notify, escalate, or both.

## Goals

- Send runtime-owned progress text for long-running Slack `reply` turns, including `must_reply`.
- Keep neutral reaction ACK as a lightweight receipt only; it must not cancel later progress timers.
- Keep reply route-commit text ACK disabled unless separately changed.
- Keep delegate escalation stricter than progress reminders.
- Record evidence that distinguishes progress notification from budget/delegate escalation.
- Avoid false positives for fast replies, already-visible replies, delivered replies, streaming replies, and non-Slack/no-target turns.

## Non-Goals

- Do not force all `must_reply` turns to delegate.
- Do not re-enable reply route-commit text ACK.
- Do not rely on model text to provide progress notices.
- Do not redesign the router, judge, or WorkContract policy.

## Acceptance Gate

- A Slack `reply + must_reply` turn that remains silent past the soft progress threshold receives visible progress text even if a reaction ACK was already sent.
- A fast reply or already-streaming reply does not receive duplicate progress text.
- A delegate/observe route does not receive reply-style progress after the route decision is known.
- Existing route-commit reply ACK suppression still returns `reply_route_runtime_text_ack_disabled`.
- Targeted ACK/runtime tests pass.
