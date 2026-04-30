import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRouteCommitAckKey,
  buildRouteCommitAckPacket,
  checkAndSetRouteCommitAck,
  projectRouteCommitAckText,
  resetRouteCommitAckState,
  sendRouteCommitAck,
  type RouteCommitAckPacket,
} from "../ack-route-commit.js";

let useMockAdapter = false;

const imAdapter = {
  canHandle: vi.fn(() => true),
  resolveTarget: vi.fn(() => ({ target: "C1" })),
  send: vi.fn(),
  react: vi.fn(),
};

vi.mock("../../im/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../im/index.js")>();
  return {
    ...actual,
    getAdapterForSession: (sessionKey: string) => useMockAdapter ? imAdapter : actual.getAdapterForSession(sessionKey),
  };
});

function packet(overrides: Partial<RouteCommitAckPacket> = {}): RouteCommitAckPacket {
  return {
    routeCommitId: "wc-123",
    route: "delegate",
    routeSource: "judge",
    routeSealId: "rs-456",
    turnId: "turn-789",
    sessionKey: "slack:target:T1:thread:1700000000.000100",
    hasValidThreadTarget: true,
    channelTone: "chat",
    taskClass: "coding",
    language: "zh",
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route_decision: { route: "delegate", route_source: "judge" },
    work_contract: { workContractId: "wc-123", turnId: "turn-789" },
    routeSeal: { requestId: "req-seal-456", turnId: "turn-789", threadBindingKey: "thread-binding", route: "delegate", source: "local_judge", reasonCodes: ["local_judge"], createdAt: new Date().toISOString(), inputHash: "", stateGeneration: 0, schemaVersion: "octoclaw.route_seal.v1" },
    ...overrides,
  };
}

describe("route commit ACK", () => {
  beforeEach(() => {
    resetRouteCommitAckState();
    vi.clearAllMocks();
    useMockAdapter = false;
    imAdapter.canHandle.mockReturnValue(true);
    imAdapter.resolveTarget.mockReturnValue({ target: "C1" });
    imAdapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "1700000000.000100" });
  });

  it("projects truthful zh delegate text without execution claims", () => {
    const result = projectRouteCommitAckText(packet({ route: "delegate", language: "zh" }));

    expect(result.text).not.toMatch(/运行|已启动|完成/);
    expect(result.text).toMatch(/委派|派发|状态/);
    expect(result.truthful).toBe(true);
  });

  it("projects truthful en delegate text without execution claims", () => {
    const result = projectRouteCommitAckText(packet({ route: "delegate", language: "en" }));

    expect(result.text.toLowerCase()).not.toMatch(/running|started|completed/);
    expect(result.text.toLowerCase()).toMatch(/delegation|dispatch|status/);
    expect(result.truthful).toBe(true);
  });

  it("projects zh status text without dispatch language", () => {
    const result = projectRouteCommitAckText(packet({ route: "status", language: "zh" }));

    expect(result.text).toMatch(/状态|读取/);
    expect(result.text).not.toMatch(/派发|dispatch/);
  });

  it("projects zh reply text", () => {
    const result = projectRouteCommitAckText(packet({ route: "reply", language: "zh" }));

    expect(result.text).toMatch(/收到|处理/);
  });

  it("builds route commit ACK key format", () => {
    const key = buildRouteCommitAckKey({
      sessionKey: "session-1",
      threadBindingKey: "thread-1",
      turnId: "turn-1",
      routeCommitId: "commit-1",
    });
    const otherKey = buildRouteCommitAckKey({
      sessionKey: "session-1",
      threadBindingKey: "thread-1",
      turnId: "turn-2",
      routeCommitId: "commit-1",
    });

    expect(key).toBe("route_commit_ack:session-1:thread-1:turn-1:commit-1");
    expect(otherKey).not.toBe(key);
  });

  it("builds route commit ACK packet from decision", () => {
    const result = buildRouteCommitAckPacket(decision(), "session-1", true);

    expect(result?.routeCommitId).toBe("wc-123");
    expect(result?.route).toBe("delegate");
    expect(result?.routeSealId).toBe("req-seal-456");
  });

  it("returns null when route commit packet fields are missing", () => {
    const result = buildRouteCommitAckPacket(
      decision({ work_contract: undefined }),
      "session-1",
      true,
    );

    expect(result).toBeNull();
  });

  it("maps observe route to status", () => {
    const result = buildRouteCommitAckPacket(
      decision({ route_decision: { route: "observe" } }),
      "session-1",
      true,
    );

    expect(result?.route).toBe("status");
  });

  it("dedupes route commit ACK claims", () => {
    const ackKey = "route_commit_ack:session-1:thread-1:turn-1:commit-1";

    expect(checkAndSetRouteCommitAck(ackKey, "route_commit_ack")).toEqual({ allowed: true });
    expect(checkAndSetRouteCommitAck(ackKey, "route_commit_ack")).toEqual({
      allowed: false,
      existingOwner: "route_commit_ack",
    });

    resetRouteCommitAckState();
    expect(checkAndSetRouteCommitAck(ackKey, "route_commit_ack")).toEqual({ allowed: true });
  });

  it("skips send when route data is missing with replay event", async () => {
    const replaySpy = vi.spyOn(
      await import("../../replay/replay.js"),
      "recordPolicyReplay",
    );

    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      stateKey: "state-1",
      decision: { route_decision: { route: "delegate" } },
      state: {},
      replyToMessageId: "1700000000.000100",
    });

    expect(result.skipped).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("missing_route_commit_data");
    expect(result.ack_target_resolution_state).toBe("missing_route_commit_data");
    expect(result.ack_delivery_state).toBe("not_attempted");

    expect(replaySpy).toHaveBeenCalledWith(
      "route_commit_ack",
      expect.objectContaining({
        ack_delivery_state: "not_attempted",
        reason: "missing_route_commit_data",
      }),
      undefined,
    );

    replaySpy.mockRestore();
  });

  it("skips unresolvable session target even with message id", async () => {
    const replaySpy = vi.spyOn(
      await import("../../replay/replay.js"),
      "recordPolicyReplay",
    );

    const result = await sendRouteCommitAck({
      sessionKey: "bogus-no-colon",
      stateKey: "state-1",
      decision: decision(),
      state: {},
      replyToMessageId: "1700000000.000100",
    });

    expect(result.skipped).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("target_resolution_failed");
    expect(result.ack_target_resolution_state).toBe("target_resolution_failed");
    expect(result.ackKey).toContain("wc-123");

    expect(replaySpy).toHaveBeenCalledWith(
      "route_commit_ack",
      expect.objectContaining({
        ackKey: expect.stringContaining("wc-123"),
        routeCommitId: "wc-123",
      }),
      undefined,
    );

    replaySpy.mockRestore();
  });

  it("sends top-level when canonical target resolves but no message anchor", async () => {
    const envModule = await import("../../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      timedOut: false,
    });
    const replaySpy = vi.spyOn(
      await import("../../replay/replay.js"),
      "recordPolicyReplay",
    );

    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1",
      stateKey: "state-1",
      decision: decision(),
      state: {},
    });

    expect(result.skipped).toBe(false);
    expect(result.sent).toBe(true);
    expect(result.reason).toBe("channel_message_sent");
    expect(result.ack_target_resolution_state).toBe("resolved");
    expect(result.ackKey).toContain("wc-123");
    expect(runCommandSpy).toHaveBeenCalledWith(
      "openclaw",
      expect.not.arrayContaining(["--reply-to"]),
      expect.any(Object),
    );

    expect(replaySpy).toHaveBeenCalledWith(
      "route_commit_ack",
      expect.objectContaining({
        ackKey: expect.stringContaining("wc-123"),
        routeCommitId: "wc-123",
        ackSent: true,
      }),
      undefined,
    );

    runCommandSpy.mockRestore();
    replaySpy.mockRestore();
  });

  it("no-target skip does not consume dedupe key", async () => {
    const params = {
      sessionKey: "bogus-no-colon",
      stateKey: "state-1",
      decision: decision(),
      state: {},
      replyToMessageId: "1700000000.000100",
    };

    const first = await sendRouteCommitAck(params);
    expect(first.skipped).toBe(true);
    expect(first.reason).toBe("target_resolution_failed");
    expect(first.ackKey).toContain("wc-123");

    const second = await sendRouteCommitAck(params);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("target_resolution_failed");

    expect(checkAndSetRouteCommitAck(first.ackKey, "route_commit_ack").allowed).toBe(true);
  });

  it("skips duplicate sends with replay event", async () => {
    const replaySpy = vi.spyOn(
      await import("../../replay/replay.js"),
      "recordPolicyReplay",
    );

    const sessionKey = "slack:channel:C1";
    const threadBindingKey = "thread-binding";
    const ackKey = buildRouteCommitAckKey({
      sessionKey,
      threadBindingKey,
      turnId: "turn-789",
      routeCommitId: "wc-123",
    });

    checkAndSetRouteCommitAck(ackKey, "route_commit_ack");

    const result = await sendRouteCommitAck({
      sessionKey,
      stateKey: "state-1",
      decision: decision(),
      state: {},
      replyToMessageId: "1700000000.000100",
    });

    expect(result.skipped).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("duplicate");
    expect(result.ack_target_resolution_state).toBe("skipped_duplicate");

    expect(replaySpy).toHaveBeenCalledWith(
      "route_commit_ack",
      expect.objectContaining({
        ack_target_resolution_state: "skipped_duplicate",
        reason: "duplicate",
      }),
      undefined,
    );

    replaySpy.mockRestore();
  });

  it("skips reply route when final output already visible", async () => {
    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      stateKey: "state-1",
      decision: decision({ route_decision: { route: "reply" } }),
      state: { delivered: true },
      replyToMessageId: "1700000000.000100",
    });

    expect(result.skipped).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("reply_already_visible");
    expect(result.ack_target_resolution_state).toBe("suppressed_reply_visible");
  });

  it("skips reply route when formal reply visible", async () => {
    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      stateKey: "state-1",
      decision: decision({ route_decision: { route: "reply" } }),
      state: { formalReplyVisible: true },
      replyToMessageId: "1700000000.000100",
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("reply_already_visible");
  });

  it("skips generic reply route ACK when reaction ACK is configured", async () => {
    const envModule = await import("../../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      timedOut: false,
    });
    const replaySpy = vi.spyOn(
      await import("../../replay/replay.js"),
      "recordPolicyReplay",
    );

    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      stateKey: "state-1",
      decision: decision({ route_decision: { route: "reply" } }),
      state: { reactionAckEnabled: true, reactionAckEmoji: "eyes" },
      replyToMessageId: "1700000000.000100",
    });

    expect(result).toMatchObject({
      sent: false,
      skipped: true,
      reason: "reaction_ack_configured",
      ack_target_resolution_state: "suppressed_reaction_ack_configured",
      ack_delivery_state: "skipped",
    });
    expect(runCommandSpy).not.toHaveBeenCalled();
    expect(replaySpy).toHaveBeenCalledWith(
      "route_commit_ack",
      expect.objectContaining({
        route: "reply",
        reason: "reaction_ack_configured",
        ackSent: false,
      }),
      undefined,
    );

    runCommandSpy.mockRestore();
    replaySpy.mockRestore();
  });

  it("uses reaction ACK for delegate route commit ACK when configured", async () => {
    const envModule = await import("../../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      timedOut: false,
    });
    useMockAdapter = true;
    imAdapter.react.mockResolvedValue({ ok: true });

    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      stateKey: "state-1",
      decision: decision(),
      state: { reactionAckEnabled: true, reactionAckEmoji: "eyes" },
      replyToMessageId: "1700000000.000100",
    });

    expect(result.sent).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.reason).toBe("reaction_ack_sent");
    expect(imAdapter.react).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "1700000000.000100",
      emoji: "eyes",
    }));
    expect(runCommandSpy).not.toHaveBeenCalled();

    runCommandSpy.mockRestore();
  });

  it("falls back to text when reaction ACK configured and reaction fails", async () => {
    const envModule = await import("../../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      timedOut: false,
    });
    useMockAdapter = true;
    imAdapter.react.mockResolvedValue({ ok: false, error: "missing_scope" });

    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      stateKey: "state-1",
      decision: decision(),
      state: { reactionAckEnabled: true, reactionAckEmoji: "eyes" },
      replyToMessageId: "1700000000.000100",
    });

    expect(result.sent).toBe(true);
    expect(result.reason).toBe("reaction_ack_failed_text_fallback");
    expect(imAdapter.react).toHaveBeenCalledOnce();
    expect(imAdapter.send).toHaveBeenCalledWith(expect.objectContaining({
      message: "已判定为委派任务，正在准备派发。稍后可查看状态。",
      replyToMessageId: "1700000000.000100",
    }));
    expect(runCommandSpy).not.toHaveBeenCalled();

    runCommandSpy.mockRestore();
  });

  it("allows delegate route even when final output visible", async () => {
    const result = await sendRouteCommitAck({
      sessionKey: "bogus-no-colon",
      stateKey: "state-1",
      decision: decision(),
      state: { delivered: true },
      replyToMessageId: "1700000000.000100",
    });

    expect(result.reason).not.toBe("reply_already_visible");
    expect(result.reason).toBe("target_resolution_failed");
  });

  it("sends delegated route commit ACK and records telemetry", async () => {
    const envModule = await import("../../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      timedOut: false,
    });

    const replaySpy = vi.spyOn(
      await import("../../replay/replay.js"),
      "recordPolicyReplay",
    );

    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      stateKey: "state-1",
      decision: decision(),
      state: {},
      replyToMessageId: "1700000000.000100",
    });

    expect(result.sent).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.reason).toBe("channel_message_sent");
    expect(result.routeCommitId).toBe("wc-123");
    expect(result.ackKey).toContain("wc-123");
    expect(result.ack_target_resolution_state).toBe("resolved");
    expect(result.ack_delivery_state).toBe("sent");

    expect(runCommandSpy).toHaveBeenCalledOnce();

    expect(replaySpy).toHaveBeenCalledWith(
      "route_commit_ack",
      expect.objectContaining({
        routeCommitId: "wc-123",
        routeSealId: "req-seal-456",
        route: "delegate",
        ackKey: expect.stringContaining("wc-123"),
        ack_target_resolution_state: "resolved",
        ack_delivery_state: "sent",
        ackSent: true,
        ackKind: "route_commit_ack",
        ackMode: "channel_message",
      }),
      undefined,
    );

    const replayCall = replaySpy.mock.calls.find(
      (call) => call[0] === "route_commit_ack",
    );
    const replayPayload = replayCall![1] as Record<string, unknown>;
    const ackMessage = String(replayPayload.ackMessage ?? "");
    expect(ackMessage).not.toMatch(/running|started|completed/i);
    expect(ackMessage).toMatch(/委派|派发|状态/);

    runCommandSpy.mockRestore();
    replaySpy.mockRestore();
  });

  it("skips generic reply ACK for status surface replies", async () => {
    const envModule = await import("../../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      timedOut: false,
    });
    const replaySpy = vi.spyOn(
      await import("../../replay/replay.js"),
      "recordPolicyReplay",
    );

    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      stateKey: "state-1",
      decision: decision({
        route_decision: { route: "reply", route_source: "rule", task_class: "main_direct" },
        state_grounding: { required: true, source: "control_plane_status" },
        tool_policy: { allowed_control_tools: ["octoclaw_status", "octoclaw_task_action"] },
      }),
      state: {},
      replyToMessageId: "1700000000.000100",
    });

    expect(result).toMatchObject({
      sent: false,
      skipped: true,
      reason: "status_surface_reply_no_route_ack",
      ack_target_resolution_state: "suppressed_status_surface",
      ack_delivery_state: "skipped",
    });
    expect(runCommandSpy).not.toHaveBeenCalled();
    expect(replaySpy).toHaveBeenCalledWith(
      "route_commit_ack",
      expect.objectContaining({
        route: "reply",
        reason: "status_surface_reply_no_route_ack",
        ackSent: false,
      }),
      undefined,
    );

    runCommandSpy.mockRestore();
    replaySpy.mockRestore();
  });

  it("sends ACK for Slack channel session key without thread when reply anchor is provided", async () => {
    const envModule = await import("../../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      timedOut: false,
    });

    const result = await sendRouteCommitAck({
      sessionKey: "slack:channel:C1",
      stateKey: "state-1",
      decision: decision(),
      state: {},
      replyToMessageId: "1700000000.000100",
    });

    expect(result.sent).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.ack_target_resolution_state).toBe("resolved");
    expect(runCommandSpy).toHaveBeenCalledWith(
      "openclaw",
      expect.arrayContaining(["--reply-to", "1700000000.000100"]),
      expect.any(Object),
    );

    runCommandSpy.mockRestore();
  });

  it("resolves agent-prefixed Slack channel session key with state message id", async () => {
    const envModule = await import("../../resolve/env.js");
    const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      timedOut: false,
    });

    const result = await sendRouteCommitAck({
      sessionKey: "agent:main:slack:channel:C1",
      stateKey: "state-1",
      decision: decision(),
      state: { message_id: "1700000000.000100" },
    });

    expect(result.sent).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.ack_target_resolution_state).toBe("resolved");
    expect(runCommandSpy).toHaveBeenCalledWith(
      "openclaw",
      expect.arrayContaining(["--reply-to", "1700000000.000100"]),
      expect.any(Object),
    );

    runCommandSpy.mockRestore();
  });
});
