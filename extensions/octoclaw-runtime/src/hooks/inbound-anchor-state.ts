import { policyState, type PolicyStateEntry } from "../state/policy-state.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";
import { extractInboundMessageTimestampWithSource } from "../inbound-timestamps.js";
import { resolvePolicyStateKey, resolvePolicyStateKeys } from "../resolve/session.js";
import { buildImmutableDeliveryTarget, deliveryTargetReplyTo } from "./footer-mode.js";

export interface InboundAnchorStateMatch {
  stateKey: string;
  sessionKey: string;
  replyToMessageId: string;
  deliveryTarget: UnknownRecord;
  state: UnknownRecord;
}

function deliveryTargetFromState(state: UnknownRecord): UnknownRecord {
  return asRecord(state.deliveryTarget || state.delivery_target);
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

function promptMatchScore(left: string, right: string): number {
  const normalize = (value: string) => stringValue(value).replace(/\s+/gu, " ").trim().toLowerCase();
  const leftText = normalize(left);
  const rightText = normalize(right);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 100;
  if (leftText.length >= rightText.length && rightText.length >= 12 && leftText.includes(rightText)) return 90;
  if (rightText.length > leftText.length && leftText.length >= 12 && rightText.includes(leftText)) return 80;
  return 0;
}

function canonicalInboundAnchorMatch(key: string, state: UnknownRecord, fallbackReplyToMessageId = ""): InboundAnchorStateMatch | null {
  const initialReplyToMessageId = inboundAnchorFromState(state) || stringValue(fallbackReplyToMessageId);
  if (!initialReplyToMessageId) return null;
  const canonicalKey = stringValue(state.canonicalSessionKey || state.canonical_session_key);
  const canonicalState = canonicalKey && canonicalKey !== key
    ? asRecord(policyState.get(canonicalKey))
    : {};
  const canonicalReplyToMessageId = inboundAnchorFromState(canonicalState);
  const selectedKey = canonicalKey && canonicalReplyToMessageId === initialReplyToMessageId
    ? canonicalKey
    : key;
  const selectedState = selectedKey === canonicalKey && canonicalReplyToMessageId === initialReplyToMessageId
    ? canonicalState
    : state;
  const selectedDeliveryTarget = deliveryTargetFromState(selectedState);
  const fallbackDeliveryTarget = deliveryTargetFromState(state);
  const sessionKey = deliveryTargetSessionKey(selectedState)
    || deliveryTargetSessionKey(state)
    || selectedKey;
  return {
    stateKey: selectedKey,
    sessionKey,
    replyToMessageId: initialReplyToMessageId,
    deliveryTarget: Object.keys(selectedDeliveryTarget).length > 0 ? selectedDeliveryTarget : fallbackDeliveryTarget,
    state: selectedState,
  };
}

function exactPolicyStateForContext(ctx: UnknownRecord): { key: string; state: UnknownRecord } | null {
  const keys = resolvePolicyStateKeys(ctx);
  for (const key of keys) {
    const state = asRecord(policyState.get(key));
    if (!Object.keys(state).length) continue;
    const canonicalKey = stringValue(state.canonicalSessionKey || state.canonical_session_key);
    if (canonicalKey && canonicalKey !== key) {
      const canonicalState = asRecord(policyState.get(canonicalKey));
      if (Object.keys(canonicalState).length > 0) {
        return { key: canonicalKey, state: canonicalState };
      }
    }
    return { key, state };
  }
  return null;
}

function rootSessionKey(value: unknown): string {
  return stringValue(value).replace(/:thread:\d{10}\.\d{6}$/u, "");
}

function stateTimestamp(state: UnknownRecord): number {
  return Number(state.inboundObservedAt || state.inbound_observed_at || state.createdAt || state.updatedAt || 0) || 0;
}

function claimPromptMatchedInboundAnchor(prompt: string, ctx: UnknownRecord): InboundAnchorStateMatch | null {
  const sessionId = stringValue(ctx.sessionId || ctx.session_id);
  const sessionKey = rootSessionKey(ctx.sessionKey || ctx.session_key);
  if (!sessionId || !sessionKey || !prompt) return null;
  const candidates = canonicalPromptMatchedInboundAnchorCandidates(prompt, ctx, sessionId)
    .sort((left, right) => {
      const leftClaimedByCurrent = stringValue(left.state.currentTurnClaimSessionId || left.state.current_turn_claim_session_id) === sessionId;
      const rightClaimedByCurrent = stringValue(right.state.currentTurnClaimSessionId || right.state.current_turn_claim_session_id) === sessionId;
      if (leftClaimedByCurrent !== rightClaimedByCurrent) return leftClaimedByCurrent ? -1 : 1;
      if (left.score !== right.score) return right.score - left.score;
      return stateTimestamp(left.state) - stateTimestamp(right.state);
    });
  const selected = candidates[0];
  if (!selected) return null;
  const selectedState = {
    ...selected.state,
    currentTurnClaimSessionId: sessionId,
    current_turn_claim_session_id: sessionId,
    currentTurnClaimedAt: Date.now(),
    current_turn_claimed_at: Date.now(),
  };
  policyState.set(selected.key, selectedState as PolicyStateEntry);
  policyState.set(sessionId, {
    ...selectedState,
    canonicalSessionKey: selected.key,
    canonical_session_key: selected.key,
  } as PolicyStateEntry);
  return canonicalInboundAnchorMatch(selected.key, selectedState);
}

function canonicalPromptMatchedInboundAnchorCandidates(
  prompt: string,
  ctx: UnknownRecord = {},
  sessionId = "",
): Array<{ key: string; state: UnknownRecord; score: number }> {
  const rootKey = rootSessionKey(ctx.sessionKey || ctx.session_key);
  return policyState.entries()
    .map((entry) => ({ key: stringValue(entry.key), state: asRecord(entry.state) }))
    .map((entry) => ({ ...entry, score: promptMatchScore(prompt, stringValue(entry.state.prompt)) }))
    .filter((entry) => {
      if (!entry.key || entry.score <= 0) return false;
      const canonicalKey = stringValue(entry.state.canonicalSessionKey || entry.state.canonical_session_key);
      if (canonicalKey && canonicalKey !== entry.key) return false;
      if (!inboundAnchorFromState(entry.state)) return false;
      const candidateSessionKey = rootSessionKey(deliveryTargetSessionKey(entry.state));
      if (rootKey && candidateSessionKey && candidateSessionKey !== rootKey) return false;
      const claimSessionId = stringValue(entry.state.currentTurnClaimSessionId || entry.state.current_turn_claim_session_id);
      return !sessionId || !claimSessionId || claimSessionId === sessionId;
    });
}

function canonicalPromptMatchedInboundAnchor(prompt: string, ctx: UnknownRecord = {}): InboundAnchorStateMatch | null {
  const candidates = canonicalPromptMatchedInboundAnchorCandidates(prompt, ctx);
  const matchedAnchors = new Set(candidates.map((entry) => inboundAnchorFromState(entry.state)).filter(Boolean));
  if (matchedAnchors.size > 1) return null;
  const selected = candidates
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return stateTimestamp(right.state) - stateTimestamp(left.state);
    })[0];
  return selected ? canonicalInboundAnchorMatch(selected.key, selected.state) : null;
}

function statePromptMatches(prompt: string, state: UnknownRecord): boolean {
  const statePrompt = stringValue(state.prompt);
  return Boolean(prompt && statePrompt && promptsEquivalent(prompt, statePrompt));
}

export function inboundAnchorFromState(state: unknown): string {
  const record = asRecord(state);
  return deliveryTargetReplyTo(record)
    || stringValue(record.inboundMessageTs || record.inbound_message_ts || record.replyToMessageId || record.reply_to_message_id || record.message_id || record.messageId);
}

export function promptMatchedInboundAnchor(prompt: string): InboundAnchorStateMatch | null {
  const canonicalMatch = canonicalPromptMatchedInboundAnchor(prompt);
  if (canonicalMatch) return canonicalMatch;
  const match = policyState.findByPrompt(prompt);
  const state = asRecord(match.state);
  if (!match.key) return null;
  return canonicalInboundAnchorMatch(match.key, state);
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
  const statePrompt = stringValue(state.prompt);
  if (input.currentStateKey && input.resolvedStateKey === input.currentStateKey) {
    if (input.prompt && statePrompt && !promptsEquivalent(input.prompt, statePrompt)) {
      return null;
    }
    return canonicalInboundAnchorMatch(input.resolvedStateKey, state, replyToMessageId);
  }
  if (promptsEquivalent(input.prompt, stringValue(state.prompt))) {
    return canonicalInboundAnchorMatch(input.resolvedStateKey, state, replyToMessageId);
  }
  const promptMatch = promptMatchedInboundAnchor(input.prompt);
  if (promptMatch?.replyToMessageId === replyToMessageId) {
    return promptMatch;
  }
  return null;
}

export function resolveCurrentTurnBinding(input: {
  prompt: string;
  ctx?: UnknownRecord;
  event?: UnknownRecord;
  fallbackStateKey?: string;
  fallbackState?: unknown;
}): InboundAnchorStateMatch | null {
  const ctx = asRecord(input.ctx);
  const event = asRecord(input.event);
  const prompt = stringValue(input.prompt);
  const mergedCtx = { ...event, ...ctx };
  const explicitAnchor = extractInboundMessageTimestampWithSource(ctx, event, prompt);
  if (explicitAnchor.ts) {
    const stateKey = resolvePolicyStateKey({
      ...mergedCtx,
      inboundMessageTs: explicitAnchor.ts,
      messageId: explicitAnchor.ts,
      message_id: explicitAnchor.ts,
      replyToMessageId: explicitAnchor.ts,
    });
    const state = asRecord(policyState.get(stateKey));
    const exact = Object.keys(state).length > 0
      ? canonicalInboundAnchorMatch(stateKey, state, explicitAnchor.ts)
      : null;
    if (explicitAnchor.source === "ctx" && exact && prompt && !statePromptMatches(prompt, exact.state)) {
      const promptMatch = claimPromptMatchedInboundAnchor(prompt, mergedCtx)
        || promptMatchedInboundAnchor(prompt);
      if (promptMatch && promptMatch.replyToMessageId !== exact.replyToMessageId) return promptMatch;
    }
    if (exact) return exact;
    if (explicitAnchor.source === "ctx" && prompt) {
      const promptMatch = claimPromptMatchedInboundAnchor(prompt, mergedCtx)
        || promptMatchedInboundAnchor(prompt);
      if (promptMatch && promptMatch.replyToMessageId !== explicitAnchor.ts) return promptMatch;
    }
    const sessionKey = stringValue(ctx.sessionKey || ctx.session_key || event.sessionKey || event.session_key || stateKey);
    return {
      stateKey,
      sessionKey,
      replyToMessageId: explicitAnchor.ts,
      deliveryTarget: buildImmutableDeliveryTarget(sessionKey, explicitAnchor.ts),
      state: {},
    };
  }

  const claimedPromptMatch = claimPromptMatchedInboundAnchor(prompt, mergedCtx);
  if (claimedPromptMatch) return claimedPromptMatch;

  const promptMatch = promptMatchedInboundAnchor(prompt);
  if (promptMatch) return promptMatch;

  const fallbackKey = stringValue(input.fallbackStateKey);
  const fallbackState = asRecord(input.fallbackState);
  if (fallbackKey && Object.keys(fallbackState).length > 0) {
    const match = usableExistingInboundAnchor({
      prompt,
      currentStateKey: resolvePolicyStateKey(mergedCtx),
      resolvedStateKey: fallbackKey,
      state: fallbackState,
    });
    if (match) return match;
  }

  const exact = exactPolicyStateForContext(mergedCtx);
  if (exact) {
    return usableExistingInboundAnchor({
      prompt,
      currentStateKey: resolvePolicyStateKey(mergedCtx),
      resolvedStateKey: exact.key,
      state: exact.state,
    });
  }

  return null;
}

export function bindContextToCurrentTurn(ctx: UnknownRecord, binding: InboundAnchorStateMatch): UnknownRecord {
  const sessionKey = stringValue(binding.sessionKey || ctx.sessionKey || ctx.session_key);
  const deliveryTarget = asRecord(binding.deliveryTarget);
  return {
    ...ctx,
    sessionKey,
    session_key: sessionKey,
    canonicalSessionKey: binding.stateKey,
    canonical_session_key: binding.stateKey,
    inboundMessageTs: binding.replyToMessageId,
    inbound_message_ts: binding.replyToMessageId,
    replyToMessageId: binding.replyToMessageId,
    reply_to_message_id: binding.replyToMessageId,
    messageId: binding.replyToMessageId,
    message_id: binding.replyToMessageId,
    ...(Object.keys(deliveryTarget).length > 0 ? { deliveryTarget, delivery_target: deliveryTarget } : {}),
  };
}
