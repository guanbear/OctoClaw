import type {
  DelegationHealthLane,
  ExecutionTransitionLane,
  NightlyReport,
  RouteCommitAckLane,
} from "../nightly/types.js";
import type { SlackAcceptanceReport } from "../slack-acceptance/types.js";

export type GateCheckResult = "pass" | "fail" | "unknown";
export type RecommendationStatus = "recommend_only" | "unknown" | "blocked";

export interface CalibrationMetrics {
  latencyMs?: number;
  costUsd?: number;
}

export interface CalibrationInputFile {
  nightly?: NightlyReport;
  slackAcceptance?: SlackAcceptanceReport;
  metrics?: CalibrationMetrics;
  rollbackTarget?: string;
}

export interface DimensionResult {
  status: GateCheckResult;
  reason: string;
}

export interface CalibrationGateReport {
  schemaVersion: "octoclaw.calibration.report/v1";
  reportId: string;
  generatedAt: string;
  baseline: { source: string; nightlyReportId?: string; slackReportId?: string };
  candidate: { source: string; nightlyReportId?: string; slackReportId?: string };
  dimensions: {
    latency: DimensionResult;
    cost: DimensionResult;
    acceptance: DimensionResult;
    noLie: DimensionResult;
    contextPollution: DimensionResult;
    fallbackTimeout: DimensionResult;
  };
  overallGate: GateCheckResult;
  recommendationStatus: RecommendationStatus;
  recommendation: string;
  rollbackTarget: string | null;
}

export type { DelegationHealthLane, ExecutionTransitionLane, NightlyReport, RouteCommitAckLane, SlackAcceptanceReport };
