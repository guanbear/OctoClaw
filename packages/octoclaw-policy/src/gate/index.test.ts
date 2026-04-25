import { describe, expect, it } from "vitest";
import { checkHardBoundary, compareCandidateGate } from "./index.js";

describe("hard boundary gate", () => {
  it("triggers on explicit control action", () => {
    expect(checkHardBoundary({ explicitControlAction: true })).toEqual({
      triggered: true,
      signal: "explicit_control_action",
      reason: "explicit control action detected",
    });
  });

  it("triggers on existing task binding", () => {
    expect(checkHardBoundary({ existingTaskBinding: "task-123" })).toEqual({
      triggered: true,
      signal: "existing_task_binding",
      routeOverride: "delegate",
      reason: "bound to existing task task-123",
    });
  });

  it("triggers on recovery session", () => {
    expect(checkHardBoundary({ isRecoverySession: true })).toEqual({
      triggered: true,
      signal: "recovery_session",
      routeOverride: "delegate",
      reason: "recovery session detected",
    });
  });

  it("triggers on permission boundary", () => {
    expect(checkHardBoundary({ permissionBoundaryTriggered: true })).toEqual({
      triggered: true,
      signal: "permission_boundary",
      reason: "permission boundary triggered",
    });
  });

  it("triggers on dangerous write", () => {
    expect(checkHardBoundary({ dangerousWrite: true })).toEqual({
      triggered: true,
      signal: "dangerous_write",
      reason: "dangerous write operation detected",
    });
  });

  it("does not trigger without signals", () => {
    expect(checkHardBoundary({})).toEqual({
      triggered: false,
      signal: null,
      reason: "no hard boundary signal",
    });
  });
});

describe("candidate cost/speed gate", () => {
  it("passes only when latency, cost, replay, acceptance, context, fallback, and timeout do not regress", () => {
    expect(compareCandidateGate({
      baseline: { latencyMs: 1000, costUsd: 0.1, parentContextTokensAdded: 100, resultPacketTokens: 200, artifactReopenCount: 2, fallbackCount: 1, timeoutCount: 0 },
      candidate: {
        latencyMs: 900,
        costUsd: 0.08,
        acceptancePassed: true,
        replayPassed: true,
        parentContextTokensAdded: 80,
        resultPacketTokens: 150,
        artifactReopenCount: 1,
        fallbackCount: 1,
        timeoutCount: 0,
      },
    })).toMatchObject({
      latency: "pass",
      cost: "pass",
      acceptance: "pass",
      replay: "pass",
      contextPollution: "pass",
      fallback: "pass",
      timeout: "pass",
      overall: "pass",
      unknownIsPass: false,
    });
  });

  it("treats unknown as unknown rather than pass", () => {
    const report = compareCandidateGate({
      baseline: { latencyMs: 1000, costUsd: 0.1 },
      candidate: { latencyMs: 900, costUsd: 0.08, acceptancePassed: true },
    });

    expect(report.replay).toBe("unknown");
    expect(report.contextPollution).toBe("unknown");
    expect(report.overall).toBe("unknown");
    expect(report.unknownIsPass).toBe(false);
  });

  it("fails when cheaper model degrades acceptance or replay", () => {
    expect(compareCandidateGate({
      baseline: { latencyMs: 1000, costUsd: 0.1, parentContextTokensAdded: 100, fallbackCount: 0, timeoutCount: 0 },
      candidate: {
        latencyMs: 700,
        costUsd: 0.05,
        acceptancePassed: false,
        replayPassed: true,
        parentContextTokensAdded: 100,
        fallbackCount: 0,
        timeoutCount: 0,
      },
    }).overall).toBe("fail");
  });
});

describe("Phase C acceptance: gate report baseline vs candidate", () => {
  const baseline = {
    latencyMs: 1000,
    costUsd: 0.1,
    parentContextTokensAdded: 100,
    resultPacketTokens: 200,
    artifactReopenCount: 2,
    fallbackCount: 1,
    timeoutCount: 1,
  };

  const passingCandidate = {
    latencyMs: 1000,
    costUsd: 0.1,
    acceptancePassed: true,
    replayPassed: true,
    parentContextTokensAdded: 100,
    resultPacketTokens: 180,
    artifactReopenCount: 2,
    fallbackCount: 1,
    timeoutCount: 1,
  };

  it("all dimensions pass when candidate equals or beats baseline", () => {
    expect(compareCandidateGate({ baseline, candidate: passingCandidate })).toMatchObject({
      latency: "pass",
      cost: "pass",
      acceptance: "pass",
      replay: "pass",
      contextPollution: "pass",
      fallback: "pass",
      timeout: "pass",
      overall: "pass",
    });
  });

  it("latency regression fails overall", () => {
    const report = compareCandidateGate({
      baseline,
      candidate: { ...passingCandidate, latencyMs: 1001 },
    });

    expect(report.latency).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  it("cost regression fails overall", () => {
    const report = compareCandidateGate({
      baseline,
      candidate: { ...passingCandidate, costUsd: 0.11 },
    });

    expect(report.cost).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  it("unknown metrics produce unknown overall (not pass)", () => {
    const report = compareCandidateGate({
      baseline,
      candidate: { latencyMs: 900, costUsd: 0.09 },
    });

    expect(report.acceptance).toBe("unknown");
    expect(report.replay).toBe("unknown");
    expect(report.contextPollution).toBe("unknown");
    expect(report.fallback).toBe("unknown");
    expect(report.timeout).toBe("unknown");
    expect(report.overall).toBe("unknown");
  });

  it("unknown does not count as pass", () => {
    const report = compareCandidateGate({ baseline, candidate: {} });

    expect(report.overall).toBe("unknown");
    expect(report.unknownIsPass).toBe(false);
  });

  it("acceptance boolean gate", () => {
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, acceptancePassed: true } }).acceptance).toBe("pass");
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, acceptancePassed: false } }).acceptance).toBe("fail");
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, acceptancePassed: undefined } }).acceptance).toBe("unknown");
  });

  it("replay boolean gate", () => {
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, replayPassed: true } }).replay).toBe("pass");
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, replayPassed: false } }).replay).toBe("fail");
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, replayPassed: undefined } }).replay).toBe("unknown");
  });

  it("context pollution comparison covers parent, result packet, and artifact reopen metrics", () => {
    expect(compareCandidateGate({
      baseline,
      candidate: { ...passingCandidate, parentContextTokensAdded: 100, resultPacketTokens: 200, artifactReopenCount: 2 },
    }).contextPollution).toBe("pass");
    expect(compareCandidateGate({
      baseline,
      candidate: { ...passingCandidate, parentContextTokensAdded: 99 },
    }).contextPollution).toBe("pass");
    expect(compareCandidateGate({
      baseline,
      candidate: { ...passingCandidate, parentContextTokensAdded: 101 },
    }).contextPollution).toBe("fail");
    expect(compareCandidateGate({
      baseline,
      candidate: { ...passingCandidate, resultPacketTokens: 201 },
    }).contextPollution).toBe("fail");
    expect(compareCandidateGate({
      baseline,
      candidate: { ...passingCandidate, artifactReopenCount: 3 },
    }).contextPollution).toBe("fail");
    expect(compareCandidateGate({
      baseline,
      candidate: { ...passingCandidate, artifactReopenCount: undefined },
    }).contextPollution).toBe("unknown");
  });

  it("fallback count comparison", () => {
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, fallbackCount: 1 } }).fallback).toBe("pass");
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, fallbackCount: 0 } }).fallback).toBe("pass");
  });

  it("timeout count comparison", () => {
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, timeoutCount: 1 } }).timeout).toBe("pass");
    expect(compareCandidateGate({ baseline, candidate: { ...passingCandidate, timeoutCount: 0 } }).timeout).toBe("pass");
  });

  it("mixed pass and unknown produces unknown overall", () => {
    const report = compareCandidateGate({
      baseline,
      candidate: {
        latencyMs: 900,
        costUsd: 0.09,
        acceptancePassed: true,
        replayPassed: true,
      },
    });

    expect(report.latency).toBe("pass");
    expect(report.cost).toBe("pass");
    expect(report.acceptance).toBe("pass");
    expect(report.replay).toBe("pass");
    expect(report.contextPollution).toBe("unknown");
    expect(report.fallback).toBe("unknown");
    expect(report.timeout).toBe("unknown");
    expect(report.overall).toBe("unknown");
  });

  it("reasons array contains all dimension results", () => {
    expect(compareCandidateGate({
      baseline,
      candidate: { ...passingCandidate, costUsd: 0.11 },
    }).reasons).toEqual([
      "latency:pass",
      "cost:fail",
      "acceptance:pass",
      "replay:pass",
      "contextPollution:pass",
      "fallback:pass",
      "timeout:pass",
    ]);
  });

  it("only gate pass allows promotion", () => {
    const allowsPromotion = (overall: "pass" | "fail" | "unknown") => overall === "pass";

    expect(allowsPromotion(compareCandidateGate({ baseline, candidate: passingCandidate }).overall)).toBe(true);
    expect(allowsPromotion(compareCandidateGate({ baseline, candidate: { ...passingCandidate, latencyMs: 1001 } }).overall)).toBe(false);
    expect(allowsPromotion(compareCandidateGate({ baseline, candidate: {} }).overall)).toBe(false);
  });
});
