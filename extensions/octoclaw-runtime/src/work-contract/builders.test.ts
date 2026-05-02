import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ContextCoverageSnapshot, DelegateContract } from "@octoclaw/contracts/work-contract";
import { stableId } from "../resolve/env.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "./builders.js";

const now = new Date("2026-04-25T12:00:00.000Z");

describe("work contract builders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buildWorkDecisionSeal creates correct seal with required fields", () => {
    const seal = buildWorkDecisionSeal("local_judge", "reply", ["covered_by_memory"]);

    expect(seal).toEqual({
      source: "local_judge",
      route: "reply",
      reasonCodes: ["covered_by_memory"],
      replyMode: undefined,
      delegateRole: undefined,
      confidence: undefined,
      routeSealId: undefined,
      judgeTraceRef: undefined,
      sealedAt: now.toISOString(),
    });
  });

  it("buildWorkDecisionSeal applies optional overrides", () => {
    const seal = buildWorkDecisionSeal("validator", "delegate", ["needs_execution"], {
      delegateRole: "code",
      confidence: 0.82,
      routeSealId: "route-seal-1",
      judgeTraceRef: "judge-trace-1",
    });

    expect(seal.delegateRole).toBe("code");
    expect(seal.confidence).toBe(0.82);
    expect(seal.routeSealId).toBe("route-seal-1");
    expect(seal.judgeTraceRef).toBe("judge-trace-1");
  });

  it("buildWorkContractFromPolicy creates valid contract with all required fields", () => {
    const seal = buildWorkDecisionSeal("memory_coverage", "reply", ["memory_sufficient"], { replyMode: "answer" });
    const contract = buildWorkContractFromPolicy(
      "session-1",
      "Summarize the current task status",
      "runtime_read_model",
      coverage,
      seal,
      {
        turnId: "turn-1",
        reply: {
          replyMode: "answer",
          grounding: "memory",
          allowedTools: [],
          forbiddenTools: ["octoclaw_dispatch"],
          evidenceRefs: ["memory-1"],
        },
      },
    );

    expect(contract.schemaVersion).toBe("octoclaw.work_contract.v1");
    expect(contract.workContractId).toBe(stableId("wc", [
      "session-1",
      "Summarize the current task status",
      "turn-1",
      "",
      seal.sealedAt,
    ]));
    expect(contract.turnId).toBe("turn-1");
    expect(contract.status).toBe("sealed");
    expect(contract.route).toBe("reply");
    expect(contract.mainContext.nextAction).toBe("answer");
    expect(contract.mainContext.visibleIds.workContractId).toBe(contract.workContractId);
    expect(contract.continuity).toEqual({
      threadBindingKey: stableId("thread", ["session-1"]),
      parentSessionKey: "session-1",
      continuationMode: "status_only",
    });
    expect(contract.telemetry).toEqual({
      executionCoverage: "current_turn",
      executionSupportsProvenanceReply: true,
      executionSupportsStatusReply: false,
      executionRequiresControlPlaneRefresh: false,
      memoryCoverage: "strong",
      memoryFreshnessRisk: undefined,
      authority: "execution_wins",
      decisionSource: "memory_coverage",
      parentContextTokensAdded: 0,
    });
    expect(contract.createdAt).toBe(now.toISOString());
    expect(contract.updatedAt).toBe(now.toISOString());
  });

  it("buildWorkContractFromPolicy includes turn entropy to avoid same-prompt id collisions", () => {
    const seal = buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"], {
      routeSealId: "route-seal-collision",
    });
    const first = buildWorkContractFromPolicy("session-same", "repeat prompt", "delegated_work", coverage, seal, {
      turnId: "turn-a",
    });
    const second = buildWorkContractFromPolicy("session-same", "repeat prompt", "delegated_work", coverage, seal, {
      turnId: "turn-b",
    });

    expect(first.workContractId).not.toBe(second.workContractId);
    expect(first.workContractId).toBe(stableId("wc", [
      "session-same",
      "repeat prompt",
      "turn-a",
      "route-seal-collision",
      seal.sealedAt,
    ]));
    expect(second.workContractId).toBe(stableId("wc", [
      "session-same",
      "repeat prompt",
      "turn-b",
      "route-seal-collision",
      seal.sealedAt,
    ]));
  });

  it("buildWorkContractFromPolicy applies overrides for delegate contract", () => {
    const seal = buildWorkDecisionSeal("local_judge", "delegate", ["requires_code"], { delegateRole: "code" });
    const contract = buildWorkContractFromPolicy("session-2", "Fix the failing test", "delegated_work", coverage, seal, {
      status: "queued",
      delegate,
      decisionOverrides: { confidence: 0.93, routeSealId: "route-seal-2" },
    });

    expect(contract.status).toBe("queued");
    expect(contract.delegate).toBe(delegate);
    expect(contract.decision.confidence).toBe(0.93);
    expect(contract.decision.routeSealId).toBe("route-seal-2");
    expect(contract.mainContext.nextAction).toBe("dispatch");
    expect(contract.continuity.continuationMode).toBe("resume_preferred");
  });
});

export const coverage: ContextCoverageSnapshot = {
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
    coverage: "current_turn",
    supports_provenance_reply: true,
  },
  memory: {
    coverage: "strong",
    supports_direct_reply: true,
  },
  conflict: true,
  authority: "execution_wins",
};

export const delegate: DelegateContract = {
  delegateTaskId: "delegate-1",
  currentAttemptId: "attempt-1",
  role: "code",
  coordinationMode: "solo_worker",
  acceptanceCriteria: ["tests pass"],
  scope: {
    read: ["src"],
    write: ["src/work-contract"],
    workspaceMode: "write_allowed",
    scopeFingerprint: "scope-1",
  },
  modelProfile: "coding",
  nativeBinding: {
    flowId: "flow-1",
    ownerKey: "wc-1",
    controllerId: "octoclaw.delegate",
    revision: 2,
    expectedRevision: 2,
    nativeTaskId: "native-task-1",
    runId: "run-1",
    childSessionKey: "child-session-key-1",
    syncMode: "managed",
    status: "running",
  },
  childSessions: [],
  artifactRefs: [
    {
      artifactId: "artifact-1",
      artifactKind: "worker_report",
      createdAt: now.toISOString(),
    },
  ],
  nextAction: "wait",
};
