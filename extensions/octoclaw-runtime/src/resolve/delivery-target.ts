import { asRecord, asString, type UnknownRecord } from "../util/type-coercion.js";

export interface NormalizedDeliveryTarget extends Record<string, unknown> {
  surface: string;
  sessionKey: string;
  session_key: string;
  replyToMessageId: string;
  reply_to_message_id: string;
  threadTs: string;
  thread_ts: string;
  immutable: boolean;
}

export interface DeliveryTargetResolution {
  target: NormalizedDeliveryTarget | null;
  source: "work_contract" | "bound_state" | "session_thread" | "none";
  reason: "resolved" | "missing_delivery_session" | "missing_inbound_anchor";
}

export function isSlackSessionKey(sessionKey: string): boolean {
  return /(?:^|:)slack:/iu.test(asString(sessionKey));
}

export function slackThreadAnchorFromSessionKey(sessionKey: string): string {
  const match = asString(sessionKey).match(/(?:^|:)thread:(\d{10}\.\d{6})(?::|$)/u);
  return match?.[1] || "";
}

function deliveryTargetSessionKey(record: UnknownRecord, fallbackSessionKey = ""): string {
  return asString(record.sessionKey || record.session_key || fallbackSessionKey);
}

function deliveryTargetReplyTo(record: UnknownRecord): string {
  return asString(
    record.replyToMessageId
      || record.reply_to_message_id
      || record.threadTs
      || record.thread_ts,
  );
}

function deliveryTargetSurface(record: UnknownRecord, sessionKey: string): string {
  const explicit = asString(record.surface || record.channel).toLowerCase();
  if (explicit) return explicit;
  return isSlackSessionKey(sessionKey) ? "slack" : "";
}

function hasExplicitDeliveryTarget(value: unknown): boolean {
  return Object.keys(asRecord(value)).length > 0;
}

function normalizeExplicitDeliveryTarget(value: unknown, fallbackSessionKey = ""): NormalizedDeliveryTarget | null {
  return hasExplicitDeliveryTarget(value)
    ? normalizeDeliveryTarget(value, fallbackSessionKey)
    : null;
}

export function normalizeDeliveryTarget(value: unknown, fallbackSessionKey = ""): NormalizedDeliveryTarget | null {
  const record = asRecord(value);
  const sessionKey = deliveryTargetSessionKey(record, fallbackSessionKey);
  const replyToMessageId = deliveryTargetReplyTo(record) || slackThreadAnchorFromSessionKey(sessionKey);
  if (!sessionKey || !replyToMessageId) return null;
  const surface = deliveryTargetSurface(record, sessionKey);
  return {
    surface,
    sessionKey,
    session_key: sessionKey,
    replyToMessageId,
    reply_to_message_id: replyToMessageId,
    threadTs: replyToMessageId,
    thread_ts: replyToMessageId,
    immutable: true,
  };
}

function workContractIdFrom(value: unknown): string {
  const record = asRecord(value);
  const decision = asRecord(record.decision);
  const decisionContract = asRecord(decision.work_contract);
  return asString(
    record.workContractId
      || record.work_contract_id
      || decisionContract.workContractId
      || decisionContract.work_contract_id,
  );
}

export function resolveDurableDeliveryTarget(input: {
  contract?: unknown;
  state?: unknown;
  ctx?: unknown;
  fallbackSessionKeys?: unknown[];
}): DeliveryTargetResolution {
  const contract = asRecord(input.contract);
  const contractTarget = normalizeExplicitDeliveryTarget(
    contract.deliveryTarget || contract.delivery_target,
    asString(contract.sessionKey || contract.session_key),
  );
  if (contractTarget) {
    return { target: contractTarget, source: "work_contract", reason: "resolved" };
  }

  const state = asRecord(input.state);
  const contractId = workContractIdFrom(contract);
  const stateContractId = workContractIdFrom(state);
  if (contractId && stateContractId === contractId) {
    const stateTarget = normalizeExplicitDeliveryTarget(
      state.deliveryTarget || state.delivery_target,
      asString(contract.sessionKey || contract.session_key),
    );
    if (stateTarget) {
      return { target: stateTarget, source: "bound_state", reason: "resolved" };
    }
  }

  const sessionKeys = [
    contract.sessionKey,
    contract.session_key,
    ...(input.fallbackSessionKeys || []),
  ].map((value) => asString(value)).filter(Boolean);
  const sessionKey = sessionKeys[0] || "";
  if (!sessionKey) {
    return { target: null, source: "none", reason: "missing_delivery_session" };
  }

  for (const candidateSessionKey of sessionKeys) {
    const sessionThread = slackThreadAnchorFromSessionKey(candidateSessionKey);
    if (!sessionThread) continue;
    return {
      target: normalizeDeliveryTarget({ sessionKey: candidateSessionKey, replyToMessageId: sessionThread }, candidateSessionKey),
      source: "session_thread",
      reason: "resolved",
    };
  }

  if (sessionKeys.some((candidateSessionKey) => isSlackSessionKey(candidateSessionKey))) {
    return { target: null, source: "none", reason: "missing_inbound_anchor" };
  }

  return { target: null, source: "none", reason: "missing_delivery_session" };
}

export function slackDeliveryRequiresAnchor(sessionKey: string, replyToMessageId: string): boolean {
  return isSlackSessionKey(sessionKey) && !asString(replyToMessageId) && !slackThreadAnchorFromSessionKey(sessionKey);
}
