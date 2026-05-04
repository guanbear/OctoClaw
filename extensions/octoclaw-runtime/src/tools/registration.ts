import {
  buildDecision,
  buildTsRuntimeDispatchPayload,
  buildTsRuntimeSpawnPayload,
  checkActiveTaskRecovery,
  resolveStatelessPolicyDecision,
} from "../resolve/policy-resolver.js";
import {
  envOverrides,
  resolveReplayLogPath,
  resolveWorkspaceRoot,
  resolveWorkerCompletionPath,
  stableId,
  truncateText,
} from "../resolve/env.js";
import { buildDelegateHandoffPacket } from "../context/delegate-packets.js";
import {
  pruneTaskStateCache,
  readArchivedTaskState,
} from "../state/task-state-retention.js";
import {
  readTaskStateRecords,
  upsertTaskStateRecord,
  type TaskStateRecord,
} from "../state/task-state-store.js";
import {
  type NativeHelperInvoker,
} from "../adapter/native-helper.js";
import {
  applyUserMetadataOverrides,
  buildPolicyMetadata,
  detectSessionBoundary,
  finalizeDispatchMetadata,
  isDispatchableUserSessionKey,
  isManagedAgentContext,
  resolveDispatchSessionKey,
  resolvePolicyStateKey,
  resolvePolicyStateKeys,
} from "../resolve/session.js";
import { policySummaryText } from "../replay/policy-utils.js";
import {
  recordDispatchLifecycleReplayEvents,
  recordPolicyReplay,
} from "../replay/replay.js";
import { policyState } from "../state/policy-state.js";
import { projectNativeStatus, type NativeStatusProjection, type NativeStatusProjectorInput } from "../state/native-status-projector.js";
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
import type { NativeBindingRef, NativeFlowStatus, WorkContract } from "@octoclaw/contracts/work-contract";
import { compactWorkContractView } from "@octoclaw/contracts/work-contract";
import { loadWorkContract } from "../work-contract/store.js";
import { materializeWorkContractSuccess, materializeWorkContractFailure } from "../work-contract/materializer.js";
import { markChildSessionPreferred, selectPreferredChildSession } from "../work-contract/continuity.js";
import { emitExecutionTransitionNotification } from "../ack/execution-transition-notifier.js";
import { scheduleChildCompletionFinalizer } from "../delegate/child-finalizer.js";
import { createCompletionBinding } from "../runtime-ledger/completion-binding.js";
import { randomUUID } from "node:crypto";
import { isPlannerAllowedForSession, resolveSpawnBackend, resolveSpawnIntentTtlMs } from "../config/index.js";
import { confirmNativeSpawn } from "../delegate/native-spawn-confirm.js";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { getModelMap } from "../model-map.js";
import { detectIMType, buildSlackStatusOutput, type StatusTaskSummary } from "../im-status-renderer.js";
import { buildDelegationTicketDryRun } from "../runtime-ledger/ticket-dry-run.js";
import { admitDelegationTicketForDispatch } from "../runtime-ledger/ticket-enforcement.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import { isSchedulerEnabled } from "../runtime-ledger/feature-flags.js";
import { resolveRuntimeLedgerMode } from "../runtime-ledger/shadow.js";
import { performCrashRecovery } from "../runtime-ledger/crash-recovery.js";
import {
  materializeNativeIds,
  promoteToQueued,
  releaseOrComplete,
  resolveSchedulerConfig,
  tryAcquireLease,
} from "../runtime-ledger/scheduler.js";
type UnknownRecord = Record<string, unknown>;
type NullRecord = UnknownRecord | null;

export interface OpenClawSubagentRuntime {
  run(params: {
    sessionKey: string;
    message: string;
    deliver?: boolean;
    provider?: string;
    model?: string;
    extraSystemPrompt?: string;
    lane?: string;
    idempotencyKey?: string;
  }): Promise<{ runId?: string }>;
}

export interface ToolRegistrationOptions {
  subagentRuntime?: OpenClawSubagentRuntime | null;
  judgeFastRaw?: UnknownRecord;
  delegationEnabled?: boolean;
}

function isSyntheticTestTaskState(record: RuntimeTaskStateRecord): boolean {
  const id = asString(record.id);
  const flowId = asString(record.flow_id);
  const sessionKey = asString(record.session_key);
  const summary = asString(record.summary);
  return id === "task-honesty"
    || id === "task-no-spawn"
    || id === "task-spawned"
    || flowId === "flow-honesty"
    || flowId === "flow-no-spawn"
    || flowId === "flow-spawned"
    || sessionKey.startsWith("session-dispatch-honesty")
    || sessionKey === "session-dispatch-spawned-test"
    || sessionKey === "session-work-contract-prior-continuity"
    || sessionKey === "session-contract-wins"
    || summary.includes("Dispatch from sealed WorkContract");
}

async function upsertTaskStateCache(record: RuntimeTaskStateRecord): Promise<void> {
  try {
    if (!envOverrides.workspaceRoot && isSyntheticTestTaskState(record)) return;
    upsertTaskStateRecord(record);
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

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function explicitBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function hasExplicitTrue(values: unknown[]): boolean {
  return values.some((value) => explicitBoolean(value) === true);
}

function hasExplicitFalse(values: unknown[]): boolean {
  return values.some((value) => explicitBoolean(value) === false);
}

function asNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return undefined;
}

function optionalReplyTargetId(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text && text !== "0" && text !== "0.0" && text.toLowerCase() !== "root") return text;
  }
  return undefined;
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
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter(Boolean) : [];
}

function sealedReplyBlocksDelegateHint(decision: UnknownRecord, requestedRoute: string, routeObjection: boolean): boolean {
  if (normalizeLiveRoute(requestedRoute, "reply") !== "delegate" || routeObjection) return false;
  const route = authoritativeDecisionRoute(decision, "reply");
  if (route !== "reply") return false;
  const workContract = asRecord(decision.work_contract);
  const replyContract = asRecord(decision.replyContract ?? decision.reply_contract);
  const toolPolicy = asRecord(decision.tool_policy);
  const forbidden = new Set([
    ...stringArray(toolPolicy.block_tool_patterns),
    ...stringArray(workContract.forbiddenTools ?? workContract.forbidden_tools),
    ...stringArray(replyContract.forbiddenTools),
    ...stringArray(replyContract.forbidden_tools),
  ]);
  return asString(workContract.route) === "reply"
    || (forbidden.has("octoclaw_dispatch") && forbidden.has("spawn"));
}

function sealedReplyRouteHintPayload(decision: UnknownRecord, routeHintPayload: UnknownRecord): UnknownRecord {
  const routeDecision = asRecord(decision.route_decision);
  const request = asRecord(decision.request);
  const metadata = asRecord(request.metadata);
  const routeHintPolicy = asRecord(decision.route_hint_policy);
  return canonicalizeDecisionForPolicyState({
    ...decision,
    request: {
      ...request,
      metadata: {
        ...metadata,
        route_hint_payload: routeHintPayload,
        route_hint_blocked_by_sealed_work_contract: true,
      },
    },
    route_decision: {
      ...routeDecision,
      route: "reply",
      system_preferred_route: "reply",
      dispatch_required: false,
      reason_codes: Array.from(new Set([
        ...stringArray(routeDecision.reason_codes),
        "route_hint_blocked_by_sealed_work_contract",
      ])),
    },
    route_hint_policy: {
      ...routeHintPolicy,
      submitted: true,
      advisory_only: true,
      blocked_by_sealed_work_contract: true,
      blocked_requested_route: "delegate",
      source: asString(routeHintPayload.source, "main_agent"),
    },
  });
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

function isBudgetedMainDispatchEscalationAllowed(input: {
  cachedRouteSeal: RouteSeal;
  cachedDecision: UnknownRecord;
  resolvedRoute: string;
  hadCachedDecision: boolean;
  routeSealState: UnknownRecord | null;
}): boolean {
  if (!input.hadCachedDecision || !input.routeSealState) return false;
  if (input.cachedRouteSeal.route !== "reply" || input.resolvedRoute !== "delegate") return false;
  const routeDecision = asRecord(input.cachedDecision.route_decision);
  const startupCostPolicy = asRecord(routeDecision.startup_cost_policy || input.cachedDecision._startup_cost_policy);
  const decisionBucket = asString(
    routeDecision.decision_bucket
    || input.cachedDecision._decision_bucket
    || startupCostPolicy.decision_bucket,
  );
  if (decisionBucket !== "budgeted_main_then_delegate") return false;
  return input.cachedDecision._budgeted_main_escalated === true
    || routeDecision.route_source === "budgeted_main_escalation"
    || routeDecision.dispatch_required === true;
}

function dispatchPlannerSessionCandidates(...values: unknown[]): string[] {
  const candidates = new Set<string>();
  for (const value of values) {
    const key = asString(value);
    if (!key) continue;
    candidates.add(key);
    const threadIndex = key.indexOf(":thread:");
    if (threadIndex > 0) {
      candidates.add(key.slice(0, threadIndex));
    }
  }
  return Array.from(candidates);
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

function selectDispatchWorkContractId(params: UnknownRecord, decision: UnknownRecord | null): string {
  const decisionRecord = asRecord(decision);
  return asString(params.workContractId)
    || asString(decisionRecord.workContractId)
    || asString(asRecord(decisionRecord.work_contract).workContractId);
}

function decisionFromWorkContract(contract: WorkContract, baseDecision: UnknownRecord | null): UnknownRecord {
  const base = asRecord(baseDecision);
  const routeDecision = asRecord(base.route_decision);
  const toolPolicy = asRecord(base.tool_policy);
  const routerDecision = asRecord(base.router_decision_v2);
  const request = asRecord(base.request);
  const route = contract.route;
  return canonicalizeDecisionForPolicyState({
    ...base,
    route,
    workContractId: contract.workContractId,
    work_contract: compactWorkContractView(contract),
    request: {
      ...request,
      session_key: asString(request.session_key, contract.sessionKey),
    },
    route_decision: {
      ...routeDecision,
      route,
      system_preferred_route: route,
      task_class: route === "delegate"
        ? asString(routeDecision.task_class, contract.delegate?.role || "delegated_single")
        : asString(routeDecision.task_class, "main_direct"),
      dispatch_required: route === "delegate",
      reason_codes: Array.isArray(routeDecision.reason_codes)
        ? routeDecision.reason_codes
        : contract.decision.reasonCodes,
    },
    tool_policy: {
      ...toolPolicy,
      must_delegate_via: route === "delegate" ? asString(toolPolicy.must_delegate_via, "octoclaw_dispatch") : "",
      delegate_first: route === "delegate",
    },
    router_decision_v2: {
      ...routerDecision,
      request_kind: route === "delegate" ? "delegated_task" : asString(routerDecision.request_kind, "reply"),
    },
  });
}

function validateDispatchWorkContract(contract: WorkContract | null, workContractId: string): { ok: true; contract: WorkContract } | { ok: false; route: string; error: string } {
  if (!contract) {
    return { ok: false, route: "delegate", error: `work_contract_not_found:${workContractId}` };
  }
  if (contract.status !== "sealed") {
    return { ok: false, route: contract.route, error: `work_contract_not_sealed:${workContractId}:${contract.status}` };
  }
  if (contract.route !== "delegate") {
    return { ok: false, route: contract.route, error: `work_contract_route_not_dispatchable:${workContractId}:${contract.route}` };
  }
  return { ok: true, contract };
}

function confirmedNativePlannerRefs(contract: WorkContract | null): {
  runId: string;
  childRunId: string;
  childSessionKey: string;
  spawnIntentId: string;
} | null {
  if (!contract) return null;
  const refs = asRecord(contract.nativeSpawnRefs);
  const telemetry = asRecord(contract.telemetry);
  const spawnBackend = asString(refs.spawnBackend);
  const runId = asString(refs.openclawRunId || telemetry.openclawRunId);
  if (spawnBackend !== "sessions_spawn_planner" || !runId) return null;
  return {
    runId,
    childRunId: asString(refs.childRunId || telemetry.childRunId || runId),
    childSessionKey: asString(refs.childSessionKey || telemetry.childSessionKey),
    spawnIntentId: asString(refs.spawnIntentId),
  };
}

function nativePlannerAlreadyStartedResponse(params: {
  workContract: WorkContract;
  refs: NonNullable<ReturnType<typeof confirmedNativePlannerRefs>>;
  workerPool: string;
  model: string;
}): Record<string, unknown> {
  const delegateTaskId = asString(params.workContract.delegate?.delegateTaskId);
  const attemptId = asString(params.workContract.delegate?.currentAttemptId);
  const body = {
    ok: true,
    route: "delegate",
    status: "already_started",
    delegation_method: "octoclaw_dispatch_planner",
    work_contract_id: params.workContract.workContractId,
    workContractId: params.workContract.workContractId,
    delegate_task_id: delegateTaskId || null,
    delegateTaskId: delegateTaskId || null,
    attempt_id: attemptId || null,
    attemptId: attemptId || null,
    spawn_intent_id: params.refs.spawnIntentId || null,
    spawnIntentId: params.refs.spawnIntentId || null,
    run_id: params.refs.runId,
    runId: params.refs.runId,
    child_run_id: params.refs.childRunId || params.refs.runId,
    childRunId: params.refs.childRunId || params.refs.runId,
    child_session_key: params.refs.childSessionKey || null,
    childSessionKey: params.refs.childSessionKey || null,
    worker_pool: params.workerPool,
    model: params.model,
    dispatch_executed: true,
    spawn_executed: true,
    materialized: false,
    result_materialized: false,
    ack_sent: false,
    instruction: "Native sessions_spawn is already accepted for this WorkContract. Do not call sessions_spawn or legacy dispatch again; wait for native_announce completion or use octoclaw_status.",
  };
  return toolResponse(JSON.stringify(body), body);
}

function nativeFlowStatusFromSubstrate(substrate: string): NativeFlowStatus {
  switch (substrate) {
    case "running":
      return "running";
    case "blocked":
      return "blocked";
    case "completed":
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "lost":
      return "lost";
    case "waiting":
      return "waiting";
    case "queued":
    case "planned":
    default:
      return "queued";
  }
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
  const candidates = [
    resolveDispatchSessionKey(ctx, metadata, { stateKey, state, cachedDecision: decision }),
    metadata.session_key,
    asRecord(decision.request).session_key,
    asRecord(payload.job).session_key,
    payload.session_key,
  ].map((value) => asString(value)).filter(Boolean);
  return candidates.find((candidate) => isDispatchableUserSessionKey(candidate)) || asString(stateKey);
}

function toolLogger(ctx: UnknownRecord): UnknownRecord {
  return asRecord(ctx.logger);
}

function warnToolLogger(ctx: UnknownRecord, message: string): void {
  const warn = toolLogger(ctx).warn;
  if (typeof warn === "function") {
    warn(message);
  }
}

function toolResponse(summary: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: summary,
    json: details,
  };
}

function statusToolResponse(rawOutput: string, format: string, imType: string = "plain"): Record<string, unknown> {
  // For Slack, don't wrap in a code block — mrkdwn formatting should be preserved.
  // For other IMs / plain text, use the existing code block + verbatim instruction.
  const text = imType === "slack"
    ? [
        "OctoClaw status panel below. Return it to the user as-is without wrapping in a code block or reformatting.",
        "",
        rawOutput,
      ].join("\n")
    : [
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

interface RuntimeTaskStateRecord extends TaskStateRecord {
  id?: unknown;
  status?: unknown;
  summary?: unknown;
  route?: unknown;
  role?: unknown;
  session_key?: unknown;
  flow_id?: unknown;
  worker_pool?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  failed_at?: unknown;
  spawned_at?: unknown;
  materialized_at?: unknown;
  report_path?: unknown;
  model?: unknown;
  model_profile?: unknown;
  backend?: unknown;
  artifacts?: unknown;
}

interface RuntimeStatusTaskView {
  taskId: string;
  status: string;
  rawStatus: string;
  route: string;
  title: string;
  summary: string;
  complexityBand: string;
  updatedAt: string;
  delegatedAt: string;
  startedAt: string;
  completedAt: string;
  elapsedMs: number | null;
  elapsedText: string;
  model: string;
  backend: string;
  workerPool: string;
  childSessionKey: string;
  runId: string;
  statusReason: string;
  resultLocation: string;
}

function dedupeTaskStateRecords(tasks: RuntimeTaskStateRecord[]): RuntimeTaskStateRecord[] {
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

async function readRuntimeTaskState(options: { includeArchive?: boolean; includeSynthetic?: boolean } = {}): Promise<RuntimeTaskStateRecord[]> {
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

const STATUS_STALE_AFTER_MS = 5 * 60 * 1000;
// timed_out/blocked tasks stay visible for 30 min (was 1h — most aren't worth seeing after half an hour)
const STATUS_PANEL_STALE_VISIBLE_MS = 30 * 60 * 1000;
// completed/failed/canceled stay visible for 4h (was 24h — don't need yesterday's tasks cluttering the panel)
const STATUS_PANEL_TERMINAL_VISIBLE_MS = 4 * 60 * 60 * 1000;

function timestampMs(value: unknown): number | null {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "unknown";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) return `${hours}h${remainingMinutes ? `${remainingMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

function firstTimestamp(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value);
    if (timestampMs(text) !== null) return text;
  }
  return "";
}

function runtimeStatusEvidence(record: RuntimeTaskStateRecord): { hasDispatchEvidence: boolean; hasSpawnEvidence: boolean; resultMaterialized: boolean; childSessionKey: string; runId: string } {
  const artifacts = asRecord(record.artifacts);
  const runtimeTruth = asRecord(artifacts.runtime_truth);
  const evidence = asRecord(runtimeTruth.evidence);
  const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
  const nativeBinding = asRecord(delegateAttempt.nativeBinding);
  const nativeTaskBinding = asRecord(runtimeTruth.nativeTaskBinding);
  const delivery = asRecord(runtimeTruth.delivery || runtimeTruth.resultDelivery);
  const continuity = asRecord(runtimeTruth.childSessionContinuity || runtimeTruth.continuity);
  const childSessionKey = optionalString(
    record.childSessionKey,
    record.child_session_key,
    delegateAttempt.childSessionKey,
    continuity.childSessionKey,
    evidence.childSessionKey,
  ) ?? "";
  const runId = optionalString(
    record.runId,
    record.run_id,
    record.childRunId,
    record.child_run_id,
    delegateAttempt.runId,
    delegateAttempt.run_id,
    delegateAttempt.childRunId,
    delegateAttempt.child_run_id,
    continuity.runId,
    continuity.run_id,
    evidence.childRunId,
    evidence.child_run_id,
    evidence.runId,
    evidence.run_id,
  ) ?? "";
  const childSessionId = optionalString(
    record.childSessionId,
    record.child_session_id,
    delegateAttempt.childSessionId,
    delegateAttempt.child_session_id,
    continuity.childSessionId,
    continuity.child_session_id,
    evidence.childSessionId,
    evidence.child_session_id,
  ) ?? "";
  const hasDispatchEvidence = asBoolean(record.dispatchExecuted)
    || asBoolean(record.dispatch_executed)
    || asBoolean(evidence.dispatchExecuted)
    || asBoolean(evidence.dispatch_executed)
    || asBoolean(delegateAttempt.dispatchExecuted)
    || asBoolean(delegateAttempt.dispatch_executed)
    || Boolean(asString(nativeBinding.nativeFlowId || nativeTaskBinding.nativeFlowId))
    || Boolean(asString(record.flow_id));
  const spawnSignals = [
    record.spawnExecuted,
    record.spawn_executed,
    evidence.spawnExecuted,
    evidence.spawn_executed,
    delegateAttempt.spawnExecuted,
    delegateAttempt.spawn_executed,
  ];
  const hasSpawnEvidence = hasExplicitTrue(spawnSignals)
    || Boolean(runId || childSessionId)
    || (!hasExplicitFalse(spawnSignals) && Boolean(childSessionKey));
  const resultMaterialized = asBoolean(record.resultMaterialized)
    || asBoolean(record.result_materialized)
    || asBoolean(evidence.resultMaterialized)
    || asBoolean(evidence.result_materialized)
    || asBoolean(runtimeTruth.resultMaterialized)
    || asBoolean(runtimeTruth.result_materialized)
    || asBoolean(delivery.resultMaterialized)
    || asBoolean(delivery.result_materialized)
    || Boolean(asString(record.report_path || delivery.artifact_path || delivery.result_path));
  return { hasDispatchEvidence, hasSpawnEvidence, resultMaterialized, childSessionKey, runId };
}

function splitModelRefForSubagent(ref: string): { provider?: string; model?: string } {
  const value = asString(ref);
  if (!value) return {};
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1) return { model: value };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function childSessionAgentId(ctx: UnknownRecord, metadata: UnknownRecord): string {
  return asString(ctx.agentId || metadata.agent_id, "main").replace(/[^A-Za-z0-9_.-]/gu, "_") || "main";
}

function buildChildSessionKey(ctx: UnknownRecord, metadata: UnknownRecord): string {
  return `agent:${childSessionAgentId(ctx, metadata)}:subagent:${randomUUID()}`;
}

function buildSubagentSpawnMessage(params: { task: string; childSessionKey: string; delegateTaskId: string; workContractId: string }): string {
  const completionPath = resolveWorkerCompletionPath(params.workContractId);
  const completionTemplate = JSON.stringify({
    schemaVersion: "octoclaw.worker_completion/v1",
    workContractId: params.workContractId,
    childSessionKey: params.childSessionKey,
    delegateTaskId: params.delegateTaskId,
    status: "success",
    summary: "（在此填写任务结果摘要，最多 2000 字）",
    artifacts: [],
    completedAt: new Date().toISOString(),
  }, null, 2);

  return [
    "[OctoClaw Delegated Task]",
    `childSessionKey: ${params.childSessionKey}`,
    `delegateTaskId: ${params.delegateTaskId}`,
    `workContractId: ${params.workContractId}`,
    "",
    "## Completion Requirement",
    "When the task is done, you MUST write the result to this file using the Write tool:",
    `File path: ${completionPath}`,
    "File content (fill in your actual results):",
    "```json",
    completionTemplate,
    "```",
    "Rules:",
    '- status: use "success" if task completed, "failure" if it failed, "partial" if partially done',
    "- summary: plain text description of what was done and the key results; do not include hidden reasoning or full conversation logs",
    "- If failed, add errorCode and errorMessage fields",
    "- Writing this file is your LAST action. Do not output anything after writing it.",
    "",
    "## Task",
    params.task,
  ].filter(Boolean).join("\n");
}

const PLANNER_NATIVE_RUN_TIMEOUT_FLOOR_SECONDS = 300;
const PLANNER_CONTEXT_PACKET_MAX_ITEMS = 8;

function plannerStringArray(...values: unknown[]): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    const text = asString(value);
    if (text && !out.includes(text)) out.push(text);
  };
  for (const value of values) push(value);
  return out.slice(0, PLANNER_CONTEXT_PACKET_MAX_ITEMS);
}

function plannerAbsoluteScopePath(value: string, cwd: string): string {
  const home = process.env.HOME || "";
  const expanded = home && (value === "~" || value.startsWith("~/"))
    ? `${home.replace(/\/+$/, "")}/${value.slice(2).replace(/^\/+/, "")}`
    : value;
  const absolute = expanded.startsWith("/")
    ? expanded
    : `${cwd.replace(/\/+$/, "")}/${expanded}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function isOpenClawRepoRootPath(value: string): boolean {
  const parts = value.split("/").filter(Boolean);
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] === "openclaw" && parts[index + 1] === "repos") {
      return index + 3 === parts.length;
    }
  }
  return false;
}

function isBroadPlannerReadScope(value: string, params: { cwd: string; workspaceRoot: string }): boolean {
  const text = value.trim();
  if (!text || text === "." || text === "./" || text === "/" || text === "~") return true;
  const absolute = plannerAbsoluteScopePath(text, params.cwd);
  const cwd = plannerAbsoluteScopePath(params.cwd, params.cwd);
  const workspaceRoot = plannerAbsoluteScopePath(params.workspaceRoot, params.cwd);
  if (absolute === cwd || absolute === workspaceRoot) return true;
  return isOpenClawRepoRootPath(absolute);
}

function plannerReadScopeArray(params: { cwd: string; workspaceRoot: string; values: unknown[] }): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    const text = asString(value);
    if (!text || isBroadPlannerReadScope(text, params) || out.includes(text)) return;
    out.push(text);
  };
  for (const value of params.values) push(value);
  return out.slice(0, PLANNER_CONTEXT_PACKET_MAX_ITEMS);
}

function plannerContextRecord(...values: unknown[]): UnknownRecord {
  for (const value of values) {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

function normalizePlannerWorkspaceMode(value: unknown, fallback: "read_only" | "write_allowed" = "write_allowed"): "read_only" | "write_allowed" {
  const mode = asString(value);
  return mode === "read_only" || mode === "readonly" || mode === "read-only" ? "read_only" : fallback;
}

function normalizePlannerRole(value: unknown): "observer" | "default" | "code" | "research" | "review" {
  const role = asString(value);
  if (role === "observer" || role === "code" || role === "research" || role === "review") return role;
  if (role === "worker_code" || role === "octoclaw-code") return "code";
  if (role === "worker_research" || role === "octoclaw-research") return "research";
  if (role === "worker_review" || role === "octoclaw-review") return "review";
  return "default";
}

function plannerMaxToolCalls(value: unknown, fallback = 10): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(2, Math.min(24, Math.floor(numeric)));
}

function plannerDefaultMaxToolCalls(role: "observer" | "default" | "code" | "research" | "review", hasExplicitContextRefs: boolean): number {
  if (role === "code" || role === "review") return 14;
  if (role === "research") return hasExplicitContextRefs ? 8 : 5;
  return hasExplicitContextRefs ? 8 : 4;
}

function buildPlannerContextPacket(params: {
  task: string;
  workContractId: string;
  delegateTaskId: string;
  attemptId?: string;
  expectedDeliverable?: string;
  childSessionKey?: string;
  cwd?: string;
  selectedModel?: string;
  decision?: UnknownRecord | null;
  metadata?: UnknownRecord | null;
  workContract?: WorkContract | null;
}): string {
  const metadata = asRecord(params.metadata);
  const decision = asRecord(params.decision);
  const routeDecision = asRecord(decision.route_decision);
  const requestMetadata = asRecord(asRecord(decision.request).metadata);
  const contextRefs = plannerContextRecord(
    metadata.context_refs,
    metadata.contextRefs,
    requestMetadata.context_refs,
    requestMetadata.contextRefs,
    decision.context_refs,
    decision.contextRefs,
    routeDecision.context_refs,
    routeDecision.contextRefs,
  );
  const delegateScope = params.workContract?.delegate?.scope;
  const cwd = asString(params.cwd, resolveWorkspaceRoot());
  const workspaceRoot = optionalString(
    contextRefs.workspaceRoot,
    contextRefs.workspace_root,
    metadata.workspaceRoot,
    metadata.workspace_root,
    envOverrides.workspaceRoot,
    cwd,
  ) || cwd;
  const primaryFiles = plannerReadScopeArray({
    cwd,
    workspaceRoot,
    values: [
      contextRefs.primaryFiles,
      contextRefs.primary_files,
      metadata.primaryFiles,
      metadata.primary_files,
      routeDecision.primaryFiles,
      routeDecision.primary_files,
    ],
  });
  const readScope = plannerReadScopeArray({
    cwd,
    workspaceRoot,
    values: [
      contextRefs.readScope,
      contextRefs.read_scope,
      primaryFiles,
    ],
  });
  const writeScope = plannerStringArray(
    contextRefs.writeScope,
    contextRefs.write_scope,
    delegateScope?.write,
  );
  const artifactRefs = params.workContract?.delegate?.artifactRefs ?? [];
  const hasExplicitContextRefs = primaryFiles.length > 0 || readScope.length > 0 || writeScope.length > 0 || artifactRefs.length > 0;
  const role = normalizePlannerRole(params.workContract?.delegate?.role
    ?? routeDecision.worker_role
    ?? routeDecision.role
    ?? routeDecision.task_class
    ?? routeDecision.worker_pool);
  const workspaceFallback = role === "code" || writeScope.length > 0 ? "write_allowed" : "read_only";
  const workspaceMode = normalizePlannerWorkspaceMode(
    contextRefs.workspaceMode
      ?? contextRefs.workspace_mode
      ?? delegateScope?.workspaceMode
      ?? metadata.workspaceMode
      ?? metadata.workspace_mode,
    workspaceFallback,
  );
  const maxToolCalls = plannerMaxToolCalls(
    hasExplicitContextRefs
      ? contextRefs.maxToolCalls
        ?? contextRefs.max_tool_calls
        ?? metadata.maxToolCalls
        ?? metadata.max_tool_calls
      : undefined,
    plannerDefaultMaxToolCalls(role, hasExplicitContextRefs),
  );
  const defaultSourcePolicy = hasExplicitContextRefs
    ? "Use explicit refs and local workspace first. Use external web only when the task explicitly needs current outside facts or local refs are insufficient."
    : "Use the supplied task brief first. No explicit refs were provided, so avoid broad workspace inventory; use external web only when the task explicitly needs current outside facts.";
  const sourcePolicy = optionalString(
    hasExplicitContextRefs ? contextRefs.sourcePolicy : undefined,
    hasExplicitContextRefs ? contextRefs.source_policy : undefined,
    defaultSourcePolicy,
  ) || defaultSourcePolicy;
  const threadSummary = optionalString(
    contextRefs.threadSummary,
    contextRefs.thread_summary,
    metadata.threadSummary,
    metadata.thread_summary,
    "",
  ) || "";
  const handoffPacket = buildDelegateHandoffPacket({
    delegateTaskId: params.delegateTaskId,
    attemptId: params.attemptId || `${params.delegateTaskId}:attempt:1`,
    threadBindingKey: params.workContract?.continuity.threadBindingKey || stableId("thread", [params.workContractId]),
    currentUserAsk: truncateText(params.task, 700),
    taskBrief: truncateText(params.task, 900),
    acceptanceCriteria: [asString(params.expectedDeliverable, "Return a compact result that directly satisfies the parent user request.")],
    readScope,
    writeScope,
    workspaceMode,
    role,
    modelProfile: asString(params.selectedModel, params.workContract?.delegate?.modelProfile || "default"),
    maxInputTokens: 1800,
    maxSummaryTokens: 500,
    threadSummary: threadSummary ? truncateText(threadSummary, 500) : undefined,
    artifactRefs: params.workContract?.delegate?.artifactRefs ?? [],
    forbiddenContent: params.workContract?.mainContext.forbiddenContent ?? [],
  });
  return [
    "## Runtime Context Packet",
    "This packet is generated by OctoClaw runtime; do not infer hidden parent transcript.",
    "```json",
    JSON.stringify({
      schemaVersion: "octoclaw.planner_native_context.v1",
      workContractId: params.workContractId,
      delegateTaskId: params.delegateTaskId,
      attemptId: params.attemptId || `${params.delegateTaskId}:attempt:1`,
      preferredChildSessionKey: asString(params.childSessionKey) || undefined,
      cwd,
      workspaceRoot,
      contextMode: "isolated",
      lightContext: true,
      contextStrategy: hasExplicitContextRefs ? "explicit_refs" : "bounded_brief_only",
      primaryFiles,
      sourcePolicy,
      executionBudget: {
        maxToolCalls,
        broadDiscovery: "forbidden_outside_cwd_without_explicit_need",
        resultOnBudgetPressure: "return_partial_with_caveats",
      },
      handoff: handoffPacket,
    }, null, 2),
    "```",
    "",
    "Operational rules:",
    hasExplicitContextRefs
      ? "- Start from primaryFiles/readScope/artifactRefs; do not expand beyond them unless the task cannot be answered otherwise."
      : "- No primaryFiles/readScope/artifactRefs were supplied. Treat the task as bounded by the brief; avoid broad workspace inventory and use only narrowly targeted read-only checks when indispensable.",
    "- Do not run broad discovery under /Users, memory/wiki search, or web search unless explicit refs fail and the task requires it.",
    "- If a fast file search tool is unavailable, use a scoped fallback under cwd/workspaceRoot only.",
    "- Keep within maxToolCalls when possible; deliver partial findings with caveats instead of exhausting the native run timeout.",
    "- Native announce handles final delivery; do not write legacy completion files unless explicitly instructed by a rollback path.",
  ].join("\n");
}

function buildPlannerSpawnTask(params: {
  task: string;
  workContractId: string;
  delegateTaskId: string;
  attemptId?: string;
  expectedDeliverable?: string;
  childSessionKey?: string;
  cwd?: string;
  selectedModel?: string;
  decision?: UnknownRecord | null;
  metadata?: UnknownRecord | null;
  workContract?: WorkContract | null;
}): string {
  return [
    "[OctoClaw delegated work]",
    `workContractId: ${params.workContractId}`,
    `delegateTaskId: ${params.delegateTaskId}`,
    params.attemptId ? `attemptId: ${params.attemptId}` : "",
    params.childSessionKey ? `preferredChildSessionKey: ${params.childSessionKey}` : "",
    "",
    "Expected deliverable:",
    params.expectedDeliverable || "A compact result packet that directly satisfies the parent user request.",
    "",
    buildPlannerContextPacket(params),
    "",
    "Rules:",
    "- Work only on the task below; do not expose hidden reasoning or raw transcript.",
    "- Return a compact, user-safe summary and any artifact refs needed by the parent.",
    "- Prefer concise progress and final output; OpenClaw native delivery handles announce/return.",
    "- For live lookup or research, bound source checks to the minimum needed and deliver partial findings with caveats instead of exhausting the run timeout.",
    "",
    "Task:",
    truncateText(params.task, 1800),
  ].filter(Boolean).join("\n");
}

function plannedDelegateTaskId(workContractId: string, payload: UnknownRecord, contract?: WorkContract | null): string {
  return asString(contract?.delegate?.delegateTaskId)
    || asString(payload.delegate_task_id || payload.delegateTaskId)
    || `delegate-task:${workContractId}`;
}

function plannedAttemptId(delegateTaskId: string, payload: UnknownRecord, contract?: WorkContract | null): string {
  return asString(contract?.delegate?.currentAttemptId)
    || asString(payload.attempt_id || payload.attemptId)
    || `${delegateTaskId}:attempt:1`;
}

function hasNonNewWorkFollowupEvidence(decision: UnknownRecord, metadata: UnknownRecord): boolean {
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

function buildPlannerSessionsSpawnArgs(params: {
  task: string;
  workContractId: string;
  delegateTaskId: string;
  expectedDeliverable?: string;
  selectedModel?: string;
  cwd?: string;
  expectedSeconds: number;
  timeoutSeconds?: number;
  preferredChildSessionKey?: string;
  label?: string;
  attemptId?: string;
  decision?: UnknownRecord | null;
  metadata?: UnknownRecord | null;
  workContract?: WorkContract | null;
}): Record<string, unknown> {
  const requestedTimeout = Number.isFinite(params.timeoutSeconds)
    ? Math.max(0, Math.floor(params.timeoutSeconds ?? 0))
    : params.expectedSeconds > 0
      ? Math.max(60, Math.floor(params.expectedSeconds + 120))
      : undefined;
  const timeout = requestedTimeout === undefined
    ? PLANNER_NATIVE_RUN_TIMEOUT_FLOOR_SECONDS
    : requestedTimeout > 0
      ? Math.max(PLANNER_NATIVE_RUN_TIMEOUT_FLOOR_SECONDS, requestedTimeout)
      : PLANNER_NATIVE_RUN_TIMEOUT_FLOOR_SECONDS;
  return {
    task: buildPlannerSpawnTask({
      task: params.task,
      workContractId: params.workContractId,
      delegateTaskId: params.delegateTaskId,
      attemptId: params.attemptId,
      expectedDeliverable: params.expectedDeliverable,
      childSessionKey: params.preferredChildSessionKey,
      cwd: params.cwd,
      selectedModel: params.selectedModel,
      decision: params.decision,
      metadata: params.metadata,
      workContract: params.workContract,
    }),
    label: truncateText(params.label || params.expectedDeliverable || params.task, 80),
    runtime: "subagent",
    ...(params.selectedModel ? { model: params.selectedModel } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(timeout !== undefined ? { runTimeoutSeconds: timeout } : {}),
    mode: "run",
    cleanup: "keep",
    sandbox: "inherit",
    context: "isolated",
    lightContext: true,
  };
}

function plannerDispatchResponse(params: {
  spawnIntentId: string;
  workContractId: string;
  delegateTaskId: string;
  attemptId: string;
  sessionsSpawnArgs: Record<string, unknown>;
  canonicalArgsHash: string;
  expiresAt: string;
  workerPool: string;
  model: string;
}): Record<string, unknown> {
  const body = {
    ok: true,
    route: "delegate",
    status: "requires_native_spawn",
    delegation_method: "octoclaw_dispatch_planner",
    next_tool: "sessions_spawn",
    nextTool: "sessions_spawn",
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
    sessions_spawn_args: params.sessionsSpawnArgs,
    sessionsSpawnArgs: params.sessionsSpawnArgs,
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
    instruction: "Call sessions_spawn exactly with sessionsSpawnArgs, then call octoclaw_dispatch_confirm with spawnIntentId, workContractId, sessionsSpawnStatus, runId, childRunId, and childSessionKey from the native result.",
  };
  return toolResponse(JSON.stringify(body), body);
}

async function trySpawnSubagentRuntime(params: {
  runtime?: OpenClawSubagentRuntime | null;
  task: string;
  ctx: UnknownRecord;
  metadata: UnknownRecord;
  delegateTaskId: string;
  workContractId: string;
  selectedModel: string;
  idempotencyKey: string;
  preferredChildSessionKey?: string;
}): Promise<{ spawnExecuted: boolean; childSessionKey: string; runId: string; childRunId: string; error: string; sessionReused?: boolean; sessionReuseReason?: string }> {
  const runtime = params.runtime;
  if (!runtime || typeof runtime.run !== "function") {
    return { spawnExecuted: false, childSessionKey: "", runId: "", childRunId: "", error: "subagent_runtime_unavailable" };
  }

  // Resolve child session key: preferred > metadata > new UUID
  const metadataChildKey = asString(params.metadata.childSessionKey || params.metadata.child_session_key);
  let childSessionKey: string;
  let sessionReused = false;
  let sessionReuseReason = "";
  if (params.preferredChildSessionKey) {
    childSessionKey = params.preferredChildSessionKey;
    sessionReused = true;
    sessionReuseReason = "preferred_child_session_reused";
  } else if (metadataChildKey) {
    childSessionKey = metadataChildKey;
    sessionReused = true;
    sessionReuseReason = "metadata_child_session_key_reused";
  } else {
    childSessionKey = buildChildSessionKey(params.ctx, params.metadata);
  }
  const modelRef = splitModelRefForSubagent(params.selectedModel);
  const message = buildSubagentSpawnMessage({
    task: params.task,
    childSessionKey,
    delegateTaskId: params.delegateTaskId,
    workContractId: params.workContractId,
  });
  const extraSystemPrompt = [
    "You are an OctoClaw child worker. Use only the supplied task packet and available tools.",
    "Never expose raw transcript or hidden reasoning. Return a compact, user-safe result packet.",
  ].join("\n");

  try {
    let result: { runId?: string };
    try {
      result = await runtime.run({
        sessionKey: childSessionKey,
        message,
        deliver: false,
        provider: modelRef.provider,
        model: modelRef.model,
        extraSystemPrompt,
        lane: "octoclaw_delegate",
        idempotencyKey: params.idempotencyKey,
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error || "");
      if (!params.selectedModel || !/provider\/model override|model override|not authorized/iu.test(messageText)) {
        throw error;
      }
      result = await runtime.run({
        sessionKey: childSessionKey,
        message,
        deliver: false,
        extraSystemPrompt,
        lane: "octoclaw_delegate",
        idempotencyKey: `${params.idempotencyKey}:default-model`,
      });
    }
    const runId = asString(result?.runId);
    if (!runId) {
      return { spawnExecuted: false, childSessionKey, runId: "", childRunId: "", error: "subagent_runtime_missing_run_id", sessionReused, sessionReuseReason };
    }
    return { spawnExecuted: true, childSessionKey, runId, childRunId: runId, error: "", sessionReused, sessionReuseReason };
  } catch (error) {
    return {
      spawnExecuted: false,
      childSessionKey,
      runId: "",
      childRunId: "",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error || "subagent_runtime_spawn_failed"),
      sessionReused,
      sessionReuseReason,
    };
  }
}

function dispatchSpawnEvidence(input: {
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


function workContractRecord(record: RuntimeTaskStateRecord): UnknownRecord {
  const contract = asRecord(record.workContract);
  return Object.keys(contract).length > 0 ? contract : asRecord(record.work_contract);
}

function nativeStatusInputForTask(record: RuntimeTaskStateRecord, ctx: UnknownRecord): NativeStatusProjectorInput {
  const contract = workContractRecord(record);
  const delegate = asRecord(contract.delegate);
  const nativeBinding = asRecord(delegate.nativeBinding);
  const nativeRefs = asRecord(contract.nativeSpawnRefs);
  const telemetry = asRecord(contract.telemetry);
  const continuity = asRecord(contract.continuity);
  const evidence = runtimeStatusEvidence(record);
  return {
    ctx,
    sessionKey: optionalString(record.session_key, record.sessionKey, contract.sessionKey),
    workContractId: optionalString(record.workContractId, record.work_contract_id, contract.workContractId, record.id),
    openclawRunId: optionalString(nativeRefs.openclawRunId, record.openclawRunId, record.runId, record.run_id, nativeBinding.runId, telemetry.openclawRunId, evidence.runId),
    openclawTaskId: optionalString(nativeRefs.openclawTaskId, record.openclawTaskId, record.nativeTaskId, record.native_task_id, nativeBinding.nativeTaskId),
    openclawFlowId: optionalString(nativeRefs.openclawFlowId, record.openclawFlowId, record.nativeFlowId, record.native_flow_id, record.flowId, record.flow_id, nativeBinding.flowId, telemetry.nativeFlowId),
    childSessionKey: optionalString(nativeRefs.childSessionKey, record.childSessionKey, record.child_session_key, nativeBinding.childSessionKey, continuity.preferredChildSessionKey, evidence.childSessionKey),
    cache: {
      status: asString(record.status),
      rawStatus: asString(record.rawStatus || record.raw_status),
      summary: asString(record.summary),
    },
  };
}

function workContractMainContext(record: RuntimeTaskStateRecord): UnknownRecord {
  return asRecord(workContractRecord(record).mainContext);
}

function runtimeTaskRoute(record: RuntimeTaskStateRecord): string {
  const contract = workContractRecord(record);
  return normalizeLiveRoute(optionalString(record.route, contract.route), "delegate");
}

function runtimeTaskTitle(record: RuntimeTaskStateRecord): string {
  const contract = workContractRecord(record);
  const mainContext = workContractMainContext(record);
  return truncateText(optionalString(
    record.title,
    record.taskSummary,
    record.task_summary,
    mainContext.summary,
    contract.userAsk,
    record.summary,
  ) ?? "未命名任务", 160);
}

function runtimeTaskComplexityBand(record: RuntimeTaskStateRecord): string {
  const metadata = asRecord(record.metadata);
  const contract = workContractRecord(record);
  const decision = asRecord(contract.decision);
  const routeDecision = asRecord(decision.route_decision);
  return optionalString(
    record.complexityBand,
    record.complexity_band,
    metadata.complexityBand,
    metadata.complexity_band,
    decision._judge_complexity_band,
    routeDecision._judge_complexity_band,
    routeDecision.complexity_band,
  ) ?? "unknown";
}

function projectRuntimeStatus(record: RuntimeTaskStateRecord, nowMs = Date.now()): { status: string; reason: string } {
  const rawStatus = asString(record.status, "unknown");
  const route = runtimeTaskRoute(record);
  const evidence = runtimeStatusEvidence(record);
  const terminalStatus = ["failed", "completed", "done", "succeeded", "cancelled", "canceled", "blocked", "timed_out"].includes(rawStatus)
    ? rawStatus === "done" || rawStatus === "succeeded" ? "completed" : rawStatus === "cancelled" ? "canceled" : rawStatus
    : "";
  const updatedMs = timestampMs(record.updated_at || record.started_at || record.spawned_at);
  const isStale = updatedMs !== null && nowMs - updatedMs >= STATUS_STALE_AFTER_MS;
  if ((rawStatus === "running" || rawStatus === "queued" || rawStatus === "materializing") && isStale) {
    return { status: "timed_out", reason: `stale_status_no_progress>${formatElapsed(STATUS_STALE_AFTER_MS)}` };
  }

  if (route === "delegate") {
    if (!evidence.hasDispatchEvidence) return { status: "registered", reason: "no_dispatch_evidence" };
    if (!evidence.hasSpawnEvidence && !["failed", "canceled", "blocked", "timed_out"].includes(terminalStatus)) {
      return { status: "queued", reason: "dispatch_materialized_but_no_spawn_evidence" };
    }
    if (terminalStatus === "completed" && !evidence.resultMaterialized) {
      return { status: "deliverable_ready", reason: "terminal_completed_without_result_materialized" };
    }
  }

  if (terminalStatus) {
    return { status: terminalStatus, reason: "terminal_or_explicit_status" };
  }

  if (rawStatus === "running") return { status: "running", reason: "fresh_running_with_required_evidence" };
  if (rawStatus === "queued" || rawStatus === "planned") return { status: "queued", reason: "queued_or_planned" };
  return { status: rawStatus || "unknown", reason: "raw_status_projection" };
}

function statusPanelRelevantMs(task: RuntimeStatusTaskView): number | null {
  return timestampMs(task.completedAt)
    ?? timestampMs(task.updatedAt)
    ?? timestampMs(task.delegatedAt)
    ?? timestampMs(task.startedAt);
}

function statusPanelRetentionMs(task: RuntimeStatusTaskView): number | null {
  if (["failed", "completed", "canceled"].includes(task.status)) return STATUS_PANEL_TERMINAL_VISIBLE_MS;
  if (["timed_out", "blocked"].includes(task.status)) return STATUS_PANEL_STALE_VISIBLE_MS;
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

function buildRuntimeStatusTaskView(record: RuntimeTaskStateRecord, nowMs = Date.now(), nativeProjection?: NativeStatusProjection): RuntimeStatusTaskView {
  const artifacts = asRecord(record.artifacts);
  const runtimeTruth = asRecord(artifacts.runtime_truth);
  const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
  const binding = asRecord(runtimeTruth.binding);
  const evidence = runtimeStatusEvidence(record);
  const materializedAt = firstTimestamp(record.materialized_at, record.created_at, record.spawned_at, record.started_at, record.updated_at);
  const startedAt = evidence.hasSpawnEvidence ? firstTimestamp(record.started_at, record.spawned_at, materializedAt) : "";
  const delegatedAt = firstTimestamp(record.spawned_at, record.started_at, materializedAt, record.updated_at);
  const completedAt = firstTimestamp(record.completed_at, record.failed_at, delegateAttempt.completedAt, delegateAttempt.failedAt);
  const startMs = timestampMs(startedAt || delegatedAt);
  const endMs = timestampMs(completedAt) ?? nowMs;
  const elapsedMs = startMs === null ? null : Math.max(0, endMs - startMs);
  const fallbackProjection = projectRuntimeStatus(record, nowMs);
  const nativeProjectionAuthoritative = Boolean(nativeProjection && (
    ["run", "flow", "latest"].includes(nativeProjection.source)
    || nativeProjection.reason === "native_id_known_but_registry_missing"
    || nativeProjection.reason === "native_registry_lookup_failed"
    || nativeProjection.reason === "native_registry_unavailable"
    || nativeProjection.reason === "task_state_cache_degraded"
  ));
  const projected = nativeProjectionAuthoritative && nativeProjection
    ? { status: nativeProjection.status, reason: nativeProjection.reason }
    : fallbackProjection;
  const workerPool = optionalString(record.worker_pool, binding.workerPool, delegateAttempt.workerPool) ?? "unknown";
  const artifactRefs = Array.isArray(record.artifact_refs) ? record.artifact_refs.map(String).filter(Boolean) : [];
  const compactPacket = asRecord(record.compact_parent_packet);
  const compactArtifactRefs = Array.isArray(compactPacket.artifactRefIds) ? compactPacket.artifactRefIds.map(String).filter(Boolean) : [];
  const resultLocation = optionalString(
    record.report_path,
    artifacts.report_path,
    artifacts.result_path,
    artifacts.output_path,
    artifactRefs.length > 0 ? `artifact_refs=${artifactRefs.join(",")}` : undefined,
    compactArtifactRefs.length > 0 ? `artifact_refs=${compactArtifactRefs.join(",")}` : undefined,
  ) ?? "none";
  return {
    taskId: asString(record.id),
    status: projected.status,
    rawStatus: nativeProjectionAuthoritative ? (nativeProjection?.rawStatus || asString(record.status, "unknown")) : asString(record.status, "unknown"),
    route: runtimeTaskRoute(record),
    title: runtimeTaskTitle(record),
    summary: (() => {
      // Prefer completion summary for finished tasks
      const completion = record.completion as Record<string, unknown> | undefined;
      if (completion && typeof completion === "object") {
        const completionSummary = asString(completion.summary);
        if (completionSummary) {
          const statusEmoji = asString(completion.status) === "success" ? "✅"
            : asString(completion.status) === "partial" ? "⚠️" : "❌";
          return `${statusEmoji} ${completionSummary.slice(0, 200)}`;
        }
      }
      return (nativeProjectionAuthoritative ? nativeProjection?.summary : "") || asString(record.summary) || runtimeTaskTitle(record);
    })(),
    complexityBand: runtimeTaskComplexityBand(record),
    updatedAt: asString(record.updated_at),
    delegatedAt,
    startedAt,
    completedAt,
    elapsedMs,
    elapsedText: formatElapsed(elapsedMs),
    model: optionalString(
      record.model,
      record.model_profile,
      delegateAttempt.model,
      runtimeTruth.model,
      asRecord(runtimeTruth.model_policy).selected_model,
    ) ?? "unknown",
    backend: optionalString(record.backend, workerPool, binding.controllerId, runtimeTruth.backend) ?? "unknown",
    workerPool,
    childSessionKey: optionalString(nativeProjectionAuthoritative ? nativeProjection?.childSessionKey : "", evidence.childSessionKey) ?? "",
    runId: optionalString(nativeProjectionAuthoritative ? nativeProjection?.runId : "", evidence.runId) ?? "",
    statusReason: projected.reason,
    resultLocation,
  };
}

function buildTaskActionTimeline(record: RuntimeTaskStateRecord, liveRead: UnknownRecord, replayEvents: UnknownRecord[]): UnknownRecord[] {
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

function collectIdentityAliases(value: unknown, output: Set<string>, depth = 0): void {
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

function taskStateRecordMatchesId(record: RuntimeTaskStateRecord, rawTaskId: string): boolean {
  const taskId = asString(rawTaskId);
  if (!taskId) return false;
  const aliases = new Set<string>();
  collectIdentityAliases(record, aliases);
  return aliases.has(taskId);
}

async function buildNativeTaskActionPayload(rawText: string, format: "text" | "json"): Promise<{ summary: string; payload: UnknownRecord }> {
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
  const plugin = createOctoClawRuntimePlugin();
  if (!liveRead) {
    try {
      liveRead = asString(record.session_key) && asString(record.flow_id)
        ? plugin.createAdapter().bindSession(asString(record.session_key)).readTask(asString(record.flow_id), asString(record.id))
        : null;
    } catch {
      liveRead = null;
    }
  }
  const replayEvents = await readRuntimeReplayTimeline(asString(record.id));
  const artifacts = asRecord(record.artifacts);
  const projected = projectRuntimeStatus(record);
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

async function buildNativeStatusOutput(format: string, imType: string = "plain", ctx: UnknownRecord = {}): Promise<string> {
  const normalizedFormat = format || "anchors";
  const nowMs = Date.now();
  const includeExpired = shouldIncludeExpiredStatus(normalizedFormat);
  const retention = pruneRuntimeTaskStateCache();
  const tasks = sortTaskStateRecords(await readRuntimeTaskState({ includeArchive: includeExpired }));
  const nativeProjections = await Promise.all(tasks.map((task) => projectNativeStatus(nativeStatusInputForTask(task, ctx))));
  const allTasks = tasks
    .map((task, index) => buildRuntimeStatusTaskView(task, nowMs, nativeProjections[index]))
    .filter((task) => task.route === "delegate");
  const visibleTasks = includeExpired ? allTasks : allTasks.filter((task) => !isStatusPanelExpired(task, nowMs));
  const hiddenExpiredCount = allTasks.length - visibleTasks.length;

  // Sort by importance: active first, then recent terminal
  const STATUS_PRIORITY: Record<string, number> = {
    running: 0, materializing: 1, queued: 2, blocked: 3,
    timed_out: 4, lost: 5, degraded: 6, failed: 7, deliverable_ready: 8,
    completed: 9, canceled: 10, registered: 11,
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
    const slackTasks: StatusTaskSummary[] = sortedVisibleTasks.slice(0, limit).map((t) => ({
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
      statusReason: t.statusReason,
      route: t.route,
    }));
    const slackOutput = buildSlackStatusOutput(slackTasks, {
      totalCount: allTasks.length,
      hiddenCount: hiddenExpiredCount,
      format: normalizedFormat,
    });
    return slackOutput.text;
  }
  // ── Feishu card: TODO — needs IMAdapter.sendCard() support ───────────────
  // if (imType === "feishu") { ... return feishu card JSON as text ... }

  // ── Beautified anchors format (default) ─────────────────────────────────
  if (normalizedFormat === "anchors") {
    const limit = 50;
    const completedStates = new Set(["completed"]);
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

    type GroupKey = "active" | "completed" | "failed";
    const groupOrder: GroupKey[] = ["active", "completed", "failed"];
    const groupEmoji: Record<GroupKey, string> = { active: "⏳", completed: "✅", failed: "❌" };
    const groupLabel: Record<GroupKey, string> = { active: "Active", completed: "Completed", failed: "Failed" };

    const groups = new Map<GroupKey, typeof sortedVisibleTasks>();
    for (const key of groupOrder) groups.set(key, []);
    for (const task of sortedVisibleTasks) {
      let key: GroupKey;
      if (completedStates.has(task.status)) key = "completed";
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
        const metaParts = [task.status, elapsed, model, band].filter(Boolean);
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
    return lines.join("\n");
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
    "Fields: task_id | projected_status(raw_status) | route | title | complexity | elapsed | delegated_at | model | backend | child_session/run | result_location/artifact_refs | reason | summary",
  ].filter(Boolean);
  const limit = normalizedFormat === "raw" ? 50 : 25;
  for (const task of sortedVisibleTasks.slice(0, limit)) {
    const childRef = [task.childSessionKey, task.runId].filter(Boolean).join("/") || "none";
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
      `child=${childRef}`,
      `result=${task.resultLocation}`,
      `reason=${task.statusReason}`,
      task.summary,
    ].join(" | "));
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

function resolveDispatchPolicyContext(ctx: UnknownRecord, prompt = ""): { key: string; state: UnknownRecord | null } {
  const fromStore = asRecord(policyState.getDispatchPolicyContext(ctx, prompt));
  const contextKey = asString(fromStore.key);
  const contextState = isRecord(fromStore.state) ? fromStore.state : null;
  if (contextKey || contextState) {
    return { key: contextKey, state: contextState };
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

function setPolicyStateAliasesForContext(ctx: UnknownRecord, entry: UnknownRecord, explicitKeys: string[] = []): string {
  const keys = Array.from(new Set([
    ...explicitKeys.map((key) => asString(key)),
    ...resolvePolicyStateKeys(ctx).map((key) => asString(key)),
  ].filter(Boolean)));
  let primaryKey = "";
  for (const key of keys) {
    const storedKey = setPolicyStateForContext(ctx, entry, key);
    if (!primaryKey) primaryKey = storedKey;
  }
  return primaryKey || setPolicyStateForContext(ctx, entry);
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


export function dispatchReplyToMessageId(metadata: UnknownRecord, state: UnknownRecord | null | undefined, ctx: UnknownRecord): string {
  const stateRecord = asRecord(state);
  const slackMetadata = asRecord(metadata.slack);
  const transportMetadata = asRecord(metadata.transport);
  const deliveryTarget = asRecord(stateRecord.deliveryTarget || stateRecord.delivery_target || metadata.delivery_target);
  return optionalReplyTargetId(
    deliveryTarget.replyToMessageId,
    deliveryTarget.reply_to_message_id,
    deliveryTarget.threadTs,
    deliveryTarget.thread_ts,
    metadata.inboundMessageTs,
    metadata.inbound_message_ts,
    metadata.replyToMessageId,
    metadata.reply_to_message_id,
    metadata.message_id,
    metadata.messageId,
    metadata.thread_ts,
    metadata.threadTs,
    slackMetadata.thread_ts,
    slackMetadata.threadTs,
    slackMetadata.reply_to_id,
    transportMetadata.thread_ts,
    transportMetadata.reply_to_id,
    stateRecord.inboundMessageTs,
    stateRecord.inbound_message_ts,
    stateRecord.replyToMessageId,
    stateRecord.reply_to_message_id,
    stateRecord.message_id,
    stateRecord.messageId,
    ctx.inboundMessageTs,
    ctx.inbound_message_ts,
    ctx.replyToMessageId,
    ctx.reply_to_message_id,
    ctx.message_id,
    ctx.messageId,
    ctx.thread_ts,
    ctx.threadTs,
  ) ?? "";
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
  workContractId?: string | null;
  delegateTaskId?: string | null;
  attemptId?: string | null;
  childSessionKey?: string | null;
  childSessionId?: string | null;
  runId?: string | null;
  childRunId?: string | null;
  dispatchExecuted?: boolean;
  spawnExecuted?: boolean;
  materialized?: boolean;
  executionState?: string;
  nativeTaskId?: string | null;
  nativeFlowId?: string | null;
  resultMaterialized?: boolean;
  deliveryStatus?: string | null;
}): Record<string, unknown> {
  const body = {
    ok: true,
    route: params.route,
    worker_pool: params.workerPool,
    task_id: params.taskId,
    task_class: params.taskClass,
    work_contract_id: asString(params.workContractId) || null,
    delegate_task_id: asString(params.delegateTaskId) || null,
    attempt_id: asString(params.attemptId) || null,
    child_session_key: asString(params.childSessionKey) || null,
    child_session_id: asString(params.childSessionId) || null,
    run_id: asString(params.runId) || null,
    child_run_id: asString(params.childRunId) || null,
    delegation_method: "octoclaw_dispatch",
    materialized: params.materialized === true,
    execution_state: asString(params.executionState) || (params.spawnExecuted === true ? "spawn_confirmed" : "unknown"),
    dispatch_executed: params.dispatchExecuted === true,
    spawn_executed: params.spawnExecuted === true,
    native_task_id: params.nativeTaskId ?? null,
    native_flow_id: params.nativeFlowId ?? null,
    result_materialized: params.resultMaterialized === true,
    delivery_status: params.deliveryStatus ?? null,
  };
  return toolResponse(JSON.stringify(body), body);
}

function dispatchHonestyFailure(params: {
  route?: string | null;
  error: string;
  sealMismatch?: boolean;
  retryable?: boolean;
  terminal?: boolean;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  const body = {
    ok: false,
    route: params.route ?? null,
    error: params.error,
    seal_mismatch: params.sealMismatch === true,
    retryable: params.retryable === true,
    terminal: params.terminal === true,
    ...(params.details ?? {}),
  };
  return toolResponse(JSON.stringify(body), body);
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

function taskActionError(error: string, extra: UnknownRecord = {}): { summary: string; payload: UnknownRecord } {
  const payload = { ok: false, error, ...extra };
  return { summary: JSON.stringify(payload, null, 2), payload };
}

function findWorkContractForTaskAction(taskId: string): WorkContract | null {
  const direct = loadWorkContract(taskId);
  if (direct) return direct;

  const records = readTaskStateRecords();
  const matched = records.find((record) => taskStateRecordMatchesId(record as RuntimeTaskStateRecord, taskId));
  if (!matched) return null;

  const matchedWorkContractId = asString(matched.workContractId || matched.work_contract_id || matched.id);
  if (matchedWorkContractId) {
    const byId = loadWorkContract(matchedWorkContractId);
    if (byId) return byId;
  }

  const embedded = asRecord(matched.workContract || matched.work_contract) as Partial<WorkContract>;
  return asString(embedded.workContractId) ? embedded as WorkContract : null;
}

function issueRetryDelegationTicket(db: NonNullable<ReturnType<typeof openRuntimeLedger>["db"]>, contract: WorkContract, attemptId: string, nowIso: string): string {
  const ticketId = `retry:${contract.workContractId}:${attemptId}`;
  const expiresAt = new Date(Date.parse(nowIso) + 24 * 60 * 60 * 1000).toISOString();
  const ticketJson = {
    ticket_id: ticketId,
    work_contract_id: contract.workContractId,
    turn_id: contract.turnId,
    session_key: contract.sessionKey,
    retry: true,
    attempt_id: attemptId,
  };
  db.prepare(
    `INSERT INTO delegation_tickets (
       ticket_id, work_contract_id, turn_id, session_key,
       delivery_target_id, expected_deliverable, complexity_final,
       status, issued_at, expires_at, ticket_json, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, 0)`,
  ).run(
    ticketId,
    contract.workContractId,
    contract.turnId,
    contract.sessionKey,
    contract.continuity.threadBindingKey || contract.sessionKey,
    contract.mainContext.summary.slice(0, 200),
    null,
    nowIso,
    expiresAt,
    JSON.stringify(ticketJson),
  );
  return ticketId;
}

async function executeRetryTaskAction(taskId: string, format: "text" | "json"): Promise<{ summary: string; payload: UnknownRecord }> {
  if (!taskId) return taskActionError("retry_requires_task_id");
  const contract = findWorkContractForTaskAction(taskId);
  if (!contract) return taskActionError("work_contract_not_found", { taskId });
  const delegateTaskId = asString(contract.delegate?.delegateTaskId || contract.continuity.delegateTaskId);
  if (!delegateTaskId) return taskActionError("delegate_task_id_not_found", { taskId, workContractId: contract.workContractId });

  const openResult = openRuntimeLedger({ mode: "enforce" });
  if (openResult.status !== "ok" || !openResult.db) {
    return taskActionError("ledger_unavailable", { taskId, workContractId: contract.workContractId, dbPath: openResult.dbPath });
  }

  const db = openResult.db;
  const now = new Date();
  const nowIso = now.toISOString();
  let attemptNo = 1;
  let attemptId = "";
  let queueId = "";
  let ticketId = "";
  let sessionMode = "new_session";
  let childSessionKey = "";
  let preferredReason = "";

  try {
    db.exec("BEGIN");
    const maxRow = db.prepare("SELECT MAX(attempt_no) AS max_no FROM task_attempts WHERE work_contract_id = ?").get(contract.workContractId);
    attemptNo = maxRow && maxRow.max_no != null ? Number(maxRow.max_no) + 1 : 1;
    attemptId = `${delegateTaskId}:attempt:${attemptNo}`;
    queueId = `queue:${attemptId}`;
    ticketId = issueRetryDelegationTicket(db, contract, attemptId, nowIso);
    const preferred = selectPreferredChildSession(contract, "resume_preferred");
    preferredReason = preferred.reason;
    childSessionKey = preferred.selected?.childSessionKey ?? `child:${delegateTaskId}:attempt:${attemptNo}`;
    sessionMode = preferred.selected ? "resume_preferred" : "new_session";
    const attemptJson = {
      ticket_id: ticketId,
      work_contract_id: contract.workContractId,
      delegate_task_id: delegateTaskId,
      retry: true,
      session_mode: sessionMode,
      preferred_child_session_reason: preferredReason,
    };
    db.prepare(
      `INSERT INTO task_attempts (
         attempt_id, work_contract_id, delegate_task_id, attempt_no,
         attempt_kind, status, child_session_key, model_profile, worker_pool,
         updated_at, attempt_json, revision
       ) VALUES (?, ?, ?, ?, 'retry', 'admitted', ?, ?, ?, ?, ?, 0)`,
    ).run(
      attemptId,
      contract.workContractId,
      delegateTaskId,
      attemptNo,
      childSessionKey,
      contract.delegate?.modelProfile ?? null,
      contract.delegate?.role ?? null,
      nowIso,
      JSON.stringify(attemptJson),
    );
    db.prepare(
      `INSERT INTO scheduler_queue (
         queue_id, work_contract_id, attempt_id, queue_status, priority,
         dependency_ids_json, resource_keys_json, created_at, updated_at, revision
       ) VALUES (?, ?, ?, 'admitted', 0, '[]', '[]', ?, ?, 0)`,
    ).run(queueId, contract.workContractId, attemptId, nowIso, nowIso);
    db.prepare("UPDATE delegation_tickets SET status = 'used', used_at = ?, revision = revision + 1 WHERE ticket_id = ?").run(nowIso, ticketId);
    db.prepare(
      `INSERT INTO runtime_events (event_type, work_contract_id, attempt_id, payload_json, created_at)
       VALUES ('task_retry_requested', ?, ?, ?, ?)`,
    ).run(contract.workContractId, attemptId, JSON.stringify({ taskId, delegateTaskId, attemptNo, queueId, ticketId, sessionMode, childSessionKey }), nowIso);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    return taskActionError("retry_attempt_create_failed", { taskId, workContractId: contract.workContractId, message: error instanceof Error ? error.message : String(error) });
  } finally {
    try { db.close(); } catch {}
  }

  const queued = promoteToQueued({ queueId, contract });
  const updatedContract = markChildSessionPreferred({
    workContractId: contract.workContractId,
    childSessionKey,
    delegateTaskId,
    attemptId,
    agentRole: contract.delegate?.role ?? "default",
    modelProfile: contract.delegate?.modelProfile ?? "",
    parentSessionKey: contract.continuity.parentSessionKey || contract.sessionKey,
    threadBindingKey: contract.continuity.threadBindingKey,
    scopeFingerprint: contract.delegate?.scope.scopeFingerprint ?? "",
  }) ?? contract;
  upsertTaskStateRecord({
    id: updatedContract.workContractId,
    taskId: asString(updatedContract.telemetry.nativeTaskId || taskId),
    task_id: asString(updatedContract.telemetry.nativeTaskId || taskId),
    workContractId: updatedContract.workContractId,
    work_contract_id: updatedContract.workContractId,
    status: queued.queueStatus,
    workContractStatus: updatedContract.status,
    work_contract_status: updatedContract.status,
    route: updatedContract.route,
    sessionKey: updatedContract.sessionKey,
    session_key: updatedContract.sessionKey,
    childSessionKey,
    child_session_key: childSessionKey,
    updatedAt: nowIso,
    updated_at: nowIso,
    workContract: updatedContract,
    work_contract: updatedContract,
    retry: { attempt_no: attemptNo, attempt_id: attemptId, delegateTaskId, queue_id: queueId, ticket_id: ticketId, status: queued.queueStatus },
  });

  const payload = {
    ok: true,
    mode: "native_runtime",
    action: "retry",
    taskId,
    workContractId: contract.workContractId,
    delegateTaskId,
    attempt_no: attemptNo,
    attempt_id: attemptId,
    status: queued.queueStatus,
    queue_id: queueId,
    ticket_id: ticketId,
    child_session_key: childSessionKey,
    session_mode: sessionMode,
    preferred_child_session_reason: preferredReason,
    scheduler: queued,
  };
  const summary = format === "json" ? JSON.stringify(payload, null, 2) : `Retry admitted for ${delegateTaskId}: attempt ${attemptNo} (${attemptId}) is ${queued.queueStatus}.`;
  return { summary, payload };
}

async function executeTaskAnchorCommand(rawText: string, format: string, cwd: string): Promise<{ summary: string; payload: UnknownRecord }> {
  void cwd;
  const parsed = parseTaskAction(rawText);
  if (["stop", "approve", "reject"].includes(parsed.action)) {
    return taskActionError(`action_not_implemented: ${parsed.action}`, { action_deferred: true, action: parsed.action });
  }
  if (parsed.action === "retry") {
    return executeRetryTaskAction(parsed.taskId, normalizeTaskActionFormat(format));
  }
  if ((parsed.action || "details") === "details" && parsed.taskId) {
    checkActiveTaskRecovery({ taskId: parsed.taskId });
  }
  return buildNativeTaskActionPayload(rawText, normalizeTaskActionFormat(format));
}

function buildMinimalProjection(params: {
  taskId: string;
  status: string;
  dispatchExecuted: boolean;
  spawnExecuted: boolean;
  resultMaterialized: boolean;
  modelId?: string;
  backend?: string;
  artifactRefIds?: string[];
  childSessionKey?: string;
  runId?: string;
  childRunId?: string;
  latestAnomalyNotice?: Record<string, unknown>;
}): import("@octoclaw/contracts/status-projection").TaskStatusProjection {
  return {
    schemaVersion: "octoclaw.task_status_projection/v1" as const,
    projectionId: `exec_transition_${params.taskId}_${Date.now()}`,
    generatedAt: new Date().toISOString(),
    requestId: "",
    flowId: "",
    taskId: params.taskId,
    title: "",
    summary: "",
    taskSummary: "",
    route: "delegate" as const,
    role: "",
    backend: params.backend ?? "octoclaw.delegate",
    modelProfile: "",
    modelId: params.modelId,
    status: params.status as any,
    success: false,
    createdAt: new Date().toISOString(),
    dispatchExecuted: params.dispatchExecuted,
    spawnExecuted: params.spawnExecuted,
    resultMaterialized: params.resultMaterialized,
    elapsedMs: 0,
    artifactRefs: [],
    artifactRefIds: params.artifactRefIds ?? [],
    childSessionKey: params.childSessionKey,
    runId: params.runId,
    childRunId: params.childRunId,
    actions: [],
    latestAnomalyNotice: params.latestAnomalyNotice as any,
  };
}

export function getToolRegistrations(options: ToolRegistrationOptions = {}): ToolRegistration[] {
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
        const existingRecord = asRecord(existing);
        const existingDecision = nestedRecord(existingRecord, "decision");
        const existingRequest = nestedRecord(existingDecision, "request");
        let metadata = buildPolicyMetadata(ctx, { stateKey: existingStateKey || asString(existingRequest.session_key) });
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey: existingStateKey, state: existingRecord, cachedDecision: existingDecision });
        if (!asString(metadata.message_id)) {
          metadata.message_id = asString(existingRecord.message_id || existingRecord.inboundMessageTs || existingRecord.replyToMessageId || existingRecord.reply_to_id);
        }
        if (!asString(metadata.session_thread_id)) {
          metadata.session_thread_id = asString(existingRecord.inboundMessageTs || existingRecord.message_id || existingRecord.replyToMessageId || existingRecord.reply_to_id);
        }
        if (Object.keys(asRecord(options.judgeFastRaw)).length > 0) {
          metadata._judgeFastConfig = asRecord(options.judgeFastRaw);
        }
        if (typeof options.delegationEnabled === "boolean") {
          metadata._delegationEnabled = options.delegationEnabled;
        }
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
        if (sealedReplyBlocksDelegateHint(existingDecision, asString(params.routeHint), routeObjection)) {
          const payload = sealedReplyRouteHintPayload(existingDecision, routeHintPayload);
          const nextState = {
            ...(existing ?? {}),
            prompt: asString(existing?.prompt, task),
            decision: payload,
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            delegated: existing?.delegated === true,
            delegationTool: asString(existing?.delegationTool),
            blockedTools: Array.isArray(existing?.blockedTools) ? existing?.blockedTools : [],
            routeHintSubmitted: true,
            routeHintPayload,
          };
          setPolicyStateAliasesForContext(ctx, nextState, [replaySessionKey, existingStateKey]);
          await recordPolicyReplay(
            "route_hint_blocked_by_sealed_work_contract",
            {
              sessionKey: replaySessionKey,
              sessionId: asString(ctx.sessionId),
              routeHint: asString(params.routeHint),
              finalRoute: "reply",
              workContractId: asString(asRecord(payload.work_contract).workContractId || asRecord(payload.work_contract).work_contract_id),
              reason: "route_hint_blocked_by_sealed_work_contract",
            },
            toolLogger(ctx),
            payload,
          );
          return toolResponse(policySummaryText(payload), payload);
        }
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
        const finalRoute = asString(asRecord(payload.route_decision).route);
        const objectionAccepted = routeObjection && finalRoute === asString(params.requestedRoute);
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
              objection_accepted: objectionAccepted,
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
        setPolicyStateAliasesForContext(ctx, nextState, [replaySessionKey, existingStateKey]);
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
        const task = asString(params.task);
        const payload = await resolveStatelessPolicyDecision(asString(params.task), {
          command: asString(params.command),
          metadata,
          forceRoute: asString(params.forceRoute),
        });
        const json: UnknownRecord = {
          ...asRecord(payload),
          managed_agent_context: isManagedAgentContext(ctx),
        };
        const routeHintPolicy = asRecord(json.route_hint_policy);
        const request = asRecord(json.request);
        const replaySessionKey = asString(request.session_key || metadata.session_key || params.sessionKey);
        const existing = replaySessionKey ? policyState.get(replaySessionKey) : undefined;
        setPolicyStateAliasesForContext(ctx, {
          ...(existing ?? {}),
          prompt: task,
          decision: json,
          canonicalSessionKey: asString(existing?.canonicalSessionKey) || replaySessionKey,
          routeHintSubmitted: routeHintPolicy.submitted === true,
          routeHintPayload: asRecord(asRecord(request.metadata).route_hint_payload),
        }, [replaySessionKey]);
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
          metadataJson: { type: "string", description: "Optional JSON object with extra session metadata. For delegated work, include known anchors as context_refs: { primaryFiles, readScope, writeScope, sourcePolicy, maxToolCalls, workspaceMode }." },
          policyJson: { type: "string", description: "Optional precomputed runtime policy decision JSON." },
          workContractId: { type: "string", description: "Optional sealed WorkContract id to dispatch without re-judging." },
          delegateTaskId: { type: "string", description: "Optional delegate task id for continuation-aware dispatch." },
          continuationMode: { type: "string", enum: ["resume_preferred", "status_only", "new_attempt"], description: "Optional continuation hint for WorkContract dispatch." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const dispatchToolStartedAt = Date.now();
        let { key: stateKey, state } = resolveDispatchPolicyContext(ctx, asString(params.task));
        let hadCachedDecision = Boolean(params.policyJson || state?.decision);
        let cachedDecision = selectDispatchPolicyDecision(state?.decision, params.policyJson);
        let dispatchWorkContract: WorkContract | null = null;
        let workContractDispatchError: { route: string; error: string } | null = null;
        const requestedWorkContractId = selectDispatchWorkContractId(asRecord(params), cachedDecision);
        if (requestedWorkContractId) {
          const validation = validateDispatchWorkContract(loadWorkContract(requestedWorkContractId), requestedWorkContractId);
          if (validation.ok) {
            dispatchWorkContract = validation.contract;
            cachedDecision = decisionFromWorkContract(dispatchWorkContract, cachedDecision);
            hadCachedDecision = true;
          } else {
            workContractDispatchError = { route: validation.route, error: validation.error };
            cachedDecision = cachedDecision ?? {
              request: { session_key: stateKey || asString(params.sessionKey) },
              route_decision: { route: validation.route },
              workContractId: requestedWorkContractId,
            };
          }
        }
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
        const runtimeLedgerMode = resolveRuntimeLedgerMode();
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
        if (workContractDispatchError) {
          await recordDispatchTerminalFailure(workContractDispatchError.error, { route: workContractDispatchError.route });
          return dispatchHonestyFailure({
            route: workContractDispatchError.route,
            error: workContractDispatchError.error,
            sealMismatch: false,
            retryable: false,
            terminal: true,
            details: {
              dispatch_executed: false,
              spawn_executed: false,
              materialized: false,
              result_materialized: false,
            },
          });
        }
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
        const budgetedMainEscalationAllowed = cachedRouteSeal
          ? isBudgetedMainDispatchEscalationAllowed({
              cachedRouteSeal,
              cachedDecision,
              resolvedRoute,
              hadCachedDecision,
              routeSealState,
            })
          : false;
        if (cachedRouteSeal && resolvedRoute !== cachedRouteSeal.route && !budgetedMainEscalationAllowed) {
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
        } else if (cachedRouteSeal && budgetedMainEscalationAllowed) {
          await recordPolicyReplay("sealed_budgeted_main_dispatch_allowed", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            sealedRoute: cachedRouteSeal.route,
            decision_bucket: "budgeted_main_then_delegate",
            hadCachedDecision,
            policyJsonProvided: Boolean(params.policyJson),
          }, toolLogger(ctx), cachedDecision);
        }
        let metadata = initialMetadata;
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey, state, cachedDecision });
        metadata.requested_route = normalizeLiveRoute(resolvedRoute, "reply");
        await recordPolicyReplay("dispatch_tool_started", {
          sessionKey: managedSessionKey || stateKey || asString(params.sessionKey),
          sessionId: asString(ctx.sessionId),
          route: resolvedRoute,
          stateKey,
          hadCachedDecision,
          policyJsonProvided: Boolean(params.policyJson),
          work_contract_id: asString(requestedWorkContractId || asRecord(cachedDecision.work_contract).workContractId || asRecord(cachedDecision.work_contract).work_contract_id || cachedDecision.workContractId),
          elapsedMs: Date.now() - dispatchToolStartedAt,
        }, toolLogger(ctx), null).catch(() => undefined);
        if (dispatchWorkContract) {
          metadata.workContractId = dispatchWorkContract.workContractId;
          metadata.work_contract_id = dispatchWorkContract.workContractId;
          const continuationMode = asString(params.continuationMode, dispatchWorkContract.continuity.continuationMode);
          metadata.continuationMode = continuationMode;
          metadata.continuation_mode = continuationMode;
          if (continuationMode === "resume_preferred") {
            const preferred = selectPreferredChildSession(dispatchWorkContract, "resume_preferred");
            if (preferred.selected) {
              metadata.child_session_key = preferred.selected.childSessionKey;
              metadata.childSessionKey = preferred.selected.childSessionKey;
              if (preferred.selected.childSessionId) {
                metadata.child_session_id = preferred.selected.childSessionId;
              }
            }
          }
        }
        if (asString(params.delegateTaskId)) {
          metadata.delegateTaskId = asString(params.delegateTaskId);
          metadata.delegate_task_id = asString(params.delegateTaskId);
        }

        const complexityBand = asString(params.complexityBand || asRecord(cachedDecision)._judge_complexity_band || asRecord(asRecord(cachedDecision).route_decision)._judge_complexity_band);
        const budgetBand = asString(asRecord(cachedDecision._judge_budget_band ?? asRecord(cachedDecision.route_decision)._judge_budget_band));

        // Dynamic model map: reads openclaw models list and maps fallback rank to complexity bands.
        // In-memory cached (5-min TTL). Falls back to hardcoded defaults if CLI unavailable.
        const modelMap = await getModelMap();
        const complexityModelMap = modelMap.complexity as unknown as Record<string, string>;
        const budgetModelMap = modelMap.budget as unknown as Record<string, string>;
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

        const existingNativePlannerRefs = confirmedNativePlannerRefs(dispatchWorkContract);
        if (isDelegatedRoute && dispatchWorkContract && existingNativePlannerRefs) {
          const replaySessionKey = resolveDispatchSessionKey(ctx, metadata, { stateKey, state, cachedDecision })
            || asString(metadata.session_key || managedSessionKey || stateKey);
          const delegateTaskId = asString(dispatchWorkContract?.delegate?.delegateTaskId);
          const attemptId = asString(dispatchWorkContract?.delegate?.currentAttemptId);
          const nextState = {
            ...(state ?? {}),
            prompt: asString(params.task),
            decision: cachedDecision,
            delegated: true,
            dispatchRoute: "delegate",
            dispatchStatus: "already_started",
            dispatchExecuted: true,
            spawnExecuted: true,
            childSessionKey: existingNativePlannerRefs.childSessionKey,
            childRunId: existingNativePlannerRefs.childRunId || existingNativePlannerRefs.runId,
            runId: existingNativePlannerRefs.runId,
            workContractId: dispatchWorkContract.workContractId,
            spawnIntentId: existingNativePlannerRefs.spawnIntentId,
            updatedAt: Date.now(),
          };
          setPolicyStateForContext(ctx, nextState, replaySessionKey || stateKey);
          if (stateKey && replaySessionKey && stateKey !== replaySessionKey) {
            setPolicyStateForContext(ctx, nextState, stateKey);
          }
          await recordPolicyReplay("dispatch_native_spawn_already_started", {
            sessionKey: replaySessionKey,
            sessionId: asString(ctx.sessionId),
            route: "delegate",
            work_contract_id: dispatchWorkContract.workContractId,
            delegate_task_id: delegateTaskId,
            attempt_id: attemptId,
            spawn_intent_id: existingNativePlannerRefs.spawnIntentId,
            run_id: existingNativePlannerRefs.runId,
            child_run_id: existingNativePlannerRefs.childRunId || existingNativePlannerRefs.runId,
            child_session_key: existingNativePlannerRefs.childSessionKey,
            dispatch_executed: true,
            spawn_executed: true,
            materialized: false,
          }, toolLogger(ctx), null);
          return nativePlannerAlreadyStartedResponse({
            workContract: dispatchWorkContract,
            refs: existingNativePlannerRefs,
            workerPool: asString(asRecord(cachedDecision.route_decision).worker_pool),
            model: selectedModel || asString(metadata.model),
          });
        }

        const helperInvoker = readHelperInvoker(asRecord(metadata).helperInvoker, ctx.helperInvoker);
        let schedulerQueueId = "";
        let schedulerDispatchState: "inactive" | "bypassed" | "leased" = "inactive";
        const releaseSchedulerQueue = (outcome: "completed" | "failed" | "cancelled", errorMessage?: string) => {
          if (!schedulerQueueId || schedulerDispatchState !== "leased") return;
          const result = releaseOrComplete({
            queueId: schedulerQueueId,
            outcome,
            errorCode: errorMessage ? outcome : undefined,
            errorMessage,
            terminalSummary: errorMessage,
          });
          if (!result.ok) {
            warnToolLogger(ctx, `scheduler release failed: ${result.error || "unknown_error"}`);
          }
        };

        if (isDelegatedRoute) {
          const spawnBackend = resolveSpawnBackend();
          const plannerSessionCandidates = dispatchPlannerSessionCandidates(
            managedSessionKey,
            stateKey,
            params.sessionKey,
            metadata.session_key,
            initialMetadata.session_key,
            ctx.sessionKey,
            ctx.canonicalSessionKey,
            ctx.sessionId,
            state?.canonicalSessionKey,
            state?.canonical_session_key,
            state?.ackGuardKey,
            state?.ack_guard_key,
            state?.sessionKey,
            state?.session_key,
            asRecord(state?.deliveryTarget).sessionKey,
            asRecord(state?.deliveryTarget).session_key,
            asRecord(state?.delivery_target).sessionKey,
            asRecord(state?.delivery_target).session_key,
          );
          const plannerEnabled = spawnBackend === "planner"
            && plannerSessionCandidates.some((candidate) => isPlannerAllowedForSession(candidate));
          if (spawnBackend === "off") {
            const errorMessage = "spawn_backend_off";
            await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
            return dispatchHonestyFailure({
              route: resolvedRoute,
              error: errorMessage,
              retryable: false,
              terminal: true,
            });
          }

          // Preflight checks the execution backend that dispatch will use. The helperInvoker path
          // is a native execution path, so only probe the dist taskflow port when dispatch will use it.
          if (!plannerEnabled && !helperInvoker) {
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
          const ticketCandidate = buildDelegationTicketDryRun({
            contract: dispatchWorkContract,
            decision: cachedDecision,
            payload: { task: asString(params.task) },
            metadata,
          });
          cachedDecision.delegation_ticket_candidate = asRecord(cachedDecision.delegation_ticket_candidate).ticket_decision
            ? cachedDecision.delegation_ticket_candidate
            : ticketCandidate;
          // Backstop against repeat delegated execution: policyState may know about a recent
          // delegated receipt even when metadata lacks relation_to_recent_execution.
          const recentDelegated = policyState.findRecentDelegated(asString(params.task));
          const recentDelegatedInCurrentContext = Boolean(recentDelegated) && [
            stateKey,
            managedSessionKey,
            asString(params.sessionKey),
            asString(initialMetadata.session_key),
          ].filter(Boolean).includes(asString(recentDelegated?.key));
          const rejectedAsFollowup = ticketCandidate.ticket_decision !== "ticket_would_issue"
            && ticketCandidate.ticket_denial_reason === "not_new_work"
            && hasNonNewWorkFollowupEvidence(cachedDecision, metadata);
          if (recentDelegated && recentDelegatedInCurrentContext && rejectedAsFollowup) {
            const errorMessage = "blocked_by_recent_delegated_execution_guard:recent_delegated_without_new_work_ticket";
            await recordPolicyReplay("dispatch_recent_delegated_blocked", {
              sessionKey: managedSessionKey,
              sessionId: asString(ctx.sessionId),
              route: resolvedRoute,
              error: errorMessage,
              recent_delegated_key: recentDelegated.key,
              ticket_decision: ticketCandidate.ticket_decision,
              ticket_denial_reason: ticketCandidate.ticket_denial_reason,
              dispatch_executed: false,
              spawn_executed: false,
              materialized: false,
              retryable: false,
              terminal: true,
            }, toolLogger(ctx), cachedDecision);
            await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
            return dispatchHonestyFailure({
              route: resolvedRoute,
              error: errorMessage,
              retryable: false,
              terminal: true,
              details: {
                rejected: true,
                rejection_reason: "recent_delegated_without_new_work_ticket",
                recent_delegated_key: recentDelegated.key,
                dispatch_executed: false,
                spawn_executed: false,
                materialized: false,
              },
            });
          }
          if (plannerEnabled) {
            if (ticketCandidate.ticket_decision !== "ticket_would_issue") {
              const errorMessage = `delegation_ticket_rejected:${ticketCandidate.ticket_denial_reason || "not_new_work"}`;
              await recordPolicyReplay("dispatch_planner_ticket_rejected", {
                sessionKey: managedSessionKey,
                sessionId: asString(ctx.sessionId),
                route: resolvedRoute,
                error: errorMessage,
                ticket_decision: ticketCandidate.ticket_decision,
                ticket_denial_reason: ticketCandidate.ticket_denial_reason,
                dispatch_executed: false,
                spawn_executed: false,
                materialized: false,
                terminal: true,
              }, toolLogger(ctx), cachedDecision);
              await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
              return dispatchHonestyFailure({
                route: resolvedRoute,
                error: errorMessage,
                retryable: false,
                terminal: true,
                details: {
                  rejected: true,
                  rejection_reason: ticketCandidate.ticket_denial_reason || "not_new_work",
                  ticket_decision: ticketCandidate.ticket_decision,
                  dispatch_executed: false,
                  spawn_executed: false,
                  materialized: false,
                },
              });
            }

            const workContractId = dispatchWorkContract?.workContractId
              || asString(ticketCandidate.work_contract_id)
              || asString(asRecord(cachedDecision.work_contract).workContractId);
            if (!workContractId) {
              const errorMessage = "planner_requires_work_contract";
              await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
              return dispatchHonestyFailure({ route: resolvedRoute, error: errorMessage, retryable: false, terminal: true });
            }

            const ticketCandidateRecord = ticketCandidate as unknown as UnknownRecord;
            const delegateTaskId = plannedDelegateTaskId(workContractId, ticketCandidateRecord, dispatchWorkContract);
            const attemptId = plannedAttemptId(delegateTaskId, ticketCandidateRecord, dispatchWorkContract);
            const sessionsSpawnArgs = buildPlannerSessionsSpawnArgs({
              task: asString(params.task),
              workContractId,
              delegateTaskId,
              attemptId,
              expectedDeliverable: asString(ticketCandidate.expected_deliverable),
              selectedModel,
              cwd: asString(params.cwd, ctxCwd(ctx)),
              expectedSeconds,
              timeoutSeconds: asNumber(params.timeoutSeconds),
              preferredChildSessionKey: asString(metadata.childSessionKey || metadata.child_session_key)
                || dispatchWorkContract?.continuity.preferredChildSessionKey
                || undefined,
              label: asString(asRecord(dispatchWorkContract?.mainContext).summary || params.task),
              decision: cachedDecision,
              metadata,
              workContract: dispatchWorkContract,
            });
            let intent: ReturnType<typeof nativeSpawnIntentStore.create>;
            try {
              intent = nativeSpawnIntentStore.create({
                workContractId,
                delegateTaskId,
                attemptId,
                sessionKey: managedSessionKey || stateKey || asString(params.sessionKey),
                sessionsSpawnArgs: sessionsSpawnArgs as { task: string; [key: string]: unknown },
                ttlMs: resolveSpawnIntentTtlMs(),
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const errorMessage = message.includes("SQLITE") || message.includes("sqlite")
                ? "native_spawn_intent_store_unavailable"
                : "native_spawn_intent_create_failed";
              await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
              return dispatchHonestyFailure({ route: resolvedRoute, error: errorMessage, retryable: true, terminal: false });
            }

            const nextState = {
              ...(state ?? {}),
              prompt: asString(params.task),
              decision: cachedDecision,
              delegated: false,
              dispatchRoute: "delegate",
              dispatchStatus: "requires_native_spawn",
              dispatchExecuted: false,
              spawnExecuted: false,
              spawnIntentId: intent.spawnIntentId,
              workContractId,
              updatedAt: Date.now(),
            };
            setPolicyStateForContext(ctx, nextState, managedSessionKey || stateKey);
            if (stateKey && managedSessionKey && stateKey !== managedSessionKey) {
              setPolicyStateForContext(ctx, nextState, stateKey);
            }
            await recordPolicyReplay("dispatch_planner_intent_created", {
              sessionKey: managedSessionKey,
              sessionId: asString(ctx.sessionId),
              route: resolvedRoute,
              work_contract_id: workContractId,
              delegate_task_id: delegateTaskId,
              attempt_id: attemptId,
              spawn_intent_id: intent.spawnIntentId,
              canonical_args_hash: intent.canonicalArgsHash,
              expires_at: intent.expiresAt,
              dispatch_executed: false,
              spawn_executed: false,
              materialized: false,
              elapsedMs: Date.now() - dispatchToolStartedAt,
            }, toolLogger(ctx), null);
            return plannerDispatchResponse({
              spawnIntentId: intent.spawnIntentId,
              workContractId,
              delegateTaskId,
              attemptId,
              sessionsSpawnArgs,
              canonicalArgsHash: intent.canonicalArgsHash,
              expiresAt: intent.expiresAt,
              workerPool: asString(asRecord(cachedDecision.route_decision).worker_pool),
              model: selectedModel || asString(metadata.model),
            });
          }

          const ticketAdmission = admitDelegationTicketForDispatch({
            contract: dispatchWorkContract,
            candidate: ticketCandidate,
            delegateTaskId: asString(params.delegateTaskId),
            workerPool: asString(asRecord(cachedDecision.route_decision).worker_pool),
            modelProfile: selectedModel || asString(metadata.model),
          });
          if (!ticketAdmission.allowed) {
            const errorMessage = `delegation_ticket_rejected:${ticketAdmission.reason}`;
            await recordPolicyReplay("dispatch_ticket_rejected", {
              sessionKey: managedSessionKey,
              sessionId: asString(ctx.sessionId),
              route: resolvedRoute,
              error: errorMessage,
              ticket_decision: ticketCandidate.ticket_decision,
              ticket_denial_reason: ticketAdmission.reason,
              is_new_work: ticketCandidate.is_new_work,
              expected_deliverable: ticketCandidate.expected_deliverable,
              work_contract_id: ticketAdmission.work_contract_id ?? ticketCandidate.work_contract_id ?? null,
              ticket_id: ticketAdmission.ticket_id ?? ticketCandidate.ticket_id ?? null,
              dispatch_executed: false,
              spawn_executed: false,
              materialized: false,
              retryable: ticketAdmission.reason === "ledger_unavailable",
              terminal: ticketAdmission.reason !== "ledger_unavailable",
            }, toolLogger(ctx), cachedDecision);
            await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
            return dispatchHonestyFailure({
              route: resolvedRoute,
              error: errorMessage,
              retryable: ticketAdmission.reason === "ledger_unavailable",
              terminal: ticketAdmission.reason !== "ledger_unavailable",
              details: {
                rejected: true,
                rejection_reason: ticketAdmission.reason,
                ticket_decision: ticketCandidate.ticket_decision,
                ticket_denial_reason: ticketAdmission.reason,
                is_new_work: ticketCandidate.is_new_work,
                expected_deliverable: ticketCandidate.expected_deliverable,
                work_contract_id: ticketAdmission.work_contract_id ?? ticketCandidate.work_contract_id ?? null,
                ticket_id: ticketAdmission.ticket_id ?? ticketCandidate.ticket_id ?? null,
                dispatch_executed: false,
                spawn_executed: false,
                materialized: false,
              },
            });
          }
          if (ticketAdmission.enforced) {
            metadata.delegation_ticket_id = ticketAdmission.ticket_id;
            metadata.delegateTaskId = ticketAdmission.delegate_task_id;
            metadata.delegate_task_id = ticketAdmission.delegate_task_id;
            metadata.attemptId = ticketAdmission.attempt_id;
            metadata.attempt_id = ticketAdmission.attempt_id;
            schedulerQueueId = asString(ticketAdmission.queue_id);
            if (runtimeLedgerMode === "enforce") {
              if (!isSchedulerEnabled()) {
                const errorMessage = "blocked_by_scheduler_mandatory:scheduler_not_enabled";
                warnToolLogger(ctx, "OCTOCLAW_SCHEDULER_ENABLED is false; blocking dispatch because scheduler gating is mandatory in enforce mode");
                await recordPolicyReplay("dispatch_scheduler_mandatory_blocked", {
                  sessionKey: managedSessionKey,
                  sessionId: asString(ctx.sessionId),
                  route: resolvedRoute,
                  queue_id: schedulerQueueId || null,
                  work_contract_id: ticketAdmission.work_contract_id ?? null,
                  attempt_id: ticketAdmission.attempt_id ?? null,
                  reason: "scheduler_not_enabled",
                  dispatch_executed: false,
                  spawn_executed: false,
                  materialized: false,
                  retryable: false,
                  terminal: true,
                }, toolLogger(ctx), cachedDecision);
                await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
                return dispatchHonestyFailure({
                  route: resolvedRoute,
                  error: errorMessage,
                  retryable: false,
                  terminal: true,
                  details: {
                    status: "blocked_by_scheduler_mandatory",
                    scheduler_status: "blocked_by_scheduler_mandatory",
                    queue_id: schedulerQueueId || null,
                    work_contract_id: ticketAdmission.work_contract_id ?? null,
                    attempt_id: ticketAdmission.attempt_id ?? null,
                    reason: "scheduler_not_enabled",
                    dispatch_executed: false,
                    spawn_executed: false,
                    materialized: false,
                  },
                });
              } else if (!schedulerQueueId) {
                const errorMessage = "blocked_by_scheduler:missing_queue_id";
                await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
                return dispatchHonestyFailure({
                  route: resolvedRoute,
                  error: errorMessage,
                  retryable: false,
                  terminal: true,
                  details: {
                    status: "blocked_by_scheduler",
                    scheduler_status: "blocked_by_scheduler",
                    queue_id: null,
                    dispatch_executed: false,
                    spawn_executed: false,
                    materialized: false,
                  },
                });
              } else {
                const promoted = promoteToQueued({ queueId: schedulerQueueId, contract: dispatchWorkContract });
                if (!promoted.ok) {
                  const schedulerStatus = promoted.queueStatus === "blocked" ? "blocked_by_scheduler" : "blocked_by_scheduler";
                  const errorMessage = `${schedulerStatus}:${promoted.blockedReason || promoted.error || promoted.queueStatus}`;
                  await recordPolicyReplay("dispatch_scheduler_blocked", {
                    sessionKey: managedSessionKey,
                    sessionId: asString(ctx.sessionId),
                    route: resolvedRoute,
                    queue_id: schedulerQueueId,
                    queue_status: promoted.queueStatus,
                    blocked_by: promoted.blockedBy ?? null,
                    blocked_reason: promoted.blockedReason ?? promoted.error ?? null,
                    dispatch_executed: false,
                    spawn_executed: false,
                    materialized: false,
                  }, toolLogger(ctx), cachedDecision);
                  await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
                  return dispatchHonestyFailure({
                    route: resolvedRoute,
                    error: errorMessage,
                    retryable: promoted.error === "ledger_unavailable",
                    terminal: promoted.error !== "ledger_unavailable",
                    details: {
                      status: "blocked_by_scheduler",
                      scheduler_status: "blocked_by_scheduler",
                      queue_id: schedulerQueueId,
                      queue_status: promoted.queueStatus,
                      blocked_by: promoted.blockedBy ?? null,
                      blocked_reason: promoted.blockedReason ?? promoted.error ?? null,
                      dispatch_executed: false,
                      spawn_executed: false,
                      materialized: false,
                    },
                  });
                }
                const schedulerConfig = resolveSchedulerConfig();
                const lease = tryAcquireLease({
                  queueId: schedulerQueueId,
                  leaseOwner: `octoclaw_dispatch:${asString(ctx.sessionId, managedSessionKey) || process.pid}`,
                  maxConcurrentSpawns: schedulerConfig.maxConcurrentSpawns,
                  leaseDurationMs: schedulerConfig.leaseDurationMs,
                });
                if (!lease.acquired || lease.queueId !== schedulerQueueId) {
                  const errorMessage = `queued_not_leased:${lease.reason || (lease.queueId && lease.queueId !== schedulerQueueId ? "different_queue_leased" : "unknown")}`;
                  await recordPolicyReplay("dispatch_scheduler_not_leased", {
                    sessionKey: managedSessionKey,
                    sessionId: asString(ctx.sessionId),
                    route: resolvedRoute,
                    queue_id: schedulerQueueId,
                    leased_queue_id: lease.queueId ?? null,
                    reason: lease.reason ?? null,
                    blocked_by: lease.blockedBy ?? null,
                    blocked_reason: lease.blockedReason ?? null,
                    dispatch_executed: false,
                    spawn_executed: false,
                    materialized: false,
                  }, toolLogger(ctx), cachedDecision);
                  if (lease.acquired && lease.queueId && lease.queueId !== schedulerQueueId) {
                    const releaseResult = releaseOrComplete({
                      queueId: lease.queueId,
                      outcome: "cancelled",
                      errorCode: "unexpected_lease_owner",
                      errorMessage: `dispatch acquired ${lease.queueId} while waiting for ${schedulerQueueId}`,
                    });
                    if (!releaseResult.ok) warnToolLogger(ctx, `scheduler unexpected lease release failed: ${releaseResult.error || "unknown_error"}`);
                  }
                  await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
                  return dispatchHonestyFailure({
                    route: resolvedRoute,
                    error: errorMessage,
                    retryable: true,
                    terminal: false,
                    details: {
                      status: "queued_not_leased",
                      scheduler_status: "queued_not_leased",
                      queue_id: schedulerQueueId,
                      leased_queue_id: lease.queueId ?? null,
                      blocked_by: lease.blockedBy ?? null,
                      blocked_reason: lease.blockedReason ?? lease.reason ?? null,
                      dispatch_executed: false,
                      spawn_executed: false,
                      materialized: false,
                    },
                  });
                }
                schedulerDispatchState = "leased";
                metadata.scheduler_queue_id = schedulerQueueId;
                metadata.scheduler_status = "leased";
              }
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
            releaseSchedulerQueue("failed", errorMessage);
            return dispatchHonestyFailure({
              route: resolvedRoute,
              error: errorMessage,
              sealMismatch: false,
              retryable: true,
            });
          }
          await recordDispatchTerminalFailure(errorMessage, { route: asString(payload.route, resolvedRoute) });
          if (dispatchWorkContract) {
            materializeWorkContractFailure({
              workContractId: dispatchWorkContract.workContractId,
              errorMessage,
              nativeBinding: dispatchWorkContract.delegate?.nativeBinding ?? undefined,
            });
          }
          try {
            void emitExecutionTransitionNotification({
              transitionKind: "spawn_failed",
              projection: buildMinimalProjection({
                taskId: asString(payload.delegateTaskId || payload.task_id || dispatchWorkContract?.workContractId || ""),
                status: "failed",
                dispatchExecuted: true,
                spawnExecuted: false,
                resultMaterialized: false,
              }),
              attemptId: asString(payload.attemptId || ""),
              workContractId: dispatchWorkContract?.workContractId ?? "",
              sessionKey: stateKey,
              stateKey,
            });
          } catch (_) { }
          releaseSchedulerQueue("failed", errorMessage);
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
        const delegationTicketDryRun = buildDelegationTicketDryRun({
          contract: dispatchWorkContract,
          decision: authoritativeDecision,
          payload,
          metadata,
        });
        authoritativeDecision.delegation_ticket_candidate = asRecord(authoritativeDecision.delegation_ticket_candidate).ticket_decision
          ? authoritativeDecision.delegation_ticket_candidate
          : delegationTicketDryRun;
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
            ticket_decision: delegationTicketDryRun.ticket_decision,
            ticket_denial_reason: delegationTicketDryRun.ticket_denial_reason,
            is_new_work: delegationTicketDryRun.is_new_work,
            expected_deliverable: delegationTicketDryRun.expected_deliverable,
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
        const payloadRuntimeTruth = asRecord(payload.runtime_truth);
        const payloadNativeTaskBinding = asRecord(payloadRuntimeTruth.nativeTaskBinding);
        const payloadDelegateAttempt = asRecord(payloadRuntimeTruth.delegateAttempt);
        const payloadNativeAttemptBinding = asRecord(payloadDelegateAttempt.nativeBinding);
        const materializedNativeTaskId = optionalString(
          payloadNativeTaskBinding.nativeTaskId,
          payloadNativeAttemptBinding.nativeTaskId,
          materialization.task_id,
          payload.task_id,
        );
        const materializedNativeFlowId = optionalString(
          payloadNativeTaskBinding.nativeFlowId,
          payloadNativeAttemptBinding.nativeFlowId,
          materialization.flow_id,
          payload.flow_id,
        );
        void summary;
        void compactDispatchDetails;
        const finalRoute = normalizeLiveRoute(payload.route, resolvedRoute);
        const finalDecisionRoute = asRecord(authoritativeDecision.route_decision);
        const workerPool = asString(finalDecisionRoute.worker_pool || payload.worker_pool);
        const taskClass = asString(finalDecisionRoute.task_class || finalDecisionRoute.judge_role || finalDecisionRoute.role);
        const nativeBinding = dispatchWorkContract?.delegate?.nativeBinding;
        let spawnEvidence = dispatchSpawnEvidence({
          payloadRuntimeTruth,
          payloadNativeTaskBinding,
          payloadDelegateAttempt,
          payloadNativeAttemptBinding,
          nativeBinding,
        });
        const materialized = Boolean(asString(materialization.task_id) || materializedNativeTaskId || materializedNativeFlowId);
        const dispatchExecuted = materialized;
        const delegateTaskId = asString(payload.delegateTaskId || materialization.delegateTaskId || materialization.task_id || payload.task_id);
        const workContractIdForDispatch = (dispatchWorkContract?.workContractId ?? asString(authoritativeDecision.workContractId)) || "";
        const preferredChildSessionKeyForSpawn = asString(metadata.childSessionKey || metadata.child_session_key)
          || dispatchWorkContract?.continuity.preferredChildSessionKey
          || undefined;
        if (finalRoute === "delegate" && materialized && !spawnEvidence.spawnExecuted) {
          const runtimeSpawn = await trySpawnSubagentRuntime({
            runtime: options.subagentRuntime ?? asRecord(ctx.runtime).subagent as OpenClawSubagentRuntime | undefined,
            task: asString(params.task),
            ctx,
            metadata,
            delegateTaskId,
            workContractId: workContractIdForDispatch,
            selectedModel,
            idempotencyKey: stableId("octoclaw-child-run", [delegateTaskId, materializedNativeFlowId ?? "", asString(metadata.message_id), asString(params.task)]),
            preferredChildSessionKey: preferredChildSessionKeyForSpawn,
          });
          if (runtimeSpawn.spawnExecuted) {
            spawnEvidence = {
              spawnExecuted: true,
              runId: runtimeSpawn.runId,
              childRunId: runtimeSpawn.childRunId,
              childSessionKey: runtimeSpawn.childSessionKey,
              childSessionId: runtimeSpawn.childSessionKey,
            };
            payloadRuntimeTruth.evidence = {
              ...asRecord(payloadRuntimeTruth.evidence),
              spawnExecuted: true,
              spawn_executed: true,
              runId: runtimeSpawn.runId,
              run_id: runtimeSpawn.runId,
              childRunId: runtimeSpawn.childRunId,
              child_run_id: runtimeSpawn.childRunId,
              childSessionKey: runtimeSpawn.childSessionKey,
              child_session_key: runtimeSpawn.childSessionKey,
              childSessionId: runtimeSpawn.childSessionKey,
              child_session_id: runtimeSpawn.childSessionKey,
              sessionReused: runtimeSpawn.sessionReused || false,
              session_reused: runtimeSpawn.sessionReused || false,
              sessionReuseReason: runtimeSpawn.sessionReuseReason || "",
              session_reuse_reason: runtimeSpawn.sessionReuseReason || "",
            };
            payloadNativeTaskBinding.spawnExecuted = true;
            payloadNativeTaskBinding.spawn_executed = true;
            payloadNativeTaskBinding.runId = runtimeSpawn.runId;
            payloadNativeTaskBinding.childRunId = runtimeSpawn.childRunId;
            payloadNativeTaskBinding.childSessionKey = runtimeSpawn.childSessionKey;
            payloadNativeTaskBinding.childSessionId = runtimeSpawn.childSessionKey;
            if (schedulerQueueId && schedulerDispatchState === "leased") {
              const materializeResult = materializeNativeIds({
                queueId: schedulerQueueId,
                nativeFlowId: materializedNativeFlowId,
                nativeTaskId: materializedNativeTaskId,
                childSessionKey: runtimeSpawn.childSessionKey,
                childRunId: runtimeSpawn.childRunId,
              });
              if (!materializeResult.ok) {
                warnToolLogger(ctx, `scheduler materialize failed: ${materializeResult.error || "unknown_error"}`);
              }
            }
          } else if (runtimeSpawn.error) {
            payloadRuntimeTruth.spawn_error = runtimeSpawn.error;
            releaseSchedulerQueue("failed", runtimeSpawn.error);
          }
        }
        const executionState = finalRoute === "delegate"
          ? spawnEvidence.spawnExecuted
            ? "spawn_confirmed"
            : materialized
              ? "materialized_no_spawn"
              : "not_materialized"
          : payload.executed === true ? "executed" : "planned";
        const materializedAt = new Date().toISOString();
        const nativeSubstrateState = asString(materialization.substrate_state);
        const projectedSubstrateState = spawnEvidence.spawnExecuted
          ? nativeSubstrateState && nativeSubstrateState !== "queued" ? nativeSubstrateState : "running"
          : "queued";
        const childSessionKey = spawnEvidence.childSessionKey || nativeBinding?.childSessionKey || dispatchWorkContract?.continuity.preferredChildSessionKey || undefined;
        if (asString(materialization.task_id) || workContractIdForDispatch) {
          await upsertTaskStateCache({
            id: workContractIdForDispatch || asString(materialization.task_id),
            workContractId: workContractIdForDispatch || undefined,
            work_contract_id: workContractIdForDispatch || undefined,
            taskId: asString(materialization.task_id) || materializedNativeTaskId || undefined,
            task_id: asString(materialization.task_id) || materializedNativeTaskId || undefined,
            nativeTaskId: materializedNativeTaskId || asString(materialization.task_id) || undefined,
            native_task_id: materializedNativeTaskId || asString(materialization.task_id) || undefined,
            flowId: materializedNativeFlowId || asString(materialization.flow_id) || undefined,
            flow_id: materializedNativeFlowId || asString(materialization.flow_id) || undefined,
            nativeFlowId: materializedNativeFlowId || asString(materialization.flow_id) || undefined,
            native_flow_id: materializedNativeFlowId || asString(materialization.flow_id) || undefined,
            sessionKey: replaySessionKey,
            session_key: replaySessionKey,
            deliveryTarget: asRecord(metadata.delivery_target || state?.deliveryTarget || state?.delivery_target),
            delivery_target: asRecord(metadata.delivery_target || state?.deliveryTarget || state?.delivery_target),
            replyToMessageId: dispatchReplyToMessageId(metadata, state, ctx) || undefined,
            reply_to_message_id: dispatchReplyToMessageId(metadata, state, ctx) || undefined,
            route: asString(payload.route),
            status: projectedSubstrateState,
            summary: spawnEvidence.spawnExecuted
              ? asString(asRecord(payload.handoff).summary || payload.summary)
              : "TaskFlow materialized; child session spawn not confirmed",
            role: asString(asRecord(authoritativeDecision.route_decision).task_class),
            workerPool,
            worker_pool: workerPool,
            title: truncateText(asString(asRecord(dispatchWorkContract?.mainContext).summary || dispatchWorkContract?.userAsk || params.task), 160),
            complexityBand: complexityBand || undefined,
            complexity_band: complexityBand || undefined,
            model: selectedModel || asString(metadata.model),
            modelProfile: selectedModel || asString(metadata.model),
            model_profile: selectedModel || asString(metadata.model),
            materialized_at: materializedAt,
            spawned_at: spawnEvidence.spawnExecuted ? materializedAt : undefined,
            started_at: spawnEvidence.spawnExecuted ? materializedAt : undefined,
            updated_at: materializedAt,
            updatedAt: materializedAt,
            dispatchExecuted,
            dispatch_executed: dispatchExecuted,
            spawnExecuted: spawnEvidence.spawnExecuted,
            spawn_executed: spawnEvidence.spawnExecuted,
            resultMaterialized: false,
            result_materialized: false,
            childSessionKey: childSessionKey || undefined,
            child_session_key: childSessionKey || undefined,
            runId: spawnEvidence.runId || undefined,
            run_id: spawnEvidence.runId || undefined,
            childRunId: spawnEvidence.childRunId || undefined,
            child_run_id: spawnEvidence.childRunId || undefined,
          } as RuntimeTaskStateRecord);
        }
        if (dispatchWorkContract) {
          const revision = asNumber(materialization.substrate_revision) ?? nativeBinding?.revision ?? 1;
          const nextNativeBinding: NativeBindingRef = {
            ...(nativeBinding ?? {}),
            flowId: materializedNativeFlowId ?? nativeBinding?.flowId ?? asString(materialization.flow_id, "unknown"),
            nativeFlowId: materializedNativeFlowId ?? nativeBinding?.nativeFlowId,
            ownerKey: nativeBinding?.ownerKey ?? dispatchWorkContract.delegate?.delegateTaskId ?? dispatchWorkContract.workContractId,
            controllerId: nativeBinding?.controllerId ?? "octoclaw.delegate",
            revision,
            expectedRevision: revision,
            taskId: materializedNativeTaskId ?? nativeBinding?.taskId,
            nativeTaskId: materializedNativeTaskId ?? nativeBinding?.nativeTaskId,
            runId: spawnEvidence.runId || nativeBinding?.runId,
            childRunId: spawnEvidence.childRunId || nativeBinding?.childRunId,
            childSessionKey,
            syncMode: nativeBinding?.syncMode ?? "managed",
            status: nativeFlowStatusFromSubstrate(projectedSubstrateState),
            lastMutation: nativeBinding?.lastMutation ?? "createManaged",
            lastMutationApplied: true,
          };
          materializeWorkContractSuccess({
            workContractId: dispatchWorkContract.workContractId,
            nativeBinding: nextNativeBinding,
            delegateTaskId: asString(payload.delegateTaskId || materialization.delegateTaskId || materialization.task_id || payload.task_id),
            attemptId: asString(payload.attemptId || materialization.attemptId),
            nativeTaskId: materializedNativeTaskId,
            nativeFlowId: materializedNativeFlowId,
            childSessionKey,
            childSessionId: spawnEvidence.childSessionId || undefined,
            runId: spawnEvidence.runId || undefined,
            substrateState: projectedSubstrateState,
            spawnExecuted: spawnEvidence.spawnExecuted,
            resultMaterialized: false,
            deliveryStatus: "none",
          });
        }
        const statePatch = {
          dispatchExecuted,
          spawnExecuted: spawnEvidence.spawnExecuted,
          dispatchStatus: executionState,
          executionState,
          latestAnomalyNotice: finalRoute === "delegate" && materialized && !spawnEvidence.spawnExecuted
            ? {
              kind: "spawn_not_confirmed",
              severity: "error",
              taskId: delegateTaskId,
              nativeTaskId: materializedNativeTaskId ?? null,
              nativeFlowId: materializedNativeFlowId ?? null,
              workContractId: (dispatchWorkContract?.workContractId ?? asString(authoritativeDecision.workContractId)) || null,
              message: "Native TaskFlow was materialized, but no child session/run evidence confirmed subagent start.",
              createdAt: materializedAt,
            }
            : undefined,
          updatedAt: Date.now(),
        };
        setPolicyStateForContext(ctx, { ...nextState, ...statePatch }, replaySessionKey || stateKey);
        if (stateKey && replaySessionKey && stateKey !== replaySessionKey) {
          setPolicyStateForContext(ctx, { ...nextState, ...statePatch }, stateKey);
        }
        try {
          const baseProjection = buildMinimalProjection({
            taskId: delegateTaskId,
            status: spawnEvidence.spawnExecuted ? "running" : "queued",
            dispatchExecuted,
            spawnExecuted: spawnEvidence.spawnExecuted,
            resultMaterialized: false,
            modelId: selectedModel || asString(metadata.model),
            backend: "octoclaw.delegate",
            childSessionKey,
            runId: spawnEvidence.runId,
            childRunId: spawnEvidence.childRunId,
            latestAnomalyNotice: statePatch.latestAnomalyNotice,
          });
          const attemptId = asString(payload.attemptId || materialization.attemptId);
          const workContractId = workContractIdForDispatch;
          const replyToMessageId = dispatchReplyToMessageId(metadata, state, ctx);
          const notifyParams = {
            projection: baseProjection,
            attemptId,
            workContractId: workContractId || "",
            sessionKey: replaySessionKey || stateKey,
            stateKey: replaySessionKey || stateKey,
            decision: authoritativeDecision as Record<string, unknown>,
            replyToMessageId: replyToMessageId || undefined,
            occurredAt: materializedAt,
          };
          if (materialized) {
            void emitExecutionTransitionNotification({
              ...notifyParams,
              transitionKind: "dispatch_materialized",
            });
            if (spawnEvidence.spawnExecuted) {
              void emitExecutionTransitionNotification({
                ...notifyParams,
                transitionKind: "spawn_started",
              });
              try {
                createCompletionBinding({
                  workContractId: workContractId || "",
                  attemptId,
                  expectedDelegateTaskId: delegateTaskId,
                  expectedPath: resolveWorkerCompletionPath(workContractId || ""),
                  expectedNativeTaskId: materializedNativeTaskId || undefined,
                  expectedChildSessionKey: childSessionKey || undefined,
                });
              } catch (_bindingError) {
                void recordPolicyReplay("completion_binding_pre_create_failed", { workContractId, error: String(_bindingError) }, toolLogger(ctx));
              }
              scheduleChildCompletionFinalizer({
                childSessionKey: childSessionKey || "",
                delegateTaskId,
                workContractId,
                parentSessionKey: replaySessionKey || stateKey,
                replyToMessageId: replyToMessageId || undefined,
                deliveryTarget: asRecord(metadata.delivery_target || state?.deliveryTarget || state?.delivery_target),
                nativeTaskId: materializedNativeTaskId,
                nativeFlowId: materializedNativeFlowId,
                runId: spawnEvidence.runId,
                childRunId: spawnEvidence.childRunId,
                modelId: selectedModel || asString(metadata.model),
                cwd: ctxCwd(ctx),
                timeoutMs: Math.max(600_000, (expectedSeconds > 0 ? expectedSeconds * 1000 + 120_000 : 0)),
                logger: toolLogger(ctx),
                onSuccess: schedulerQueueId && schedulerDispatchState === "leased"
                  ? () => {
                      const result = releaseOrComplete({ queueId: schedulerQueueId, outcome: "completed" });
                      if (!result.ok) warnToolLogger(ctx, `scheduler completion release failed: ${result.error || "unknown_error"}`);
                    }
                  : undefined,
              });
            } else {
              releaseSchedulerQueue("failed", "spawn_not_confirmed");
              void emitExecutionTransitionNotification({
                ...notifyParams,
                transitionKind: "materialized_no_spawn",
              });
            }
          }
        } catch (_) { }
        if (finalRoute === "delegate" && materialized && !spawnEvidence.spawnExecuted) {
          return dispatchHonestyFailure({
            route: finalRoute,
            error: "spawn_not_confirmed",
            retryable: true,
            terminal: false,
            details: {
              materialized: true,
              execution_state: executionState,
              delegation_method: "octoclaw_dispatch",
              work_contract_id: workContractIdForDispatch || null,
              delegate_task_id: delegateTaskId || null,
              attempt_id: asString(payload.attemptId || materialization.attemptId) || null,
              dispatch_executed: dispatchExecuted,
              spawn_executed: false,
              native_task_id: materializedNativeTaskId ?? null,
              native_flow_id: materializedNativeFlowId ?? null,
              result_materialized: false,
              delivery_status: null,
              user_message: "已登记到 Native TaskFlow，但没有子会话/runId 证据，不能视为已启动子 agent；请重试派发或改为主会话直接处理。",
            },
          });
        }
        return dispatchHonestySuccess({
          route: finalRoute,
          workerPool,
          taskId: delegateTaskId,
          taskClass,
          workContractId: dispatchWorkContract?.workContractId ?? asString(authoritativeDecision.workContractId),
          delegateTaskId,
          attemptId: asString(payload.attemptId || materialization.attemptId),
          childSessionKey: childSessionKey ?? null,
          childSessionId: (spawnEvidence.childSessionId || dispatchWorkContract?.continuity.preferredChildSessionId) ?? null,
          runId: spawnEvidence.runId || null,
          childRunId: spawnEvidence.childRunId || null,
          materialized,
          executionState,
          dispatchExecuted,
          spawnExecuted: spawnEvidence.spawnExecuted,
          nativeTaskId: materializedNativeTaskId,
          nativeFlowId: materializedNativeFlowId,
          resultMaterialized: false,
          deliveryStatus: null,
        });
      },
    },
    {
      name: "octoclaw_dispatch_confirm",
      label: "OctoClaw Dispatch Confirm",
      description: "Confirm native sessions_spawn acceptance for an OctoClaw planner intent. Records native refs only after accepted run evidence exists.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          spawnIntentId: { type: "string", description: "spawnIntentId returned by octoclaw_dispatch." },
          workContractId: { type: "string", description: "WorkContract id returned by octoclaw_dispatch." },
          sessionsSpawnStatus: { type: "string", description: "Native sessions_spawn status, usually accepted or error." },
          runId: { type: "string", description: "Native runId returned by sessions_spawn. Required when accepted." },
          childRunId: { type: "string", description: "Optional child run id if distinct from runId." },
          childSessionKey: { type: "string", description: "Optional native child session key." },
          sessionsSpawnResultJson: { type: "string", description: "Optional raw sessions_spawn result JSON for status/error/child refs; accepted runId must be passed as top-level runId." },
          error: { type: "string", description: "Native spawn error if sessionsSpawnStatus is not accepted." },
        },
        required: ["spawnIntentId", "workContractId", "sessionsSpawnStatus"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const resultJson = parseObjectJson(params.sessionsSpawnResultJson);
        const status = asString(params.sessionsSpawnStatus || resultJson.status);
        const runId = asString(params.runId);
        const childRunId = asString(params.childRunId || resultJson.childRunId || resultJson.child_run_id || runId);
        const childSessionKey = asString(params.childSessionKey || resultJson.childSessionKey || resultJson.child_session_key);
        const { key: stateKey, state } = resolveToolPolicyContext(ctx, "");
        const decision = asRecord(state?.decision);
        const replayDecision = Object.keys(decision).length > 0 ? decision : null;
        const sessionKey = asString(asRecord(decision.request).session_key)
          || asString(ctx.sessionKey || ctx.canonicalSessionKey || stateKey);
        const confirmed = await confirmNativeSpawn({
          spawnIntentId: asString(params.spawnIntentId),
          workContractId: asString(params.workContractId),
          sessionKey,
          stateKey,
          sessionsSpawnStatus: status,
          runId,
          childRunId,
          childSessionKey,
          error: asString(params.error || resultJson.error),
          modelId: asString(resultJson.model || resultJson.modelId),
          replyToMessageId: dispatchReplyToMessageId({}, state, ctx) || undefined,
          cwd: ctxCwd(ctx),
          decision,
        });
        await recordPolicyReplay("dispatch_confirm_completed", {
          sessionKey,
          stateKey,
          sessionId: asString(ctx.sessionId),
          spawn_intent_id: asString(params.spawnIntentId),
          work_contract_id: asString(params.workContractId),
          sessions_spawn_status: status,
          ok: confirmed.ok,
          confirm_status: confirmed.status,
          error: asString(confirmed.error),
          run_id: asString(confirmed.runId),
          child_run_id: asString(confirmed.childRunId),
          child_session_key: asString(confirmed.childSessionKey),
          ack_sent: confirmed.ackSent === true,
          ack_skipped: confirmed.ackSkipped === true,
        }, toolLogger(ctx), replayDecision);
        if (confirmed.ok) {
          const confirmedAt = new Date().toISOString();
          const updatedContract = loadWorkContract(confirmed.workContractId);
          await upsertTaskStateCache({
            id: confirmed.workContractId,
            workContractId: confirmed.workContractId,
            work_contract_id: confirmed.workContractId,
            route: "delegate",
            status: "running",
            sessionKey,
            session_key: sessionKey,
            flow_id: asString(updatedContract?.delegate?.nativeBinding?.flowId) || (confirmed.runId ? `sessions_spawn:${confirmed.runId}` : ""),
            runId: confirmed.runId || undefined,
            run_id: confirmed.runId || undefined,
            childRunId: confirmed.childRunId || undefined,
            child_run_id: confirmed.childRunId || undefined,
            childSessionKey: confirmed.childSessionKey || undefined,
            child_session_key: confirmed.childSessionKey || undefined,
            dispatchExecuted: true,
            dispatch_executed: true,
            spawnExecuted: true,
            spawn_executed: true,
            resultMaterialized: false,
            result_materialized: false,
            spawned_at: confirmedAt,
            started_at: confirmedAt,
            updatedAt: confirmedAt,
            updated_at: confirmedAt,
            ...(updatedContract ? { workContract: updatedContract, work_contract: updatedContract } : {}),
          });
          const nextState = {
            ...(state ?? {}),
            delegated: true,
            dispatchRoute: "delegate",
            dispatchStatus: "spawn_confirmed",
            dispatchExecuted: true,
            dispatch_executed: true,
            spawnExecuted: true,
            spawn_executed: true,
            spawnIntentId: confirmed.spawnIntentId,
            spawn_intent_id: confirmed.spawnIntentId,
            workContractId: confirmed.workContractId,
            work_contract_id: confirmed.workContractId,
            runId: confirmed.runId,
            run_id: confirmed.runId,
            childRunId: confirmed.childRunId,
            child_run_id: confirmed.childRunId,
            childSessionKey: confirmed.childSessionKey,
            child_session_key: confirmed.childSessionKey,
            updatedAt: Date.now(),
          };
          setPolicyStateAliasesForContext(ctx, nextState, [
            sessionKey,
            stateKey,
            asString(ctx.sessionKey),
            asString(ctx.canonicalSessionKey),
            asString(asRecord(updatedContract).sessionKey),
          ]);
        }
        return toolResponse(JSON.stringify(confirmed), confirmed as unknown as Record<string, unknown>);
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
        // Guard: provenance/status-only follow-up must not spawn (design §4b)
        const existingDecisionForCoverage = asRecord(existingState?.decision);
        const decisionForCoverage = asRecord(existingDecisionForCoverage);
        const routeDecisionForCoverage = asRecord(decisionForCoverage.route_decision);
        const executionCoverage = asRecord(
          decisionForCoverage._execution_coverage ?? routeDecisionForCoverage._execution_coverage,
        );
        const parentRequest = asRecord(asRecord(existingDecisionForCoverage).request);
        const parentMetadata = asRecord(parentRequest.metadata);
        const parentConversationControl = asRecord(parentMetadata.conversation_control);
        const parentIntentClass = asString(parentConversationControl.intent_class);
        if (asBoolean(executionCoverage.supports_provenance_reply)) {
          return toolResponse(JSON.stringify({
            ok: false,
            error: "Spawn blocked: provenance answerable from execution coverage (supports_provenance_reply=true)",
            provenance_blocked: true,
          }));
        }
        if (asBoolean(executionCoverage.supports_status_reply)) {
          return toolResponse(JSON.stringify({
            ok: false,
            error: "Spawn blocked: status answerable from execution coverage (supports_status_reply=true)",
            status_blocked: true,
          }));
        }
        if (asBoolean(executionCoverage.requires_control_plane_refresh)) {
          return toolResponse(JSON.stringify({
            ok: false,
            error: "Spawn blocked: control plane refresh needed (requires_control_plane_refresh=true), use octoclaw_status instead",
            control_plane_refresh_blocked: true,
          }));
        }
        const hasSupportedExecutionReply = Object.entries(executionCoverage)
          .some(([key, value]) => key.startsWith("supports_") && asBoolean(value));
        const coverageLevel = asString(executionCoverage.coverage ?? executionCoverage.coverage_level).toLowerCase();
        const executionTruthMissing = Object.keys(executionCoverage).length === 0 || !coverageLevel || coverageLevel === "none";
        const isExecutionFollowup = parentIntentClass === "execution_followup";
        if (!hasSupportedExecutionReply && executionTruthMissing && isExecutionFollowup) {
          return toolResponse(JSON.stringify({
            ok: false,
            error: "Spawn blocked: execution follow-up query with no execution truth — answer 'no verifiable record' directly",
            missing_execution_truth_blocked: true,
            intent_class: parentIntentClass,
          }));
        }
        const parentDecision = asRecord(existingState?.decision);
        const parentRoute = asString(asRecord(parentDecision.route_decision).route);
        const parentSessionKey = asString(asRecord(parentDecision.request).session_key);
        if (Object.keys(parentDecision).length > 0 && parentRoute === "delegate" && asString(asRecord(parentDecision.route_decision).judge_role) === "observer_probe" && asString(params.route) === "delegate") {
          return toolResponse(
            "sealed_route_violation: parent route is delegate with observer role, cannot reroute this observer workflow. This violates §4.6.1.",
            { sealed_route_violation: true, parent_route: "delegate", parent_role: "observer_probe", attempted_route: "delegate", error: "freeform_reroute_blocked" },
          );
        }
        if (sealedReplyBlocksDelegateHint(parentDecision, asString(params.route, "delegate"), false)) {
          return toolResponse(JSON.stringify({
            ok: false,
            error: "Spawn blocked: sealed reply WorkContract prohibits delegation",
            sealed_reply_blocked: true,
            work_contract_route: "reply",
            blocked_by_sealed_work_contract: true,
          }));
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
      description: "Handle implemented task anchor fallback commands: details, queue, artifacts, and retry. Deferred: stop, approve, reject.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Fallback command text such as 'details task-123' or 'queue'." },
          // deferred: stop, approve, reject
          action: { type: "string", enum: ["details", "queue", "artifacts", "retry", "view", "detail"] },
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
          format: { type: "string", enum: ["anchors", "compact", "table", "lanes", "raw"] },
        },
      },
      execute: async (params, _rawCtx) => {
        const format = asString(params.format, "anchors");
        const ctx = _rawCtx ?? {};
        // Detect IM type from multiple ctx fields — OpenClaw may use different key names
        const sessionKey = asString(
          ctx.sessionKey || ctx.canonicalSessionKey || ctx.agentId ||
          ctx.session_key || ctx.canonical_session_key,
        );
        const imType = sessionKey ? detectIMType(sessionKey) : "plain";
        checkActiveTaskRecovery();
        const output = await buildNativeStatusOutput(format, imType, ctx);
        return statusToolResponse(output, format, imType);
      },
    },
    {
      name: "octoclaw_crash_recovery",
      label: "OctoClaw Crash Recovery",
      description: "Operator tool to manually run runtime ledger crash recovery for stale leases, attempt reconciliation, orphan scans, and projection rebuild.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      execute: async () => {
        if (resolveRuntimeLedgerMode() === "off") {
          return toolResponse("crash_recovery_unavailable", { reason: "runtime_ledger_off" });
        }
        const result = performCrashRecovery({});
        const summary = [
          "crash_recovery_completed",
          `staleLeasesReleased=${result.staleLeasesReleased}`,
          `attemptsReconciled=${result.attemptsReconciled}`,
          `spawnConfirmed=${result.spawnConfirmed}`,
          `orphansFound=${result.orphansFound}`,
          `projectionRebuilt=${result.projectionRebuilt}`,
          `errors=${result.errors.length}`,
        ].join("; ");
        return toolResponse(summary, { ...result });
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
