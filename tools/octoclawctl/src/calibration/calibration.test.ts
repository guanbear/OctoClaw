import { describe, expect, it } from "vitest";
import type {
  DeliveryLane,
  EvaluationLaneResult,
  NightlyReport,
  RouteQualityLane,
} from "../nightly/types.js";
import type {
  SlackAcceptanceCaseKind,
  SlackAcceptanceCaseResult,
  SlackAcceptanceReport,
} from "../slack-acceptance/types.js";
import type { CalibrationInputFile } from "./types.js";
import {
  compareCost,
  computeRecommendationStatus,
  normalizeCalibrationInputFile,
  runCalibrationGate,
} from "./gate.js";
import { renderCalibrationMarkdown } from "./report.js";

const allCaseKinds: SlackAcceptanceCaseKind[] = [
  "plain_chat",
  "fresh_lookup",
  "delegated_work",
  "status_panel",
  "provenance_followup",
  "route_objection_correction",
  "no_lie_materialized_no_spawn",
];

describe("calibration gate", () => {
  it("pass when all dimensions pass", () => {
    const baseline = makeInput();
    const candidate = makeInput({ nightlyReportId: "nightly-candidate", slackReportId: "slack-candidate" });

    const report = runCalibrationGate(baseline, candidate);

    expect(report.overallGate).toBe("pass");
    expect(report.recommendationStatus).toBe("recommend_only");
    expect(report.rollbackTarget).not.toBeNull();
  });

  it("fail when latency regresses", () => {
    const baseline = makeInput({ metrics: { latencyMs: 300, costUsd: 0.1 } });
    const candidate = makeInput({ metrics: { latencyMs: 500, costUsd: 0.1 } });

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.latency.status).toBe("fail");
    expect(report.overallGate).toBe("fail");
  });

  it("fail when acceptance regresses", () => {
    const baseline = makeInput();
    const candidate = makeInput({ slackCases: { no_lie_materialized_no_spawn: "fail" }, slackOverallGate: "fail" });

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.acceptance.status).toBe("fail");
  });

  it("fail when candidate acceptance is still failing even if baseline failed", () => {
    const baseline = makeInput({ slackOverallGate: "fail", slackCases: { plain_chat: "fail" } });
    const candidate = makeInput({ slackOverallGate: "fail", slackCases: { plain_chat: "fail" } });

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.acceptance.status).toBe("fail");
    expect(report.overallGate).toBe("fail");
  });

  it("unknown when candidate acceptance is unknown", () => {
    const candidate = makeInput({ slackCases: { status_panel: "unknown" }, slackOverallGate: "unknown" });

    const report = runCalibrationGate(makeInput(), candidate);

    expect(report.dimensions.acceptance.status).toBe("unknown");
    expect(report.overallGate).toBe("unknown");
  });

  it("fail when context pollution regresses", () => {
    const baseline = makeInput({ nightly: { delegationHealth: { parentContextTokensAddedP95: 1500 } } });
    const candidate = makeInput({ nightly: { delegationHealth: { parentContextTokensAddedP95: 2500 } } });

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.contextPollution.status).toBe("fail");
  });

  it("fail when fallback/timeout regresses", () => {
    const baseline = makeInput({ nightly: { executionTransition: { timedOutSent: 0 } } });
    const candidate = makeInput({ nightly: { executionTransition: { timedOutSent: 3 } } });

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.fallbackTimeout.status).toBe("fail");
  });

  it("fail when no-lie regresses", () => {
    const baseline = makeInput({ slackCases: { no_lie_materialized_no_spawn: "pass" } });
    const candidate = makeInput({ slackCases: { no_lie_materialized_no_spawn: "fail" }, slackOverallGate: "fail" });

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.noLie.status).toBe("fail");
  });

  it("unknown when candidate missing nightly report", () => {
    const baseline = makeInput();
    const candidate: CalibrationInputFile = { slackAcceptance: makeSlackAcceptanceReport() };

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.latency.status).toBe("unknown");
    expect(report.dimensions.cost.status).toBe("unknown");
    expect(report.dimensions.contextPollution.status).toBe("unknown");
    expect(report.dimensions.fallbackTimeout.status).toBe("unknown");
    expect(report.overallGate).toBe("unknown");
  });

  it("unknown when baseline missing nightly report", () => {
    const baseline: CalibrationInputFile = { slackAcceptance: makeSlackAcceptanceReport() };
    const candidate = makeInput();

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.latency.status).toBe("unknown");
    expect(report.dimensions.contextPollution.status).toBe("unknown");
    expect(report.dimensions.fallbackTimeout.status).toBe("unknown");
    expect(report.overallGate).toBe("unknown");
  });

  it("unknown when both missing slack acceptance", () => {
    const baseline: CalibrationInputFile = { nightly: makeNightlyReport() };
    const candidate: CalibrationInputFile = { nightly: makeNightlyReport() };

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.acceptance.status).toBe("unknown");
    expect(report.dimensions.noLie.status).toBe("unknown");
    expect(report.overallGate).toBe("unknown");
  });

  it("unknown when latency metric and nightly latency are missing", () => {
    const baseline = makeInput({ metrics: { costUsd: 0.1 }, nightly: { routeCommitAck: { ackMsP95: null, ackMsP50: null } } });
    const candidate = makeInput({ metrics: { latencyMs: 900, costUsd: 0.1 } });

    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.latency.status).toBe("unknown");
  });

  it("rollback target preserved when gate passes", () => {
    const baseline = makeInput({ nightlyReportId: "nightly-baseline" });
    const candidate = makeInput();

    const report = runCalibrationGate(baseline, candidate);

    expect(report.rollbackTarget).toBe("nightly-baseline");
  });

  it("rollback target null when gate fails", () => {
    const baseline = makeInput({ metrics: { latencyMs: 300, costUsd: 0.1 } });
    const candidate = makeInput({ metrics: { latencyMs: 500, costUsd: 0.1 } });

    const report = runCalibrationGate(baseline, candidate);

    expect(report.rollbackTarget).toBeNull();
  });

  it("rollback target null when gate is unknown", () => {
    const report = runCalibrationGate({}, {});

    expect(report.rollbackTarget).toBeNull();
  });

  it("no live mutation — gate function is pure", () => {
    const baseline = makeInput();
    const candidate = makeInput({ nightlyReportId: "candidate-nightly", slackReportId: "candidate-slack" });
    const baselineClone = cloneJson(baseline);
    const candidateClone = cloneJson(candidate);

    const report = runCalibrationGate(baseline, candidate);

    expect(baseline).toEqual(baselineClone);
    expect(candidate).toEqual(candidateClone);
    expect(report.schemaVersion).toBe("octoclaw.calibration.report/v1");
  });

  it("cost passes when candidate cost is not worse", () => {
    const result = compareCost(makeInput(), makeInput({ metrics: { costUsd: 0.08, latencyMs: 900 } }));
    const report = runCalibrationGate(makeInput(), makeInput({ metrics: { costUsd: 0.08, latencyMs: 900 } }));

    expect(result.status).toBe("pass");
    expect(report.dimensions.cost.status).toBe("pass");
  });

  it("cost regression fails overall", () => {
    const report = runCalibrationGate(makeInput(), makeInput({ metrics: { costUsd: 0.12, latencyMs: 900 } }));

    expect(report.dimensions.cost.status).toBe("fail");
    expect(report.overallGate).toBe("fail");
  });

  it("missing cost keeps overall unknown, not pass", () => {
    const baseline = makeInput({ metrics: { latencyMs: 1000 } });
    const candidate = makeInput({ metrics: { latencyMs: 900 } });
    const report = runCalibrationGate(baseline, candidate);

    expect(report.dimensions.cost.status).toBe("unknown");
    expect(report.overallGate).toBe("unknown");
    expect(report.recommendationStatus).toBe("unknown");
  });

  it("recommendationStatus matches overall gate", () => {
    expect(computeRecommendationStatus("pass")).toBe("recommend_only");
    expect(computeRecommendationStatus("fail")).toBe("blocked");
    expect(computeRecommendationStatus("unknown")).toBe("unknown");
  });

  it("unknown never equals pass", () => {
    const report = runCalibrationGate({}, {});

    expect(report.overallGate).toBe("unknown");
    expect(report.recommendationStatus).not.toBe("recommend_only");
  });

  it("markdown report contains all sections", () => {
    const markdown = renderCalibrationMarkdown(runCalibrationGate(makeInput(), makeInput()));

    expect(markdown).toContain("Calibration Gate Report");
    expect(markdown).toContain("Dimension Results");
    expect(markdown).toContain("Latency");
    expect(markdown).toContain("Cost");
    expect(markdown).toContain("Acceptance");
    expect(markdown).toContain("No-Lie");
    expect(markdown).toContain("Context Pollution");
    expect(markdown).toContain("Fallback/Timeout");
  });

  it("normalizes raw nightly reports", () => {
    const raw = makeNightlyReport({ reportId: "nightly-raw" });
    const input = normalizeCalibrationInputFile(raw);

    expect(input.nightly?.reportId).toBe("nightly-raw");
  });

  it("normalizes raw slack acceptance reports", () => {
    const raw = makeSlackAcceptanceReport({ reportId: "slack-raw" });
    const input = normalizeCalibrationInputFile(raw);

    expect(input.slackAcceptance?.reportId).toBe("slack-raw");
  });

  it("normalizes aggregate wrapper input", () => {
    const aggregate = makeInput({ rollbackTarget: "rollback-v1" });
    const input = normalizeCalibrationInputFile(aggregate);

    expect(input.rollbackTarget).toBe("rollback-v1");
    expect(input.nightly?.reportId).toBeDefined();
  });

  it("empty input files yield unknown overall", () => {
    const report = runCalibrationGate({}, {});

    expect(report.dimensions.latency.status).toBe("unknown");
    expect(report.dimensions.cost.status).toBe("unknown");
    expect(report.dimensions.acceptance.status).toBe("unknown");
    expect(report.dimensions.noLie.status).toBe("unknown");
    expect(report.dimensions.contextPollution.status).toBe("unknown");
    expect(report.dimensions.fallbackTimeout.status).toBe("unknown");
    expect(report.overallGate).toBe("unknown");
  });

  it("candidate same as baseline passes", () => {
    const input = makeInput();

    const report = runCalibrationGate(input, cloneJson(input));

    expect(report.dimensions.latency.status).toBe("pass");
    expect(report.dimensions.cost.status).toBe("pass");
    expect(report.dimensions.acceptance.status).toBe("pass");
    expect(report.dimensions.noLie.status).toBe("pass");
    expect(report.dimensions.contextPollution.status).toBe("pass");
    expect(report.dimensions.fallbackTimeout.status).toBe("pass");
  });
});

interface InputOptions {
  nightlyReportId?: string;
  slackReportId?: string;
  nightly?: NightlyOverrides;
  slackCases?: Partial<Record<SlackAcceptanceCaseKind, "pass" | "fail" | "unknown">>;
  slackOverallGate?: "pass" | "fail" | "unknown";
  metrics?: { latencyMs?: number; costUsd?: number };
  rollbackTarget?: string;
}

interface NightlyOverrides {
  routeCommitAck?: Partial<Extract<EvaluationLaneResult, { lane: "route_commit_ack" }>>;
  executionTransition?: Partial<Extract<EvaluationLaneResult, { lane: "execution_transition" }>>;
  delegationHealth?: Partial<Extract<EvaluationLaneResult, { lane: "delegation_health" }>>;
}

function makeInput(options: InputOptions = {}): CalibrationInputFile {
  return {
    nightly: makeNightlyReport({ reportId: options.nightlyReportId, lanes: options.nightly }),
    slackAcceptance: makeSlackAcceptanceReport({
      reportId: options.slackReportId,
      cases: options.slackCases,
      overallGate: options.slackOverallGate,
    }),
    metrics: options.metrics ?? { latencyMs: 1000, costUsd: 0.1 },
    rollbackTarget: options.rollbackTarget,
  };
}

function makeNightlyReport(options: { reportId?: string; lanes?: NightlyOverrides } = {}): NightlyReport {
  const routeQuality: RouteQualityLane = {
    lane: "route_quality",
    total: 10,
    pass: 10,
    fail: 0,
    unknown: 0,
    falseDelegate: 0,
    falseReply: 0,
    unclear: 0,
    protectedLaneMisroute: 0,
    statusRespawnRisk: 0,
    directPathLatency: 0,
    routeSourceDistribution: { policy: 10 },
    judgeTimeoutCount: 0,
    judgeFallbackCount: 0,
    samples: [],
  };
  const routeCommitAck: Extract<EvaluationLaneResult, { lane: "route_commit_ack" }> = {
    lane: "route_commit_ack",
    total: 10,
    pass: 10,
    fail: 0,
    unknown: 0,
    ackSent: 10,
    ackSkipped: 0,
    ackFailed: 0,
    ackDuplicate: 0,
    ackMissing: 0,
    ackNoTarget: 0,
    ackMsP50: 200,
    ackMsP95: 300,
    ackMsP99: 500,
    coverage: 1,
    samples: [],
    ...options.lanes?.routeCommitAck,
  };
  const executionTransition: Extract<EvaluationLaneResult, { lane: "execution_transition" }> = {
    lane: "execution_transition",
    total: 10,
    pass: 10,
    fail: 0,
    unknown: 0,
    dispatchedSent: 10,
    dispatchedSkipped: 0,
    materializedNoSpawnSent: 0,
    materializedNoSpawnSkipped: 0,
    spawnStartedSent: 10,
    spawnStartedSkipped: 0,
    spawnFailedSent: 0,
    spawnFailedSkipped: 0,
    queuedStaleSent: 0,
    queuedStaleSkipped: 0,
    heartbeatStaleSent: 0,
    heartbeatStaleSkipped: 0,
    timedOutSent: 0,
    timedOutSkipped: 0,
    resultReadySent: 10,
    resultReadySkipped: 0,
    deliveryFailedSent: 0,
    deliveryFailedSkipped: 0,
    dispatchToSpawnLatencyP50: 100,
    dispatchToSpawnLatencyP95: 200,
    resultReadyToDeliveryLatencyP50: 100,
    resultReadyToDeliveryLatencyP95: 200,
    samples: [],
    ...options.lanes?.executionTransition,
  };
  const delegationHealth: Extract<EvaluationLaneResult, { lane: "delegation_health" }> = {
    lane: "delegation_health",
    total: 10,
    pass: 10,
    fail: 0,
    unknown: 0,
    noSpawnCount: 0,
    spawnFailedCount: 0,
    staleCount: 0,
    timedOutCount: 0,
    resultOrphanCount: 0,
    contextPollutionCount: 0,
    parentContextTokensAddedMax: 2000,
    parentContextTokensAddedP95: 1500,
    resultPacketTokensMax: 1000,
    samples: [],
    ...options.lanes?.delegationHealth,
  };
  const delivery: DeliveryLane = {
    lane: "delivery",
    total: 10,
    pass: 10,
    fail: 0,
    unknown: 0,
    deliveryFailedCount: 0,
    retryDeferredCount: 0,
    compensatedCount: 0,
    samples: [],
  };

  return {
    reportId: options.reportId ?? "nightly-baseline",
    generatedAt: "2026-04-26T00:00:00.000Z",
    inputEventCount: 50,
    inputDateRange: { earliest: "2026-04-25T00:00:00.000Z", latest: "2026-04-26T00:00:00.000Z" },
    lanes: [routeQuality, routeCommitAck, executionTransition, delegationHealth, delivery],
    modelShadowComparison: {
      mode: "shadow",
      generatedAt: "2026-04-26T00:00:00.000Z",
      sourceEventCount: 0,
      comparedCount: 0,
      changedRecommendationCount: 0,
      matchedRecommendationCount: 0,
      promotionAllowedCount: 0,
      rollbackTargets: [],
      samples: [],
    },
    costSpeedBaseline: {
      generatedAt: "2026-04-26T00:00:00.000Z",
      sourceEventCount: 0,
      lanes: ["reply", "delegate", "flow"].map((lane) => ({
        lane: lane as "reply" | "delegate" | "flow",
        requestCount: 0,
        successCount: 0,
        ackMs: { p50: null, p95: null, p99: null },
        routeDecisionMs: { p50: null, p95: null, p99: null },
        taskMaterializeMs: { p50: null, p95: null, p99: null },
        queueWaitMs: { p50: null, p95: null, p99: null },
        firstProgressMs: { p50: null, p95: null, p99: null },
        finalDeliveryMs: { p50: null, p95: null, p99: null },
        totalLatencyMs: { p50: null, p95: null, p99: null },
        estimatedCostUsd: null,
        actualCostUsd: null,
        estimatedCostStatus: "unknown",
        actualCostStatus: "unknown",
        missingEstimatedCostCount: 0,
        missingActualCostCount: 0,
        costPerRequest: null,
        costPerSuccess: null,
        fallbackCount: 0,
        retryCount: 0,
        terminalStates: {},
        parentContextTokensAdded: { p50: null, p95: null, p99: null },
        resultPacketTokens: { p50: null, p95: null, p99: null },
        artifactReopenCount: { p50: null, p95: null, p99: null },
      })),
    },
    overallGate: "pass",
    recommendationStatus: "recommend_only",
    recommendation: "pass",
    rollbackTarget: null,
  };
}

function makeSlackAcceptanceReport(
  options: {
    reportId?: string;
    cases?: Partial<Record<SlackAcceptanceCaseKind, "pass" | "fail" | "unknown">>;
    overallGate?: "pass" | "fail" | "unknown";
  } = {},
): SlackAcceptanceReport {
  const cases = allCaseKinds.map((kind) => makeSlackCase(kind, options.cases?.[kind] ?? "pass"));
  const fail = cases.filter((current) => current.status === "fail").length;
  const unknown = cases.filter((current) => current.status === "unknown").length;
  const pass = cases.filter((current) => current.status === "pass").length;

  return {
    schemaVersion: "octoclaw.slack_acceptance.report/v1",
    reportId: options.reportId ?? "slack-baseline",
    generatedAt: "2026-04-26T00:00:00.000Z",
    sessionKey: "session-key",
    target: { channel: "C123" },
    overallGate: options.overallGate ?? (fail > 0 ? "fail" : unknown > 0 ? "unknown" : "pass"),
    total: cases.length,
    pass,
    fail,
    unknown,
    skipped: 0,
    toolExposureAudit: { status: "pass", exposedTools: [], blockedTools: [] },
    cases,
  };
}

function makeSlackCase(
  kind: SlackAcceptanceCaseKind,
  status: "pass" | "fail" | "unknown",
): SlackAcceptanceCaseResult {
  return {
    id: kind,
    kind,
    prompt: `prompt for ${kind}`,
    status,
    sentAt: "2026-04-26T00:00:00.000Z",
    threadTs: "123.456",
    ackMs: 100,
    finalMs: 1000,
    ack: { status, reason: "ack" },
    final: { status, reason: "final" },
    noSpawn: { status, reason: "no spawn" },
    transcript: [],
    errors: [],
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
