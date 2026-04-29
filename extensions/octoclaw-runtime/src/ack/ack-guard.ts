import fsSync from "node:fs";
import {
  resolveTaskStatePath,
  resolveWorkspaceRoot,
} from "../resolve/env.js";

interface FsSyncLike {
  readFileSync(pathname: string, encoding: string): string;
  writeFileSync(pathname: string, data: string, encoding: string): void;
}

const fsSyncLike = fsSync as unknown as FsSyncLike;
import { getAdapterForSession } from "../im/index.js";
import { sendIMMessage } from "../im/send.js";
import {
  AckStage,
  ackStageText,
  selectAckTemplate,
  selectAckTemplate as selectLegacyAckTemplate,
  type AckTemplateStage,
  type AckTemplateTaskClass,
  type TemplateSelectionInputs,
} from "./ack-templates.js";
import {
  decideAckAction,
  type AckDecision,
  type AckDecisionPacket,
} from "./ack-decision.js";
import {
  buildAckKey,
  checkAndSet,
  recordDelivery,
  tryClaimLease,
} from "./ack-dedupe.js";
import {
  getBurstState,
  recordAckSent,
  recordMessage,
} from "./ack-burst.js";
import {
  AckRoutePhase,
  DEFAULT_ACK_TIMING_CONFIG,
  cancelAckTimers,
  createAckTimers,
  markMainModelFirstToken as markMainModelFirstTokenInTiming,
  ackTimerStateForKey,
} from "./ack-timing.js";
import {
  DELEGATED_ROUTE_NAMES,
} from "../resolve/route-helpers.js";
import {
  parseSessionRoute as canonicalParseSessionRoute,
  resolveAckDeliverySessionKey as canonicalResolveAckDeliverySessionKey,
} from "../resolve/session.js";
import { emitExecutionTransitionNotification } from "./execution-transition-notifier.js";

const ACK_DEBUG = Boolean(process.env.OCTOCLAW_ACK_DEBUG);

function ackDebug(message: string): void {
  if (ACK_DEBUG) {
    console.log(`[octoclaw-ack] ${message}`);
  }
}

export const WATCHDOG_INTERVAL_MS = 30_000;
export const WATCHDOG_DEBOUNCE_MS = 25_000;
export const STALE_QUEUED_THRESHOLD_MIN = 90;
export const STUCK_THRESHOLD_MIN = 15;

const OBSERVE_ROUTE_NAMES = new Set(["observe", "observer", "status", "inspect", "probe", "scan"]);
const ACK_CONTROLLER_LEASE_MS = DEFAULT_ACK_TIMING_CONFIG.tierDelaysMs[2] + 10_000;
const MAIN_MODEL_LEASE_MS = DEFAULT_ACK_TIMING_CONFIG.tierDelaysMs[2] + 10_000;

type UnknownRecord = Record<string, unknown>;
type AckOwner = "" | "latency_ack" | "timer_ack";

export interface AckContext extends UnknownRecord {
  trigger?: unknown;
  cwd?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
}

export interface AckLogger {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface AckTrackingState extends UnknownRecord {
  ackOwner?: unknown;
  ack_owner?: unknown;
  ackGuardKey?: unknown;
  latencyAckSent?: unknown;
  reactionAckSent?: boolean;
  reactionAckSupported?: boolean;
  reactionAckEnabled?: boolean;
  channelTone?: "chat" | "work" | "cli" | "unknown";
}

export interface AckTarget {
  target: string;
  threadId: string;
}

interface AckSendResult {
  attempted: boolean;
  delivered: boolean;
  sent: boolean;
  error: string;
  reason: string;
  ack_target_resolution_state: string;
  ack_delivery_state: string;
  target: string;
  threadId: string;
}

interface AckClaimResult {
  claimed: boolean;
  currentOwner: string;
}

interface TaskStateTask extends UnknownRecord {
  id?: unknown;
  status?: unknown;
  updated_at?: unknown;
  spawned_at?: unknown;
}

interface TaskStateFile extends UnknownRecord {
  tasks?: unknown;
}

interface AckAttemptParams {
  sessionKey: string;
  stateKey: string;
  ackOwner: AckOwner;
  ackStage: AckStage;
  routePhase: AckRoutePhase;
  message: string;
  metadata?: UnknownRecord;
  state?: UnknownRecord;
  ctx?: AckContext;
  logger?: AckLogger;
  timeoutMs?: number;
  ownerTag: string;
  skipOwnerClaim?: boolean;
  markLatencySent?: boolean;
  markMode?: string;
  messageTurnId?: string;
  stageHint?: string;
  replyToMessageId?: string;
  decision?: AckDecision;
}

const ackStateByStateKey = new Map<string, AckTrackingState>();
let watchdogLastTick = 0;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ackState(stateKey: string): AckTrackingState {
  const key = asString(stateKey);
  return key ? (ackStateByStateKey.get(key) ?? {}) : {};
}

function resolveAckDeliverySessionKey(
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
): string {
  return canonicalResolveAckDeliverySessionKey(metadata, stateKey, isRecord(state) ? state : null, ctx);
}

function ackTargetResolutionState(result: AckSendResult): string {
  return asString(result.ack_target_resolution_state) || "unresolved";
}

function ackDeliveryState(result: AckSendResult): string {
  return asString(result.ack_delivery_state) || (result.delivered || result.sent ? "sent" : "failed");
}

function updateTrackingState(stateKey: string, patch: UnknownRecord): void {
  const key = asString(stateKey);
  if (!key) {
    return;
  }
  const current = ackStateByStateKey.get(key) ?? {};
  ackStateByStateKey.set(key, { ...current, ...patch });
}

function tryClaimAckOwner(stateKey: string, owner: AckOwner): AckClaimResult {
  const key = asString(stateKey);
  const normalizedOwner = asString(owner) as AckOwner;
  if (!key || !normalizedOwner) {
    return { claimed: false, currentOwner: currentAckOwner(key) };
  }
  const currentOwner = currentAckOwner(key);
  if (!currentOwner || currentOwner === normalizedOwner) {
    updateTrackingState(key, {
      ackOwner: normalizedOwner,
      ack_owner: normalizedOwner,
    });
    return { claimed: true, currentOwner: normalizedOwner };
  }
  return { claimed: false, currentOwner };
}

function ackLeaseKey(stateKey: string): string {
  const normalized = asString(stateKey);
  return normalized ? `ack-lease:${normalized}` : "";
}

function ensureAckTurnTimestamp(stateKey: string): number {
  const normalizedStateKey = asString(stateKey);
  if (!normalizedStateKey) {
    return Date.now();
  }
  const existing = asNumber(ackState(normalizedStateKey)._ackTurnTs);
  if (existing > 0) {
    return existing;
  }
  const created = Date.now();
  updateTrackingState(normalizedStateKey, { _ackTurnTs: created });
  return created;
}

function normalizeAckStage(value: string): AckStage {
  switch (asString(value)) {
    case AckStage.PreRouteSoftAck:
      return AckStage.PreRouteSoftAck;
    case AckStage.DelegateStarted:
      return AckStage.DelegateStarted;
    case AckStage.ObserveStarted:
      return AckStage.ObserveStarted;
    case AckStage.ReplySoftAck:
      return AckStage.ReplySoftAck;
    case AckStage.Queued:
      return AckStage.Queued;
    case AckStage.Blocked:
      return AckStage.Blocked;
    case AckStage.ProgressNudge:
    case "progress_nudge_explicit_stage":
      return AckStage.ProgressNudge;
    case AckStage.ToolStillWorking:
      return AckStage.ToolStillWorking;
    case AckStage.ToolComplexTask:
      return AckStage.ToolComplexTask;
    case AckStage.ToolAskContinue:
      return AckStage.ToolAskContinue;
    case AckStage.ToolSuggestStop:
      return AckStage.ToolSuggestStop;
    default:
      return AckStage.ProgressNudge;
  }
}

export function resolveRoutePhase(decision: UnknownRecord, options: UnknownRecord = {}): AckRoutePhase {
  const explicit = asString(options.routePhase || options.route_phase).toLowerCase();
  if (explicit === "delegate" || explicit === "observe" || explicit === "reply" || explicit === "pre_route") {
    return explicit;
  }

  const routeDecision = isRecord(decision.route_decision) ? decision.route_decision : {};
  const workContract = isRecord(decision.work_contract) ? decision.work_contract : {};
  const explicitRoute = asString(options.route || workContract.route || routeDecision.route);
  if (!explicitRoute && Object.keys(decision).length === 0) {
    return "pre_route";
  }

  const route = explicitRoute.toLowerCase();
  if (DELEGATED_ROUTE_NAMES.has(route)) {
    return "delegate";
  }
  if (OBSERVE_ROUTE_NAMES.has(route)) {
    return "observe";
  }
  if (route === "reply" || route === "direct") {
    return "reply";
  }
  return "pre_route";
}

export function threadKeyFromSessionKey(sessionKey: string, stateKey = ""): string {
  const parsed = canonicalParseSessionRoute(sessionKey);
  if (parsed.threadKey) return parsed.threadKey;
  if (parsed.bindingKey) return `${parsed.bindingKey}:${parsed.threadId || "root"}`;
  return asString(parsed.threadId || parsed.target || stateKey);
}

function applyTemplateVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : value;
  });
}

function templateMessageForStage(
  stage: AckStage,
  inputs: TemplateSelectionInputs,
  vars: Record<string, string> = {},
): string {
  const selected = selectLegacyAckTemplate(stage, inputs);
  if (selected?.text) {
    return applyTemplateVars(selected.text, vars);
  }
  return ackStageText(stage, vars);
}

function normalizeDecisionRoute(routePhase: AckRoutePhase): AckDecisionPacket["route"] {
  if (routePhase === "reply" || routePhase === "pre_route") {
    return routePhase;
  }
  if (routePhase === "delegate") {
    return "delegate";
  }
  return "unknown";
}

function normalizeChannelTone(value: unknown): AckDecisionPacket["channelTone"] {
  const normalized = asString(value).toLowerCase();
  if (normalized === "chat" || normalized === "work" || normalized === "cli") {
    return normalized;
  }
  return "unknown";
}

function buildTemplateRegistryMessage(
  stage: AckTemplateStage,
  packet: AckDecisionPacket,
  stateKey: string,
  state: UnknownRecord,
  sessionKey = "",
  decision?: AckDecision,
): string {
  const turnId = asString(state.turnId || state.turn_id || state.messageTurnId || state.message_turn_id)
    || `${stateKey}:${ensureAckTurnTimestamp(stateKey)}`;
  const recentKeys = Array.isArray(state.recentAckTemplateKeys)
    ? state.recentAckTemplateKeys.map((entry) => asString(entry)).filter(Boolean)
    : [];
  const template = selectAckTemplate({
    stage,
    channel: packet.channelTone ?? "unknown",
    tone: "neutral",
    taskClass: asString(state.taskClass || state.task_class || "unknown") as AckTemplateTaskClass,
    modality: decision?.modality ?? "text",
    semanticKey: asString(state.semanticKey || state.semantic_key) || undefined,
    threadBindingKey: asString(state.threadBindingKey || state.thread_binding_key)
      || threadKeyFromSessionKey(sessionKey, stateKey),
    turnId,
    recentKeys,
  });
  updateTrackingState(stateKey, {
    lastAckTemplateKey: template.key,
    recentAckTemplateKeys: [template.key, ...recentKeys].slice(0, 5),
  });
  return template.text;
}

function ackTemplateStageFromDecision(decision: AckDecision, fallback: AckTemplateStage): AckTemplateStage {
  const stage = decision.ackStage;
  if (stage === "ack0" || stage === "tier1" || stage === "tier2" || stage === "tier3") {
    return stage;
  }
  return fallback;
}

export function buildDecisionPacket(
  stateKey: string,
  state: UnknownRecord = {},
  routePhase: AckRoutePhase = "unknown",
): AckDecisionPacket {
  const normalizedStateKey = asString(stateKey);
  const tracking = ackState(normalizedStateKey);
  const merged = { ...state, ...tracking };
  const timerState = ackTimerStateForKey(normalizedStateKey);
  const inboundAtMs = asNumber(merged.inboundAtMs || merged.inbound_at_ms || merged._ackTurnTs) || timerState?.inboundTs || Date.now();
  const nowMs = asNumber(merged.nowMs || merged.now_ms) || Date.now();
  const hasMessageTarget = Boolean(asString(merged.inboundMessageTs || merged.message_id || merged.replyToMessageId));

  return {
    route: normalizeDecisionRoute(routePhase),
    nowMs,
    inboundAtMs,
    firstTokenSeen: asBoolean(merged.firstTokenSeen) || asBoolean(merged.mainModelFirstTokenSeen) || asBoolean(merged.mainModelStartedOutput),
    formalReplyVisible: asBoolean(merged.formalReplyVisible) || asBoolean(merged.formal_reply_visible),
    deliveryPending: asBoolean(merged.deliveryPending) || asBoolean(merged.delivery_pending),
    delivered: asBoolean(merged.delivered),
    finalResponseStreaming: asBoolean(merged.finalResponseStreaming || merged.final_response_streaming),
    userInputActive: asBoolean(merged.userInputActive) || asBoolean(merged.user_input_active),
    mainModelActive: asBoolean(merged.mainModelActive) || asBoolean(merged.main_model_active) || asBoolean(merged.final_response_streaming),
    toolActive: asBoolean(merged.toolActive) || asBoolean(merged.tool_active),
    delegatedRunning: asBoolean(merged.delegatedRunning) || asBoolean(merged.delegated_running),
    blocked: asBoolean(merged.blocked) || asString(merged.native_state) === "blocked",
    hasValidThreadTarget: hasMessageTarget,
    reactionAckSupported: asBoolean(merged.reactionAckSupported),
    reactionAckEnabled: asBoolean(merged.reactionAckEnabled),
    reactionAckSent: asBoolean(merged.reactionAckSent),
    textAck0Sent: asBoolean(merged.textAck0Sent) || asBoolean(merged.latencyAckSent),
    tier1Sent: asBoolean(merged.tier1Sent) || Boolean(timerState?.tier1Fired),
    tier2Sent: asBoolean(merged.tier2Sent) || Boolean(timerState?.tier2Fired),
    ackWriterQueued: asBoolean(merged.ackWriterQueued) || asBoolean(merged.ack_writer_queued),
    channelTone: normalizeChannelTone(merged.channelTone || merged.channel_tone),
  };
}

function buildTemplateInputs(
  state: UnknownRecord,
  ctx: AckContext,
  routePhase: AckRoutePhase,
  threadKey: string,
  stageHint = "",
): TemplateSelectionInputs {
  const channelSupportsUpdate = isRecord(state.channel)
    ? state.channel.supportsUpdate !== false
    : state.channelSupportsUpdate !== false;
  return {
    route: routePhase,
    queueState: asString(state.queueState || state.queue_state),
    blockedReason: asString(state.blockedReason || state.blocked_reason),
    channelCapability: channelSupportsUpdate ? "update" : "text_only",
    burstState: getBurstState(threadKey),
    anchorExists: Boolean(asString(state.anchorId || state.anchor_id || state.pendingDeliveryId)),
    userInputActive: asBoolean(state.userInputActive) || asBoolean(ctx.userInputActive),
    stageHint: stageHint || asString(state.stageHint || state.stage_hint),
  };
}

async function sendAckMessage(
  sessionKey: string,
  message: string,
  cwd?: string,
  options: UnknownRecord = {},
): Promise<AckSendResult> {
  const resolved = resolveAckTargetFromSessionKey(sessionKey);
  if (!resolved.target) {
    return {
      attempted: false,
      delivered: false,
      sent: false,
      error: "unresolvable_session_target",
      reason: "channel_message_unresolvable",
      ack_target_resolution_state: "target_resolution_failed",
      ack_delivery_state: "not_attempted",
      target: "",
      threadId: "",
    };
  }

  const result = await sendIMMessage({
    sessionKey,
    message,
    replyToMessageId: asString(options.replyToMessageId) || undefined,
    timeoutMs: Math.max(500, Number(options.timeoutMs || 5000)),
    cwd: asString(cwd) || resolveWorkspaceRoot(),
  });
  return {
    attempted: result.error !== "no_im_adapter",
    delivered: result.sent,
    sent: result.sent,
    error: result.error || "",
    reason: result.sent ? "channel_message_sent" : "channel_message_failed",
    ack_target_resolution_state: "resolved",
    ack_delivery_state: result.sent ? "sent" : "failed",
    target: resolved.target,
    threadId: result.threadTs || resolved.threadId,
  };
}

async function sendReactionAckDetailed(
  sessionKey: string,
  messageId: string,
  cwd?: string,
  options: UnknownRecord = {},
): Promise<AckSendResult> {
  const parsed = canonicalParseSessionRoute(sessionKey);
  const resolved = resolveAckTargetFromSessionKey(sessionKey);
  if (!parsed.origin || !resolved.target || !messageId) {
    return {
      attempted: false,
      delivered: false,
      sent: false,
      error: "unresolvable_reaction_target",
      reason: "reaction_unresolvable",
      ack_target_resolution_state: "target_resolution_failed",
      ack_delivery_state: "not_attempted",
      target: "",
      threadId: "",
    };
  }

  const adapter = getAdapterForSession(sessionKey);
  if (adapter) {
    const result = await adapter.react({
      sessionKey,
      messageId,
      emoji: asString(options.emoji) || "eyes",
      timeoutMs: Math.max(500, Number(options.timeoutMs || 5000)),
      cwd: asString(cwd) || resolveWorkspaceRoot(),
    });
    return {
      attempted: true,
      delivered: result.ok,
      sent: result.ok,
      error: result.error || "",
      reason: result.ok ? "reaction_ack_sent" : "reaction_ack_failed",
      ack_target_resolution_state: "resolved",
      ack_delivery_state: result.ok ? "sent" : "failed",
      target: adapter.resolveTarget(sessionKey).target,
      threadId: resolved.threadId,
    };
  }

  return {
    attempted: false,
    delivered: false,
    sent: false,
    error: "reaction_adapter_unavailable",
    reason: "reaction_ack_unavailable",
    ack_target_resolution_state: "resolved",
    ack_delivery_state: "not_attempted",
    target: resolved.target,
    threadId: resolved.threadId,
  };
}

async function readTaskStateFile(): Promise<TaskStateFile> {
  try {
    const fs = await import("node:fs");
    const content = fs.default.readFileSync(resolveTaskStatePath(), "utf-8");
    return JSON.parse(content) as TaskStateFile;
  } catch {
    return {};
  }
}

function parseUpdatedSortValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = asString(value);
  if (!text) {
    return 0;
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function buildMinimalProjectionFromTaskState(
  task: TaskStateTask,
  status: string,
): import("@octoclaw/contracts/status-projection").TaskStatusProjection {
  const t = task as UnknownRecord;
  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: "octoclaw.task_status_projection/v1" as const,
    projectionId: `exec_transition_${asString(t.id)}_${Date.now()}`,
    generatedAt,
    requestId: "",
    flowId: asString(t.flow_id),
    taskId: asString(t.id),
    title: "",
    summary: "",
    taskSummary: "",
    route: "delegate" as const,
    role: "",
    backend: "octoclaw.delegate",
    modelProfile: "",
    status: status as import("@octoclaw/contracts/status-projection").TaskProjectionStatus,
    success: false,
    createdAt: asString(t.created_at) || asString(t.spawned_at) || generatedAt,
    dispatchExecuted: asBoolean(t.dispatchExecuted) || asBoolean(t.dispatch_executed),
    spawnExecuted: asBoolean(t.spawnExecuted) || asBoolean(t.spawn_executed),
    resultMaterialized: asBoolean(t.resultMaterialized) || asBoolean(t.result_materialized),
    latestAnomalyNotice: (isRecord(t.latestAnomalyNotice) ? t.latestAnomalyNotice : isRecord(t.latest_anomaly_notice) ? t.latest_anomaly_notice : undefined) as import("@octoclaw/contracts/work-contract").AnomalyNotice | undefined,
    elapsedMs: 0,
    artifactRefs: [],
    artifactRefIds: [],
    actions: [],
  };
}

async function watchdogTransitionStaleTask(taskId: string, task: TaskStateTask, newStatus: string, sink: AckLogger): Promise<boolean> {
  const sessionKey = asString((task as UnknownRecord).session_key);
  const flowId = asString((task as UnknownRecord).flow_id);
  if (!sessionKey || !flowId) {
    sink.debug?.(`octoclaw watchdog: skip transition task=${taskId} missing session_key or flow_id`);
    return false;
  }
  try {
    const { invokeNativeHelper } = await import("../adapter/native-helper.js");
    const result = invokeNativeHelper({ action: "read-task", args: { session_key: sessionKey, flow_id: flowId, task_id: taskId } });
    if (!result?.found) {
      sink.debug?.(`octoclaw watchdog: skip transition task=${taskId} not found in runtime`);
      return false;
    }
    const taskRead = result as unknown as { task?: { state?: string; status?: string } };
    const currentState = asString(taskRead.task?.state || taskRead.task?.status);
    if (currentState === "completed" || currentState === "failed" || currentState === "timed_out") {
      return false;
    }
    const failResult = invokeNativeHelper({
      action: "fail-flow" as const,
      args: {
        session_key: sessionKey,
        flow_id: flowId,
        blocked_task_id: taskId,
        blocked_summary: `watchdog timeout: task ${taskId} stuck in ${currentState} after threshold`,
      },
    }) as unknown as { ok?: boolean; status?: string };
    if (failResult.ok) {
      sink.debug?.(`octoclaw watchdog: transitioned task=${taskId} to ${newStatus}`);
      updateTaskStateCache(taskId, {
        status: newStatus,
        updated_at: new Date().toISOString(),
        latestAnomalyNotice: {
          kind: "watchdog_timeout",
          severity: "error",
          taskId,
          message: `Watchdog transitioned task to ${newStatus}`,
          createdAt: new Date().toISOString(),
          nativeTaskId: asString((task as UnknownRecord).native_task_id),
          nativeFlowId: asString((task as UnknownRecord).flow_id),
        },
      });
      try {
        void emitExecutionTransitionNotification({
          transitionKind: "timed_out",
          projection: buildMinimalProjectionFromTaskState(task, newStatus),
          attemptId: taskId,
          workContractId: "",
          sessionKey,
          stateKey: sessionKey,
        });
      } catch (_) {}
      return true;
    }
    sink.debug?.(`octoclaw watchdog: failed to transition task=${taskId}: ${asString(failResult.status)}`);
    return false;
  } catch (err) {
    sink.debug?.(`octoclaw watchdog: error transitioning task=${taskId}: ${String(err)}`);
    return false;
  }
}

function updateTaskStateCache(taskId: string, patch: Record<string, unknown>): void {
  try {
    const taskPath = resolveTaskStatePath();
    let existing: { tasks?: unknown[] } = { tasks: [] };
    try {
      existing = JSON.parse(fsSyncLike.readFileSync(taskPath, "utf-8")) as { tasks?: unknown[] };
    } catch { /* no file */ }
    const tasks = Array.isArray(existing.tasks) ? existing.tasks as TaskStateTask[] : [];
    const idx = tasks.findIndex((t) => asString(t.id) === taskId);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], ...patch };
      fsSyncLike.writeFileSync(taskPath, JSON.stringify({ tasks }, null, 2), "utf-8");
    }
  } catch { /* best effort */ }
}

async function attemptAckSend(params: AckAttemptParams): Promise<{ sent: boolean; reason: string } | null> {
  const normalizedStateKey = asString(params.stateKey);
  const normalizedSessionKey = asString(params.sessionKey);
  const effectiveState: UnknownRecord = {
    ...(isRecord(params.state) ? params.state : {}),
    replyToMessageId: asString(params.replyToMessageId || (isRecord(params.state) ? params.state.replyToMessageId : undefined)),
  };
  const effectiveCtx = params.ctx ?? {};
  const routePhase = params.routePhase;
  const threadKey = threadKeyFromSessionKey(normalizedSessionKey, normalizedStateKey);
  const ackTarget = resolveAckTargetFromSessionKey(normalizedSessionKey);
  const messageTurnId = asString(params.messageTurnId) || `${normalizedStateKey}:${ensureAckTurnTimestamp(normalizedStateKey)}`;
  const ackKey = buildAckKey({
    threadId: ackTarget.threadId || threadKey,
    anchorId: asString(effectiveState.anchorId || effectiveState.anchor_id),
    ackStage: params.ackStage,
    routePhase,
    messageTurnId,
  });

  const packet = buildDecisionPacket(normalizedStateKey, effectiveState, routePhase);
  // Suppress reply ACK0 if route-commit ACK already sent for this turn.
  if (asBoolean(effectiveState.routeCommitAckSent || effectiveState.route_commit_ack_sent) && routePhase === "reply") {
    ackDebug(`attemptAckSend: route-commit ACK satisfied ACK0 for reply route stateKey=${normalizedStateKey}`);
    updateTrackingState(normalizedStateKey, {
      ack_target_resolution_state: "suppressed_by_route_commit_ack",
      ack_delivery_state: "skipped",
    });
    return null;
  }
  const decision = params.decision ?? decideAckAction(packet);
  if (decision.action === "suppress" || decision.action === "no_action") {
    ackDebug(`attemptAckSend: skipped action=${decision.action} reason=${decision.reason} threadKey=${threadKey} stage=${params.ackStage}`);
    updateTrackingState(normalizedStateKey, {
      ackKey,
      ack_target_resolution_state: `${decision.action}_${decision.reason}`,
      ack_delivery_state: "skipped",
    });
    return null;
  }
  if (decision.action === "cancel_ack_writer") {
    cancelAckGuardForState(normalizedStateKey);
    updateTrackingState(normalizedStateKey, {
      ackKey,
      ackWriterQueued: false,
      ack_writer_queued: false,
      ack_target_resolution_state: `cancelled_${decision.reason}`,
      ack_delivery_state: "skipped",
    });
    return null;
  }

  const idempotency = checkAndSet(ackKey, params.ownerTag);
  if (!idempotency.allowed) {
    ackDebug(`attemptAckSend: duplicate ackKey=${ackKey} existing=${idempotency.existingOwner}`);
    updateTrackingState(normalizedStateKey, {
      ackOwner: params.ackOwner,
      ack_owner: params.ackOwner,
      ackKey,
      ack_target_resolution_state: "skipped_duplicate",
      ack_delivery_state: "skipped",
    });
    return null;
  }

  const ownerClaim = params.skipOwnerClaim ? { claimed: true, currentOwner: params.ackOwner } : tryClaimAckOwner(normalizedStateKey, params.ackOwner);
  if (!ownerClaim.claimed) {
    ackDebug(`attemptAckSend: owner_conflict owner=${ownerClaim.currentOwner} ackOwner=${params.ackOwner}`);
    updateTrackingState(normalizedStateKey, {
      ack_owner: ownerClaim.currentOwner,
      ack_target_resolution_state: "skipped_owner_conflict",
      ack_delivery_state: "skipped",
    });
    return params.ackOwner === "latency_ack" ? { sent: false, reason: "owner_conflict" } : null;
  }

  const lease = tryClaimLease(ackLeaseKey(normalizedStateKey), "ack_controller", ACK_CONTROLLER_LEASE_MS);
  if (!lease.claimed || lease.owner !== "ack_controller") {
    updateTrackingState(normalizedStateKey, {
      ackOwner: params.ackOwner,
      ack_owner: params.ackOwner,
      ackKey,
      ack_target_resolution_state: `skipped_lease_${lease.owner || "unknown"}`,
      ack_delivery_state: "skipped",
    });
    return params.ackOwner === "latency_ack" ? { sent: false, reason: "lease_conflict" } : null;
  }

  if (!packet.hasValidThreadTarget) {
    ackDebug(`attemptAckSend: missing_thread_target stateKey=${normalizedStateKey} sessionKey=${normalizedSessionKey}`);
  }

  if (!normalizedSessionKey) {
    ackDebug(`attemptAckSend: missing_session_key stateKey=${normalizedStateKey}`);
    updateTrackingState(normalizedStateKey, {
      ackOwner: params.ackOwner,
      ack_owner: params.ackOwner,
      ackKey,
      ack_target_resolution_state: "missing_session_key",
      ack_delivery_state: "not_attempted",
    });
    return params.ackOwner === "latency_ack" ? { sent: false, reason: "missing_session_key" } : null;
  }

  const message = decision.modality === "text" && decision.ackStage
    ? buildTemplateRegistryMessage(
        ackTemplateStageFromDecision(decision, "ack0"),
        packet,
        normalizedStateKey,
        effectiveState,
        normalizedSessionKey,
        decision,
      )
    : params.message;
  const isReactionAck = decision.action === "send_reaction_ack";

  ackDebug(`attemptAckSend: sending sessionKey=${normalizedSessionKey} stage=${params.ackStage} action=${decision.action} message="${message.substring(0, 30)}"`);
  const result = isReactionAck
    ? await sendReactionAckDetailed(
        normalizedSessionKey,
        asString(params.replyToMessageId || effectiveState.message_id || effectiveState.messageId),
        asString(effectiveCtx.cwd) || process.cwd(),
        { timeoutMs: Math.max(500, Number(params.timeoutMs || 5000)), emoji: effectiveState.reactionAckEmoji || effectiveState.reaction_ack_emoji },
      )
    : await sendAckMessage(
        normalizedSessionKey,
        message,
        asString(effectiveCtx.cwd) || process.cwd(),
        { timeoutMs: Math.max(500, Number(params.timeoutMs || 5000)), replyToMessageId: params.replyToMessageId },
      );

  recordDelivery(ackKey, {
    ackKey,
    sent: Boolean(result.delivered || result.sent),
    deliveredAt: Date.now(),
    target: result.target,
    threadId: result.threadId || ackTarget.threadId || threadKey,
    error: result.error || undefined,
  });

  updateTrackingState(normalizedStateKey, {
    ackOwner: params.ackOwner,
    ack_owner: params.ackOwner,
    ackKey,
    ack_target_resolution_state: ackTargetResolutionState(result),
    ack_delivery_state: ackDeliveryState(result),
    ...(params.markLatencySent
      ? {
          latencyAckSent: Boolean(result.delivered || result.sent),
          latencyAckText: message,
          latencyAckMode: isReactionAck ? "reaction" : params.markMode || "channel_message",
        }
      : {}),
    ...(isReactionAck ? { reactionAckSent: Boolean(result.delivered || result.sent) } : {}),
    ...(decision.action === "send_text_ack0" ? { textAck0Sent: Boolean(result.delivered || result.sent) } : {}),
    ...(decision.ackStage === "tier1" ? { tier1Sent: Boolean(result.delivered || result.sent) } : {}),
    ...(decision.ackStage === "tier2" ? { tier2Sent: Boolean(result.delivered || result.sent) } : {}),
  });

  if (result.delivered || result.sent) {
    ackDebug(`attemptAckSend: sent=true stage=${params.ackStage} target=${result.target}`);
    recordAckSent(threadKey, params.ackStage, routePhase);
    if (params.ackOwner !== "timer_ack") {
      cancelAckGuardForState(normalizedStateKey);
    }
    return { sent: true, reason: result.reason };
  }

  return { sent: false, reason: result.reason };
}
export function latencyAckText(
  decision: UnknownRecord,
  packet: AckDecisionPacket = buildDecisionPacket("", {}, resolveRoutePhase(decision)),
  stateKey = "",
  state: UnknownRecord = {},
  sessionKey = "",
): string {
  return buildTemplateRegistryMessage("ack0", packet, stateKey, state, sessionKey);
}

export function latencyAckStage(decision: UnknownRecord): AckStage {
  const routePhase = resolveRoutePhase(decision);
  if (routePhase === "observe") {
    return AckStage.ObserveStarted;
  }
  if (routePhase === "delegate") {
    return AckStage.DelegateStarted;
  }
  return AckStage.ReplySoftAck;
}

export function shouldSendLatencyAck(
  decision: UnknownRecord,
  state: UnknownRecord = {},
  ctx: AckContext = {},
  toolName = "",
): boolean {
  const latencyAck = isRecord(decision.latency_ack) ? decision.latency_ack : {};
  if (!asBoolean(latencyAck.required)) {
    return false;
  }
  if (asBoolean(state.latencyAckSent)) {
    return false;
  }
  const trigger = asString(ctx.trigger).toLowerCase();
  if (trigger && ["heartbeat", "cron", "memory"].includes(trigger)) {
    return false;
  }
  const normalizedToolName = asString(toolName);
  if (!normalizedToolName || normalizedToolName.startsWith("octoclaw_")) {
    return false;
  }
  return Boolean(latencyAckText(decision));
}

export function resolveAckTargetFromSessionKey(sessionKey: string): AckTarget {
  const parsed = canonicalParseSessionRoute(sessionKey);
  return {
    target: parsed.target,
    threadId: parsed.threadId,
  };
}

export async function sendAckDirect(
  sessionKey: string,
  message: string,
  cwd?: string,
  options: UnknownRecord = {},
): Promise<boolean> {
  const stateKey = asString(options.stateKey || options.state_key);
  const routePhase = asString(options.routePhase || options.route_phase) as AckRoutePhase;
  if (stateKey && routePhase) {
    const result = await attemptAckSend({
      sessionKey,
      stateKey,
      ackOwner: asString(options.ackOwner || options.ack_owner) as AckOwner || "latency_ack",
      ackStage: normalizeAckStage(asString(options.ackStage || options.ack_stage) || AckStage.ReplySoftAck),
      routePhase,
      message,
      state: isRecord(options.state) ? options.state : ackState(stateKey),
      ctx: { cwd, ...(isRecord(options.ctx) ? options.ctx : {}) },
      timeoutMs: Math.max(500, Number(options.timeoutMs || 5000)),
      ownerTag: asString(options.ownerTag || options.owner_tag) || "direct_ack",
      skipOwnerClaim: asBoolean(options.skipOwnerClaim),
      replyToMessageId: asString(options.replyToMessageId),
    });
    return Boolean(result?.sent);
  }
  const result = await sendAckMessage(sessionKey, message, cwd, options);
  return Boolean(result.delivered || result.sent);
}

export function startAckGuard(sessionKey: string, cwd: string, options: UnknownRecord = {}): void {
  const normalizedSessionKey = asString(sessionKey);
  if (!normalizedSessionKey) {
    return;
  }

  const stateKey = asString(options.stateKey || normalizedSessionKey);
  const decision = isRecord(options.decision) ? options.decision : {};
  const baseState = isRecord(options.state) ? options.state : {};
  const ctx = isRecord(options.ctx) ? options.ctx as AckContext : { cwd };
  const logger = isRecord(options.logger) ? options.logger as AckLogger : {};
  const routePhase = resolveRoutePhase(decision, options);
  const replyToMessageId = asString(options.replyToMessageId);
  const turnTs = ensureAckTurnTimestamp(stateKey);

  updateTrackingState(stateKey, {
    ackGuardKey: normalizedSessionKey,
    ackOwner: "",
    ack_owner: "",
    _ackTurnTs: turnTs,
    reactionAckSent: asBoolean(baseState.reactionAckSent),
    reactionAckSupported: asBoolean(baseState.reactionAckSupported),
    reactionAckEnabled: asBoolean(baseState.reactionAckEnabled),
    channelTone: normalizeChannelTone(baseState.channelTone || baseState.channel_tone),
  });

  createAckTimers({
    stateKey,
    sessionKey: normalizedSessionKey,
    routePhase,
    inboundTs: turnTs,
    config: isRecord(options.ackTimingConfig) ? options.ackTimingConfig as Partial<import("./ack-timing.js").AckTimingConfig> : undefined,
    onTierFire: (result) => {
      const currentState = ackTimerStateForKey(stateKey);
      if (!currentState || currentState.cancelled) {
        return;
      }
      ackDebug(`tier${result.tier} fired stage=${result.stage} routePhase=${result.routePhase} sessionKey=${normalizedSessionKey} stateKey=${stateKey}`);
      const liveTrackingState = { ...baseState, ...ackState(stateKey) };
      const ackStage = normalizeAckStage(result.stage);
      const threadKey = threadKeyFromSessionKey(normalizedSessionKey, stateKey);
      const templateInputs = buildTemplateInputs(
        liveTrackingState,
        ctx,
        result.routePhase,
        threadKey,
        result.tier >= 3 ? `tier${result.tier}` : "",
      );
      const message = templateMessageForStage(
        ackStage,
        templateInputs,
        result.tier >= 3 ? { stage_hint: templateInputs.stageHint || `tier${result.tier}` } : {},
      );
      const packet = buildDecisionPacket(stateKey, liveTrackingState, result.routePhase);
      const ackDecision = decideAckAction(packet);
      if (ackDecision.action === "cancel_ack_writer") {
        cancelAckGuardForState(stateKey);
        updateTrackingState(stateKey, { ackWriterQueued: false, ack_writer_queued: false });
        return;
      }
      if (!message || !ackDecision.action.startsWith("send_")) {
        return;
      }
      void attemptAckSend({
        sessionKey: normalizedSessionKey,
        stateKey,
        ackOwner: "timer_ack",
        ackStage,
        routePhase: result.routePhase,
        message,
        state: liveTrackingState,
        ctx: { ...ctx, cwd },
        logger,
        timeoutMs: 2_000,
        ownerTag: "ack_controller",
        messageTurnId: `${stateKey}:${turnTs}`,
        stageHint: templateInputs.stageHint,
        replyToMessageId,
        decision: ackDecision,
      }).catch((error) => {
        logger.warn?.(`octoclaw timed ack failed: ${String(error)}`);
      });
    },
  });
}

export function updateAckGuardDecision(
  stateKey: string,
  decision: Record<string, unknown>,
): void {
  const key = asString(stateKey);
  if (!key) return;
  updateAckTrackingState(key, {
    decision,
    decision_updated_at: Date.now(),
  });
}

export function cancelAckGuard(sessionKey: string): void {
  cancelAckTimers(asString(sessionKey));
}

export function cancelAckGuardForState(stateKey: string): void {
  const normalizedStateKey = asString(stateKey);
  if (!normalizedStateKey) {
    return;
  }
  const state = ackState(normalizedStateKey);
  const storedAckKey = asString(state.ackGuardKey);
  if (storedAckKey) {
    cancelAckGuard(storedAckKey);
  }
  cancelAckGuard(normalizedStateKey);
  updateTrackingState(normalizedStateKey, {
    ackOwner: "",
    ack_owner: "",
  });
}

export function currentAckOwner(stateKey: string): string {
  const state = ackState(stateKey);
  return asString(state.ackOwner || state.ack_owner);
}

export function claimAckOwner(stateKey: string, owner: string): string {
  return tryClaimAckOwner(stateKey, asString(owner) as AckOwner).currentOwner;
}

export function updateAckTrackingState(stateKey: string, patch: UnknownRecord): void {
  updateTrackingState(stateKey, patch);
}

export async function maybeSendLatencyAck(
  decision: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
  logger: AckLogger,
  toolName: string,
): Promise<{ sent: boolean; reason: string } | null> {
  if (!shouldSendLatencyAck(decision, state, ctx, toolName)) {
    return null;
  }
  const routePhase = resolveRoutePhase(decision);
  const preDecisionState = {
    ...state,
    userInputActive: asBoolean(state.userInputActive) || asBoolean(ctx.userInputActive),
    toolActive: asBoolean(state.toolActive) || asBoolean(state.tool_active) || Boolean(asString(toolName)),
  };
  const sessionKey = resolveAckDeliverySessionKey(metadata, stateKey, state, ctx);
  const decisionPacket = buildDecisionPacket(stateKey, preDecisionState, routePhase);
  const ackDecision = decideAckAction(decisionPacket);
  if (ackDecision.action === "cancel_ack_writer") {
    cancelAckGuardForState(stateKey);
    updateTrackingState(stateKey, { ackWriterQueued: false, ack_writer_queued: false });
    return null;
  }
  if (!ackDecision.action.startsWith("send_")) {
    if (!decisionPacket.hasValidThreadTarget) {
      ackDebug(`maybeSendLatencyAck: suppressed due to no valid thread target stateKey=${stateKey} sessionKey=${sessionKey || "unresolved"}`);
    }
    updateTrackingState(stateKey, {
      ack_target_resolution_state: `${ackDecision.action}_${ackDecision.reason}`,
      ack_delivery_state: "skipped",
    });
    return null;
  }
  if (!sessionKey) {
    updateTrackingState(stateKey, {
      ackOwner: "latency_ack",
      ack_owner: "latency_ack",
      ack_target_resolution_state: "missing_session_key",
      ack_delivery_state: "not_attempted",
    });
    return { sent: false, reason: "missing_session_key" };
  }
  try {
    const latencyAck = isRecord(decision.latency_ack) ? decision.latency_ack : {};
    const ackStage = latencyAckStage(decision);
    const message = ackStageText(ackStage);
    const liveTrackingState = { ...preDecisionState, ...ackState(stateKey) };
    const result = await attemptAckSend({
      sessionKey,
      stateKey,
      ackOwner: "latency_ack",
      ackStage,
      routePhase,
      message,
      metadata,
      state: liveTrackingState,
      ctx,
      logger,
      timeoutMs: Math.max(500, Number(latencyAck.channel_timeout_ms || 5000)),
      ownerTag: "latency_ack",
      markLatencySent: true,
      markMode: "channel_message",
      messageTurnId: `${stateKey}:${ensureAckTurnTimestamp(stateKey)}`,
      replyToMessageId: isRecord(metadata) ? asString(metadata.message_id) : "",
      decision: ackDecision,
    });
    return result;
  } catch (error) {
    logger.warn?.(`octoclaw latency ack failed: ${String(error)}`);
    updateTrackingState(stateKey, {
      ackOwner: "latency_ack",
      ack_owner: "latency_ack",
      ack_target_resolution_state: "unresolved",
      ack_delivery_state: "failed",
    });
    return { sent: false, reason: String(error) };
  }
}

export function markMainModelFirstToken(stateKey: string): void {
  const normalizedStateKey = asString(stateKey);
  if (!normalizedStateKey) {
    return;
  }
  markMainModelFirstTokenInTiming(normalizedStateKey);
  tryClaimLease(ackLeaseKey(normalizedStateKey), "main_model", MAIN_MODEL_LEASE_MS);
  cancelAckGuardForState(normalizedStateKey);
  updateTrackingState(normalizedStateKey, { mainModelFirstTokenSeen: true, mainModelStartedOutput: true });
}

export function notifyUserMessage(sessionKey: string, stateKey: string): void {
  const threadKey = threadKeyFromSessionKey(sessionKey, stateKey);
  if (!threadKey) {
    return;
  }
  recordMessage(threadKey);
}

export async function watchdogTick(logger: unknown): Promise<void> {
  const sink = isRecord(logger) ? logger as AckLogger : {};
  const now = Date.now();
  if (now - watchdogLastTick < WATCHDOG_DEBOUNCE_MS) {
    return;
  }
  watchdogLastTick = now;

  try {
    const taskState = await readTaskStateFile();
    const tasks = Array.isArray(taskState.tasks) ? taskState.tasks as TaskStateTask[] : [];
    if (tasks.length === 0) {
      return;
    }

    let staleCount = 0;
    let stuckCount = 0;
    let transitionedCount = 0;
    for (const task of tasks) {
      const taskId = asString(task.id);
      const status = asString(task.status).toLowerCase();
      const updatedAt = parseUpdatedSortValue(task.updated_at ?? task.spawned_at ?? 0);
      if (!taskId || !updatedAt) {
        continue;
      }
      const ageMin = (now - updatedAt) / 60_000;
      if (status === "queued" && ageMin > STALE_QUEUED_THRESHOLD_MIN) {
        staleCount += 1;
        sink.debug?.(`octoclaw watchdog: task_timeout task=${taskId} status=${status} age_min=${ageMin.toFixed(1)}`);
        try {
          const sessionKey = asString((task as UnknownRecord).session_key);
          updateTaskStateCache(taskId, {
            latestAnomalyNotice: {
              kind: "queued_stale",
              severity: "warning",
              taskId,
              message: `Task queued for ${ageMin.toFixed(0)} minutes exceeds ${STALE_QUEUED_THRESHOLD_MIN} minute threshold`,
              createdAt: new Date().toISOString(),
            },
          });
          void emitExecutionTransitionNotification({
            transitionKind: "queued_stale",
            projection: buildMinimalProjectionFromTaskState(task, "queued"),
            attemptId: taskId,
            workContractId: "",
            sessionKey,
            stateKey: sessionKey,
          });
        } catch (_) {}
        const transitioned = await watchdogTransitionStaleTask(taskId, task, "timed_out", sink);
        if (transitioned) transitionedCount += 1;
        continue;
      }
      if ((status === "running" || status === "dispatched") && ageMin > STUCK_THRESHOLD_MIN) {
        stuckCount += 1;
        sink.debug?.(`octoclaw watchdog: runner_stuck task=${taskId} status=${status} age_min=${ageMin.toFixed(1)}`);
        try {
          const sessionKey = asString((task as UnknownRecord).session_key);
          updateTaskStateCache(taskId, {
            latestAnomalyNotice: {
              kind: "heartbeat_stale",
              severity: "warning",
              taskId,
              message: `Task stuck in ${status} for ${ageMin.toFixed(0)} minutes exceeds ${STUCK_THRESHOLD_MIN} minute threshold`,
              createdAt: new Date().toISOString(),
            },
          });
          void emitExecutionTransitionNotification({
            transitionKind: "heartbeat_stale",
            projection: buildMinimalProjectionFromTaskState(task, status),
            attemptId: taskId,
            workContractId: "",
            sessionKey,
            stateKey: sessionKey,
          });
        } catch (_) {}
        const transitioned = await watchdogTransitionStaleTask(taskId, task, "timed_out", sink);
        if (transitioned) transitionedCount += 1;
      }
    }

    if (staleCount > 0 || stuckCount > 0 || transitionedCount > 0) {
      sink.debug?.(`octoclaw watchdog: stale_queued=${staleCount} stuck=${stuckCount} transitioned=${transitionedCount}`);
    }
  } catch (error) {
    sink.warn?.(`octoclaw watchdog tick failed: ${String(error)}`);
  }
}
