import { resolveWorkspaceRoot } from "../resolve/env.js";
import { getAdapterForSession } from "../im/index.js";
import { resolveChannelStreamingMode } from "../im/index.js";
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
  releaseAckKey,
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
  resolveAckTargetFromSessionKey,
  resolveRoutePhase,
  threadKeyFromSessionKey,
} from "./ack-route.js";
import {
  ackLeaseKey,
  ackState,
  ensureAckTurnTimestamp,
  prepareAckTrackingForMessageTurn,
  resolveAckMessageTurnId,
  tryClaimAckOwner,
  updateTrackingState,
  type AckOwner,
} from "./ack-state.js";
import {
  parseSessionRoute as canonicalParseSessionRoute,
  resolveAckDeliverySessionKey as canonicalResolveAckDeliverySessionKey,
} from "../resolve/session.js";
import { type UnknownRecord, isRecord, asString, asBooleanStrict, asNumber } from "../util/type-coercion.js";
export {
  STALE_QUEUED_THRESHOLD_MIN,
  STUCK_THRESHOLD_MIN,
  WATCHDOG_DEBOUNCE_MS,
  WATCHDOG_INTERVAL_MS,
  watchdogTick,
} from "./ack-watchdog.js";

const ACK_DEBUG = Boolean(process.env.OCTOCLAW_ACK_DEBUG);

function ackDebug(message: string): void {
  if (ACK_DEBUG) {
    console.log(`[octoclaw-ack] ${message}`);
  }
}

function resolveChannelStreamingForAck(sessionKey: string): import("./ack-timing.js").ChannelStreamingMode {
  try {
    return resolveChannelStreamingMode(sessionKey);
  } catch {
    return "off";
  }
}

const ACK_CONTROLLER_LEASE_MS = DEFAULT_ACK_TIMING_CONFIG.tierDelaysMs[2] + 10_000;
const MAIN_MODEL_LEASE_MS = DEFAULT_ACK_TIMING_CONFIG.tierDelaysMs[2] + 10_000;
export const NEUTRAL_INBOUND_ACK_TEXT = "收到，正在判断并准备处理。";
export const NEUTRAL_REACTION_ACK_FALLBACK_MS = 2200;

export { resolveAckTargetFromSessionKey, resolveRoutePhase, threadKeyFromSessionKey } from "./ack-route.js";
export type { AckTarget } from "./ack-route.js";
export {
  currentAckOwner,
  getAckTrackingState,
  updateAckTrackingState,
  claimAckOwner,
} from "./ack-state.js";
export type { AckTrackingState } from "./ack-state.js";

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

export interface NeutralInboundAckResult {
  sent: boolean;
  reason: string;
  mode: "reaction" | "text" | "not_sent";
  error?: string;
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
  allowReactionTextFallback?: boolean;
}

const neutralInboundAckKeys = new Set<string>();

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return asString(error) || "unknown_error";
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

function recordAckOutcome(params: {
  ackKey: string;
  sent: boolean;
  target?: string;
  threadId?: string;
  error?: string;
  ackOwner?: AckOwner | string;
  ackKind?: string;
  deliveryState: string;
  targetResolutionState: string;
  reason: string;
  messageTurnId?: string;
}): void {
  if (!asString(params.ackKey)) return;
  recordDelivery(params.ackKey, {
    ackKey: params.ackKey,
    sent: params.sent,
    deliveredAt: Date.now(),
    target: asString(params.target),
    threadId: asString(params.threadId),
    error: params.error || undefined,
    ackOwner: asString(params.ackOwner) || undefined,
    ackKind: params.ackKind || undefined,
    deliveryState: params.deliveryState,
    targetResolutionState: params.targetResolutionState,
    reason: params.reason,
    messageTurnId: asString(params.messageTurnId) || undefined,
  });
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
    firstTokenSeen: asBooleanStrict(merged.firstTokenSeen) || asBooleanStrict(merged.mainModelFirstTokenSeen) || asBooleanStrict(merged.mainModelStartedOutput),
    formalReplyVisible: asBooleanStrict(merged.formalReplyVisible) || asBooleanStrict(merged.formal_reply_visible),
    deliveryPending: asBooleanStrict(merged.deliveryPending) || asBooleanStrict(merged.delivery_pending),
    delivered: asBooleanStrict(merged.delivered),
    finalResponseStreaming: asBooleanStrict(merged.finalResponseStreaming || merged.final_response_streaming),
    userInputActive: asBooleanStrict(merged.userInputActive) || asBooleanStrict(merged.user_input_active),
    mainModelActive: asBooleanStrict(merged.mainModelActive) || asBooleanStrict(merged.main_model_active) || asBooleanStrict(merged.final_response_streaming),
    toolActive: asBooleanStrict(merged.toolActive) || asBooleanStrict(merged.tool_active),
    delegatedRunning: asBooleanStrict(merged.delegatedRunning) || asBooleanStrict(merged.delegated_running),
    blocked: asBooleanStrict(merged.blocked) || asString(merged.native_state) === "blocked",
    hasValidThreadTarget: hasMessageTarget,
    reactionAckSupported: asBooleanStrict(merged.reactionAckSupported),
    reactionAckEnabled: asBooleanStrict(merged.reactionAckEnabled),
    reactionAckAttempted: asBooleanStrict(merged.reactionAckAttempted) || asBooleanStrict(merged.reaction_ack_attempted),
    reactionAckSent: asBooleanStrict(merged.reactionAckSent),
    textAck0Sent: asBooleanStrict(merged.textAck0Sent) || asBooleanStrict(merged.latencyAckSent),
    tier1Sent: asBooleanStrict(merged.tier1Sent) || Boolean(timerState?.tier1Fired),
    tier2Sent: asBooleanStrict(merged.tier2Sent) || Boolean(timerState?.tier2Fired),
    ackWriterQueued: asBooleanStrict(merged.ackWriterQueued) || asBooleanStrict(merged.ack_writer_queued),
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
    userInputActive: asBooleanStrict(state.userInputActive) || asBooleanStrict(ctx.userInputActive),
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
    suppressProjectionFooter: true,
    deliveryKind: "neutral_ack",
    deliveryTargetSource: asString(options.replyToMessageId) ? "inbound_anchor" : "session_fallback",
    footerMode: "off",
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

async function withAckSendTimeout(
  promise: Promise<AckSendResult>,
  timeoutMs: number,
  timeoutResult: AckSendResult,
): Promise<AckSendResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<AckSendResult>((resolve) => {
        timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function attemptAckSend(params: AckAttemptParams): Promise<{ sent: boolean; reason: string; mode?: "reaction" | "text"; error?: string } | null> {
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
  const messageTurnId = asString(params.messageTurnId) || resolveAckMessageTurnId(
    normalizedSessionKey,
    normalizedStateKey,
    effectiveState,
    effectiveCtx,
    isRecord(params.metadata) ? params.metadata : {},
    asString(params.replyToMessageId),
  );
  prepareAckTrackingForMessageTurn(normalizedStateKey, messageTurnId);
  const ackKey = buildAckKey({
    threadId: ackTarget.threadId || threadKey,
    anchorId: asString(effectiveState.anchorId || effectiveState.anchor_id),
    ackStage: params.ackStage,
    routePhase,
    messageTurnId,
  });

  const packet = buildDecisionPacket(normalizedStateKey, effectiveState, routePhase);
  // Suppress reply ACK0 if route-commit ACK already sent for this turn.
  if (asBooleanStrict(effectiveState.routeCommitAckSent || effectiveState.route_commit_ack_sent) && routePhase === "reply") {
    const reason = "suppressed_by_route_commit_ack";
    ackDebug(`attemptAckSend: route-commit ACK satisfied ACK0 for reply route stateKey=${normalizedStateKey}`);
    recordAckOutcome({
      ackKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: params.ackOwner,
      ackKind: params.markLatencySent ? "latency_ack" : "ack",
      deliveryState: "skipped",
      targetResolutionState: reason,
      reason,
      messageTurnId,
    });
    updateTrackingState(normalizedStateKey, {
      ackKey,
      ack_target_resolution_state: reason,
      ack_delivery_state: "skipped",
      ackSuppressedReason: reason,
      ack_suppressed_reason: reason,
    });
    return null;
  }
  const decision = params.decision ?? decideAckAction(packet);
  if (decision.action === "suppress" || decision.action === "no_action") {
    const reason = `${decision.action}_${decision.reason}`;
    ackDebug(`attemptAckSend: skipped action=${decision.action} reason=${decision.reason} threadKey=${threadKey} stage=${params.ackStage}`);
    recordAckOutcome({
      ackKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: params.ackOwner,
      ackKind: params.markLatencySent ? "latency_ack" : "ack",
      deliveryState: "skipped",
      targetResolutionState: reason,
      reason: decision.reason,
      messageTurnId,
    });
    updateTrackingState(normalizedStateKey, {
      ackKey,
      ack_target_resolution_state: reason,
      ack_delivery_state: "skipped",
      ackSuppressedReason: decision.reason,
      ack_suppressed_reason: decision.reason,
    });
    return null;
  }
  if (decision.action === "cancel_ack_writer") {
    const reason = `cancelled_${decision.reason}`;
    recordAckOutcome({
      ackKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: params.ackOwner,
      ackKind: params.markLatencySent ? "latency_ack" : "ack",
      deliveryState: "skipped",
      targetResolutionState: reason,
      reason: decision.reason,
      messageTurnId,
    });
    cancelAckGuardForState(normalizedStateKey);
    updateTrackingState(normalizedStateKey, {
      ackKey,
      ackWriterQueued: false,
      ack_writer_queued: false,
      ack_target_resolution_state: reason,
      ack_delivery_state: "skipped",
      ackSuppressedReason: decision.reason,
      ack_suppressed_reason: decision.reason,
    });
    return null;
  }

  const idempotency = checkAndSet(ackKey, params.ownerTag);
  if (!idempotency.allowed) {
    ackDebug(`attemptAckSend: duplicate ackKey=${ackKey} existing=${idempotency.existingOwner}`);
    recordAckOutcome({
      ackKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: params.ackOwner,
      ackKind: params.markLatencySent ? "latency_ack" : "ack",
      deliveryState: "skipped",
      targetResolutionState: "skipped_duplicate",
      reason: "duplicate",
      messageTurnId,
    });
    updateTrackingState(normalizedStateKey, {
      ackOwner: params.ackOwner,
      ack_owner: params.ackOwner,
      ackKey,
      ack_target_resolution_state: "skipped_duplicate",
      ack_delivery_state: "skipped",
      ackSuppressedReason: "duplicate",
      ack_suppressed_reason: "duplicate",
    });
    return null;
  }

  const ownerClaim = params.skipOwnerClaim ? { claimed: true, currentOwner: params.ackOwner } : tryClaimAckOwner(normalizedStateKey, params.ackOwner);
  if (!ownerClaim.claimed) {
    ackDebug(`attemptAckSend: owner_conflict owner=${ownerClaim.currentOwner} ackOwner=${params.ackOwner}`);
    recordAckOutcome({
      ackKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: params.ackOwner,
      ackKind: params.markLatencySent ? "latency_ack" : "ack",
      deliveryState: "skipped",
      targetResolutionState: "skipped_owner_conflict",
      reason: "owner_conflict",
      messageTurnId,
    });
    updateTrackingState(normalizedStateKey, {
      ackKey,
      ack_owner: ownerClaim.currentOwner,
      ack_target_resolution_state: "skipped_owner_conflict",
      ack_delivery_state: "skipped",
      ackSuppressedReason: "owner_conflict",
      ack_suppressed_reason: "owner_conflict",
    });
    return params.ackOwner === "latency_ack" ? { sent: false, reason: "owner_conflict" } : null;
  }

  const lease = tryClaimLease(ackLeaseKey(normalizedStateKey), "ack_controller", ACK_CONTROLLER_LEASE_MS);
  if (!lease.claimed || lease.owner !== "ack_controller") {
    const reason = `skipped_lease_${lease.owner || "unknown"}`;
    recordAckOutcome({
      ackKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: params.ackOwner,
      ackKind: params.markLatencySent ? "latency_ack" : "ack",
      deliveryState: "skipped",
      targetResolutionState: reason,
      reason: "lease_conflict",
      messageTurnId,
    });
    updateTrackingState(normalizedStateKey, {
      ackOwner: params.ackOwner,
      ack_owner: params.ackOwner,
      ackKey,
      ack_target_resolution_state: reason,
      ack_delivery_state: "skipped",
      ackSuppressedReason: "lease_conflict",
      ack_suppressed_reason: "lease_conflict",
    });
    return params.ackOwner === "latency_ack" ? { sent: false, reason: "lease_conflict" } : null;
  }

  if (!packet.hasValidThreadTarget) {
    ackDebug(`attemptAckSend: missing_thread_target stateKey=${normalizedStateKey} sessionKey=${normalizedSessionKey}`);
  }

  if (!normalizedSessionKey) {
    ackDebug(`attemptAckSend: missing_session_key stateKey=${normalizedStateKey}`);
    recordAckOutcome({
      ackKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: params.ackOwner,
      ackKind: params.markLatencySent ? "latency_ack" : "ack",
      deliveryState: "not_attempted",
      targetResolutionState: "missing_session_key",
      reason: "missing_session_key",
      messageTurnId,
    });
    updateTrackingState(normalizedStateKey, {
      ackOwner: params.ackOwner,
      ack_owner: params.ackOwner,
      ackKey,
      ack_target_resolution_state: "missing_session_key",
      ack_delivery_state: "not_attempted",
      ackSuppressedReason: "missing_session_key",
      ack_suppressed_reason: "missing_session_key",
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
  const sendTimeoutMs = Math.max(500, Number(params.timeoutMs || 5000));
  const reactionMessageId = asString(params.replyToMessageId || effectiveState.message_id || effectiveState.messageId);
  const reactionTimeoutMs = isReactionAck
    ? Math.min(sendTimeoutMs, NEUTRAL_REACTION_ACK_FALLBACK_MS)
    : sendTimeoutMs;
  const reactionPromise = isReactionAck
    ? sendReactionAckDetailed(
        normalizedSessionKey,
        reactionMessageId,
        asString(effectiveCtx.cwd) || process.cwd(),
        { timeoutMs: reactionTimeoutMs, emoji: effectiveState.reactionAckEmoji || effectiveState.reaction_ack_emoji },
      ).catch((error: unknown): AckSendResult => ({
        attempted: true,
        delivered: false,
        sent: false,
        error: unknownErrorMessage(error),
        reason: "reaction_ack_failed",
        ack_target_resolution_state: "resolved_send_failed",
        ack_delivery_state: "failed",
        target: ackTarget.target,
        threadId: ackTarget.threadId || threadKey,
      }))
    : null;
  let result = isReactionAck
    ? await withAckSendTimeout(
        reactionPromise as Promise<AckSendResult>,
        reactionTimeoutMs,
        {
          attempted: true,
          delivered: false,
          sent: false,
          error: `reaction_ack_timeout_after_${reactionTimeoutMs}ms`,
          reason: "reaction_ack_timeout",
          ack_target_resolution_state: "resolved_send_failed",
          ack_delivery_state: "failed",
          target: ackTarget.target,
          threadId: ackTarget.threadId || threadKey,
        },
      )
    : await sendAckMessage(
        normalizedSessionKey,
        message,
        asString(effectiveCtx.cwd) || process.cwd(),
        { timeoutMs: sendTimeoutMs, replyToMessageId: params.replyToMessageId },
      );
  const reactionAckDelivered = isReactionAck && Boolean(result.delivered || result.sent);
  let reactionTextFallbackSent = false;
  let deliveredMessage = message;
  if (isReactionAck && !reactionAckDelivered) {
    if (params.allowReactionTextFallback) {
      const fallback = await sendAckMessage(
        normalizedSessionKey,
        message,
        asString(effectiveCtx.cwd) || process.cwd(),
        { timeoutMs: Math.max(500, Number(params.timeoutMs || 5000)), replyToMessageId: params.replyToMessageId },
      );
      reactionTextFallbackSent = Boolean(fallback.delivered || fallback.sent);
      result = {
        ...fallback,
        error: reactionTextFallbackSent ? "" : fallback.error || result.error || "reaction_ack_failed",
        reason: reactionTextFallbackSent ? "reaction_ack_failed_text_fallback_sent" : fallback.reason || "reaction_ack_failed_text_fallback_failed",
        ack_delivery_state: reactionTextFallbackSent ? ackDeliveryState(fallback) : "failed",
        ack_target_resolution_state: reactionTextFallbackSent
          ? ackTargetResolutionState(fallback)
          : fallback.attempted ? "resolved_send_failed" : "target_resolution_failed",
      };
    } else {
      result = {
        ...result,
        sent: false,
        delivered: false,
        error: result.error || "reaction_ack_failed",
        reason: "reaction_ack_failed_no_text_fallback",
        ack_delivery_state: "failed",
        ack_target_resolution_state: result.attempted ? "resolved_send_failed" : "target_resolution_failed",
      };
    }
  }
  const finalSent = Boolean(result.delivered || result.sent);

  recordAckOutcome({
    ackKey,
    sent: finalSent,
    target: result.target,
    threadId: result.threadId || ackTarget.threadId || threadKey,
    error: result.error || undefined,
    ackOwner: params.ackOwner,
    ackKind: params.markLatencySent ? "latency_ack" : "ack",
    deliveryState: ackDeliveryState(result),
    targetResolutionState: ackTargetResolutionState(result),
    reason: result.reason,
    messageTurnId,
  });

  updateTrackingState(normalizedStateKey, {
    ackOwner: params.ackOwner,
    ack_owner: params.ackOwner,
    ackKey,
    ackMessageTurnId: messageTurnId,
    ack_message_turn_id: messageTurnId,
    ack_target_resolution_state: ackTargetResolutionState(result),
    ack_delivery_state: ackDeliveryState(result),
    ...(params.markLatencySent
      ? {
          latencyAckSent: finalSent,
          latencyAckText: finalSent ? deliveredMessage : "",
          latencyAckMode: reactionAckDelivered ? "reaction" : finalSent ? params.markMode || "channel_message" : "not_sent",
          ...(isReactionAck ? { reactionAckAttempted: true, reaction_ack_attempted: true } : {}),
        }
      : {}),
    ...(isReactionAck ? { reactionAckAttempted: true, reaction_ack_attempted: true, reactionAckSent: reactionAckDelivered } : {}),
    ...(decision.action === "send_text_ack0" || reactionTextFallbackSent ? { textAck0Sent: finalSent } : {}),
    ...(decision.ackStage === "tier1" ? { tier1Sent: finalSent } : {}),
    ...(decision.ackStage === "tier2" ? { tier2Sent: finalSent } : {}),
  });

  if (finalSent) {
    ackDebug(`attemptAckSend: sent=true stage=${params.ackStage} target=${result.target}`);
    recordAckSent(threadKey, params.ackStage, routePhase);
    if (params.ackOwner !== "timer_ack") {
      cancelAckGuardForState(normalizedStateKey);
    }
    return { sent: true, reason: result.reason, mode: reactionAckDelivered ? "reaction" : reactionTextFallbackSent || !isReactionAck ? "text" : undefined };
  }

  if (isReactionAck && !params.allowReactionTextFallback) {
    releaseAckKey(ackKey, params.ownerTag);
  }
  return { sent: false, reason: result.reason, mode: "text", error: result.error || undefined };
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
  if (!asBooleanStrict(latencyAck.required)) {
    return false;
  }
  if (asBooleanStrict(state.latencyAckSent)) {
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
      skipOwnerClaim: asBooleanStrict(options.skipOwnerClaim),
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
  const existingTrackingState = ackState(stateKey);
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
    reactionAckSent: asBooleanStrict(baseState.reactionAckSent) || asBooleanStrict(existingTrackingState.reactionAckSent),
    reactionAckAttempted: asBooleanStrict(baseState.reactionAckAttempted)
      || asBooleanStrict(baseState.reaction_ack_attempted)
      || asBooleanStrict(existingTrackingState.reactionAckAttempted)
      || asBooleanStrict(existingTrackingState.reaction_ack_attempted),
    reactionAckSupported: asBooleanStrict(baseState.reactionAckSupported),
    reactionAckEnabled: asBooleanStrict(baseState.reactionAckEnabled),
    channelTone: normalizeChannelTone(baseState.channelTone || baseState.channel_tone),
  });

  createAckTimers({
    stateKey,
    sessionKey: normalizedSessionKey,
    routePhase,
    inboundTs: turnTs,
    config: isRecord(options.ackTimingConfig) ? options.ackTimingConfig as Partial<import("./ack-timing.js").AckTimingConfig> : undefined,
    channelStreaming: resolveChannelStreamingForAck(normalizedSessionKey),
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
        messageTurnId: resolveAckMessageTurnId(normalizedSessionKey, stateKey, liveTrackingState, ctx, {}, replyToMessageId),
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
  updateTrackingState(key, {
    decision,
    decision_updated_at: Date.now(),
  });
  // For delegate/observe routes, tier1/2/3 timers should not fire.
  // They were created with routePhase="pre_route" (before judge completed)
  // using delays [12s, 30s, 90s]. Now that we know the actual route, cancel
  // them so they don't fire and produce suppressed no-op log entries.
  const routePhase = resolveRoutePhase(decision);
  if (routePhase === "delegate" || routePhase === "observe") {
    cancelAckTimers(key);
  }
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

export function resetNeutralInboundAckDedupeForTests(): void {
  neutralInboundAckKeys.clear();
}

function buildNeutralInboundAckKey(sessionKey: string, replyToMessageId: string): string {
  const target = resolveAckTargetFromSessionKey(sessionKey).target.toLowerCase();
  return `neutral:${target || sessionKey.toLowerCase()}:${replyToMessageId}`;
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
  const metadataMessageId = isRecord(metadata) ? asString(metadata.message_id || metadata.messageId) : "";
  const preDecisionState = {
    ...state,
    ...(metadataMessageId ? { message_id: metadataMessageId } : {}),
    userInputActive: asBooleanStrict(state.userInputActive) || asBooleanStrict(ctx.userInputActive),
    toolActive: asBooleanStrict(state.toolActive) || asBooleanStrict(state.tool_active) || Boolean(asString(toolName)),
  };
  const sessionKey = resolveAckDeliverySessionKey(metadata, stateKey, state, ctx);
  const messageTurnId = resolveAckMessageTurnId(sessionKey, stateKey, preDecisionState, ctx, metadata);
  prepareAckTrackingForMessageTurn(stateKey, messageTurnId);
  const ackTarget = resolveAckTargetFromSessionKey(sessionKey);
  const threadKey = threadKeyFromSessionKey(sessionKey, stateKey);
  const preDecisionRecord = preDecisionState as UnknownRecord;
  const latencyAckKey = buildAckKey({
    threadId: ackTarget.threadId || threadKey,
    anchorId: asString(preDecisionRecord.anchorId || preDecisionRecord.anchor_id),
    ackStage: latencyAckStage(decision),
    routePhase,
    messageTurnId,
  });
  const decisionPacket = buildDecisionPacket(stateKey, { ...preDecisionState, ...ackState(stateKey) }, routePhase);
  const ackDecision = decideAckAction(decisionPacket);
  if (ackDecision.action === "cancel_ack_writer") {
    recordAckOutcome({
      ackKey: latencyAckKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: "latency_ack",
      ackKind: "latency_ack",
      deliveryState: "skipped",
      targetResolutionState: `cancelled_${ackDecision.reason}`,
      reason: ackDecision.reason,
      messageTurnId,
    });
    cancelAckGuardForState(stateKey);
    updateTrackingState(stateKey, { ackKey: latencyAckKey, ackWriterQueued: false, ack_writer_queued: false, ackSuppressedReason: ackDecision.reason, ack_suppressed_reason: ackDecision.reason });
    return null;
  }
  if (!ackDecision.action.startsWith("send_")) {
    const reason = `${ackDecision.action}_${ackDecision.reason}`;
    if (!decisionPacket.hasValidThreadTarget) {
      ackDebug(`maybeSendLatencyAck: suppressed due to no valid thread target stateKey=${stateKey} sessionKey=${sessionKey || "unresolved"}`);
    }
    recordAckOutcome({
      ackKey: latencyAckKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: "latency_ack",
      ackKind: "latency_ack",
      deliveryState: "skipped",
      targetResolutionState: reason,
      reason: ackDecision.reason,
      messageTurnId,
    });
    updateTrackingState(stateKey, {
      ackKey: latencyAckKey,
      ack_target_resolution_state: reason,
      ack_delivery_state: "skipped",
      ackSuppressedReason: ackDecision.reason,
      ack_suppressed_reason: ackDecision.reason,
    });
    return null;
  }
  if (!sessionKey) {
    recordAckOutcome({
      ackKey: latencyAckKey,
      sent: false,
      target: ackTarget.target,
      threadId: ackTarget.threadId || threadKey,
      ackOwner: "latency_ack",
      ackKind: "latency_ack",
      deliveryState: "not_attempted",
      targetResolutionState: "missing_session_key",
      reason: "missing_session_key",
      messageTurnId,
    });
    updateTrackingState(stateKey, {
      ackOwner: "latency_ack",
      ack_owner: "latency_ack",
      ackKey: latencyAckKey,
      ack_target_resolution_state: "missing_session_key",
      ack_delivery_state: "not_attempted",
      ackSuppressedReason: "missing_session_key",
      ack_suppressed_reason: "missing_session_key",
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
      messageTurnId,
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

export async function sendNeutralInboundAck(params: {
  sessionKey: string;
  stateKey: string;
  replyToMessageId?: string;
  cwd?: string;
  state?: UnknownRecord;
  ctx?: AckContext;
  logger?: AckLogger;
  timeoutMs?: number;
}): Promise<NeutralInboundAckResult> {
  const sessionKey = asString(params.sessionKey);
  const stateKey = asString(params.stateKey || sessionKey);
  const baseState = isRecord(params.state) ? params.state : {};
  const replyToMessageId = asString(
    params.replyToMessageId
      || baseState.inboundMessageTs
      || baseState.message_id
      || baseState.messageId
      || baseState.replyToMessageId,
  );
  const isSlackSession = /(?:^|:)slack:/u.test(sessionKey.toLowerCase());
  if (!sessionKey || !stateKey) {
    return { sent: false, reason: "missing_session_key", mode: "not_sent" };
  }
  if (isSlackSession && !replyToMessageId) {
    updateTrackingState(stateKey, {
      ack_target_resolution_state: "no_valid_thread_target",
      ack_delivery_state: "not_attempted",
      ackSuppressedReason: "no_valid_thread_target",
      ack_suppressed_reason: "no_valid_thread_target",
    });
    return { sent: false, reason: "no_valid_thread_target", mode: "not_sent" };
  }
  const neutralAckKey = isSlackSession && replyToMessageId
    ? buildNeutralInboundAckKey(sessionKey, replyToMessageId)
    : "";
  if (neutralAckKey && neutralInboundAckKeys.has(neutralAckKey)) {
    return { sent: false, reason: "skipped_duplicate", mode: "not_sent" };
  }
  if (neutralAckKey) {
    neutralInboundAckKeys.add(neutralAckKey);
  }

  const reactionAckEnabled = asBooleanStrict(baseState.reactionAckEnabled);
  const reactionAckSupported = asBooleanStrict(baseState.reactionAckSupported);
  const preferText = asBooleanStrict(baseState.neutralAckPreferText) || asBooleanStrict(baseState.neutral_ack_prefer_text);
  const useReactionAck = Boolean(replyToMessageId && reactionAckEnabled && reactionAckSupported && !preferText);
  const decision: AckDecision = useReactionAck
    ? {
        action: "send_reaction_ack",
        reason: "neutral inbound reaction ACK from original Slack anchor",
        ackStage: "ack0",
        modality: "reaction",
        templateKey: "ack0-reaction",
      }
    : {
        action: "send_text_ack0",
        reason: "neutral inbound text ACK from original Slack anchor",
        modality: "text",
        templateKey: "ack0",
      };

  const result = await attemptAckSend({
    sessionKey,
    stateKey,
    ackOwner: "latency_ack",
    ackStage: AckStage.PreRouteSoftAck,
    routePhase: "pre_route",
    message: NEUTRAL_INBOUND_ACK_TEXT,
    state: {
      ...baseState,
      inboundMessageTs: replyToMessageId,
      replyToMessageId,
      message_id: replyToMessageId,
      userInputActive: true,
      reactionAckEnabled,
      reactionAckSupported,
    },
    ctx: params.ctx ?? { cwd: params.cwd },
    logger: params.logger ?? {},
    timeoutMs: Math.max(500, Number(params.timeoutMs || 5000)),
    ownerTag: "neutral_inbound_ack",
    markLatencySent: true,
    markMode: useReactionAck ? "reaction" : "channel_message",
    replyToMessageId,
    decision,
    allowReactionTextFallback: false,
  });
  if (neutralAckKey && !result?.sent) {
    neutralInboundAckKeys.delete(neutralAckKey);
  }
  return {
    sent: Boolean(result?.sent),
    reason: result?.reason || "not_sent",
    mode: result?.sent ? result.mode || (useReactionAck ? "reaction" : "text") : "not_sent",
    error: result?.error || undefined,
  };
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
