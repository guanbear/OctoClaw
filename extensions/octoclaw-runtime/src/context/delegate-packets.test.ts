import { describe, expect, it } from "vitest";
import {
  buildDelegateHandoffPacket,
  buildDelegateStatusPacket,
  buildMainResumePacket,
  buildWorkerResultPacket,
} from "./delegate-packets.js";
import { recordContextBudgetReport, sanitizeMainContextInjection } from "./context-budget.js";

describe("delegate packet builders", () => {
  it("worker input does not include full transcript", () => {
    const packet = buildDelegateHandoffPacket({
      delegateTaskId: "delegate-1",
      attemptId: "attempt-1",
      threadBindingKey: "thread-1",
      currentUserAsk: "好了吗",
      taskBrief: "Check status",
      modelProfile: "worker_research",
      threadSummary: "User asked for status",
    });

    expect(packet.contextBudget.allowRawTranscript).toBe(false);
    expect(JSON.stringify(packet)).not.toContain("[Thread history - for context]");
    expect(packet.forbiddenContent).toContain("full_transcript");
  });

  it("worker result injection into main agent only includes compact packet", () => {
    const result = buildWorkerResultPacket({
      delegateTaskId: "delegate-1",
      attemptId: "attempt-1",
      status: "completed",
      summary: "Done",
      keyFindings: ["Use artifact for full report"],
      artifactRefs: ["artifact-report-1"],
      metrics: { resultPacketTokens: 50 },
    });

    expect(result.schemaVersion).toBe("octoclaw.worker_result.v1");
    expect(JSON.stringify(result)).not.toContain("full report body");
    expect(result.artifactRefs).toEqual(["artifact-report-1"]);
  });

  it("follow-up status prompts only inject DelegateStatusPacket", () => {
    const status = buildDelegateStatusPacket({
      threadBindingKey: "thread-1",
      delegateTaskId: "delegate-1",
      nativeFlowId: "flow-1",
      nativeTaskId: "task-1",
      status: "running",
      role: "research",
      modelProfile: "worker_research",
      progressSummary: "Still running",
      artifactRefs: ["artifact-status-1"],
    });

    expect(status.schemaVersion).toBe("octoclaw.delegate_status.v1");
    expect(status.progressSummary).toBe("Still running");
    expect(JSON.stringify(status)).not.toContain("threadSummary");
  });

  it("internal orchestration wording does not enter user-visible reply", () => {
    const clean = sanitizeMainContextInjection({
      message: "Internal route rationale: spawn worker. User-visible: done.",
    });

    expect(JSON.stringify(clean)).not.toContain("Internal route rationale");
    expect(JSON.stringify(clean)).toContain("User-visible: done.");
  });

  it("artifact ref can be read on demand for full report", () => {
    const status = buildDelegateStatusPacket({
      threadBindingKey: "thread-1",
      delegateTaskId: "delegate-1",
      nativeFlowId: "flow-1",
      nativeTaskId: "task-1",
      status: "completed",
      role: "code",
      modelProfile: "worker_code",
      terminalSummary: "Full report available as artifact",
      artifactRefs: ["artifact-report-1"],
    });

    expect(status.artifactRefs).toContain("artifact-report-1");
  });

  it("telemetry records parent context added tokens", () => {
    const report = recordContextBudgetReport({
      parentContextTokensAdded: 120,
      childInputTokens: 1400,
      childOutputTokens: 600,
      injectedResultTokens: 110,
      artifactBytes: 2048,
      artifactReopenCount: 0,
      delegationCostBand: "lower",
    });

    expect(report.parentContextTokensAdded).toBe(120);
  });

  it("full report is artifact ref, not main resume packet body", () => {
    const status = buildDelegateStatusPacket({
      threadBindingKey: "thread-1",
      delegateTaskId: "delegate-1",
      nativeFlowId: "flow-1",
      nativeTaskId: "task-1",
      status: "completed",
      role: "code",
      modelProfile: "worker_code",
      terminalSummary: "Done",
      artifactRefs: ["worker_report:delegate-1:1"],
    });
    const resume = buildMainResumePacket(status, { threadSummary: "Compact summary" });

    expect(resume.artifactRefs).toEqual(["worker_report:delegate-1:1"]);
    expect(JSON.stringify(resume)).not.toContain("full worker report markdown");
  });

  it("context escalation to transcript excerpt requires a reason", () => {
    expect(() => buildDelegateHandoffPacket({
      delegateTaskId: "delegate-1",
      attemptId: "attempt-1",
      threadBindingKey: "thread-1",
      currentUserAsk: "quote exact prior wording",
      taskBrief: "Need prior wording",
      modelProfile: "worker_research",
      relevantExcerpts: ["exact phrase"],
    })).toThrow("context_escalation_reason_required");
  });
});
