import type { NightlyReport, NightlyReplayFilterOptions } from "../nightly/types.js";
import { renderMarkdownReport } from "../nightly/report.js";
import type { SlackAcceptanceReport } from "../slack-acceptance/types.js";
import { renderSlackAcceptanceMarkdown } from "../slack-acceptance/report.js";
import type { CalibrationGateReport, GateCheckResult, RecommendationStatus } from "../calibration/types.js";
import { renderCalibrationMarkdown } from "../calibration/report.js";
import { renderNightlyEvalMarkdown } from "./report.js";
import type { EvalStepResult, NightlyEvalAggregateReport, NightlyEvalConfig } from "./types.js";
import { readStoredBaseline } from "./baseline.js";

const SECRET_KEYS = new Set(["token", "authorization", "botToken", "apiKey", "secret", "password"]);
const TRANSCRIPT_KEYS = new Set(["rawTranscript", "childTranscript", "workerChainOfThought", "executionLog"]);

export interface RunNightlyEvalParams {
  config: NightlyEvalConfig;
  outputDir: string;
  env: Record<string, string | undefined>;
  openclawHome?: string;
  nightlyRunner: (replayPath: string, filter: NightlyReplayFilterOptions) => Promise<NightlyReport>;
  slackRunner?: (configPath: string, env: Record<string, string | undefined>) => Promise<SlackAcceptanceReport>;
  calibrationRunner?: (baselinePath: string, candidatePath: string) => Promise<CalibrationGateReport>;
  fileWriter?: (path: string, content: string) => Promise<void>;
}

export function parseNightlyEvalConfig(raw: unknown): NightlyEvalConfig {
  if (!isRecord(raw)) {
    throw new Error("replayPath is required");
  }

  const replayPath = nonEmptyString(raw.replayPath) ? raw.replayPath : undefined;
  if (replayPath === undefined) {
    throw new Error("replayPath is required");
  }

  const baselinePresent = "baseline" in raw && raw.baseline !== undefined;
  const candidatePresent = "candidate" in raw && raw.candidate !== undefined;
  if (baselinePresent !== candidatePresent) {
    throw new Error("calibration requires both baseline and candidate");
  }

  const config: NightlyEvalConfig = { replayPath };
  if (raw.lookbackHours !== undefined) {
    const lookbackHours = Number(raw.lookbackHours);
    if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
      throw new Error("lookbackHours must be a positive number");
    }
    config.lookbackHours = lookbackHours;
  }
  if (raw.excludeSynthetic !== undefined) {
    if (typeof raw.excludeSynthetic !== "boolean") {
      throw new Error("excludeSynthetic must be a boolean");
    }
    config.excludeSynthetic = raw.excludeSynthetic;
  }
  if (raw.slackAcceptanceConfig !== undefined) {
    if (!nonEmptyString(raw.slackAcceptanceConfig)) {
      throw new Error("slackAcceptanceConfig must be a non-empty string");
    }
    config.slackAcceptanceConfig = raw.slackAcceptanceConfig;
  }

  if (baselinePresent && candidatePresent) {
    if (!nonEmptyString(raw.baseline) || !nonEmptyString(raw.candidate)) {
      throw new Error("calibration requires both baseline and candidate");
    }
    config.baseline = raw.baseline;
    config.candidate = raw.candidate;
  }

  return config;
}

export function computeEvalOverallGate(steps: {
  nightly: EvalStepResult<unknown>;
  slackAcceptance: EvalStepResult<unknown>;
  calibration: EvalStepResult<unknown>;
}): GateCheckResult {
  const statuses = Object.values(steps).map((step) => step.status).filter((status) => status !== "skipped");
  if (statuses.includes("fail")) {
    return "fail";
  }
  if (statuses.includes("unknown")) {
    return "unknown";
  }
  if (statuses.includes("pass")) {
    return "pass";
  }
  return "unknown";
}

export function computeEvalRecommendationStatus(gate: GateCheckResult): RecommendationStatus {
  if (gate === "pass") {
    return "recommend_only";
  }
  if (gate === "fail") {
    return "blocked";
  }
  return "unknown";
}

export function buildEvalRecommendation(
  gate: GateCheckResult,
  _steps: {
    nightly: EvalStepResult<unknown>;
    slackAcceptance: EvalStepResult<unknown>;
    calibration: EvalStepResult<unknown>;
  },
): string {
  if (gate === "pass") {
    return "All evaluation steps passed; keep recommend-only status.";
  }
  if (gate === "fail") {
    return "One or more evaluation steps failed; block promotion and investigate.";
  }
  return "Evaluation evidence is incomplete; do not promote.";
}

export async function runNightlyEval(params: RunNightlyEvalParams): Promise<NightlyEvalAggregateReport> {
  const writer = params.fileWriter ?? (async () => undefined);
  const generatedAt = new Date().toISOString();
  const artifactPrefix = generatedAt.slice(0, 19).replace(/[T:]/gu, "-");
  const nightly = await runStep(
    "nightly",
    `${params.outputDir}/${artifactPrefix}-nightly.json`,
    `${params.outputDir}/${artifactPrefix}-nightly.md`,
    () => params.nightlyRunner(params.config.replayPath, {
      lookbackHours: params.config.lookbackHours,
      excludeSynthetic: params.config.excludeSynthetic,
    }),
    renderMarkdownReport,
    writer,
  );

  const slackAcceptance = params.config.slackAcceptanceConfig === undefined
    ? skippedStep<SlackAcceptanceReport>("slackAcceptance", "slack acceptance config not provided")
    : await runStep(
      "slackAcceptance",
      `${params.outputDir}/${artifactPrefix}-slack-acceptance.json`,
      `${params.outputDir}/${artifactPrefix}-slack-acceptance.md`,
      () => {
        if (params.slackRunner === undefined) {
          throw new Error("slackRunner is required when slackAcceptanceConfig is configured");
        }
        return params.slackRunner(params.config.slackAcceptanceConfig ?? "", params.env);
      },
      renderSlackAcceptanceMarkdown,
      writer,
    );

  // Determine calibration baseline/candidate.
  // Explicit config takes precedence; otherwise auto-detect stored baseline.
  let calibrationBaseline = params.config.baseline;
  let calibrationCandidate = params.config.candidate;
  let autoBaselineUsed = false;

  if (!calibrationBaseline && !calibrationCandidate && params.calibrationRunner) {
    const storedBaseline = await readStoredBaseline(params.openclawHome);
    if (storedBaseline && nightly.artifactPaths?.json) {
      calibrationBaseline = storedBaseline.reportPath;
      calibrationCandidate = nightly.artifactPaths.json;
      autoBaselineUsed = true;
    }
  }

  const calibration = calibrationBaseline === undefined || calibrationCandidate === undefined
    ? skippedStep<CalibrationGateReport>("calibration", autoBaselineUsed ? "no stored baseline available" : "baseline and candidate not provided")
    : await runStep(
        "calibration",
        `${params.outputDir}/${artifactPrefix}-calibration.json`,
        `${params.outputDir}/${artifactPrefix}-calibration.md`,
        () => {
          if (params.calibrationRunner === undefined) {
            throw new Error("calibrationRunner is required when calibration is configured");
          }
          return params.calibrationRunner(calibrationBaseline ?? "", calibrationCandidate ?? "");
        },
        renderCalibrationMarkdown,
        writer,
      );

  const steps = { nightly, slackAcceptance, calibration };
  const overallGate = computeEvalOverallGate(steps);
  const recommendationStatus = computeEvalRecommendationStatus(overallGate);
  const recommendation = buildEvalRecommendation(overallGate, steps);
  const report: NightlyEvalAggregateReport = {
    schemaVersion: "octoclaw.nightly_eval.report/v1",
    reportId: `nightly-eval:${generatedAt}`,
    generatedAt,
    config: {
      replayPath: params.config.replayPath,
      lookbackHours: params.config.lookbackHours,
      excludeSynthetic: params.config.excludeSynthetic,
      slackAcceptanceEnabled: params.config.slackAcceptanceConfig !== undefined,
      calibrationEnabled: calibrationBaseline !== undefined && calibrationCandidate !== undefined,
    },
    steps,
    overallGate,
    recommendationStatus,
    recommendation,
    artifactDir: params.outputDir,
  };

  await writer(`${params.outputDir}/${artifactPrefix}-nightly-eval.json`, `${JSON.stringify(sanitizeAggregateReport(report), null, 2)}\n`);
  await writer(`${params.outputDir}/${artifactPrefix}-nightly-eval.md`, renderNightlyEvalMarkdown(sanitizeAggregateReport(report) as NightlyEvalAggregateReport));
  return report;
}

export function sanitizeAggregateReport(report: NightlyEvalAggregateReport): unknown {
  return sanitizeValue(report);
}

async function runStep<T>(
  step: string,
  jsonPath: string,
  markdownPath: string,
  runner: () => Promise<T>,
  markdownRenderer: (report: T) => string,
  writer: (path: string, content: string) => Promise<void>,
): Promise<EvalStepResult<T>> {
  try {
    const report = await runner();
    await writer(jsonPath, `${JSON.stringify(sanitizeValue(report), null, 2)}\n`);
    await writer(markdownPath, markdownRenderer(report));
    return {
      step,
      status: statusFromReport(report),
      reason: "step completed",
      report,
      artifactPaths: { json: jsonPath, markdown: markdownPath },
    };
  } catch (error) {
    return {
      step,
      status: "fail",
      reason: errorReason(error),
      artifactPaths: { json: jsonPath, markdown: markdownPath },
    };
  }
}

function skippedStep<T>(step: string, reason: string): EvalStepResult<T> {
  return { step, status: "skipped", reason };
}

function statusFromReport(report: unknown): "pass" | "fail" | "unknown" {
  if (isRecord(report) && (report.overallGate === "pass" || report.overallGate === "fail" || report.overallGate === "unknown")) {
    return report.overallGate;
  }
  return "unknown";
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(key) || lower.includes("token") || lower.includes("secret")) {
      output[key] = "[REDACTED]";
      continue;
    }
    if (TRANSCRIPT_KEYS.has(key)) {
      output[key] = "[STRIPPED]";
      continue;
    }
    output[key] = sanitizeValue(entry);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function errorReason(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : String(error));
}

function redactSecretText(text: string): string {
  return text
    .replace(/xox[baprs]-[A-Za-z0-9-]+/gu, "[REDACTED]")
    .replace(/(token|secret|password|api[_-]?key)=([^\s]+)/giu, "$1=[REDACTED]");
}
