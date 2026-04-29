import type { TaskStatusProjection } from "@octoclaw/contracts/status-projection";
import type { AnomalyNotice } from "@octoclaw/contracts/work-contract";
import { appendToDeliveryOutbox } from "../delivery/delivery-outbox.js";
import { sendIMMessage } from "../im/send.js";
import { resolveWorkspaceRoot } from "../resolve/env.js";
import { recordDelivery } from "./ack-dedupe.js";
import { resolveAckTargetFromSessionKey } from "./ack-guard.js";
import { recordPolicyReplay } from "../replay/replay.js";

export type ExecutionTransitionKind =
  | "dispatch_materialized"
  | "materialized_no_spawn"
  | "spawn_started"
  | "spawn_failed"
  | "queued_stale"
  | "heartbeat_stale"
  | "timed_out"
  | "result_ready"
  | "delivery_failed";

export interface ExecutionTransitionNotification {
  sent: boolean;
  skipped: boolean;
  reason: string;
  transitionKind: ExecutionTransitionKind;
  notificationKey: string;
  ack_target_resolution_state: string;
  ack_delivery_state: string;
  compactParentPacket?: CompactParentPacket;
}

export interface CompactParentPacket {
  taskId: string;
  status: string;
  modelId?: string;
  backend?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  artifactRefIds: string[];
  childSessionKey?: string;
  runId?: string;
  childRunId?: string;
  latestAnomalyNotice?: AnomalyNotice;
}

export interface ExecutionTransitionReplayPayload extends Record<string, unknown> {
  transitionKind: ExecutionTransitionKind;
  notificationKey: string;
  taskId: string;
  attemptId: string;
  workContractId: string;
  sessionKey: string;
  stateKey: string;
  projectionStatus: string;
  projectionStatusReason: string;
  dispatchExecuted: boolean;
  spawnExecuted: boolean;
  resultMaterialized: boolean;
  ack_target_resolution_state: string;
  ack_delivery_state: string;
  sent: boolean;
  skipped: boolean;
  reason: string;
  occurredAt: string;
  compactParentPacket?: CompactParentPacket;
  ackMessage?: string;
  target?: string;
  threadId?: string;
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

const execTransitionOwners = new Map<string, string>();

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

function detectLanguage(decision: Record<string, unknown> | undefined): "zh" | "en" {
  const record = readRecord(decision);
  const routeDecision = readRecord(record.route_decision);
  const rawLanguage = asString(record.language || record.lang || routeDecision.language || routeDecision.lang).toLowerCase();
  if (["en", "eng", "english"].includes(rawLanguage)) {
    return "en";
  }
  return "zh";
}

function compactDefined<T extends CompactParentPacket>(packet: T): T {
  if ("transcript" in packet) {
    throw new Error("compact_parent_packet_must_not_include_transcript");
  }
  return packet;
}

async function sendExecutionTransitionMessage(
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

  const topLevelFallback = !asString(replyToMessageId) && !resolved.threadId;
  const result = await sendIMMessage({
    sessionKey,
    message,
    replyToMessageId: replyToMessageId || undefined,
    timeoutMs: 5000,
    cwd: asString(cwd) || resolveWorkspaceRoot(),
  });
  return {
    attempted: result.error !== "no_im_adapter",
    delivered: result.sent,
    sent: result.sent,
    error: result.error || "",
    reason: result.sent ? (topLevelFallback ? "top_level_fallback" : "channel_message_sent") : "channel_message_failed",
    target: resolved.target,
    threadId: result.threadTs || resolved.threadId,
  };
}

async function recordExecutionTransitionReplay(
  params: {
    transitionKind: ExecutionTransitionKind;
    projection: TaskStatusProjection;
    attemptId: string;
    workContractId: string;
    sessionKey: string;
    stateKey: string;
    occurredAt: string;
    logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
  },
  notificationKey: string,
  outcome: {
    ack_target_resolution_state: string;
    ack_delivery_state: string;
    sent: boolean;
    skipped: boolean;
    reason: string;
    compactParentPacket?: CompactParentPacket;
    ackMessage?: string;
    target?: string;
    threadId?: string;
  },
): Promise<void> {
  try {
    const payload: ExecutionTransitionReplayPayload = {
      transitionKind: params.transitionKind,
      notificationKey,
      taskId: params.projection.taskId,
      attemptId: params.attemptId,
      workContractId: params.workContractId,
      sessionKey: params.sessionKey,
      stateKey: params.stateKey,
      projectionStatus: params.projection.status,
      projectionStatusReason: asString(params.projection.statusReason),
      dispatchExecuted: asBoolean(params.projection.dispatchExecuted),
      spawnExecuted: asBoolean(params.projection.spawnExecuted),
      resultMaterialized: asBoolean(params.projection.resultMaterialized),
      ack_target_resolution_state: outcome.ack_target_resolution_state,
      ack_delivery_state: outcome.ack_delivery_state,
      sent: outcome.sent,
      skipped: outcome.skipped,
      reason: outcome.reason,
      occurredAt: params.occurredAt,
      ...(outcome.compactParentPacket ? { compactParentPacket: outcome.compactParentPacket } : {}),
      ...(outcome.ackMessage ? { ackMessage: outcome.ackMessage } : {}),
      ...(outcome.target ? { target: outcome.target } : {}),
      ...(outcome.threadId ? { threadId: outcome.threadId } : {}),
    };
    await recordPolicyReplay("execution_transition", payload, params.logger);
  } catch {
    // Replay logging failure must not block the notification path.
  }
}

export function buildCompactParentPacket(projection: TaskStatusProjection): CompactParentPacket {
  return compactDefined({
    taskId: projection.taskId,
    status: projection.status,
    ...(projection.modelId ? { modelId: projection.modelId } : {}),
    ...(projection.backend ? { backend: projection.backend } : {}),
    ...(typeof projection.estimatedCostUsd === "number" ? { estimatedCostUsd: projection.estimatedCostUsd } : {}),
    ...(typeof projection.actualCostUsd === "number" ? { actualCostUsd: projection.actualCostUsd } : {}),
    artifactRefIds: Array.isArray(projection.artifactRefIds) ? [...projection.artifactRefIds] : [],
    ...(projection.childSessionKey ? { childSessionKey: projection.childSessionKey } : {}),
    ...(projection.runId ? { runId: projection.runId } : {}),
    ...(projection.childRunId ? { childRunId: projection.childRunId } : {}),
    ...(projection.latestAnomalyNotice ? { latestAnomalyNotice: projection.latestAnomalyNotice } : {}),
  });
}

export function projectTransitionText(
  transitionKind: ExecutionTransitionKind,
  projection: TaskStatusProjection,
  language: "zh" | "en" = "zh",
): string {
  const textByKind: Record<ExecutionTransitionKind, { zh: string; en: string }> = {
    dispatch_materialized: { zh: "任务已派发，排队中。", en: "Task dispatched, queuing." },
    materialized_no_spawn: { zh: "任务已登记，尚未启动。", en: "Task registered, not yet started." },
    spawn_started: { zh: "任务已启动。", en: "Task started." },
    spawn_failed: { zh: "任务启动失败，正在恢复。", en: "Task failed to start, recovering." },
    queued_stale: { zh: "任务排队超时，正在检查。", en: "Task queue timeout, checking." },
    heartbeat_stale: { zh: "任务进度停滞，正在检查。", en: "Task progress stalled, checking." },
    timed_out: { zh: "任务超时。", en: "Task timed out." },
    result_ready: { zh: "任务完成，等待投递。", en: "Task completed, pending delivery." },
    delivery_failed: { zh: "任务结果投递失败。", en: "Task result delivery failed." },
  };

  if (transitionKind === "spawn_started" && !projection.spawnExecuted) {
    return textByKind.materialized_no_spawn[language];
  }
  return textByKind[transitionKind][language];
}

export function buildExecTransitionKey(input: {
  taskId: string;
  attemptId: string;
  transitionKind: string;
}): string {
  return `exec_transition:${input.taskId}:${input.attemptId}:${input.transitionKind}`;
}

export function checkAndSetExecTransition(key: string, owner: string): { allowed: boolean; existingOwner?: string } {
  const normalizedKey = asString(key);
  const normalizedOwner = asString(owner);
  if (!normalizedKey) {
    return { allowed: false };
  }

  const existingOwner = execTransitionOwners.get(normalizedKey);
  if (existingOwner !== undefined) {
    return { allowed: false, existingOwner };
  }

  execTransitionOwners.set(normalizedKey, normalizedOwner);
  return { allowed: true };
}

export function resetExecTransitionState(): void {
  execTransitionOwners.clear();
}

export async function emitExecutionTransitionNotification(params: {
  transitionKind: ExecutionTransitionKind;
  projection: TaskStatusProjection;
  attemptId: string;
  workContractId: string;
  sessionKey: string;
  stateKey: string;
  decision?: Record<string, unknown>;
  replyToMessageId?: string;
  cwd?: string;
  occurredAt?: string;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<ExecutionTransitionNotification> {
  const occurredAt = asString(params.occurredAt) || new Date().toISOString();
  const notificationKey = buildExecTransitionKey({
    taskId: params.projection.taskId,
    attemptId: params.attemptId,
    transitionKind: params.transitionKind,
  });

  const replayParams = {
    transitionKind: params.transitionKind,
    projection: params.projection,
    attemptId: params.attemptId,
    workContractId: params.workContractId,
    sessionKey: params.sessionKey,
    stateKey: params.stateKey,
    occurredAt,
    logger: params.logger,
  };

  const packet = buildCompactParentPacket(params.projection);
  const text = projectTransitionText(params.transitionKind, params.projection, detectLanguage(params.decision));
  const targetResolution = resolveAckTargetFromSessionKey(params.sessionKey);
  const hasValidTarget = Boolean(targetResolution.target);

  if (!hasValidTarget) {
    const reason = "no_valid_target";
    const ackTargetResolutionState = "no_valid_target";
    await recordExecutionTransitionReplay(replayParams, notificationKey, {
      ack_target_resolution_state: ackTargetResolutionState,
      ack_delivery_state: "skipped",
      sent: false,
      skipped: true,
      reason,
      compactParentPacket: packet,
      ackMessage: text,
    });
    return {
      sent: false,
      skipped: true,
      reason,
      transitionKind: params.transitionKind,
      notificationKey,
      ack_target_resolution_state: ackTargetResolutionState,
      ack_delivery_state: "skipped",
      compactParentPacket: packet,
    };
  }

  const claim = checkAndSetExecTransition(notificationKey, "execution_transition");
  if (!claim.allowed) {
    await recordExecutionTransitionReplay(replayParams, notificationKey, {
      ack_target_resolution_state: "skipped_duplicate",
      ack_delivery_state: "skipped",
      sent: false,
      skipped: true,
      reason: "skipped_duplicate",
    });
    params.logger?.debug?.(`execution transition duplicate: ${notificationKey}`);
    return {
      sent: false,
      skipped: true,
      reason: "skipped_duplicate",
      transitionKind: params.transitionKind,
      notificationKey,
      ack_target_resolution_state: "skipped_duplicate",
      ack_delivery_state: "skipped",
    };
  }

  const result = await sendExecutionTransitionMessage(
    params.sessionKey,
    text,
    params.replyToMessageId,
    params.cwd,
  );
  recordDelivery(notificationKey, {
    ackKey: notificationKey,
    sent: result.sent,
    deliveredAt: Date.now(),
    target: result.target,
    threadId: result.threadId,
    error: result.error || undefined,
  });

  const sent = Boolean(result.delivered || result.sent);
  if (!sent && params.workContractId && ["dispatch_materialized", "spawn_started", "timed_out", "result_ready", "delivery_failed"].includes(params.transitionKind)) {
    try {
      appendToDeliveryOutbox({
        workContractId: params.workContractId,
        kind: "progress",
        parentSessionKey: params.sessionKey,
        replyToMessageId: params.replyToMessageId,
        message: text,
        cwd: params.cwd,
      });
    } catch {}
  }
  const ackTargetResolutionState = sent ? "resolved" : (result.attempted ? "resolved_send_failed" : "no_valid_target");
  const ackDeliveryState = sent ? "sent" : (result.attempted ? "failed" : "queued_for_retry");

  await recordExecutionTransitionReplay(replayParams, notificationKey, {
    ack_target_resolution_state: ackTargetResolutionState,
    ack_delivery_state: ackDeliveryState,
    sent,
    skipped: false,
    reason: result.reason,
    compactParentPacket: packet,
    ackMessage: text,
    target: result.target,
    threadId: result.threadId,
  });

  return {
    sent,
    skipped: false,
    reason: result.reason,
    transitionKind: params.transitionKind,
    notificationKey,
    ack_target_resolution_state: ackTargetResolutionState,
    ack_delivery_state: ackDeliveryState,
  };
}

/**
 * Detects boolean-edge transitions only: dispatch_materialized, spawn_started, and result_ready.
 * Event-driven anomalies (materialized_no_spawn, spawn_failed, queued_stale, heartbeat_stale,
 * timed_out, delivery_failed) must be emitted explicitly at their detection sites.
 */
export function detectExecutionTransition(
  previous: { dispatchExecuted: boolean; spawnExecuted: boolean; resultMaterialized: boolean } | null,
  current: { dispatchExecuted: boolean; spawnExecuted: boolean; resultMaterialized: boolean },
): ExecutionTransitionKind | null {
  if (!previous) {
    if (current.dispatchExecuted && !current.spawnExecuted && !current.resultMaterialized) {
      return "dispatch_materialized";
    }
    return null;
  }
  if (!previous.dispatchExecuted && current.dispatchExecuted && !current.spawnExecuted) {
    return "dispatch_materialized";
  }
  if (previous.dispatchExecuted && !previous.spawnExecuted && current.spawnExecuted) {
    return "spawn_started";
  }
  if (previous.spawnExecuted && !previous.resultMaterialized && current.resultMaterialized) {
    return "result_ready";
  }
  return null;
}
