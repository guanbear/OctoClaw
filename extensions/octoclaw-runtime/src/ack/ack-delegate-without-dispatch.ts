import { getAdapterForSession } from "../im/index.js";
import { resolveWorkspaceRoot, runCommand } from "../resolve/env.js";
import { recordPolicyReplay, delegationFailureReply } from "../replay/replay-logger.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
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

  const origin = sessionKey.split(":")[0] || "";
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
