import {
  buildDecision,
  applyPhaseTwoLivePathPolicy,
  buildTsRuntimeDispatchPayload,
  buildTsRuntimeSpawnPayload,
  checkActiveTaskRecovery,
  resolveStatelessPolicyDecision,
} from "../resolve/policy-resolver.js";
import {
  resolveReplayLogPath,
  resolveTaskStatePath,
  stableId,
  truncateText,
} from "../resolve/env.js";
import {
  type NativeHelperInvoker,
} from "../adapter/native-helper.js";
import {
  applyUserMetadataOverrides,
  buildPolicyMetadata,
  detectSessionBoundary,
  finalizeDispatchMetadata,
  isManagedAgentContext,
  resolveDispatchSessionKey,
  resolvePolicyStateKey,
} from "../resolve/session.js";
import {
  policySummaryText,
  recordDispatchLifecycleReplayEvents,
  recordPolicyReplay,
  registerPendingDelivery,
} from "../replay/replay-logger.js";
import { policyState } from "../state/policy-state.js";
import { createOctoClawRuntimePlugin } from "../plugin.js";
import {
  authoritativeDecisionRoute,
  canonicalizeDecisionForPolicyState,
  normalizeLiveRoute,
} from "../resolve/route-helpers.js";
import { validateRouteSeal } from "../resolve/route-seal.js";
import { createOpenClawDistTaskFlowPort } from "../ports/openclaw-dist-taskflow-port.js";
import { checkTaskflowCapability } from "../ports/taskflow-port.js";
import type { RouteSeal } from "@octoclaw/contracts/route-seal";
import fsSync from "node:fs";

interface FsSyncLike {
  readFileSync(pathname: string, encoding: string): string;
  writeFileSync(pathname: string, data: string, encoding: string): void;
}

const fsSyncLike = fsSync as unknown as FsSyncLike;

type UnknownRecord = Record<string, unknown>;
type NullRecord = UnknownRecord | null;

function taskIdsFromRuntimeTruth(runtimeTruth: UnknownRecord): string[] {
  const binding = asRecord(runtimeTruth.binding);
  const delegateTask = asRecord(runtimeTruth.delegateTask);
  const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
  const nativeTaskBinding = asRecord(runtimeTruth.nativeTaskBinding);
  return [
    binding.taskId,
    delegateTask.delegateTaskId,
    asRecord(delegateAttempt.nativeBinding).nativeTaskId,
    nativeTaskBinding.nativeTaskId,
  ].map((value) => asString(value)).filter(Boolean);
}

function flowIdsFromRuntimeTruth(runtimeTruth: UnknownRecord): string[] {
  const binding = asRecord(runtimeTruth.binding);
  const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
  const nativeTaskBinding = asRecord(runtimeTruth.nativeTaskBinding);
  return [
    binding.flowId,
    asRecord(delegateAttempt.nativeBinding).nativeFlowId,
    nativeTaskBinding.nativeFlowId,
  ].map((value) => asString(value)).filter(Boolean);
}

function findRuntimeTaskInPolicyState(taskId: string): { sessionKey: string; flowId: string } | null {
  for (const { state } of policyState.entries()) {
    const decision = asRecord(state?.decision);
    const runtimeTruth = asRecord(decision.runtime_truth);
    const candidateTaskIds = taskIdsFromRuntimeTruth(runtimeTruth);
    const candidateFlowId = flowIdsFromRuntimeTruth(runtimeTruth)[0] || "";
    const sessionKey = asString(runtimeTruth.sessionKey || asRecord(decision.request).session_key);
    if (candidateTaskIds.includes(taskId) && candidateFlowId && sessionKey) {
      return { sessionKey, flowId: candidateFlowId };
    }
  }
  return null;
}

async function upsertTaskStateCache(record: RuntimeTaskStateRecord): Promise<void> {
  try {
    const taskPath = resolveTaskStatePath();
    let existing: { tasks?: unknown[] } = { tasks: [] };
    try {
      const content = fsSyncLike.readFileSync(taskPath, "utf-8");
      existing = JSON.parse(content) as { tasks?: unknown[] };
    } catch { /* file doesn't exist yet */ }
    const tasks = Array.isArray(existing.tasks) ? existing.tasks as RuntimeTaskStateRecord[] : [];
    const idx = tasks.findIndex((t) => asString(t.id) === asString(record.id));
    const entry: RuntimeTaskStateRecord = {
      ...record,
      updated_at: record.updated_at || new Date().toISOString(),
    };
    if (idx >= 0) {
      tasks[idx] = entry;
    } else {
      tasks.unshift(entry);
    }
    fsSyncLike.writeFileSync(taskPath, JSON.stringify({ tasks }, null, 2), "utf-8");
  } catch { /* best effort cache write */ }
}

export interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  params?: Record<string, unknown>;
  execute: (params: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface CommandRegistration {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  handler: (ctx: Record<string, unknown>) => Promise<void>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function nestedRecord(value: unknown, key: string): UnknownRecord {
  return asRecord(asRecord(value)[key]);
}

function asString(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function asNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseObjectJson(value: unknown): UnknownRecord {
  const text = asString(value);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parsePolicyDecisionJson(value: unknown): UnknownRecord | null {
  const parsed = parseObjectJson(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function isRouteSealCandidate(value: unknown): value is RouteSeal {
  const record = asRecord(value);
  return Object.keys(record).length > 0
    && (record.route === "reply" || record.route === "delegate")
    && typeof record.turnId === "string"
    && typeof record.threadBindingKey === "string"
    && typeof record.createdAt === "string";
}

function routeSealTurnId(metadata: UnknownRecord, fallback = ""): string {
  return asString(metadata.turnId ?? metadata.turn_id, fallback);
}

function routeSealThreadBindingKey(metadata: UnknownRecord, fallback = ""): string {
  return asString(metadata.threadBindingKey ?? metadata.thread_binding_key)
    || asString(metadata.session_binding_key)
    || asString(metadata.session_thread_key)
    || asString(metadata.session_key)
    || fallback;
}

export function validCachedRouteSeal(state: UnknownRecord | null, decision: UnknownRecord, metadata: UnknownRecord): RouteSeal | null {
  const stateRecord = asRecord(state);
  const requestMetadata = asRecord(asRecord(decision.request).metadata);
  const candidate = isRouteSealCandidate(stateRecord.routeSeal)
    ? stateRecord.routeSeal
    : isRouteSealCandidate(decision.routeSeal)
      ? decision.routeSeal
      : isRouteSealCandidate(requestMetadata.routeSeal)
        ? requestMetadata.routeSeal
        : null;
  if (!candidate) return null;
  const turnId = routeSealTurnId(metadata, candidate.turnId);
  const threadBindingKey = routeSealThreadBindingKey(metadata, candidate.threadBindingKey);
  return validateRouteSeal(candidate, turnId, threadBindingKey) ? candidate : null;
}

export function selectDispatchPolicyDecision(
  stateDecision: unknown,
  policyJsonDecision: unknown,
): UnknownRecord | null {
  const explicit = parsePolicyDecisionJson(policyJsonDecision);
  if (explicit) {
    return explicit;
  }
  return isRecord(stateDecision) ? stateDecision : null;
}

function selectRouteSealState(ctx: UnknownRecord, stateKey: string, state: UnknownRecord | null): UnknownRecord | null {
  if (state) {
    return state;
  }
  for (const rawKey of [stateKey, ctx.canonicalSessionKey, ctx.sessionKey, ctx.sessionId]) {
    const key = asString(rawKey);
    if (!key) continue;
    const candidate = policyState.get(key);
    if (candidate) {
      return candidate as UnknownRecord;
    }
  }
  return null;
}

export function selectReplaySessionKeyForDispatch(
  ctx: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord | null,
  decision: UnknownRecord,
  payload: UnknownRecord,
): string {
  return asString(
    resolveDispatchSessionKey(ctx, metadata, { stateKey, state, cachedDecision: decision })
    || metadata.session_key
    || asRecord(decision.request).session_key
    || asRecord(payload.job).session_key
    || payload.session_key
    || stateKey,
  );
}

function toolLogger(ctx: UnknownRecord): UnknownRecord {
  return asRecord(ctx.logger);
}

function toolResponse(summary: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: summary,
    json: details,
  };
}

function statusToolResponse(rawOutput: string, format: string): Record<string, unknown> {
  const text = [
    "OctoClaw raw status panel below. Return it verbatim to the user without summarizing or rewriting.",
    "```text",
    rawOutput,
    "```",
  ].join("\n");
  return {
    text,
    json: {
      format,
      source: "native_runtime",
      raw_output: rawOutput,
      return_verbatim: true,
    },
  };
}

function normalizeTaskActionFormat(format: string): "text" | "json" {
  return format === "text" ? "text" : "json";
}

function parseTaskAction(rawText: string): { action: string; taskId: string } {
  const [action = "", taskId = ""] = rawText.trim().split(/\s+/u);
  return {
    action: action.trim(),
    taskId: taskId.trim(),
  };
}

interface RuntimeTaskStateRecord extends UnknownRecord {
  id?: unknown;
  status?: unknown;
  summary?: unknown;
  route?: unknown;
  role?: unknown;
  session_key?: unknown;
  flow_id?: unknown;
  worker_pool?: unknown;
  updated_at?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  spawned_at?: unknown;
  report_path?: unknown;
  artifacts?: unknown;
}

async function readRuntimeTaskState(): Promise<RuntimeTaskStateRecord[]> {
  try {
    const fs = await import("node:fs");
    const content = fs.default.readFileSync(resolveTaskStatePath(), "utf-8");
    const parsed = JSON.parse(content) as { tasks?: unknown };
    return Array.isArray(parsed.tasks) ? parsed.tasks.filter(isRecord) as RuntimeTaskStateRecord[] : [];
  } catch {
    return [];
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

function buildTaskActionTimeline(record: RuntimeTaskStateRecord, liveRead: UnknownRecord, replayEvents: UnknownRecord[]): UnknownRecord[] {
  const timeline: UnknownRecord[] = [];
  const pushIfPresent = (eventType: string, eventAt: unknown, summary: string) => {
    const at = asString(eventAt);
    if (at) timeline.push({ eventType, eventAt: at, summary });
  };
  pushIfPresent("spawned", record.spawned_at, "Task was spawned");
  pushIfPresent("started", record.started_at, "Task started execution");
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

async function buildNativeTaskActionPayload(rawText: string, format: "text" | "json"): Promise<{ summary: string; payload: UnknownRecord }> {
  const { action, taskId } = parseTaskAction(rawText);
  const normalizedAction = action || "details";
  const tasks = sortTaskStateRecords(await readRuntimeTaskState());
  let record = (taskId ? tasks.find((entry) => asString(entry.id) === taskId) : tasks[0]) || null;
  let liveRead: NullRecord = null;
  let liveSessionKey = "";
  let liveFlowId = "";

  if (!record && taskId) {
    try {
      const plugin = createOctoClawRuntimePlugin();
      const adapter = plugin.createAdapter();
      const runtimeRecord = findRuntimeTaskInPolicyState(taskId);
      if (runtimeRecord) {
        liveSessionKey = asString(runtimeRecord.sessionKey);
        liveFlowId = asString(runtimeRecord.flowId);
        if (liveSessionKey && liveFlowId) {
          const binding = adapter.bindSession(liveSessionKey);
          const taskRead = binding.readTask(liveFlowId, taskId);
          if (taskRead?.found) {
            liveRead = taskRead;
            record = {
              id: taskId,
              flow_id: liveFlowId,
              session_key: liveSessionKey,
              route: "delegate",
              status: taskRead.substrateState || "unknown",
              summary: asString(taskRead.progressSummary),
              role: "",
              worker_pool: "",
            } as RuntimeTaskStateRecord;
          }
        }
      }
    } catch {
      // runtime query failed — fall through to not-found
    }
  }

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
  const plugin = createOctoClawRuntimePlugin();
  if (!liveRead) {
    liveRead = asString(record.session_key) && asString(record.flow_id)
      ? plugin.createAdapter().bindSession(asString(record.session_key)).readTask(asString(record.flow_id), asString(record.id))
      : null;
  }
  const replayEvents = await readRuntimeReplayTimeline(asString(record.id));
  const artifacts = asRecord(record.artifacts);
  const payload: UnknownRecord = {
    mode: "native_runtime",
    action: normalizedAction,
    taskId: asString(record.id),
    flowId: asString(record.flow_id || liveFlowId),
    sessionKey: asString(record.session_key || liveSessionKey),
    route: normalizeLiveRoute(record.route, "delegate"),
    role: asString(record.role, asString(asRecord(artifacts.runtime_truth).role)),
    status: asString(liveRead?.substrateState || record.status),
    progress: asString(liveRead?.progressSummary || record.summary),
    summary: asString(record.summary, asString(liveRead?.progressSummary || record.status)),
    workerPool: asString(record.worker_pool),
    syncMode: asString(liveRead?.syncMode),
    substrateRevision: liveRead?.substrateRevision,
    timeline: buildTaskActionTimeline(record, liveRead ?? {}, replayEvents),
    artifacts,
    reportPath: asString(record.report_path || artifacts.report_path),
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
        Array.isArray(payload.timeline) && payload.timeline.length > 0
          ? `Timeline:\n${(payload.timeline as UnknownRecord[]).map((event) => `- ${asString(event.eventAt)} ${asString(event.eventType)}: ${asString(event.summary)}`).join("\n")}`
          : "",
        Object.keys(artifacts).length > 0 ? `Artifacts: ${Object.keys(artifacts).join(", ")}` : "",
      ].filter(Boolean).join("\n");
  return { summary, payload };
}

async function buildNativeStatusOutput(format: string): Promise<string> {
  const normalizedFormat = format || "anchors";
  const tasks = sortTaskStateRecords(await readRuntimeTaskState());
  const taskIdsFromCache = new Set(tasks.map((entry) => asString(entry.id)));
  const runtimeTasks: { taskId: string; status: string; route: string; summary: string; updatedAt: string }[] = [];
  for (const { state } of policyState.entries()) {
    const decision = asRecord(state?.decision);
    const runtimeTruth = asRecord(decision.runtime_truth);
    const taskIds = taskIdsFromRuntimeTruth(runtimeTruth);
    const binding = asRecord(runtimeTruth.binding);
    const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
    const status = asString(
      delegateAttempt.status
      || binding.substrateState
      || binding.status
      || asRecord(runtimeTruth.recovery).status
      || "unknown",
    );
    const summary = asString(
      delegateAttempt.failureReason
      || delegateAttempt.status
      || asRecord(runtimeTruth.recovery).reason
      || "",
    );
    for (const taskId of taskIds) {
      if (!taskId || taskIdsFromCache.has(taskId)) {
        continue;
      }
      runtimeTasks.push({
        taskId,
        status,
        route: "delegate",
        summary,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  const allTasks = [
    ...tasks.map((task) => ({
      taskId: asString(task.id),
      status: asString(task.status),
      route: normalizeLiveRoute(task.route, "delegate"),
      summary: asString(task.summary),
      updatedAt: asString(task.updated_at),
    })),
    ...runtimeTasks,
  ];
  const lines = [
    `OctoClaw native runtime status (${normalizedFormat})`,
    `Active records: ${allTasks.length}`,
  ];
  for (const task of allTasks.slice(0, normalizedFormat === "anchors" ? 10 : 25)) {
    lines.push(`- ${task.taskId} | ${task.status} | ${task.route} | ${task.summary}`);
  }
  if (allTasks.length === 0) {
    lines.push("No runtime task state is currently available.");
  }
  return lines.join("\n");
}

function handoffText(payload: Record<string, unknown>, fallback: string): string {
  const handoff = asRecord(payload.handoff);
  if (handoff.user_safe === true && asString(handoff.reply_text)) {
    return asString(handoff.reply_text);
  }
  if (asString(handoff.summary)) {
    return asString(handoff.summary);
  }
  return fallback;
}

async function readReportExcerpt(reportPath: string, cwd?: string): Promise<Record<string, unknown>> {
  const resolvedPath = reportPath.startsWith("/")
    ? reportPath
    : `${asString(cwd, process.cwd()).replace(/\/$/u, "")}/${reportPath}`;
  return {
    exists: false,
    excerpt: "",
    path: resolvedPath,
    source: "native_runtime",
    note: "report excerpt preview is surfaced by native runtime consumers rather than this tool shim",
  };
}

async function userFacingHandoff(payload: Record<string, unknown>, fallback: string, cwd?: string): Promise<string> {
  const base = handoffText(payload, fallback);
  const handoff = asRecord(payload.handoff);
  const reportPath = asString(handoff.report_path ?? payload.report_path);
  const job = asRecord(payload.job);
  const taskId = asString(job.id ?? payload.task_id);
  if (!reportPath) {
    return base;
  }
  const artifactsCmd = taskId ? `octoclaw_task_action artifacts ${taskId}` : "octoclaw_task_action artifacts";
  try {
    const preview = await readReportExcerpt(reportPath, cwd);
    if (preview.exists === true && asString(preview.excerpt)) {
      return `${base}\n\n报告摘录：\n${asString(preview.excerpt)}\n\n结果已写入：\`${reportPath}\`\n（用 \`${artifactsCmd}\` 读取完整内容）`;
    }
  } catch {
    // Fall back to base handoff text.
  }
  return `${base}\n\n结果已写入：\`${reportPath}\`\n（用 \`${artifactsCmd}\` 读取完整内容）`;
}

function resolveToolPolicyContext(ctx: UnknownRecord, prompt = ""): { key: string; state: UnknownRecord | null } {
  const fromStore = asRecord(policyState.getToolPolicyContext(ctx, prompt));
  const contextKey = asString(fromStore.key);
  const contextState = isRecord(fromStore.state) ? fromStore.state : null;
  if (contextKey || contextState) {
    return { key: contextKey, state: contextState };
  }
  if (prompt) {
    const byPrompt = asRecord(policyState.findByPrompt(prompt));
    return {
      key: asString(byPrompt.key),
      state: isRecord(byPrompt.state) ? byPrompt.state : null,
    };
  }
  return { key: asString(resolvePolicyStateKey(ctx)), state: null };
}

function setPolicyStateForContext(ctx: UnknownRecord, entry: UnknownRecord, explicitKey = ""): string {
  const stateKey = asString(explicitKey || resolvePolicyStateKey(ctx));
  if (stateKey) {
    const normalized = isRecord(entry) && isRecord(entry.decision)
      ? { ...entry, decision: canonicalizeDecisionForPolicyState(entry.decision) }
      : entry;
    policyState.set(stateKey, normalized);
  }
  return stateKey;
}

function delegatedStickyRoute(decision: UnknownRecord): boolean {
  return authoritativeDecisionRoute(decision, "reply") === "delegate";
}

async function persistStickyLane(sessionKey: string, payload: UnknownRecord, logger: unknown, source: string): Promise<Record<string, unknown>> {
  const stickyPersisted = {
    persisted: Boolean(sessionKey),
    source,
    reason_codes: delegatedStickyRoute(payload) ? ["delegated_route"] : [],
  };
  if (sessionKey) {
    await recordPolicyReplay("sticky_lane_persisted", { sessionKey, source }, logger, payload);
  }
  return stickyPersisted;
}

function compactDispatchDetails(payload: UnknownRecord): UnknownRecord {
  return {
    route: asString(payload.route),
    status: asString(payload.status),
    executed: payload.executed === true,
    worker_pool: asString(payload.worker_pool),
    model: asString(payload.model),
    task_id: asString(payload.task_id ?? asRecord(payload.materialization).task_id),
    flow_id: asString(payload.flow_id ?? asRecord(payload.materialization).flow_id),
  };
}

function dispatchHonestySuccess(params: {
  route: string;
  workerPool: string;
  taskId: string;
  taskClass: string;
}): Record<string, unknown> {
  return toolResponse(JSON.stringify({
    ok: true,
    route: params.route,
    worker_pool: params.workerPool,
    task_id: params.taskId,
    task_class: params.taskClass,
    delegation_method: "octoclaw_dispatch",
  }), {
    ok: true,
    route: params.route,
    worker_pool: params.workerPool,
    task_id: params.taskId,
    task_class: params.taskClass,
    delegation_method: "octoclaw_dispatch",
  });
}

function dispatchHonestyFailure(params: {
  route?: string | null;
  error: string;
  sealMismatch?: boolean;
  retryable?: boolean;
  terminal?: boolean;
}): Record<string, unknown> {
  return toolResponse(JSON.stringify({
    ok: false,
    route: params.route ?? null,
    error: params.error,
    seal_mismatch: params.sealMismatch === true,
    retryable: params.retryable === true,
    terminal: params.terminal === true,
  }), {
    ok: false,
    route: params.route ?? null,
    error: params.error,
    seal_mismatch: params.sealMismatch === true,
    retryable: params.retryable === true,
    terminal: params.terminal === true,
  });
}

function ctxCwd(ctx: UnknownRecord): string {
  return asString(ctx.cwd, process.cwd());
}

function ctxUi(ctx: UnknownRecord): { notify?: (message: string, level?: string) => void; setEditorText?: (text: string) => void } {
  return asRecord(ctx.ui) as { notify?: (message: string, level?: string) => void; setEditorText?: (text: string) => void };
}

function hasUi(ctx: UnknownRecord): boolean {
  return ctx.hasUI === true;
}

function readHelperInvoker(...values: unknown[]): NativeHelperInvoker | null {
  for (const value of values) {
    if (typeof value === "function") {
      return value as NativeHelperInvoker;
    }
  }
  return null;
}

async function executeTaskAnchorCommand(rawText: string, format: string, cwd: string): Promise<{ summary: string; payload: UnknownRecord }> {
  void cwd;
  const parsed = parseTaskAction(rawText);
  if ((parsed.action || "details") === "details" && parsed.taskId) {
    checkActiveTaskRecovery({ taskId: parsed.taskId });
  }
  return buildNativeTaskActionPayload(rawText, normalizeTaskActionFormat(format));
}

export function getToolRegistrations(): ToolRegistration[] {
  return [
    {
      name: "octoclaw_route_hint",
      label: "OctoClaw Route Hint",
      description: "Submit a structured main-brain route hint so OctoClaw can merge it with system policy and return the final decision.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "Optional task override. Defaults to the current prompt for this session." },
          command: { type: "string", description: "Optional shell command context." },
          routeHint: { type: "string", enum: ["reply", "delegate"] },
          routeObjection: { type: "boolean", description: "Set true if you disagree with the recommended route" },
          objectionReason: { type: "string", description: "Required if routeObjection is true. Why you disagree." },
          requestedRoute: { type: "string", enum: ["reply", "delegate"], description: "The route you want instead. Required if routeObjection is true." },
          workType: { type: "string", enum: ["ops", "research", "code", "review"] },
          budgetBand: { type: "string", enum: ["low", "medium", "high"], description: "Override task complexity. low=fast/cheap model, medium=standard model, high=capable model." },
          phase: { type: "string", description: "Optional phase hint such as inspect, implement, collect, report, verify." },
          reviewRequired: { type: "boolean", description: "Whether review should be required after merge." },
          confidence: { type: "number", description: "Confidence from 0 to 1." },
          reason: { type: "string", description: "Short explanation for the route hint." },
        },
        required: ["routeHint"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const { key: existingStateKey, state: existing } = resolveToolPolicyContext(ctx, asString(params.task));
        const task = asString(params.task ?? existing?.prompt);
        if (!task) {
          return { error: "octoclaw_route_hint requires task context" };
        }
        const routeObjection = params.routeObjection === true;
        if (routeObjection && !asString(params.objectionReason)) {
          return { error: "octoclaw_route_hint requires objectionReason when routeObjection is true" };
        }
        if (routeObjection && !asString(params.requestedRoute)) {
          return { error: "octoclaw_route_hint requires requestedRoute when routeObjection is true" };
        }
        const existingDecision = nestedRecord(existing, "decision");
        const existingRequest = nestedRecord(existingDecision, "request");
        let metadata = buildPolicyMetadata(ctx, { stateKey: existingStateKey || asString(existingRequest.session_key) });
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey: existingStateKey, state: existing, cachedDecision: existingDecision });
        const replaySessionKey = asString(metadata.session_key || existingRequest.session_key || existingStateKey);
        const routeHintPayload = {
          route_hint: asString(params.routeHint),
          route_objection: routeObjection,
          objection_reason: asString(params.objectionReason),
          requested_route: asString(params.requestedRoute),
          work_type: asString(params.workType),
          phase: asString(params.phase),
          review_required: params.reviewRequired === true,
          confidence: asNumber(params.confidence) ?? 0,
          reason: asString(params.reason),
          source: "main_agent",
        };
        const payload = await resolveStatelessPolicyDecision(task, {
          command: asString(params.command),
          metadata,
          routeHint: routeHintPayload,
        });
        if (asString(params.budgetBand)) {
          payload._judge_budget_band = asString(params.budgetBand);
        }
        const judgeSucceeded = asRecord(payload)._judge_succeeded === true;
        const judgeRoute = asString(asRecord(payload)._judge_route || asRecord(asRecord(payload).route_decision).judge_route || asRecord(asRecord(payload).route_decision).system_preferred_route);
        if (routeObjection) {
          await recordPolicyReplay(
            "route_hint_objection",
            {
              route_objection: true,
              objection_reason: truncateText(params.objectionReason, 180),
              requested_route: asString(params.requestedRoute),
              judge_route: judgeRoute,
              session_key: replaySessionKey,
              tool_name: "route_hint",
              objection_accepted: !judgeSucceeded,
              judge_succeeded: judgeSucceeded,
            },
            toolLogger(ctx),
            payload,
          );
        }
        const stickyPersisted = await persistStickyLane(replaySessionKey, payload, toolLogger(ctx), "route_hint");
        const nextState = {
          ...(existing ?? {}),
          prompt: task,
          decision: payload,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          delegated: existing?.delegated === true,
          delegationTool: asString(existing?.delegationTool),
          blockedTools: Array.isArray(existing?.blockedTools) ? existing?.blockedTools : [],
          routeHintSubmitted: true,
          routeHintPayload,
        };
        setPolicyStateForContext(ctx, nextState, replaySessionKey || existingStateKey);
        if (existingStateKey && replaySessionKey && existingStateKey !== replaySessionKey) {
          setPolicyStateForContext(ctx, nextState, existingStateKey);
        }
        await recordPolicyReplay(
          "route_hint_submitted",
          {
            sessionKey: replaySessionKey,
            sessionId: asString(ctx.sessionId),
            routeHint: asString(params.routeHint),
            workType: asString(params.workType),
            phase: asString(params.phase),
            reviewRequired: params.reviewRequired === true,
            confidence: asNumber(params.confidence) ?? 0,
            reason: truncateText(params.reason, 180),
            routeObjection,
            objectionReason: truncateText(params.objectionReason, 180),
            requestedRoute: asString(params.requestedRoute),
            systemPreferredRoute: asString(asRecord(payload.route_decision).system_preferred_route),
            finalRoute: asString(asRecord(payload.route_decision).route),
            workerPool: asString(asRecord(payload.route_decision).worker_pool),
            stickyPersisted,
          },
          toolLogger(ctx),
          payload,
        );
        const finalRoute = asString(asRecord(payload.route_decision).route);
        const objectionMessage = routeObjection
          ? (finalRoute === asString(params.requestedRoute)
              ? "objection accepted, using your route"
              : "objection escalated to remote adjudication; using judge recommendation")
          : "";
        const nextSummaryBase = asString(asRecord(payload.route_decision).route) === "reply"
          ? "route_hint merged: final route is reply. You may answer directly."
          : `route_hint merged: final route is ${asString(asRecord(payload.route_decision).route, "delegate")}. Next call octoclaw_dispatch.`;
        const nextSummary = objectionMessage ? `${objectionMessage}; ${nextSummaryBase}` : nextSummaryBase;
        return toolResponse(nextSummary, payload);
      },
    },
    {
      name: "octoclaw_policy_decide",
      label: "OctoClaw Policy Decide",
      description: "Debug/parity helper that returns the structured OctoClaw runtime policy decision object, including route, model/profile, skill bundle, review policy, and hook interface hints.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify and route." },
          command: { type: "string", description: "Optional shell command if one already exists." },
          channel: { type: "string", description: "Optional transport/origin hint such as slack, wechat, webchat, or any other IM identifier." },
          sessionKey: { type: "string", description: "Optional main session key." },
          forceRoute: { type: "string", enum: ["reply", "delegate"] },
          metadataJson: { type: "string", description: "Optional JSON object with extra routing metadata." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        let metadata = applyUserMetadataOverrides(buildPolicyMetadata(ctx), parseObjectJson(params.metadataJson));
        if (asString(params.channel)) metadata.channel = asString(params.channel);
        if (asString(params.sessionKey)) metadata.session_key = asString(params.sessionKey);
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey: asString(params.sessionKey) });
        const payload = await resolveStatelessPolicyDecision(asString(params.task), {
          command: asString(params.command),
          metadata,
          forceRoute: asString(params.forceRoute),
        });
        const json = applyPhaseTwoLivePathPolicy({
          ...payload,
          managed_agent_context: isManagedAgentContext(ctx),
        });
        return toolResponse(policySummaryText(json), json);
      },
    },
    {
      name: "octoclaw_route",
      label: "OctoClaw Route",
      description: "Debug/parity helper that exposes the current Node-side route decision for a task.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify." },
          command: { type: "string", description: "Optional shell command if the task already includes one." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const payload = await resolveStatelessPolicyDecision(asString(params.task), {
          command: asString(params.command),
          metadata: buildPolicyMetadata(ctx),
        });
        return toolResponse(policySummaryText(payload), payload);
      },
    },
    {
      name: "octoclaw_dispatch",
      label: "OctoClaw Dispatch",
      description: "Run OctoClaw dispatch so reply or delegated work follows the runtime policy plan. Read-only observation uses delegate + observer role.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The task to dispatch." },
          command: { type: "string", description: "Optional shell command context for the routed task." },
          cwd: { type: "string", description: "Optional working directory override." },
          forceRoute: { type: "string", enum: ["auto", "reply", "delegate"] },
          complexityBand: { type: "string", enum: ["simple", "normal", "deep"], description: "Task complexity band. simple=light research/observer work, normal=GLM-5.1, deep=gpt-5.4" },
          expectedSeconds: { type: "number", description: "Main agent's estimate of how long this task should take. Used as timeout baseline." },
          timeoutSeconds: { type: "number", description: "Runner timeout in seconds." },
          sessionKey: { type: "string", description: "Optional session key override." },
          metadataJson: { type: "string", description: "Optional JSON object with extra session metadata." },
          policyJson: { type: "string", description: "Optional precomputed runtime policy decision JSON." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        let { key: stateKey, state } = resolveToolPolicyContext(ctx, asString(params.task));
        const hadCachedDecision = Boolean(params.policyJson || state?.decision);
        let cachedDecision = selectDispatchPolicyDecision(state?.decision, params.policyJson);
        let freshDecisionSource = "";
        if (!cachedDecision) {
          cachedDecision = await resolveStatelessPolicyDecision(asString(params.task), {
            command: asString(params.command),
            metadata: buildPolicyMetadata(ctx, { stateKey }),
            forceRoute: asString(params.forceRoute === "auto" ? "" : params.forceRoute),
          });
          freshDecisionSource = "fresh_context_resolve";
        }
        const initialMetadata = applyUserMetadataOverrides(
          {
            ...buildPolicyMetadata(ctx, { stateKey: stateKey || asString(asRecord(cachedDecision.request).session_key) }),
            ...(asString(params.sessionKey) ? { session_key: asString(params.sessionKey) } : {}),
          },
          parseObjectJson(params.metadataJson),
        );
        const managedSessionKey = asString(asRecord(cachedDecision.request).session_key || initialMetadata.session_key);
        const resolvedRoute = normalizeLiveRoute(params.forceRoute === "auto" ? "" : params.forceRoute || asRecord(cachedDecision.route_decision).route, "reply");
        const isDelegatedRoute = resolvedRoute === "delegate";
        const recordDispatchTerminalFailure = async (errorMessage: string, options: { sealMismatch?: boolean; route?: string | null } = {}) => {
          await recordPolicyReplay("dispatch_terminal_failure", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: options.route ?? resolvedRoute,
            error: errorMessage,
            sealMismatch: options.sealMismatch === true,
            retryable: false,
            terminal: true,
          }, toolLogger(ctx));
        };
        const routeSealState = selectRouteSealState(ctx, stateKey, state);
        const cachedRouteSeal = validCachedRouteSeal(routeSealState, cachedDecision, initialMetadata);
        if (!hadCachedDecision && isDelegatedRoute && managedSessionKey && !params.policyJson) {
          const driftSummary = `sealed_decision_required: managed session ${managedSessionKey.slice(0, 40)}… requires cached/passed policy for delegated route=${resolvedRoute}; got fresh decision from freeform prompt (source=${freshDecisionSource}). This violates §4.6.1 (dispatch must not re-judge).`;
          await recordPolicyReplay("sealed_decision_required", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            freshDecisionSource,
            hadCachedDecision: false,
            policyJsonProvided: false,
          }, toolLogger(ctx));
          await recordDispatchTerminalFailure(driftSummary);
          return dispatchHonestyFailure({
            route: resolvedRoute,
            error: driftSummary,
            sealMismatch: false,
            retryable: false,
            terminal: true,
          });
        }
        if (cachedRouteSeal && resolvedRoute !== cachedRouteSeal.route) {
          const driftSummary = `sealed_decision_required: managed session ${managedSessionKey.slice(0, 40)}… requires sealed route=${cachedRouteSeal.route}; got dispatch route=${resolvedRoute}. This violates §4.6.1 (dispatch must not re-route after seal).`;
          await recordPolicyReplay("sealed_decision_required", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            sealedRoute: cachedRouteSeal.route,
            hadCachedDecision,
            policyJsonProvided: Boolean(params.policyJson),
          }, toolLogger(ctx), cachedDecision);
          await recordDispatchTerminalFailure(driftSummary, { sealMismatch: true });
          return dispatchHonestyFailure({
            route: resolvedRoute,
            error: driftSummary,
            sealMismatch: true,
            retryable: false,
            terminal: true,
          });
        }
        let metadata = initialMetadata;
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey, state, cachedDecision });
        metadata.requested_route = normalizeLiveRoute(resolvedRoute, "reply");

        const complexityBand = asString(params.complexityBand || asRecord(cachedDecision)._judge_complexity_band || asRecord(asRecord(cachedDecision).route_decision)._judge_complexity_band);
        const budgetBand = asString(asRecord(cachedDecision._judge_budget_band ?? asRecord(cachedDecision.route_decision)._judge_budget_band));
        const complexityModelMap: Record<string, string> = {
          simple: "minimax-portal/MiniMax-M2.7-highspeed",
          medium: "zhipu/GLM-5.1",
          normal: "zhipu/GLM-5.1",
          deep: "omniroute/cx/gpt-5.4",
        };
        const budgetModelMap: Record<string, string> = {
          high: "cliproxyapi/gpt-5.4",
          medium: "zhipu/GLM-5.1",
          low: "minimax-portal/MiniMax-M2.7-highspeed",
        };
        const selectedModel = complexityBand && complexityModelMap[complexityBand]
          ? complexityModelMap[complexityBand]
          : budgetBand && budgetModelMap[budgetBand]
            ? budgetModelMap[budgetBand]
            : "";
        if (complexityBand) {
          metadata.complexity_band = complexityBand;
        }
        if (selectedModel) {
          metadata.model = selectedModel;
        }

        const expectedSeconds = asNumber(params.expectedSeconds) || 0;
        if (expectedSeconds > 0) {
          metadata.expected_seconds = expectedSeconds;
          metadata.expected_at = Date.now() + expectedSeconds * 1000;
        }

        const helperInvoker = readHelperInvoker(asRecord(metadata).helperInvoker, ctx.helperInvoker);

        if (isDelegatedRoute) {
          // Preflight checks the execution backend that dispatch will use. The helperInvoker path
          // is a native execution path, so only probe the dist taskflow port when dispatch will use it.
          if (!helperInvoker) {
            const taskflowCheck = await checkTaskflowCapability(createOpenClawDistTaskFlowPort());
            if (!taskflowCheck.available) {
              const errorMessage = `taskflow_unavailable: ${taskflowCheck.reason || "unknown_error"}`;
              await recordPolicyReplay("dispatch_capability_failure", {
                sessionKey: managedSessionKey,
                sessionId: asString(ctx.sessionId),
                route: resolvedRoute,
                error: errorMessage,
                retryable: false,
                terminal: true,
              }, toolLogger(ctx));
              await recordDispatchTerminalFailure(errorMessage);
              return dispatchHonestyFailure({
                route: resolvedRoute,
                error: errorMessage,
                retryable: false,
                terminal: true,
              });
            }
          }
        }

        let payload: UnknownRecord;
        try {
          payload = buildTsRuntimeDispatchPayload({
            task: asString(params.task),
            command: asString(params.command),
            cwd: asString(params.cwd, ctxCwd(ctx)),
            decision: cachedDecision,
            metadata,
            timeoutSeconds: asNumber(params.timeoutSeconds) ?? undefined,
            helperInvoker,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const candidate = asRecord(error);
          payload = isRecord(candidate.payload) ? asRecord(candidate.payload) : {};
          if (Object.keys(payload).length === 0) {
            await recordDispatchTerminalFailure(errorMessage);
            return dispatchHonestyFailure({
              route: resolvedRoute,
              error: errorMessage,
              sealMismatch: false,
              retryable: true,
            });
          }
          await recordDispatchTerminalFailure(errorMessage, { route: asString(payload.route, resolvedRoute) });
          return dispatchHonestyFailure({
            route: asString(payload.route, resolvedRoute),
            error: errorMessage,
            sealMismatch: false,
            retryable: true,
          });
        }
        const authoritativeDecision = asRecord(payload.policy_decision ?? cachedDecision);
        const replaySessionKey = selectReplaySessionKeyForDispatch(
          ctx,
          metadata,
          stateKey,
          state,
          authoritativeDecision,
          payload,
        );
        const stickyDecision = delegatedStickyRoute(authoritativeDecision)
          ? authoritativeDecision
          : {
              route_decision: {
                route: asString(payload.route),
                system_preferred_route: asString(payload.system_preferred_route ?? payload.route),
                work_type: asString(payload.work_type),
                phase: asString(payload.phase),
                protocol: asString(payload.protocol),
              },
            };
        const stickyPersisted = await persistStickyLane(replaySessionKey, stickyDecision, toolLogger(ctx), "dispatch");
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw dispatch: ${asString(payload.route)}${payload.executed === true ? " (executed)" : " (planned)"}`,
          ctxCwd(ctx),
        );
        const delegateReasonCodes = Array.isArray(asRecord(authoritativeDecision)._delegate_reason_codes)
          ? (asRecord(authoritativeDecision)._delegate_reason_codes as unknown[]).map((value) => asString(value)).filter(Boolean)
          : [];
        await registerPendingDelivery({
          decision: authoritativeDecision,
          payload,
          summary,
          sessionKey: replaySessionKey,
          stateKey,
          logger: toolLogger(ctx),
        });
        await recordDispatchLifecycleReplayEvents({
          decision: authoritativeDecision,
          payload,
          sessionKey: replaySessionKey,
          sessionId: asString(ctx.sessionId),
          logger: toolLogger(ctx),
        });
        const sessionBoundary = detectSessionBoundary(ctx);
        await recordPolicyReplay(
          "dispatch_called",
          {
            sessionKey: replaySessionKey,
            sessionId: asString(ctx.sessionId),
            route: asString(asRecord(authoritativeDecision.route_decision).route || payload.route),
            systemPreferredRoute: asString(asRecord(authoritativeDecision.route_decision).system_preferred_route || payload.system_preferred_route),
            workerPool: asString(asRecord(authoritativeDecision.route_decision).worker_pool || payload.worker_pool),
            executed: payload.executed === true,
            usedCachedPolicy: hadCachedDecision,
            originalRoute: asString(asRecord(cachedDecision.route_decision).route || params.forceRoute),
            routeChanged: asString(asRecord(cachedDecision.route_decision).route) !== asString(payload.route),
            decisionSource: hadCachedDecision ? "cached" : (params.policyJson ? "policy_json" : freshDecisionSource || "fresh"),
            stickyPersisted,
            complexityBand,
            delegateReasonCodes,
            sessionBoundaryStatus: asString(sessionBoundary.status),
            canonicalSessionKey: asString(sessionBoundary.canonicalSessionKey || replaySessionKey),
          },
          toolLogger(ctx),
          authoritativeDecision,
        );
        if (!stateKey) {
          stateKey = asString(metadata.session_key, stableId("policy", [asString(params.task), asString(ctx.sessionId)]));
        }
        const nextState = {
          ...(state ?? {}),
          prompt: asString(params.task),
          decision: authoritativeDecision,
          delegated: asString(payload.route) === "delegate",
          dispatchRoute: asString(payload.route),
          dispatchStatus: asString(payload.status),
          dispatchExecuted: payload.executed === true,
          updatedAt: Date.now(),
        };
        setPolicyStateForContext(ctx, nextState, replaySessionKey || stateKey);
        if (stateKey && replaySessionKey && stateKey !== replaySessionKey) {
          setPolicyStateForContext(ctx, nextState, stateKey);
        }
        const materialization = asRecord(payload.materialization);
        if (asString(materialization.task_id)) {
          const substrateState = asString(materialization.substrate_state, payload.executed === true ? "running" : "queued");
          const startedAt = substrateState === "queued" || substrateState === "planned"
            ? ""
            : new Date().toISOString();
          await upsertTaskStateCache({
            id: materialization.task_id,
            flow_id: asString(materialization.flow_id),
            session_key: replaySessionKey,
            route: asString(payload.route),
            status: substrateState,
            summary: asString(asRecord(payload.handoff).summary || payload.summary),
            role: asString(asRecord(authoritativeDecision.route_decision).task_class),
            worker_pool: asString(asRecord(authoritativeDecision.route_decision).worker_pool),
            model: selectedModel || asString(metadata.model),
            spawned_at: new Date().toISOString(),
            started_at: startedAt || undefined,
            updated_at: new Date().toISOString(),
          } as RuntimeTaskStateRecord);
        }
        void summary;
        void compactDispatchDetails;
        const finalRoute = normalizeLiveRoute(payload.route, resolvedRoute);
        const finalDecisionRoute = asRecord(authoritativeDecision.route_decision);
        const workerPool = asString(finalDecisionRoute.worker_pool || payload.worker_pool);
        const delegateTaskId = asString(payload.delegateTaskId || materialization.delegateTaskId || materialization.task_id || payload.task_id);
        const taskClass = asString(finalDecisionRoute.task_class || finalDecisionRoute.judge_role || finalDecisionRoute.role);
        return dispatchHonestySuccess({
          route: finalRoute,
          workerPool,
          taskId: delegateTaskId,
          taskClass,
        });
      },
    },
    {
      name: "octoclaw_spawn",
      label: "OctoClaw Spawn",
      description: "Generate and register a validated OctoClaw spawn task. Use this instead of hand-writing sessions_spawn arguments.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The task to run in a subagent." },
          route: { type: "string", enum: ["delegate"] },
          model: { type: "string", description: "Optional model override." },
          complexityBand: { type: "string", enum: ["simple", "normal", "deep"], description: "Task complexity band. simple=light research/observer work, normal=GLM-5.1, deep=gpt-5.4" },
          runtime: { type: "string", enum: ["subagent", "acp"] },
          streamTo: { type: "string", description: "Only valid when runtime=acp." },
          parentId: { type: "string", description: "Optional parent task id." },
          sessionKey: { type: "string", description: "Optional parent session key." },
          metadataJson: { type: "string", description: "Optional JSON object with extra session metadata." },
          execute: { type: "boolean", description: "Whether to immediately execute spawn via ClawTeam when enabled." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const { key: existingStateKey, state: existingState } = resolveToolPolicyContext(ctx, asString(params.task));
        const parentDecision = asRecord(existingState?.decision);
        const parentRoute = asString(asRecord(parentDecision.route_decision).route);
        const parentSessionKey = asString(asRecord(parentDecision.request).session_key);
        if (Object.keys(parentDecision).length > 0 && parentRoute === "delegate" && asString(asRecord(parentDecision.route_decision).judge_role) === "observer_probe" && asString(params.route) === "delegate") {
          return toolResponse(
            "sealed_route_violation: parent route is delegate with observer role, cannot reroute this observer workflow. This violates §4.6.1.",
            { sealed_route_violation: true, parent_route: "delegate", parent_role: "observer_probe", attempted_route: "delegate", error: "freeform_reroute_blocked" },
          );
        }
        const existingDecision = nestedRecord(existingState, "decision");
        const existingRequest = nestedRecord(existingDecision, "request");
        let metadata = { ...buildPolicyMetadata(ctx, { stateKey: existingStateKey || parentSessionKey || asString(existingRequest.session_key) }) };
        if (asString(params.sessionKey)) metadata.session_key = asString(params.sessionKey);
        if (!metadata.session_key && parentSessionKey) metadata.session_key = parentSessionKey;
        metadata = applyUserMetadataOverrides(metadata, parseObjectJson(params.metadataJson));
        metadata = finalizeDispatchMetadata(ctx, metadata, {
          stateKey: existingStateKey,
          state: existingState,
          cachedDecision: existingState?.decision,
        });
        const complexityBand = asString(params.complexityBand || asRecord(existingState?.decision)._judge_complexity_band || asRecord(asRecord(existingState?.decision).route_decision)._judge_complexity_band);
        const budgetBand = asString(asRecord(existingState?.decision)._judge_budget_band || asRecord(asRecord(existingState?.decision).route_decision)._judge_budget_band);
        const complexityModelMap: Record<string, string> = {
          simple: "minimax-portal/MiniMax-M2.7-highspeed",
          normal: "zhipu/GLM-5.1",
          deep: "omniroute/cx/gpt-5.4",
        };
        const budgetModelMap: Record<string, string> = {
          high: "cliproxyapi/gpt-5.4",
          medium: "zhipu/GLM-5.1",
          low: "minimax-portal/MiniMax-M2.7-highspeed",
        };
        const resolvedModel = asString(params.model) || (complexityBand && complexityModelMap[complexityBand]) || (budgetBand && budgetModelMap[budgetBand]) || "";
        if (complexityBand) {
          metadata.complexity_band = complexityBand;
        }
        let payload: UnknownRecord;
        try {
          payload = buildTsRuntimeSpawnPayload({
            task: asString(params.task),
            route: asString(params.route, "delegate"),
            decision: existingState?.decision as UnknownRecord | undefined,
            metadata: {
              ...metadata,
              model: resolvedModel,
              runtime: asString(params.runtime),
              stream_to: asString(params.streamTo),
              parent_id: asString(params.parentId),
            },
            helperInvoker: readHelperInvoker(asRecord(metadata).helperInvoker, ctx.helperInvoker),
            execute: params.execute === true,
          });
        } catch (error) {
          const candidate = asRecord(error);
          payload = isRecord(candidate.payload) ? asRecord(candidate.payload) : {};
          if (Object.keys(payload).length === 0) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        }
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw spawn registered: ${asString(payload.worker_pool || payload.route)} / ${asString(payload.model)}`,
          ctxCwd(ctx),
        );
        return toolResponse(summary, compactDispatchDetails(payload));
      },
    },
    {
      name: "octoclaw_task_action",
      label: "OctoClaw Task Action",
      description: "Handle task anchor fallback commands like details, queue, artifacts, stop, retry, approve, and reject.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Fallback command text such as 'details task-123' or 'queue'." },
          action: { type: "string", enum: ["details", "queue", "artifacts", "stop", "retry", "approve", "reject", "view", "detail"] },
          taskId: { type: "string", description: "Task id for task-scoped actions." },
          format: { type: "string", enum: ["text", "json"] },
        },
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const action = asString(params.action);
        const taskId = asString(params.taskId);
        const rawText = asString(params.text) || [action, taskId].filter(Boolean).join(" ").trim();
        if (!rawText) {
          return { error: "octoclaw_task_action requires either text or action/taskId" };
        }
        const format = asString(params.format, "json");
        const result = await executeTaskAnchorCommand(rawText, format, ctxCwd(ctx));
        return toolResponse(result.summary, result.payload);
      },
    },
    {
      name: "octoclaw_status",
      label: "OctoClaw Status",
      description: "Show current OctoClaw task state. Default to task anchors; use compact/table/lanes only when the user explicitly asks for those legacy views.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          format: { type: "string", enum: ["anchors", "compact", "table", "lanes"] },
        },
      },
      execute: async (params) => {
        const format = asString(params.format, "anchors");
        checkActiveTaskRecovery();
        const output = await buildNativeStatusOutput(format);
        return statusToolResponse(output, format);
      },
    },
  ];
}

export function getCommandRegistrations(): CommandRegistration[] {
  return [
    {
      name: "octotask",
      description: "Run an OctoClaw task anchor fallback command such as details <task_id> or queue",
      acceptsArgs: true,
      handler: async (ctx) => {
        const commandText = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!commandText) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octotask <details|queue|artifacts|stop|retry|approve|reject> [task_id]", "error");
          return;
        }
        const result = await executeTaskAnchorCommand(commandText, "text", ctxCwd(ctx));
        if (hasUi(ctx)) {
          ui.setEditorText?.(result.summary);
          ui.notify?.("OctoClaw task action completed", "info");
        }
      },
    },
    {
      name: "octostatus",
      description: "Show OctoClaw status; default task anchors, with compact/table/lanes available when explicitly requested",
      acceptsArgs: true,
      handler: async (ctx) => {
        const format = asString(ctx.args, "anchors");
        const output = await buildNativeStatusOutput(format);
        const ui = ctxUi(ctx);
        if (hasUi(ctx)) {
          ui.notify?.(`OctoClaw status (${format})`);
          ui.setEditorText?.(output);
        }
      },
    },
    {
      name: "octoroute",
      description: "Show the current Node-side OctoClaw route decision for a task",
      acceptsArgs: true,
      handler: async (ctx) => {
        const task = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!task) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octoroute <task>", "error");
          return;
        }
        const payload = await resolveStatelessPolicyDecision(task, { metadata: buildPolicyMetadata(ctx) });
        if (hasUi(ctx)) {
          ui.setEditorText?.(JSON.stringify(payload, null, 2));
          ui.notify?.(policySummaryText(payload));
        }
      },
    },
    {
      name: "octopolicy",
      description: "Show the structured OctoClaw runtime policy decision for a task",
      acceptsArgs: true,
      handler: async (ctx) => {
        const task = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!task) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octopolicy <task>", "error");
          return;
        }
        const payload = await resolveStatelessPolicyDecision(task, { metadata: buildPolicyMetadata(ctx) });
        if (hasUi(ctx)) {
          ui.setEditorText?.(JSON.stringify(payload, null, 2));
          ui.notify?.(policySummaryText(payload));
        }
      },
    },
    {
      name: "octospawn",
      description: "Register a validated OctoClaw spawn task",
      acceptsArgs: true,
      handler: async (ctx) => {
        const task = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!task) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octospawn <task>", "error");
          return;
        }
        let payload: UnknownRecord;
        try {
          payload = buildTsRuntimeSpawnPayload({
            task,
              route: "delegate",
            decision: {},
            metadata: buildPolicyMetadata(ctx),
          });
        } catch (error) {
          const candidate = asRecord(error);
          if (!isRecord(candidate.payload)) {
            throw error;
          }
          payload = asRecord(candidate.payload);
        }
        const workflowDecision = buildDecision(task, payload.policy_decision as UnknownRecord | undefined, buildPolicyMetadata(ctx));
        if (hasUi(ctx)) {
          ui.setEditorText?.(JSON.stringify({ ...payload, workflow_decision: workflowDecision }, null, 2));
          ui.notify?.(`OctoClaw spawn registered: ${asString(payload.task_id)}`);
        }
      },
    },
  ];
}
