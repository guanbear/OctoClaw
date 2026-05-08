import { sendIMMessage } from "../im/send.js";
import { resolveWorkspaceRoot } from "../resolve/env.js";
import { delegationFailureReply } from "../replay/message-guard.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { isRecord, asString } from "../util/type-coercion.js";
import { resolveAckTargetFromSessionKey } from "./ack-guard.js";

export interface DelegateWithoutDispatchPacket {
  routeCommitId: string;
  routeSealId: string;
  turnId: string;
  sessionKey: string;
  route: "delegate";
  language: "zh" | "en";
  observeMode: boolean;
  intentClass: string;
}

export interface DelegateWithoutDispatchResult {
  sent: boolean;
  skipped: boolean;
  reason: string;
  ackKey: string;
  notificationDeliveryState: string;
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

const delegateWithoutDispatchOwners = new Map<string, string>();

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function detectLanguage(decision: Record<string, unknown>, state: Record<string, unknown>): "zh" | "en" {
  const routeDecision = readRecord(decision.route_decision);
  const rawLanguage = asString(state.language || state.lang || routeDecision.language || routeDecision.lang).toLowerCase();
  return ["en", "eng", "english"].includes(rawLanguage) ? "en" : "zh";
}

function detectObserveMode(decision: Record<string, unknown>): boolean {
  const routeDecision = readRecord(decision.route_decision);
  const judgeRole = asString(routeDecision.judge_role || decision.role).toLowerCase();
  const executionProfile = asString(decision.executionProfile).toLowerCase();
  return judgeRole === "observer_probe" || executionProfile === "observer";
}

async function sendDelegateWithoutDispatchDirect(
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

  const result = await sendIMMessage({
    sessionKey,
    message,
    replyToMessageId: replyToMessageId || undefined,
    timeoutMs: 5000,
    cwd: asString(cwd) || resolveWorkspaceRoot(),
    suppressProjectionFooter: true,
    deliveryKind: "status_reply",
    deliveryTargetSource: asString(replyToMessageId) ? "inbound_anchor" : "session_fallback",
    footerMode: "off",
  });
  return {
    attempted: result.error !== "no_im_adapter",
    delivered: result.sent,
    sent: result.sent,
    error: result.error || "",
    reason: result.sent ? "channel_message_sent" : "channel_message_failed",
    target: resolved.target,
    threadId: result.threadTs || resolved.threadId,
  };
}

export function resetDelegateWithoutDispatchState(): void {
  delegateWithoutDispatchOwners.clear();
}

export function checkAndSetDelegateWithoutDispatch(key: string, owner: string): { allowed: boolean; existingOwner?: string } {
  const ackKey = asString(key);
  const normalizedOwner = asString(owner);
  if (!ackKey) {
    return { allowed: false };
  }

  const existingOwner = delegateWithoutDispatchOwners.get(ackKey);
  if (existingOwner !== undefined) {
    return { allowed: false, existingOwner };
  }

  delegateWithoutDispatchOwners.set(ackKey, normalizedOwner);
  return { allowed: true };
}

export function buildDelegateWithoutDispatchPacket(
  decision: Record<string, unknown>,
  state: Record<string, unknown>,
  sessionKey: string,
): DelegateWithoutDispatchPacket | null {
  const workContract = readRecord(decision.work_contract);
  const routeSeal = readRecord(decision.routeSeal);

  const routeCommitId = asString(workContract.workContractId);
  const routeSealId = asString(routeSeal.routeSealId || decision.route_seal_id || routeSeal.requestId);
  if (!routeCommitId || !routeSealId) {
    return null;
  }

  return {
    routeCommitId,
    routeSealId,
    turnId: asString(routeSeal.turnId || workContract.turnId),
    sessionKey,
    route: "delegate",
    language: detectLanguage(decision, state),
    observeMode: detectObserveMode(decision),
    intentClass: asString(state.conversationIntentClass),
  };
}

export function projectDelegateWithoutDispatchText(
  packet: DelegateWithoutDispatchPacket,
  state: Record<string, unknown>,
): string {
  if (packet.language === "en") {
    return "Delegation was selected but dispatch was not executed. I'll respond once I have real execution results.";
  }

  const content = delegationFailureReply(state).message.content;
  if (Array.isArray(content)) {
    return asString(readRecord(content[0]).text);
  }
  return asString(readRecord(content).text || content);
}

export async function sendDelegateWithoutDispatchNotice(params: {
  sessionKey: string;
  stateKey: string;
  decision: Record<string, unknown>;
  state: Record<string, unknown>;
  replyToMessageId?: string;
  cwd?: string;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<DelegateWithoutDispatchResult> {
  const packet = buildDelegateWithoutDispatchPacket(params.decision, params.state, params.sessionKey);
  if (!packet) {
    return { sent: false, skipped: true, reason: "missing_route_commit_data", ackKey: "", notificationDeliveryState: "not_attempted" };
  }

  const key = `delegate_without_dispatch_notice:${params.sessionKey}:${packet.turnId}:${packet.routeCommitId}`;
  const targetResolution = resolveAckTargetFromSessionKey(params.sessionKey);
  if (!targetResolution.target) {
    return { sent: false, skipped: true, reason: "target_resolution_failed", ackKey: key, notificationDeliveryState: "target_resolution_failed" };
  }

  const replyAnchor = params.replyToMessageId || asString(params.state.message_id) || asString(params.state.inboundMessageTs) || undefined;

  const claim = checkAndSetDelegateWithoutDispatch(key, "delegate_without_dispatch");
  if (!claim.allowed) {
    return { sent: false, skipped: true, reason: "skipped_duplicate", ackKey: key, notificationDeliveryState: "skipped_duplicate" };
  }

  const ackMessage = projectDelegateWithoutDispatchText(packet, params.state);
  const result = await sendDelegateWithoutDispatchDirect(
    params.sessionKey,
    ackMessage,
    replyAnchor,
    params.cwd,
  );
  const sent = Boolean(result.delivered || result.sent);
  const notificationDeliveryState = sent ? "sent" : (result.attempted ? "failed" : "not_attempted");

  try {
    await recordPolicyReplay(
      "delegate_without_dispatch_notice",
      {
        sessionKey: params.stateKey,
        deliverySessionKey: params.sessionKey,
        route: packet.route,
        routeCommitId: packet.routeCommitId,
        routeSealId: packet.routeSealId,
        turnId: packet.turnId,
        delegated: false,
        dispatchExecuted: false,
        spawnExecuted: false,
        delegate_without_dispatch: true,
        ackKey: key,
        ackSent: sent,
        ack_delivery_state: notificationDeliveryState,
        notificationDeliveryState,
        reason: result.reason,
        ackMessage,
        ...(result.target ? { target: result.target } : {}),
        ...(result.threadId ? { threadId: result.threadId } : {}),
      },
      params.logger,
      params.decision,
    );
  } catch {
    // replay logging failure must not block notice path
  }

  return {
    sent,
    skipped: false,
    reason: result.reason,
    ackKey: key,
    notificationDeliveryState,
  };
}
