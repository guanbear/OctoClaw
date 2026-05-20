import fs from "node:fs/promises";
import path from "node:path";
import { buildCatalogCasePack } from "./catalog.js";
import { sanitizeStabilityArtifact } from "./sanitize.js";
import { buildAiReviewPrompt, classifyStabilityFailure, evaluateFixDraftGuard, shouldRunFixDraft } from "./ai.js";
import { runNightlyReplayStabilityLane, runSyntheticStabilityFixture, type SyntheticFixture } from "./synthetic.js";
import { REPORT_SCHEMA_VERSION, type StabilityFailurePacket, type StabilityGate, type StabilityLaneResult, type StabilityReport, type StabilityRunKind } from "./types.js";

export interface StabilityRunnerOptions {
  subcommand: "post-deploy" | "nightly" | "full" | "review-latest" | "fix-draft";
  outputDir: string;
  cadence?: string;
  config?: string;
  env: Record<string, string | undefined>;
  openclawHome?: string;
  liveSlackReport?: StabilityLiveSlackReport;
}

export interface StabilityRunnerResult {
  reportPath?: string;
  markdownPath?: string;
  summaryPath?: string;
  overallGate: StabilityGate;
  lanes: StabilityLaneResult[];
  failures: StabilityFailurePacket[];
  skippedLiveReason?: string;
  fixDraftSummary?: string;
}

export interface StabilityLiveSlackReport {
  overallGate: StabilityGate;
  cases: Array<{
    id: string;
    status: StabilityGate;
    threadTs?: string;
    errors?: string[];
    progress?: Array<{ event: string; elapsedMs?: number; detail?: string }>;
    replayEvidence?: {
      footerRoute?: string;
      footerModel?: string;
      footerDifficulty?: string;
      footerVia?: string;
      workContractId?: string;
      spawnIntentId?: string;
      runId?: string;
      childSessionKey?: string;
      stageMs?: Record<string, number>;
    };
  }>;
}

const DEFAULT_CADENCE = "3d";
const STABILITY_REPORT_DIR = "stability-smoke-v2";

export function parseCadence(value: string | undefined): string {
  if (!value) return DEFAULT_CADENCE;
  const match = /^(\d+)([dhm])$/u.exec(value.trim());
  if (!match) throw new Error(`Invalid cadence: ${value}. Expected format like 3d, 12h, 30m`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function hasStabilitySlackEnv(env: Record<string, string | undefined>, configPath?: string): Promise<boolean> {
  if (!configPath) return Boolean(env.SLACK_BOT_TOKEN?.trim());
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(raw)) return false;
  const botTokenEnv = asString(raw.botTokenEnv);
  if (!botTokenEnv || !env[botTokenEnv]?.trim()) return false;
  const userTokenEnv = asString(raw.userTokenEnv);
  return !userTokenEnv || Boolean(env[userTokenEnv]?.trim());
}

function runKindForSubcommand(subcommand: StabilityRunnerOptions["subcommand"]): StabilityRunKind {
  switch (subcommand) {
    case "post-deploy": return "post_deploy";
    case "nightly": return "nightly";
    case "full": return "full_3d";
    default: return "manual";
  }
}

async function ensureStabilityOutputDir(outputDir: string): Promise<string> {
  const dir = path.join(outputDir, STABILITY_REPORT_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function reportTimestamp(): string {
  return new Date().toISOString().replace(/[T:.]/gu, "-").slice(0, 19);
}

function computeOverallGate(lanes: StabilityLaneResult[]): StabilityGate {
  if (lanes.some((lane) => lane.gate === "fail")) return "fail";
  if (lanes.every((lane) => lane.gate === "pass")) return "pass";
  return "unknown";
}

function renderCompactStabilitySummary(report: StabilityReport): string {
  const lines = [
    `Stability Smoke v2: ${report.runKind}`,
    `Gate: ${report.overallGate}`,
    `Lanes: ${report.lanes.map((lane) => `${lane.name}=${lane.gate}`).join(" ")}`,
  ];
  if (report.failures.length > 0) {
    lines.push(`Failures (${report.failures.length}): ${report.failures.slice(0, 8).map((failure) => `${failure.caseId}:${failure.code}`).join(", ")}${report.failures.length > 8 ? " ..." : ""}`);
  } else {
    lines.push("Failures: 0");
  }
  lines.push(`Artifacts: ${report.artifactDir}`);
  return lines.join("\n");
}

const SYNTHETIC_KIND_MAP: Record<string, SyntheticFixture["kind"]> = {
  ack: "ack_thread",
  delegate: "escaped_spawn_json",
  exec: "main_tool_guard",
  provider: "provider_status",
  restart: "restart_shutdown",
  wizard: "wizard_start",
  router: "escaped_spawn_json",
  footer: "delegate_footer",
  delivery: "native_final_delivery",
  status: "escaped_spawn_json",
};

function isSyntheticFixtureKind(value: unknown): value is SyntheticFixture["kind"] {
  return typeof value === "string" && [
    "escaped_spawn_json",
    "late_ack",
    "ack_thread",
    "provider_status",
    "delegate_footer",
    "main_tool_guard",
    "native_final_delivery",
    "restart_shutdown",
    "wizard_start",
  ].includes(value);
}

function syntheticKindForCase(caseId: string, expect: Record<string, unknown>): SyntheticFixture["kind"] {
  if (isSyntheticFixtureKind(expect.fixtureKind)) {
    return expect.fixtureKind;
  }
  for (const [key, kind] of Object.entries(SYNTHETIC_KIND_MAP)) {
    if (caseId.includes(key)) return kind;
  }
  return "escaped_spawn_json";
}

async function findLatestReport(artifactDir: string): Promise<string> {
  let rawEntries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    rawEntries = await fs.readdir(artifactDir, { withFileTypes: true });
  } catch {
    throw new Error(`No stability report found in ${artifactDir}. Run a stability command first.`);
  }
  const entries = rawEntries.map((e) => e.name);
  const reportFiles = entries
    .filter((name) => name.endsWith("-stability-report.json"))
    .sort();
  const latest = reportFiles[reportFiles.length - 1];
  if (!latest) {
    throw new Error(`No stability report found in ${artifactDir}. Run a stability command first.`);
  }
  return path.join(artifactDir, latest);
}

export async function runStabilityOrchestration(options: StabilityRunnerOptions): Promise<StabilityRunnerResult> {
  const runKind = runKindForSubcommand(options.subcommand);
  const casePack = buildCatalogCasePack(runKind);
  const slackAvailable = await hasStabilitySlackEnv(options.env, options.config);

  const allLanes: StabilityLaneResult[] = [];
  const allFailures: StabilityFailurePacket[] = [];

  const liveCases = casePack.cases.filter((c) => c.mode === "live_slack");
  const syntheticCases = casePack.cases.filter((c) => c.mode === "synthetic");
  const routerCases = casePack.cases.filter((c) => c.mode === "router_model");
  const wizardCases = casePack.cases.filter((c) => c.mode === "wizard");
  const providerCases = casePack.cases.filter((c) => c.mode === "provider");

  if (liveCases.length > 0) {
    if (options.liveSlackReport) {
      const liveFailures = options.liveSlackReport.cases
        .filter((item) => item.status !== "pass")
        .map((item): StabilityFailurePacket => {
          const catalogCase = liveCases.find((candidate) => candidate.id === item.id);
          return {
            code: item.status === "fail" ? "live_slack_case_failed" : "live_slack_case_unknown",
            severity: catalogCase?.severity ?? "major",
            caseId: item.id,
            mode: "live_slack",
            classification: "runtime_bug",
            errors: item.errors,
            progress: item.progress,
            threadTs: item.threadTs,
            route: item.replayEvidence?.footerRoute,
            model: item.replayEvidence?.footerModel,
            footerDifficulty: item.replayEvidence?.footerDifficulty,
            footerVia: item.replayEvidence?.footerVia,
            workContractId: item.replayEvidence?.workContractId,
            spawnIntentId: item.replayEvidence?.spawnIntentId,
            runId: item.replayEvidence?.runId,
            childSessionKey: item.replayEvidence?.childSessionKey,
            stageMs: item.replayEvidence?.stageMs,
          };
        });
      allFailures.push(...liveFailures);
      allLanes.push({
        name: "slack_delivery",
        gate: options.liveSlackReport.overallGate,
        caseIds: options.liveSlackReport.cases.map((item) => item.id),
        failureCodes: [...new Set(liveFailures.map((item) => item.code))],
      });
    } else if (slackAvailable) {
      allLanes.push({
        name: "slack_delivery",
        gate: "unknown",
        caseIds: liveCases.map((c) => c.id),
        failureCodes: ["live_slack_not_run"],
      });
    } else {
      allFailures.push(...liveCases.map((liveCase): StabilityFailurePacket => ({
        code: "environment_unhealthy",
        severity: liveCase.severity,
        caseId: liveCase.id,
        mode: "live_slack",
        classification: "environment_issue",
      })));
      allLanes.push({
        name: "slack_delivery",
        gate: "unknown",
        caseIds: liveCases.map((c) => c.id),
        failureCodes: ["environment_unhealthy"],
      });
    }
  }

  if (syntheticCases.length > 0) {
    const syntheticFailures: StabilityFailurePacket[] = [];
    const syntheticCaseIds: string[] = [];
    for (const fixtureCase of syntheticCases) {
      syntheticCaseIds.push(fixtureCase.id);
      const kind = syntheticKindForCase(fixtureCase.id, fixtureCase.expect);
      const fixture = buildMinimalFixture(fixtureCase.id, kind, fixtureCase.expect);
      const result = runSyntheticStabilityFixture(fixture);
      const expectedFailureCode = asString(fixtureCase.expect.failureCode);
      if (expectedFailureCode) {
        if (!result.failures.some((failure) => failure.code === expectedFailureCode)) {
          syntheticFailures.push({
            code: "smoke_spec_mismatch",
            severity: fixtureCase.severity,
            caseId: fixtureCase.id,
            mode: "synthetic",
            classification: "smoke_spec_bug",
            errors: [`expected synthetic fixture to emit ${expectedFailureCode}`],
          });
        }
      } else if (result.gate === "fail") {
        syntheticFailures.push(...result.failures.map((f): StabilityFailurePacket => ({
          ...f,
          mode: "synthetic",
          caseId: fixtureCase.id,
          severity: fixtureCase.severity,
        })));
      }
    }
    allFailures.push(...syntheticFailures);
    allLanes.push({
      name: "synthetic_fixtures",
      gate: syntheticFailures.length > 0 ? "fail" : "pass",
      caseIds: syntheticCaseIds,
      failureCodes: [...new Set(syntheticFailures.map((f) => f.code))],
    });
  }

  if (runKind === "nightly" || runKind === "full_3d") {
    const result = runNightlyReplayStabilityLane(undefined);
    allLanes.push(...result.lanes);
    allFailures.push(...result.failures);
  }

  if (routerCases.length > 0) {
    allLanes.push({
      name: "router_model_choice",
      gate: "unknown",
      caseIds: routerCases.map((c) => c.id),
      failureCodes: [],
    });
  }

  if (wizardCases.length > 0) {
    allLanes.push({
      name: "wizard_contract",
      gate: "unknown",
      caseIds: wizardCases.map((c) => c.id),
      failureCodes: [],
    });
  }

  if (providerCases.length > 0) {
    const providerFailures: StabilityFailurePacket[] = [];
    for (const providerCase of providerCases) {
      const kind = syntheticKindForCase(providerCase.id, providerCase.expect);
      const fixture = buildMinimalFixture(providerCase.id, kind, providerCase.expect);
      const result = runSyntheticStabilityFixture(fixture);
      const expectedFailureCode = asString(providerCase.expect.failureCode);
      if (expectedFailureCode) {
        if (!result.failures.some((failure) => failure.code === expectedFailureCode)) {
          providerFailures.push({
            code: "smoke_spec_mismatch",
            severity: providerCase.severity,
            caseId: providerCase.id,
            mode: "provider",
            classification: "smoke_spec_bug",
            errors: [`expected provider fixture to emit ${expectedFailureCode}`],
          });
        }
      } else if (result.gate === "fail") {
        providerFailures.push(...result.failures.map((f): StabilityFailurePacket => ({
          ...f,
          mode: "provider",
          caseId: providerCase.id,
          severity: providerCase.severity,
        })));
      }
    }
    allFailures.push(...providerFailures);
    allLanes.push({
      name: "provider_resilience",
      gate: providerFailures.length > 0 ? "fail" : "pass",
      caseIds: providerCases.map((c) => c.id),
      failureCodes: [...new Set(providerFailures.map((f) => f.code))],
    });
  }

  if ((runKind === "nightly" || runKind === "full_3d") && allFailures.length > 0) {
    const classifiedFailures = allFailures.map(classifyStabilityFailure);
    buildAiReviewPrompt(classifiedFailures);
    allLanes.push({
      name: "ai_review",
      gate: "unknown",
      caseIds: [],
      failureCodes: [],
    });
  }

  const overallGate = computeOverallGate(allLanes);
  const artifactDir = await ensureStabilityOutputDir(options.outputDir);
  const timestamp = reportTimestamp();

  const report: StabilityReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    runKind,
    overallGate,
    lanes: allLanes,
    failures: sanitizeStabilityArtifact(allFailures) as StabilityFailurePacket[],
    artifactDir,
  };

  const reportPath = path.join(artifactDir, `${timestamp}-stability-report.json`);
  const markdownPath = path.join(artifactDir, `${timestamp}-stability-report.md`);
  const summaryPath = path.join(artifactDir, `${timestamp}-stability-summary.txt`);

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(markdownPath, renderStabilityMarkdownReport(report), "utf8");
  await fs.writeFile(summaryPath, renderCompactStabilitySummary(report), "utf8");

  return {
    reportPath,
    markdownPath,
    summaryPath,
    overallGate,
    lanes: allLanes,
    failures: report.failures,
    skippedLiveReason: !slackAvailable && liveCases.length > 0 ? "missing_slack_env" : undefined,
  };
}

function buildMinimalFixture(id: string, kind: SyntheticFixture["kind"], expect: Record<string, unknown>): SyntheticFixture {
  switch (kind) {
    case "late_ack":
      return { id, kind, ackMs: expect.ackMs as number ?? 0, ackDeadlineMs: expect.ackDeadlineMs as number ?? 90_000, finalDelivered: true };
    case "ack_thread":
      return {
        id,
        kind,
        expectedThreadTs: asString(expect.expectedThreadTs) ?? "thread-ok",
        observedThreadTs: asString(expect.observedThreadTs) ?? "thread-ok",
        ackText: asString(expect.ackText),
      };
    case "provider_status":
      return {
        id,
        kind,
        statusCode: (expect.statusCodes as number[])?.[0] ?? 402,
        slackText: asString(expect.slackText) ?? `${(expect.statusCodes as number[])?.[0] ?? 402} status code (no body)`,
        fallbackAvailable: typeof expect.fallbackAvailable === "boolean" ? expect.fallbackAvailable : true,
      };
    case "delegate_footer":
      return {
        id,
        kind,
        footerRoute: asString(expect.footerRoute) ?? "reply",
        footerDifficulty: asString(expect.footerDifficulty),
        hasSpawnIntent: typeof expect.hasSpawnIntent === "boolean" ? expect.hasSpawnIntent : true,
        hasChildSession: typeof expect.hasChildSession === "boolean" ? expect.hasChildSession : true,
      };
    case "main_tool_guard":
      return {
        id,
        kind,
        route: asString(expect.route) ?? "reply",
        escalationReason: asString(expect.escalationReason),
        attemptedToolName: asString(expect.attemptedToolName) ?? "exec",
        ordinaryToolRanAfterEscalation: typeof expect.ordinaryToolRanAfterEscalation === "boolean" ? expect.ordinaryToolRanAfterEscalation : false,
        dispatchCalled: typeof expect.dispatchCalled === "boolean" ? expect.dispatchCalled : true,
      };
    case "native_final_delivery":
      return {
        id,
        kind,
        nativeFinalDelivered: typeof expect.nativeFinalDelivered === "boolean" ? expect.nativeFinalDelivered : true,
        parentEchoAfterNativeFinalCount: typeof expect.parentEchoAfterNativeFinalCount === "number" ? expect.parentEchoAfterNativeFinalCount : 0,
        duplicateFinalCount: typeof expect.duplicateFinalCount === "number" ? expect.duplicateFinalCount : 0,
      };
    case "restart_shutdown":
      return { id, kind, slackText: "Previous run is still shutting down.", restartWindowMs: 12_000 };
    case "wizard_start":
      return { id, kind, nextState: "step_1" };
    case "escaped_spawn_json":
    default:
      return { id, kind: "escaped_spawn_json", expectedSpawnArgs: { task: "test" }, observedSpawnArgsText: '{"task":"test"}' };
  }
}

export async function runStabilityReviewLatest(outputDir: string): Promise<StabilityRunnerResult> {
  const artifactDir = path.join(outputDir, STABILITY_REPORT_DIR);
  const reportPath = await findLatestReport(artifactDir);
  const raw = await fs.readFile(reportPath, "utf8");
  const report = JSON.parse(raw) as StabilityReport;

  const classified = report.failures.map(classifyStabilityFailure);

  return {
    reportPath,
    overallGate: report.overallGate,
    lanes: report.lanes,
    failures: classified,
  };
}

export async function runStabilityFixDraft(outputDir: string, reportPath?: string): Promise<StabilityRunnerResult> {
  let resolvedPath = reportPath;
  if (!resolvedPath) {
    const artifactDir = path.join(outputDir, STABILITY_REPORT_DIR);
    resolvedPath = await findLatestReport(artifactDir);
  }

  const raw = await fs.readFile(resolvedPath, "utf8");
  const report = JSON.parse(raw) as StabilityReport;
  const classified = report.failures.map(classifyStabilityFailure);

  if (!shouldRunFixDraft(classified)) {
    return {
      reportPath: resolvedPath,
      overallGate: report.overallGate,
      lanes: report.lanes,
      failures: classified,
      fixDraftSummary: "No actionable runtime_bug failures found. Fix-draft skipped.",
    };
  }

  const guardResult = evaluateFixDraftGuard({
    filesChanged: 0,
    linesChanged: 0,
    touchesHotPath: false,
    validationPassed: true,
    attemptedCommands: [],
    mutatesOpenClawConfig: false,
  });

  const runtimeBugs = classified.filter(
    (f) => f.classification === "runtime_bug" && (f.severity === "blocker" || f.severity === "major"),
  );

  const summary = guardResult.allowed
    ? `Fix-draft is safe to prepare for ${runtimeBugs.length} runtime_bug failure(s). Produce local guarded instructions only. Do not commit, push, deploy, restart Gateway, or mutate OpenClaw config. ${runtimeBugs.map((f) => `${f.caseId}: ${f.code}`).join("; ")}`
    : `Fix-draft blocked: ${guardResult.reasonCodes.join(", ")}. Produce needs_human_review summary only.`;

  return {
    reportPath: resolvedPath,
    overallGate: report.overallGate,
    lanes: report.lanes,
    failures: classified,
    fixDraftSummary: summary,
  };
}

function renderStabilityMarkdownReport(report: StabilityReport): string {
  const lines: string[] = [
    `# Stability Smoke v2 Report`,
    ``,
    `- **Run kind**: ${report.runKind}`,
    `- **Generated**: ${report.generatedAt}`,
    `- **Overall gate**: ${report.overallGate}`,
    `- **Artifact dir**: ${report.artifactDir}`,
    ``,
    `## Lanes`,
    ``,
  ];
  for (const lane of report.lanes) {
    lines.push(`- **${lane.name}**: ${lane.gate} (${lane.caseIds.length} cases${lane.failureCodes.length > 0 ? `, failures: ${lane.failureCodes.join(", ")}` : ""})`);
  }
  if (report.failures.length > 0) {
    lines.push("");
    lines.push("## Failures");
    lines.push("");
    for (const failure of report.failures) {
      lines.push(`- **${failure.caseId}** (${failure.mode}): \`${failure.code}\` [${failure.severity}]${failure.classification ? ` → ${failure.classification}` : ""}`);
    }
  }
  return lines.join("\n");
}
