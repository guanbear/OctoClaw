#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import type { StatusSurfaceAction } from "@octoclaw/status-surface";
import { generateNightlyReport, filterNightlyReplayEvents, renderMarkdownReport, validateReplayEvents } from "./nightly/index.js";
import { loadSlackAcceptanceConfig, runSlackAcceptanceHarness, renderSlackAcceptanceMarkdown } from "./slack-acceptance/index.js";
import { normalizeCalibrationInputFile, runCalibrationGate, renderCalibrationMarkdown } from "./calibration/index.js";
import { parseNightlyEvalConfig, runNightlyEval, sanitizeAggregateReport, renderNightlyEvalMarkdown, renderNightlyEvalSlackSummary, generateLaunchAgentPlist, defaultLabel, defaultPlistPath, validateScheduleHour, readStoredBaseline, writeStoredBaseline, clearStoredBaseline } from "./nightly-eval/index.js";
import { runStabilityOrchestration, runStabilityReviewLatest, runStabilityFixDraft, parseCadence, hasStabilitySlackEnv } from "./stability/runner.js";
import { SlackWebApiAcceptanceClient } from "./slack-acceptance/index.js";
import { disablePlugin, enablePlugin, getConfigValue, restartAll, setConfigValue, showStatus } from "./manage.js";
import { buildWorkspace, cloneOrUpdate, DEFAULT_REF, DEFAULT_REPO_URL, deployExtension, deployPackages, setupSymlinks, syncOctoClawCoreRules, syncOpenClawPluginEntry, syncSlackDeliveryHookCompatibility, uninstallDeployment, validateLoad, writeSourceManifest } from "./install.js";
import { readConfig, syncToOpenClawPluginConfig, writeConfig } from "./config.js";
import { generateReadinessReport, redactReadinessReport, formatReadinessSummary } from "./readiness.js";
import type { ModelIntelSnapshot } from "@octoclaw/policy/router-lite";
import type { CostEvent, RouterShadowEvent } from "@octoclaw/router";
import type { CalibrationInputFile } from "./calibration/types.js";
import type { SlackAcceptanceCaseConfig, SlackAcceptanceFormat } from "./slack-acceptance/types.js";
import type { NightlyEvalConfig, LaunchAgentConfig } from "./nightly-eval/index.js";
import { installLaunchAgent, uninstallLaunchAgent } from "./platform.js";

// Lazy-loaded workspace modules — only loaded when their commands are used.
// This allows `init` to work standalone without workspace packages installed.
type StatusSurfaceModule = typeof import("@octoclaw/status-surface");
type PolicyRouterLiteModule = typeof import("@octoclaw/policy/router-lite");
type RouterModule = typeof import("@octoclaw/router");

let _statusSurface: StatusSurfaceModule | undefined;
async function loadStatusSurface(): Promise<StatusSurfaceModule> {
  if (!_statusSurface) _statusSurface = await import("@octoclaw/status-surface");
  return _statusSurface;
}

let _policyRouterLite: PolicyRouterLiteModule | undefined;
async function loadPolicyRouterLite(): Promise<PolicyRouterLiteModule> {
  if (!_policyRouterLite) _policyRouterLite = await import("@octoclaw/policy/router-lite");
  return _policyRouterLite;
}

let _router: RouterModule | undefined;
async function loadRouter(): Promise<RouterModule> {
  if (!_router) _router = await import("@octoclaw/router");
  return _router;
}

function detectLang(): "zh" | "en" {
  const env = process.env.LANG ?? process.env.LC_ALL ?? "";
  return env.startsWith("zh") ? "zh" : "en";
}

type LegacyCliFormat = "text" | "json";
type StatusFormat = "compact" | "table" | "lanes" | "anchors" | "text" | "json";
type ServiceName = "openclaw" | "runner";
type RunnerMode = "ondemand" | "daemon";
type NightlyFormat = "markdown" | "json";
type CliCommand =
  | "doctor"
  | "install"
  | "update"
  | "deploy"
  | "enable"
  | "disable"
  | "config"
  | "uninstall"
  | "calibration-gate"
  | "review"
  | "curate"
  | "status"
  | "details"
  | "queue"
  | "timeline"
  | "health"
  | "up"
  | "down"
  | "restart"
  | "patrol"
  | "reconcile"
  | "repair"
  | "init"
  | "nightly"
  | "nightly-eval"
  | "router"
  | "slack-acceptance"
  | "stability";
type JsonRecord = Record<string, unknown>;

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  cwd(): string;
  exit(code?: number): never;
  kill(pid: number, signal?: string | number): boolean;
  on(event: "uncaughtException", listener: (err: unknown) => void): void;
};

const LEGACY_ACTIONS: StatusSurfaceAction[] = ["status", "details", "queue", "timeline"];
const STATUS_FORMATS: StatusFormat[] = ["compact", "table", "lanes", "anchors", "text", "json"];
const SERVICE_NAMES: ServiceName[] = ["openclaw", "runner"];
const RUNNER_MODES: RunnerMode[] = ["ondemand", "daemon"];
const ROUTER_COST_PERIODS: Array<NonNullable<ParsedCliArgs["period"]>> = ["1d", "7d", "30d", "month"];
const INIT_LANGUAGES = ["zh", "en"] as const;
const RUNNING_STATES = new Set(["running", "in_progress", "active", "working"]);
const QUEUED_STATES = new Set(["queued", "pending", "planned", "waiting"]);
const DONE_STATES = new Set(["completed", "delivered", "done", "succeeded", "success"]);
const FAILED_STATES = new Set(["failed", "error", "cancelled", "canceled", "blocked"]);
const NON_DELEGATED_ROUTES = new Set(["reply", "direct"]);
const FALLBACK_MESSAGE = "No active OctoClaw runtime detected. Ensure the extension is installed and a task has been created.";
const DEFAULT_REPLAY_SAMPLE_LIMIT = 1000;
const ROUTER_CAPABILITY_REFRESH_CRON_NAME = "OctoClaw AutoRouter capability refresh";
const ROUTER_MODEL_INTEL_SNAPSHOT_FILENAME = "model-intel-snapshot.json";
const ROUTER_CAPABILITY_FULL_CATALOG_FILENAME = "capability-catalog-full.json";
const ROUTER_MODEL_INTEL_SLIM_LIMIT = 800;

interface ParsedCliArgs {
  command?: CliCommand;
  format?: StatusFormat;
  legacyFormat: LegacyCliFormat;
  help: boolean;
  version: boolean;
  taskId?: string;
  limit?: number;
  service?: ServiceName;
  mode?: RunnerMode;
  model: boolean;
  drift: boolean;
  once: boolean;
  incremental: boolean;
  cliMode: boolean;
  resume: boolean;
  input?: string;
  baseline?: string;
  candidate?: string;
  outputDir?: string;
  since?: string;
  period?: "1d" | "7d" | "30d" | "month";
  monthly?: number;
  forTier?: string;
  dispreferredFor?: string;
  reason?: string;
  nightlyFormat: NightlyFormat;
  calibrationFormat: "markdown" | "json";
  config?: string;
  repoUrl?: string;
  branch?: string;
  openclawHome?: string;
  octoclawRoot?: string;
  skipBuild: boolean;
  restartServices: boolean;
  scheduleHour?: number;
  logDir?: string;
  nonInteractive: boolean;
  autoRemoteJudge: boolean;
  cooldownOnly: boolean;
  lang?: "zh" | "en";
  nightlyEvalSubcommand?: "run" | "install-launchagent" | "uninstall-launchagent" | "print-plist" | "deliver-slack" | "promote" | "clear-baseline" | "show-baseline";
  slackAcceptanceFormat: SlackAcceptanceFormat;
  stabilitySubcommand?: "post-deploy" | "nightly" | "full" | "review-latest" | "fix-draft";
  cadence?: string;
  extraArgs: string[];
}

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface RuntimeTaskRecord {
  id: string;
  flowId: string;
  title: string;
  state: string;
  route: string;
  model: string;
  workerPool: string;
  phase: string;
  profile: string;
  claimOwner: string;
  summary: string;
  anchor: string;
  updatedAt: string;
  createdAt: string;
  raw: JsonRecord;
  record: RuntimeStateSurfaceRecord;
}

interface ReplaySummary {
  phase: string;
  totalEvents: number;
  delegatedEvents: number;
  runnerEvents: number;
  routeHintEvents: number;
  blockedEvents: number;
  models: Map<string, { count: number; totalLatencyMs: number; latencySamples: number }>;
  routeCounts: Map<string, number>;
  drift: {
    expectedMainModel: string;
    actualMainModel: string;
    aligned: boolean;
  };
}

interface StatusSnapshot {
  tasks: RuntimeTaskRecord[];
  runner: {
    mode: RunnerMode;
    state: string;
    pid?: number;
  };
  replay: ReplaySummary;
  config: JsonRecord;
}

interface ServiceState {
  service: ServiceName;
  action: "up" | "down" | "restart";
  mode: RunnerMode;
  binaryPath: string;
  pidFilePath: string;
  logFilePath: string;
  state: string;
  pid?: number;
}

interface TimelineEvent {
  at: string;
  event: string;
  route: string;
  workerPool: string;
  model: string;
  taskId: string;
  summary: string;
  raw: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFoundError(value: unknown): boolean {
  return isRecord(value) && value.code === "ENOENT";
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeSubstrateState(value: string | undefined): RuntimeStateSurfaceRecord["substrateState"] {
  switch (value) {
    case "planned":
    case "running":
    case "waiting":
    case "completed":
    case "failed":
      return value;
    default:
      return "planned";
  }
}

function normalizeWorkspaceMode(value: string | undefined): RuntimeStateSurfaceRecord["scope"]["workspaceMode"] {
  switch (value) {
    case "isolated_worktree":
    case "shared_workspace":
    case "read_only":
      return value;
    default:
      return "isolated_worktree";
  }
}

function normalizeState(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function shortText(value: string, limit = 72): string {
  const text = value.trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function pad(value: string, width: number): string {
  const text = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return text.padEnd(width, " ");
}

function parseJsonText(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function resolvePath(filePath: string): string {
  return filePath.startsWith("/") ? filePath : path.join(process.cwd(), filePath);
}

function resolveStableNodePath(invokedNodePath: string): string {
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return invokedNodePath;
}

async function readJsonFile(filePath: string): Promise<JsonRecord | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = parseJsonText(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonLines(filePath: string): Promise<JsonRecord[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split(/\r?\n/u)
      .map((line: string) => line.trim())
      .filter(Boolean)
      .flatMap((line: string) => {
        try {
          const parsed = parseJsonText(line);
          return isRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function readDirFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry: { isFile(): boolean; name: string }) => entry.isFile()).map((entry: { isFile(): boolean; name: string }) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

function resolveOctoClawHome(env: Record<string, string | undefined>, override?: string): string {
  const explicit = asString(override).trim() || asString(env.OPENCLAW_HOME).trim() || asString(env.OCTOCLAW_HOME).trim();
  if (explicit) {
    return resolvePath(explicit);
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveConfigPath(env: Record<string, string | undefined>): string {
  return path.join(resolveOctoClawHome(env), "octoclaw-config.json");
}

function resolveTaskStateDir(env: Record<string, string | undefined>): string {
  return path.join(resolveOctoClawHome(env), "task-state");
}

function resolveReplayDir(env: Record<string, string | undefined>): string {
  return path.join(resolveOctoClawHome(env), "replay");
}

function resolveCtlStateDir(env: Record<string, string | undefined>): string {
  return path.join(resolveOctoClawHome(env), "octoclawctl");
}

function resolveOctoclawRoot(parsed: ParsedCliArgs, env: Record<string, string | undefined>): string {
  return resolvePath(asString(parsed.octoclawRoot).trim() || asString(env.OCTOCLAW_ROOT).trim() || process.cwd());
}

function resolveServicePidFile(env: Record<string, string | undefined>, service: ServiceName): string {
  return path.join(resolveCtlStateDir(env), `${service}.pid`);
}

function resolveServiceLogFile(env: Record<string, string | undefined>, service: ServiceName): string {
  return path.join(resolveCtlStateDir(env), `${service}.log`);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export function resolveRuntimeStateSurfaceRecord(
  env: Record<string, string | undefined>,
): RuntimeStateSurfaceRecord | undefined {
  const taskId = env.OCTOCLAW_TASK_ID;
  const flowId = env.OCTOCLAW_FLOW_ID;

  if (!taskId || !flowId) {
    return undefined;
  }

  const substrateRevision = Number.parseInt(env.OCTOCLAW_SUBSTRATE_REVISION ?? "1", 10);
  const claimOwner = env.OCTOCLAW_CLAIM_OWNER ?? "octoclawctl";
  const workspaceMode = normalizeWorkspaceMode(env.OCTOCLAW_WORKSPACE_MODE);
  const writeScopeSummary = env.OCTOCLAW_WRITE_SCOPE_SUMMARY ?? "repo:workspace";
  const substrateState = normalizeSubstrateState(env.OCTOCLAW_SUBSTRATE_STATE);
  const syncMode = "managed";
  const resolvedRevision = Number.isNaN(substrateRevision) ? 1 : substrateRevision;

  return {
    taskId,
    flowId,
    runtime: "openclaw-native",
    syncMode,
    substrateState,
    substrateRevision: resolvedRevision,
    ownership: {
      claimOwner,
      claimToken: env.OCTOCLAW_CLAIM_TOKEN ?? "octoclawctl-claim-token",
      controllerId: env.OCTOCLAW_CONTROLLER_ID ?? "octoclawctl-controller",
    },
    scope: {
      readScope: [{ resource: env.OCTOCLAW_READ_SCOPE_RESOURCE ?? "repo:workspace", access: "read" }],
      writeScope: [{ resource: writeScopeSummary, access: "write" }],
      workspaceMode,
      writeScopeSummary,
    },
    truth: {
      schemaVersion: "octoclaw.truth/v1",
      createdAt: env.OCTOCLAW_CREATED_AT ?? "1970-01-01T00:00:00.000Z",
      kind: "truth",
      sessionKey: env.OCTOCLAW_SESSION_KEY ?? `${taskId}-session`,
      requestId: env.OCTOCLAW_REQUEST_ID ?? `${taskId}-request`,
      flowId,
      taskId,
      runtime: "openclaw-native",
      syncMode,
      substrateState,
      substrateRevision: resolvedRevision,
      managedDisposition: syncMode,
      ownership: {
        claimOwner,
        claimToken: env.OCTOCLAW_CLAIM_TOKEN ?? "octoclawctl-claim-token",
        controllerId: env.OCTOCLAW_CONTROLLER_ID ?? "octoclawctl-controller",
      },
      scope: {
        workspaceMode,
        readScopeCount: 1,
        writeScopeCount: 1,
        writeScopeSummary,
      },
    },
    projection: {
      schemaVersion: "octoclaw.projection/v1",
      createdAt: env.OCTOCLAW_CREATED_AT ?? "1970-01-01T00:00:00.000Z",
      kind: "projection",
      status: env.OCTOCLAW_PROJECTION_STATUS ?? substrateState,
      runtime: "openclaw-native",
      flowId,
      taskId,
      substrateState,
      substrateRevision: resolvedRevision,
      workspaceMode,
    },
    artifact: {
      schemaVersion: "octoclaw.artifact/v1",
      createdAt: env.OCTOCLAW_CREATED_AT ?? "1970-01-01T00:00:00.000Z",
      kind: "artifact",
      taskPacketRef: env.OCTOCLAW_TASK_PACKET_REF ?? `${taskId}-packet`,
      schemaPlanes: ["truth", "projection"],
    },
    telemetry: {
      schemaVersion: "octoclaw.telemetry/v1",
      createdAt: env.OCTOCLAW_CREATED_AT ?? "1970-01-01T00:00:00.000Z",
      kind: "telemetry",
      substrateRevision: resolvedRevision,
      syncMode,
      claimOwner,
    },
  };
}

function runtimeRecordFromTask(task: JsonRecord): RuntimeStateSurfaceRecord {
  const taskId = asString(task.id) || asString(task.task_id) || asString(task.taskId) || "unknown-task";
  const flowId = asString(task.flow_id) || asString(task.flowId) || taskId;
  const state = normalizeSubstrateState(
    asString(task.lifecycle_state) || asString(task.status) || asString(task.state) || asString(task.session_status),
  );
  const workspaceMode = normalizeWorkspaceMode(asString(task.workspace_mode) || asString(task.workspaceMode));
  const claimOwner = asString(task.owner) || asString(task.executor) || asString(task.agent_id) || "octoclawctl";
  const writeScopeSummary = asString(task.write_scope_summary) || "repo:workspace";
  const createdAt = asString(task.spawned_at) || asString(task.started_at) || asString(task.updated_at) || new Date().toISOString();
  const revision = asNumber(task.substrate_revision) ?? 1;
  return {
    taskId,
    flowId,
    runtime: "openclaw-native",
    syncMode: "managed",
    substrateState: state,
    substrateRevision: revision,
    ownership: {
      claimOwner,
      claimToken: `${taskId}-claim`,
      controllerId: claimOwner,
    },
    scope: {
      readScope: [{ resource: "repo:workspace", access: "read" }],
      writeScope: [{ resource: writeScopeSummary, access: "write" }],
      workspaceMode,
      writeScopeSummary,
    },
    truth: {
      schemaVersion: "octoclaw.truth/v1",
      createdAt,
      kind: "truth",
      sessionKey: asString(task.session_key) || `${taskId}-session`,
      requestId: asString(task.run_id) || `${taskId}-request`,
      flowId,
      taskId,
      runtime: "openclaw-native",
      syncMode: "managed",
      substrateState: state,
      substrateRevision: revision,
      managedDisposition: "managed",
      ownership: {
        claimOwner,
        claimToken: `${taskId}-claim`,
        controllerId: claimOwner,
      },
      scope: {
        workspaceMode,
        readScopeCount: 1,
        writeScopeCount: 1,
        writeScopeSummary,
      },
    },
    projection: {
      schemaVersion: "octoclaw.projection/v1",
      createdAt,
      kind: "projection",
      status: asString(task.status) || state,
      runtime: "openclaw-native",
      flowId,
      taskId,
      substrateState: state,
      substrateRevision: revision,
      workspaceMode,
    },
    artifact: {
      schemaVersion: "octoclaw.artifact/v1",
      createdAt,
      kind: "artifact",
      taskPacketRef: asString(task.title) || taskId,
      schemaPlanes: ["truth", "projection", "artifact", "telemetry"],
    },
    telemetry: {
      schemaVersion: "octoclaw.telemetry/v1",
      createdAt,
      kind: "telemetry",
      substrateRevision: revision,
      syncMode: "managed",
      claimOwner,
    },
  };
}

async function loadConfig(env: Record<string, string | undefined>): Promise<JsonRecord> {
  return (await readJsonFile(resolveConfigPath(env))) ?? {};
}

function inferAnchor(task: JsonRecord): string {
  const artifacts = isRecord(task.artifacts) ? task.artifacts : {};
  const surface = isRecord(artifacts.operator_surface) ? artifacts.operator_surface : {};
  return asString(surface.anchor)
    || asString(surface.tmux_session)
    || asString(task.session_thread_key)
    || asString(task.session_key)
    || asString(task.report_path)
    || "-";
}

function inferModel(task: JsonRecord): string {
  return asString(task.model)
    || asString(task.model_path)
    || asString(task.resolved_model)
    || asString(task.recommended_model)
    || asString(task.profile)
    || "-";
}

function inferComplexityBand(task: JsonRecord): string {
  const metadata = isRecord(task.metadata) ? task.metadata : {};
  const contract = isRecord(task.workContract) ? task.workContract : (isRecord(task.work_contract) ? task.work_contract : {});
  const decision = isRecord(contract.decision) ? contract.decision : {};
  const routeDecision = isRecord(decision.route_decision) ? decision.route_decision : {};
  return asString(task.complexityBand)
    || asString(task.complexity_band)
    || asString(metadata.complexityBand)
    || asString(metadata.complexity_band)
    || asString(decision._judge_complexity_band)
    || asString(routeDecision._judge_complexity_band)
    || asString(routeDecision.complexity_band)
    || "";
}

function isDelegatedRoute(route: string): boolean {
  return !NON_DELEGATED_ROUTES.has(route.trim().toLowerCase());
}

function routeLane(route: string): string {
  const normalized = route.trim().toLowerCase();
  if (normalized === "reply" || normalized === "direct") return "direct";
  if (normalized === "runner") return "runner";
  return "spawn";
}

function compareTasks(a: RuntimeTaskRecord, b: RuntimeTaskRecord): number {
  const aTime = Date.parse(a.updatedAt || a.createdAt || "") || 0;
  const bTime = Date.parse(b.updatedAt || b.createdAt || "") || 0;
  return bTime - aTime;
}

async function loadTasksFromStateDir(env: Record<string, string | undefined>): Promise<RuntimeTaskRecord[]> {
  const files = await readDirFiles(resolveTaskStateDir(env));
  const tasks = await Promise.all(
    files
      .filter((filePath) => filePath.endsWith(".json"))
      .map(async (filePath) => {
        const raw = await readJsonFile(filePath);
        if (!raw) {
          return undefined;
        }
        const id = asString(raw.id) || asString(raw.task_id) || path.basename(filePath, ".json");
        const state = asString(raw.status) || asString(raw.lifecycle_state) || asString(raw.state) || "planned";
        const record = runtimeRecordFromTask(raw);
        return {
          id,
          flowId: asString(raw.flow_id) || asString(raw.flowId) || id,
          title: asString(raw.title) || asString(raw.task_description) || id,
          state,
          route: asString(raw.route) || "reply",
          model: inferModel(raw),
          workerPool: asString(raw.worker_pool) || asString(raw.executor_type) || "octoclaw-runtime",
          phase: asString(raw.phase) || asString(raw.lifecycle_state) || "-",
          profile: asString(raw.profile) || "-",
          claimOwner: asString(raw.owner) || asString(raw.executor) || "octoclawctl",
          summary: asString(raw.summary) || asString(raw.user_safe_summary) || asString(raw.task_description),
          anchor: inferAnchor(raw),
          updatedAt: asString(raw.updated_at) || asString(raw.last_observed_at),
          createdAt: asString(raw.spawned_at) || asString(raw.started_at),
          raw,
          record,
        } satisfies RuntimeTaskRecord;
      }),
  );
  return tasks.filter((task): task is RuntimeTaskRecord => Boolean(task)).sort(compareTasks);
}

async function loadReplayEvents(env: Record<string, string | undefined>): Promise<JsonRecord[]> {
  const files = await readDirFiles(resolveReplayDir(env));
  const jsonlFiles = files.filter((filePath) => filePath.endsWith(".jsonl"));
  const eventLists = await Promise.all(jsonlFiles.map((filePath) => readJsonLines(filePath)));
  return eventLists.flat();
}

function replayPhaseFromConfig(config: JsonRecord): string {
  const runtimePolicy = isRecord(config.runtime_policy) ? config.runtime_policy : {};
  return asString(runtimePolicy.phase) || asString(runtimePolicy.rollout_phase) || "conservative";
}

function replaySummaryFromEvents(config: JsonRecord, events: JsonRecord[]): ReplaySummary {
  const summary: ReplaySummary = {
    phase: replayPhaseFromConfig(config),
    totalEvents: events.length,
    delegatedEvents: 0,
    runnerEvents: 0,
    routeHintEvents: 0,
    blockedEvents: 0,
    models: new Map(),
    routeCounts: new Map(),
    drift: {
      expectedMainModel: asString(isRecord(config.model_auto) ? config.model_auto.main_model : undefined)
        || asString(config.main_model),
      actualMainModel: "",
      aligned: true,
    },
  };

  for (const event of events.slice(-DEFAULT_REPLAY_SAMPLE_LIMIT)) {
    const route = asString(event.route) || asString(event.finalRoute) || asString(event.systemPreferredRoute);
    const workerPool = asString(event.workerPool);
    const model = asString(event.resolvedModel) || asString(event.recommendedModel) || asString(event.model);
    const latency = asNumber(event.actualLatency) ?? asNumber(event.latency_ms) ?? asNumber(event.latencyMs);
    const eventType = asString(event.event);
    if (route) {
      summary.routeCounts.set(route, (summary.routeCounts.get(route) ?? 0) + 1);
    }
    if (route && route !== "reply" && route !== "direct") {
      summary.delegatedEvents += 1;
    }
    if (route === "runner" || workerPool.includes("runner") || eventType.includes("runner")) {
      summary.runnerEvents += 1;
    }
    if (eventType === "route_hint_submitted") {
      summary.routeHintEvents += 1;
    }
    if (eventType.includes("blocked")) {
      summary.blockedEvents += 1;
    }
    if (model) {
      const current = summary.models.get(model) ?? { count: 0, totalLatencyMs: 0, latencySamples: 0 };
      current.count += 1;
      if (latency !== undefined) {
        current.totalLatencyMs += latency;
        current.latencySamples += 1;
      }
      summary.models.set(model, current);
    }
  }

  const [actualMainModel] = [...summary.models.entries()].sort((a, b) => b[1].count - a[1].count)[0] ?? ["", undefined];
  summary.drift.actualMainModel = actualMainModel;
  summary.drift.aligned = !summary.drift.expectedMainModel || !actualMainModel || summary.drift.expectedMainModel === actualMainModel;
  return summary;
}

async function loadStatusSnapshot(env: Record<string, string | undefined>): Promise<StatusSnapshot> {
  const [config, tasks, replayEvents] = await Promise.all([
    loadConfig(env),
    loadTasksFromStateDir(env),
    loadReplayEvents(env),
  ]);
  const runnerMode = asString(env.RUNNER_MODE) === "daemon" ? "daemon" : "ondemand";
  const runnerPidPath = resolveServicePidFile(env, "runner");
  const runnerPid = await readPidFromFile(runnerPidPath);
  return {
    tasks,
    runner: {
      mode: runnerMode,
      state: runnerPid && isPidAlive(runnerPid) ? "running" : (runnerMode === "ondemand" ? "ondemand" : "stopped"),
      pid: runnerPid,
    },
    replay: replaySummaryFromEvents(config, replayEvents),
    config,
  };
}

function formatCompact(snapshot: StatusSnapshot): string {
  const running = snapshot.tasks.filter((task) => RUNNING_STATES.has(normalizeState(task.state))).length;
  const queued = snapshot.tasks.filter((task) => QUEUED_STATES.has(normalizeState(task.state))).length;
  const done = snapshot.tasks.filter((task) => DONE_STATES.has(normalizeState(task.state))).length;
  const delivered = snapshot.tasks.filter((task) => normalizeState(task.state) === "delivered").length;
  const failed = snapshot.tasks.filter((task) => FAILED_STATES.has(normalizeState(task.state))).length;
  const routeSummary = [...snapshot.replay.routeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([route, count]) => `${route}=${count}`)
    .join(", ") || "none";
  return [
    `Tasks total=${snapshot.tasks.length} running=${running} queued=${queued} done=${done} delivered=${delivered} failed=${failed}`,
    `Runner state=${snapshot.runner.state} mode=${snapshot.runner.mode}${snapshot.runner.pid ? ` pid=${snapshot.runner.pid}` : ""}`,
    `Replay phase=${snapshot.replay.phase} events=${snapshot.replay.totalEvents} delegated=${snapshot.replay.delegatedEvents} runner=${snapshot.replay.runnerEvents} route_hints=${snapshot.replay.routeHintEvents} blocked=${snapshot.replay.blockedEvents}`,
    `Replay routes=${routeSummary}`,
  ].join("\n");
}

function formatTable(snapshot: StatusSnapshot): string {
  const header = [
    pad("TASK", 20),
    pad("STATE", 12),
    pad("ROUTE", 14),
    pad("MODEL", 28),
    pad("POOL", 20),
    pad("PHASE", 14),
  ].join(" ");
  const rows = snapshot.tasks.map((task) => [
    pad(task.id, 20),
    pad(formatTaskState(task.state), 12),
    pad(task.route, 14),
    pad(task.model, 28),
    pad(task.workerPool, 20),
    pad(task.phase, 14),
  ].join(" "));
  return [header, ...rows].join("\n");
}

function formatTaskState(state: string): string {
  const normalized = normalizeState(state);
  if (normalized === "delivered") return "✅ delivered";
  if (normalized === "degraded") return "⚠️ degraded";
  return state;
}

function formatLanes(snapshot: StatusSnapshot): string {
  const lanes = new Map<string, RuntimeTaskRecord[]>();
  for (const task of snapshot.tasks) {
    const lane = routeLane(task.route);
    const current = lanes.get(lane) ?? [];
    current.push(task);
    lanes.set(lane, current);
  }
  return [...lanes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([lane, tasks]) => {
      const body = tasks.map((task) => `  - ${task.id} state=${task.state} route=${task.route} model=${task.model}`).join("\n");
      return `${lane} (${tasks.length})\n${body}`;
    })
    .join("\n");
}

function humanElapsed(updatedAt: string, nowMs: number): string {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return "-";
  const diff = Math.max(0, nowMs - ts);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 48) return `${hours}h${remMin ? `${remMin}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

function formatAnchors(snapshot: StatusSnapshot): string {
  const nowMs = Date.now();
  const tasks = snapshot.tasks.filter((task) => isDelegatedRoute(task.route));
  const completedStates = DONE_STATES;
  const failedStates = new Set([
    ...FAILED_STATES,
    "timed_out",
    "timeout_no_result",
    "completion_orphaned",
    "binding_mismatch",
    "delivery_failed",
    "spawn_not_confirmed",
  ]);

  type GroupKey = "active" | "completed" | "failed";
  const groupOrder: GroupKey[] = ["active", "completed", "failed"];
  const groupEmoji: Record<GroupKey, string> = { active: "⏳", completed: "✅", failed: "❌" };
  const groupLabel: Record<GroupKey, string> = { active: "Active", completed: "Completed", failed: "Failed" };

  const groups = new Map<GroupKey, typeof tasks>();
  for (const key of groupOrder) groups.set(key, []);
  for (const task of tasks) {
    let key: GroupKey;
    const normalizedState = normalizeState(task.state);
    if (completedStates.has(normalizedState)) key = "completed";
    else if (failedStates.has(normalizedState)) key = "failed";
    else key = "active";
    groups.get(key)!.push(task);
  }

  const limit = 50;
  const lines: string[] = [
    "OctoClaw status (anchors)",
    `Visible delegated tasks: ${tasks.length} | Total projected tasks: ${snapshot.tasks.length}`,
  ];

  let shown = 0;
  for (const key of groupOrder) {
    const gTasks = groups.get(key)!;
    if (gTasks.length === 0) continue;
    lines.push("");
    lines.push(`${groupEmoji[key]} ${groupLabel[key]}:`);
    for (const task of gTasks) {
      if (shown >= limit) break;
      const id = task.id.length > 10 ? `${task.id.slice(0, 10)}…` : task.id;
      const elapsed = humanElapsed(task.updatedAt, nowMs);
      const model = task.model && task.model !== "-" ? task.model : "";
      const band = inferComplexityBand(task.raw);
      const rawTitle = task.title || task.summary || task.id;
      const title = rawTitle.length > 60 ? `${rawTitle.slice(0, 57)}…` : rawTitle;
      const metaParts = [task.state, elapsed, model, band].filter(Boolean);
      const metaStr = metaParts.length > 0 ? ` | ${metaParts.join(" | ")}` : "";
      lines.push(`- ${id}${metaStr} | ${title}`);
      shown++;
    }
    if (shown >= limit) break;
  }

  if (tasks.length === 0) {
    lines.push("");
    lines.push("No delegated task state is currently available.");
  }
  if (tasks.length > limit) {
    lines.push("");
    lines.push(`… ${tasks.length - limit} more tasks hidden.`);
  }
  return lines.join("\n");
}

function modelHealthToJson(summary: ReplaySummary): JsonRecord {
  return {
    phase: summary.phase,
    totalEvents: summary.totalEvents,
    models: [...summary.models.entries()].map(([model, stats]) => ({
      model,
      count: stats.count,
      avgLatencyMs: stats.latencySamples > 0 ? Math.round(stats.totalLatencyMs / stats.latencySamples) : null,
      available: stats.count > 0,
    })),
  };
}

function formatModelHealth(summary: ReplaySummary): string {
  if (summary.models.size === 0) {
    return "Model health: no replay-backed model signals yet";
  }
  return [
    `Model health phase=${summary.phase}`,
    ...[...summary.models.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([model, stats]) => {
        const latency = stats.latencySamples > 0 ? Math.round(stats.totalLatencyMs / stats.latencySamples) : undefined;
        return `- ${model}: available=yes count=${stats.count}${latency !== undefined ? ` avg_latency_ms=${latency}` : ""}`;
      }),
  ].join("\n");
}

function formatDrift(summary: ReplaySummary): string {
  if (!summary.drift.expectedMainModel && !summary.drift.actualMainModel) {
    return "Main model drift: no configured or observed main model";
  }
  return [
    "Main model drift",
    `expected=${summary.drift.expectedMainModel || "-"}`,
    `actual=${summary.drift.actualMainModel || "-"}`,
    `aligned=${String(summary.drift.aligned)}`,
  ].join("\n");
}

async function renderDetails(task: RuntimeTaskRecord, outputJson: boolean): Promise<string> {
  const statusSurface = await loadStatusSurface();
  const projection = statusSurface.buildDetailsProjection({
    record: task.record,
    route: task.route,
    workerPool: task.workerPool,
    modelSummary: task.model,
  });
  if (outputJson) {
    return JSON.stringify({ ...projection, raw: task.raw }, null, 2);
  }
  return [
    String(statusSurface.runStatusSurfaceOperator("details", task.record, "text")),
    `route=${task.route}`,
    `worker_pool=${task.workerPool}`,
    `model=${task.model}`,
    `phase=${task.phase}`,
    `anchor=${task.anchor}`,
    task.summary ? `summary=${task.summary}` : null,
  ].filter(Boolean).join("\n");
}

async function renderQueue(tasks: RuntimeTaskRecord[], outputJson: boolean): Promise<string> {
  const statusSurface = await loadStatusSurface();
  const queued = tasks
    .filter((task) => QUEUED_STATES.has(normalizeState(task.state)) || RUNNING_STATES.has(normalizeState(task.state)))
    .map((task, index) => ({
      task,
      view: statusSurface.buildQueueProjection({
        record: task.record,
        queuePosition: index + 1,
        workerPool: task.workerPool,
      }),
    }));
  if (outputJson) {
    return JSON.stringify(queued.map(({ view, task }) => ({ ...view, route: task.route, model: task.model })), null, 2);
  }
  return queued.length === 0
    ? "Queue: empty"
    : queued.map(({ task, view }) => [String(statusSurface.runStatusSurfaceOperator("queue", task.record, "text")), `route=${task.route}`, `model=${task.model}`, `position=${view.queuePosition ?? "unknown"}`].join("\n")).join("\n\n");
}

function renderTimeline(events: TimelineEvent[], outputJson: boolean): string {
  if (outputJson) {
    return JSON.stringify(events, null, 2);
  }
  if (events.length === 0) {
    return "Timeline: no replay events found";
  }
  return events.map((event) => `${event.at} ${event.event} task=${event.taskId || "-"} route=${event.route || "-"} pool=${event.workerPool || "-"} model=${event.model || "-"}${event.summary ? ` :: ${event.summary}` : ""}`).join("\n");
}

async function buildTimeline(env: Record<string, string | undefined>, taskId: string | undefined, limit: number): Promise<TimelineEvent[]> {
  const events = await loadReplayEvents(env);
  return events
    .filter((event) => !taskId || asString(event.taskId) === taskId)
    .slice(-limit)
    .map((event) => ({
      at: asString(event.at),
      event: asString(event.event),
      route: asString(event.route) || asString(event.finalRoute),
      workerPool: asString(event.workerPool),
      model: asString(event.resolvedModel) || asString(event.recommendedModel) || asString(event.model),
      taskId: asString(event.taskId),
      summary: shortText(asString(event.reason) || asString(event.ackMessage) || asString(event.prompt), 100),
      raw: event,
    }))
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

function resolveTaskById(tasks: RuntimeTaskRecord[], taskId: string | undefined): RuntimeTaskRecord | undefined {
  if (!taskId) {
    return tasks[0];
  }
  return tasks.find((task) => task.id === taskId);
}

function parseEnumValue<T extends string>(value: string | undefined, valid: readonly T[], kind: string): T {
  if (!value || !valid.includes(value as T)) {
    throw new Error(`Unknown ${kind}: ${value ?? "(missing)"}. Expected one of: ${valid.join(", ")}`);
  }
  return value as T;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let command: CliCommand | undefined;
  let format: StatusFormat | undefined;
  let legacyFormat: LegacyCliFormat = "text";
  let help = false;
  let version = false;
  let taskId: string | undefined;
  let limit: number | undefined;
  let service: ServiceName | undefined;
  let mode: RunnerMode | undefined;
  let model = false;
  let drift = false;
  let once = false;
  let incremental = false;
  let cliMode = false;
  let resume = false;
  let input: string | undefined;
  let baseline: string | undefined;
  let candidate: string | undefined;
  let outputDir: string | undefined;
  let since: string | undefined;
  let period: ParsedCliArgs["period"];
  let monthly: number | undefined;
  let forTier: string | undefined;
  let dispreferredFor: string | undefined;
  let reason: string | undefined;
  let nightlyFormat: NightlyFormat = "markdown";
  let calibrationFormat: "markdown" | "json" = "markdown";
  let config: string | undefined;
  let repoUrl: string | undefined;
  let branch: string | undefined;
  let openclawHome: string | undefined;
  let octoclawRoot: string | undefined;
  let skipBuild = false;
  let restartServices = false;
  let scheduleHour: number | undefined;
  let logDir: string | undefined;
  let nonInteractive = false;
  let autoRemoteJudge = false;
  let cooldownOnly = false;
  let lang: "zh" | "en" | undefined;
  let nightlyEvalSubcommand: ParsedCliArgs["nightlyEvalSubcommand"];
  let slackAcceptanceFormat: SlackAcceptanceFormat = "markdown";
  let stabilitySubcommand: ParsedCliArgs["stabilitySubcommand"];
  let cadence: string | undefined;
  let rawFormat: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      version = true;
      continue;
    }
    if (argument === "--format") {
      rawFormat = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--json") {
      rawFormat = "json";
      continue;
    }
    if (argument.startsWith("--format=")) {
      [, rawFormat] = argument.split("=", 2);
      continue;
    }
    if (argument === "--task-id") {
      taskId = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--task-id=")) {
      [, taskId] = argument.split("=", 2);
      continue;
    }
    if (argument === "--limit") {
      limit = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (argument.startsWith("--limit=")) {
      const [, rawLimit] = argument.split("=", 2);
      limit = Number.parseInt(rawLimit ?? "", 10);
      continue;
    }
    if (argument === "--service") {
      service = parseEnumValue(argv[index + 1], SERVICE_NAMES, "service");
      index += 1;
      continue;
    }
    if (argument.startsWith("--service=")) {
      const [, rawService] = argument.split("=", 2);
      service = parseEnumValue(rawService, SERVICE_NAMES, "service");
      continue;
    }
    if (argument === "--mode") {
      mode = parseEnumValue(argv[index + 1], RUNNER_MODES, "mode");
      index += 1;
      continue;
    }
    if (argument.startsWith("--mode=")) {
      const [, rawMode] = argument.split("=", 2);
      mode = parseEnumValue(rawMode, RUNNER_MODES, "mode");
      continue;
    }
    if (argument === "--model") {
      model = true;
      continue;
    }
    if (argument === "--drift") {
      drift = true;
      continue;
    }
    if (argument === "--once") {
      once = true;
      continue;
    }
    if (argument === "--incremental") {
      incremental = true;
      continue;
    }
    if (argument === "--cli") {
      cliMode = true;
      continue;
    }
    if (argument === "--resume") {
      resume = true;
      continue;
    }
    if (argument === "--input") {
      input = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--input=")) {
      [, input] = argument.split("=", 2);
      continue;
    }
    if (argument === "--baseline") {
      baseline = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--baseline=")) {
      [, baseline] = argument.split("=", 2);
      continue;
    }
    if (argument === "--candidate") {
      candidate = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--candidate=")) {
      [, candidate] = argument.split("=", 2);
      continue;
    }
    if (argument === "--output-dir") {
      outputDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--output-dir=")) {
      [, outputDir] = argument.split("=", 2);
      continue;
    }
    if (argument === "--since") {
      since = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--since=")) {
      [, since] = argument.split("=", 2);
      continue;
    }
    if (argument === "--period") {
      period = parseEnumValue(argv[index + 1], ROUTER_COST_PERIODS, "period");
      index += 1;
      continue;
    }
    if (argument.startsWith("--period=")) {
      const [, rawPeriod] = argument.split("=", 2);
      period = parseEnumValue(rawPeriod, ROUTER_COST_PERIODS, "period");
      continue;
    }
    if (argument === "--monthly") {
      monthly = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--monthly=")) {
      const [, rawMonthly] = argument.split("=", 2);
      monthly = Number(rawMonthly);
      continue;
    }
    if (argument === "--for") {
      forTier = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--for=")) {
      [, forTier] = argument.split("=", 2);
      continue;
    }
    if (argument === "--dispreferred-for") {
      dispreferredFor = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--dispreferred-for=")) {
      [, dispreferredFor] = argument.split("=", 2);
      continue;
    }
    if (argument === "--reason") {
      reason = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--reason=")) {
      [, reason] = argument.split("=", 2);
      continue;
    }
    if (argument === "--config") {
      config = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--config=")) {
      [, config] = argument.split("=", 2);
      continue;
    }
    if (argument === "--repo-url") {
      repoUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--repo-url=")) {
      [, repoUrl] = argument.split("=", 2);
      continue;
    }
    if (argument === "--branch" || argument === "--ref") {
      branch = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--branch=") || argument.startsWith("--ref=")) {
      [, branch] = argument.split("=", 2);
      continue;
    }
    if (argument === "--openclaw-home") {
      openclawHome = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--openclaw-home=")) {
      [, openclawHome] = argument.split("=", 2);
      continue;
    }
    if (argument === "--octoclaw-root") {
      octoclawRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--octoclaw-root=")) {
      [, octoclawRoot] = argument.split("=", 2);
      continue;
    }
    if (argument === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (argument === "--restart") {
      restartServices = true;
      continue;
    }
    if (argument === "--schedule-hour") {
      scheduleHour = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (argument.startsWith("--schedule-hour=")) {
      const [, rawHour] = argument.split("=", 2);
      scheduleHour = Number.parseInt(rawHour ?? "", 10);
      continue;
    }
    if (argument === "--log-dir") {
      logDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--log-dir=")) {
      [, logDir] = argument.split("=", 2);
      continue;
    }
    if (argument === "--non-interactive") {
      nonInteractive = true;
      continue;
    }
    if (argument === "--auto-remote-judge") {
      autoRemoteJudge = true;
      continue;
    }
    if (argument === "--cooldown-only") {
      cooldownOnly = true;
      continue;
    }
    if (argument === "--lang") {
      lang = parseEnumValue(argv[index + 1], INIT_LANGUAGES, "language");
      index += 1;
      continue;
    }
    if (argument.startsWith("--lang=")) {
      const [, rawLang] = argument.split("=", 2);
      lang = parseEnumValue(rawLang, INIT_LANGUAGES, "language");
      continue;
    }
    if (argument === "--cadence") {
      cadence = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--cadence=")) {
      [, cadence] = argument.split("=", 2);
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    positionals.push(argument);
  }

  if (positionals.length > 0) {
    command = positionals[0] as CliCommand;
  }
  if (command === "nightly-eval" && positionals[1]) {
    const sub = positionals[1];
    const validSubs = ["run", "install-launchagent", "uninstall-launchagent", "print-plist", "deliver-slack", "promote", "clear-baseline", "show-baseline"];
    if (!validSubs.includes(sub)) {
      throw new Error(`Unknown nightly-eval subcommand: ${sub}. Expected one of: ${validSubs.join(", ")}`);
    }
    nightlyEvalSubcommand = sub as ParsedCliArgs["nightlyEvalSubcommand"];
  }
  if (command === "stability" && positionals[1]) {
    const sub = positionals[1];
    const validStabilitySubs = ["post-deploy", "nightly", "full", "review-latest", "fix-draft"];
    if (!validStabilitySubs.includes(sub)) {
      throw new Error(`Unknown stability subcommand: ${sub}. Expected one of: ${validStabilitySubs.join(", ")}`);
    }
    stabilitySubcommand = sub as ParsedCliArgs["stabilitySubcommand"];
  }
  if (command === "details" && positionals[1] && !taskId) {
    taskId = positionals[1];
  }
  if (command && !["doctor", "install", "update", "deploy", "enable", "disable", "config", "uninstall", "calibration-gate", "review", "curate", "status", "details", "queue", "timeline", "health", "up", "down", "restart", "patrol", "reconcile", "repair", "init", "nightly", "nightly-eval", "router", "slack-acceptance", "stability"].includes(command)) {
    throw new Error(`Unknown action: ${command}. Expected one of: doctor, install, update, deploy, enable, disable, config, uninstall, calibration-gate, review, curate, status, details, queue, timeline, health, up, down, restart, patrol, reconcile, repair, init, nightly, nightly-eval, router, slack-acceptance, stability`);
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`Unknown limit: ${String(limit)}. Expected a positive integer`);
  }

  if (rawFormat !== undefined) {
    const MARKDOWN_JSON_FORMATS: readonly string[] = ["markdown", "json"];
    if (command === "nightly" || command === "nightly-eval" || command === "slack-acceptance" || command === "calibration-gate") {
      if (!MARKDOWN_JSON_FORMATS.includes(rawFormat)) {
        throw new Error(`Unknown format: ${rawFormat}. Expected one of: markdown, json`);
      }
      if (command === "nightly") nightlyFormat = rawFormat as NightlyFormat;
      if (command === "nightly-eval") calibrationFormat = rawFormat as "markdown" | "json";
      if (command === "slack-acceptance") slackAcceptanceFormat = rawFormat as SlackAcceptanceFormat;
      if (command === "calibration-gate") calibrationFormat = rawFormat as "markdown" | "json";
    } else {
      format = parseEnumValue(rawFormat, STATUS_FORMATS, "format");
      legacyFormat = format === "json" ? "json" : "text";
    }
  }

  if (command === "nightly") {
    if (!input) {
      throw new Error("nightly command requires --input <replay.jsonl>");
    }
    if (!outputDir) {
      throw new Error("nightly command requires --output-dir <dir>");
    }
  }

  if (command === "slack-acceptance") {
    if (!config) {
      throw new Error("slack-acceptance command requires --config <acceptance.json>");
    }
    if (!outputDir) {
      throw new Error("slack-acceptance command requires --output-dir <dir>");
    }
  }

  if (command === "calibration-gate") {
    if (!baseline) {
      throw new Error("calibration-gate command requires --baseline <report.json>");
    }
    if (!candidate) {
      throw new Error("calibration-gate command requires --candidate <report.json>");
    }
    if (!outputDir) {
      throw new Error("calibration-gate command requires --output-dir <dir>");
    }
  }

  if (command === "nightly-eval") {
    if (!nightlyEvalSubcommand) {
      throw new Error("nightly-eval requires a subcommand: run, install-launchagent, uninstall-launchagent, print-plist, deliver-slack");
    }
    if (nightlyEvalSubcommand === "run" || nightlyEvalSubcommand === "install-launchagent" || nightlyEvalSubcommand === "print-plist") {
      if (!config) {
        throw new Error(`nightly-eval ${nightlyEvalSubcommand} requires --config <eval-config.json>`);
      }
      if (!outputDir) {
        throw new Error(`nightly-eval ${nightlyEvalSubcommand} requires --output-dir <dir>`);
      }
    }
    if (nightlyEvalSubcommand === "deliver-slack") {
      if (!config) {
        throw new Error("nightly-eval deliver-slack requires --config <slack-acceptance.json>");
      }
      if (!outputDir) {
        throw new Error("nightly-eval deliver-slack requires --output-dir <nightly-report-dir>");
      }
    }
    if (scheduleHour !== undefined && (!Number.isFinite(scheduleHour) || scheduleHour < 0 || scheduleHour > 23)) {
      throw new Error("Invalid --schedule-hour: must be 0-23");
    }
  }

  if (command === "router" && positionals[1] === "capability" && positionals[2] === "install-schedule") {
    if (scheduleHour !== undefined && (!Number.isFinite(scheduleHour) || scheduleHour < 0 || scheduleHour > 23)) {
      throw new Error("Invalid --schedule-hour: must be 0-23");
    }
  }

  if (command === "stability") {
    if (!stabilitySubcommand) {
      throw new Error("stability requires a subcommand: post-deploy, nightly, full, review-latest, fix-draft");
    }
    if (stabilitySubcommand !== "review-latest" && stabilitySubcommand !== "fix-draft" && !outputDir) {
      throw new Error(`stability ${stabilitySubcommand} requires --output-dir <dir>`);
    }
  }

  return {
    command,
    format,
    legacyFormat,
    help,
    version,
    taskId,
    limit,
    service,
    mode,
    model,
    drift,
    once,
    incremental,
    cliMode,
    resume,
    input,
    baseline,
    candidate,
    outputDir,
    since,
    period,
    monthly,
    forTier,
    dispreferredFor,
    reason,
    nightlyFormat,
    calibrationFormat,
    config,
    repoUrl,
    branch,
    openclawHome,
    octoclawRoot,
    skipBuild,
    restartServices,
    scheduleHour,
    logDir,
    nonInteractive,
    autoRemoteJudge,
    cooldownOnly,
    lang,
    nightlyEvalSubcommand,
    slackAcceptanceFormat,
    stabilitySubcommand,
    cadence,
    extraArgs: positionals.slice(1),
  };
}

export function runOctoClawCtl(
  action: StatusSurfaceAction,
  record: RuntimeStateSurfaceRecord,
  format: LegacyCliFormat = "text",
): Promise<string> {
  return loadStatusSurface().then((statusSurface) => {
  if (format === "json") {
    return JSON.stringify(statusSurface.runStatusSurfaceOperator(action, record, "rich"), null, 2);
  }
  return String(statusSurface.runStatusSurfaceOperator(action, record, "text"));
  });
}

export function printUsage(): string {
  return [
    "Usage: octoclawctl <command> [options]",
    "",
    "Commands:",
    "  octoclawctl doctor [--json] [--lang zh|en] [--openclaw-home DIR]",
    "  octoclawctl init [--non-interactive] [--auto-remote-judge] [--lang zh|en] [--openclaw-home DIR]",
    "  octoclawctl install [--repo-url URL] [--branch NAME] [--openclaw-home DIR] [--octoclaw-root DIR] [--skip-build] [--restart]",
    "  octoclawctl update [--repo-url URL] [--branch NAME] [--openclaw-home DIR] [--octoclaw-root DIR] [--skip-build] [--restart]",
    "  octoclawctl deploy [--openclaw-home DIR] [--octoclaw-root DIR] [--skip-build] [--restart]",
    "  octoclawctl enable",
    "  octoclawctl disable",
    "  octoclawctl config get [key]",
    "  octoclawctl config set <key> <value>",
    "  octoclawctl restart [--service openclaw|runner]",
    "  octoclawctl uninstall",
    "  octoclawctl status [--format compact|table|lanes|anchors|json]",
    "  octoclawctl details <task-id>",
    "  octoclawctl queue",
    "  octoclawctl timeline [--task-id ID] [--limit N] [--format json]",
    "  octoclawctl health [--model] [--drift] [--format json]",
    "  octoclawctl up [--service openclaw|runner] [--mode ondemand|daemon]",
    "  octoclawctl down [--service openclaw|runner]",
    "  octoclawctl patrol [--once]",
    "  octoclawctl reconcile",
    "  octoclawctl repair",
    "  octoclawctl nightly --input <replay.jsonl> --output-dir <dir> [--format markdown|json]",
    "  octoclawctl nightly-eval run --config <eval-config.json> --output-dir <dir> [--format markdown|json]",
    "  octoclawctl nightly-eval install-launchagent --config <eval-config.json> --output-dir <dir> [--schedule-hour 2] [--log-dir <dir>]",
    "  octoclawctl nightly-eval uninstall-launchagent",
    "  octoclawctl nightly-eval print-plist --config <eval-config.json> --output-dir <dir> [--schedule-hour 2]",
    "  octoclawctl nightly-eval deliver-slack --config <slack-acceptance.json> --output-dir <nightly-report-dir> [--format markdown|json]",
    "  octoclawctl router wizard [--incremental]",
    "  octoclawctl router wizard --cli [--resume]",
    "  octoclawctl router wizard accept-proposal <model>",
    "  octoclawctl router decisions [--since 7d] [--format text|json]",
    "  octoclawctl router promotion review [--input <shadow.jsonl>] [--format text|json]",
    "  octoclawctl router promotion nightly-review [--input <shadow.jsonl>] [--format text|json]",
    "  octoclawctl router cost report [--period 1d|7d|30d|month] [--format text|json]",
    "  octoclawctl router score override <model> <tier>=<score>",
    "  octoclawctl router model mark <model> --dispreferred-for <tier>",
    "  octoclawctl router model ban <model> --for <tier>",
    "  octoclawctl router capability refresh [--output-dir <dir>] [--format json]",
    "  octoclawctl router capability list [--input <snapshot.json>] [--format text|json]",
    "  octoclawctl router capability show <model> [--input <snapshot.json>] [--format text|json]",
    "  octoclawctl router capability snapshot show [--input <snapshot.json>] [--format text|json]",
    "  octoclawctl router capability lookup <model> [--input <snapshot.json>] [--format text|json]",
    "  octoclawctl router capability probe <model> [--input <snapshot.json>] [--format text|json]",
    "  octoclawctl router capability install-schedule [--schedule-hour 4] [--openclaw-home DIR] [--format text|json]",
    "  octoclawctl router model-intel refresh [--output-dir <dir>] [--openclaw-home <dir>] [--format json]",
    "  octoclawctl router health aggregate|list|show <model>|suggest-fallbacks [--format text|json]",
    "  octoclawctl router model-config analyze [--input <snapshot.json>] [--output-dir <dir>] [--format json]",
    "  octoclawctl router shadow-report [--input <shadow.jsonl>] [--format json]",
    "  octoclawctl slack-acceptance --config <acceptance.json> --output-dir <dir> [--format markdown|json]",
    "  octoclawctl calibration-gate --baseline <report.json> --candidate <report.json> --output-dir <dir> [--format markdown|json]",
    "  octoclawctl stability post-deploy --output-dir <dir> [--config <config>] [--format json]",
    "  octoclawctl stability nightly --output-dir <dir> [--config <config>] [--format json]",
    "  octoclawctl stability full --output-dir <dir> [--cadence 3d] [--config <config>] [--format json]",
    "  octoclawctl stability review-latest --output-dir <dir> [--format json]",
    "  octoclawctl stability fix-draft --output-dir <dir> [--format json]",
    "",
    "Compatibility:",
    "  status/details/queue/timeline keep existing status-surface behavior when runtime env vars are present.",
  ].join("\n");
}

async function readPidFromFile(filePath: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveOpenClawBinary(env: Record<string, string | undefined>): string {
  const pathEntries = asString(env.PATH).split(path.delimiter).filter(Boolean);
  const explicit = asString(env.OPENCLAW_BIN).trim();
  const candidates = [
    explicit,
    ...pathEntries.map((entry) => path.join(entry, "openclaw")),
    "/usr/local/bin/openclaw",
    "/opt/homebrew/bin/openclaw",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  throw new Error("Unable to find openclaw binary. Set OPENCLAW_BIN or add openclaw to PATH.");
}

async function spawnAndCollect(command: string, args: string[], options: SpawnOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Uint8Array | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Uint8Array | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function parseFirstJsonRecord(text: string): JsonRecord | undefined {
  const direct = tryParseJsonRecord(text);
  if (direct) return direct;

  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
        continue;
      }
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJsonRecord(text.slice(start, index + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  return undefined;
}

function tryParseJsonRecord(text: string): JsonRecord | undefined {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function spawnDaemon(command: string, args: string[], logFilePath: string, pidFilePath: string, env: Record<string, string | undefined>): Promise<number> {
  await ensureDir(path.dirname(logFilePath));
  const out = fsSync.openSync(logFilePath, "a");
  const child: ChildProcess = spawn(command, args, {
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  if (!child.pid) {
    throw new Error(`Failed to start daemon: ${command}`);
  }
  await fs.writeFile(pidFilePath, `${child.pid}\n`, "utf8");
  return child.pid;
}

async function stopPidFile(pidFilePath: string): Promise<number | undefined> {
  const pid = await readPidFromFile(pidFilePath);
  if (!pid) {
    return undefined;
  }
  if (isPidAlive(pid)) {
    process.kill(pid, "SIGTERM");
  }
  await fs.rm(pidFilePath, { force: true });
  return pid;
}

async function manageService(
  action: "up" | "down" | "restart",
  service: ServiceName,
  mode: RunnerMode,
  env: Record<string, string | undefined>,
): Promise<ServiceState> {
  const binaryPath = resolveOpenClawBinary(env);
  const pidFilePath = resolveServicePidFile(env, service);
  const logFilePath = resolveServiceLogFile(env, service);

  if (action === "down" || action === "restart") {
    await stopPidFile(pidFilePath);
    const stopArgs = service === "openclaw" ? ["gateway", "stop"] : ["runner", "stop"];
    await spawnAndCollect(binaryPath, stopArgs, { env: { ...process.env, ...env } });
  }

  if (action === "up" || action === "restart") {
    if (service === "openclaw") {
      const startArgs = ["gateway", "start"];
      if (mode === "daemon") {
        await spawnDaemon(binaryPath, startArgs, logFilePath, pidFilePath, env);
      } else {
        await spawnAndCollect(binaryPath, startArgs, { env: { ...process.env, ...env } });
      }
    } else if (mode === "daemon") {
      await spawnDaemon(binaryPath, ["runner", "start", "--mode", "daemon"], logFilePath, pidFilePath, env);
    } else {
      await fs.rm(pidFilePath, { force: true });
      await spawnAndCollect(binaryPath, ["runner", "start", "--mode", "ondemand"], { env: { ...process.env, ...env } });
    }
  }

  const pid = await readPidFromFile(pidFilePath);
  return {
    service,
    action,
    mode,
    binaryPath,
    pidFilePath,
    logFilePath,
    state: pid && isPidAlive(pid) ? "running" : (action === "down" ? "stopped" : mode === "ondemand" ? "ondemand" : "started"),
    pid,
  };
}

async function runOperationalCommand(commandName: "patrol" | "reconcile" | "repair", env: Record<string, string | undefined>, once: boolean): Promise<string> {
  const binaryPath = resolveOpenClawBinary(env);
  const args = [commandName, ...(commandName === "patrol" && once ? ["--once"] : [])];
  const result = await spawnAndCollect(binaryPath, args, { env: { ...process.env, ...env } });
  if (result.code !== 0) {
    throw new Error(result.stderr || `${commandName} failed`);
  }
  return result.stdout || `${commandName} completed`;
}

function renderServiceState(state: ServiceState): string {
  return [
    `${state.service} ${state.action}`,
    `binary=${state.binaryPath}`,
    `mode=${state.mode}`,
    `state=${state.state}`,
    state.pid ? `pid=${state.pid}` : null,
    `log=${state.logFilePath}`,
  ].filter(Boolean).join("\n");
}

async function runNightlyCommand(parsed: ParsedCliArgs, _env: Record<string, string | undefined>): Promise<string> {
  const inputPath = parsed.input!;
  const outputDirPath = parsed.outputDir!;
  const format = parsed.nightlyFormat;

  const content = await fs.readFile(inputPath, "utf8");
  const lines = content.split(/\r?\n/u);
  const rawEvents: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rawEvents.push(JSON.parse(line));
    } catch {
      throw new Error(`Nightly harness: malformed JSON at line ${i + 1}: ${line.slice(0, 80)}`);
    }
  }

  validateReplayEvents(rawEvents);
  const report = generateNightlyReport(rawEvents as import("./nightly/index.js").ReplayEvent[]);

  await ensureDir(outputDirPath);
  const dateStr = report.inputDateRange.latest
    ? new Date(report.inputDateRange.latest).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const jsonPath = path.join(outputDirPath, `${dateStr}.json`);
  const mdPath = path.join(outputDirPath, `${dateStr}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(mdPath, renderMarkdownReport(report), "utf8");

  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  return `Written: ${jsonPath}\nWritten: ${mdPath}`;
}

async function runSlackAcceptanceCliCommand(parsed: ParsedCliArgs, env: Record<string, string | undefined>): Promise<string> {
  const configPath = parsed.config!;
  const outputDirPath = parsed.outputDir!;
  const format = parsed.slackAcceptanceFormat;

  const resolvedConfig = await loadSlackAcceptanceConfig(configPath, env);
  const client = new SlackWebApiAcceptanceClient(resolvedConfig.botToken, { postToken: resolvedConfig.userToken, requestTimeoutMs: resolvedConfig.requestTimeoutMs });
  const report = await runSlackAcceptanceHarness(client, resolvedConfig);

  await ensureDir(outputDirPath);
  const dateStr = new Date().toISOString().slice(0, 19).replace(/[T:]/gu, "-");
  const jsonPath = path.join(outputDirPath, `slack-acceptance-${dateStr}.json`);
  const mdPath = path.join(outputDirPath, `slack-acceptance-${dateStr}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(mdPath, renderSlackAcceptanceMarkdown(report), "utf8");

  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  return `Written: ${jsonPath}\nWritten: ${mdPath}\nGate: ${report.overallGate} pass=${report.pass} fail=${report.fail}`;
}

async function runCalibrationGateCliCommand(parsed: ParsedCliArgs, _env: Record<string, string | undefined>): Promise<string> {
  const baselinePath = parsed.baseline!;
  const candidatePath = parsed.candidate!;
  const outputDirPath = parsed.outputDir!;
  const format = parsed.calibrationFormat;

  const [baselineRaw, candidateRaw] = await Promise.all([
    fs.readFile(baselinePath, "utf8"),
    fs.readFile(candidatePath, "utf8"),
  ]);

  let baseline: CalibrationInputFile;
  let candidate: CalibrationInputFile;
  try {
    baseline = normalizeCalibrationInputFile(JSON.parse(baselineRaw)) as CalibrationInputFile;
  } catch {
    throw new Error(`Calibration gate: malformed baseline JSON: ${baselinePath}`);
  }
  try {
    candidate = normalizeCalibrationInputFile(JSON.parse(candidateRaw)) as CalibrationInputFile;
  } catch {
    throw new Error(`Calibration gate: malformed candidate JSON: ${candidatePath}`);
  }

  const report = runCalibrationGate(baseline, candidate);

  await ensureDir(outputDirPath);
  const dateStr = new Date().toISOString().slice(0, 19).replace(/[T:]/gu, "-");
  const jsonPath = path.join(outputDirPath, `calibration-${dateStr}.json`);
  const mdPath = path.join(outputDirPath, `calibration-${dateStr}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(mdPath, renderCalibrationMarkdown(report), "utf8");

  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  return `Written: ${jsonPath}\nWritten: ${mdPath}\nGate: ${report.overallGate}`;
}

async function runNightlyEvalCommand(parsed: ParsedCliArgs, env: Record<string, string | undefined>): Promise<string> {
  const configPath = parsed.config!;
  const outputDirPath = parsed.outputDir!;
  const format = parsed.calibrationFormat;

  const configRaw = await fs.readFile(configPath, "utf8");
  await ensureDir(outputDirPath);
  let evalConfig: NightlyEvalConfig;
  try {
    evalConfig = parseNightlyEvalConfig(JSON.parse(configRaw));
  } catch {
    throw new Error(`Nightly eval: malformed config JSON: ${configPath}`);
  }

  const report = await runNightlyEval({
    config: evalConfig,
    outputDir: outputDirPath,
    env,
    openclawHome: parsed.openclawHome ?? path.join(os.homedir(), ".openclaw"),
    nightlyRunner: async (replayPath: string, filterOptions) => {
      const content = await fs.readFile(replayPath, "utf8");
      const lines = content.split(/\r?\n/u);
      const rawEvents: unknown[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          rawEvents.push(JSON.parse(line));
        } catch {
          throw new Error(`Nightly eval: malformed JSON at line ${i + 1}`);
        }
      }
      validateReplayEvents(rawEvents);
      const filter = filterNightlyReplayEvents(rawEvents as import("./nightly/index.js").ReplayEvent[], filterOptions);
      return generateNightlyReport(filter.events, filter.metadata);
    },
    slackRunner: evalConfig.slackAcceptanceConfig ? async (configPath: string, runnerEnv: Record<string, string | undefined>) => {
      const resolved = await loadSlackAcceptanceConfig(configPath, runnerEnv);
      const client = new SlackWebApiAcceptanceClient(resolved.botToken, { postToken: resolved.userToken });
      return runSlackAcceptanceHarness(client, resolved);
    } : undefined,
    // Always provide calibrationRunner so auto-baseline works even without explicit config
    calibrationRunner: async (baselinePath: string, candidatePath: string) => {
      const [blRaw, clRaw] = await Promise.all([
        fs.readFile(baselinePath, "utf8"),
        fs.readFile(candidatePath, "utf8"),
      ]);
      return runCalibrationGate(
        normalizeCalibrationInputFile(JSON.parse(blRaw)),
        normalizeCalibrationInputFile(JSON.parse(clRaw)),
      );
    },
    fileWriter: async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, "utf8");
    },
  });

  if (format === "json") {
    return JSON.stringify(sanitizeAggregateReport(report), null, 2);
  }
  renderNightlyEvalMarkdown(report);
  return `Written: ${outputDirPath}\nGate: ${report.overallGate}\nNightly: ${report.steps.nightly.status}\nSlack: ${report.steps.slackAcceptance.status}\nCalibration: ${report.steps.calibration.status}`;
}

async function runNightlyEvalSlackDeliveryCommand(parsed: ParsedCliArgs, env: Record<string, string | undefined>): Promise<string> {
  const configPath = parsed.config!;
  const outputDirPath = parsed.outputDir!;
  const reportPath = await findLatestNightlyEvalReport(outputDirPath);
  const reportRaw = await fs.readFile(reportPath, "utf8");
  let report: NightlyEvalConfigReport;
  try {
    report = JSON.parse(reportRaw) as NightlyEvalConfigReport;
  } catch {
    throw new Error(`Nightly eval delivery: malformed report JSON: ${reportPath}`);
  }
  if (!isNightlyEvalAggregateReport(report)) {
    throw new Error(`Nightly eval delivery: invalid report schema: ${reportPath}`);
  }

  const slackConfig = await loadSlackAcceptanceConfig(configPath, env);
  const client = new SlackWebApiAcceptanceClient(slackConfig.botToken);
  const message = renderNightlyEvalSlackSummary(report, reportPath);
  const delivery = await client.postMessage({
    channel: slackConfig.target.channel,
    threadTs: slackConfig.target.threadTs,
    text: message,
  });
  if (!delivery.ok) {
    throw new Error(`Nightly eval delivery: slack post failed: ${delivery.error || "unknown"}`);
  }

  if (parsed.calibrationFormat === "json") {
    return JSON.stringify({ delivered: true, channel: delivery.channel, ts: delivery.ts, threadTs: delivery.threadTs, reportPath }, null, 2);
  }
  return `Delivered nightly eval report to Slack: channel=${delivery.channel} ts=${delivery.ts} report=${reportPath}`;
}

type NightlyEvalConfigReport = unknown;

async function findLatestNightlyEvalReport(outputDirPath: string): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(outputDirPath, { withFileTypes: true });
  } catch {
    throw new Error(`Nightly eval delivery: report directory not found: ${outputDirPath}`);
  }
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith("-nightly-eval.json"))
    .sort();
  const latest = candidates[candidates.length - 1];
  if (!latest) {
    throw new Error(`Nightly eval delivery: no *-nightly-eval.json report found in ${outputDirPath}`);
  }
  return path.join(outputDirPath, latest);
}

function isNightlyEvalAggregateReport(value: unknown): value is import("./nightly-eval/index.js").NightlyEvalAggregateReport {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { schemaVersion?: unknown }).schemaVersion === "octoclaw.nightly_eval.report/v1";
}

async function runNightlyEvalLaunchAgentCommand(parsed: ParsedCliArgs, _env: Record<string, string | undefined>): Promise<string> {
  const label = defaultLabel();
  const plistPath = defaultPlistPath();

  if (parsed.nightlyEvalSubcommand === "uninstall-launchagent") {
    try {
      await uninstallLaunchAgent(plistPath);
    } catch {
      // tolerate — may not be loaded
    }
    try {
      await fs.rm(plistPath, { force: true });
    } catch {
      // tolerate — may not exist
    }
    return `Uninstalled LaunchAgent: ${label}`;
  }

  const configPath = resolvePath(parsed.config!);
  const outputDirPath = resolvePath(parsed.outputDir!);
  const hour = parsed.scheduleHour ?? 2;

  validateScheduleHour(hour);

  const nodePath = resolveStableNodePath(process.argv[0] ?? "node");
  const cliPath = process.argv[1] ?? "octoclawctl";
  const logDir = parsed.logDir ?? path.join(path.dirname(plistPath), "..", "Logs", "octoclaw");
  const resolvedLogDir = resolvePath(logDir);

  const launchConfig: LaunchAgentConfig = {
    label,
    nodePath: resolvePath(nodePath),
    cliPath: resolvePath(cliPath),
    configPath,
    outputDir: outputDirPath,
    scheduleHour: hour,
    logDir: resolvedLogDir,
  };

  if (parsed.nightlyEvalSubcommand === "print-plist") {
    return generateLaunchAgentPlist(launchConfig);
  }

  if (parsed.nightlyEvalSubcommand === "install-launchagent") {
    const plist = generateLaunchAgentPlist(launchConfig);
    await ensureDir(path.dirname(plistPath));
    await ensureDir(resolvedLogDir);
    await fs.writeFile(plistPath, plist, "utf8");
    await installLaunchAgent(plistPath);
    return `Installed LaunchAgent: ${label}\nPlist: ${plistPath}\nSchedule: daily at ${String(hour).padStart(2, "0")}:00\nLogs: ${resolvedLogDir}`;
  }

  throw new Error(`Unknown nightly-eval subcommand: ${parsed.nightlyEvalSubcommand}`);
}

function resolveRouterLiteOutputDir(parsed: ParsedCliArgs, openclawHome: string): string {
  return resolvePath(parsed.outputDir ?? path.join(openclawHome, "workspace", "tmp", "octopus", "router-lite"));
}

async function runOpenClawJsonCommand(args: string[], env: Record<string, string | undefined>): Promise<JsonRecord | undefined> {
  let binaryPath: string;
  try {
    binaryPath = resolveOpenClawBinary(env);
  } catch {
    return undefined;
  }

  const result = await spawnAndCollect(binaryPath, args, { env: { ...process.env, ...env } });
  if (result.code !== 0) {
    return undefined;
  }
  return parseFirstJsonRecord(result.stdout);
}

async function runOpenClawCommand(args: string[], env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string }> {
  const binaryPath = resolveOpenClawBinary(env);
  const result = await spawnAndCollect(binaryPath, args, { env: { ...process.env, ...env } });
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.code}`;
    throw new Error(`openclaw ${args.join(" ")} failed: ${detail}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function openClawHomeEnv(openclawHome: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_STATE_DIR: openclawHome,
    OPENCLAW_CONFIG_PATH: path.join(openclawHome, "openclaw.json"),
  };
}

function assertModelIntelSnapshot(value: unknown, filePath: string): ModelIntelSnapshot {
  if (!isRecord(value) || value.schemaVersion !== "octoclaw.router_lite.model_intel_snapshot/v1" || !Array.isArray(value.models)) {
    throw new Error(`Invalid router-lite model intel snapshot: ${filePath}`);
  }
  return value as unknown as ModelIntelSnapshot;
}

function countModels(snapshot: ModelIntelSnapshot): { configured: number; proposalOnly: number } {
  return {
    configured: snapshot.models.filter((model) => model.configured).length,
    proposalOnly: snapshot.models.filter((model) => model.proposalOnly).length,
  };
}

function countHealthModels(healthSnapshot: unknown): { models: number; cooldown: number } {
  const models = asRecord(asRecord(healthSnapshot).models);
  const values = Object.values(models).map((value) => asRecord(value));
  return {
    models: values.length,
    cooldown: values.filter((model) => model.cooldown === true).length,
  };
}

function resolveCapabilitySnapshotPath(parsed: ParsedCliArgs, openclawHome: string): string {
  return resolvePath(parsed.input ?? path.join(openclawHome, "octoclaw", "router-lite", "model-intel-snapshot.json"));
}

async function readModelIntelSnapshot(filePath: string): Promise<ModelIntelSnapshot> {
  return assertModelIntelSnapshot(await readJsonFile(filePath), filePath);
}

async function readOptionalModelIntelSnapshot(filePath: string): Promise<ModelIntelSnapshot | undefined> {
  const value = await readJsonFile(filePath);
  if (!isRecord(value) || value.schemaVersion !== "octoclaw.router_lite.model_intel_snapshot/v1" || !Array.isArray(value.models)) {
    return undefined;
  }
  return value as unknown as ModelIntelSnapshot;
}

function sourceSet(model: ModelIntelSnapshot["models"][number]): Set<string> {
  return new Set([
    ...(model.sources ?? []),
    ...(model.marketPrice.sources ?? []),
    ...(model.capability.sources ?? []),
    ...(model.health.sources ?? []),
    ...(model.plan.sources ?? []),
  ]);
}

function hasAnySource(model: ModelIntelSnapshot["models"][number], sources: string[]): boolean {
  const set = sourceSet(model);
  return sources.some((source) => set.has(source));
}

function isNativeOrUserModel(model: ModelIntelSnapshot["models"][number], nativeFallbacks: Set<string>): boolean {
  if (model.configured === true || model.proposalOnly === false) return true;
  if (nativeFallbacks.has(model.modelKey)) return true;
  if (model.tags.some((tag) => tag === "configured" || tag === "default" || tag.startsWith("fallback"))) return true;
  return hasAnySource(model, [
    "openclaw_config",
    "openclaw_models_list",
    "legacy_model_catalog",
    "provider_alias:openai",
    "operator_override",
  ]);
}

function isCommonPublicRouterCandidate(model: ModelIntelSnapshot["models"][number]): boolean {
  if (hasAnySource(model, ["packaged_leaderboard", "pinchbench", "aider", "bfcl", "swe_bench"])) return true;
  const provider = model.provider.toLowerCase();
  const text = `${model.modelKey} ${model.name ?? ""}`.toLowerCase();
  if (provider === "openai" || text.includes("openai/gpt-") || text.includes("/gpt-")) return true;
  if (provider === "anthropic" || text.includes("anthropic/claude") || text.includes("claude-")) return true;
  if (provider === "google" || provider === "gemini" || text.includes("google/gemini") || text.includes("gemini-")) return true;
  if (provider === "deepseek" || text.includes("deepseek/")) return true;
  if (provider === "qwen" || text.includes("qwen/") || text.includes("qwen-")) return true;
  if (provider === "zhipu" || provider === "zai" || text.includes("glm-")) return true;
  if (provider === "xai" || text.includes("grok-")) return true;
  if (provider === "mistral" || text.includes("mistral")) return true;
  if (provider === "moonshot" || text.includes("kimi")) return true;
  return false;
}

function modelSlimRank(model: ModelIntelSnapshot["models"][number]): number {
  const tier = model.capability.codingTier;
  const confidence = model.capability.confidence;
  return (
    (hasAnySource(model, ["packaged_leaderboard"]) ? 100 : 0)
    + (tier === "frontier" ? 80 : tier === "strong" ? 60 : tier === "standard" ? 40 : tier === "mini" ? 20 : 0)
    + (confidence === "high" ? 12 : confidence === "medium" ? 8 : confidence === "low" ? 4 : 0)
    + (model.marketPrice.blendedUsdPerMTok !== undefined ? 2 : 0)
  );
}

function slimModelIntelSnapshot(snapshot: ModelIntelSnapshot, maxModels = ROUTER_MODEL_INTEL_SLIM_LIMIT): ModelIntelSnapshot {
  const nativeFallbacks = new Set(snapshot.nativeFallbackOrder ?? []);
  const always = snapshot.models.filter((model) => isNativeOrUserModel(model, nativeFallbacks));
  const alwaysKeys = new Set(always.map((model) => model.modelKey));
  const common = snapshot.models
    .filter((model) => !alwaysKeys.has(model.modelKey) && isCommonPublicRouterCandidate(model))
    .sort((a, b) => modelSlimRank(b) - modelSlimRank(a) || a.modelKey.localeCompare(b.modelKey));
  const remainingSlots = Math.max(0, maxModels - always.length);
  const models = [...always, ...common.slice(0, remainingSlots)]
    .sort((a, b) => a.modelKey.localeCompare(b.modelKey));
  return {
    ...snapshot,
    models,
    sourceStatus: [
      ...snapshot.sourceStatus,
      { source: "octoclaw_router_slim_snapshot", status: "ok" as const, detail: `models=${models.length}/${snapshot.models.length}` },
    ],
  };
}

function injectedCapabilitySourceJson(env: Record<string, string | undefined>, key: "openrouter" | "modelsDev" | "litellm"): ((url: string) => Promise<unknown>) | undefined {
  const raw = env.OCTOCLAW_ROUTER_CAPABILITY_SOURCES_JSON;
  if (!raw) return undefined;
  return async () => asRecord(JSON.parse(raw))[key];
}

function formatCapabilityList(snapshot: ModelIntelSnapshot, format: "json" | "text"): string {
  const models = snapshot.models.map((model) => ({
    modelKey: model.modelKey,
    provider: model.provider,
    tier: model.capability.codingTier,
    price: model.marketPrice.blendedUsdPerMTok,
    contextWindow: model.capability.contextWindow,
    sources: model.sources,
  }));
  if (format === "json") return JSON.stringify({ snapshotId: snapshot.snapshotId, generatedAt: snapshot.generatedAt, models }, null, 2);
  return [
    `Capability snapshot: ${snapshot.snapshotId}`,
    ...models.map((model) => `${model.modelKey} tier=${model.tier} price=${model.price ?? "unknown"} context=${model.contextWindow ?? "unknown"} sources=${model.sources.join(",")}`),
  ].join("\n");
}

function formatCapabilityFreshness(freshness: string | undefined, now = Date.now()): string {
  const timestamp = Date.parse(freshness ?? "");
  if (Number.isNaN(timestamp)) return "data very_stale (unknown age)";

  const ageDays = Math.max(0, Math.floor((now - timestamp) / (1000 * 60 * 60 * 24)));
  const status = ageDays < 14 ? "fresh" : ageDays < 90 ? "stale" : "very_stale";
  return `data ${status} (${ageDays} days)`;
}

function formatCapabilityShow(snapshot: ModelIntelSnapshot, modelKey: string, format: "json" | "text"): string {
  const normalized = modelKey.toLowerCase();
  const model = snapshot.models.find((item) => item.modelKey.toLowerCase() === normalized);
  if (!model) throw new Error(`Capability model not found: ${modelKey}`);
  if (format === "json") return JSON.stringify(model, null, 2);
  return [
    model.modelKey,
    `tier: ${model.capability.codingTier} (${model.capability.confidence})`,
    `price: ${model.marketPrice.blendedUsdPerMTok ?? "unknown"} USD/MTok blended`,
    `context: ${model.capability.contextWindow ?? "unknown"}`,
    `toolUse: ${model.capability.toolUse}`,
    `structuredOutput: ${model.capability.structuredOutput}`,
    `reasoning: ${model.capability.reasoning}`,
    `freshness: ${formatCapabilityFreshness(model.freshness)}`,
    `sources: ${model.sources.join(", ") || "(none)"}`,
  ].join("\n");
}

function formatCapabilitySnapshotShow(snapshot: ModelIntelSnapshot, format: "json" | "text"): string {
  const sourceStatus = snapshot.sourceStatus.map((source) => `${source.source}:${source.status}`);
  const generatedAtMs = Date.parse(snapshot.generatedAt);
  const snapshotAgeDays = Number.isNaN(generatedAtMs) ? undefined : Math.max(0, Math.floor((Date.now() - generatedAtMs) / (1000 * 60 * 60 * 24)));
  const stale = snapshotAgeDays === undefined || snapshotAgeDays >= 7;
  const payload = {
    snapshotId: snapshot.snapshotId,
    generatedAt: snapshot.generatedAt,
    snapshotAgeDays,
    stale,
    models: snapshot.models.length,
    sourceStatus: snapshot.sourceStatus,
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    `Capability snapshot: ${snapshot.snapshotId}`,
    `generatedAt=${snapshot.generatedAt}`,
    `stale=${stale}${snapshotAgeDays === undefined ? " age=unknown" : ` ageDays=${snapshotAgeDays}`}`,
    `models=${snapshot.models.length}`,
    `sources=${sourceStatus.join(", ") || "(none)"}`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function routerCapabilityRefreshCommands(openclawHome: string, outputDir: string): { capabilityRefresh: string; modelIntelRefresh: string } {
  const nodePath = resolvePath(resolveStableNodePath(process.argv[0] ?? "node"));
  const cliPath = resolvePath(process.argv[1] ?? "octoclawctl");
  const cli = `${shellQuote(nodePath)} ${shellQuote(cliPath)}`;
  return {
    capabilityRefresh: `${cli} router capability refresh --output-dir ${shellQuote(outputDir)} --format json`,
    modelIntelRefresh: `${cli} router model-intel refresh --output-dir ${shellQuote(outputDir)} --openclaw-home ${shellQuote(openclawHome)} --format json`,
  };
}

function buildRouterCapabilityScheduleMessage(openclawHome: string, outputDir: string): string {
  const commands = routerCapabilityRefreshCommands(openclawHome, outputDir);
  return [
    "你是 OpenClaw cron 的轻量调度壳。只刷新 OctoClaw AutoRouter 本地能力数据，不要修改模型配置，不要投递 IM。",
    "",
    "请在本机按顺序执行下面两条命令：",
    commands.capabilityRefresh,
    commands.modelIntelRefresh,
    "",
    "要求：",
    "- 只运行上面两条命令。",
    "- 如果第一条失败，不要运行第二条，最终内部摘要说明失败命令和关键 stderr。",
    "- 如果两条都成功，最终内部摘要只写 slim snapshot 路径、full catalog 路径、模型数量和 Health 行。",
    "- 不要泄露 token、API key、完整 openclaw.json 或完整日志。",
  ].join("\n");
}

function cronJobsFromList(value: JsonRecord | undefined): JsonRecord[] {
  const jobs = asRecord(value).jobs;
  return Array.isArray(jobs) ? jobs.map((job) => asRecord(job)) : [];
}

function findRouterCapabilityRefreshCronJob(value: JsonRecord | undefined): JsonRecord | undefined {
  return cronJobsFromList(value).find((job) => asString(job.name) === ROUTER_CAPABILITY_REFRESH_CRON_NAME);
}

async function runRouterCapabilityInstallSchedule(input: {
  openclawHome: string;
  outputDir: string;
  env: Record<string, string | undefined>;
  scheduleHour?: number;
  format: "json" | "text";
}): Promise<string> {
  const hour = input.scheduleHour ?? 4;
  validateScheduleHour(hour);
  const cron = `0 ${hour} * * *`;
  const commandEnv = openClawHomeEnv(input.openclawHome, input.env);
  const existingList = await runOpenClawJsonCommand(["cron", "list", "--json"], commandEnv);
  const existing = findRouterCapabilityRefreshCronJob(existingList);
  const message = buildRouterCapabilityScheduleMessage(input.openclawHome, input.outputDir);
  const description = "Managed by OctoClaw: refresh AutoRouter capability/model-intel snapshots. No IM delivery; no model config mutation.";
  const commonArgs = [
    "--name",
    ROUTER_CAPABILITY_REFRESH_CRON_NAME,
    "--cron",
    cron,
    "--tz",
    "Asia/Shanghai",
    "--session",
    "isolated",
    "--wake",
    "now",
    "--light-context",
    "--tools",
    "exec",
    "--timeout-seconds",
    "900",
    "--no-deliver",
    "--description",
    description,
    "--message",
    message,
  ];
  const existingId = asString(existing?.id);
  const action = existingId ? "updated" : "created";
  const args = existingId
    ? ["cron", "edit", existingId, "--enable", ...commonArgs]
    : ["cron", "add", ...commonArgs];
  const result = await runOpenClawCommand(args, commandEnv);
  const response = parseFirstJsonRecord(result.stdout);
  const jobId = asString(asRecord(response).id) || existingId || undefined;
  const payload = {
    action,
    jobId,
    name: ROUTER_CAPABILITY_REFRESH_CRON_NAME,
    cron,
    tz: "Asia/Shanghai",
    outputDir: input.outputDir,
  };
  if (input.format === "json") return JSON.stringify(payload, null, 2);
  return [
    `Router capability refresh schedule ${action}: ${ROUTER_CAPABILITY_REFRESH_CRON_NAME}`,
    `jobId=${jobId ?? "unknown"}`,
    `cron=${cron} tz=Asia/Shanghai`,
    `outputDir=${input.outputDir}`,
  ].join("\n");
}

function formatCapabilityLookup(snapshot: ModelIntelSnapshot, modelKey: string, format: "json" | "text"): string {
  const normalized = modelKey.toLowerCase();
  const model = snapshot.models.find((item) => item.modelKey.toLowerCase() === normalized);
  const result = model
    ? { model: model.modelKey, ok: model.available !== "no", reason: model.available === "no" ? "known_unavailable" : "known_available", sources: model.sources }
    : { model: modelKey, ok: false, reason: "unknown_model", sources: [] };
  return format === "json" ? JSON.stringify(result, null, 2) : `Capability lookup ${result.model}: ${result.ok ? "ok" : "failed"} (${result.reason})`;
}

function combineModelIntelSnapshots(base: ModelIntelSnapshot, overlay: ModelIntelSnapshot | undefined): ModelIntelSnapshot {
  if (!overlay) return base;
  return {
    ...base,
    snapshotId: overlay.snapshotId || base.snapshotId,
    generatedAt: overlay.generatedAt || base.generatedAt,
    sourceStatus: [...base.sourceStatus, ...overlay.sourceStatus],
    models: [...base.models, ...overlay.models],
  };
}

async function writeModelIntelSnapshot(filePath: string, snapshot: ModelIntelSnapshot): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function runCapabilityProbe(input: {
  snapshot: ModelIntelSnapshot;
  modelKey: string;
  openclawHome: string;
  format: "json" | "text";
  env: Record<string, string | undefined>;
}): Promise<string> {
  const router = await loadRouter();
  const openclawConfig = await readJsonFile(path.join(input.openclawHome, "openclaw.json"));
  const providerConfig = router.resolveProviderForModel(input.modelKey, openclawConfig) ?? nativeOpenClawProviderConfig(input.modelKey);
  const model = input.snapshot.models.find((item) => item.modelKey.toLowerCase() === input.modelKey.toLowerCase());
  const mockProbe = input.env.OCTOCLAW_ROUTER_PROBE_MOCK_JSON;
  const probeRunner = mockProbe
    ? { runOpenClaw: async () => ({ exitCode: 0, stdout: mockProbe }), cleanup: async () => {} }
    : await createOpenClawProbeRunner(input.modelKey, input.openclawHome, openclawConfig, input.env);
  const healthSink = router.createHealthEventSink({
    jsonlPath: path.join(input.openclawHome, "octoclaw", "router-lite", "model-health.jsonl"),
    snapshotPath: path.join(input.openclawHome, "octoclaw", "router-lite", "model-health-snapshot.json"),
  });
  let result: Awaited<ReturnType<RouterModule["probeModel"]>>;
  try {
    result = await router.probeModel({
      modelKey: input.modelKey,
      providerConfig,
      estimatedBlendedUsdPerMTok: model?.marketPrice.blendedUsdPerMTok,
      runOpenClaw: probeRunner.runOpenClaw,
      recordHealthEvent: (event) => healthSink.recordCall(event),
    });
    await healthSink.flush();
    if (result.ok) {
      await router.recordProbeSuccess(input.modelKey, input.openclawHome);
    }
  } finally {
    await probeRunner.cleanup();
  }
  if (input.format === "json") return JSON.stringify(result, null, 2);
  return [
    `Capability probe ${result.modelKey}: ${result.ok ? "ok" : "failed"}`,
    `authOk=${result.authOk} modelExists=${result.modelExists} toolUseOk=${result.toolUseOk}`,
    `latencyMs=${result.latencyMs ?? "unknown"} costUsd=${result.costUsd ?? "unknown"}`,
    ...(result.error ? [`error=${result.error.code}: ${result.error.message}`] : []),
  ].join("\n");
}

function modelKeyParts(modelKey: string): { providerId: string; modelId: string } {
  const slash = modelKey.indexOf("/");
  return slash > 0
    ? { providerId: modelKey.slice(0, slash), modelId: modelKey.slice(slash + 1) }
    : { providerId: "openclaw", modelId: modelKey };
}

function providerModelsForProbe(providerBlock: JsonRecord): unknown[] {
  return Array.isArray(providerBlock.models) ? providerBlock.models : [];
}

function providerHasProbeModel(providerBlock: JsonRecord, modelId: string, modelKey: string): boolean {
  return providerModelsForProbe(providerBlock).some((entry) => {
    if (typeof entry === "string") return entry === modelId || entry === modelKey;
    const id = asString(asRecord(entry).id);
    return id === modelId || id === modelKey;
  });
}

function cloneJsonRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function createOpenClawProbeHome(
  modelKey: string,
  openclawHome: string,
  openclawConfig: unknown,
): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const { providerId, modelId } = modelKeyParts(modelKey);
  const configCopy = cloneJsonRecord(openclawConfig);
  const providers = asRecord(asRecord(asRecord(configCopy).models).providers);
  const providerBlock = asRecord(providers[providerId]);
  if (!isRecord(providerBlock) || providerHasProbeModel(providerBlock, modelId, modelKey)) {
    return { home: openclawHome, cleanup: async () => {} };
  }

  providerBlock.models = [...providerModelsForProbe(providerBlock), { id: modelId, name: modelId }];
  providers[providerId] = providerBlock;
  const tempHome = path.join(
    path.dirname(openclawHome),
    `.octoclaw-probe-openclaw-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tempHome, { recursive: false });
  await fs.writeFile(path.join(tempHome, "openclaw.json"), `${JSON.stringify(configCopy, null, 2)}\n`, "utf8");
  return {
    home: tempHome,
    cleanup: async () => {
      await fs.rm(tempHome, { recursive: true, force: true });
    },
  };
}

async function createOpenClawProbeRunner(
  modelKey: string,
  openclawHome: string,
  openclawConfig: unknown,
  env: Record<string, string | undefined>,
): Promise<{ runOpenClaw: RouterModule["probeModel"] extends (request: infer Request) => unknown ? NonNullable<Request extends { runOpenClaw?: infer Runner } ? Runner : never> : never; cleanup: () => Promise<void> }> {
  const binaryPath = resolveOpenClawBinary(env);
  const probeHome = await createOpenClawProbeHome(modelKey, openclawHome, openclawConfig);
  return {
    runOpenClaw: async (args, options) => {
      const result = await spawnAndCollect(binaryPath, args, {
        env: { ...process.env, ...openClawHomeEnv(probeHome.home, env) },
        timeout: options.timeoutMs,
      });
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    },
    cleanup: probeHome.cleanup,
  };
}

function nativeOpenClawProviderConfig(modelKey: string): NonNullable<ReturnType<RouterModule["resolveProviderForModel"]>> {
  const slash = modelKey.indexOf("/");
  return {
    providerId: slash > 0 ? modelKey.slice(0, slash) : "openclaw",
    baseUrl: "openclaw-native",
    authHeader: { name: "openclaw-native", value: "redacted" },
    format: "openai_chat",
  };
}

async function runRouterHealthCommand(input: {
  action: string;
  modelKey?: string;
  openclawHome: string;
  env: Record<string, string | undefined>;
  format: "json" | "text";
  cooldownOnly?: boolean;
}): Promise<string> {
  type RouterHealthCliModel = JsonRecord & { modelKey: string };
  const router = await loadRouter();
  const healthPaths = resolveRouterHealthPaths(input.openclawHome, input.env);
  const sink = router.createHealthEventSink({
    jsonlPath: healthPaths.jsonlPath,
    snapshotPath: healthPaths.snapshotPath,
  });
  const snapshot = await sink.aggregate(Date.now());
  const models: RouterHealthCliModel[] = Object.entries(asRecord(snapshot.models))
    .map(([modelKey, health]): RouterHealthCliModel => ({
      modelKey,
      ...asRecord(health),
    }))
    .filter((model) => input.cooldownOnly !== true || model.cooldown === true)
    .sort(compareRouterHealthCliModels);

  if (input.action === "aggregate") {
    const summary = { ...countHealthModels(snapshot), snapshotPath: healthPaths.snapshotPath };
    return input.format === "json"
      ? JSON.stringify(summary, null, 2)
      : `Health: ${summary.models} models, ${summary.cooldown} in cooldown`;
  }

  if (input.action === "list") {
    return input.format === "json"
      ? JSON.stringify({ models }, null, 2)
      : [
          "Router model health",
          ...models.map((model) => `${model.modelKey} cooldown=${model.cooldown === true ? "yes" : "no"} failureRate=${model.recentFailureRate ?? "unknown"} p95=${model.p95LatencyMs ?? "unknown"}`),
        ].join("\n");
  }

  if (input.action === "show") {
    if (!input.modelKey) throw new Error("router health show expects <model>");
    const model = models.find((entry) => entry.modelKey.toLowerCase() === input.modelKey!.toLowerCase());
    if (!model) throw new Error(`No health data for ${input.modelKey}`);
    return input.format === "json"
      ? JSON.stringify(model, null, 2)
      : `${model.modelKey}: cooldown=${model.cooldown === true ? "yes" : "no"} reason=${model.cooldownReason ?? "none"} failureRate=${model.recentFailureRate ?? "unknown"}`;
  }

  const suggestions = models
    .filter((model) => model.cooldown === true)
    .map((model) => ({
      modelKey: model.modelKey,
      reason: asString(model.cooldownReason) || "cooldown",
      suggestedActions: [
        { binary: "openclaw", args: ["models", "fallbacks", "remove", model.modelKey] },
      ],
    }));
  return input.format === "json"
    ? JSON.stringify({ suggestions }, null, 2)
    : suggestions.length === 0
      ? "No fallback suggestions."
      : ["Fallback suggestions", ...suggestions.map((item) => `${item.modelKey}: ${item.reason}`)].join("\n");
}

function resolveRouterHealthPaths(openclawHome: string, env: Record<string, string | undefined>): { jsonlPath: string; snapshotPath: string } {
  const overridePath = env.OCTOCLAW_ROUTER_HEALTH_PATH;
  if (overridePath && overridePath.trim()) {
    const jsonlPath = resolvePath(overridePath.trim());
    const snapshotPath = jsonlPath.endsWith(".jsonl")
      ? `${jsonlPath.slice(0, -".jsonl".length)}-snapshot.json`
      : path.join(jsonlPath, "model-health-snapshot.json");
    return {
      jsonlPath: jsonlPath.endsWith(".jsonl") ? jsonlPath : path.join(jsonlPath, "model-health.jsonl"),
      snapshotPath,
    };
  }
  return {
    jsonlPath: path.join(openclawHome, "octoclaw", "router-lite", "model-health.jsonl"),
    snapshotPath: path.join(openclawHome, "octoclaw", "router-lite", "model-health-snapshot.json"),
  };
}

function compareRouterHealthCliModels(left: JsonRecord & { modelKey: string }, right: JsonRecord & { modelKey: string }): number {
  const leftCooldown = left.cooldown === true ? 1 : 0;
  const rightCooldown = right.cooldown === true ? 1 : 0;
  if (leftCooldown !== rightCooldown) return rightCooldown - leftCooldown;
  const failureDiff = (asNumber(right.recentFailureRate) ?? 0) - (asNumber(left.recentFailureRate) ?? 0);
  if (failureDiff !== 0) return failureDiff;
  return left.modelKey.localeCompare(right.modelKey);
}

interface RouterDecisionRow {
  ts: string;
  model: string;
  tier: string;
  decision: string;
  reason: string;
  evidence?: unknown;
}

function parseRouterDecisionRows(text: string): RouterDecisionRow[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RouterDecisionRow);
}

function filterRouterDecisionRows(rows: RouterDecisionRow[], since?: string, now = Date.now()): RouterDecisionRow[] {
  if (since === undefined) return rows;
  const cutoff = now - parseCliDurationMs(since);
  return rows.filter((row) => {
    const ts = Date.parse(row.ts);
    return !Number.isNaN(ts) && ts >= cutoff;
  });
}

function renderRouterDecisionRows(rows: RouterDecisionRow[], format: "text" | "json"): string {
  if (format === "json") return JSON.stringify({ decisions: rows }, null, 2);
  if (rows.length === 0) return "No router promotion decisions found.";
  return [
    "Router promotion decisions",
    ...rows.map((row) => `${row.ts}  ${row.model}  ${row.tier}  ${row.decision}  ${row.reason}`),
  ].join("\n");
}

function parseRouterShadowEvents(text: string): RouterShadowEvent[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeRouterShadowEvent(JSON.parse(line) as JsonRecord))
    .filter((event): event is RouterShadowEvent => Boolean(event));
}

function normalizeRouterShadowEvent(raw: JsonRecord): RouterShadowEvent | null {
  const recommendation = asRecord(raw.recommendation);
  const recommendedModel = asString(raw.recommendedModel) || asString(recommendation.recommendedModel);
  if (!recommendedModel) return null;
  const outcome = asRecord(raw.outcome);
  const recommendationOutcome = asRecord(raw.recommendation);
  const estimatedCostDeltaUsd = asNumber(raw.estimatedCostDeltaUsd);
  const actualCost = asNumber(outcome.costUsd);
  return {
    ts: asString(raw.ts) || new Date().toISOString(),
    sessionKey: asString(raw.sessionKey) || undefined,
    turnId: asString(raw.turnId) || undefined,
    actualModel: asString(raw.actualModel) || undefined,
    recommendedModel,
    promotionState: raw.promotionState === "live" ? "live" : "shadow",
    reasonCodes: [
      ...(Array.isArray(raw.reasonCodes) ? raw.reasonCodes : []),
      ...(Array.isArray(recommendation.reasonCodes) ? recommendation.reasonCodes : []),
    ].map((item) => asString(item)).filter(Boolean),
    judge: { complexity: asString(asRecord(raw.judge).complexity) || "unknown" },
    outcome: {
      success: typeof outcome.success === "boolean" ? outcome.success : true,
      ...(actualCost !== undefined ? { costUsd: actualCost } : {}),
      ...(asNumber(outcome.latencyMs) !== undefined ? { latencyMs: asNumber(outcome.latencyMs) } : {}),
    },
    recommendation: {
      expectedSuccess: typeof recommendationOutcome.expectedSuccess === "boolean" ? recommendationOutcome.expectedSuccess : true,
      ...(asNumber(recommendationOutcome.expectedCostUsd) !== undefined
        ? { expectedCostUsd: asNumber(recommendationOutcome.expectedCostUsd) }
        : actualCost !== undefined && estimatedCostDeltaUsd !== undefined
          ? { expectedCostUsd: actualCost + estimatedCostDeltaUsd }
          : {}),
    },
  };
}

async function runRouterPromotionReview(input: {
  openclawHome: string;
  shadowPath: string;
  decisionsPath: string;
  format: "text" | "json";
}): Promise<string> {
  const [shadowText, existingText] = await Promise.all([
    fs.readFile(input.shadowPath, "utf8").catch(() => ""),
    fs.readFile(input.decisionsPath, "utf8").catch(() => ""),
  ]);
  const config = await loadRouterWizardFile(input.openclawHome);
  const router = await loadRouter();
  const configuredModels = Object.entries(config.models)
    .filter(([, value]) => value.source !== "same_provider_discovery")
    .map(([modelName]) => modelName);
  const existing = router.parsePromotionDecisionLog(existingText);
  const today = new Date().toISOString().slice(0, 10);
  let todayPromotionCount = existing.filter((decision) => decision.decision === "promote" && decision.ts.startsWith(today)).length;
  const decisions = router.aggregateShadowEvents(parseRouterShadowEvents(shadowText)).map((metrics) => {
    const decision = router.evaluatePromotionForConfiguredModel({
      model: metrics.model,
      tier: metrics.tier,
      metrics,
      todayPromotionCount,
      configuredModels,
    });
    if (decision.action === "promote") todayPromotionCount += 1;
    return router.createPromotionDecisionEvent({
      ts: new Date().toISOString(),
      model: metrics.model,
      tier: metrics.tier,
      decision,
    });
  });
  if (decisions.length > 0) {
    await ensureDir(path.dirname(input.decisionsPath));
    const existingSuffix = existingText && !existingText.endsWith("\n") ? "\n" : "";
    await fs.writeFile(input.decisionsPath, `${existingText}${existingSuffix}${decisions.map((decision) => JSON.stringify(decision)).join("\n")}\n`, "utf8");
  }
  return router.renderPromotionDecisions(decisions, input.format);
}

async function runRouterPromotionNightlyReview(input: {
  shadowPath: string;
  format: "text" | "json";
}): Promise<string> {
  const shadowText = await fs.readFile(input.shadowPath, "utf8").catch(() => "");
  const router = await loadRouter();
  const review = router.runLightweightPromotionReview(parseRouterShadowEvents(shadowText));
  if (input.format === "json") return JSON.stringify(review, null, 2);
  const lines = [
    "Router lightweight promotion review",
    "Failure rates:",
    ...Object.entries(review.failureRates).map(([model, rate]) => `  ${model}: ${(rate * 100).toFixed(1)}%`),
    "Cost delta by model:",
    ...Object.entries(review.costDeltaByModel).map(([model, delta]) => `  ${model}: ${(delta * 100).toFixed(1)}%`),
    "Ignored reason counts:",
    ...Object.entries(review.ignoredReasonCounts).map(([reason, count]) => `  ${reason}: ${count}`),
    "Alerts:",
    ...(review.alerts.length > 0 ? review.alerts.map((alert) => `  ${alert.model}: ${alert.reason}`) : ["  (none)"]),
  ];
  return lines.join("\n");
}

function parseCliDurationMs(value: string): number {
  const match = /^(\d+)([dhm])$/u.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2];
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 60 * 1000;
}

interface RouterWizardFile {
  schemaVersion: "octoclaw.router_wizard/v1";
  completedAt: string;
  models: Record<string, { planType: string; configuredAt: string; source?: "configured" | "same_provider_discovery" }>;
  budget?: { monthly: number; currency: "USD" };
  privacy: "standard" | "local_only";
  language: "auto" | "zh" | "en";
  restrictedModels: string[];
  openclawConfigHash?: string;
  overrides: {
    scoreOverrides: Record<string, Record<string, number>>;
    userBans: Record<string, string[]>;
    userDispreferred: Record<string, string[]>;
    entries: Array<{ model: string; tier: string; type: string; value?: number; reason?: string; since: string }>;
  };
}

interface RouterWizardAnswerFile {
  budget?: { monthly?: number; currency?: string };
  monthlyBudget?: number;
  privacy?: "standard" | "local_only";
  language?: "auto" | "zh" | "en";
  restrictedModels?: string[];
  modelPlanTypes?: Record<string, string>;
  sameProviderModels?: string[];
}

function defaultRouterWizardFile(models: string[], now = new Date().toISOString()): RouterWizardFile {
  return {
    schemaVersion: "octoclaw.router_wizard/v1",
    completedAt: now,
    models: Object.fromEntries(models.map((model) => [model, { planType: inferRouterPlanType(model), configuredAt: now, source: "configured" }])),
    privacy: "standard",
    language: "auto",
    restrictedModels: [],
    overrides: { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] },
  };
}

function inferRouterPlanType(model: string): string {
  const lower = model.toLowerCase();
  return lower.includes("codex") || lower.includes("chatgpt") || lower.includes("claude") || lower.includes("glm") ? "subscription" : "pay_as_you_go";
}

async function loadRouterWizardFile(openclawHome: string): Promise<RouterWizardFile> {
  const filePath = routerWizardPath(openclawHome);
  try {
    const value = await readJsonFile(filePath);
    if (isRecord(value) && value.schemaVersion === "octoclaw.router_wizard/v1") return value as unknown as RouterWizardFile;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  return defaultRouterWizardFile([]);
}

async function writeRouterWizardFile(openclawHome: string, config: RouterWizardFile): Promise<string> {
  const filePath = routerWizardPath(openclawHome);
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

function routerWizardPath(openclawHome: string): string {
  return path.join(openclawHome, "octoclaw", "router-wizard.json");
}

async function openclawConfigHash(openclawHome: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(openclawHome, "openclaw.json"), "utf8");
    let hash = 0x811c9dc5;
    for (let index = 0; index < raw.length; index += 1) {
      hash ^= raw.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  } catch {
    return undefined;
  }
}

async function loadRouterWizardAnswers(filePath?: string): Promise<RouterWizardAnswerFile> {
  if (!filePath) return {};
  const raw = await readJsonFile(resolvePath(filePath));
  if (!raw) throw new Error(`Invalid router wizard answers file: ${filePath}`);
  const budget = asRecord(raw.budget);
  const answers: RouterWizardAnswerFile = {};
  const monthly = asNumber(raw.monthlyBudget) ?? asNumber(budget.monthly);
  if (monthly !== undefined) answers.budget = { monthly, currency: "USD" };
  if (raw.privacy === "standard" || raw.privacy === "local_only") answers.privacy = raw.privacy;
  if (raw.language === "auto" || raw.language === "zh" || raw.language === "en") answers.language = raw.language;
  if (Array.isArray(raw.restrictedModels)) answers.restrictedModels = raw.restrictedModels.map((item) => asString(item)).filter(Boolean);
  const rawPlanTypes = asRecord(raw.modelPlanTypes);
  answers.modelPlanTypes = Object.fromEntries(Object.entries(rawPlanTypes)
    .filter(([, value]) => value === "subscription" || value === "pay_as_you_go" || value === "unknown")
    .map(([modelName, value]) => [modelName, String(value)]));
  if (Array.isArray(raw.sameProviderModels)) answers.sameProviderModels = raw.sameProviderModels.map((item) => asString(item)).filter(Boolean);
  return answers;
}

function applyRouterWizardAnswers(config: RouterWizardFile, answers: RouterWizardAnswerFile, now: string): void {
  if (answers.budget?.monthly !== undefined) config.budget = { monthly: answers.budget.monthly, currency: "USD" };
  if (answers.privacy) config.privacy = answers.privacy;
  if (answers.language) config.language = answers.language;
  if (answers.restrictedModels) config.restrictedModels = answers.restrictedModels;
  for (const [modelName, planType] of Object.entries(answers.modelPlanTypes ?? {})) {
    const existing = config.models[modelName];
    if (existing) existing.planType = planType;
  }
  for (const modelName of answers.sameProviderModels ?? []) {
    config.models[modelName] = {
      planType: answers.modelPlanTypes?.[modelName] ?? inferRouterPlanType(modelName),
      configuredAt: now,
      source: "same_provider_discovery",
    };
  }
}

async function discoverConfiguredRouterModels(openclawHome: string): Promise<string[]> {
  const config = await readJsonFile(path.join(openclawHome, "openclaw.json"));
  const providers = asRecord(asRecord(asRecord(config).models).providers);
  const models: string[] = [];
  for (const [provider, providerConfig] of Object.entries(providers)) {
    const providerModels = asRecord(providerConfig).models;
    if (!Array.isArray(providerModels)) continue;
    for (const item of providerModels) {
      const id = asString(asRecord(item).id);
      if (id) models.push(`${provider}/${id}`);
    }
  }
  return models;
}

function upsertRouterOverride(config: RouterWizardFile, entry: { model: string; tier: string; type: string; value?: number; reason?: string; since: string }): void {
  config.overrides.entries = config.overrides.entries.filter((candidate) => !(candidate.model === entry.model && candidate.tier === entry.tier && candidate.type === entry.type));
  config.overrides.entries.push(entry);
}

function renderRouterOverrides(config: RouterWizardFile, format: "text" | "json"): string {
  if (format === "json") return JSON.stringify({ overrides: config.overrides.entries }, null, 2);
  if (config.overrides.entries.length === 0) return "No router model overrides.";
  return ["Router model overrides", ...config.overrides.entries.map((entry) => `${entry.model}  ${entry.tier}  ${entry.type}  ${entry.value ?? ""}  ${entry.reason ?? ""}`.trim())].join("\n");
}

interface RouterCostCliEvent {
  ts: string;
  model: string;
  complexity?: string;
  route?: string;
  costUsd?: number;
  cost_usd?: number;
}

interface RouterCostCliReport {
  period: ParsedCliArgs["period"] | "7d";
  totalUsd: number;
  byModel: Record<string, { totalUsd: number; percent: number }>;
  byComplexity: Record<string, { totalUsd: number; percent: number }>;
  byRoute: Record<string, { totalUsd: number; percent: number }>;
  monthEndPredictionUsd: number;
  anomalies: Array<{ day: string; costUsd: number; reason: string }>;
  budget?: {
    monthly: number;
    currency: "USD";
    usedPercent: number;
    action?: "warn" | "plan_only";
    notification?: string;
    reasonCodes: string[];
    ignoredReason?: "budget_exceeded_no_plan";
  };
}

function parseRouterCostEvents(text: string): RouterCostCliEvent[] {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as RouterCostCliEvent);
}

function toRouterCostEvents(events: RouterCostCliEvent[]): CostEvent[] {
  return events.map((event) => ({
    ts: event.ts,
    model: event.model,
    ...(event.complexity === "simple" || event.complexity === "normal" || event.complexity === "complex" || event.complexity === "deep" ? { complexity: event.complexity } : {}),
    ...(event.route === "reply" || event.route === "delegate" ? { route: event.route } : {}),
    costUsd: event.costUsd ?? event.cost_usd ?? 0,
  }));
}

async function renderRouterCostReport(events: RouterCostCliEvent[], period: ParsedCliArgs["period"], format: "text" | "json", config?: RouterWizardFile): Promise<string> {
  const router = await loadRouter();
  const base = router.generateCostReport(toRouterCostEvents(events), { period: period ?? "7d" });
  const report: RouterCostCliReport = { ...base };
  if (config?.budget) {
    const budget = router.evaluateBudget(config.budget.monthly, base.totalUsd);
    report.budget = {
      monthly: config.budget.monthly,
      currency: config.budget.currency,
      usedPercent: budget.usedPercent,
      ...(budget.action ? { action: budget.action } : {}),
      ...(budget.notification ? { notification: budget.notification } : {}),
      reasonCodes: budget.reasonCodes,
      ...(budget.ignoredReason ? { ignoredReason: budget.ignoredReason } : {}),
    };
  }
  if (format === "json") return JSON.stringify(report, null, 2);
  return [
    `OctoClaw Auto Router - Cost Report (${report.period})`,
    `Total spend: $${report.totalUsd.toFixed(2)}`,
    `Predicted month-end: $${report.monthEndPredictionUsd.toFixed(2)}`,
    ...(report.budget ? [`Budget: ${Math.round(report.budget.usedPercent)}% of $${report.budget.monthly} ${report.budget.currency}${report.budget.action ? ` (${report.budget.action})` : ""}`] : []),
    `By model: ${JSON.stringify(report.byModel)}`,
    `By complexity: ${JSON.stringify(report.byComplexity)}`,
    `By route: ${JSON.stringify(report.byRoute)}`,
  ].join("\n");
}

async function runRouterLiteCommand(parsed: ParsedCliArgs, env: Record<string, string | undefined>, openclawHome: string): Promise<string> {
  const [area, action] = parsed.extraArgs;
  const outputDir = resolveRouterLiteOutputDir(parsed, openclawHome);
  const wantsJson = parsed.format === "json";

  if (area === "wizard") {
    if (action === "accept-proposal") {
      const modelKey = parsed.extraArgs[2];
      if (!modelKey) throw new Error("router wizard accept-proposal expects <model>");
      const result = await (await loadRouter()).acceptProposal(modelKey, openclawHome);
      return wantsJson
        ? JSON.stringify(result, null, 2)
        : `Router proposal accepted: ${result.modelKey}\nopenclawConfig=${result.openclawConfigPath}\nbackup=${result.backupPath}`;
    }
    const configured = await discoverConfiguredRouterModels(openclawHome);
    if (parsed.cliMode) {
      const { runRouterWizardCli } = await import("./commands/router-wizard.js");
      return runRouterWizardCli({
        openclawHome,
        models: configured,
        nonInteractive: parsed.nonInteractive,
        resume: parsed.resume,
        format: wantsJson ? "json" : "text",
      });
    }
    const answers = await loadRouterWizardAnswers(parsed.config);
    const existing = parsed.incremental ? await loadRouterWizardFile(openclawHome) : defaultRouterWizardFile([]);
    const now = new Date().toISOString();
    const newModels = configured.filter((modelName) => existing.models[modelName] === undefined);
    const config = parsed.incremental ? existing : defaultRouterWizardFile(configured, now);
    for (const modelName of newModels) {
      config.models[modelName] = { planType: inferRouterPlanType(modelName), configuredAt: now, source: "configured" };
    }
    applyRouterWizardAnswers(config, answers, now);
    const hash = await openclawConfigHash(openclawHome);
    if (hash) config.openclawConfigHash = hash;
    const filePath = await writeRouterWizardFile(openclawHome, config);
    const steps = [
      "model_scan",
      "plan_confirmation",
      "budget",
      "privacy",
      "language",
      "restricted_models",
      "same_provider_discovery",
    ];
    return wantsJson ? JSON.stringify({ path: filePath, models: Object.keys(config.models), newModels, steps }, null, 2) : `Router wizard config written: ${filePath}`;
  }

  if (area === "score" && action === "override") {
    const modelName = parsed.extraArgs[2];
    const assignment = parsed.extraArgs[3];
    if (!modelName || !assignment?.includes("=")) throw new Error("router score override expects: router score override <model> <tier>=<score>");
    const [tier, rawScore] = assignment.split("=", 2) as [string, string];
    const score = Number(rawScore);
    if (!Number.isFinite(score)) throw new Error(`Invalid score: ${rawScore}`);
    const config = await loadRouterWizardFile(openclawHome);
    config.overrides.scoreOverrides[modelName] = { ...(config.overrides.scoreOverrides[modelName] ?? {}), [tier]: score };
    upsertRouterOverride(config, { model: modelName, tier, type: "score", value: score, since: new Date().toISOString() });
    const filePath = await writeRouterWizardFile(openclawHome, config);
    return `Router score override saved: ${modelName} ${tier}=${score} (${filePath})`;
  }

  if (area === "score" && action === "reset") {
    const modelName = parsed.extraArgs[2];
    if (!modelName) throw new Error("router score reset expects: router score reset <model>");
    const config = await loadRouterWizardFile(openclawHome);
    delete config.overrides.scoreOverrides[modelName];
    delete config.overrides.userBans[modelName];
    delete config.overrides.userDispreferred[modelName];
    config.overrides.entries = config.overrides.entries.filter((entry) => entry.model !== modelName);
    const filePath = await writeRouterWizardFile(openclawHome, config);
    return `Router overrides reset: ${modelName} (${filePath})`;
  }

  if (area === "model" && action === "list-overrides") {
    const config = await loadRouterWizardFile(openclawHome);
    return renderRouterOverrides(config, wantsJson ? "json" : "text");
  }

  if (area === "model" && (action === "mark" || action === "ban")) {
    const modelName = parsed.extraArgs[2];
    const tier = action === "mark" ? parsed.dispreferredFor : parsed.forTier;
    if (!modelName || !tier) throw new Error(`router model ${action} expects model and tier`);
    const config = await loadRouterWizardFile(openclawHome);
    if (action === "mark") {
      config.overrides.userDispreferred[modelName] = [...new Set([...(config.overrides.userDispreferred[modelName] ?? []), tier])];
      upsertRouterOverride(config, { model: modelName, tier, type: "dispreferred", reason: parsed.reason, since: new Date().toISOString() });
    } else {
      config.overrides.userBans[modelName] = [...new Set([...(config.overrides.userBans[modelName] ?? []), tier])];
      upsertRouterOverride(config, { model: modelName, tier, type: "ban", reason: parsed.reason, since: new Date().toISOString() });
    }
    const filePath = await writeRouterWizardFile(openclawHome, config);
    return `Router model override saved: ${modelName} ${tier} (${filePath})`;
  }

  if (area === "cost" && action === "budget" && parsed.extraArgs[2] === "set") {
    if (parsed.monthly === undefined || !Number.isFinite(parsed.monthly)) throw new Error("router cost budget set requires --monthly <usd>");
    const config = await loadRouterWizardFile(openclawHome);
    config.budget = { monthly: parsed.monthly, currency: "USD" };
    const filePath = await writeRouterWizardFile(openclawHome, config);
    return `Router monthly budget saved: $${parsed.monthly} (${filePath})`;
  }

  if (area === "cost" && action === "budget" && parsed.extraArgs[2] === "show") {
    const config = await loadRouterWizardFile(openclawHome);
    return wantsJson ? JSON.stringify(config.budget ?? null, null, 2) : `Router monthly budget: ${config.budget ? `$${config.budget.monthly} ${config.budget.currency}` : "(unset)"}`;
  }

  if (area === "cost" && action === "report") {
    const costPath = resolvePath(parsed.input ?? path.join(openclawHome, "octoclaw", "cost-events.jsonl"));
    let events: RouterCostCliEvent[] = [];
    try {
      events = parseRouterCostEvents(await fs.readFile(costPath, "utf8"));
    } catch (error) {
      if (!isNotFoundError(error)) {
        events = [];
      } else {
        const opened = (await loadRouter()).openSqliteCostEventStore({ dbPath: path.join(openclawHome, "octoclaw", "cost.sqlite") });
        if (opened.status === "ok") {
          try {
            events = opened.store?.list() ?? [];
          } finally {
            opened.store?.close();
          }
        }
      }
    }
    return renderRouterCostReport(events, parsed.period, wantsJson ? "json" : "text", await loadRouterWizardFile(openclawHome));
  }

  if (area === "decisions") {
    const decisionsPath = resolvePath(parsed.input ?? path.join(openclawHome, "octoclaw", "router-lite", "decisions.log"));
    let text = "";
    try {
      text = await fs.readFile(decisionsPath, "utf8");
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    const decisions = filterRouterDecisionRows(parseRouterDecisionRows(text), parsed.since);
    return renderRouterDecisionRows(decisions, wantsJson ? "json" : "text");
  }

  if (area === "promotion" && action === "review") {
    const shadowPath = resolvePath(parsed.input ?? path.join(openclawHome, "workspace", "tmp", "octopus", "router-lite", "shadow.jsonl"));
    const decisionsPath = path.join(openclawHome, "octoclaw", "router-lite", "decisions.log");
    return runRouterPromotionReview({
      openclawHome,
      shadowPath,
      decisionsPath,
      format: wantsJson ? "json" : "text",
    });
  }

  if (area === "promotion" && action === "nightly-review") {
    const shadowPath = resolvePath(parsed.input ?? path.join(openclawHome, "workspace", "tmp", "octopus", "router-lite", "shadow.jsonl"));
    return runRouterPromotionNightlyReview({
      shadowPath,
      format: wantsJson ? "json" : "text",
    });
  }

  if (area === "capability" && action === "refresh") {
    const router = await loadRouter();
    const capabilityOutputDir = resolvePath(parsed.outputDir ?? path.join(openclawHome, "octoclaw", "router-lite"));
    const snapshotPath = path.join(capabilityOutputDir, ROUTER_MODEL_INTEL_SNAPSHOT_FILENAME);
    const fullCatalogPath = path.join(capabilityOutputDir, ROUTER_CAPABILITY_FULL_CATALOG_FILENAME);
    const snapshot = await router.refreshCapability({
      sources: [
        router.createPackagedLeaderboardCapabilitySource(),
        router.createOpenRouterCapabilitySource({ fetchJson: injectedCapabilitySourceJson(env, "openrouter") }),
        router.createModelsDevCapabilitySource({ fetchJson: injectedCapabilitySourceJson(env, "modelsDev") }),
        router.createLiteLLMCapabilitySource({ fetchJson: injectedCapabilitySourceJson(env, "litellm") }),
      ],
      writeSnapshot: async (value) => {
        await writeModelIntelSnapshot(fullCatalogPath, value);
        await writeModelIntelSnapshot(snapshotPath, value);
      },
    });
    const counts = countModels(snapshot);
    if (wantsJson) {
      return JSON.stringify({
        snapshotPath,
        fullCatalogPath,
        snapshotId: snapshot.snapshotId,
        generatedAt: snapshot.generatedAt,
        models: snapshot.models.length,
        ...counts,
        sourceStatus: snapshot.sourceStatus,
      }, null, 2);
    }
    return [
      `Capability snapshot written: ${snapshotPath}`,
      `models=${snapshot.models.length} configured=${counts.configured} proposalOnly=${counts.proposalOnly}`,
      `sources=${snapshot.sourceStatus.map((source) => `${source.source}:${source.status}`).join(", ")}`,
    ].join("\n");
  }

  if (area === "capability" && action === "install-schedule") {
    return runRouterCapabilityInstallSchedule({
      openclawHome,
      outputDir,
      env,
      scheduleHour: parsed.scheduleHour,
      format: wantsJson ? "json" : "text",
    });
  }

  if (area === "capability" && action === "snapshot" && parsed.extraArgs[2] === "show") {
    const snapshot = await readModelIntelSnapshot(resolveCapabilitySnapshotPath(parsed, openclawHome));
    return formatCapabilitySnapshotShow(snapshot, wantsJson ? "json" : "text");
  }

  if (area === "capability" && (action === "list" || action === "show" || action === "lookup" || action === "probe")) {
    const snapshot = await readModelIntelSnapshot(resolveCapabilitySnapshotPath(parsed, openclawHome));
    if (action === "list") return formatCapabilityList(snapshot, wantsJson ? "json" : "text");
    const modelKey = parsed.extraArgs[2];
    if (!modelKey) throw new Error(`router capability ${action} expects <model>`);
    if (action === "show") return formatCapabilityShow(snapshot, modelKey, wantsJson ? "json" : "text");
    if (action === "lookup") return formatCapabilityLookup(snapshot, modelKey, wantsJson ? "json" : "text");
    return runCapabilityProbe({ snapshot, modelKey, openclawHome, format: wantsJson ? "json" : "text", env });
  }

  if (area === "health" && (action === "aggregate" || action === "list" || action === "show" || action === "suggest-fallbacks")) {
    return runRouterHealthCommand({
      action,
      modelKey: parsed.extraArgs[2],
      openclawHome,
      env,
      format: wantsJson ? "json" : "text",
      cooldownOnly: parsed.cooldownOnly,
    });
  }

  if (area === "model-intel" && action === "refresh") {
    const commandEnv = openClawHomeEnv(openclawHome, env);
    const snapshotPath = path.join(outputDir, ROUTER_MODEL_INTEL_SNAPSHOT_FILENAME);
    const fullCatalogPath = path.join(outputDir, ROUTER_CAPABILITY_FULL_CATALOG_FILENAME);
    const refreshedCapabilitySnapshot = await readOptionalModelIntelSnapshot(fullCatalogPath)
      ?? await readOptionalModelIntelSnapshot(snapshotPath);
    const openClawModelsList = await runOpenClawJsonCommand(["models", "list", "--json"], commandEnv);
    const nativeFallbackOrder = await runOpenClawJsonCommand(["models", "fallbacks", "list", "--json"], commandEnv);
    const usageStatus = await runOpenClawJsonCommand(["status", "--usage", "--json"], commandEnv);
    const usageCost = await runOpenClawJsonCommand(["gateway", "usage-cost", "--days", "3", "--json"], commandEnv);
    const openClawConfig = await readJsonFile(path.join(openclawHome, "openclaw.json"));
    const legacyCatalog = await readJsonFile(path.join(openclawHome, "workspace", "tmp", "octopus", "model-catalog.json"));
    const routerLite = await loadPolicyRouterLite();
    const router = await loadRouter();
    const packagedSnapshot = router.loadPackagedModelIntelSnapshot();
    const healthSnapshot = await router.createHealthEventSink({
      jsonlPath: path.join(openclawHome, "octoclaw", "router-lite", "model-health.jsonl"),
      snapshotPath: path.join(openclawHome, "octoclaw", "router-lite", "model-health-snapshot.json"),
    }).aggregate(Date.now()).catch(() => undefined);
    const fullSnapshot = routerLite.buildModelIntelSnapshot({
      openClawModelsList,
      openClawConfig,
      legacyCatalog,
      packagedSnapshot: combineModelIntelSnapshots(packagedSnapshot, refreshedCapabilitySnapshot),
      usageStatus,
      usageCost,
      healthSnapshot,
      nativeFallbackOrder,
    });
    const snapshot = slimModelIntelSnapshot(fullSnapshot);
    await ensureDir(outputDir);
    await writeModelIntelSnapshot(fullCatalogPath, fullSnapshot);
    await writeModelIntelSnapshot(snapshotPath, snapshot);
    const counts = countModels(snapshot);
    const healthCounts = countHealthModels(healthSnapshot);
    if (wantsJson) {
      return JSON.stringify({
        snapshotPath,
        fullCatalogPath,
        snapshotId: snapshot.snapshotId,
        generatedAt: snapshot.generatedAt,
        models: snapshot.models.length,
        fullCatalogModels: fullSnapshot.models.length,
        ...counts,
        health: healthCounts,
        sourceStatus: snapshot.sourceStatus,
      }, null, 2);
    }
    return [
      `Model intel snapshot written: ${snapshotPath}`,
      `Full capability catalog written: ${fullCatalogPath}`,
      `snapshotId=${snapshot.snapshotId}`,
      `models=${snapshot.models.length} fullCatalogModels=${fullSnapshot.models.length} configured=${counts.configured} proposalOnly=${counts.proposalOnly}`,
      `Health: ${healthCounts.models} models, ${healthCounts.cooldown} in cooldown`,
      `sources=${snapshot.sourceStatus.map((source) => `${source.source}:${source.status}`).join(", ")}`,
    ].join("\n");
  }

  if (area === "model-config" && action === "analyze") {
    const inputPath = resolvePath(parsed.input ?? path.join(outputDir, "model-intel-snapshot.json"));
    const rawSnapshot = await readJsonFile(inputPath);
    const snapshot = assertModelIntelSnapshot(rawSnapshot, inputPath);
    const proposal = (await loadPolicyRouterLite()).analyzeModelConfig(snapshot);
    const proposalPath = path.join(outputDir, "model-config-proposal.json");
    await ensureDir(outputDir);
    await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    const actions = proposal.proposals.reduce<Record<string, number>>((acc, item) => {
      acc[item.action] = (acc[item.action] ?? 0) + 1;
      return acc;
    }, {});
    if (wantsJson) {
      return JSON.stringify({
        proposalPath,
        snapshotId: proposal.snapshotId,
        generatedAt: proposal.generatedAt,
        proposals: proposal.proposals.length,
        actions,
        summary: proposal.summary,
      }, null, 2);
    }
    return [
      `Model config proposal written: ${proposalPath}`,
      `snapshotId=${proposal.snapshotId}`,
      `proposals=${proposal.proposals.length}`,
      `actions=${Object.entries(actions).map(([name, count]) => `${name}:${count}`).join(", ") || "none"}`,
    ].join("\n");
  }

  if (area === "shadow-report" || (area === "shadow" && action === "report")) {
    const shadowPath = resolvePath(parsed.input ?? path.join(outputDir, "shadow.jsonl"));
    const { generateShadowReport } = await loadPolicyRouterLite();
    const summary = generateShadowReport(shadowPath);
    if (wantsJson) {
      return JSON.stringify(summary, null, 2);
    }
    const lines = [
      "OctoClaw router-lite shadow report",
      "==================================",
      `total events            : ${summary.totalEvents}`,
      `unique models actual    : ${summary.uniqueModelsActual.join(", ") || "(none)"}`,
      `unique models recommended: ${summary.uniqueModelsRecommended.join(", ") || "(none)"}`,
      "ignoredReason counts:",
    ];
    for (const [reason, count] of Object.entries(summary.ignoredReasonCounts)) {
      lines.push(`  ${reason.padEnd(22)}: ${count}`);
    }
    if (Object.keys(summary.ignoredReasonCounts).length === 0) {
      lines.push("  (none)");
    }
    lines.push(`estimated cost delta   : $${summary.estimatedCostDeltaTotalUsd.toFixed(4)} USD (negative = recommendation would save)`);
    lines.push(`quality gate           : ${summary.qualityGatePass} pass / ${summary.qualityGateFail} fail / ${summary.qualityGateUnknown} unknown`);
    if (summary.timeRange) {
      lines.push(`time range             : ${summary.timeRange.first} → ${summary.timeRange.last}`);
    }
    return lines.join("\n");
  }

  throw new Error("router command expects: router wizard | router capability refresh/list/show/snapshot show/lookup/probe/install-schedule | router model-intel refresh | router model-config analyze | router shadow-report | router decisions | router promotion review/nightly-review | router cost report | router score override/reset | router model mark/ban/list-overrides");
}

async function runCommandFromSnapshot(parsed: ParsedCliArgs, env: Record<string, string | undefined>): Promise<string> {
  const snapshot = await loadStatusSnapshot(env);
  switch (parsed.command) {
    case "status": {
      const format = parsed.format ?? "compact";
      if (format === "json") {
        return JSON.stringify({
          tasks: snapshot.tasks.map((task) => ({
            id: task.id,
            state: task.state,
            route: task.route,
            model: task.model,
            workerPool: task.workerPool,
            phase: task.phase,
            anchor: task.anchor,
          })),
          runner: snapshot.runner,
          replay: {
            phase: snapshot.replay.phase,
            totalEvents: snapshot.replay.totalEvents,
            delegatedEvents: snapshot.replay.delegatedEvents,
            runnerEvents: snapshot.replay.runnerEvents,
            routeHintEvents: snapshot.replay.routeHintEvents,
            blockedEvents: snapshot.replay.blockedEvents,
            routes: Object.fromEntries(snapshot.replay.routeCounts),
          },
        }, null, 2);
      }
      if (format === "table") return formatTable(snapshot);
      if (format === "lanes") return formatLanes(snapshot);
      if (format === "anchors") return formatAnchors(snapshot);
      return formatCompact(snapshot);
    }
    case "details": {
      const task = resolveTaskById(snapshot.tasks, parsed.taskId);
      if (!task) {
        throw new Error(`Unknown task id: ${parsed.taskId ?? "(missing)"}`);
      }
      return await renderDetails(task, parsed.format === "json");
    }
    case "queue":
      return await renderQueue(snapshot.tasks, parsed.format === "json");
    case "timeline": {
      const events = await buildTimeline(env, parsed.taskId, parsed.limit ?? 20);
      return renderTimeline(events, parsed.format === "json");
    }
    case "health": {
      const wantsJson = parsed.format === "json";
      if (wantsJson) {
        return JSON.stringify({
          model: modelHealthToJson(snapshot.replay),
          drift: snapshot.replay.drift,
        }, null, 2);
      }
      if (parsed.model) {
        return formatModelHealth(snapshot.replay);
      }
      if (parsed.drift) {
        return formatDrift(snapshot.replay);
      }
      return [formatModelHealth(snapshot.replay), "", formatDrift(snapshot.replay)].join("\n");
    }
    case "up":
    case "down":
    case "restart": {
      const service = parsed.service ?? "openclaw";
      const mode = parsed.mode ?? (service === "runner" ? "ondemand" : "daemon");
      const result = await manageService(parsed.command, service, mode, env);
      return renderServiceState(result);
    }
    case "patrol":
      return runOperationalCommand("patrol", env, parsed.once || true);
    case "reconcile":
      return runOperationalCommand("reconcile", env, true);
    case "repair":
      return runOperationalCommand("repair", env, true);
    case "nightly":
      return runNightlyCommand(parsed, env);
    case "nightly-eval":
      if (parsed.nightlyEvalSubcommand === "run") {
        return runNightlyEvalCommand(parsed, env);
      }
      if (parsed.nightlyEvalSubcommand === "deliver-slack") {
        return runNightlyEvalSlackDeliveryCommand(parsed, env);
      }
      if (parsed.nightlyEvalSubcommand === "promote") {
        return runNightlyEvalPromoteCommand(parsed, env);
      }
      if (parsed.nightlyEvalSubcommand === "clear-baseline") {
        return runNightlyEvalClearBaselineCommand(parsed, env);
      }
      if (parsed.nightlyEvalSubcommand === "show-baseline") {
        return runNightlyEvalShowBaselineCommand(parsed, env);
      }
      return runNightlyEvalLaunchAgentCommand(parsed, env);
    case "review":
      return runReviewCommand(parsed, env);
    case "curate":
      return runCurateCommand(parsed, env);
    case "slack-acceptance":
      return runSlackAcceptanceCliCommand(parsed, env);
    case "calibration-gate":
      return runCalibrationGateCliCommand(parsed, env);
    case "stability":
      return runStabilityCliCommand(parsed, env);
    default:
      throw new Error(`Unknown action: ${parsed.command ?? "(missing)"}`);
  }
}

async function runInstallCommand(parsed: ParsedCliArgs, env: Record<string, string | undefined>, openclawHome: string): Promise<string> {
  const restoreEnv = applyProcessEnv(env);
  try {
    const octoclawRoot = resolveOctoclawRoot(parsed, env);
    const repoUrl = parsed.repoUrl ?? DEFAULT_REPO_URL;
    const branch = parsed.branch ?? DEFAULT_REF;
    if (parsed.command === "install" || parsed.command === "update") {
      await cloneOrUpdate(octoclawRoot, repoUrl, branch);
    }
    if (!parsed.skipBuild) {
      await buildWorkspace(octoclawRoot);
    }
    await deployPackages(octoclawRoot, openclawHome);
    await deployExtension(octoclawRoot, openclawHome);
    await syncOctoClawCoreRules(openclawHome);
    await setupSymlinks(openclawHome);
    const config = await readConfig(openclawHome);
    await syncToOpenClawPluginConfig(openclawHome, config);
    await writeConfig(openclawHome, config);
    await syncOpenClawPluginEntry(openclawHome, octoclawRoot, config.pluginConfig);
    await syncSlackDeliveryHookCompatibility(openclawHome);
    await writeSourceManifest(openclawHome, octoclawRoot);
    await validateLoad(openclawHome);
    if (parsed.restartServices) {
      await restartAll(openclawHome);
    }

    let readinessLines = "";
    try {
      const report = redactReadinessReport(await generateReadinessReport(openclawHome));
      readinessLines = `\n\n${formatReadinessSummary(report, parsed.lang ?? "en")}`;
    } catch {
      // Readiness is observational
    }

    let postDeployStabilityLines = "";
    if (parsed.command === "deploy" && parsed.restartServices) {
      const stabilityOutputDir = env.OCTOCLAW_STABILITY_OUTPUT_DIR?.trim() || path.join(openclawHome, "reports");
      const stabilityConfig = await resolvePostDeployStabilityConfig(parsed, openclawHome);
      const liveSlackReport = stabilityConfig
        && env.OCTOCLAW_POST_DEPLOY_LIVE_SMOKE === "1"
        && await hasStabilitySlackEnv(env, stabilityConfig)
        ? await runStabilityLiveSlackPack(stabilityConfig, env)
        : undefined;
      const stability = await runStabilityOrchestration({
        subcommand: "post-deploy",
        outputDir: stabilityOutputDir,
        config: stabilityConfig,
        liveSlackReport,
        env,
        openclawHome,
      });
      postDeployStabilityLines = [
        "",
        "",
        `Post-deploy stability: gate=${stability.overallGate}`,
        `Report: ${stability.reportPath ?? "(missing)"}`,
        ...(stability.skippedLiveReason ? [`Skipped live: ${stability.skippedLiveReason}`] : []),
      ].join("\n");
      if (stability.overallGate === "fail") {
        throw new Error(`Post-deploy stability failed: ${stability.failures.map((failure) => `${failure.caseId}:${failure.code}`).join(", ")}`);
      }
    }

    return `OctoClaw ${parsed.command} completed at ${octoclawRoot}${readinessLines}${postDeployStabilityLines}`;
  } finally {
    restoreEnv();
  }
}

async function resolvePostDeployStabilityConfig(parsed: ParsedCliArgs, openclawHome: string): Promise<string | undefined> {
  const candidates = [
    parsed.config,
    path.join(openclawHome, "octoclaw-slack-acceptance-config.json"),
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  // Missing acceptance config just means post-deploy runs non-live lanes.
  return undefined;
}

function applyProcessEnv(env: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  io: CliIo = {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
  },
): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.version) {
      try {
        const pkgPath = new URL("../package.json", import.meta.url).pathname;
        const raw = await fs.readFile(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { version?: string };
        io.stdout(pkg.version ?? "unknown");
      } catch {
        io.stdout("0.6.0");
      }
      return 0;
    }
    if (parsed.help) {
      io.stdout(printUsage());
      return 0;
    }
    if (!parsed.command) {
      io.stderr("Unknown action: (missing). Expected one of: doctor, install, update, deploy, enable, disable, config, uninstall, calibration-gate, status, details, queue, timeline, health, up, down, restart, patrol, reconcile, repair, init, nightly, nightly-eval, router, slack-acceptance, stability");
      return 1;
    }

    const openclawHome = resolveOctoClawHome(env, parsed.openclawHome);
    if (parsed.command === "doctor") {
      const { runDoctor } = await import("./commands/doctor.js");
      const { output, exitCode } = await runDoctor({
        json: parsed.format === "json",
        lang: parsed.lang ?? "zh",
        openclawHome,
      });
      io.stdout(output);
      return exitCode;
    }
    if (parsed.command === "enable") {
      const restoreEnv = applyProcessEnv(env);
      try {
        io.stdout(await enablePlugin(openclawHome));
      } finally {
        restoreEnv();
      }
      return 0;
    }
    if (parsed.command === "disable") {
      const restoreEnv = applyProcessEnv(env);
      try {
        io.stdout(await disablePlugin(openclawHome));
      } finally {
        restoreEnv();
      }
      return 0;
    }
    if (parsed.command === "config") {
      const [action, key, value] = parsed.extraArgs;
      if (action === "set" && key && value !== undefined) {
        io.stdout(await setConfigValue(openclawHome, key, value));
        return 0;
      }
      if (!action || action === "get") {
        io.stdout(await getConfigValue(openclawHome, key));
        return 0;
      }
      throw new Error("config command expects: config get [key] or config set <key> <value>");
    }
    if (parsed.command === "install" || parsed.command === "update" || parsed.command === "deploy") {
      io.stdout(await runInstallCommand(parsed, env, openclawHome));
      return 0;
    }
    if (parsed.command === "init") {
      const { runInitWizard } = await import("./commands/init.js");
      io.stdout(await runInitWizard({
        nonInteractive: parsed.nonInteractive,
        autoRemoteJudge: parsed.autoRemoteJudge,
        lang: parsed.lang ?? "zh",
        openclawHome,
      }));
      return 0;
    }
    if (parsed.command === "uninstall") {
      await uninstallDeployment(openclawHome);
      io.stdout("OctoClaw deployment removed from OpenClaw extensions/packages");
      return 0;
    }
    if (parsed.command === "router") {
      io.stdout(await runRouterLiteCommand(parsed, env, openclawHome));
      return 0;
    }

    const runtimeRecord = resolveRuntimeStateSurfaceRecord(env);
    if (runtimeRecord && LEGACY_ACTIONS.includes(parsed.command as StatusSurfaceAction) && !parsed.taskId && !parsed.service && !parsed.model && !parsed.drift) {
      io.stdout(await runOctoClawCtl(parsed.command as StatusSurfaceAction, runtimeRecord, parsed.legacyFormat));
      return 0;
    }

    if (parsed.command === "status") {
      io.stdout(await showStatus(openclawHome));
      return 0;
    }

    const output = await runCommandFromSnapshot(parsed, env);
    io.stdout(output || FALLBACK_MESSAGE);
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.on("uncaughtException", (err: unknown) => {
  if (err && typeof err === "object" && "toUserString" in err && typeof err.toUserString === "function") {
    console.error(err.toUserString(detectLang()));
  } else {
    console.error("[UNEXPECTED]", err instanceof Error ? err.message : String(err));
    console.error("请提交 issue：https://github.com/guanbear/OctoClaw/issues");
  }
  process.exit(1);
});

export function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    const realpathSync = (fsSync as unknown as { realpathSync(target: string): string }).realpathSync;
    return realpathSync(filePathFromUrl(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return moduleUrl === new URL(argvPath, "file:").href;
  }
}

function filePathFromUrl(moduleUrl: string): string {
  return decodeURIComponent(new URL(moduleUrl).pathname);
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  void main().then((exitCode) => {
    process.exit(exitCode);
  });
}

// ── Phase 2 pipeline commands ─────────────────────────────────────────────────

/** nightly-eval promote: save the latest eval report as the new baseline. */
async function runNightlyEvalPromoteCommand(parsed: ParsedCliArgs, _env: Record<string, string | undefined>): Promise<string> {
  const openclawHome = parsed.openclawHome ?? path.join(os.homedir(), ".openclaw");
  // If --input is provided, use it; otherwise find latest report in --output-dir
  let reportPath: string;
  if (parsed.input) {
    reportPath = parsed.input;
  } else if (parsed.outputDir) {
    reportPath = await findLatestNightlyEvalReport(parsed.outputDir);
  } else {
    throw new Error("nightly-eval promote requires --input <report.json> or --output-dir <dir>");
  }
  const raw = await fs.readFile(reportPath, "utf8");
  const report = JSON.parse(raw) as { overallGate?: string };
  const gate = report.overallGate ?? "unknown";
  if (gate !== "pass") {
    throw new Error(`Cannot promote eval report unless gate=pass (gate=${gate}). Fix regressions first.`);
  }
  await writeStoredBaseline(reportPath, gate, openclawHome);
  return `Baseline promoted: ${reportPath} (gate=${gate})`;
}

/** nightly-eval clear-baseline: remove the stored baseline. */
async function runNightlyEvalClearBaselineCommand(parsed: ParsedCliArgs, _env: Record<string, string | undefined>): Promise<string> {
  const openclawHome = parsed.openclawHome ?? path.join(os.homedir(), ".openclaw");
  await clearStoredBaseline(openclawHome);
  return "Stored baseline cleared.";
}

/** nightly-eval show-baseline: print the current stored baseline. */
async function runNightlyEvalShowBaselineCommand(parsed: ParsedCliArgs, _env: Record<string, string | undefined>): Promise<string> {
  const openclawHome = parsed.openclawHome ?? path.join(os.homedir(), ".openclaw");
  const baseline = await readStoredBaseline(openclawHome);
  if (!baseline) return "No stored baseline found.";
  return JSON.stringify(baseline, null, 2);
}

interface ReviewFailureSample {
  lane: string;
  eventId?: string;
  at?: string;
  turnId?: string;
  taskId?: string;
  event?: string;
  verdict: string;
  reason: string;
}

function isReviewableVerdict(verdict: string): boolean {
  const lower = verdict.toLowerCase();
  return lower === "fail"
    || lower === "failed"
    || lower === "unknown"
    || lower === "unclear"
    || lower.includes("fail")
    || lower.includes("unknown")
    || lower.includes("false_")
    || lower.includes("missing")
    || lower.includes("timeout")
    || lower.includes("stale")
    || lower.includes("orphan")
    || lower.includes("compensated")
    || lower.includes("no_spawn");
}

function sampleToReviewFailure(sample: unknown, lane: string): ReviewFailureSample | null {
  const rec = asRecord(sample);
  const verdict = asString(rec.verdict);
  if (!verdict || !isReviewableVerdict(verdict)) return null;
  return {
    lane,
    eventId: asString(rec.eventId) || undefined,
    at: asString(rec.at) || undefined,
    turnId: asString(rec.turnId) || undefined,
    taskId: asString(rec.taskId) || undefined,
    event: asString(rec.event) || undefined,
    verdict,
    reason: asString(rec.reason),
  };
}

function collectNightlyReviewFailures(report: JsonRecord): ReviewFailureSample[] {
  const nightlyReport = asRecord(asRecord(asRecord(report.steps).nightly).report);
  const failures: ReviewFailureSample[] = [];
  const lanes = Array.isArray(nightlyReport.lanes) ? nightlyReport.lanes : [];
  for (const laneValue of lanes) {
    const lane = asRecord(laneValue);
    const laneName = asString(lane.lane, "unknown_lane");
    const samples = Array.isArray(lane.samples) ? lane.samples : [];
    for (const sample of samples) {
      const failure = sampleToReviewFailure(sample, laneName);
      if (failure) failures.push(failure);
    }
  }
  const legacySamples = Array.isArray(nightlyReport.samples) ? nightlyReport.samples : [];
  for (const sample of legacySamples) {
    const failure = sampleToReviewFailure(sample, "legacy");
    if (failure) failures.push(failure);
  }
  return failures;
}

/** review: show failure/unknown samples from the latest nightly report. */
async function runReviewCommand(parsed: ParsedCliArgs, _env: Record<string, string | undefined>): Promise<string> {
  const openclawHome = parsed.openclawHome ?? path.join(os.homedir(), ".openclaw");
  const defaultOutputDir = path.join(openclawHome, "workspace", "tmp", "octopus", "nightly-eval");
  const outputDirPath = parsed.outputDir ?? defaultOutputDir;
  let reportPath: string;
  if (parsed.input) {
    reportPath = parsed.input;
  } else {
    try {
      reportPath = await findLatestNightlyEvalReport(outputDirPath);
    } catch {
      return "No nightly-eval report found. Run: octoclawctl nightly-eval run --config <eval-config.json> --output-dir <dir>";
    }
  }
  const raw = await fs.readFile(reportPath, "utf8");
  const report = JSON.parse(raw) as JsonRecord;
  const lines: string[] = [
    `=== Review: ${path.basename(reportPath)} ===`,
    `Generated: ${report.generatedAt ?? "unknown"}  Gate: ${report.overallGate ?? "unknown"}`,
    `Nightly: ${asString(asRecord(asRecord(report.steps).nightly).status, "unknown")}`,
    "",
  ];
  const failures = collectNightlyReviewFailures(report);
  if (failures.length === 0) {
    lines.push("No failures or unknowns found. Pipeline looks clean.");
  } else {
    lines.push(`${failures.length} sample(s) need review:`);
    for (const s of failures.slice(0, 20)) {
      lines.push(`  [${s.lane}/${s.verdict}] ${s.eventId || s.event || s.turnId || s.taskId || "sample"}  — ${s.reason || "needs review"}`);
    }
    if (failures.length > 20) {
      lines.push(`  ... and ${failures.length - 20} more. Use --format json for full list.`);
    }
  }
  if (parsed.format === "json") {
    return JSON.stringify({ reportPath, overallGate: report.overallGate, failures }, null, 2);
  }
  return lines.join("\n");
}

/** curate: export a specific replay event/turn as a fixture. */
async function runCurateCommand(parsed: ParsedCliArgs, _env: Record<string, string | undefined>): Promise<string> {
  const openclawHome = parsed.openclawHome ?? path.join(os.homedir(), ".openclaw");
  const replayPath = parsed.input
    ?? path.join(openclawHome, "workspace", "tmp", "octopus", "runtime-policy-replay.jsonl");
  const turnId = parsed.taskId; // reuse --task-id as --turn-id for now
  if (!turnId) {
    throw new Error("curate requires --task-id <turn-id>  (the turnId from replay events)");
  }
  const content = await fs.readFile(replayPath, "utf8");
  const events = content.split(/\r?\n/u)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
    .filter((e) => String(e.turnId ?? "").includes(turnId) || String(e.taskId ?? "").includes(turnId));
  if (events.length === 0) {
    throw new Error(`No events found for turnId=${turnId} in ${replayPath}`);
  }
  const fixturesDir = path.join(openclawHome, "workspace", "tmp", "octopus", "fixtures");
  await ensureDir(fixturesDir);
  const fixturePath = path.join(fixturesDir, `fixture-${turnId.slice(0, 16)}-${Date.now()}.jsonl`);
  await fs.writeFile(fixturePath, events.map((e) => JSON.stringify({ ...e, fixture: true })).join("\n") + "\n", "utf8");
  return `Fixture saved: ${fixturePath}  (${events.length} events for turn ${turnId})`;
}

async function runStabilityCliCommand(parsed: ParsedCliArgs, env: Record<string, string | undefined>): Promise<string> {
  const sub = parsed.stabilitySubcommand;
  if (!sub) throw new Error("stability requires a subcommand: post-deploy, nightly, full, review-latest, fix-draft");
  const outputDir = parsed.outputDir ?? path.join(resolveOctoClawHome(env, parsed.openclawHome), "reports");
  const wantsJson = parsed.format === "json";

  if (sub === "review-latest") {
    const result = await runStabilityReviewLatest(outputDir);
    if (wantsJson) {
      return JSON.stringify({ reportPath: result.reportPath, overallGate: result.overallGate, lanes: result.lanes, failureCount: result.failures.length }, null, 2);
    }
    return `Review: ${result.reportPath}\nGate: ${result.overallGate}\nLanes: ${result.lanes.map((l) => `${l.name}=${l.gate}`).join(" ")}\nFailures (${result.failures.length}): ${result.failures.map((f) => `${f.caseId}:${f.code}`).join(", ")}`;
  }

  if (sub === "fix-draft") {
    const result = await runStabilityFixDraft(outputDir);
    if (wantsJson) {
      return JSON.stringify({ reportPath: result.reportPath, overallGate: result.overallGate, fixDraftSummary: result.fixDraftSummary }, null, 2);
    }
    return `Fix-draft: ${result.reportPath}\n${result.fixDraftSummary ?? "No action needed."}`;
  }

  const cadence = parseCadence(parsed.cadence);
  const replaySince = new Date().toISOString();
  const liveSlackReport = parsed.config
    ? await runStabilityLiveSlackPack(parsed.config, env, sub === "full" ? "full_3d" : sub === "nightly" ? "nightly" : "post_deploy")
    : undefined;
  const result = await runStabilityOrchestration({
    subcommand: sub,
    outputDir,
    cadence,
    config: parsed.config,
    env,
    openclawHome: parsed.openclawHome,
    liveSlackReport,
    replaySince,
  });

  if (wantsJson) {
    return JSON.stringify({
      reportPath: result.reportPath,
      markdownPath: result.markdownPath,
      summaryPath: result.summaryPath,
      overallGate: result.overallGate,
      lanes: result.lanes,
      failureCount: result.failures.length,
      skippedLiveReason: result.skippedLiveReason,
    }, null, 2);
  }

  const lines = [
    `Stability ${sub}: gate=${result.overallGate}`,
    `Report: ${result.reportPath}`,
    `Markdown: ${result.markdownPath}`,
    `Summary: ${result.summaryPath}`,
    `Lanes: ${result.lanes.map((l) => `${l.name}=${l.gate}`).join(" ")}`,
  ];
  if (result.skippedLiveReason) {
    lines.push(`Skipped live: ${result.skippedLiveReason}`);
  }
  if (result.failures.length > 0) {
    lines.push(`Failures (${result.failures.length}): ${result.failures.slice(0, 5).map((f) => `${f.caseId}:${f.code}`).join(", ")}${result.failures.length > 5 ? " ..." : ""}`);
  }
  return lines.join("\n");
}

async function runStabilityLiveSlackPack(
  configPath: string,
  env: Record<string, string | undefined>,
  runKind: BuildStabilitySlackAcceptanceCasesOptions["runKind"] = "post_deploy",
) {
  const resolvedConfig = await loadSlackAcceptanceConfig(configPath, env);
  const stabilityCases = buildStabilitySlackAcceptanceCases(resolvedConfig.cases, { hasReplayPath: Boolean(resolvedConfig.replayPath), runKind });
  const scopedConfig = {
    ...resolvedConfig,
    cases: stabilityCases,
  };
  const client = new SlackWebApiAcceptanceClient(resolvedConfig.botToken, { postToken: resolvedConfig.userToken, requestTimeoutMs: resolvedConfig.requestTimeoutMs });
  const report = await runSlackAcceptanceHarness(client, scopedConfig);
  return {
    overallGate: report.overallGate,
    cases: report.cases.map((item) => ({
      id: item.id,
      status: item.status,
      threadTs: item.threadTs,
      errors: item.errors,
      progress: item.progress,
      replayEvidence: item.replayEvidence,
    })),
  };
}

function inferSlackMentionTrigger(configuredCases: SlackAcceptanceCaseConfig[]): string {
  for (const item of configuredCases) {
    const match = /^(\s*<@[A-Z0-9]+>\s*)/u.exec(item.prompt ?? "");
    if (match) return match[1];
  }
  return "";
}

function withSlackTrigger(trigger: string, prompt: string): string {
  return trigger && !prompt.startsWith(trigger) ? `${trigger}${prompt}` : prompt;
}

export interface BuildStabilitySlackAcceptanceCasesOptions {
  hasReplayPath?: boolean;
  runKind?: "post_deploy" | "nightly" | "full_3d";
}

export function buildStabilitySlackAcceptanceCases(
  configuredCases: SlackAcceptanceCaseConfig[] = [],
  options: BuildStabilitySlackAcceptanceCasesOptions = {},
): SlackAcceptanceCaseConfig[] {
  const trigger = inferSlackMentionTrigger(configuredCases);
  const hasReplayPath = options.hasReplayPath !== false;
  const rejectInfrastructureErrors = [
    "402 status code \\(no body\\)",
    "429 status code \\(no body\\)",
    "Previous run is still shutting down",
  ];
  const cases: SlackAcceptanceCaseConfig[] = [
    {
      id: "reply_core.simple_chat",
      kind: "plain_chat",
      prompt: withSlackTrigger(trigger, "请用一句话回复：当前 Slack smoke 正常。"),
      finalRequired: true,
      noSpawnExpected: true,
      expectFooter: { route: "reply" },
      rejectFinal: rejectInfrastructureErrors,
    },
    {
      id: "streaming_core.long_reply",
      kind: "plain_chat",
      prompt: withSlackTrigger(trigger, "写一段 300 字左右的中文说明，用来验证 Slack 流式回复不会出现误导 ACK。"),
      finalRequired: true,
      ackRequired: false,
      rejectAck: ["任务已启动。", "还没好，再等等"],
      rejectFinal: rejectInfrastructureErrors,
    },
    {
      id: "delegate_core.native_final",
      kind: "delegated_work",
      prompt: withSlackTrigger(trigger, "请委派一个子 agent 独立做只读检查：确认 OpenClaw Gateway 和 OctoClaw readiness 的当前状态，然后等子任务完成后给 3 条中文摘要。不要由主会话直接回答。"),
      ackRequired: true,
      allowFastFinalAck: true,
      ackTimeoutMs: 180_000,
      finalRequired: true,
      expectFinalAll: ["Gateway|OpenClaw|OctoClaw|readiness", "状态|摘要|结论"],
      expectFooter: { route: "delegate", via: "native_announce", difficultyRequired: true },
      expectReplay: hasReplayPath ? {
        footerVia: "native_announce",
        deliveryTransport: "slack_api",
        targetSource: "inbound_anchor",
        requireWorkContract: true,
        requireSpawnIntent: true,
        requireRunId: true,
        requireChildSession: true,
      } : undefined,
      rejectFinal: rejectInfrastructureErrors,
    },
    {
      id: "footer_truth.current_model",
      kind: "plain_chat",
      prompt: withSlackTrigger(trigger, "你现在用的是什么模型？"),
      finalRequired: true,
      rejectFinal: rejectInfrastructureErrors,
    },
    {
      id: "status_core.read_only",
      kind: "plain_chat",
      prompt: withSlackTrigger(trigger, "请只读检查当前 Gateway 是否运行正常，用一句话回答状态，不要委派子任务。"),
      finalRequired: true,
      noSpawnExpected: true,
      expectFooter: { route: "reply" },
      expectFinal: ["octoclaw: route=reply"],
      rejectAck: ["任务已启动。", "还没好，再等等"],
      rejectFinal: rejectInfrastructureErrors,
    },
  ];
  if (options.runKind === "full_3d") {
    cases.push({
      id: "delegate.parallel_two_children_status",
      kind: "delegated_work",
      prompt: withSlackTrigger(trigger, "请同时启动两个子 agent：A 只读总结当前 OctoClaw readiness，B 只读总结当前 Gateway 状态。它们运行时主会话要回复一句“主会话仍可响应”，并确认状态面板里能看到两个正在运行的子任务；两个子任务完成后再给最终摘要。"),
      ackRequired: true,
      allowFastFinalAck: true,
      ackTimeoutMs: 180_000,
      finalRequired: true,
      finalTimeoutMs: 420_000,
      expectFinalAll: ["主会话仍可响应|两个子|A|B", "状态|摘要|结论"],
      expectFooter: { route: "delegate", difficultyRequired: true },
      expectReplay: hasReplayPath ? {
        requireWorkContract: true,
        requireSpawnIntent: true,
        requireRunId: true,
        requireChildSession: true,
        minSpawnIntentCount: 2,
        minChildSessionCount: 2,
      } : undefined,
      rejectFinal: rejectInfrastructureErrors,
    });
  }
  return cases;
}
