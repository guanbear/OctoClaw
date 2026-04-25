import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDecisionPacket,
  markMainModelFirstToken,
  maybeSendLatencyAck,
  resolveAckTargetFromSessionKey,
  resolveRoutePhase,
  sendAckDirect,
  startAckGuard,
  threadKeyFromSessionKey as threadKeyFn,
  updateAckTrackingState,
} from "./ack-guard.js";
import { ackTimerStateForKey, cancelAllAckTimers } from "./ack-timing.js";

const adapter = {
  send: vi.fn(),
  react: vi.fn(),
  resolveTarget: vi.fn(),
};

vi.mock("../im/index.js", () => ({
  getAdapterForSession: () => adapter,
}));

afterEach(() => {
  vi.useRealTimers();
  cancelAllAckTimers();
  vi.clearAllMocks();
  adapter.resolveTarget.mockReturnValue({ target: "C123ABC" });
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

  it("uses template registry for text ACK0 instead of legacy ackStageText", async () => {
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "123" });
    const stateKey = `text-template-state-${Date.now()}`;
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
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^.{1,20}$/) }));
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
