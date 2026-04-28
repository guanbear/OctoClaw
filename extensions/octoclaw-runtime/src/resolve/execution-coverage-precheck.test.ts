import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { JudgeExecutionLayer } from "@octoclaw/policy/judge";
import type { PolicyStateEntry } from "../state/policy-state.js";
import { policyState } from "../state/policy-state.js";
import { buildExecutionCoverageLayer } from "./execution-coverage-precheck.js";

const now = new Date("2026-04-25T12:00:00.000Z");

function clearPolicyState(): void {
  for (const { key } of policyState.entries()) {
    policyState.clear(key);
  }
}

function seedPolicyStateEntry(
  key: string,
  overrides: Partial<PolicyStateEntry> = {},
): void {
  policyState.set(key, {
    decision: {
      route_decision: { route: "reply" },
    },
    canonicalSessionKey: key,
    toolsUsed: ["web_fetch"],
    delegated: false,
    dispatchExecuted: false,
    ...overrides,
  });
}

function seedAt(
  key: string,
  completedAt: number,
  overrides: Partial<PolicyStateEntry> = {},
): void {
  vi.setSystemTime(completedAt);
  seedPolicyStateEntry(key, overrides);
  vi.setSystemTime(now);
}

function spawnGuardBlocks(decision: {
  _execution_coverage: Pick<JudgeExecutionLayer, "coverage" | "supports_provenance_reply">;
  request: { metadata: { conversation_control: { intent_class: string } } };
}): boolean {
  const hasSupportedExecutionReply = decision._execution_coverage.supports_provenance_reply === true;
  const executionTruthMissing = decision._execution_coverage.coverage === "none";
  const isExecutionFollowup = decision.request.metadata.conversation_control.intent_class === "execution_followup";
  return !hasSupportedExecutionReply && executionTruthMissing && isExecutionFollowup;
}

describe("buildExecutionCoverageLayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    clearPolicyState();
  });

  afterEach(() => {
    clearPolicyState();
    vi.useRealTimers();
  });

  it("uses compact latestExecutionReceipt retained after direct reply agent_end", () => {
    const key = "agent:main:slack:default:direct:U12345";
    policyState.set(key, {
      canonicalSessionKey: key,
      updatedAt: Date.now() - 5_000,
      latestExecutionReceipt: {
        turnId: "turn-direct-1",
        sessionKey: key,
        route: "reply",
        delegated: false,
        dispatchExecuted: false,
        spawnExecuted: false,
        workContractId: "wc-direct-1",
        delegateTaskId: null,
        nativeTaskId: null,
        nativeFlowId: null,
        childSessionKey: null,
        childSessionId: null,
        childRunId: null,
        nativeFlowRevision: null,
        nativeFlowExpectedRevision: null,
        nativeFlowMutation: null,
        nativeFlowMutationApplied: null,
        nativeFlowMutationError: null,
        workerPool: null,
        toolsUsed: ["exec", "web_fetch"],
        resultMaterialized: false,
        deliveryStatus: null,
        durationMs: 4_000,
        outcome: "completed",
        completedAt: Date.now() - 5_000,
        executionCoverage: null,
        executionSupportsProvenanceReply: true,
        executionSupportsStatusReply: false,
        executionRequiresControlPlaneRefresh: false,
        memoryCoverage: null,
        authority: "execution_wins",
        parentContextTokensAdded: 0,
        resultPacketTokens: 0,
        artifactReopenCount: 0,
      },
    });

    const layer = buildExecutionCoverageLayer([key]);

    expect(layer.coverage).not.toBe("none");
    expect(layer.last_route).toBe("reply");
    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.tools_used).toEqual(["exec", "web_fetch"]);
    expect(layer.evidence_summary).toContain("previous answer used main-session path");
  });

  it("lets a thread follow-up see the root-turn receipt", () => {
    const rootKey = "slack:default:direct:U12345";
    seedAt(rootKey, Date.now() - 5_000, {
      createdAt: Date.now() - 10_000,
      session_binding_key: "slack:user:U12345",
    });

    const layer = buildExecutionCoverageLayer([
      "agent:main:slack:default:direct:U12345:thread:1234567890.123456",
    ]);

    expect(layer.coverage).not.toBe("none");
    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.tools_used).toContain("web_fetch");
  });

  it("resolves a thread follow-up through session_binding_key", () => {
    seedAt("receipt-key", Date.now() - 5_000, {
      canonicalSessionKey: "slack:default:direct:U12345",
      session_binding_key: "slack:user:U12345",
    });

    const layer = buildExecutionCoverageLayer([
      "agent:main:slack:default:direct:U12345:thread:ts",
    ]);

    expect(layer.coverage).not.toBe("none");
    expect(layer.supports_provenance_reply).toBe(true);
  });

  it("marks a 1-hour-old receipt as stale thread coverage", () => {
    const key = "stale-receipt";
    seedAt(key, Date.now() - 3_600_000, {
      createdAt: Date.now() - 3_601_000,
    });

    const dateNow = vi.spyOn(Date, "now");
    dateNow
      .mockReturnValueOnce(now.getTime())
      .mockReturnValueOnce(now.getTime() - 3_600_000 + 1);

    const layer = buildExecutionCoverageLayer([key]);
    dateNow.mockRestore();

    expect(layer.coverage).toBe("thread");
    expect(layer.freshness).toBe("stale");
  });

  it("marks a 2-minute-old receipt as recent_turn coverage", () => {
    const key = "recent-receipt";
    seedAt(key, Date.now() - 120_000);

    const layer = buildExecutionCoverageLayer([key]);

    expect(layer.coverage).toBe("recent_turn");
    expect(layer.freshness).toBe("recent");
  });

  it("marks a 5-second-old receipt as current_turn coverage", () => {
    const key = "current-receipt";
    seedAt(key, Date.now() - 5_000);

    const layer = buildExecutionCoverageLayer([key]);

    expect(layer.coverage).toBe("current_turn");
    expect(layer.freshness).toBe("current");
  });

  it("returns no coverage when no prior receipt exists", () => {
    const layer = buildExecutionCoverageLayer(["nonexistent-key"]);

    expect(layer.coverage).toBe("none");
    expect(layer.supports_provenance_reply).toBe(false);
    expect(layer.supports_status_reply).toBe(false);
    expect(layer.requires_control_plane_refresh).toBe(false);
    expect(layer.dispatch_executed).toBe(false);
    expect(layer.spawn_executed).toBe(false);
    expect(layer.result_materialized).toBe(false);
  });

  it("excludes the current turn ID when selecting prior receipts", () => {
    const key = "turn-filter-receipt";
    seedAt("turn-old-entry", Date.now() - 10_000, {
      canonicalSessionKey: key,
      turnId: "turn-old",
      toolsUsed: ["web_fetch"],
    });
    seedAt("turn-current-entry", Date.now() - 1_000, {
      canonicalSessionKey: key,
      turnId: "turn-current",
      toolsUsed: ["current_tool"],
    });

    const layer = buildExecutionCoverageLayer([key], "turn-current");

    expect(layer.coverage).toBe("current_turn");
    expect(layer.tools_used).toEqual(["web_fetch"]);
    expect(layer.evidence_summary).toContain("web_fetch");
    expect(layer.evidence_summary).not.toContain("current_tool");
  });
});

describe("structured intent spawn guard", () => {
  it("blocks execution_followup with missing coverage", () => {
    const decision = {
      _execution_coverage: { coverage: "none", supports_provenance_reply: false },
      request: { metadata: { conversation_control: { intent_class: "execution_followup" } } },
    } satisfies Parameters<typeof spawnGuardBlocks>[0];

    expect(spawnGuardBlocks(decision)).toBe(true);
  });

  it("does not block plain_chat with missing coverage", () => {
    const decision = {
      _execution_coverage: { coverage: "none", supports_provenance_reply: false },
      request: { metadata: { conversation_control: { intent_class: "plain_chat" } } },
    } satisfies Parameters<typeof spawnGuardBlocks>[0];

    expect(spawnGuardBlocks(decision)).toBe(false);
  });

  it("blocks Chinese provenance query with missing coverage", () => {
    const decision = {
      _execution_coverage: { coverage: "none", supports_provenance_reply: false },
      request: {
        metadata: {
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
      },
    } satisfies Parameters<typeof spawnGuardBlocks>[0];

    expect(spawnGuardBlocks(decision)).toBe(true);
  });

  it("does not block execution_followup when provenance is supported", () => {
    const decision = {
      _execution_coverage: { coverage: "current_turn", supports_provenance_reply: true },
      request: {
        metadata: {
          conversation_control: {
            intent_class: "execution_followup",
          },
        },
      },
    } satisfies Parameters<typeof spawnGuardBlocks>[0];

    expect(spawnGuardBlocks(decision)).toBe(false);
  });
});

describe("acceptance: thread provenance follow-up end-to-end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    clearPolicyState();
  });

  afterEach(() => {
    clearPolicyState();
    vi.useRealTimers();
  });

  it("simulates: fresh lookup in root DM, thread asks provenance → reply, no spawn", () => {
    const rootKey = "agent:main:slack:default:direct:U12345";
    const threadKey = `${rootKey}:thread:1745580000.123456`;

    seedAt(rootKey, Date.now() - 5_000, {
      createdAt: Date.now() - 10_000,
      decision: {
        route_decision: { route: "reply" },
      },
      canonicalSessionKey: rootKey,
      toolsUsed: ["web_fetch"],
      delegated: false,
      dispatchExecuted: false,
    });

    const layer = buildExecutionCoverageLayer([threadKey]);

    expect(layer.coverage).toBe("current_turn");
    expect(layer.freshness).toBe("current");
    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.last_route).toBe("reply");
    expect(layer.tools_used).toContain("web_fetch");
    expect(layer.dispatch_executed).toBe(false);
    expect(layer.spawn_executed).toBe(false);
    expect(layer.result_materialized).toBe(false);

    expect(layer.evidence_summary).toContain("web_fetch");
    expect(layer.evidence_summary).toContain("main-session path");
  });

  it("simulates: 1-hour-old root receipt, thread follow-up → thread/stale coverage", () => {
    const rootKey = "agent:main:slack:default:direct:U12345";
    const threadKey = `${rootKey}:thread:1745580000.654321`;

    seedAt(rootKey, Date.now() - 3_600_000, {
      createdAt: Date.now() - 3_601_000,
      decision: {
        route_decision: { route: "reply" },
      },
      canonicalSessionKey: rootKey,
      toolsUsed: ["web_fetch"],
      delegated: false,
      dispatchExecuted: false,
    });

    const dateNow = vi.spyOn(Date, "now");
    dateNow
      .mockReturnValueOnce(now.getTime())
      .mockReturnValueOnce(now.getTime() - 3_600_000 + 1);

    const layer = buildExecutionCoverageLayer([threadKey]);
    dateNow.mockRestore();

    expect(layer.coverage).toBe("thread");
    expect(layer.freshness).toBe("stale");
    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.dispatch_executed).toBe(false);
    expect(layer.spawn_executed).toBe(false);
  });


  it("prefers root execution evidence over a newer projection-only thread receipt", () => {
    const rootKey = "agent:main:slack:channel:C0AS4DAPPU3";
    const threadKey = `${rootKey}:thread:1777363646.984299`;

    policyState.set(rootKey, {
      canonicalSessionKey: rootKey,
      createdAt: Date.now() - 70_000,
      updatedAt: Date.now() - 60_000,
      latestExecutionReceipt: {
        turnId: "turn-root-direct",
        sessionKey: rootKey,
        route: "reply",
        delegated: false,
        dispatchExecuted: false,
        spawnExecuted: false,
        workContractId: "wc-root-direct",
        delegateTaskId: null,
        nativeTaskId: "task-root-direct",
        nativeFlowId: null,
        childSessionKey: null,
        childSessionId: null,
        childRunId: null,
        nativeFlowRevision: null,
        nativeFlowExpectedRevision: null,
        nativeFlowMutation: null,
        nativeFlowMutationApplied: null,
        nativeFlowMutationError: null,
        workerPool: "octoclaw-main",
        toolsUsed: ["exec"],
        resultMaterialized: false,
        deliveryStatus: null,
        durationMs: 4_000,
        outcome: "completed",
        completedAt: Date.now() - 60_000,
        executionCoverage: null,
        executionSupportsProvenanceReply: true,
        executionSupportsStatusReply: false,
        executionRequiresControlPlaneRefresh: false,
        memoryCoverage: null,
        authority: "execution_wins",
        parentContextTokensAdded: 0,
        resultPacketTokens: 0,
        artifactReopenCount: 0,
      },
    });

    policyState.set(threadKey, {
      canonicalSessionKey: threadKey,
      createdAt: Date.now() - 20_000,
      updatedAt: Date.now() - 10_000,
      latestExecutionReceipt: {
        turnId: "turn-thread-projection",
        sessionKey: threadKey,
        route: "reply",
        delegated: false,
        dispatchExecuted: false,
        spawnExecuted: false,
        workContractId: "wc-thread-projection",
        delegateTaskId: null,
        nativeTaskId: "task-thread-projection",
        nativeFlowId: null,
        childSessionKey: null,
        childSessionId: null,
        childRunId: null,
        nativeFlowRevision: null,
        nativeFlowExpectedRevision: null,
        nativeFlowMutation: null,
        nativeFlowMutationApplied: null,
        nativeFlowMutationError: null,
        workerPool: "octoclaw-main",
        toolsUsed: [],
        resultMaterialized: false,
        deliveryStatus: null,
        durationMs: 2_000,
        outcome: "completed",
        completedAt: Date.now() - 10_000,
        executionCoverage: null,
        executionSupportsProvenanceReply: true,
        executionSupportsStatusReply: false,
        executionRequiresControlPlaneRefresh: false,
        memoryCoverage: null,
        authority: "execution_wins",
        parentContextTokensAdded: 0,
        resultPacketTokens: 0,
        artifactReopenCount: 0,
      },
    });

    const layer = buildExecutionCoverageLayer([threadKey]);

    expect(layer.last_route).toBe("reply");
    expect(layer.tools_used).toEqual(["exec"]);
    expect(layer.evidence_summary).toContain("main-session path");
    expect(layer.evidence_summary).toContain("tools=[exec]");
    expect(layer.evidence_summary).not.toContain("delegated path");
  });

  it("keeps a real delegated thread receipt ahead of root direct evidence", () => {
    const rootKey = "agent:main:slack:channel:C0AS4DAPPU3";
    const threadKey = `${rootKey}:thread:1777363646.984299`;

    seedAt(rootKey, Date.now() - 30_000, {
      canonicalSessionKey: rootKey,
      decision: { route_decision: { route: "reply" } },
      toolsUsed: ["exec"],
      delegated: false,
      dispatchExecuted: false,
    });

    seedAt(threadKey, Date.now() - 60_000, {
      canonicalSessionKey: threadKey,
      decision: { route_decision: { route: "delegate", worker_pool: "octoclaw-research" } },
      toolsUsed: [],
      delegated: true,
      dispatchExecuted: true,
      delegateTaskContext: { delegateTaskId: "task-real-delegate", taskStatus: "completed" },
    });

    const layer = buildExecutionCoverageLayer([threadKey]);

    expect(layer.last_route).toBe("delegate");
    expect(layer.supports_status_reply).toBe(true);
    expect(layer.dispatch_executed).toBe(true);
    expect(layer.evidence_summary).toContain("delegated path");
  });

  it("simulates: no prior receipt at all → coverage none, spawn guard blocks execution_followup", () => {
    const threadKey = "agent:main:slack:default:direct:U99999:thread:9999";

    const layer = buildExecutionCoverageLayer([threadKey]);

    expect(layer.coverage).toBe("none");
    expect(layer.supports_provenance_reply).toBe(false);

    const spawnDecision = {
      _execution_coverage: layer,
      request: {
        metadata: {
          conversation_control: { intent_class: "execution_followup" },
        },
      },
    };

    expect(spawnGuardBlocks(spawnDecision)).toBe(true);
  });

  it("simulates: delegated root turn, thread follow-up → status supported, no new spawn", () => {
    const rootKey = "agent:main:slack:default:direct:U88888";
    const threadKey = `${rootKey}:thread:8888`;

    seedAt(rootKey, Date.now() - 30_000, {
      createdAt: Date.now() - 60_000,
      decision: {
        route_decision: { route: "delegate", worker_pool: "octoclaw-worker" },
      },
      canonicalSessionKey: rootKey,
      toolsUsed: [],
      delegated: true,
      dispatchExecuted: true,
      delegateTaskContext: {
        delegateTaskId: "task-delegated-001",
        taskStatus: "completed",
      },
    });

    const layer = buildExecutionCoverageLayer([threadKey]);

    expect(layer.coverage).not.toBe("none");
    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.supports_status_reply).toBe(true);
    expect(layer.dispatch_executed).toBe(true);
    expect(layer.evidence_summary).toContain("delegated path");
  });
});

describe("Phase A acceptance: provenance/status follow-up does not spawn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    clearPolicyState();
  });

  afterEach(() => {
    clearPolicyState();
    vi.useRealTimers();
  });

  it("怎么查的 with sufficient execution coverage → reply, no spawn", () => {
    const rootKey = "agent:main:slack:default:direct:U55555";
    seedAt(rootKey, Date.now() - 3_000, {
      createdAt: Date.now() - 8_000,
      decision: { route_decision: { route: "reply" } },
      canonicalSessionKey: rootKey,
      toolsUsed: ["web_fetch"],
      delegated: false,
      dispatchExecuted: false,
    });

    const layer = buildExecutionCoverageLayer([rootKey]);

    // Acceptance: coverage sufficient → route must be reply, not delegate
    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.last_route).toBe("reply");
    expect(layer.tools_used).toContain("web_fetch");
    expect(layer.dispatch_executed).toBe(false);
    expect(layer.spawn_executed).toBe(false);

    // The spawn guard must NOT block when provenance is supported
    const decision = {
      _execution_coverage: layer,
      request: {
        metadata: {
          conversation_control: { intent_class: "execution_followup" },
        },
      },
    };
    expect(spawnGuardBlocks(decision as any)).toBe(false);
  });

  it("刚才那个任务判定是啥 with delegate receipt → status reply, no new spawn", () => {
    const rootKey = "agent:main:slack:default:direct:U66666";
    seedAt(rootKey, Date.now() - 10_000, {
      createdAt: Date.now() - 30_000,
      decision: {
        route_decision: { route: "delegate", worker_pool: "octoclaw-worker" },
      },
      canonicalSessionKey: rootKey,
      toolsUsed: [],
      delegated: true,
      dispatchExecuted: true,
      delegateTaskContext: {
        delegateTaskId: "task-judge-001",
        taskStatus: "completed",
      },
    });

    const layer = buildExecutionCoverageLayer([rootKey]);

    expect(layer.supports_provenance_reply).toBe(true);
    expect(layer.supports_status_reply).toBe(true);
    expect(layer.dispatch_executed).toBe(true);
    expect(layer.evidence_summary).toContain("delegated");

    const decision = {
      _execution_coverage: layer,
      request: {
        metadata: {
          conversation_control: { intent_class: "execution_followup" },
        },
      },
    };
    expect(spawnGuardBlocks(decision as any)).toBe(false);
  });

  it("dispatchExecuted=true spawnExecuted=false → honest status, provenance supported", () => {
    const rootKey = "agent:main:slack:default:direct:U77777";
    seedAt(rootKey, Date.now() - 5_000, {
      createdAt: Date.now() - 15_000,
      decision: {
        route_decision: { route: "delegate" },
      },
      canonicalSessionKey: rootKey,
      toolsUsed: [],
      delegated: true,
      dispatchExecuted: true,
    });

    const layer = buildExecutionCoverageLayer([rootKey]);

    // Key acceptance: dispatch registered but no spawn evidence
    expect(layer.dispatch_executed).toBe(true);
    expect(layer.spawn_executed).toBe(false);
    // Provenance should still be supported (we CAN answer "what happened")
    expect(layer.supports_provenance_reply).toBe(true);
  });

  it("does not promote prior continuity into spawnExecuted coverage", () => {
    const rootKey = "agent:main:slack:default:direct:U77778";
    seedAt(rootKey, Date.now() - 5_000, {
      createdAt: Date.now() - 15_000,
      decision: {
        route_decision: { route: "delegate" },
        work_contract: { childSessionKey: "prior-child-key", childRunId: "prior-run-id" },
        runtime_truth: { nativeTaskBinding: { nativeFlowId: "flow-continuity-only" } },
      },
      canonicalSessionKey: rootKey,
      delegated: true,
      dispatchExecuted: true,
    });

    const layer = buildExecutionCoverageLayer([rootKey]);

    expect(layer.dispatch_executed).toBe(true);
    expect(layer.spawn_executed).toBe(false);
    expect(layer.evidence_summary).toContain("spawn not confirmed");
    expect(layer.requires_control_plane_refresh).toBe(true);
  });

  it("execution coverage missing → spawn guard blocks execution_followup", () => {
    const layer = buildExecutionCoverageLayer(["nonexistent-session"]);

    expect(layer.coverage).toBe("none");
    expect(layer.supports_provenance_reply).toBe(false);

    const decision = {
      _execution_coverage: layer,
      request: {
        metadata: {
          conversation_control: { intent_class: "execution_followup" },
        },
      },
    };
    expect(spawnGuardBlocks(decision as any)).toBe(true);
  });

  it("memory strong but execution says no dispatch → execution wins", () => {
    // This test validates execution wins over memory
    const rootKey = "agent:main:slack:default:direct:U88888";
    seedAt(rootKey, Date.now() - 5_000, {
      createdAt: Date.now() - 10_000,
      decision: { route_decision: { route: "reply" } },
      canonicalSessionKey: rootKey,
      toolsUsed: [],
      delegated: false,
      dispatchExecuted: false,
    });

    const layer = buildExecutionCoverageLayer([rootKey]);

    // Execution truth: no dispatch, no spawn
    expect(layer.dispatch_executed).toBe(false);
    expect(layer.spawn_executed).toBe(false);
    // Even if memory "remembers" differently, execution layer tells the truth
    expect(layer.last_route).toBe("reply");
  });
});
