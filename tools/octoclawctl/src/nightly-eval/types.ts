import type { NightlyReport } from "../nightly/types.js";
import type { SlackAcceptanceReport } from "../slack-acceptance/types.js";
import type { CalibrationGateReport } from "../calibration/types.js";
import type { GateCheckResult, RecommendationStatus } from "../calibration/types.js";

// The config JSON file for nightly-eval
export interface NightlyEvalConfig {
  // D3 nightly: required
  replayPath: string;
  // D3 replay filter: nightly-eval defaults to a 24h recent window.
  lookbackHours?: number;
  excludeSynthetic?: boolean;
  // D4 slack acceptance: optional
  slackAcceptanceConfig?: string;
  // D5 calibration gate: optional (both required if either present)
  baseline?: string;
  candidate?: string;
}

export type EvalStepStatus = "pass" | "fail" | "unknown" | "skipped";

export interface EvalStepResult<T> {
  step: string;
  status: EvalStepStatus;
  reason: string;
  report?: T;
  artifactPaths?: { json?: string; markdown?: string };
}

export interface NightlyEvalAggregateReport {
  schemaVersion: "octoclaw.nightly_eval.report/v1";
  reportId: string;
  generatedAt: string;
  config: {
    replayPath: string;
    lookbackHours?: number;
    excludeSynthetic?: boolean;
    slackAcceptanceEnabled: boolean;
    calibrationEnabled: boolean;
  };
  steps: {
    nightly: EvalStepResult<NightlyReport>;
    slackAcceptance: EvalStepResult<SlackAcceptanceReport>;
    calibration: EvalStepResult<CalibrationGateReport>;
  };
  overallGate: GateCheckResult;
  recommendationStatus: RecommendationStatus;
  recommendation: string;
  artifactDir: string;
}

export interface LaunchAgentConfig {
  label: string;          // e.g. "ai.octoclaw.nightly-eval"
  nodePath: string;       // absolute path to node executable
  cliPath: string;        // absolute path to octoclawctl CLI JS entry
  configPath: string;     // absolute path to nightly-eval config JSON
  outputDir: string;      // absolute path to output directory
  scheduleHour: number;   // 0-23, default 2
  logDir: string;         // absolute path for stdout/stderr logs
}
