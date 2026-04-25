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

describe("Phase A acceptance: honest status when TaskFlow created but no TaskRun", () => {
  it("flow exists but no TaskRun/session evidence → dispatchExecuted=true, spawnExecuted=false", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: true,
      dispatchExecuted: true,
      delegateTaskContext: { delegateTaskId: "dt-flow-only", taskStatus: "running" },
      decision: {
        route_decision: { route: "delegate" },
        runtime_truth: {
          nativeTaskBinding: {
            nativeFlowId: "flow-exists-123",
            nativeTaskId: null,  // No TaskRun created
            revision: 1,
            expectedRevision: 0,
          },
        },
      },
      toolsUsed: [],
    };

    const receipt = buildTurnExecutionReceipt(state as any, 3000);

    // TaskFlow created but no actual child execution
    expect(receipt.dispatchExecuted).toBe(true);
    expect(receipt.spawnExecuted).toBe(false);
    expect(receipt.nativeFlowId).toBe("flow-exists-123");
    expect(receipt.nativeTaskId).toBeNull();
    expect(receipt.resultMaterialized).toBe(false);
  });

  it("honest receipt: registered but not executed", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: false,
      dispatchExecuted: true,
      delegateTaskContext: null,
      decision: {
        route_decision: { route: "delegate" },
        runtime_truth: {
          nativeTaskBinding: {
            nativeFlowId: "flow-registered",
            nativeTaskId: null,
          },
        },
      },
    };

    const receipt = buildTurnExecutionReceipt(state as any, 1000);

    expect(receipt.dispatchExecuted).toBe(true);
    expect(receipt.spawnExecuted).toBe(false);
    // Must NOT claim completion
    expect(receipt.resultMaterialized).toBe(false);
    expect(receipt.deliveryStatus).toBeNull();
  });

  it("parent-visible receipt does not contain full child transcript", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: true,
      dispatchExecuted: true,
      delegateTaskContext: {
        delegateTaskId: "dt-with-child",
        taskStatus: "completed",
      },
      decision: {
        work_contract: {
          forbiddenContent: [
            "full_transcript",
            "internal_route_rationale",
            "delegation_rationale",
            "worker_chain_of_thought",
            "raw_execution_log",
          ],
        },
        route_decision: { route: "delegate" },
        runtime_truth: {
          nativeTaskBinding: {
            nativeFlowId: "flow-child",
            nativeTaskId: "task-child",
            childSessionKey: "child-key-1",
            childSessionId: "child-sess-1",
          },
        },
        delivery: { result_packet_tokens: 200 },
        telemetry: {
          parentContextTokensAdded: 150,
          artifactReopenCount: 0,
        },
      },
    };

    const receipt = buildTurnExecutionReceipt(state as any, 5000);

    // Child session identity is recorded (for continuity)
    expect(receipt.childSessionKey).toBe("child-key-1");
    expect(receipt.childSessionId).toBe("child-sess-1");
    // But context pollution is bounded
    expect(receipt.parentContextTokensAdded).toBe(150);
    expect(receipt.resultPacketTokens).toBe(200);
    expect(receipt.artifactReopenCount).toBe(0);
  });

  it("telemetry records request/task/flow cost and speed indicators", () => {
    const state = {
      canonicalSessionKey: "test-session",
      delegated: true,
      dispatchExecuted: true,
      decision: {
        route_decision: { route: "delegate" },
        runtime_truth: {
          nativeTaskBinding: {
            nativeFlowId: "flow-tel",
            nativeTaskId: "task-tel",
            revision: 3,
            expectedRevision: 2,
          },
          nativeFlowMutation: "createManaged",
          nativeFlowMutationApplied: true,
        },
        execution_layer: {
          coverage: "current_turn",
          supports_provenance_reply: true,
          supports_status_reply: false,
        },
        memory_layer: { coverage: "partial" },
        context_coverage: { authority: "execution_wins" },
        telemetry: {
          parentContextTokensAdded: 300,
        },
        delivery: { result_packet_tokens: 150 },
      },
      delegateTaskContext: { delegateTaskId: "dt-tel", taskStatus: "running" },
    };

    const receipt = buildTurnExecutionReceipt(state as any, 2500);

    // Flow telemetry
    expect(receipt.nativeFlowRevision).toBe(3);
    expect(receipt.nativeFlowExpectedRevision).toBe(2);
    expect(receipt.nativeFlowMutation).toBe("createManaged");
    expect(receipt.nativeFlowMutationApplied).toBe(true);

    // Coverage telemetry
    expect(receipt.executionCoverage).toBe("current_turn");
    expect(receipt.executionSupportsProvenanceReply).toBe(true);
    expect(receipt.memoryCoverage).toBe("partial");
    expect(receipt.authority).toBe("execution_wins");

    // Cost/pollution telemetry
    expect(receipt.parentContextTokensAdded).toBe(300);
    expect(receipt.resultPacketTokens).toBe(150);
  });
});
