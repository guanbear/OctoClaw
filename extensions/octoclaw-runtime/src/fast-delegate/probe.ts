import { stableHash } from "../resolve/env.js";
import { extractPromptText } from "../resolve/policy-resolver.js";
import {
  buildPolicyMetadata,
  isManagedAgentContext,
  parseSessionRoute,
  promptsEquivalent,
  resolvePolicyStateKey,
  resolvePolicyStateKeys,
} from "../resolve/session.js";
import { isRecord, type UnknownRecord } from "../util/type-coercion.js";

export interface BeforeDispatchProbeInput {
  event: UnknownRecord;
  ctx: UnknownRecord;
  lifecycleEvent?: UnknownRecord;
  lifecycleCtx?: UnknownRecord;
}

export interface FastDelegateProbeResult {
  candidateCtx: UnknownRecord;
  beforeDispatchStateKey: string;
  lifecycleStateKey: string;
  stateKeyMatch: boolean;
  stateKeyCompatible: boolean;
  aliases: string[];
  prompt: string;
  lifecyclePrompt: string;
  promptEquivalent: boolean;
  isManagedAgentContext: boolean;
  metadata: UnknownRecord;
  hasSlackAnchor: boolean;
  replay: UnknownRecord;
}

function recordValue(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function nestedRecord(source: UnknownRecord, key: string): UnknownRecord {
  return recordValue(source[key]);
}

function nestedString(source: UnknownRecord, key: string, ...nestedKeys: string[]): string {
  let current: UnknownRecord = source;
  for (const nestedKey of nestedKeys) {
    current = nestedRecord(current, nestedKey);
  }
  return stringValue(current[key]);
}

function extractCandidatePromptSource(event: UnknownRecord): string {
  return firstString(
    event.body,
    event.text,
    event.content,
    event.prompt,
    event.raw,
    event.message,
    nestedString(event, "text", "message"),
    nestedString(event, "body", "message"),
    nestedString(event, "content", "message"),
    nestedString(event, "text", "payload"),
    nestedString(event, "body", "payload"),
    nestedString(event, "content", "payload"),
  );
}

export function extractBeforeDispatchPrompt(event: UnknownRecord): string {
  const source = extractCandidatePromptSource(event);
  if (source) {
    return extractPromptText({ prompt: source });
  }
  return extractPromptText({ messages: event.messages });
}

export function buildBeforeDispatchManagedContext(event: UnknownRecord, ctx: UnknownRecord): UnknownRecord {
  const payload = nestedRecord(event, "payload");
  const message = nestedRecord(event, "message");
  const rawEvent = nestedRecord(event, "event");
  const rawCtx = recordValue(ctx);

  const sessionKey = firstString(
    rawCtx.sessionKey,
    rawCtx.canonicalSessionKey,
    event.sessionKey,
    event.session_key,
    payload.sessionKey,
    payload.session_key,
    rawCtx.sessionId,
    event.sessionId,
    event.conversationId,
    rawCtx.conversationId,
  );
  const sessionId = firstString(
    rawCtx.sessionId,
    event.sessionId,
    event.session_id,
    payload.sessionId,
    payload.session_id,
    sessionKey,
    rawCtx.conversationId,
    event.conversationId,
  );
  const canonicalSessionKey = firstString(
    rawCtx.canonicalSessionKey,
    event.canonicalSessionKey,
    event.canonical_session_key,
    payload.canonicalSessionKey,
    payload.canonical_session_key,
    sessionKey,
  );
  const messageTs = firstString(
    rawCtx.messageTs,
    event.messageTs,
    event.message_ts,
    event.ts,
    event.timestamp,
    message.ts,
    rawEvent.ts,
    payload.messageTs,
    payload.message_ts,
  );
  const threadTs = firstString(
    rawCtx.threadTs,
    event.threadTs,
    event.thread_ts,
    message.thread_ts,
    rawEvent.thread_ts,
    payload.threadTs,
    payload.thread_ts,
  );
  const messageId = firstString(
    rawCtx.messageId,
    event.messageId,
    event.message_id,
    message.client_msg_id,
    rawEvent.client_msg_id,
    messageTs,
  );
  const channelId = firstString(
    rawCtx.channelId,
    rawCtx.channel,
    event.channelId,
    event.channel_id,
    event.channel,
    payload.channelId,
    payload.channel_id,
    payload.channel,
    message.channel,
    rawEvent.channel,
  );

  return {
    ...rawCtx,
    sessionKey,
    sessionId,
    canonicalSessionKey,
    channelId,
    messageId,
    messageTs,
    threadTs,
    ts: firstString(rawCtx.ts, event.ts, event.timestamp, messageTs),
    eventId: firstString(rawCtx.eventId, event.eventId, event.event_id, payload.eventId, payload.event_id),
    agentId: firstString(rawCtx.agentId, event.agentId, event.agent_id, payload.agentId, payload.agent_id, "main"),
    trigger: firstString(rawCtx.trigger, event.trigger, payload.trigger, "message"),
    messageProvider: firstString(rawCtx.messageProvider, event.messageProvider, event.message_provider, payload.messageProvider, payload.message_provider),
    conversationId: firstString(rawCtx.conversationId, event.conversationId, event.conversation_id, payload.conversationId, payload.conversation_id),
    senderId: firstString(rawCtx.senderId, event.senderId, event.sender_id, event.user, message.user, rawEvent.user, payload.senderId, payload.sender_id),
  };
}

function sessionAliasesForKey(key: string): string[] {
  const route = parseSessionRoute(key);
  const aliases = [key].filter(Boolean);
  if (route.bindingKey) aliases.push(`binding:${route.bindingKey}`);
  if (route.threadKey) aliases.push(`thread:${route.threadKey}`);
  return Array.from(new Set(aliases));
}

function sessionAliasesForCtx(ctx: UnknownRecord): string[] {
  return Array.from(new Set(resolvePolicyStateKeys(ctx).flatMap(sessionAliasesForKey)));
}

function hasIntersection(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function hasSlackAnchor(ctx: UnknownRecord, event: UnknownRecord): boolean {
  const sessionKey = firstString(ctx.sessionKey, ctx.canonicalSessionKey, event.sessionKey, event.session_key).toLowerCase();
  const channel = firstString(ctx.channelId, ctx.channel, event.channelId, event.channel_id, event.channel);
  const ts = firstString(ctx.messageTs, ctx.messageId, ctx.ts, event.messageTs, event.message_ts, event.ts, event.timestamp);
  return sessionKey.includes(":slack:") && Boolean(channel) && Boolean(ts);
}

export function runFastDelegateFeasibilityProbe(input: BeforeDispatchProbeInput): FastDelegateProbeResult {
  const event = recordValue(input.event);
  const ctx = recordValue(input.ctx);
  const lifecycleEvent = recordValue(input.lifecycleEvent ?? event);
  const candidateCtx = buildBeforeDispatchManagedContext(event, ctx);
  const lifecycleCtx = recordValue(input.lifecycleCtx ?? candidateCtx);
  const beforeDispatchStateKey = resolvePolicyStateKey(candidateCtx);
  const lifecycleStateKey = resolvePolicyStateKey(lifecycleCtx);
  const beforeAliases = sessionAliasesForCtx(candidateCtx);
  const lifecycleAliases = sessionAliasesForCtx(lifecycleCtx);
  const stateKeyMatch = Boolean(beforeDispatchStateKey && beforeDispatchStateKey === lifecycleStateKey);
  const stateKeyCompatible = stateKeyMatch || hasIntersection(beforeAliases, lifecycleAliases);
  const prompt = extractBeforeDispatchPrompt(event);
  const lifecyclePrompt = extractPromptText(lifecycleEvent);
  const metadata = buildPolicyMetadata(candidateCtx, { stateKey: beforeDispatchStateKey });
  const managed = isManagedAgentContext(candidateCtx);
  const slackAnchor = hasSlackAnchor(candidateCtx, event);
  const promptEquivalent = promptsEquivalent(prompt, lifecyclePrompt || prompt);

  const replay: UnknownRecord = {
    event: "fast_delegate_probe",
    version: 1,
    managed_agent_context: managed,
    has_slack_anchor: slackAnchor,
    state_key: beforeDispatchStateKey,
    lifecycle_state_key: lifecycleStateKey,
    state_key_match: stateKeyMatch,
    state_key_compatible: stateKeyCompatible,
    aliases: beforeAliases,
    lifecycle_aliases: lifecycleAliases,
    prompt_hash: stableHash(prompt),
    lifecycle_prompt_hash: stableHash(lifecyclePrompt),
    prompt_equivalent: promptEquivalent,
    prompt_length: prompt.length,
    metadata: {
      session_key: metadata.session_key,
      session_origin: metadata.session_origin,
      session_target: metadata.session_target,
      session_thread_id: metadata.session_thread_id,
      message_id: metadata.message_id,
      turn_id: metadata.turn_id,
    },
  };

  return {
    candidateCtx,
    beforeDispatchStateKey,
    lifecycleStateKey,
    stateKeyMatch,
    stateKeyCompatible,
    aliases: beforeAliases,
    prompt,
    lifecyclePrompt,
    promptEquivalent,
    isManagedAgentContext: managed,
    metadata,
    hasSlackAnchor: slackAnchor,
    replay,
  };
}
