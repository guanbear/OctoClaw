# Tasks

> ## Archive note
>
> Archived 2026-05-15. All four work-packets shipped; checkboxes left unticked
> in the original file because the work landed in slices and ticking was never
> backfilled.
>
> **Shipped (verified by `grep_search`):**
>
> - WP-1: `streamingMode: "off" | "partial" | "block" | "progress"` config
>   surface on Slack adapter (`im/slack/slack-adapter.ts:43`); `canStreamNative:
>   false` set on Feishu / WeChat / Discord / Telegram adapters.
> - WP-2: `channelStreaming?: ChannelStreamingMode` parameter added to
>   `CreateAckTimersParams` in `ack/ack-timing.ts:56`. Tier-skip guard at
>   `ack-timing.ts:200` (`streamingSkipsTiers = params.channelStreaming ===
>   "native"`).
> - WP-3: `resolveChannelStreamingForAck()` helper in `ack/ack-guard.ts:75` and
>   call site at `ack-guard.ts:968`.
>
> **Skipped (no environment):** Slack live smoke (WP-4). No Slack workspace
> available in CI. Tracked under `v0.6-stability-hardening`.
>
> **Hard invariants** (unchanged): ACK0 reaction + 2500ms text-fallback timing
> unchanged; suppress priority in `decideAckAction()` unchanged;
> `cancelAckTimers()` still safe to call when nothing is scheduled; no
> behavior change on Feishu / WeChat / Discord / Telegram (those still get
> tier 1/2/3 timers because `canStreamNative=false`).


## WP-1 Adapter Capability Surface

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/im/adapter.ts`
- `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`
- `extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.ts`
- `extensions/octoclaw-runtime/src/im/wechat/wechat-adapter.ts`

Tasks:

- [ ] Extend `IMAdapter.capabilities` with a `streamingMode: "native" | "partial" | "off"` derived getter.
- [ ] Slack: return `native` iff `streamingMode !== "off"` AND `nativeTransport === true`; otherwise `off`.
- [ ] Feishu / WeChat: always return `off`.
- [ ] Do not change existing capability flags.

Acceptance:

- [ ] Unit tests on each adapter verify the new getter.
- [ ] No existing capability field is removed.

## WP-2 createAckTimers skip

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/ack/ack-timing.ts`
- `extensions/octoclaw-runtime/src/ack/ack-timing.test.ts`

Tasks:

- [ ] Add `channelStreaming?: "native" | "partial" | "off"` to `CreateAckTimersParams`.
- [ ] In `createAckTimers()`, before the tier loop, if `params.channelStreaming === "native"` set `streamingSkipsTiers = true` and skip scheduling any tier.
- [ ] Emit `tier0Fired = tier1Fired = tier2Fired = tier3Fired = false` state so downstream `cancelAckTimers` / `ackTimerStateForKey` checks still pass.
- [ ] Unit tests: with `channelStreaming="native"`, no timer fires after 120 s simulated time.
- [ ] Unit tests: with `channelStreaming="off"` or undefined, tier1/tier2 fire at expected offsets on reply route.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/ack/ack-timing.test.ts`
- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/ack/ack-timing.integration.test.ts`

## WP-3 ack-guard call site

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/ack/ack-guard.ts`
- `extensions/octoclaw-runtime/src/ack/ack-guard.test.ts`

Tasks:

- [ ] In `startAckGuard()` (or wherever `createAckTimers()` is invoked), read the adapter capability and pass as `channelStreaming`.
- [ ] Default to `"off"` when no adapter is resolved.
- [ ] Unit test: Slack adapter + reply route → no tier1 fire after 13 s.
- [ ] Unit test: Feishu adapter + reply route → tier1 fires at 12 s.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/ack/ack-guard.test.ts`

## WP-4 Verification

Owner: operator, Codex review.

Tasks:

- [ ] `pnpm check && pnpm test` (tolerating the 6 pre-existing failures tracked in improvement plan appendix B).
- [ ] Slack smoke: long reply-route turn; confirm no tier1 text ("tool_still_working") appears.
- [ ] Feishu smoke (if available): long reply-route turn; confirm tier1 fires.

Acceptance:

- [ ] No new test failures introduced by this change.
- [ ] Slack smoke passes.

## Hard Invariants

- ACK0 (reaction + text fallback at 2500ms) timing unchanged.
- `decideAckAction()` suppress priority unchanged.
- `cancelAckTimers()` still safely callable when no timers scheduled.
- No user-visible behaviour change on Feishu/WeChat.
