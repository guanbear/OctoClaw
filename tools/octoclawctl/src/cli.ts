#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import {
  buildDetailsProjection,
  buildQueueProjection,
  runStatusSurfaceOperator,
  type StatusSurfaceAction,
} from "@octoclaw/status-surface";
import { generateNightlyReport, renderMarkdownReport, validateReplayEvents } from "./nightly/index.js";
import { loadSlackAcceptanceConfig, runSlackAcceptanceHarness, renderSlackAcceptanceMarkdown } from "./slack-acceptance/index.js";
import { SlackWebApiAcceptanceClient } from "./slack-acceptance/index.js";
import type { SlackAcceptanceFormat } from "./slack-acceptance/types.js";

type LegacyCliFormat = "text" | "json";
type StatusFormat = "compact" | "table" | "lanes" | "anchors" | "json";
type ServiceName = "openclaw" | "runner";
type RunnerMode = "ondemand" | "daemon";
type NightlyFormat = "markdown" | "json";
type CliCommand =
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
  | "nightly"
  | "slack-acceptance";
type JsonRecord = Record<string, unknown>;

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  cwd(): string;
  exit(code?: number): never;
  kill(pid: number, signal?: string | number): boolean;
};

const LEGACY_ACTIONS: StatusSurfaceAction[] = ["status", "details", "queue", "timeline"];
const STATUS_FORMATS: StatusFormat[] = ["compact", "table", "lanes", "anchors", "json"];
const SERVICE_NAMES: ServiceName[] = ["openclaw", "runner"];
const RUNNER_MODES: RunnerMode[] = ["ondemand", "daemon"];
const RUNNING_STATES = new Set(["running", "in_progress", "active", "working"]);
const QUEUED_STATES = new Set(["queued", "pending", "planned", "waiting"]);
const DONE_STATES = new Set(["completed", "done", "succeeded", "success"]);
const FAILED_STATES = new Set(["failed", "error", "cancelled", "canceled", "blocked"]);
const FALLBACK_MESSAGE = "No active OctoClaw runtime detected. Ensure the extension is installed and a task has been created.";
const DEFAULT_REPLAY_SAMPLE_LIMIT = 1000;

interface ParsedCliArgs {
  command?: CliCommand;
  format?: StatusFormat;
  legacyFormat: LegacyCliFormat;
  help: boolean;
  taskId?: string;
  limit?: number;
  service?: ServiceName;
  mode?: RunnerMode;
  model: boolean;
  drift: boolean;
  once: boolean;
  input?: string;
  outputDir?: string;
  nightlyFormat: NightlyFormat;
  config?: string;
  slackAcceptanceFormat: SlackAcceptanceFormat;
}

interface CliIo {
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

function resolveOctoClawHome(env: Record<string, string | undefined>): string {
  const explicit = asString(env.OCTOCLAW_HOME).trim();
  if (explicit) {
    return explicit;
  }
  return path.join(os.homedir(), ".octoclaw");
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
  const syncMode = env.OCTOCLAW_SYNC_MODE === "mirrored" ? "mirrored" : "managed";
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
  const failed = snapshot.tasks.filter((task) => FAILED_STATES.has(normalizeState(task.state))).length;
  const routeSummary = [...snapshot.replay.routeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([route, count]) => `${route}=${count}`)
    .join(", ") || "none";
  return [
    `Tasks total=${snapshot.tasks.length} running=${running} queued=${queued} done=${done} failed=${failed}`,
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
    pad(task.state, 12),
    pad(task.route, 14),
    pad(task.model, 28),
    pad(task.workerPool, 20),
    pad(task.phase, 14),
  ].join(" "));
  return [header, ...rows].join("\n");
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

function formatAnchors(snapshot: StatusSnapshot): string {
  return snapshot.tasks
    .map((task) => `${task.id}\n  anchor=${task.anchor}\n  route=${task.route}\n  state=${task.state}`)
    .join("\n");
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

function renderDetails(task: RuntimeTaskRecord, outputJson: boolean): string {
  const projection = buildDetailsProjection({
    record: task.record,
    route: task.route,
    workerPool: task.workerPool,
    modelSummary: task.model,
  });
  if (outputJson) {
    return JSON.stringify({ ...projection, raw: task.raw }, null, 2);
  }
  return [
    String(runStatusSurfaceOperator("details", task.record, "text")),
    `route=${task.route}`,
    `worker_pool=${task.workerPool}`,
    `model=${task.model}`,
    `phase=${task.phase}`,
    `anchor=${task.anchor}`,
    task.summary ? `summary=${task.summary}` : null,
  ].filter(Boolean).join("\n");
}

function renderQueue(tasks: RuntimeTaskRecord[], outputJson: boolean): string {
  const queued = tasks
    .filter((task) => QUEUED_STATES.has(normalizeState(task.state)) || RUNNING_STATES.has(normalizeState(task.state)))
    .map((task, index) => ({
      task,
      view: buildQueueProjection({
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
    : queued.map(({ task, view }) => [String(runStatusSurfaceOperator("queue", task.record, "text")), `route=${task.route}`, `model=${task.model}`, `position=${view.queuePosition ?? "unknown"}`].join("\n")).join("\n\n");
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
  let taskId: string | undefined;
  let limit: number | undefined;
  let service: ServiceName | undefined;
  let mode: RunnerMode | undefined;
  let model = false;
  let drift = false;
  let once = false;
  let input: string | undefined;
  let outputDir: string | undefined;
  let nightlyFormat: NightlyFormat = "markdown";
  let config: string | undefined;
  let slackAcceptanceFormat: SlackAcceptanceFormat = "markdown";
  let rawFormat: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--format") {
      rawFormat = argv[index + 1];
      index += 1;
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
    if (argument === "--input") {
      input = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--input=")) {
      [, input] = argument.split("=", 2);
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
    if (argument === "--config") {
      config = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--config=")) {
      [, config] = argument.split("=", 2);
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
  if (command === "details" && positionals[1] && !taskId) {
    taskId = positionals[1];
  }
  if (command && !["status", "details", "queue", "timeline", "health", "up", "down", "restart", "patrol", "reconcile", "repair", "nightly", "slack-acceptance"].includes(command)) {
    throw new Error(`Unknown action: ${command}. Expected one of: status, details, queue, timeline, health, up, down, restart, patrol, reconcile, repair, nightly, slack-acceptance`);
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`Unknown limit: ${String(limit)}. Expected a positive integer`);
  }

  if (rawFormat !== undefined) {
    const MARKDOWN_JSON_FORMATS: readonly string[] = ["markdown", "json"];
    if (command === "nightly" || command === "slack-acceptance") {
      if (!MARKDOWN_JSON_FORMATS.includes(rawFormat)) {
        throw new Error(`Unknown format: ${rawFormat}. Expected one of: markdown, json`);
      }
      if (command === "nightly") nightlyFormat = rawFormat as NightlyFormat;
      else slackAcceptanceFormat = rawFormat as SlackAcceptanceFormat;
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

  return {
    command,
    format,
    legacyFormat,
    help,
    taskId,
    limit,
    service,
    mode,
    model,
    drift,
    once,
    input,
    outputDir,
    nightlyFormat,
    config,
    slackAcceptanceFormat,
  };
}

export function runOctoClawCtl(
  action: StatusSurfaceAction,
  record: RuntimeStateSurfaceRecord,
  format: LegacyCliFormat = "text",
): string {
  if (format === "json") {
    return JSON.stringify(runStatusSurfaceOperator(action, record, "rich"), null, 2);
  }
  return String(runStatusSurfaceOperator(action, record, "text"));
}

export function printUsage(): string {
  return [
    "Usage: octoclawctl <command> [options]",
    "",
    "Commands:",
    "  octoclawctl status [--format compact|table|lanes|anchors|json]",
    "  octoclawctl details <task-id>",
    "  octoclawctl queue",
    "  octoclawctl timeline [--task-id ID] [--limit N] [--format json]",
    "  octoclawctl health [--model] [--drift] [--format json]",
    "  octoclawctl up [--service openclaw|runner] [--mode ondemand|daemon]",
    "  octoclawctl down [--service openclaw|runner]",
    "  octoclawctl restart [--service openclaw|runner]",
    "  octoclawctl patrol [--once]",
    "  octoclawctl reconcile",
    "  octoclawctl repair",
    "  octoclawctl nightly --input <replay.jsonl> --output-dir <dir> [--format markdown|json]",
    "  octoclawctl slack-acceptance --config <acceptance.json> --output-dir <dir> [--format markdown|json]",
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
  const report = generateNightlyReport(rawEvents);

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
  const client = new SlackWebApiAcceptanceClient(resolvedConfig.botToken);
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
      return renderDetails(task, parsed.format === "json");
    }
    case "queue":
      return renderQueue(snapshot.tasks, parsed.format === "json");
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
    case "slack-acceptance":
      return runSlackAcceptanceCliCommand(parsed, env);
    default:
      throw new Error(`Unknown action: ${parsed.command ?? "(missing)"}`);
  }
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
    if (parsed.help) {
      io.stdout(printUsage());
      return 0;
    }
    if (!parsed.command) {
      io.stderr("Unknown action: (missing). Expected one of: status, details, queue, timeline, health, up, down, restart, patrol, reconcile, repair, nightly, slack-acceptance");
      return 1;
    }

    const runtimeRecord = resolveRuntimeStateSurfaceRecord(env);
    if (runtimeRecord && LEGACY_ACTIONS.includes(parsed.command as StatusSurfaceAction) && !parsed.taskId && !parsed.service && !parsed.model && !parsed.drift) {
      io.stdout(runOctoClawCtl(parsed.command as StatusSurfaceAction, runtimeRecord, parsed.legacyFormat));
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

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  void main().then((exitCode) => {
    process.exit(exitCode);
  });
}
