import { describe, it, expect } from "vitest";
import { buildTurnExecutionReceipt } from "./replay-logger.js";

describe("TurnExecutionReceipt", () => {
  it("builds receipt for delegated turn", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: true,
      delegateTaskContext: { delegateTaskId: "task-123", taskStatus: "completed" },
      decision: {
        route_decision: { route: "delegate", worker_pool: "octoclaw-worker" },
      },
      toolsUsed: [],
    };
    const receipt = buildTurnExecutionReceipt(state as any, 5000);
    expect(receipt.route).toBe("delegate");
    expect(receipt.delegated).toBe(true);
    expect(receipt.delegateTaskId).toBe("task-123");
    expect(receipt.outcome).toBe("completed");
  });

  it("builds receipt for reply (non-delegated) turn", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: false,
      delegateTaskContext: null,
      decision: {
        route_decision: { route: "reply" },
      },
      toolsUsed: ["web_search"],
    };
    const receipt = buildTurnExecutionReceipt(state as any, 2000);
    expect(receipt.route).toBe("reply");
    expect(receipt.delegated).toBe(false);
    expect(receipt.toolsUsed).toEqual(["web_search"]);
    expect(receipt.outcome).toBe("completed");
  });

  it("reads delegateTaskId from delegateTaskContext", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: true,
      delegateTaskContext: { delegateTaskId: "dt-456", taskStatus: "running" },
      decision: { route_decision: { route: "delegate" } },
    };
    const receipt = buildTurnExecutionReceipt(state as any, 1000);
    expect(receipt.delegateTaskId).toBe("dt-456");
    expect(receipt.outcome).toBe("unknown");
  });

  it("derives delegated from delegate identity when state flag is false", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: false,
      delegateTaskContext: { delegateTaskId: "dt-789", taskStatus: "completed" },
      decision: { route_decision: { route: "delegate" } },
    };
    const receipt = buildTurnExecutionReceipt(state as any, 1000);
    expect(receipt.delegated).toBe(true);
  });

  it("includes dispatch_executed from state", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: true,
      dispatchExecuted: true,
      delegateTaskContext: { delegateTaskId: "dt-100", taskStatus: "running" },
      decision: {
        route_decision: { route: "delegate", worker_pool: "octoclaw-worker" },
      },
    };
    const receipt = buildTurnExecutionReceipt(state as any, 3000);
    expect(receipt.dispatchExecuted).toBe(true);
    expect(receipt.resultMaterialized).toBe(false);
  });

  it("includes native task/flow IDs from runtime truth", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: true,
      delegateTaskContext: { delegateTaskId: "dt-200", taskStatus: "completed" },
      decision: {
        route_decision: { route: "delegate" },
        runtime_truth: {
          nativeTaskBinding: { nativeTaskId: "native-task-xyz", nativeFlowId: "native-flow-abc" },
        },
      },
    };
    const receipt = buildTurnExecutionReceipt(state as any, 5000);
    expect(receipt.nativeTaskId).toBe("native-task-xyz");
    expect(receipt.nativeFlowId).toBe("native-flow-abc");
  });
});
