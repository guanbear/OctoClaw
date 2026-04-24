import { describe, expect, it } from "vitest";
import type {
  ContextBudgetReport,
  ContextEscalationReason,
  DelegateArtifactRef,
  DelegateHandoffPacket,
  DelegateStatusPacket,
  WorkerResultPacket,
} from "./delegate-context.js";

describe("delegate context contracts", () => {
  it("type-checks delegate artifact refs", () => {
    const ref: DelegateArtifactRef = {
      artifactId: "artifact-1",
      artifactKind: "worker_report",
      uri: "file:///tmp/report.md",
      title: "Worker report",
      summary: "Full worker report",
      tokenEstimate: 120,
      createdAt: "2026-04-24T00:00:00.000Z",
    };

    expect(ref.artifactKind).toBe("worker_report");
  });

  it("type-checks handoff packets without raw transcript permission", () => {
    const packet: DelegateHandoffPacket = {
      schemaVersion: "octoclaw.delegate_handoff.v1",
      delegateTaskId: "delegate-1",
      attemptId: "attempt-1",
      threadBindingKey: "thread-1",
      currentUserAsk: "implement context packets",
      taskBrief: "Build artifact-first packets",
      acceptanceCriteria: ["tests pass"],
      readScope: ["packages/octoclaw-contracts"],
      writeScope: ["extensions/octoclaw-runtime/src/context"],
      workspaceMode: "write_allowed",
      role: "code",
      modelProfile: "worker_code",
      contextBudget: {
        maxInputTokens: 1800,
        maxSummaryTokens: 250,
        allowRawTranscript: false,
      },
      threadSummary: "Need compact context",
      relevantExcerpts: ["artifact-first delegation"],
      artifactRefs: [],
      forbiddenContent: ["full transcript"],
    };

    expect(packet.contextBudget.allowRawTranscript).toBe(false);
  });

  it("type-checks compact worker result packets", () => {
    const result: WorkerResultPacket = {
      schemaVersion: "octoclaw.worker_result.v1",
      delegateTaskId: "delegate-1",
      attemptId: "attempt-1",
      status: "completed",
      summary: "Implemented packets",
      keyFindings: ["raw transcript excluded"],
      changedFiles: ["delegate-packets.ts"],
      testsRun: ["pnpm test"],
      artifactRefs: ["artifact-report-1"],
      blockers: [],
      confidence: "high",
      metrics: {
        childInputTokens: 900,
        childOutputTokens: 400,
        resultPacketTokens: 120,
        artifactBytes: 2048,
      },
    };

    expect(result.status).toBe("completed");
  });

  it("type-checks delegate status packets", () => {
    const status: DelegateStatusPacket = {
      schemaVersion: "octoclaw.delegate_status.v1",
      threadBindingKey: "thread-1",
      delegateTaskId: "delegate-1",
      nativeFlowId: "flow-1",
      nativeTaskId: "task-1",
      status: "running",
      attemptStatus: "checkpoint",
      role: "code",
      modelProfile: "worker_code",
      createdAt: "2026-04-24T00:00:00.000Z",
      lastEventAt: "2026-04-24T00:01:00.000Z",
      progressSummary: "tests running",
      terminalSummary: "",
      error: "",
      retryable: false,
      artifactRefs: ["artifact-report-1"],
    };

    expect(status.nativeTaskId).toBe("task-1");
  });

  it("type-checks budget reports and escalation reasons", () => {
    const report: ContextBudgetReport = {
      parentContextTokensAdded: 260,
      childInputTokens: 1500,
      childOutputTokens: 700,
      injectedResultTokens: 220,
      artifactBytes: 4096,
      artifactReopenCount: 1,
      directWouldHaveEstimatedTokens: 8000,
      delegationCostBand: "lower",
    };
    const reason: ContextEscalationReason = "summary_insufficient";

    expect(report.delegationCostBand).toBe("lower");
    expect(reason).toBe("summary_insufficient");
  });
});
