import { createHash } from "node:crypto";
import { normalizeDeliveryTarget, type NormalizedDeliveryTarget } from "./delivery-target.js";
import type { PolicyStateEntry } from "../state/policy-state.js";
import { asRecord, asString, type UnknownRecord } from "../util/type-coercion.js";

export type ReplyFinalDeliveryStatus = "pending" | "delivered" | "skipped" | "failed";

export interface ReplyFinalDeliveryIntent extends Record<string, unknown> {
  intentId: string;
  stateKey: string;
  sessionKey: string;
  replyToMessageId: string;
  threadTs: string;
  deliveryTarget: NormalizedDeliveryTarget;
  deliveryTargetSource: "bound_state";
  deliveryStatus: ReplyFinalDeliveryStatus;
  createdAt: number;
  updatedAt: number;
  promptHash?: string;
  finalText?: string;
  finalHash?: string;
  finalSeenAt?: number;
  dedupeKey?: string;
  deliveryMessageId?: string;
  deliveryThreadTs?: string;
  deliveryTransport?: string;
  deliveryError?: string;
  deliveredAt?: number;
  deliveryAttemptedAt?: number;
  skipReason?: string;
}

export type ReplyFinalDeliverySkipReason =
  | "missing_intent"
  | "missing_final"
  | "already_delivered"
  | "native_announce_delivered"
  | "message_tool_delivered"
  | "matching_message_tool_target"
  | "no_missing_delivery_evidence";

export interface ReplyFinalDeliveryDecision {
  shouldSend: boolean;
  reason: "missing_message_tool_delivery" | ReplyFinalDeliverySkipReason;
  intent: ReplyFinalDeliveryIntent | null;
}

export interface ReplyFinalDeliveryResultInput {
  sent: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
  transport?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function intentIdFor(stateKey: string, replyToMessageId: string): string {
  return `rfd_${sha256(`${stateKey}:${replyToMessageId}`).slice(0, 16)}`;
}

function targetFromState(state: unknown, stateKey: string): NormalizedDeliveryTarget | null {
  const record = asRecord(state);
  return normalizeDeliveryTarget(record.deliveryTarget || record.delivery_target, stateKey);
}

function writeIntentAliases(state: UnknownRecord, intent: ReplyFinalDeliveryIntent): PolicyStateEntry {
  return {
    ...state,
    replyFinalDeliveryIntent: intent,
    reply_final_delivery_intent: intent,
    updatedAt: Date.now(),
  } as PolicyStateEntry;
}

export function replyFinalDeliveryIntentFromState(state: unknown): ReplyFinalDeliveryIntent | null {
  const record = asRecord(state);
  const intent = asRecord(record.replyFinalDeliveryIntent || record.reply_final_delivery_intent);
  const intentId = asString(intent.intentId || intent.intent_id);
  const stateKey = asString(intent.stateKey || intent.state_key);
  const sessionKey = asString(intent.sessionKey || intent.session_key);
  const replyToMessageId = asString(intent.replyToMessageId || intent.reply_to_message_id || intent.threadTs || intent.thread_ts);
  if (!intentId || !stateKey || !sessionKey || !replyToMessageId) return null;
  const deliveryTarget = normalizeDeliveryTarget(intent.deliveryTarget || intent.delivery_target, sessionKey);
  if (!deliveryTarget) return null;
  return {
    ...intent,
    intentId,
    stateKey,
    sessionKey,
    replyToMessageId,
    threadTs: replyToMessageId,
    deliveryTarget,
    deliveryTargetSource: "bound_state",
    deliveryStatus: asString(intent.deliveryStatus || intent.delivery_status, "pending") as ReplyFinalDeliveryStatus,
    createdAt: Number(intent.createdAt || intent.created_at || 0) || 0,
    updatedAt: Number(intent.updatedAt || intent.updated_at || 0) || 0,
    finalText: asString(intent.finalText || intent.final_text) || undefined,
    finalHash: asString(intent.finalHash || intent.final_hash) || undefined,
    finalSeenAt: Number(intent.finalSeenAt || intent.final_seen_at || 0) || undefined,
    dedupeKey: asString(intent.dedupeKey || intent.dedupe_key) || undefined,
    deliveryMessageId: asString(intent.deliveryMessageId || intent.delivery_message_id) || undefined,
    deliveryThreadTs: asString(intent.deliveryThreadTs || intent.delivery_thread_ts) || undefined,
    deliveryTransport: asString(intent.deliveryTransport || intent.delivery_transport) || undefined,
    deliveryError: asString(intent.deliveryError || intent.delivery_error) || undefined,
    deliveredAt: Number(intent.deliveredAt || intent.delivered_at || 0) || undefined,
    deliveryAttemptedAt: Number(intent.deliveryAttemptedAt || intent.delivery_attempted_at || 0) || undefined,
    skipReason: asString(intent.skipReason || intent.skip_reason) || undefined,
  };
}

export function createReplyFinalDeliveryIntentForState(input: {
  stateKey: string;
  state: unknown;
  now?: number;
}): PolicyStateEntry {
  const state = asRecord(input.state);
  const stateKey = asString(input.stateKey || state.canonicalSessionKey || state.canonical_session_key);
  const target = targetFromState(state, stateKey);
  if (!stateKey || !target || target.surface !== "slack") return state as PolicyStateEntry;
  const existing = replyFinalDeliveryIntentFromState(state);
  if (existing && existing.replyToMessageId === target.replyToMessageId) return state as PolicyStateEntry;
  const now = input.now ?? Date.now();
  const prompt = asString(state.prompt);
  const intent: ReplyFinalDeliveryIntent = {
    intentId: intentIdFor(stateKey, target.replyToMessageId),
    stateKey,
    sessionKey: target.sessionKey,
    replyToMessageId: target.replyToMessageId,
    threadTs: target.replyToMessageId,
    deliveryTarget: target,
    deliveryTargetSource: "bound_state",
    deliveryStatus: "pending",
    createdAt: now,
    updatedAt: now,
    ...(prompt ? { promptHash: sha256(prompt) } : {}),
  };
  return writeIntentAliases(state, intent);
}

export function recordReplyFinalTextForState(input: {
  state: unknown;
  finalText: string;
  now?: number;
}): PolicyStateEntry {
  const state = asRecord(input.state);
  const intent = replyFinalDeliveryIntentFromState(state);
  const finalText = asString(input.finalText);
  if (!intent || !finalText || finalText.toUpperCase() === "NO_REPLY") return state as PolicyStateEntry;
  const now = input.now ?? Date.now();
  const finalHash = sha256(finalText);
  const next: ReplyFinalDeliveryIntent = {
    ...intent,
    finalText,
    finalHash,
    finalSeenAt: now,
    dedupeKey: `reply-final:${intent.stateKey}:${intent.replyToMessageId}:${finalHash}`,
    deliveryStatus: intent.deliveryStatus === "delivered" ? "delivered" : "pending",
    updatedAt: now,
  };
  return writeIntentAliases(state, next);
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function eventValue(event: unknown, key: string): unknown {
  const root = asRecord(event);
  const result = asRecord(root.result);
  const meta = asRecord(root.meta);
  return root[key] ?? result[key] ?? meta[key];
}

function messagingToolSentTargets(event: unknown): UnknownRecord[] {
  const value = eventValue(event, "messagingToolSentTargets");
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function hasMatchingMessagingToolTarget(event: unknown, intent: ReplyFinalDeliveryIntent): boolean {
  return messagingToolSentTargets(event).some((target) => {
    const provider = asString(target.provider || target.channel).toLowerCase();
    const threadId = asString(target.threadId || target.thread_id || target.threadTs || target.thread_ts);
    return provider === "slack" && threadId === intent.replyToMessageId;
  });
}

function sourceReplyMode(event: unknown, ctx: unknown): string {
  return asString(
    eventValue(event, "sourceReplyDeliveryMode")
    || asRecord(ctx).sourceReplyDeliveryMode
    || asRecord(ctx).source_reply_delivery_mode,
  );
}

export function shouldBackstopReplyFinalDelivery(input: {
  state: unknown;
  event?: unknown;
  ctx?: unknown;
}): ReplyFinalDeliveryDecision {
  const state = asRecord(input.state);
  const intent = replyFinalDeliveryIntentFromState(state);
  if (!intent) return { shouldSend: false, reason: "missing_intent", intent: null };
  if (!intent.finalText || !intent.finalHash || !intent.dedupeKey) {
    return { shouldSend: false, reason: "missing_final", intent };
  }
  if (intent.deliveryStatus === "delivered") return { shouldSend: false, reason: "already_delivered", intent };
  if (state.nativeAnnounceDelivered === true || state.native_announce_delivered === true) {
    return { shouldSend: false, reason: "native_announce_delivered", intent };
  }
  const didSendViaMessagingTool = booleanValue(eventValue(input.event, "didSendViaMessagingTool"));
  if (didSendViaMessagingTool === true) {
    return { shouldSend: false, reason: "message_tool_delivered", intent };
  }
  if (hasMatchingMessagingToolTarget(input.event, intent)) {
    return { shouldSend: false, reason: "matching_message_tool_target", intent };
  }
  if (didSendViaMessagingTool === false || sourceReplyMode(input.event, input.ctx) === "message_tool_only") {
    return { shouldSend: true, reason: "missing_message_tool_delivery", intent };
  }
  return { shouldSend: false, reason: "no_missing_delivery_evidence", intent };
}

export function recordReplyFinalDeliveryResultForState(input: {
  state: unknown;
  result: ReplyFinalDeliveryResultInput;
  now?: number;
}): PolicyStateEntry {
  const state = asRecord(input.state);
  const intent = replyFinalDeliveryIntentFromState(state);
  if (!intent) return state as PolicyStateEntry;
  const now = input.now ?? Date.now();
  const next: ReplyFinalDeliveryIntent = {
    ...intent,
    deliveryStatus: input.result.sent ? "delivered" : "failed",
    deliveryAttemptedAt: now,
    updatedAt: now,
    ...(input.result.sent ? { deliveredAt: now } : {}),
    ...(input.result.messageId ? { deliveryMessageId: input.result.messageId } : {}),
    ...(input.result.threadTs ? { deliveryThreadTs: input.result.threadTs } : {}),
    ...(input.result.transport ? { deliveryTransport: input.result.transport } : {}),
    ...(input.result.error ? { deliveryError: input.result.error } : {}),
  };
  return writeIntentAliases(state, next);
}

export function recordReplyFinalDeliverySkipForState(input: {
  state: unknown;
  reason: ReplyFinalDeliverySkipReason;
  now?: number;
}): PolicyStateEntry {
  const state = asRecord(input.state);
  const intent = replyFinalDeliveryIntentFromState(state);
  if (!intent) return state as PolicyStateEntry;
  const now = input.now ?? Date.now();
  return writeIntentAliases(state, {
    ...intent,
    deliveryStatus: "skipped",
    skipReason: input.reason,
    updatedAt: now,
  });
}
