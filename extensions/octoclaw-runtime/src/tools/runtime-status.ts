import { envOverrides, resolveReplayLogPath, truncateText } from "../resolve/env.js";
import { pruneTaskStateCache, readArchivedTaskState } from "../state/task-state-retention.js";
import { readTaskStateRecords } from "../state/task-state-store.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { invokeNativeHelper } from "../adapter/native-helper.js";
import type { NativeStatusProjection } from "../state/native-status-projector.js";
import { createOpenClawRuntimeAdapter, statusSnapshotToNativeProjection } from "../runtime-host/openclaw-adapter.js";
import { buildLegacyHeuristicFallbackEvent, legacyHeuristicVerdict } from "../state/legacy-heuristics.js";
import { buildSlackStatusOutput, buildStatusInteractiveBlocks, type IMType, type StatusTaskSummary } from "../im-status-renderer.js";
import { normalizeLiveRoute } from "../resolve/route-helpers.js";
import type { NativeBindingRef } from "@octoclaw/contracts/work-contract";
import { asBoolean, asRecord, asString, isRecord, type UnknownRecord } from "../util/type-coercion.js";
import {
  formatElapsed,
  hasExplicitFalse,
  hasExplicitTrue,
  isSyntheticTestTaskState,
  optionalString,
  timestampMs,
  toolResponse,
} from "./registration-helpers.js";
import {
  buildRuntimeTaskProjection,
  deliveryEvidence,
  nativeStatusInputForTask,
  projectRuntimeStatus,
  runtimeStatusEvidence,
  shouldDisplayRuntimeStatusRecord,
  type RuntimeStatusTaskView,
  type RuntimeTaskProjectionRecord,
} from "./runtime-task-projection.js";

type NullRecord = UnknownRecord | null;

export type RuntimeTaskStateRecord = RuntimeTaskProjectionRecord;
export type { RuntimeStatusTaskView };

export function normalizeTaskActionFormat(format: string): "text" | "json" {
  return format === "text" ? "text" : "json";
}

export function parseTaskAction(rawText: string): { action: string; taskId: string } {
  const [action = "", taskId = ""] = rawText.trim().split(/\s+/u);
  return {
    action: action.trim(),
    taskId: taskId.trim(),
  };
}

export function dedupeTaskStateRecords(tasks: RuntimeTaskStateRecord[]): RuntimeTaskStateRecord[] {
  const seen = new Set<string>();
  const deduped: RuntimeTaskStateRecord[] = [];
  for (const task of tasks) {
    const id = asString(task.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    deduped.push(task);
  }
  return deduped;
}

async function readActiveRuntimeTaskState(options: { includeSynthetic?: boolean } = {}): Promise<RuntimeTaskStateRecord[]> {
  const tasks = readTaskStateRecords().filter(isRecord) as RuntimeTaskStateRecord[];
  return tasks.filter((task) => options.includeSynthetic === true || !isSyntheticTestTaskState(task));
}

export async function readRuntimeTaskState(options: { includeArchive?: boolean; includeSynthetic?: boolean } = {}): Promise<RuntimeTaskStateRecord[]> {
  const activeTasks = await readActiveRuntimeTaskState({ includeSynthetic: options.includeSynthetic });
  if (!options.includeArchive) return activeTasks;
  const archivedTasks = (readArchivedTaskState().filter(isRecord) as RuntimeTaskStateRecord[])
    .filter((task) => options.includeSynthetic === true || !isSyntheticTestTaskState(task));
  return dedupeTaskStateRecords([...activeTasks, ...archivedTasks]);
}


function pruneRuntimeTaskStateCache(): { archived: number; deletedArchiveEntries: number; skipped: boolean; reason: string } {
  try {
    const result = pruneTaskStateCache();
    return {
      archived: result.archived,
      deletedArchiveEntries: result.deletedArchiveEntries ?? 0,
      skipped: result.skipped,
      reason: result.reason || "",
    };
  } catch {
    return { archived: 0, deletedArchiveEntries: 0, skipped: true, reason: "retention_failed" };
  }
}

async function readRuntimeReplayTimeline(taskId: string): Promise<UnknownRecord[]> {
  if (!taskId) return [];
  try {
    const fs = await import("node:fs");
    const content = fs.default.readFileSync(resolveReplayLogPath(), "utf-8");
    return content
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as UnknownRecord;
        } catch {
          return {};
        }
      })
      .filter((entry) => asString(entry.taskId || entry.task_id || asRecord(entry.materialization).task_id) === taskId)
      .slice(-20);
  } catch {
    return [];
  }
}

function sortTaskStateRecords(tasks: RuntimeTaskStateRecord[]): RuntimeTaskStateRecord[] {
  return [...tasks].sort((left, right) => {
    const leftAt = Date.parse(asString(left.updated_at || left.completed_at || left.started_at || left.spawned_at)) || 0;
    const rightAt = Date.parse(asString(right.updated_at || right.completed_at || right.started_at || right.spawned_at)) || 0;
    return rightAt - leftAt;
  });
}

// timed_out/blocked tasks stay visible for 30 min (was 1h — most aren't worth seeing after half an hour)
const STATUS_PANEL_STALE_VISIBLE_MS = 30 * 60 * 1000;
// completed/failed/canceled stay visible for 4h (was 24h — don't need yesterday's tasks cluttering the panel)
const STATUS_PANEL_TERMINAL_VISIBLE_MS = 4 * 60 * 60 * 1000;


export function hasNonNewWorkFollowupEvidence(decision: UnknownRecord, metadata: UnknownRecord): boolean {
  const routeDecision = asRecord(decision.route_decision);
  const routerDecision = asRecord(decision.router_decision_v2);
  const requestMetadata = asRecord(asRecord(decision.request).metadata);
  const conversationControl = asRecord(metadata.conversation_control ?? requestMetadata.conversation_control);
  const intentPacket = asRecord(metadata.intent_packet ?? requestMetadata.intent_packet);
  const executionCoverage = asRecord(decision._execution_coverage_packet ?? decision._execution_coverage ?? routeDecision._execution_coverage);
  const coverageExecution = asRecord(asRecord(executionCoverage.coverage).execution);
  const explicitNewWork = [
    decision.is_new_work,
    decision.isNewWork,
    routeDecision.is_new_work,
    routeDecision.isNewWork,
    metadata.is_new_work,
    metadata.isNewWork,
    requestMetadata.is_new_work,
    requestMetadata.isNewWork,
    intentPacket.is_new_work,
    intentPacket.isNewWork,
  ].some((value) => value === false);
  const relation = asString(
    metadata.relation_to_recent_execution
      || requestMetadata.relation_to_recent_execution
      || intentPacket.relation_to_recent_execution,
  );
  const intentClass = asString(
    conversationControl.intent_class
      || metadata.intent_class
      || requestMetadata.intent_class
      || intentPacket.intent_class
      || intentPacket.intentClass,
  );
  return explicitNewWork
    || relation === "existing_execution_followup"
    || relation === "existing_execution_provenance_query"
    || intentClass === "execution_followup"
    || asString(routerDecision.request_kind) === "status_or_provenance"
    || asBoolean(conversationControl.status_followup)
    || asBoolean(conversationControl.provenance_followup)
    || asBoolean(coverageExecution.supports_status_reply)
    || asBoolean(coverageExecution.supports_provenance_reply)
    || asBoolean(executionCoverage.supports_status_reply)
    || asBoolean(executionCoverage.supports_provenance_reply);
}


export function plannerDispatchResponse(params: {
  spawnIntentId: string;
  workContractId: string;
  delegateTaskId: string;
  attemptId: string;
  ticketId?: string;
  ticketAdmissionReason?: string;
  ticketEnforced?: boolean;
  sessionsSpawnArgs: Record<string, unknown>;
  sessionsSendArgs?: Record<string, unknown>;
  dispatchMode?: "new_spawn" | "send_to_speculative";
  speculativeSessionLabel?: string;
  canonicalArgsHash: string;
  expiresAt: string;
  workerPool: string;
  model: string;
}): Record<string, unknown> {
  const dispatchMode = params.dispatchMode || "new_spawn";
  const nextTool = dispatchMode === "send_to_speculative" ? "sessions_send" : "sessions_spawn";
  const body = {
    ok: true,
    route: "delegate",
    status: "requires_native_spawn",
    dispatch_mode: dispatchMode,
    dispatchMode,
    delegation_method: "octoclaw_dispatch_planner",
    next_tool: nextTool,
    nextTool,
    confirm_tool: "octoclaw_dispatch_confirm",
    confirmTool: "octoclaw_dispatch_confirm",
    spawn_intent_id: params.spawnIntentId,
    spawnIntentId: params.spawnIntentId,
    work_contract_id: params.workContractId,
    workContractId: params.workContractId,
    delegate_task_id: params.delegateTaskId,
    delegateTaskId: params.delegateTaskId,
    attempt_id: params.attemptId,
    attemptId: params.attemptId,
    ...(params.ticketId ? { ticket_id: params.ticketId, ticketId: params.ticketId } : {}),
    ...(params.ticketAdmissionReason ? { ticket_admission_reason: params.ticketAdmissionReason } : {}),
    ticket_enforced: params.ticketEnforced === true,
    sessions_spawn_args: params.sessionsSpawnArgs,
    sessionsSpawnArgs: params.sessionsSpawnArgs,
    ...(params.sessionsSendArgs ? {
      sessions_send_args: params.sessionsSendArgs,
      sessionsSendArgs: params.sessionsSendArgs,
    } : {}),
    ...(params.speculativeSessionLabel ? {
      speculative_session_label: params.speculativeSessionLabel,
      speculativeSessionLabel: params.speculativeSessionLabel,
    } : {}),
    canonical_args_hash: params.canonicalArgsHash,
    canonicalArgsHash: params.canonicalArgsHash,
    expires_at: params.expiresAt,
    expiresAt: params.expiresAt,
    worker_pool: params.workerPool,
    model: params.model,
    dispatch_executed: false,
    spawn_executed: false,
    materialized: false,
    result_materialized: false,
    instruction: dispatchMode === "send_to_speculative"
      ? "Call sessions_send exactly with sessionsSendArgs, then call octoclaw_dispatch_confirm with spawnIntentId, workContractId, sessionsSpawnStatus, runId, childRunId, and childSessionKey from the native sessions_send result. If sessions_send is not accepted, confirm the error; do not claim the task has started."
      : "Call sessions_spawn exactly with sessionsSpawnArgs, then call octoclaw_dispatch_confirm with spawnIntentId, workContractId, sessionsSpawnStatus, runId, childRunId, and childSessionKey from the native result.",
  };
  return toolResponse(JSON.stringify(body), body);
}

export function speculativePreloadStandbyRequiredResponse(params: {
  label: string;
  sessionsSpawnArgs: Record<string, unknown>;
  candidateKey: string;
  status: string;
}): Record<string, unknown> {
  const body = {
    ok: false,
    route: "delegate",
    status: "speculative_standby_required",
    dispatch_mode: "standby_required",
    dispatchMode: "standby_required",
    delegation_method: "octoclaw_dispatch_planner",
    next_tool: "sessions_spawn",
    nextTool: "sessions_spawn",
    sessions_spawn_args: params.sessionsSpawnArgs,
    sessionsSpawnArgs: params.sessionsSpawnArgs,
    speculative_session_label: params.label,
    speculativeSessionLabel: params.label,
    speculative_selection_candidate_key: params.candidateKey,
    speculative_selection_status: params.status,
    dispatch_executed: false,
    spawn_executed: false,
    materialized: false,
    result_materialized: false,
    retryable: true,
    instruction: "Call sessions_spawn exactly with sessionsSpawnArgs first. After sessions_spawn returns accepted, call octoclaw_dispatch again with the original task so OctoClaw can create a send_to_speculative intent. Do not claim the task has started before octoclaw_dispatch_confirm succeeds.",
  };
  return toolResponse(JSON.stringify(body), body);
}

export function dispatchSpawnEvidence(input: {
  payloadRuntimeTruth?: UnknownRecord;
  payloadNativeTaskBinding?: UnknownRecord;
  payloadDelegateAttempt?: UnknownRecord;
  payloadNativeAttemptBinding?: UnknownRecord;
  nativeBinding?: NativeBindingRef | null;
}): { spawnExecuted: boolean; runId: string; childRunId: string; childSessionKey: string; childSessionId: string } {
  const runtimeTruth = input.payloadRuntimeTruth ?? {};
  const evidence = asRecord(runtimeTruth.evidence);
  const runtimeBinding = asRecord(runtimeTruth.binding);
  const nativeTaskBinding = input.payloadNativeTaskBinding ?? {};
  const delegateAttempt = input.payloadDelegateAttempt ?? {};
  const nativeAttemptBinding = input.payloadNativeAttemptBinding ?? {};
  const runId = optionalString(
    nativeTaskBinding.runId,
    nativeTaskBinding.run_id,
    delegateAttempt.runId,
    delegateAttempt.run_id,
    nativeAttemptBinding.runId,
    nativeAttemptBinding.run_id,
    runtimeBinding.runId,
    runtimeBinding.run_id,
    evidence.runId,
    evidence.run_id,
  ) ?? "";
  const childRunId = optionalString(
    nativeTaskBinding.childRunId,
    nativeTaskBinding.child_run_id,
    delegateAttempt.childRunId,
    delegateAttempt.child_run_id,
    nativeAttemptBinding.childRunId,
    nativeAttemptBinding.child_run_id,
    runtimeBinding.childRunId,
    runtimeBinding.child_run_id,
    evidence.childRunId,
    evidence.child_run_id,
  ) ?? "";
  const childSessionKey = optionalString(
    nativeTaskBinding.childSessionKey,
    nativeTaskBinding.child_session_key,
    delegateAttempt.childSessionKey,
    delegateAttempt.child_session_key,
    nativeAttemptBinding.childSessionKey,
    nativeAttemptBinding.child_session_key,
    runtimeBinding.childSessionKey,
    runtimeBinding.child_session_key,
    evidence.childSessionKey,
    evidence.child_session_key,
  ) ?? "";
  const childSessionId = optionalString(
    nativeTaskBinding.childSessionId,
    nativeTaskBinding.child_session_id,
    delegateAttempt.childSessionId,
    delegateAttempt.child_session_id,
    runtimeBinding.childSessionId,
    runtimeBinding.child_session_id,
    evidence.childSessionId,
    evidence.child_session_id,
  ) ?? "";
  const spawnSignals = [
    nativeTaskBinding.spawnExecuted,
    nativeTaskBinding.spawn_executed,
    delegateAttempt.spawnExecuted,
    delegateAttempt.spawn_executed,
    nativeAttemptBinding.spawnExecuted,
    nativeAttemptBinding.spawn_executed,
    runtimeBinding.spawnExecuted,
    runtimeBinding.spawn_executed,
    evidence.spawnExecuted,
    evidence.spawn_executed,
  ];
  const spawnExecuted = hasExplicitTrue(spawnSignals)
    || Boolean(runId || childRunId || childSessionId)
    || (!hasExplicitFalse(spawnSignals) && Boolean(childSessionKey));
  return { spawnExecuted, runId, childRunId, childSessionKey, childSessionId };
}


function statusPanelRelevantMs(task: RuntimeStatusTaskView): number | null {
  return timestampMs(task.completedAt)
    ?? timestampMs(task.updatedAt)
    ?? timestampMs(task.delegatedAt)
    ?? timestampMs(task.startedAt);
}

function statusPanelRetentionMs(task: RuntimeStatusTaskView): number | null {
  if (["failed", "completed", "delivered", "canceled"].includes(task.status)) return STATUS_PANEL_TERMINAL_VISIBLE_MS;
  if (task.status === "queued" && task.statusReason === "dispatch_materialized_but_no_spawn_evidence") return STATUS_PANEL_STALE_VISIBLE_MS;
  if (["timed_out", "blocked", "registered", "main_fallback", "deliverable_ready", "degraded", "lost"].includes(task.status)) return STATUS_PANEL_STALE_VISIBLE_MS;
  return null;
}

function isStatusPanelExpired(task: RuntimeStatusTaskView, nowMs = Date.now()): boolean {
  const retentionMs = statusPanelRetentionMs(task);
  if (retentionMs === null) return false;
  const relevantMs = statusPanelRelevantMs(task);
  return relevantMs !== null && nowMs - relevantMs >= retentionMs;
}

function shouldIncludeExpiredStatus(format: string): boolean {
  return ["table", "lanes", "raw"].includes(format);
}

export function buildRuntimeStatusTaskView(record: RuntimeTaskStateRecord, nowMs = Date.now(), nativeProjection?: NativeStatusProjection): RuntimeStatusTaskView {
  return buildRuntimeTaskProjection(record, { nowMs, nativeProjection });
}

export function buildTaskActionTimeline(record: RuntimeTaskStateRecord, liveRead: UnknownRecord, replayEvents: UnknownRecord[]): UnknownRecord[] {
  const timeline: UnknownRecord[] = [];
  const pushIfPresent = (eventType: string, eventAt: unknown, summary: string) => {
    const at = asString(eventAt);
    if (at) timeline.push({ eventType, eventAt: at, summary });
  };
  const evidence = runtimeStatusEvidence(record);
  pushIfPresent("materialized", record.materialized_at || record.created_at, "Task was materialized in Native TaskFlow");
  if (evidence.hasSpawnEvidence) {
    pushIfPresent("spawned", record.spawned_at, "Task was spawned");
    pushIfPresent("started", record.started_at, "Task started execution");
  }
  pushIfPresent("updated", record.updated_at, asString(record.summary || liveRead.progressSummary || record.status, "Task updated"));
  pushIfPresent("completed", record.completed_at, "Task completed");
  for (const event of replayEvents) {
    const eventType = asString(event.event || event.kind);
    const eventAt = asString(event.at || event.timestamp || event.createdAt);
    if (eventType && eventAt) {
      timeline.push({
        eventType,
        eventAt,
        summary: asString(event.summary || event.message || event.reason || eventType),
      });
    }
  }
  return timeline.sort((left, right) => Date.parse(asString(left.eventAt)) - Date.parse(asString(right.eventAt)));
}

const TASK_IDENTITY_ALIAS_KEYS = new Set([
  "id",
  "taskId",
  "task_id",
  "nativeTaskId",
  "native_task_id",
  "workContractId",
  "work_contract_id",
  "delegateTaskId",
  "delegate_task_id",
  "flowId",
  "flow_id",
  "nativeFlowId",
  "native_flow_id",
  "attemptId",
  "attempt_id",
  "currentAttemptId",
  "current_attempt_id",
  "firstAttemptId",
  "first_attempt_id",
  "latestAttemptId",
  "latest_attempt_id",
  "runId",
  "run_id",
  "childRunId",
  "child_run_id",
]);

const TASK_IDENTITY_NESTED_KEYS = [
  "workContract",
  "work_contract",
  "delegate",
  "nativeBinding",
  "native_binding",
  "runtime_truth",
  "binding",
  "visibleIds",
  "visible_ids",
  "mainContext",
  "main_context",
  "artifacts",
  "telemetry",
  "childSessions",
  "child_sessions",
];

export function collectIdentityAliases(value: unknown, output: Set<string>, depth = 0): void {
  if (!value || depth > 6) return;
  if (typeof value === "string" || typeof value === "number") {
    const text = asString(value);
    if (text) output.add(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectIdentityAliases(entry, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as UnknownRecord;
  for (const [key, entry] of Object.entries(record)) {
    if (TASK_IDENTITY_ALIAS_KEYS.has(key)) collectIdentityAliases(entry, output, depth + 1);
  }
  for (const key of TASK_IDENTITY_NESTED_KEYS) {
    collectIdentityAliases(record[key], output, depth + 1);
  }
}

export function taskStateRecordMatchesId(record: RuntimeTaskStateRecord, rawTaskId: string): boolean {
  const taskId = asString(rawTaskId);
  if (!taskId) return false;
  const aliases = new Set<string>();
  collectIdentityAliases(record, aliases);
  const canMatchPrefix = taskId.length >= 7;
  return [...aliases].some((alias) => alias === taskId || (canMatchPrefix && alias.startsWith(taskId)));
}

export async function buildNativeTaskActionPayload(rawText: string, format: "text" | "json"): Promise<{ summary: string; payload: UnknownRecord }> {
  const { action, taskId } = parseTaskAction(rawText);
  const normalizedAction = action || "details";
  pruneRuntimeTaskStateCache();
  const tasks = sortTaskStateRecords(await readRuntimeTaskState({
    includeArchive: Boolean(taskId),
    includeSynthetic: Boolean(taskId) && Boolean(envOverrides.workspaceRoot),
  }));
  let record = (taskId ? tasks.find((entry) => taskStateRecordMatchesId(entry, taskId)) : tasks[0]) || null;
  let liveRead: NullRecord = null;

  if (!record) {
    const payload = {
      mode: "native_runtime",
      action: normalizedAction,
      taskId: taskId || undefined,
      format,
      found: false,
      summary: taskId ? `Task ${taskId} not found.` : "No OctoClaw task state is available.",
    };
    return {
      summary: format === "json" ? JSON.stringify(payload, null, 2) : payload.summary,
      payload,
    };
  }
  if (!liveRead) {
    try {
      const sessionKey = asString(record.session_key);
      const flowId = asString(record.flow_id);
      const taskId = asString(record.id);
      if (sessionKey && flowId && taskId) {
        const native = invokeNativeHelper({
          action: "read-task",
          args: {
            session_key: sessionKey,
            flow_id: flowId,
            task_id: taskId,
          },
        });
        liveRead = native.found && native.task
          ? {
              taskId: native.task.taskId,
              flowId: native.flow_id,
              syncMode: native.task.syncMode,
              substrateState: native.task.state ?? native.task.status,
              substrateRevision: native.task.revision,
              progressSummary: native.task.progressSummary,
            }
          : null;
      } else {
        liveRead = null;
      }
    } catch {
      liveRead = null;
    }
  }
  const replayEvents = await readRuntimeReplayTimeline(asString(record.id));
  const artifacts = asRecord(record.artifacts);
  const projected = projectRuntimeStatus(record);
  const taskView = buildRuntimeStatusTaskView(record);
  const delivery = deliveryEvidence(record);
  const payload: UnknownRecord = {
    mode: "native_runtime",
    action: normalizedAction,
    taskId: asString(record.id),
    flowId: asString(record.flow_id),
    sessionKey: asString(record.session_key),
    route: normalizeLiveRoute(record.route, "delegate"),
    role: asString(record.role, asString(asRecord(artifacts.runtime_truth).role)),
    status: projected.status,
    rawStatus: asString(liveRead?.substrateState || record.status),
    statusReason: projected.reason,
    progress: asString(liveRead?.progressSummary || record.summary),
    summary: asString(record.summary, asString(liveRead?.progressSummary || record.status)),
    workerPool: asString(record.worker_pool),
    syncMode: asString(liveRead?.syncMode),
    substrateRevision: liveRead?.substrateRevision,
    timeline: buildTaskActionTimeline(record, liveRead ?? {}, replayEvents),
    artifacts,
    reportPath: asString(record.report_path || artifacts.report_path),
    resultLocation: taskView.resultLocation,
    delivery,
    found: true,
    format,
  };
  if (normalizedAction === "queue") {
    payload.queue = tasks.map((entry, index) => ({
      position: index + 1,
      taskId: asString(entry.id),
      status: asString(entry.status),
      route: normalizeLiveRoute(entry.route, "delegate"),
      role: asString(entry.role),
      summary: asString(entry.summary),
      updatedAt: asString(entry.updated_at),
    }));
  }
  const summary = format === "json"
    ? JSON.stringify(payload, null, 2)
    : [
        `Task: ${asString(payload.taskId)}`,
        `Status: ${asString(payload.status) || "unknown"}`,
        asString(payload.progress) ? `Progress: ${asString(payload.progress)}` : "",
        asString(payload.flowId) ? `Flow: ${asString(payload.flowId)}` : "",
        asString(payload.resultLocation) && asString(payload.resultLocation) !== "none" ? `Result: ${asString(payload.resultLocation)}` : "",
        asString(delivery.status) && asString(delivery.status) !== "none" ? `Delivery: ${asString(delivery.status)}` : "",
        Array.isArray(payload.timeline) && payload.timeline.length > 0
          ? `Timeline:\n${(payload.timeline as UnknownRecord[]).map((event) => `- ${asString(event.eventAt)} ${asString(event.eventType)}: ${asString(event.summary)}`).join("\n")}`
          : "",
        Object.keys(artifacts).length > 0 ? `Artifacts: ${Object.keys(artifacts).join(", ")}` : "",
      ].filter(Boolean).join("\n");
  return { summary, payload };
}

export interface NativeStatusPanelOutput {
  text: string;
  interactiveBlocks?: Array<Record<string, unknown>>;
}

function statusTaskSummaryFromView(t: RuntimeStatusTaskView): StatusTaskSummary {
  return {
    taskId: t.taskId,
    status: t.status,
    rawStatus: t.rawStatus,
    title: t.title,
    summary: t.summary,
    model: t.model,
    complexityBand: t.complexityBand,
    elapsedText: t.elapsedText,
    delegatedAt: t.delegatedAt,
    completedAt: t.completedAt,
    startedAtDisplay: t.startedAtDisplay,
    completedAtDisplay: t.completedAtDisplay,
    statusReason: t.statusReason,
    route: t.route,
  };
}

function nativeStatusBlocks(imType: string, tasks: RuntimeStatusTaskView[], totalCount: number, hiddenCount: number): Array<Record<string, unknown>> | undefined {
  const supported = new Set(["slack", "feishu", "discord", "telegram"]);
  if (!supported.has(imType)) return undefined;
  const summaries = tasks.slice(0, 8).map(statusTaskSummaryFromView);
  const blocks = buildStatusInteractiveBlocks(imType as IMType, summaries, { totalCount, hiddenCount });
  return blocks.length > 0 ? blocks : undefined;
}

export async function buildNativeStatusPanelOutput(format: string, imType: string = "plain", ctx: UnknownRecord = {}): Promise<NativeStatusPanelOutput> {
  const normalizedFormat = format || "anchors";
  const nowMs = Date.now();
  const includeExpired = shouldIncludeExpiredStatus(normalizedFormat);
  const retention = pruneRuntimeTaskStateCache();
  const tasks = sortTaskStateRecords(await readRuntimeTaskState({ includeArchive: includeExpired }));
  const nativeInputs = tasks.map((task) => nativeStatusInputForTask(task, ctx));
  const runtimeHost = createOpenClawRuntimeAdapter();
  const nativeProjections = await Promise.all(nativeInputs.map(async (input) => statusSnapshotToNativeProjection(await runtimeHost.readStatus({
    ctx: input.ctx,
    sessionKey: input.sessionKey,
    workContractId: input.workContractId,
    taskId: input.openclawTaskId,
    runId: input.openclawRunId,
    flowId: input.openclawFlowId,
    childSessionKey: input.childSessionKey,
    cache: input.cache,
    allowFindLatest: input.allowFindLatest,
  }))));
  tasks.forEach((task, index) => {
    const input = nativeInputs[index];
    const projection = nativeProjections[index];
    const evidence = runtimeStatusEvidence(task);
    const hasKnownNativeId = Boolean(input.openclawRunId || input.openclawTaskId || input.openclawFlowId);
    const hasNativeTruth = ["run", "flow", "latest"].includes(projection.source)
      || Boolean(projection.nativeKind || projection.agentRuntimeId);
    const hasLegacySignal = Boolean(evidence.childSessionKey || asString(task.childSessionKey || task.child_session_key));
    const newTask = Boolean(hasKnownNativeId || projection.nativeKind || projection.agentRuntimeId);
    const verdict = legacyHeuristicVerdict({
      surface: "status_projection",
      hasNativeTruth,
      hasKnownNativeId,
      hasLegacySignal,
      newTask,
      reason: hasNativeTruth || hasKnownNativeId ? "native_kind_present" : "native_fields_absent",
    });
    if (verdict.source === "legacy_heuristic_read_only") {
      void recordPolicyReplay("legacy_heuristic_fallback_used", buildLegacyHeuristicFallbackEvent({
        taskId: asString(task.id),
        workContractId: asString(task.workContractId || task.work_contract_id),
        surface: "status_projection",
        reason: verdict.reason,
        newTask,
        allowed: verdict.allowed,
      })).catch(() => undefined);
    }
  });
  const allTasks = tasks
    .map((task, index) => buildRuntimeStatusTaskView(task, nowMs, nativeProjections[index]))
    .filter((task, index) => shouldDisplayRuntimeStatusRecord(tasks[index]) && task.route === "delegate");
  const visibleTasks = includeExpired ? allTasks : allTasks.filter((task) => !isStatusPanelExpired(task, nowMs));
  const hiddenExpiredCount = allTasks.length - visibleTasks.length;

  // Sort by importance: active first, then recent terminal
  const STATUS_PRIORITY: Record<string, number> = {
    running: 0, running_slow: 0, stalled: 1, materializing: 2, queued: 3, blocked: 4,
    timed_out: 5, lost: 6, degraded: 7, failed: 8, deliverable_ready: 9,
    completed: 10, delivered: 10, canceled: 11, registered: 12,
  };
  const sortedVisibleTasks = [...visibleTasks].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 5;
    const pb = STATUS_PRIORITY[b.status] ?? 5;
    if (pa !== pb) return pa - pb;
    // Within same status: most recent first
    return Date.parse(b.delegatedAt || b.updatedAt || "") - Date.parse(a.delegatedAt || a.updatedAt || "");
  });

  // ── Slack mrkdwn rendering ───────────────────────────────────────────────
  if (imType === "slack" && normalizedFormat === "anchors") {
    const limit = 6;  // 6 tasks is enough for a readable Slack panel
    const slackTasks = sortedVisibleTasks.slice(0, limit).map(statusTaskSummaryFromView);
    const slackOutput = buildSlackStatusOutput(slackTasks, {
      totalCount: allTasks.length,
      hiddenCount: hiddenExpiredCount,
      format: normalizedFormat,
    });
    return {
      text: slackOutput.text,
      interactiveBlocks: buildStatusInteractiveBlocks("slack", slackTasks, {
        totalCount: allTasks.length,
        hiddenCount: hiddenExpiredCount,
      }),
    };
  }

  // ── Beautified anchors format (default) ─────────────────────────────────
  if (normalizedFormat === "anchors") {
    const limit = 50;
    const completedStates = new Set(["completed", "delivered"]);
    const failedStates = new Set([
      "failed",
      "timed_out",
      "timeout_no_result",
      "canceled",
      "cancelled",
      "completion_orphaned",
      "binding_mismatch",
      "delivery_failed",
      "spawn_not_confirmed",
      "lost",
      "degraded",
    ]);

    const attentionStates = new Set([
      "degraded",
      "lost",
      "deliverable_ready",
    ]);

    type GroupKey = "active" | "attention" | "completed" | "failed";
    const groupOrder: GroupKey[] = ["active", "attention", "completed", "failed"];
    const groupEmoji: Record<GroupKey, string> = { active: "⏳", attention: "⚠️", completed: "✅", failed: "❌" };
    const groupLabel: Record<GroupKey, string> = { active: "Active", attention: "Attention", completed: "Completed", failed: "Failed" };

    const groups = new Map<GroupKey, typeof sortedVisibleTasks>();
    for (const key of groupOrder) groups.set(key, []);
    for (const task of sortedVisibleTasks) {
      let key: GroupKey;
      if (completedStates.has(task.status)) key = "completed";
      else if (attentionStates.has(task.status)) key = "attention";
      else if (failedStates.has(task.status)) key = "failed";
      else key = "active";
      groups.get(key)!.push(task);
    }

    const lines: string[] = [
      "OctoClaw status (anchors)",
      `Visible delegated tasks: ${visibleTasks.length} | Total: ${allTasks.length} | Expired hidden: ${hiddenExpiredCount}`,
    ];

    let shown = 0;
    for (const key of groupOrder) {
      const tasks = groups.get(key)!;
      if (tasks.length === 0) continue;
      lines.push("");
      lines.push(`${groupEmoji[key]} ${groupLabel[key]}:`);
      for (const task of tasks) {
        if (shown >= limit) break;
        const id = task.taskId.length > 10 ? `${task.taskId.slice(0, 10)}…` : task.taskId;
        const elapsed = task.elapsedText && task.elapsedText !== "unknown" ? task.elapsedText : "-";
        const model = task.model && task.model !== "unknown" ? task.model : "";
        const band = task.complexityBand && task.complexityBand !== "unknown" ? task.complexityBand : "";
        const title = truncateText(task.title || task.summary || "未命名任务", 60);
        const timeInfo = task.completedAtDisplay || task.startedAtDisplay || "";
        const metaParts = [task.status, elapsed, timeInfo, model, band].filter(Boolean);
        const metaStr = metaParts.length > 0 ? ` | ${metaParts.join(" | ")}` : "";
        lines.push(`- ${id}${metaStr} | ${title}`);
        shown++;
      }
      if (shown >= limit) break;
    }

    if (allTasks.length === 0) {
      lines.push("");
      lines.push("No delegated task state is currently available.");
    } else if (visibleTasks.length === 0) {
      lines.push("");
      lines.push("No visible delegated tasks; use format=raw for archived/expired details.");
    }
    if (sortedVisibleTasks.length > limit) {
      lines.push("");
      lines.push(`… ${sortedVisibleTasks.length - limit} more tasks hidden; use format=raw for full details.`);
    }
    return {
      text: lines.join("\n"),
      interactiveBlocks: nativeStatusBlocks(imType, sortedVisibleTasks, allTasks.length, hiddenExpiredCount),
    };
  }

  const counts = visibleTasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
  const allCounts = allTasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
  const summarizeCounts = (source: Record<string, number>) => Object.entries(source)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  const countSummary = summarizeCounts(counts);
  const allCountSummary = summarizeCounts(allCounts);
  const lines = [
    `OctoClaw native runtime status (${normalizedFormat})`,
    `Visible records: ${visibleTasks.length}`,
    `Total records: ${allTasks.length}`,
    retention.archived > 0 || retention.deletedArchiveEntries > 0
      ? `Retention: archived=${retention.archived}, archive_deleted=${retention.deletedArchiveEntries}`
      : retention.skipped && retention.reason ? `Retention: ${retention.reason}` : "",
    hiddenExpiredCount > 0 && !includeExpired
      ? `Expired hidden: ${hiddenExpiredCount} (TTL: timed_out/blocked ${formatElapsed(STATUS_PANEL_STALE_VISIBLE_MS)}, terminal ${formatElapsed(STATUS_PANEL_TERMINAL_VISIBLE_MS)}; ask for table/lanes to inspect history)`
      : `Expired hidden: ${hiddenExpiredCount}`,
    countSummary ? `Projected counts: ${countSummary}` : "Projected counts: none",
    hiddenExpiredCount > 0 && !includeExpired && allCountSummary ? `All projected counts: ${allCountSummary}` : "",
    "Fields: task_id | projected_status(raw_status) | route | title | complexity | elapsed | delegated_at | model | backend | native_kind/runtime | child_session/run | result_location/artifact_refs | reason | summary",
  ].filter(Boolean);
  const limit = normalizedFormat === "raw" ? 50 : 25;
  for (const task of sortedVisibleTasks.slice(0, limit)) {
    const childRef = [task.childSessionKey, task.runId].filter(Boolean).join("/") || "none";
    const nativeRef = [task.nativeKind, task.agentRuntimeId].filter(Boolean).join("/") || "unknown";
    lines.push([
      `- ${task.taskId}`,
      `${task.status}(${task.rawStatus})`,
      task.route,
      `title=${task.title}`,
      `complexity=${task.complexityBand}`,
      `elapsed=${task.elapsedText}`,
      `delegated_at=${task.delegatedAt || "unknown"}`,
      `model=${task.model}`,
      `backend=${task.backend}`,
      `native=${nativeRef}`,
      `child=${childRef}`,
      `result=${task.resultLocation}`,
      `reason=${task.statusReason}`,
      task.summary,
    ].join(" | "));
  }
  if (allTasks.length === 0) {
    lines.push("No runtime task state is currently available.");
  }
  return { text: lines.join("\n") };
}

export async function buildNativeStatusOutput(format: string, imType: string = "plain", ctx: UnknownRecord = {}): Promise<string> {
  return (await buildNativeStatusPanelOutput(format, imType, ctx)).text;
}
