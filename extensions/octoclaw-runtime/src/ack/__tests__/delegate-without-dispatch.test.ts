import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  buildDelegateWithoutDispatchPacket,
  projectDelegateWithoutDispatchText,
  resetDelegateWithoutDispatchState,
  sendDelegateWithoutDispatchNotice,
} from "../ack-delegate-without-dispatch.js";

type RunCommandSpy = MockInstance<typeof import("../../resolve/env.js").runCommand>;
type ReplaySpy = MockInstance<typeof import("../../replay/replay.js").recordPolicyReplay>;

describe("delegate without dispatch notice", () => {
  beforeEach(() => {
    resetDelegateWithoutDispatchState();
    vi.restoreAllMocks();
  });

  it("builds packet with real RouteSeal requestId fallback", () => {
    const packet = buildDelegateWithoutDispatchPacket(decision(), {}, "slack:channel:C1");

    expect(packet).toEqual(expect.objectContaining({
      routeCommitId: "wc-123",
      routeSealId: "req-seal-456",
      turnId: "turn-789",
      route: "delegate",
    }));
  });

  it("projects zh task correction text without running language", () => {
    const packet = buildDelegateWithoutDispatchPacket(decision(), { decision: decision() }, "slack:channel:C1")!;
    const text = projectDelegateWithoutDispatchText(packet, { decision: decision() });

    expect(text).toMatch(/还没派发成功/);
    expect(text).not.toMatch(/running|started|completed|运行|已启动|已完成|处理中/i);
  });

  it("projects observe lookup correction text", () => {
    const d = decision({
      route_decision: { route: "delegate", route_source: "judge", judge_role: "observer_probe" },
      executionProfile: "observer",
    });
    const state = { decision: d, conversationIntentClass: "fresh_live_lookup" };
    const packet = buildDelegateWithoutDispatchPacket(d, state, "slack:channel:C1")!;

    expect(projectDelegateWithoutDispatchText(packet, state)).toMatch(/还没拿到结果/);
  });

  it("sends notice and records replay on happy path", async () => {
    const { runCommandSpy, replaySpy } = await mockDelivery();

    const result = await sendDelegateWithoutDispatchNotice(noticeParams());

    expect(result).toEqual(expect.objectContaining({
      sent: true,
      notificationDeliveryState: "sent",
    }));
    expect(runCommandSpy).toHaveBeenCalledOnce();

    const replayPayload = findReplayPayload(replaySpy);
    expect(replayPayload).toEqual(expect.objectContaining({
      delegate_without_dispatch: true,
      dispatchExecuted: false,
      spawnExecuted: false,
      notificationDeliveryState: "sent",
    }));
  });

  it("skips when route data is missing", async () => {
    await mockDelivery();

    const result = await sendDelegateWithoutDispatchNotice(noticeParams({
      decision: decision({ work_contract: {}, routeSeal: { turnId: "turn-789" } }),
    }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("missing_route_commit_data");
  });

  it("dedupes same state turn work contract", async () => {
    await mockDelivery();
    const params = noticeParams();

    const first = await sendDelegateWithoutDispatchNotice(params);
    const second = await sendDelegateWithoutDispatchNotice(params);

    expect(first.sent).toBe(true);
    expect(second).toEqual(expect.objectContaining({
      skipped: true,
      reason: "skipped_duplicate",
    }));
  });

  it("skips unresolvable targets", async () => {
    await mockDelivery();

    const result = await sendDelegateWithoutDispatchNotice(noticeParams({ sessionKey: "bogus-no-colon" }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("target_resolution_failed");
  });



  it("sends delivery without a current reply or thread anchor", async () => {
    const { runCommandSpy } = await mockDelivery();

    const result = await sendDelegateWithoutDispatchNotice(noticeParams({
      sessionKey: "slack:direct:U1",
      state: { decision: decision() },
      replyToMessageId: "",
    }));

    expect(result).toEqual(expect.objectContaining({
      sent: true,
      skipped: false,
      notificationDeliveryState: "sent",
    }));
    expect(runCommandSpy).toHaveBeenCalledOnce();
  });

  it("allows delivery when the session key itself carries a thread anchor", async () => {
    const { runCommandSpy } = await mockDelivery();

    const result = await sendDelegateWithoutDispatchNotice(noticeParams({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
      state: { decision: decision() },
      replyToMessageId: "",
    }));

    expect(result.sent).toBe(true);
    expect(runCommandSpy).toHaveBeenCalledOnce();
  });

  it("replay ackMessage has no running language", async () => {
    const { replaySpy } = await mockDelivery();

    await sendDelegateWithoutDispatchNotice(noticeParams());

    const ackMessage = String(findReplayPayload(replaySpy).ackMessage ?? "");
    expect(ackMessage).not.toMatch(/running|started|completed|运行|已启动|已完成|处理中/i);
    expect(ackMessage).toMatch(/还没派发成功/);
  });

  it("uses provided sessionKey as delivery target", async () => {
    const { runCommandSpy, replaySpy } = await mockDelivery();

    await sendDelegateWithoutDispatchNotice(noticeParams({
      sessionKey: "slack:channel:C1:thread:1700000000.000100",
    }));

    const payload = findReplayPayload(replaySpy);
    expect(payload.deliverySessionKey).toBe("slack:channel:C1:thread:1700000000.000100");
    expect(runCommandSpy).toHaveBeenCalledOnce();
  });

  it("records delivery-specific replay event distinct from agent_end event", async () => {
    const { replaySpy } = await mockDelivery();

    await sendDelegateWithoutDispatchNotice(noticeParams());

    const noticeCalls = replaySpy.mock.calls.filter((entry) => entry[0] === "delegate_without_dispatch_notice");
    const agentEndCalls = replaySpy.mock.calls.filter((entry) => entry[0] === "delegate_without_dispatch");
    expect(noticeCalls).toHaveLength(1);
    expect(agentEndCalls).toHaveLength(0);
  });
});

async function mockDelivery(): Promise<{ runCommandSpy: RunCommandSpy; replaySpy: ReplaySpy }> {
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

  return { runCommandSpy, replaySpy };
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route_decision: { route: "delegate", route_source: "judge" },
    work_contract: { workContractId: "wc-123", turnId: "turn-789" },
    routeSeal: {
      requestId: "req-seal-456",
      turnId: "turn-789",
      threadBindingKey: "thread-binding",
      route: "delegate",
      source: "local_judge",
      reasonCodes: ["local_judge"],
      createdAt: new Date().toISOString(),
      inputHash: "",
      stateGeneration: 0,
      schemaVersion: "octoclaw.route_seal.v1",
    },
    ...overrides,
  };
}

function noticeParams(overrides: Partial<Parameters<typeof sendDelegateWithoutDispatchNotice>[0]> = {}): Parameters<typeof sendDelegateWithoutDispatchNotice>[0] {
  const d = decision();
  return {
    sessionKey: "slack:channel:C1:thread:1700000000.000100",
    stateKey: "state-1",
    decision: d,
    state: { decision: d, inboundMessageTs: "1700000000.000100" },
    replyToMessageId: "1700000000.000100",
    ...overrides,
  };
}

function findReplayPayload(replaySpy: ReplaySpy): Record<string, unknown> {
  const call = replaySpy.mock.calls.find((entry) => entry[0] === "delegate_without_dispatch_notice");
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}
