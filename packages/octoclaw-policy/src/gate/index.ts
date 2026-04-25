import type { HardBoundaryCheckResult } from "@octoclaw/contracts/schemas";

export interface HardBoundaryInput {
  explicitControlAction?: boolean;
  existingTaskBinding?: string;
  isRecoverySession?: boolean;
  permissionBoundaryTriggered?: boolean;
  dangerousWrite?: boolean;
}

export function checkHardBoundary(input: HardBoundaryInput): HardBoundaryCheckResult {
  if (input.explicitControlAction) {
    return { triggered: true, signal: "explicit_control_action", reason: "explicit control action detected" };
  }
  if (input.existingTaskBinding) {
    return {
      triggered: true,
      signal: "existing_task_binding",
      routeOverride: "delegate",
      reason: `bound to existing task ${input.existingTaskBinding}`,
    };
  }
  if (input.isRecoverySession) {
    return {
      triggered: true,
      signal: "recovery_session",
      routeOverride: "delegate",
      reason: "recovery session detected",
    };
  }
  if (input.permissionBoundaryTriggered) {
    return { triggered: true, signal: "permission_boundary", reason: "permission boundary triggered" };
  }
  if (input.dangerousWrite) {
    return { triggered: true, signal: "dangerous_write", reason: "dangerous write operation detected" };
  }
  return { triggered: false, signal: null, reason: "no hard boundary signal" };
}

export type GateCheckResult = "pass" | "fail" | "unknown";

export interface CandidateGateMetrics {
  latencyMs?: number;
  costUsd?: number;
  acceptancePassed?: boolean;
  replayPassed?: boolean;
  parentContextTokensAdded?: number;
  resultPacketTokens?: number;
  artifactReopenCount?: number;
  fallbackCount?: number;
  timeoutCount?: number;
}

export interface CandidateGateReport {
  latency: GateCheckResult;
  cost: GateCheckResult;
  acceptance: GateCheckResult;
  replay: GateCheckResult;
  contextPollution: GateCheckResult;
  fallback: GateCheckResult;
  timeout: GateCheckResult;
  overall: GateCheckResult;
  unknownIsPass: false;
  reasons: string[];
}

function compareLowerOrEqual(candidate: number | undefined, baseline: number | undefined): GateCheckResult {
  if (candidate === undefined || baseline === undefined) return "unknown";
  return candidate <= baseline ? "pass" : "fail";
}

function booleanGate(value: boolean | undefined): GateCheckResult {
  if (value === undefined) return "unknown";
  return value ? "pass" : "fail";
}

function combineGateResults(results: GateCheckResult[]): GateCheckResult {
  if (results.includes("fail")) return "fail";
  if (results.includes("unknown")) return "unknown";
  return "pass";
}

export function compareCandidateGate(input: {
  baseline: CandidateGateMetrics;
  candidate: CandidateGateMetrics;
}): CandidateGateReport {
  const contextPollution = combineGateResults([
    compareLowerOrEqual(input.candidate.parentContextTokensAdded, input.baseline.parentContextTokensAdded),
    compareLowerOrEqual(input.candidate.resultPacketTokens, input.baseline.resultPacketTokens),
    compareLowerOrEqual(input.candidate.artifactReopenCount, input.baseline.artifactReopenCount),
  ]);
  const checks = {
    latency: compareLowerOrEqual(input.candidate.latencyMs, input.baseline.latencyMs),
    cost: compareLowerOrEqual(input.candidate.costUsd, input.baseline.costUsd),
    acceptance: booleanGate(input.candidate.acceptancePassed),
    replay: booleanGate(input.candidate.replayPassed),
    contextPollution,
    fallback: compareLowerOrEqual(input.candidate.fallbackCount, input.baseline.fallbackCount),
    timeout: compareLowerOrEqual(input.candidate.timeoutCount, input.baseline.timeoutCount),
  };
  const values = Object.values(checks);
  const overall: GateCheckResult = values.includes("fail") ? "fail" : values.includes("unknown") ? "unknown" : "pass";
  const reasons = Object.entries(checks).map(([key, value]) => `${key}:${value}`);
  return { ...checks, overall, unknownIsPass: false, reasons };
}
