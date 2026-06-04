# Current Turn Binding Design

## Problem

Slack inbound delivery is currently correct at `message_received`, but later runtime hooks re-resolve
the active turn from `ctx.sessionKey`, `ctx.sessionId`, or fuzzy prompt state. During a burst of Slack
DMs, this lets ACKs, WorkContracts, dispatch selection, and native announce delivery drift to another
message thread, a root DM, or a run UUID.

## Invariants

- Every inbound Slack message with a timestamp has one current-turn binding.
- The binding owns `stateKey`, root IM `sessionKey`, `replyToMessageId`, immutable `deliveryTarget`,
  and the prompt text used to match later hooks.
- Runtime hooks may use prompt matching to recover a binding, but after recovery they must use the
  binding's `stateKey` and delivery target as authoritative.
- If multiple inbound turns have identical prompt text, later hooks claim unclaimed thread states FIFO
  by root session and runtime `sessionId`; they must not fall back to the latest root alias.
- Delegate/native Slack delivery without an explicit inbound anchor must fail closed, not fall back to
  top-level delivery.
- Implicit delegate WorkContract reuse is allowed only when the candidate contract belongs to the same
  turn/thread binding. "Latest in this DM" is not enough.

## Implementation Shape

Add a small binding resolver around the existing inbound anchor state:

- `resolveCurrentTurnBinding(prompt, ctx, event)` returns the best current turn binding from explicit
  ctx/event anchors, prompt-matched inbound state, or exact existing state.
- identical-prompt Slack bursts use a small FIFO claim on canonical thread states to bind run
  `sessionId`s without using the mutable root DM alias as truth.
- `makeBeforeDispatchHook` uses the binding state key for replay, control-plane fast path, and neutral
  ACK.
- `makeBeforePromptBuildHook` builds a bound ctx before policy resolution so metadata and WorkContract
  creation freeze the correct delivery target.
- `executeOctoclawDispatch` and `selectLatestSealedDelegateWorkContract` require the implicit fallback
  candidate to match the current state key, delivery target, or WorkContract continuity.

## Tests

Add focused regressions for a multi-message Slack DM burst:

- `before_prompt_build` resolves policy on the matched thread state, not on the run UUID.
- the WorkContract created for a delegate turn contains the matching Slack `replyToMessageId`.
- implicit dispatch fallback does not pick a sealed delegate WorkContract from another Slack thread.
