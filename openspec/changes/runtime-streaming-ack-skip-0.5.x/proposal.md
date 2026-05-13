# Change: Streaming Channel ACK Tier Skip 0.5.x

## Purpose

When an IM channel streams final responses natively (Slack L2 with `streamingMode !== "off"`), the user sees text arriving live. In that case tier1/tier2/tier3 progress nudges scheduled by `createAckTimers()` are pure waste — `decideAckAction()` suppresses them anyway, but the timers still occupy state and fire-then-suppress paths. This change makes `createAckTimers()` skip tier scheduling when the channel advertises native streaming.

## Problem

- `ack-decision.ts` correctly treats `finalResponseStreaming` as HIGHEST PRIORITY suppress for all ACKs.
- `ack-timing.ts` schedules tier timers eagerly; streaming-only suppress happens later via `cancelAckTimers()`.
- For Slack (default `streamingMode=partial` + `nativeTransport=true`), every reply-route turn schedules 3 tier timers that will never fire usefully.
- The timer state adds noise to tests (many need to mock `finalResponseStreaming=true` to avoid spurious tier ACKs).

## Scope

- Add a `channelStreaming` parameter to `CreateAckTimersParams`.
- In `createAckTimers()`, skip tier scheduling when `channelStreaming === "native"`.
- Wire the IM adapter capability into `ack-guard.ts` so it passes the right value.
- Keep existing behaviour for Feishu L1 (`canStreamNative=false`) and WeChat L0 — tiers still schedule there.

## Non-Goals

- Do not change `decideAckAction()` suppress priority. That logic is correct.
- Do not remove tier templates. They are still needed on non-streaming channels.
- Do not remove `ACK_TIMING` constants.
- Do not change reply-route ACK0 (reaction or text) behaviour. Those run at t=300ms or t=2500ms, well before streaming starts.

## Target Behaviour

Channel capability | tier schedule | rationale
-------------------|---------------|----------
Slack L2, `streamingMode=partial`/`block`/`progress`, `nativeTransport=true` | skip | user sees live stream, nudges are redundant
Slack with `streamingMode=off` | schedule tiers | no streaming, nudges needed
Feishu L1 | schedule tiers | `canStreamNative=false`
WeChat L0 | schedule tiers | `canStreamNative=false`

## Acceptance Gate

- `pnpm vitest run extensions/octoclaw-runtime/src/ack/` stays green.
- Slack adapter tests explicitly assert tier1/tier2/tier3 are NOT scheduled when `channelStreaming === "native"`.
- Feishu adapter tests explicitly assert tier1/tier2 fire at 12 s / 30 s when no `channelStreaming` override or `channelStreaming !== "native"`.
- ACK0 (reaction / text fallback) path is unchanged.

## Rollout

One slice, one commit. Rollback is git revert.

## Why Now

- Low risk (timer scheduling only), high value (removes a source of test flakiness and state noise).
- Preparation for W-3 (extension-entry slim): less global timer state to move around.
