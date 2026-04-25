import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_BUDGETS,
  checkContextBudget,
  clearContextBudgetReports,
  getContextBudgetReports,
  recordContextBudgetReport,
  sanitizeMainContextInjection,
  shouldOpenArtifactForMainAgent,
} from "./context-budget.js";

describe("context budget utilities", () => {
  beforeEach(() => {
    clearContextBudgetReports();
  });

  it("enforces hard budget limits", () => {
    const check = checkContextBudget({ text: "x".repeat(100) }, { maxTokens: 10 });

    expect(check.ok).toBe(false);
    expect(check.overByTokens).toBeGreaterThan(0);
  });

  it("accepts packets within budget", () => {
    const check = checkContextBudget({ text: "small" }, { maxTokens: DEFAULT_CONTEXT_BUDGETS.worker_handoff_max_tokens });

    expect(check.ok).toBe(true);
  });

  it("records budget telemetry", () => {
    recordContextBudgetReport({
      parentContextTokensAdded: 10,
      childInputTokens: 20,
      childOutputTokens: 30,
      injectedResultTokens: 5,
      artifactBytes: 40,
      artifactReopenCount: 1,
      delegationCostBand: "similar",
    });

    expect(getContextBudgetReports()).toHaveLength(1);
    expect(getContextBudgetReports()[0]?.parentContextTokensAdded).toBe(10);
  });

  it("sanitizes forbidden main context content", () => {
    const sanitized = sanitizeMainContextInjection({
      message: "[Thread history - for context] private history\nUser-visible: hello",
      internalRationale: "spawn because policy",
      contaminationGuard: "do not reveal",
      chainOfThought: "hidden reasoning",
      executionLog: "step by step worker log",
    });
    const rendered = JSON.stringify(sanitized);

    expect(rendered).not.toContain("Thread history");
    expect(rendered).not.toContain("spawn because policy");
    expect(rendered).not.toContain("hidden reasoning");
    expect(rendered).toContain("User-visible: hello");
  });

  it("removes parent-visible raw transcript and route rationale keys", () => {
    const sanitized = sanitizeMainContextInjection({
      summary: "User-visible: compact status",
      full_transcript: "private thread",
      childTranscript: "worker raw transcript",
      rawRouteRationale: "internal router notes",
      raw_execution_log: "tool stdout",
      nested: {
        worker_chain_of_thought: "hidden",
        message: "raw route rationale: internal\nUser-visible: ok",
      },
    });
    const rendered = JSON.stringify(sanitized);

    expect(rendered).not.toContain("private thread");
    expect(rendered).not.toContain("worker raw transcript");
    expect(rendered).not.toContain("internal router notes");
    expect(rendered).not.toContain("tool stdout");
    expect(rendered).not.toContain("hidden");
    expect(rendered).not.toContain("raw route rationale");
    expect(rendered).toContain("User-visible: ok");
  });

  it("over-budget sanitized packet keeps only status and artifact refs", () => {
    const sanitized = sanitizeMainContextInjection({
      schemaVersion: "octoclaw.main_resume.v1",
      status: "completed",
      artifactRefs: ["artifact-1"],
      veryLargeBody: "x".repeat(4000),
    });

    expect(sanitized).toEqual({
      schemaVersion: "octoclaw.main_resume.v1",
      status: "completed",
      statusPacket: undefined,
      artifactRefs: ["artifact-1"],
    });
  });

  it("keeps artifact gate closed by default", () => {
    expect(shouldOpenArtifactForMainAgent({ userAsk: "好了吗" })).toBe(false);
  });

  it("opens artifacts for explicit report and evidence requests", () => {
    expect(shouldOpenArtifactForMainAgent({ userAsk: "show full report and logs" })).toBe(true);
    expect(shouldOpenArtifactForMainAgent({ userAsk: "给我证据" })).toBe(true);
  });

  it("opens artifacts for final summary gaps, recovery, and verifier lanes", () => {
    expect(shouldOpenArtifactForMainAgent({ needsFinalAnswer: true, summaryInsufficient: true })).toBe(true);
    expect(shouldOpenArtifactForMainAgent({ recoveryOrDebug: true })).toBe(true);
    expect(shouldOpenArtifactForMainAgent({ reviewerNeedsEvidence: true })).toBe(true);
  });
});
