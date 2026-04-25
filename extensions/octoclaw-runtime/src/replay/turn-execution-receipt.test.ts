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

  it("includes WorkContract continuity, native mutation, and coverage telemetry", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: true,
      dispatchExecuted: true,
      delegateTaskContext: { delegateTaskId: "dt-300", taskStatus: "running" },
      decision: {
        workContractId: "wc-300",
        work_contract: {
          workContractId: "wc-300",
          childSessionKey: "child-key-300",
        },
        route_decision: { route: "delegate", worker_pool: "octoclaw-worker" },
        execution_layer: {
          coverage: "current_turn",
          supports_provenance_reply: true,
          supports_status_reply: true,
          requires_control_plane_refresh: false,
          spawn_executed: true,
        },
        memory_layer: { coverage: "none" },
        context_coverage: { authority: "execution_wins" },
        runtime_truth: {
          nativeTaskBinding: {
            nativeTaskId: "native-task-300",
            nativeFlowId: "native-flow-300",
            revision: 7,
            expectedRevision: 6,
            childSessionId: "child-session-300",
            childRunId: "child-run-300",
          },
          nativeFlowMutation: "createManaged",
          nativeFlowMutationApplied: true,
        },
        delivery: { result_packet_tokens: 88 },
        telemetry: {
          parentContextTokensAdded: 42,
          artifactReopenCount: 2,
        },
      },
    };

    const receipt = buildTurnExecutionReceipt(state as any, 3000);

    expect(receipt.workContractId).toBe("wc-300");
    expect(receipt.spawnExecuted).toBe(true);
    expect(receipt.childSessionKey).toBe("child-key-300");
    expect(receipt.childSessionId).toBe("child-session-300");
    expect(receipt.childRunId).toBe("child-run-300");
    expect(receipt.nativeFlowRevision).toBe(7);
    expect(receipt.nativeFlowExpectedRevision).toBe(6);
    expect(receipt.nativeFlowMutation).toBe("createManaged");
    expect(receipt.nativeFlowMutationApplied).toBe(true);
    expect(receipt.executionCoverage).toBe("current_turn");
    expect(receipt.executionSupportsProvenanceReply).toBe(true);
    expect(receipt.executionSupportsStatusReply).toBe(true);
    expect(receipt.memoryCoverage).toBe("none");
    expect(receipt.authority).toBe("execution_wins");
    expect(receipt.parentContextTokensAdded).toBe(42);
    expect(receipt.resultPacketTokens).toBe(88);
    expect(receipt.artifactReopenCount).toBe(2);
  });

  it("uses explicit completedAt timestamp when provided", () => {
    const completedAt = Date.now() - 60 * 60_000;
    const state = {
      canonicalSessionKey: "test-session",
      delegated: false,
      decision: { route_decision: { route: "reply" } },
    };

    const receipt = buildTurnExecutionReceipt(state as any, 1000, completedAt);

    expect(receipt.completedAt).toBe(completedAt);
  });
});
