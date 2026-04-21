import {
  runCommand,
  resolveTaskStatePath,
  resolveWorkspaceRoot,
} from "../resolve/env.js";
import { getAdapterForSession } from "../im/index.js";
import {
  AckStage,
  ackStageText,
  selectAckTemplate,
  type TemplateSelectionInputs,
} from "./ack-templates.js";
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
  shouldSuppressAck,
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
  isDelegatedRoute as isDelegatedRouteName,
} from "../resolve/route-helpers.js";
import {
  parseSessionRoute as canonicalParseSessionRoute,
  resolveAckDeliverySessionKey as canonicalResolveAckDeliverySessionKey,
} from "../resolve/session.js";
import type { AckGateState } from "./ack-burst.js";

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
type AckOwner = "" | "pre_dispatch" | "latency_ack" | "timer_ack";

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
  preDispatchAckSent?: unknown;
  preDispatchAckPending?: unknown;
  latencyAckSent?: unknown;
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
  markPreDispatchSent?: boolean;
  markLatencySent?: boolean;
  markMode?: string;
  messageTurnId?: string;
  stageHint?: string;
  replyToMessageId?: string;
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

function isDelegatedRoute(decision: UnknownRecord): boolean {
  const routeDecision = isRecord(decision.route_decision) ? decision.route_decision : {};
  const route = asString(routeDecision.route).toLowerCase();
  return isDelegatedRouteName(route);
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

function stageFromRoutePhase(routePhase: AckRoutePhase): AckStage {
  switch (routePhase) {
    case "delegate":
      return AckStage.DelegateStarted;
    case "observe":
      return AckStage.ObserveStarted;
    case "reply":
      return AckStage.ReplySoftAck;
    case "pre_route":
    default:
      return AckStage.PreRouteSoftAck;
  }
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
  const route = asString(options.route || routeDecision.route).toLowerCase();
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
  const selected = selectAckTemplate(stage, inputs);
  if (selected?.text) {
    return applyTemplateVars(selected.text, vars);
  }
  return ackStageText(stage, vars);
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

function buildSuppressContext(state: UnknownRecord, ctx: AckContext, routePhase: AckRoutePhase): {
  mainModelStartedOutput?: boolean;
  anchorExists?: boolean;
  channelSupportsUpdate?: boolean;
  userInputActive?: boolean;
  routePhase?: string;
} {
  const channel = isRecord(state.channel) ? state.channel : {};
  const supportsUpdate = channel.supportsUpdate;
  return {
    mainModelStartedOutput: asBoolean(state.mainModelStartedOutput) || asBoolean(state.mainModelFirstTokenSeen),
    anchorExists: Boolean(asString(state.anchorId || state.anchor_id || state.pendingDeliveryId)),
    channelSupportsUpdate: typeof supportsUpdate === "boolean"
      ? supportsUpdate
      : (typeof state.channelSupportsUpdate === "boolean" ? state.channelSupportsUpdate as boolean : undefined),
    userInputActive: asBoolean(state.userInputActive) || asBoolean(ctx.userInputActive),
    routePhase,
  };
}

function buildAckGateState(state: UnknownRecord, _ctx: AckContext): AckGateState {
  return {
    tool_active: asBoolean(state.tool_active),
    delegated_running: asBoolean(state.delegated_running),
    blocked: asBoolean(state.blocked) || asString(state.native_state) === "blocked",
    final_response_streaming: asBoolean(state.final_response_streaming) || asBoolean(state.mainModelFirstTokenSeen) || asBoolean(state.mainModelStartedOutput),
    delivery_pending: asBoolean(state.delivery_pending),
    delivered: asBoolean(state.delivered),
    native_state: asString(state.native_state),
    formal_reply_visible: asBoolean(state.formal_reply_visible),
  };
}

async function sendAckDirectDetailed(
  sessionKey: string,
  message: string,
  cwd?: string,
  options: UnknownRecord = {},
): Promise<AckSendResult> {
  const parsed = canonicalParseSessionRoute(sessionKey);
  const resolved = resolveAckTargetFromSessionKey(sessionKey);
  if (!parsed.origin || !resolved.target) {
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

  const adapter = getAdapterForSession(sessionKey);
  if (adapter) {
    const replyToMessageId = asString(options.replyToMessageId);
    const result = await adapter.send({
      sessionKey,
      message,
      replyToMessageId: replyToMessageId || undefined,
      timeoutMs: Math.max(500, Number(options.timeoutMs || 5000)),
      cwd: asString(cwd) || resolveWorkspaceRoot(),
    });
    return {
      attempted: true,
      delivered: result.delivered,
      sent: result.sent,
      error: result.error || "",
      reason: result.sent ? "channel_message_sent" : "channel_message_failed",
      ack_target_resolution_state: "resolved",
      ack_delivery_state: result.sent ? "sent" : "failed",
      target: adapter.resolveTarget(sessionKey).target,
      threadId: result.threadTs || "",
    };
  }

  const timeoutMs = Math.max(500, Number(options.timeoutMs || 5000));
  const args = ["message", "send", "--channel", parsed.origin, "--target", resolved.target, "--json"];
  if (message) {
    args.push("--message", message);
  }
  if (resolved.threadId) {
    args.push("--thread-id", resolved.threadId);
  }

  try {
    const result = await runCommand("openclaw", args, {
      cwd: asString(cwd) || resolveWorkspaceRoot(),
      timeoutMs,
    });
    if (result.code === 0 && result.stdout) {
      try {
        const parsedResult = JSON.parse(result.stdout) as UnknownRecord;
        if (parsedResult.ok === true) {
          return {
            attempted: true,
            delivered: true,
            sent: true,
            error: "",
            reason: "channel_message_sent",
            ack_target_resolution_state: "resolved",
            ack_delivery_state: "sent",
            target: resolved.target,
            threadId: resolved.threadId,
          };
        }
      } catch {
        // ignore malformed json and fall through to command failure shape
      }
    }
    return {
      attempted: true,
      delivered: false,
      sent: false,
      error: result.stderr || "send_failed",
      reason: "channel_message_failed",
      ack_target_resolution_state: "resolved",
      ack_delivery_state: "failed",
      target: resolved.target,
      threadId: resolved.threadId,
    };
  } catch (error) {
    return {
      attempted: true,
      delivered: false,
      sent: false,
      error: String(error),
      reason: "channel_message_error",
      ack_target_resolution_state: "resolved",
      ack_delivery_state: "failed",
      target: resolved.target,
      threadId: resolved.threadId,
    };
  }
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
      return true;
    }
    sink.debug?.(`octoclaw watchdog: failed to transition task=${taskId}: ${asString(failResult.status)}`);
    return false;
  } catch (err) {
    sink.debug?.(`octoclaw watchdog: error transitioning task=${taskId}: ${String(err)}`);
    return false;
  }
}

function normalizeAckComparableText(value: unknown): string {
  return asString(value)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function lcsLength(left: string, right: string): number {
  if (!left || !right) return 0;
  const previous = new Array<number>(right.length + 1).fill(0);
  const current = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = 0;
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return previous[right.length] || 0;
}

function metadataUserMessage(metadata: UnknownRecord): string {
  for (const candidate of [
    metadata.user_message,
    metadata.userMessage,
    metadata.message_text,
    metadata.messageText,
    metadata.current_turn,
    metadata.prompt,
    metadata.task,
  ]) {
    const text = asString(candidate);
    if (text) return text;
  }
  return "";
}

function shouldSuppressJudgeAckEcho(judgeAckText: string, metadata: UnknownRecord): boolean {
  const normalizedAck = normalizeAckComparableText(judgeAckText);
  const normalizedUserMessage = normalizeAckComparableText(metadataUserMessage(metadata));
  if (!normalizedAck || !normalizedUserMessage) return false;
  if (normalizedUserMessage.includes(normalizedAck)) return true;
  const overlap = lcsLength(normalizedAck, normalizedUserMessage) / Math.max(1, Math.min(normalizedAck.length, normalizedUserMessage.length));
  return overlap > 0.6;
}

async function attemptAckSend(params: AckAttemptParams): Promise<{ sent: boolean; reason: string } | null> {
  const normalizedStateKey = asString(params.stateKey);
  const normalizedSessionKey = asString(params.sessionKey);
  const effectiveState = isRecord(params.state) ? params.state : {};
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

  const suppress = shouldSuppressAck(
    threadKey,
    params.ackStage,
    routePhase,
    buildSuppressContext(effectiveState, effectiveCtx, routePhase),
    buildAckGateState(effectiveState, effectiveCtx),
  );
  if (suppress.suppressed) {
    ackDebug(`attemptAckSend: suppressed reason=${suppress.reason} threadKey=${threadKey} stage=${params.ackStage}`);
    updateTrackingState(normalizedStateKey, {
      ackKey,
      ack_target_resolution_state: `suppressed_${suppress.reason}`,
      ack_delivery_state: "skipped",
    });
    return params.ackOwner === "latency_ack" ? null : null;
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

    ackDebug(`attemptAckSend: sending sessionKey=${normalizedSessionKey} stage=${params.ackStage} message="${params.message.substring(0, 30)}"`);
  const result = await sendAckDirectDetailed(
    normalizedSessionKey,
    params.message,
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
    ...(params.markPreDispatchSent
      ? {
          preDispatchAckSent: Boolean(result.delivered || result.sent),
          preDispatchAckPending: false,
          preDispatchAckText: params.message,
          preDispatchAckMode: params.markMode || "channel_message",
        }
      : {}),
    ...(params.markLatencySent
      ? {
          latencyAckSent: Boolean(result.delivered || result.sent),
          latencyAckText: params.message,
          latencyAckMode: params.markMode || "channel_message",
        }
      : {}),
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
export function preDispatchAckText(decision: UnknownRecord): string {
  return ackStageText(stageFromRoutePhase(resolveRoutePhase(decision)));
}

export function latencyAckText(_decision: UnknownRecord): string {
  return ackStageText(AckStage.ReplySoftAck);
}

export function shouldSendPreDispatchAck(
  decision: UnknownRecord,
  state: UnknownRecord = {},
  ctx: AckContext = {},
): boolean {
  if (!isDelegatedRoute(decision)) {
    return false;
  }
  const preDispatchAck = isRecord(decision.pre_dispatch_ack) ? decision.pre_dispatch_ack : {};
  if (!asBoolean(preDispatchAck.required)) {
    return false;
  }
  if (asBoolean(state.preDispatchAckSent) || asBoolean(state.preDispatchAckPending)) {
    return false;
  }
  const trigger = asString(ctx.trigger).toLowerCase();
  if (trigger && ["heartbeat", "cron", "memory"].includes(trigger)) {
    return false;
  }
  return Boolean(preDispatchAckText(decision));
}

export function shouldSendLatencyAck(
  decision: UnknownRecord,
  state: UnknownRecord = {},
  ctx: AckContext = {},
  toolName = "",
): boolean {
  if (isDelegatedRoute(decision)) {
    return false;
  }
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
  const result = await sendAckDirectDetailed(sessionKey, message, cwd, options);
  return Boolean(result.delivered || result.sent);
}

export function startAckGuard(sessionKey: string, cwd: string, options: UnknownRecord = {}): void {
  const normalizedSessionKey = asString(sessionKey);
  if (!normalizedSessionKey) {
    return;
  }

  const stateKey = asString(options.stateKey || normalizedSessionKey);
  const decision = isRecord(options.decision) ? options.decision : {};
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
      const liveTrackingState = ackState(stateKey);
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
      if (!message) {
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
      }).catch((error) => {
        logger.warn?.(`octoclaw timed ack failed: ${String(error)}`);
      });
    },
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

export async function maybeSendPreDispatchAck(
  decision: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
  logger: AckLogger,
  replyToMessageId?: string,
): Promise<void> {
  if (!shouldSendPreDispatchAck(decision, state, ctx)) {
    return;
  }
  const sessionKey = resolveAckDeliverySessionKey(metadata, stateKey, state, ctx);
  if (!sessionKey) {
    updateTrackingState(stateKey, {
      ackOwner: "pre_dispatch",
      ack_owner: "pre_dispatch",
      ack_target_resolution_state: "missing_session_key",
      ack_delivery_state: "not_attempted",
      preDispatchAckPending: false,
    });
    return;
  }
  try {
    const preDispatchAck = isRecord(decision.pre_dispatch_ack) ? decision.pre_dispatch_ack : {};
    const routePhase = resolveRoutePhase(decision, { routePhase: "delegate" });
    const threadKey = threadKeyFromSessionKey(sessionKey, stateKey);
    const message = templateMessageForStage(
      stageFromRoutePhase(routePhase),
      buildTemplateInputs(state, ctx, routePhase, threadKey),
    );
    if (!message) {
      return;
    }
    const inboundTs = asString(replyToMessageId || metadata.message_id);
    await attemptAckSend({
      sessionKey,
      stateKey,
      ackOwner: "pre_dispatch",
      ackStage: stageFromRoutePhase(routePhase),
      routePhase,
      message,
      metadata,
      state,
      ctx,
      logger,
      timeoutMs: Math.max(500, Number(preDispatchAck.channel_timeout_ms || 5000)),
      ownerTag: "pre_dispatch",
      markPreDispatchSent: true,
      markMode: "channel_message",
      replyToMessageId: inboundTs,
    });
  } catch (error) {
    logger.warn?.(`octoclaw pre-dispatch ack failed: ${String(error)}`);
    updateTrackingState(stateKey, {
      ackOwner: "pre_dispatch",
      ack_owner: "pre_dispatch",
      ack_target_resolution_state: "unresolved",
      ack_delivery_state: "failed",
      preDispatchAckPending: false,
    });
  }
}

export function scheduleEagerPreDispatchAck(
  decision: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
  logger: AckLogger,
  replyToMessageId?: string,
): void {
  if (!shouldSendPreDispatchAck(decision, state, ctx)) {
    return;
  }
  updateTrackingState(stateKey, {
    ackOwner: "pre_dispatch",
    ack_owner: "pre_dispatch",
    preDispatchAckPending: true,
  });
  setTimeout(() => {
    void maybeSendPreDispatchAck(decision, metadata, stateKey, state, ctx, logger, replyToMessageId);
  }, 0);
}

export async function maybeEmitPreDispatchAckProgress(
  onUpdate: unknown,
  decision: UnknownRecord,
  stateKey: string,
  logger: AckLogger,
): Promise<void> {
  const message = preDispatchAckText(decision);
  if (typeof onUpdate !== "function" || !message) {
    return;
  }
  const sender = onUpdate as (payload: unknown) => Promise<unknown> | unknown;
  const candidates: unknown[] = [
    { content: [{ type: "text", text: message }] },
    message,
  ];
  for (const payload of candidates) {
    try {
      await sender(payload);
      updateTrackingState(stateKey, {
        preDispatchAckSent: true,
        preDispatchAckText: message,
        preDispatchAckMode: "progress_update",
      });
      return;
    } catch (error) {
      logger.warn?.(`octoclaw pre-dispatch progress ack failed: ${String(error)}`);
    }
  }
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
  const sessionKey = resolveAckDeliverySessionKey(metadata, stateKey, state, ctx);
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
    const judgeAckText = asString(decision._judge_ack_text);
    const message = judgeAckText && !shouldSuppressJudgeAckEcho(judgeAckText, metadata)
      ? judgeAckText
      : ackStageText(AckStage.ReplySoftAck);
    const liveTrackingState = { ...state, ...ackState(stateKey) };
    const result = await attemptAckSend({
      sessionKey,
      stateKey,
      ackOwner: "latency_ack",
      ackStage: AckStage.ReplySoftAck,
      routePhase: "reply",
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

export async function ensurePreDispatchAck(
  decision: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
  onUpdate: unknown,
  logger: AckLogger,
): Promise<void> {
  const liveState = ackState(stateKey);
  if (asBoolean(liveState.preDispatchAckPending) && !asBoolean(liveState.preDispatchAckSent)) {
    return;
  }

  await maybeSendPreDispatchAck(decision, metadata, stateKey, state, ctx, logger);

  const preDispatchAck = isRecord(decision.pre_dispatch_ack) ? decision.pre_dispatch_ack : {};
  if (!asBoolean(preDispatchAck.fallback_to_progress_update)) {
    return;
  }
  if (asBoolean(ackState(stateKey).preDispatchAckSent)) {
    return;
  }

  await maybeEmitPreDispatchAckProgress(onUpdate, decision, stateKey, logger);
  if (asBoolean(ackState(stateKey).preDispatchAckSent)) {
    updateTrackingState(stateKey, {
      ackOwner: "pre_dispatch",
      ack_owner: "pre_dispatch",
      ack_delivery_state: "sent",
    });
    cancelAckGuardForState(stateKey);
  }
}

export function markMainModelFirstToken(stateKey: string): void {
  const normalizedStateKey = asString(stateKey);
  if (!normalizedStateKey) {
    return;
  }
  markMainModelFirstTokenInTiming(normalizedStateKey);
  tryClaimLease(ackLeaseKey(normalizedStateKey), "main_model", MAIN_MODEL_LEASE_MS);
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
        const transitioned = await watchdogTransitionStaleTask(taskId, task, "timed_out", sink);
        if (transitioned) transitionedCount += 1;
        continue;
      }
      if ((status === "running" || status === "dispatched") && ageMin > STUCK_THRESHOLD_MIN) {
        stuckCount += 1;
        sink.debug?.(`octoclaw watchdog: runner_stuck task=${taskId} status=${status} age_min=${ageMin.toFixed(1)}`);
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

export async function sendReactionAck(
  sessionKey: string,
  messageId: string,
  emoji = "ok_hand",
): Promise<boolean> {
  const adapter = getAdapterForSession(sessionKey);
  if (!adapter) {
    return false;
  }
  if (typeof adapter.react !== "function") {
    return false;
  }
  try {
    const result = await adapter.react({ sessionKey, messageId, emoji });
    if (result.ok) {
      ackDebug(`reaction ack sent: emoji=${emoji} messageId=${messageId}`);
      return true;
    }
    ackDebug(`reaction ack failed: ${result.error}`);
    return false;
  } catch (err) {
    ackDebug(`reaction ack error: ${String(err)}`);
    return false;
  }
}
