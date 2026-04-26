import type { AcceptanceGate, SlackAcceptanceCaseKind } from "../slack-acceptance/types.js";
import type {
  CalibrationGateReport,
  CalibrationInputFile,
  DelegationHealthLane,
  DimensionResult,
  ExecutionTransitionLane,
  GateCheckResult,
  RecommendationStatus,
  RouteCommitAckLane,
} from "./types.js";

interface ExtractedNumber {
  status: GateCheckResult;
  reason: string;
  value: number | null;
}

const noSlackAcceptanceReport: DimensionResult = { status: "unknown", reason: "no slack acceptance report" };
const noNightlyReport: DimensionResult = { status: "unknown", reason: "no nightly report" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCalibrationInputFile(raw: unknown): CalibrationInputFile {
  if (!isRecord(raw)) {
    return {};
  }
  if ("nightly" in raw || "slackAcceptance" in raw || "metrics" in raw) {
    return raw as CalibrationInputFile;
  }
  if (raw.schemaVersion === "octoclaw.slack_acceptance.report/v1") {
    return { slackAcceptance: raw as unknown as CalibrationInputFile["slackAcceptance"] };
  }
  if (Array.isArray(raw.lanes) && typeof raw.reportId === "string") {
    return { nightly: raw as unknown as CalibrationInputFile["nightly"] };
  }
  return {};
}

export function compareLowerOrEqual(
  candidate: number | undefined | null,
  baseline: number | undefined | null,
): GateCheckResult {
  if (candidate === undefined || candidate === null || baseline === undefined || baseline === null) {
    return "unknown";
  }

  return candidate <= baseline ? "pass" : "fail";
}

export function combineGateResults(results: GateCheckResult[]): GateCheckResult {
  if (results.includes("fail")) {
    return "fail";
  }

  if (results.includes("unknown")) {
    return "unknown";
  }

  return "pass";
}

export function computeRecommendationStatus(gate: GateCheckResult): RecommendationStatus {
  if (gate === "pass") {
    return "recommend_only";
  }

  if (gate === "fail") {
    return "blocked";
  }

  return "unknown";
}

export function extractLatency(input: CalibrationInputFile): DimensionResult {
  const extracted = extractLatencyValue(input);
  return { status: extracted.status, reason: extracted.reason };
}

export function compareLatency(baseline: CalibrationInputFile, candidate: CalibrationInputFile): DimensionResult {
  const baselineLatency = extractLatencyValue(baseline);
  const candidateLatency = extractLatencyValue(candidate);
  if (baselineLatency.status === "unknown") {
    return { status: "unknown", reason: baselineLatency.reason };
  }
  if (candidateLatency.status === "unknown") {
    return { status: "unknown", reason: candidateLatency.reason };
  }

  const status = compareLowerOrEqual(candidateLatency.value, baselineLatency.value);
  return {
    status,
    reason:
      status === "pass"
        ? `candidate ACK latency ${formatMetric(candidateLatency.value)} <= baseline ${formatMetric(baselineLatency.value)}`
        : `candidate ACK latency ${formatMetric(candidateLatency.value)} > baseline ${formatMetric(baselineLatency.value)}`,
  };
}

export function compareCost(
  baseline: CalibrationInputFile,
  candidate: CalibrationInputFile,
): DimensionResult {
  const baselineCost = baseline.metrics?.costUsd;
  const candidateCost = candidate.metrics?.costUsd;
  const status = compareLowerOrEqual(candidateCost, baselineCost);
  if (status === "unknown") {
    return {
      status,
      reason: "cost metrics missing; unknown cannot pass",
    };
  }

  return {
    status,
    reason:
      status === "pass"
        ? `candidate cost ${formatMetric(candidateCost ?? null)} <= baseline ${formatMetric(baselineCost ?? null)}`
        : `candidate cost ${formatMetric(candidateCost ?? null)} > baseline ${formatMetric(baselineCost ?? null)}`,
  };
}

export function compareAcceptance(baseline: CalibrationInputFile, candidate: CalibrationInputFile): DimensionResult {
  const baselineReport = baseline.slackAcceptance;
  const candidateReport = candidate.slackAcceptance;
  if (baselineReport === undefined || candidateReport === undefined) {
    return noSlackAcceptanceReport;
  }

  const results: DimensionResult[] = [compareAcceptanceGate(baselineReport.overallGate, candidateReport.overallGate)];
  for (const baselineCase of baselineReport.cases) {
    const candidateCase = candidateReport.cases.find((current) => current.kind === baselineCase.kind);
    if (candidateCase === undefined) {
      results.push({ status: "unknown", reason: `candidate missing acceptance case ${baselineCase.kind}` });
    } else if (candidateCase.status === "fail") {
      results.push({ status: "fail", reason: `acceptance case ${baselineCase.kind} is failing` });
    } else if (candidateCase.status === "unknown") {
      results.push({ status: "unknown", reason: `acceptance case ${baselineCase.kind} is unknown` });
    } else {
      results.push({ status: "pass", reason: `acceptance case ${baselineCase.kind} passed` });
    }
  }

  return combineDimensionResults(results, "acceptance did not regress");
}

export function compareNoLie(baseline: CalibrationInputFile, candidate: CalibrationInputFile): DimensionResult {
  const results: DimensionResult[] = [];
  results.push(compareNoLieAcceptanceCase(baseline, candidate));
  results.push(compareMaterializedNoSpawn(baseline, candidate));
  return combineDimensionResults(results, "no-lie and materialized-no-spawn signals did not regress");
}

export function compareContextPollution(baseline: CalibrationInputFile, candidate: CalibrationInputFile): DimensionResult {
  const baselineLane = getDelegationHealthLane(baseline);
  const candidateLane = getDelegationHealthLane(candidate);
  if (baselineLane === undefined || candidateLane === undefined) {
    return missingNightlyOrLane(baseline, candidate, "delegation_health");
  }

  const results = [
    compareNamedMetric("parentContextTokensAddedP95", baselineLane.parentContextTokensAddedP95, candidateLane.parentContextTokensAddedP95),
    compareNamedMetric("parentContextTokensAddedMax", baselineLane.parentContextTokensAddedMax, candidateLane.parentContextTokensAddedMax),
    compareNamedMetric("contextPollutionCount", baselineLane.contextPollutionCount, candidateLane.contextPollutionCount),
  ];

  return combineDimensionResults(results, "context pollution did not regress");
}

export function compareFallbackTimeout(baseline: CalibrationInputFile, candidate: CalibrationInputFile): DimensionResult {
  const baselineLane = getExecutionTransitionLane(baseline);
  const candidateLane = getExecutionTransitionLane(candidate);
  if (baselineLane === undefined || candidateLane === undefined) {
    return missingNightlyOrLane(baseline, candidate, "execution_transition");
  }

  const results = [
    compareNamedMetric(
      "timedOut",
      baselineLane.timedOutSent + baselineLane.timedOutSkipped,
      candidateLane.timedOutSent + candidateLane.timedOutSkipped,
    ),
    compareNamedMetric(
      "queuedStale",
      baselineLane.queuedStaleSent + baselineLane.queuedStaleSkipped,
      candidateLane.queuedStaleSent + candidateLane.queuedStaleSkipped,
    ),
    compareNamedMetric(
      "heartbeatStale",
      baselineLane.heartbeatStaleSent + baselineLane.heartbeatStaleSkipped,
      candidateLane.heartbeatStaleSent + candidateLane.heartbeatStaleSkipped,
    ),
  ];

  return combineDimensionResults(results, "fallback and timeout signals did not regress");
}

export function runCalibrationGate(
  baseline: CalibrationInputFile,
  candidate: CalibrationInputFile,
): CalibrationGateReport {
  const generatedAt = new Date().toISOString();
  const dimensions = {
    latency: compareLatency(baseline, candidate),
    cost: compareCost(baseline, candidate),
    acceptance: compareAcceptance(baseline, candidate),
    noLie: compareNoLie(baseline, candidate),
    contextPollution: compareContextPollution(baseline, candidate),
    fallbackTimeout: compareFallbackTimeout(baseline, candidate),
  };
  const overallGate = combineGateResults(Object.values(dimensions).map((dimension) => dimension.status));

  return {
    schemaVersion: "octoclaw.calibration.report/v1",
    reportId: `calibration:${generatedAt}`,
    generatedAt,
    baseline: {
      source: "baseline",
      nightlyReportId: baseline.nightly?.reportId,
      slackReportId: baseline.slackAcceptance?.reportId,
    },
    candidate: {
      source: "candidate",
      nightlyReportId: candidate.nightly?.reportId,
      slackReportId: candidate.slackAcceptance?.reportId,
    },
    dimensions,
    overallGate,
    recommendationStatus: computeRecommendationStatus(overallGate),
    recommendation: recommendationForGate(overallGate),
    rollbackTarget: overallGate === "pass" ? baseline.rollbackTarget ?? baseline.nightly?.rollbackTarget ?? baseline.nightly?.reportId ?? baseline.slackAcceptance?.reportId ?? null : null,
  };
}

function extractLatencyValue(input: CalibrationInputFile): ExtractedNumber {
  if (input.metrics?.latencyMs !== undefined) {
    return { status: "pass", reason: "latency metric available", value: input.metrics.latencyMs };
  }
  if (input.nightly === undefined) {
    return { status: "unknown", reason: "no nightly report", value: null };
  }

  const lane = getRouteCommitAckLane(input);
  if (lane === undefined || (lane.ackMsP95 === null && lane.ackMsP50 === null)) {
    return { status: "unknown", reason: "no ACK latency data", value: null };
  }

  return { status: "pass", reason: "ACK latency data available", value: lane.ackMsP95 ?? lane.ackMsP50 };
}

function getRouteCommitAckLane(input: CalibrationInputFile): RouteCommitAckLane | undefined {
  return input.nightly?.lanes.find((lane) => lane.lane === "route_commit_ack");
}

function getExecutionTransitionLane(input: CalibrationInputFile): ExecutionTransitionLane | undefined {
  return input.nightly?.lanes.find((lane) => lane.lane === "execution_transition");
}

function getDelegationHealthLane(input: CalibrationInputFile): DelegationHealthLane | undefined {
  return input.nightly?.lanes.find((lane) => lane.lane === "delegation_health");
}

function compareAcceptanceGate(_baseline: AcceptanceGate, candidate: AcceptanceGate): DimensionResult {
  if (candidate === "pass") {
    return { status: "pass", reason: "candidate overall acceptance gate passed" };
  }
  if (candidate === "fail") {
    return { status: "fail", reason: "candidate overall acceptance gate failed" };
  }
  return { status: "unknown", reason: "candidate overall acceptance gate unknown" };
}

function compareNoLieAcceptanceCase(baseline: CalibrationInputFile, candidate: CalibrationInputFile): DimensionResult {
  const kind: SlackAcceptanceCaseKind = "no_lie_materialized_no_spawn";
  const baselineCase = baseline.slackAcceptance?.cases.find((current) => current.kind === kind);
  const candidateCase = candidate.slackAcceptance?.cases.find((current) => current.kind === kind);
  if (baselineCase === undefined || candidateCase === undefined) {
    return { status: "unknown", reason: "no-lie acceptance case missing" };
  }

  if (candidateCase.status === "fail") {
    return { status: "fail", reason: "no-lie acceptance case is failing" };
  }
  if (candidateCase.status === "unknown") {
    return { status: "unknown", reason: "no-lie acceptance case is unknown" };
  }

  return { status: "pass", reason: "no-lie acceptance case passed" };
}

function compareMaterializedNoSpawn(baseline: CalibrationInputFile, candidate: CalibrationInputFile): DimensionResult {
  const baselineLane = getExecutionTransitionLane(baseline);
  const candidateLane = getExecutionTransitionLane(candidate);
  if (baselineLane === undefined || candidateLane === undefined) {
    return missingNightlyOrLane(baseline, candidate, "execution_transition");
  }

  return compareNamedMetric(
    "materializedNoSpawn",
    baselineLane.materializedNoSpawnSent + baselineLane.materializedNoSpawnSkipped,
    candidateLane.materializedNoSpawnSent + candidateLane.materializedNoSpawnSkipped,
  );
}

function compareNamedMetric(name: string, baseline: number | null, candidate: number | null): DimensionResult {
  const status = compareLowerOrEqual(candidate, baseline);
  if (status === "unknown") {
    return { status, reason: `${name} metric unavailable` };
  }

  return {
    status,
    reason:
      status === "pass"
        ? `${name} candidate ${candidate} <= baseline ${baseline}`
        : `${name} candidate ${candidate} > baseline ${baseline}`,
  };
}

function combineDimensionResults(results: DimensionResult[], passReason: string): DimensionResult {
  const status = combineGateResults(results.map((result) => result.status));
  if (status === "pass") {
    return { status, reason: passReason };
  }

  return { status, reason: results.filter((result) => result.status === status).map((result) => result.reason).join("; ") };
}

function missingNightlyOrLane(
  baseline: CalibrationInputFile,
  candidate: CalibrationInputFile,
  lane: string,
): DimensionResult {
  if (baseline.nightly === undefined || candidate.nightly === undefined) {
    return noNightlyReport;
  }

  return { status: "unknown", reason: `missing ${lane} lane` };
}

function recommendationForGate(gate: GateCheckResult): string {
  if (gate === "pass") {
    return "Candidate is not worse than baseline on available calibration dimensions; keep rollout recommend-only.";
  }

  if (gate === "fail") {
    return "Candidate regressed on at least one calibration dimension; block promotion and investigate before rollout.";
  }

  return "Calibration evidence is incomplete; do not treat unknown as pass and collect missing reports or metrics.";
}

function formatMetric(value: number | null): string {
  return value === null ? "unknown" : String(value);
}
