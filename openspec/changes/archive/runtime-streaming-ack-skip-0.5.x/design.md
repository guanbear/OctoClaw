# Design: Streaming Channel ACK Tier Skip 0.5.x

## 1. Context

`ack-decision.ts` currently contains:

```ts
export function decideAckAction(packet: AckDecisionPacket): AckDecision {
  // HIGHEST PRIORITY: suppress when final response is actively streaming
  if (packet.finalResponseStreaming) {
    return packet.ackWriterQueued
      ? { action: "cancel_ack_writer", reason: "final response streaming supersedes all ACK" }
      : { action: "suppress", reason: "final response streaming supersedes all ACK" };
  }
  ...
}
```

This is correct. But `ack-timing.ts` / `createAckTimers()` schedules tier timers eagerly when a turn begins, long before `finalResponseStreaming` becomes true. On Slack (the L2 adapter with native streaming), these timers fire into `decideAckAction()`, get suppressed, and leave no visible effect — but they still consumed:

1. a `setTimeout` slot per tier (3 per turn),
2. entries in `ackTimersByStateKey`,
3. test noise because streaming tests must mock `finalResponseStreaming=true` early to keep assertions clean.

## 2. Principle

The scheduler should not schedule what the decider will always suppress. If the channel guarantees live streaming, skip tier scheduling at the source.

## 3. Channel capability

Each IM adapter already has a `capabilities` object with `canStreamNative`. We add a derived `streamingMode` getter:

```ts
type StreamingMode = "native" | "partial" | "off";

interface IMAdapterCapabilities {
  canUpdateMessage: boolean;
  canStreamNative: boolean;       // unchanged
  canReplyInThread: boolean;
  canTypingIndicator: boolean;
  messageIdFormat: string;
  userIdCaseSensitive: boolean;
  maxMessageLength: number;
  // NEW:
  streamingMode: StreamingMode;   // derived per adapter
}
```

Per adapter:

- **Slack L2**: `streamingMode = this.config.streamingMode !== "off" && this.config.nativeTransport ? "native" : "off"`
- **Feishu L1**: always `"off"`
- **WeChat L0**: always `"off"`

Callers treat `"partial"` same as `"off"` for tier scheduling (reserved for future non-native partial streaming).

## 4. ack-timing.ts changes

```ts
export interface CreateAckTimersParams {
  stateKey: string;
  sessionKey: string;
  routePhase: AckRoutePhase;
  inboundTs?: number;
  onTierFire: (result: AckTimerResult) => void;
  config?: Partial<AckTimingConfig>;
  channelStreaming?: StreamingMode;  // NEW
}

export function createAckTimers(params: CreateAckTimersParams): AckTimerState {
  // ... existing setup ...

  const streamingSkipsTiers = params.channelStreaming === "native";

  if (!streamingSkipsTiers) {
    for (let tier = 0; tier <= 3; tier++) {
      const delayMs = tierDelays[tier] ?? config.tierDelaysMs[tier];
      if (!delayMs || !shouldScheduleTier(state.routePhase, tier)) continue;
      // ... existing timer scheduling ...
    }
  }

  ackTimersByStateKey.set(stateKey, state);
  if (sessionKey) stateKeyBySessionKey.set(sessionKey, stateKey);
  return state;
}
```

The state object is still registered and keyed, so downstream `cancelAckTimers()` and `ackTimerStateForKey()` continue to behave correctly — they just find an empty timer set.

## 5. ack-guard.ts call site

```ts
import { getAdapterForSession } from "../im/index.js";

export function startAckGuard(input: StartAckGuardInput): void {
  // ... existing prep ...
  const adapter = getAdapterForSession(input.sessionKey);
  const channelStreaming: StreamingMode = adapter?.capabilities?.streamingMode ?? "off";

  createAckTimers({
    stateKey,
    sessionKey: input.sessionKey,
    routePhase,
    inboundTs,
    onTierFire: (result) => handleTierFire(input.stateKey, result),
    config: input.ackTimingConfig,
    channelStreaming,
  });
  // ... existing watchdog wiring ...
}
```

When no adapter is registered (tests, CLI mode), `channelStreaming = "off"` — same behaviour as today.

## 6. Tests

### 6.1 `ack-timing.test.ts`

New test: "skips tier scheduling when channelStreaming === native"

```ts
it("skips tier scheduling when channelStreaming === native", () => {
  vi.useFakeTimers();
  const fired: AckTimerResult[] = [];
  createAckTimers({
    stateKey: "native-stream",
    sessionKey: "slack:x:channel:C1",
    routePhase: "reply",
    config: { tierDelaysMs: DEFAULT_TIER_DELAYS_MS },
    channelStreaming: "native",
    onTierFire: (r) => fired.push(r),
  });
  vi.advanceTimersByTime(200_000);
  expect(fired).toEqual([]);
});
```

Existing tests that don't pass `channelStreaming` remain unchanged because the default behaves the same as `"off"`.

### 6.2 `ack-timing.integration.test.ts`

Add counterpart tests that explicitly pass `"native"` and assert no tier fires.

### 6.3 `slack-adapter.test.ts`

```ts
it("exposes streamingMode='native' by default", () => {
  expect(new SlackAdapter({ nativeTransport: true, streamingMode: "partial" }).capabilities.streamingMode).toBe("native");
  expect(new SlackAdapter({ nativeTransport: false, streamingMode: "partial" }).capabilities.streamingMode).toBe("off");
  expect(new SlackAdapter({ nativeTransport: true, streamingMode: "off" }).capabilities.streamingMode).toBe("off");
});
```

### 6.4 `feishu-adapter.test.ts` / `wechat-adapter.test.ts`

```ts
it("exposes streamingMode='off' (no native streaming)", () => {
  expect(new FeishuAdapter().capabilities.streamingMode).toBe("off");
  expect(new WeChatAdapter().capabilities.streamingMode).toBe("off");
});
```

## 7. Rollout

One commit:

- Adapter capability additions.
- `createAckTimers()` skip logic.
- Call site update.
- Unit tests.

Rollback is `git revert`. No data migration. No state persistence involved.

## 8. Hard Invariants

1. ACK0 reaction timing (`reaction_ack_ms = 300`) and text fallback timing (`text_ack0_ms = 2500`) are not affected.
2. On Feishu/WeChat the observed behaviour is byte-for-byte identical.
3. `cancelAckTimers()` remains safe to call on any state regardless of `channelStreaming`.
4. `decideAckAction()` suppress priority unchanged.

## 9. Future Considerations

- If we later add a channel with "partial" non-native streaming (e.g. Discord webhook with typing indicator), map it to `"partial"` and decide whether tiers should still fire on a longer cadence.
- If tier0 (warmth nudge) becomes desirable even on streaming channels (currently not scheduled on reply path anyway), handle it as a separate parameter.
