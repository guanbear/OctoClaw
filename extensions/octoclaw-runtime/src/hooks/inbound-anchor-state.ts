import { policyState } from "../state/policy-state.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";
import { deliveryTargetReplyTo } from "./footer-mode.js";

export interface InboundAnchorStateMatch {
  stateKey: string;
  sessionKey: string;
  replyToMessageId: string;
  state: UnknownRecord;
}

function deliveryTargetSessionKey(state: UnknownRecord): string {
  const target = asRecord(state.deliveryTarget || state.delivery_target);
  return stringValue(
    target.sessionKey
    || target.session_key
    || state.ackGuardKey
    || state.ack_guard_key
    || state.sessionKey
    || state.session_key
    || state.canonicalSessionKey
    || state.canonical_session_key,
  );
}

function promptsEquivalent(left: string, right: string): boolean {
  const normalize = (value: string) => stringValue(value).replace(/\s+/gu, " ").trim().toLowerCase();
  const leftText = normalize(left);
  const rightText = normalize(right);
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;
  const shorter = leftText.length <= rightText.length ? leftText : rightText;
  const longer = leftText.length > rightText.length ? leftText : rightText;
  return shorter.length >= 12 && longer.includes(shorter);
}

export function inboundAnchorFromState(state: unknown): string {
  const record = asRecord(state);
  return deliveryTargetReplyTo(record)
    || stringValue(record.inboundMessageTs || record.inbound_message_ts || record.replyToMessageId || record.reply_to_message_id || record.message_id || record.messageId);
}

export function promptMatchedInboundAnchor(prompt: string): InboundAnchorStateMatch | null {
  const match = policyState.findByPrompt(prompt);
  const state = asRecord(match.state);
  const replyToMessageId = inboundAnchorFromState(state);
  if (!match.key || !replyToMessageId) return null;
  return {
    stateKey: match.key,
    sessionKey: deliveryTargetSessionKey(state),
    replyToMessageId,
    state,
  };
}

export function usableExistingInboundAnchor(input: {
  prompt: string;
  currentStateKey: string;
  resolvedStateKey: string;
  state: unknown;
}): InboundAnchorStateMatch | null {
  const state = asRecord(input.state);
  const replyToMessageId = inboundAnchorFromState(state);
  if (!replyToMessageId) return null;
  if (input.currentStateKey && input.resolvedStateKey === input.currentStateKey) {
    return {
      stateKey: input.resolvedStateKey,
      sessionKey: deliveryTargetSessionKey(state),
      replyToMessageId,
      state,
    };
  }
  if (promptsEquivalent(input.prompt, stringValue(state.prompt))) {
    return {
      stateKey: input.resolvedStateKey,
      sessionKey: deliveryTargetSessionKey(state),
      replyToMessageId,
      state,
    };
  }
  const promptMatch = promptMatchedInboundAnchor(input.prompt);
  if (promptMatch?.replyToMessageId === replyToMessageId) {
    return promptMatch;
  }
  return null;
}
