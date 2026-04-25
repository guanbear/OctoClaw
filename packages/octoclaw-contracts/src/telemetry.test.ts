import { describe, expect, it } from "vitest";
import type { OptimizationTelemetry } from "./telemetry.js";
import type { ExecutionCoveragePacket } from "./work-contract.js";

const createdAt = "2026-04-25T00:00:00.000Z";

describe("OptimizationTelemetry", () => {
  it("supports request/task/flow speed, cost, and context pollution fields", () => {
    const telemetry: OptimizationTelemetry = {
      schemaVersion: "octoclaw.contracts/v1",
      createdAt,
      kind: "telemetry",
      telemetryId: "task:flow-1:task-1",
      requestId: "req-1",
      taskId: "task-1",
      flowId: "flow-1",
      route: "delegate",
      role: "code",
      modelProfile: "code-fast",
      backend: "openclaw-native",
      queueBudget: 3,
      concurrencyBudget: 1,
      capabilityBudget: ["delegate"],
      workspaceMode: "isolated_worktree",
      readScope: [],
      writeScope: [],
      ackMs: 12,
      routeDecisionMs: 20,
      taskMaterializeMs: 30,
      queueWaitMs: 40,
      firstProgressMs: 50,
      finalDeliveryMs: 60,
      estimatedCostUsd: 0.01,
      actualCostUsd: 0.02,
      parentContextTokensAdded: 10,
      resultPacketTokens: 20,
      artifactReopenCount: 2,
    };

    expect(telemetry.ackMs).toBe(12);
    expect(telemetry.actualCostUsd).toBe(0.02);
    expect(telemetry.parentContextTokensAdded).toBe(10);
    expect(telemetry.resultPacketTokens).toBe(20);
    expect(telemetry.artifactReopenCount).toBe(2);
  });
});

describe("ExecutionCoveragePacket", () => {
  it("records route answer coverage without implying spawn execution", () => {
    const packet: ExecutionCoveragePacket = {
      packetId: "coverage-1",
      requestId: "req-1",
      turnId: "turn-1",
      sessionKey: "session-1",
      route: "reply",
      replyMode: "answer",
      dispatchExecuted: false,
      spawnExecuted: false,
      resultMaterialized: true,
      evidenceRefs: ["receipt-1"],
      createdAt,
      coverage: {
        precheckOrder: [
          "conversation_grounding",
          "continuation_route_reuse",
          "execution_coverage",
          "memory_coverage",
          "build_judge_context_packet",
          "local_judge",
          "validator_or_remote",
          "route_seal_commit",
        ],
        execution: {
          coverage: "thread",
          supports_provenance_reply: true,
          supports_status_reply: true,
          spawn_executed: false,
          result_materialized: true,
        },
        memory: { coverage: "partial" },
        conflict: false,
        authority: "execution_wins",
      },
    };

    expect(packet.route).toBe("reply");
    expect(packet.replyMode).toBe("answer");
    expect(packet.spawnExecuted).toBe(false);
  });
});
