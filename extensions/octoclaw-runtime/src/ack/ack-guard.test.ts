import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDecisionPacket,
  markMainModelFirstToken,
  maybeSendLatencyAck,
  NEUTRAL_INBOUND_ACK_TEXT,
  NEUTRAL_REACTION_ACK_FALLBACK_MS,
  resetNeutralInboundAckDedupeForTests,
  resolveAckTargetFromSessionKey,
  resolveRoutePhase,
  sendAckDirect,
  sendNeutralInboundAck,
  startAckGuard,
  threadKeyFromSessionKey as threadKeyFn,
  updateAckTrackingState,
} from "./ack-guard.js";
import { buildAckKey } from "./ack-dedupe.js";
import { ackTimerStateForKey, cancelAllAckTimers } from "./ack-timing.js";

const adapter = {
  send: vi.fn(),
  react: vi.fn(),
  resolveTarget: vi.fn(),
};

vi.mock("../im/index.js", () => ({
  getAdapterForSession: () => adapter,
  sendWithDegradation: async (adapterArg: typeof adapter, params: Record<string, unknown>) => adapterArg.send(params),
}));

afterEach(() => {
  vi.useRealTimers();
  cancelAllAckTimers();
  resetNeutralInboundAckDedupeForTests();
  vi.clearAllMocks();
  adapter.resolveTarget.mockReturnValue({ target: "C123ABC" });
});

describe("ack-dedupe", () => {
  it("separates ACK stages in the idempotency key", () => {
    const base = {
      threadId: "thread-1",
      anchorId: "anchor-1",
      routePhase: "reply",
      messageTurnId: "turn-1",
    };

    expect(buildAckKey({ ...base, ackStage: "ack0" })).not.toBe(
      buildAckKey({ ...base, ackStage: "delegate_started" }),
    );
  });
});

describe("ack-guard: canonical resolver integration", () => {
  describe("resolveAckTargetFromSessionKey", () => {
    it("extracts target and threadId from Slack channel+thread session key", () => {
      const key = "slack:default:channel:C123ABC:thread:1234567890.123456";
      const target = resolveAckTargetFromSessionKey(key);
      expect(target.target).toBeTruthy();
      expect(target.threadId).toBe("1234567890.123456");
    });

    it("extracts target from Slack DM session key", () => {
      const key = "slack:default:dm:U123ABC";
      const target = resolveAckTargetFromSessionKey(key);
      expect(target.target).toBeTruthy();
    });

    it("extracts target from Slack channel session key without thread", () => {
      const key = "slack:default:channel:C123ABC";
      const target = resolveAckTargetFromSessionKey(key);
      expect(target.target).toBeTruthy();
      expect(target.threadId).toBe("");
    });

    it("returns empty for non-IM session key", () => {
      const key = "agent:main:main";
      const target = resolveAckTargetFromSessionKey(key);
      expect(target.target).toBe("");
      expect(target.threadId).toBe("");
    });
  });

  describe("resolveRoutePhase", () => {
    it("returns delegate for delegate route", () => {
      const result = resolveRoutePhase({ route_decision: { route: "delegate" } });
      expect(result).toBe("delegate");
    });

    it("returns pre_route for delegate.single route (compound routes not auto-detected)", () => {
      const result = resolveRoutePhase({ route_decision: { route: "delegate.single" } });
      expect(result).toBe("pre_route");
    });

    it("returns reply for reply route", () => {
      const result = resolveRoutePhase({ route_decision: { route: "reply" } });
      expect(result).toBe("reply");
    });

    it("returns reply for direct route", () => {
      const result = resolveRoutePhase({ route_decision: { route: "direct" } });
      expect(result).toBe("reply");
    });

    it("returns observe for observe route", () => {
      const result = resolveRoutePhase({ route_decision: { route: "observe" } });
      expect(result).toBe("observe");
    });

    it("returns pre_route for empty decision", () => {
      const result = resolveRoutePhase({});
      expect(result).toBe("pre_route");
    });

    it("respects explicit routePhase option", () => {
      const result = resolveRoutePhase({}, { routePhase: "delegate" });
      expect(result).toBe("delegate");
    });

    it("does not infer ACK route from judge or router raw fields", () => {
      const result = resolveRoutePhase({
        _judge_route: "delegate",
        router_decision_v2: { request_kind: "delegated_task" },
      });

      expect(result).toBe("pre_route");
    });

    it("uses WorkContract projection for ACK route phase", () => {
      const result = resolveRoutePhase({
        _judge_route: "reply",
        router_decision_v2: { request_kind: "reply" },
        work_contract: { workContractId: "wc-1", route: "delegate" },
      });

      expect(result).toBe("delegate");
    });
  });

  describe("threadKeyFromSessionKey uses canonical threadKey", () => {
    it("produces threadKey with binding and thread for Slack channel+thread", () => {
      const key = "slack:default:channel:C123ABC:thread:1234567890.123456";
      const threadKey = threadKeyFn(key);
      expect(threadKey).toContain("slack");
      expect(threadKey).toContain("1234567890.123456");
    });

    it("falls back to binding key when no threadId", () => {
      const key = "slack:default:channel:C123ABC";
      const threadKey = threadKeyFn(key);
      expect(threadKey).toContain("slack");
    });

    it("falls back to stateKey for non-IM sessions", () => {
      const key = "agent:main:main";
      const threadKey = threadKeyFn(key, "fallback-state-key");
      expect(threadKey).toBe("fallback-state-key");
    });
  });
});

describe("ack-guard: decideAckAction runtime wiring", () => {
  it("attemptAckSend suppresses sends when decideAckAction returns suppress", async () => {
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "123" });
    updateAckTrackingState("suppress-state", {
      _ackTurnTs: Date.now() - 4_000,
      mainModelActive: true,
      delivered: true,
      reactionAckSupported: false,
      reactionAckEnabled: false,
    });

    const result = await sendAckDirect("x:slack:default:channel:C123ABC", "should not send", process.cwd(), {
      stateKey: "suppress-state",
      routePhase: "reply",
    });

    expect(result).toBe(false);
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("gates tier fire when decideAckAction returns no_action", async () => {
    vi.useFakeTimers();
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "123" });

    startAckGuard("x:slack:default:channel:C123ABC", process.cwd(), {
      stateKey: "tier-no-action",
      decision: { route_decision: { route: "reply" } },
      state: {
        mainModelActive: false,
        toolActive: false,
        reactionAckSupported: false,
        reactionAckEnabled: false,
      },
      ackTimingConfig: { tierDelaysMs: [1, 0, 0, 0] },
    });

    await vi.advanceTimersByTimeAsync(5);

    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("does not dedupe queued Slack messages that have different message ids", async () => {
    adapter.react.mockResolvedValue({ ok: true });
    const stateKey = `queued-reaction-state-${Date.now()}`;
    const state = {
      _ackTurnTs: Date.now() - 5_000,
      mainModelActive: true,
      toolActive: true,
      reactionAckSupported: true,
      reactionAckEnabled: true,
      channelTone: "chat",
    };

    const first = await maybeSendLatencyAck(
      { latency_ack: { required: true }, route_decision: { route: "reply" } },
      { session_key: "slack:default:dm:U123ABCDEF", message_id: "111.111111" },
      stateKey,
      state,
      {},
      {},
      "lookup",
    );
    const second = await maybeSendLatencyAck(
      { latency_ack: { required: true }, route_decision: { route: "reply" } },
      { session_key: "slack:default:dm:U123ABCDEF", message_id: "222.222222" },
      stateKey,
      state,
      {},
      {},
      "lookup",
    );

    expect(first?.sent).toBe(true);
    expect(second?.sent).toBe(true);
    expect(adapter.react).toHaveBeenCalledTimes(2);
    expect(adapter.react).toHaveBeenNthCalledWith(1, expect.objectContaining({ messageId: "111.111111" }));
    expect(adapter.react).toHaveBeenNthCalledWith(2, expect.objectContaining({ messageId: "222.222222" }));
  });

  it("sends reaction ACK when decideAckAction returns send_reaction_ack", async () => {
    adapter.react.mockResolvedValue({ ok: true });
    const stateKey = `reaction-state-${Date.now()}`;
    updateAckTrackingState(stateKey, {
      _ackTurnTs: Date.now() - 1_500,
      mainModelActive: true,
      reactionAckSupported: true,
      reactionAckEnabled: true,
      channelTone: "chat",
    });

    const result = await sendAckDirect("slack:default:channel:C123ABC", "", process.cwd(), {
      stateKey,
      routePhase: "reply",
      ownerTag: stateKey,
      replyToMessageId: "111.222",
    });

    expect(result).toBe(true);
    expect(adapter.react).toHaveBeenCalledWith(expect.objectContaining({ messageId: "111.222", emoji: "eyes" }));
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("sends route-independent neutral inbound reaction ACK from the original Slack anchor", async () => {
    adapter.resolveTarget.mockReturnValue({ target: "C123ABC" });
    adapter.react.mockResolvedValue({ ok: true });
    const stateKey = `neutral-reaction-state-${Date.now()}`;

    const result = await sendNeutralInboundAck({
      sessionKey: "slack:default:channel:C123ABC",
      stateKey,
      replyToMessageId: "1777737951.706329",
      state: {
        reactionAckSupported: true,
        reactionAckEnabled: true,
        reactionAckEmoji: "eyes",
      },
      cwd: process.cwd(),
    });

    expect(result).toEqual({ sent: true, reason: "reaction_ack_sent", mode: "reaction" });
    expect(adapter.react).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "1777737951.706329",
      emoji: "eyes",
    }));
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("dedupes neutral inbound ACKs per Slack target and original message anchor", async () => {
    adapter.react.mockResolvedValue({ ok: true });
    const baseState = {
      reactionAckSupported: true,
      reactionAckEnabled: true,
      reactionAckEmoji: "eyes",
    };

    const first = await sendNeutralInboundAck({
      sessionKey: "slack:default:channel:C123ABC",
      stateKey: `neutral-dedupe-a-${Date.now()}`,
      replyToMessageId: "1777737951.706329",
      state: baseState,
      cwd: process.cwd(),
    });
    const duplicate = await sendNeutralInboundAck({
      sessionKey: "slack:default:channel:C123ABC:thread:1777737951.706329",
      stateKey: `neutral-dedupe-b-${Date.now()}`,
      replyToMessageId: "1777737951.706329",
      state: baseState,
      cwd: process.cwd(),
    });
    const otherChannel = await sendNeutralInboundAck({
      sessionKey: "slack:default:channel:C999XYZ",
      stateKey: `neutral-dedupe-c-${Date.now()}`,
      replyToMessageId: "1777737951.706329",
      state: baseState,
      cwd: process.cwd(),
    });

    expect(first.sent).toBe(true);
    expect(duplicate).toEqual({ sent: false, reason: "skipped_duplicate", mode: "not_sent" });
    expect(otherChannel.sent).toBe(true);
    expect(adapter.react).toHaveBeenCalledTimes(2);
  });

  it("does not immediately fall back to neutral inbound text when reaction ACK fails", async () => {
    adapter.resolveTarget.mockReturnValue({ target: "C123ABC" });
    adapter.react.mockResolvedValue({ ok: false, error: "operation_aborted" });
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "1777737951.706329" });
    const stateKey = `neutral-reaction-fallback-state-${Date.now()}`;

    const result = await sendNeutralInboundAck({
      sessionKey: "slack:default:channel:C123ABC",
      stateKey,
      replyToMessageId: "1777737951.706329",
      state: {
        reactionAckSupported: true,
        reactionAckEnabled: true,
        reactionAckEmoji: "eyes",
      },
      cwd: process.cwd(),
    });

    expect(result).toEqual({
      sent: false,
      reason: "reaction_ack_failed_no_text_fallback",
      mode: "not_sent",
      error: "operation_aborted",
    });
    expect(adapter.react).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "1777737951.706329",
      emoji: "eyes",
    }));
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("times out a hung neutral inbound reaction without immediate text fallback", async () => {
    vi.useFakeTimers();
    adapter.resolveTarget.mockReturnValue({ target: "C123ABC" });
    adapter.react.mockImplementation(() => new Promise(() => {}));
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "1777737951.706329" });
    const stateKey = `neutral-reaction-hung-fallback-state-${Date.now()}`;

    const pending = sendNeutralInboundAck({
      sessionKey: "slack:default:channel:C123ABC",
      stateKey,
      replyToMessageId: "1777737951.706329",
      state: {
        reactionAckSupported: true,
        reactionAckEnabled: true,
        reactionAckEmoji: "eyes",
      },
      cwd: process.cwd(),
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(NEUTRAL_REACTION_ACK_FALLBACK_MS + 1);

    await expect(pending).resolves.toEqual({
      sent: false,
      reason: "reaction_ack_failed_no_text_fallback",
      mode: "not_sent",
      error: `reaction_ack_timeout_after_${NEUTRAL_REACTION_ACK_FALLBACK_MS}ms`,
    });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("sends neutral inbound text ACK when reaction is not configured", async () => {
    adapter.resolveTarget.mockReturnValue({ target: "C123ABC" });
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "1777737951.706329" });
    const stateKey = `neutral-text-state-${Date.now()}`;

    const result = await sendNeutralInboundAck({
      sessionKey: "slack:default:channel:C123ABC",
      stateKey,
      replyToMessageId: "1777737951.706329",
      state: {
        reactionAckSupported: false,
        reactionAckEnabled: false,
      },
      cwd: process.cwd(),
    });

    expect(result).toEqual({ sent: true, reason: "channel_message_sent", mode: "text" });
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      message: NEUTRAL_INBOUND_ACK_TEXT,
      replyToMessageId: "1777737951.706329",
    }));
  });

  it("fails closed when Slack neutral inbound ACK has no original thread target", async () => {
    const result = await sendNeutralInboundAck({
      sessionKey: "slack:default:channel:C123ABC",
      stateKey: `neutral-missing-target-${Date.now()}`,
      state: {
        reactionAckSupported: true,
        reactionAckEnabled: true,
      },
      cwd: process.cwd(),
    });

    expect(result).toEqual({ sent: false, reason: "no_valid_thread_target", mode: "not_sent" });
    expect(adapter.react).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("does not fall back to text when reaction ACK0 fails", async () => {
    adapter.react.mockResolvedValue({ ok: false, error: "operation_aborted" });
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "111.222" });
    const stateKey = `reaction-fallback-state-${Date.now()}`;
    updateAckTrackingState(stateKey, {
      _ackTurnTs: Date.now() - 1_500,
      mainModelActive: true,
      reactionAckSupported: true,
      reactionAckEnabled: true,
      channelTone: "chat",
    });

    const result = await sendAckDirect("slack:default:channel:C123ABC", "", process.cwd(), {
      stateKey,
      routePhase: "reply",
      ownerTag: stateKey,
      replyToMessageId: "111.222",
    });

    expect(result).toBe(false);
    expect(adapter.react).toHaveBeenCalledOnce();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("sends text ACK0 when reaction not configured", async () => {
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "123" });
    const stateKey = "text-ack0-no-reaction";
    updateAckTrackingState(stateKey, {
      _ackTurnTs: Date.now() - 4_000,
      mainModelActive: true,
      reactionAckSupported: false,
      reactionAckEnabled: false,
      channelTone: "unknown",
    });

    const result = await sendAckDirect("slack:default:channel:C123ABC", "legacy text", process.cwd(), {
      stateKey,
      routePhase: "reply",
      ownerTag: stateKey,
      replyToMessageId: "111.222",
    });

    expect(result).toBe(true);
    expect(adapter.send).toHaveBeenCalled();
  });

  it("first token arrival cancels pending ACK", () => {
    vi.useFakeTimers();
    startAckGuard("x:slack:default:channel:C123ABC", process.cwd(), {
      stateKey: "first-token-state",
      decision: { route_decision: { route: "reply" } },
      ackTimingConfig: { tierDelaysMs: [1_000, 0, 0, 0] },
    });

    expect(ackTimerStateForKey("first-token-state")).not.toBeNull();
    markMainModelFirstToken("first-token-state");

    expect(ackTimerStateForKey("first-token-state")).toBeNull();
    expect(buildDecisionPacket("first-token-state", {}, "reply").firstTokenSeen).toBe(true);
  });

  it("maybeSendLatencyAck applies decideAckAction as authoritative final gate", async () => {
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "123" });

    const result = await maybeSendLatencyAck(
      { latency_ack: { required: true }, route_decision: { route: "reply" } },
      { session_key: "x:slack:default:channel:C123ABC", message_id: "111.222" },
      "latency-gated-state",
      { delivered: true, mainModelActive: true, reactionAckSupported: false, reactionAckEnabled: false },
      {},
      {},
      "lookup",
    );

    expect(result).toBeNull();
    expect(adapter.send).not.toHaveBeenCalled();
  });
});

describe("Phase B acceptance: ACK reads WorkContract/status/native/delivery not _judge_*", () => {
  it("resolveRoutePhase ignores _judge_route field", () => {
    const result = resolveRoutePhase({ _judge_route: "delegate" });

    expect(result).toBe("pre_route");
  });

  it("resolveRoutePhase uses WorkContract route", () => {
    const result = resolveRoutePhase({ work_contract: { route: "delegate" } });

    expect(result).toBe("delegate");
  });

  it("resolveRoutePhase ignores router_decision_v2", () => {
    const result = resolveRoutePhase({ router_decision_v2: { request_kind: "delegated_task" } });

    expect(result).toBe("pre_route");
  });

  it("ACK decision packet does not include judge internals", () => {
    const packet = buildDecisionPacket("phase-b-decision-packet", {
      _judge_route: "delegate",
      _judge_reason: "internal only",
      router_decision_v2: { request_kind: "delegated_task" },
      delivered: true,
      inboundMessageTs: "111.222",
    }, "reply");

    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain("_judge_");
    expect(serialized).not.toContain("router_decision_v2");
    expect(packet.route).toBe("reply");
    expect(packet.delivered).toBe(true);
  });
});
