import { resolveIMMessageTurnAnchor } from "../im/message-turn.js";
import { asNumber, asString, type UnknownRecord } from "../util/type-coercion.js";
import { type AckContext } from "./ack-guard.js";

export type AckOwner = "" | "latency_ack" | "timer_ack";

export interface AckTrackingState extends UnknownRecord {
  ackOwner?: unknown;
  ack_owner?: unknown;
  ackGuardKey?: unknown;
  ackMessageTurnId?: unknown;
  ack_message_turn_id?: unknown;
  latencyAckSent?: unknown;
  reactionAckSent?: boolean;
  reactionAckAttempted?: boolean;
  reactionAckSupported?: boolean;
  reactionAckEnabled?: boolean;
  channelTone?: "chat" | "work" | "cli" | "unknown";
}

interface AckClaimResult {
  claimed: boolean;
  currentOwner: string;
}

const ackStateByStateKey = new Map<string, AckTrackingState>();

export function ackState(stateKey: string): AckTrackingState {
  const key = asString(stateKey);
  return key ? (ackStateByStateKey.get(key) ?? {}) : {};
}

export function updateTrackingState(stateKey: string, patch: UnknownRecord): void {
  const key = asString(stateKey);
  if (!key) {
    return;
  }
  const current = ackStateByStateKey.get(key) ?? {};
  ackStateByStateKey.set(key, { ...current, ...patch });
}

export function currentAckOwner(stateKey: string): string {
  const state = ackState(stateKey);
  return asString(state.ackOwner || state.ack_owner);
}

export function tryClaimAckOwner(stateKey: string, owner: AckOwner): AckClaimResult {
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

export function ackLeaseKey(stateKey: string): string {
  const normalized = asString(stateKey);
  return normalized ? `ack-lease:${normalized}` : "";
}

export function ensureAckTurnTimestamp(stateKey: string): number {
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

export function resolveAckMessageTurnId(
  sessionKey: string,
  stateKey: string,
  state: UnknownRecord = {},
  ctx: AckContext = {},
  metadata: UnknownRecord = {},
  replyToMessageId = "",
): string {
  const anchor = resolveIMMessageTurnAnchor({
    sessionKey,
    stateKey,
    state,
    ctx,
    metadata,
    replyToMessageId,
    fallbackTurnId: "",
  });
  if (anchor) return `${stateKey}:${anchor}`;
  return `${stateKey}:${ensureAckTurnTimestamp(stateKey)}`;
}

export function prepareAckTrackingForMessageTurn(stateKey: string, messageTurnId: string): void {
  const normalizedStateKey = asString(stateKey);
  const normalizedMessageTurnId = asString(messageTurnId);
  if (!normalizedStateKey || !normalizedMessageTurnId) return;
  const current = ackState(normalizedStateKey);
  const previous = asString(current.ackMessageTurnId || current.ack_message_turn_id);
  if (previous === normalizedMessageTurnId) return;
  updateTrackingState(normalizedStateKey, {
    ackMessageTurnId: normalizedMessageTurnId,
    ack_message_turn_id: normalizedMessageTurnId,
    ...(previous ? {
      ackOwner: "",
      ack_owner: "",
      ackKey: "",
      latencyAckSent: false,
      latencyAckText: "",
      latencyAckMode: "",
      reactionAckAttempted: false,
      reaction_ack_attempted: false,
      reactionAckSent: false,
      textAck0Sent: false,
      tier1Sent: false,
      tier2Sent: false,
    } : {}),
  });
}

export function claimAckOwner(stateKey: string, owner: string): string {
  return tryClaimAckOwner(stateKey, asString(owner) as AckOwner).currentOwner;
}

export function updateAckTrackingState(stateKey: string, patch: UnknownRecord): void {
  updateTrackingState(stateKey, patch);
}

export function getAckTrackingState(stateKey: string): AckTrackingState {
  return ackState(stateKey);
}
