import { describe, expect, it, vi } from "vitest";

import { runReplyDirectToolGate } from "./reply-direct-tool-runner.js";

describe("ReplyDirectToolRunner", () => {
  it("observes reply direct tools and records latency/direct-tool side effects", async () => {
    let directToolsState: unknown;
    const deps = {
      now: () => 2000,
      escalateBudgetedMainForTool: vi.fn(),
      updateBudgetedMainForContext: vi.fn(() => ({ budget: "updated" })),
      scheduleBudgetedMainTimeout: vi.fn(),
      updateAckTrackingState: vi.fn(),
      maybeSendLatencyAck: vi.fn(async () => ({ sent: true, reason: "latency_ack_sent" })),
      updatePolicyState: vi.fn((_stateKey: string, updater: (current: { directToolsSeen?: string[] }) => unknown) => {
        directToolsState = updater({ directToolsSeen: ["previous_tool"] });
      }),
      recordAckReplay: vi.fn(async () => {}),
      recordPolicyReplay: vi.fn(async () => {}),
    };

    const result = await runReplyDirectToolGate({
      toolName: "exec",
      toolParams: { cmd: "rg NativeSpawnGate extensions/octoclaw-runtime/src" },
      decision: {
        route_decision: {
          route: "reply",
          decision_bucket: "budgeted_main_then_delegate",
          task_class: "main_direct",
          protected_lane: "reply",
        },
        latency_ack: { required: true },
      },
      state: {},
      stateKey: "session-key",
      ctx: { sessionId: "runtime-session" },
      metadata: { message_id: "1700000000.000100" },
      logger: {},
      budgetedMainHandledTool: false,
    }, deps);

    expect(result).toMatchObject({ kind: "handled", state: { budget: "updated" } });
    expect(deps.updateBudgetedMainForContext).toHaveBeenCalledOnce();
    expect(deps.scheduleBudgetedMainTimeout).toHaveBeenCalledOnce();
    expect(deps.updateAckTrackingState).toHaveBeenCalledWith("session-key", { tool_active: true });
    expect(deps.maybeSendLatencyAck).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ message_id: "1700000000.000100" }),
      "session-key",
      expect.objectContaining({ budget: "updated" }),
      expect.objectContaining({ sessionId: "runtime-session" }),
      {},
      "exec",
    );
    expect(directToolsState).toMatchObject({ directToolsSeen: ["previous_tool", "exec"] });
    expect(deps.recordAckReplay).toHaveBeenCalledWith(expect.objectContaining({
      kind: "latency",
      phase: "direct_tool",
      toolName: "exec",
    }));
    expect(deps.recordPolicyReplay).toHaveBeenCalledWith(
      "direct_tool_called",
      expect.objectContaining({ sessionKey: "session-key", toolName: "exec", latencyAckSent: true }),
      {},
      expect.any(Object),
    );
    expect(deps.recordPolicyReplay).toHaveBeenCalledWith(
      "tool_used",
      expect.objectContaining({ sessionKey: "session-key", toolName: "exec", latencyAckReason: "latency_ack_sent" }),
      {},
      expect.any(Object),
    );
  });
});
