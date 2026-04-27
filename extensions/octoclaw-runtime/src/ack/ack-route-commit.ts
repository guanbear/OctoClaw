import { getAdapterForSession } from "../im/index.js";
import { resolveWorkspaceRoot, runCommand } from "../resolve/env.js";
import { recordDelivery } from "./ack-dedupe.js";
import { resolveAckTargetFromSessionKey } from "./ack-guard.js";
import { recordPolicyReplay } from "../replay/replay-logger.js";

export interface RouteCommitAckPacket {
  routeCommitId: string;
  route: "reply" | "delegate" | "status";
  routeSource: string;
  routeSealId: string;
  turnId: string;
  sessionKey: string;
  hasValidThreadTarget: boolean;
  channelTone: "chat" | "work" | "cli" | "unknown";
  taskClass: string;
  language: "zh" | "en";
}

export interface RouteCommitAckResult {
  sent: boolean;
  skipped: boolean;
  reason: string;
  routeCommitId: string;
  ackKey: string;
  ack_target_resolution_state: string;
  ack_delivery_state: string;
}

export interface RouteCommitAckText {
  text: string;
  route: "reply" | "delegate" | "status";
  truthful: boolean;
}

interface AckSendResult {
  attempted: boolean;
  delivered: boolean;
  sent: boolean;
  error: string;
  reason: string;
  target: string;
  threadId: string;
}

const routeCommitAckOwners = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeRoute(value: unknown): "reply" | "delegate" | "status" {
  const route = asString(value).toLowerCase();
  if (route === "delegate") {
    return "delegate";
  }
  if (["observe", "observer", "status", "inspect", "probe", "scan"].includes(route)) {
    return "status";
  }
  return "reply";
}

function detectLanguage(decision: Record<string, unknown>, state: Record<string, unknown>): "zh" | "en" {
  const routeDecision = readRecord(decision.route_decision);
  const rawLanguage = asString(state.language || state.lang || routeDecision.language || routeDecision.lang).toLowerCase();
  if (["en", "eng", "english"].includes(rawLanguage)) {
    return "en";
  }
  return "zh";
}

function detectChannelTone(decision: Record<string, unknown>, state: Record<string, unknown>): "chat" | "work" | "cli" | "unknown" {
  const routeDecision = readRecord(decision.route_decision);
  const rawTone = asString(
    state.channelTone ||
      state.channel_tone ||
      routeDecision.channelTone ||
      routeDecision.channel_tone,
  ).toLowerCase();
  if (rawTone === "chat" || rawTone === "work" || rawTone === "cli") {
    return rawTone;
  }
  return "unknown";
}

function parseThreadBindingKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  const threadIndex = parts.indexOf("thread");
  if (threadIndex >= 0 && parts[threadIndex + 1]) {
    return parts.slice(0, threadIndex + 2).join(":");
  }
  return sessionKey;
}

function buildRouteCommitAckPacketInternal(
  decision: Record<string, unknown>,
  state: Record<string, unknown>,
  sessionKey: string,
  hasValidThreadTarget: boolean,
): RouteCommitAckPacket | null {
  const workContract = readRecord(decision.work_contract);
  const routeDecision = readRecord(decision.route_decision);
  const routeSeal = readRecord(decision.routeSeal);

  const routeCommitId = asString(workContract.workContractId);
  const routeSealId = asString(routeSeal.routeSealId || decision.route_seal_id || routeSeal.requestId);
  if (!routeCommitId || !routeSealId) {
    return null;
  }

  return {
    routeCommitId,
    route: normalizeRoute(routeDecision.route),
    routeSource: asString(routeDecision.route_source || routeDecision.final_judge_source),
    routeSealId,
    turnId: asString(routeSeal.turnId || workContract.turnId),
    sessionKey,
    hasValidThreadTarget,
    channelTone: detectChannelTone(decision, state),
    taskClass: asString(routeDecision.task_class),
    language: detectLanguage(decision, state),
  };
}

async function sendRouteCommitAckDirect(
  sessionKey: string,
  message: string,
  replyToMessageId?: string,
  cwd?: string,
): Promise<AckSendResult> {
  const resolved = resolveAckTargetFromSessionKey(sessionKey);
  if (!resolved.target) {
    return {
      attempted: false,
      delivered: false,
      sent: false,
      error: "unresolvable_session_target",
      reason: "channel_message_unresolvable",
      target: "",
      threadId: "",
    };
  }

  const adapter = getAdapterForSession(sessionKey);
  if (adapter) {
    const result = await adapter.send({
      sessionKey,
      message,
      replyToMessageId: replyToMessageId || undefined,
      timeoutMs: 5000,
      cwd: asString(cwd) || resolveWorkspaceRoot(),
    });
    return {
      attempted: true,
      delivered: result.delivered,
      sent: result.sent,
      error: result.error || "",
      reason: result.sent ? "channel_message_sent" : "channel_message_failed",
      target: adapter.resolveTarget(sessionKey).target,
      threadId: result.threadTs || "",
    };
  }

  const sessionParts = sessionKey.split(":");
  const origin = sessionParts.length >= 3 && sessionParts[0] === "agent" ? sessionParts[2] : (sessionParts[0] || "");
  if (!origin) {
    return {
      attempted: false,
      delivered: false,
      sent: false,
      error: "unresolvable_session_origin",
      reason: "channel_message_unresolvable",
      target: resolved.target,
      threadId: resolved.threadId,
    };
  }

  const args = ["message", "send", "--channel", origin, "--target", resolved.target, "--json"];
  if (message) {
    args.push("--message", message);
  }
  if (resolved.threadId) {
    args.push("--thread-id", resolved.threadId);
  } else if (replyToMessageId) {
    args.push("--reply-to", replyToMessageId);
  }

  try {
    const result = await runCommand("openclaw", args, {
      cwd: asString(cwd) || resolveWorkspaceRoot(),
      timeoutMs: 5000,
    });
    if (result.code === 0 && result.stdout) {
      try {
        const parsedResult = JSON.parse(result.stdout) as Record<string, unknown>;
        if (parsedResult.ok === true) {
          return {
            attempted: true,
            delivered: true,
            sent: true,
            error: "",
            reason: "channel_message_sent",
            target: resolved.target,
            threadId: resolved.threadId,
          };
        }
      } catch {
        // Ignore malformed JSON and return the command failure shape below.
      }
    }
    return {
      attempted: true,
      delivered: false,
      sent: false,
      error: result.stderr || "send_failed",
      reason: "channel_message_failed",
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
      target: resolved.target,
      threadId: resolved.threadId,
    };
  }
}

export function buildRouteCommitAckPacket(
  decision: Record<string, unknown>,
  sessionKey: string,
  hasValidThreadTarget: boolean,
): RouteCommitAckPacket | null {
  return buildRouteCommitAckPacketInternal(decision, {}, sessionKey, hasValidThreadTarget);
}

export function projectRouteCommitAckText(packet: RouteCommitAckPacket): RouteCommitAckText {
  if (packet.route === "delegate") {
    return {
      text: packet.language === "en"
        ? "Classified for delegation, preparing dispatch. You can check status later."
        : "已判定为委派任务，正在准备派发。稍后可查看状态。",
      route: "delegate",
      truthful: true,
    };
  }

  if (packet.route === "status") {
    return {
      text: packet.language === "en" ? "Reading current status information." : "正在读取当前状态信息。",
      route: "status",
      truthful: true,
    };
  }

  return {
    text: packet.language === "en" ? "Got it — working on it." : "收到，正在处理。",
    route: "reply",
    truthful: true,
  };
}

export function buildRouteCommitAckKey(input: {
  sessionKey: string;
  threadBindingKey: string;
  turnId: string;
  routeCommitId: string;
}): string {
  return `route_commit_ack:${input.sessionKey}:${input.threadBindingKey}:${input.turnId}:${input.routeCommitId}`;
}

export function checkAndSetRouteCommitAck(ackKey: string, owner: string): { allowed: boolean; existingOwner?: string } {
  const key = asString(ackKey);
  const normalizedOwner = asString(owner);
  if (!key) {
    return { allowed: false };
  }

  const existingOwner = routeCommitAckOwners.get(key);
  if (existingOwner !== undefined) {
    return { allowed: false, existingOwner };
  }

  routeCommitAckOwners.set(key, normalizedOwner);
  return { allowed: true };
}

export function resetRouteCommitAckState(): void {
  routeCommitAckOwners.clear();
}

async function recordRouteCommitAckReplay(
  params: {
    sessionKey: string;
    stateKey: string;
    decision: Record<string, unknown>;
    logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
  },
  packet: RouteCommitAckPacket | null,
  ackKey: string,
  outcome: {
    ack_target_resolution_state: string;
    ack_delivery_state: string;
    reason: string;
    sent?: boolean;
    ackMessage?: string;
    target?: string;
    threadId?: string;
  },
): Promise<void> {
  try {
    await recordPolicyReplay(
      "route_commit_ack",
      {
        sessionKey: params.sessionKey,
        stateKey: params.stateKey,
        route: packet?.route ?? "",
        routeSource: packet?.routeSource ?? "",
        routeCommitId: packet?.routeCommitId ?? "",
        routeSealId: packet?.routeSealId ?? "",
        turnId: packet?.turnId ?? "",
        taskClass: packet?.taskClass ?? "",
        channelTone: packet?.channelTone ?? "",
        ackKey,
        ackKind: "route_commit_ack",
        ackSent: Boolean(outcome.sent),
        ackMode: outcome.sent ? "channel_message" : "not_sent",
        ack_target_resolution_state: outcome.ack_target_resolution_state,
        ack_delivery_state: outcome.ack_delivery_state,
        reason: outcome.reason,
        ...(outcome.ackMessage ? { ackMessage: outcome.ackMessage } : {}),
        ...(outcome.target ? { target: outcome.target } : {}),
        ...(outcome.threadId ? { threadId: outcome.threadId } : {}),
      },
      params.logger,
    );
  } catch { /* replay logging failure must not block ACK path */ }
}

export async function sendRouteCommitAck(params: {
  sessionKey: string;
  stateKey: string;
  decision: Record<string, unknown>;
  state: Record<string, unknown>;
  replyToMessageId?: string;
  cwd?: string;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<RouteCommitAckResult> {
  const slackMetadata = readRecord(params.state?.slackMetadata || params.state?.slack_metadata);
  const slackThreadId = asString(slackMetadata.thread_ts || slackMetadata.thread_id || slackMetadata.reply_to_id);
  const stateMessageId = asString(params.state?.message_id || params.state?.inboundMessageTs);
  const effectiveReplyToMessageId = asString(params.replyToMessageId) || stateMessageId || slackThreadId;
  const hasMessageAnchor = Boolean(
    effectiveReplyToMessageId,
  );

  const packet = buildRouteCommitAckPacketInternal(
    params.decision,
    params.state,
    params.sessionKey,
    hasMessageAnchor,
  );
  if (!packet) {
    await recordRouteCommitAckReplay(params, null, "", {
      ack_target_resolution_state: "missing_route_commit_data",
      ack_delivery_state: "not_attempted",
      reason: "missing_route_commit_data",
    });
    return { sent: false, skipped: true, reason: "missing_route_commit_data", routeCommitId: "", ackKey: "", ack_target_resolution_state: "missing_route_commit_data", ack_delivery_state: "not_attempted" };
  }

  const candidateAckKey = buildRouteCommitAckKey({
    sessionKey: params.sessionKey,
    threadBindingKey: readRecord(params.decision.routeSeal).threadBindingKey ? asString(readRecord(params.decision.routeSeal).threadBindingKey) : parseThreadBindingKey(params.sessionKey),
    turnId: packet.turnId,
    routeCommitId: packet.routeCommitId,
  });

  const targetResolution = resolveAckTargetFromSessionKey(params.sessionKey);
  const hasCanonicalTarget = Boolean(targetResolution.target);

  if (packet.route === "reply") {
    const stateGrounding = readRecord(params.decision.state_grounding);
    const toolPolicy = readRecord(params.decision.tool_policy);
    const allowedControlTools = Array.isArray(toolPolicy.allowed_control_tools) ? toolPolicy.allowed_control_tools.map(asString) : [];
    const statusSurfaceReply = asString(stateGrounding.source) === "control_plane_status"
      || allowedControlTools.includes("octoclaw_status");
    if (statusSurfaceReply) {
      await recordRouteCommitAckReplay(params, packet, candidateAckKey, {
        ack_target_resolution_state: "suppressed_status_surface",
        ack_delivery_state: "skipped",
        reason: "status_surface_reply_no_route_ack",
      });
      return { sent: false, skipped: true, reason: "status_surface_reply_no_route_ack", routeCommitId: packet.routeCommitId, ackKey: candidateAckKey, ack_target_resolution_state: "suppressed_status_surface", ack_delivery_state: "skipped" };
    }

    const replyAlreadyVisible = asBoolean(params.state.finalResponseStreaming)
      || asBoolean(params.state.formalReplyVisible)
      || asBoolean(params.state.delivered)
      || asBoolean(params.state.deliveryPending);
    if (replyAlreadyVisible) {
      await recordRouteCommitAckReplay(params, packet, candidateAckKey, {
        ack_target_resolution_state: "suppressed_reply_visible",
        ack_delivery_state: "skipped",
        reason: "reply_already_visible",
      });
      return { sent: false, skipped: true, reason: "reply_already_visible", routeCommitId: packet.routeCommitId, ackKey: candidateAckKey, ack_target_resolution_state: "suppressed_reply_visible", ack_delivery_state: "skipped" };
    }
  }

  if (!hasCanonicalTarget || !hasMessageAnchor) {
    const skipReason = !hasCanonicalTarget ? "target_resolution_failed" : "no_valid_thread_anchor";
    const resolutionState = !hasCanonicalTarget ? "target_resolution_failed" : "no_valid_thread_anchor";
    await recordRouteCommitAckReplay(params, packet, candidateAckKey, {
      ack_target_resolution_state: resolutionState,
      ack_delivery_state: "skipped",
      reason: skipReason,
    });
    return { sent: false, skipped: true, reason: skipReason, routeCommitId: packet.routeCommitId, ackKey: candidateAckKey, ack_target_resolution_state: resolutionState, ack_delivery_state: "skipped" };
  }

  const ackKey = candidateAckKey;

  const claim = checkAndSetRouteCommitAck(ackKey, "route_commit_ack");
  if (!claim.allowed) {
    await recordRouteCommitAckReplay(params, packet, ackKey, {
      ack_target_resolution_state: "skipped_duplicate",
      ack_delivery_state: "skipped",
      reason: "duplicate",
    });
    params.logger?.debug?.(`route commit ack duplicate: ${ackKey}`);
    return { sent: false, skipped: true, reason: "duplicate", routeCommitId: packet.routeCommitId, ackKey, ack_target_resolution_state: "skipped_duplicate", ack_delivery_state: "skipped" };
  }

  const projected = projectRouteCommitAckText(packet);
  const result = await sendRouteCommitAckDirect(
    params.sessionKey,
    projected.text,
    effectiveReplyToMessageId || undefined,
    params.cwd,
  );
  recordDelivery(ackKey, {
    ackKey,
    sent: result.sent,
    deliveredAt: Date.now(),
    target: result.target,
    threadId: result.threadId,
    error: result.error || undefined,
  });

  const sent = Boolean(result.delivered || result.sent);
  const ackTargetResolutionState = sent ? "resolved" : (result.attempted ? "resolved_send_failed" : "target_resolution_failed");
  const ackDeliveryState = sent ? "sent" : (result.attempted ? "failed" : "not_attempted");

  await recordRouteCommitAckReplay(params, packet, ackKey, {
    ack_target_resolution_state: ackTargetResolutionState,
    ack_delivery_state: ackDeliveryState,
    reason: result.reason,
    sent,
    ackMessage: projected.text,
    target: result.target,
    threadId: result.threadId,
  });

  return {
    sent,
    skipped: false,
    reason: result.reason,
    routeCommitId: packet.routeCommitId,
    ackKey,
    ack_target_resolution_state: ackTargetResolutionState,
    ack_delivery_state: ackDeliveryState,
  };
}
