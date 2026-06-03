import { type UnknownRecord, asRecord } from "./util/type-coercion.js";
import { stringValue } from "./extension-entry-shared.js";

export const SLACK_MESSAGE_TS_PATTERN = /^\d{10}\.\d{6}$/u;
const INBOUND_MESSAGE_TS_KEYS = new Set([
  "ts",
  "messageTs",
  "message_ts",
  "messageId",
  "message_id",
  "eventTs",
  "event_ts",
  "replyToId",
  "reply_to_id",
  "threadTs",
  "thread_ts",
]);

export function findInboundMessageTimestamp(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const text = value.trim();
    return SLACK_MESSAGE_TS_PATTERN.test(text) ? text : "";
  }
  if (depth > 5) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findInboundMessageTimestamp(item, depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  const record = value as UnknownRecord;
  for (const key of INBOUND_MESSAGE_TS_KEYS) {
    const direct = findInboundMessageTimestamp(record[key], depth + 1, seen);
    if (direct) return direct;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (INBOUND_MESSAGE_TS_KEYS.has(key)) continue;
    const nested = findInboundMessageTimestamp(entry, depth + 1, seen);
    if (nested) return nested;
  }
  return "";
}

export function extractInboundMessageTimestamp(ctx: UnknownRecord, event: UnknownRecord, prompt = ""): string {
  // 1. Known key names in ctx/event (fast path)
  const fromContext = findInboundMessageTimestamp(ctx);
  if (fromContext) return fromContext;
  const fromEvent = findInboundMessageTimestamp(event);
  if (fromEvent) return fromEvent;
  // 2. JSON key-value in prompt: "ts": "1234567890.123456"
  const msgIdMatch = prompt.match(/"(?:reply_to_id|message_id|message_ts|event_ts|thread_ts|ts)"\s*:\s*"(\d{10}\.\d{6})"/u);
  if (msgIdMatch) return stringValue(msgIdMatch[1]);
  // 3. Broad scan: any Slack ts-shaped string in ALL ctx/event field values
  // Covers cases where OpenClaw uses non-standard key names (slackTs, inboundTs, etc.)
  const fromCtxBroad = findAnySlackTs(ctx);
  if (fromCtxBroad) return fromCtxBroad;
  const fromEventBroad = findAnySlackTs(event);
  if (fromEventBroad) return fromEventBroad;
  // 4. Raw text in prompt — Slack ts can appear as bare number, e.g. ts=1777500517.132259
  const rawMatch = prompt.match(/(?:^|[\s"'=,:{[])(\d{10}\.\d{6})(?:$|[\s"',}\]:])/mu);
  if (rawMatch) return stringValue(rawMatch[1]);
  return "";
}

export type InboundMessageTimestampSource = "ctx" | "event" | "prompt" | "fallback_history" | "none";

export function extractInboundMessageTimestampWithSource(ctx: UnknownRecord, event: UnknownRecord, prompt = ""): { ts: string; source: InboundMessageTimestampSource } {
  const fromContext = findInboundMessageTimestamp(ctx);
  if (fromContext) return { ts: fromContext, source: "ctx" };
  const fromEvent = findInboundMessageTimestamp(event);
  if (fromEvent) return { ts: fromEvent, source: "event" };
  const msgIdMatch = prompt.match(/"(?:reply_to_id|message_id|message_ts|event_ts|thread_ts|ts)"\s*:\s*"(\d{10}\.\d{6})"/u);
  if (msgIdMatch) return { ts: stringValue(msgIdMatch[1]), source: "prompt" };
  const fromCtxBroad = findAnySlackTs(ctx);
  if (fromCtxBroad) return { ts: fromCtxBroad, source: "ctx" };
  const fromEventBroad = findAnySlackTs(event);
  if (fromEventBroad) return { ts: fromEventBroad, source: "event" };
  const rawMatch = prompt.match(/(?:^|[\s"'=,:{[])(\d{10}\.\d{6})(?:$|[\s"',}\]:])/mu);
  if (rawMatch) return { ts: stringValue(rawMatch[1]), source: "prompt" };
  return { ts: "", source: "none" };
}

function stripKnownTargetPrefix(value: string): string {
  const text = stringValue(value);
  if (!text) return "";
  const withoutSlackPrefix = text.replace(/^slack:/iu, "");
  return withoutSlackPrefix.replace(/^(?:channel|chat|conversation|group|room|space|user|direct|dm):/iu, "");
}

export function resolveSlackMessageReceivedSessionKey(event: UnknownRecord, ctx: UnknownRecord): string {
  const metadata = asRecord(event.metadata);
  const explicitSessionKey = stringValue(
    ctx.sessionKey
    || event.sessionKey
    || metadata.sessionKey
    || metadata.session_key,
  );
  if (/(?:^|:)slack:/u.test(explicitSessionKey.toLowerCase())) return explicitSessionKey;

  const channel = stringValue(
    ctx.channelId
    || event.channelId
    || metadata.channelId
    || metadata.channel_id
    || metadata.originatingChannel
    || metadata.provider
    || metadata.surface,
  ).toLowerCase();
  const rawTarget = stringValue(
    ctx.conversationId
    || event.conversationId
    || metadata.conversationId
    || metadata.conversation_id
    || metadata.originatingTo
    || metadata.to,
  );
  const target = stripKnownTargetPrefix(rawTarget);
  if (!target) return "";
  const targetUpper = target.toUpperCase();
  const targetKind = (() => {
    if (/^(?:user|direct|dm):/iu.test(rawTarget) || /^U[A-Z0-9]{8,}$/u.test(targetUpper)) return "direct";
    if (/^(?:group|room|space):/iu.test(rawTarget)) return "group";
    if (/^(?:channel|chat|conversation):/iu.test(rawTarget)) return "channel";
    if (/^[CDG][A-Z0-9]{8,}$/u.test(targetUpper)) return "channel";
    return "";
  })();
  if (!targetKind || (channel && channel !== "slack")) return "";
  const threadId = stringValue(metadata.threadId || metadata.thread_id || event.threadId || event.thread_id);
  const base = targetKind === "direct"
    ? `agent:main:slack:default:direct:${target.toLowerCase()}`
    : `agent:main:slack:${targetKind}:${target.toLowerCase()}`;
  return threadId ? `${base}:thread:${threadId}` : base;
}

/** Scan ALL string values in an object tree for a Slack ts pattern.
 * Used as a fallback when the key name is non-standard. */
function findAnySlackTs(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    // Only match strings that look like a standalone Slack ts (not embedded in a larger number)
    if (SLACK_MESSAGE_TS_PATTERN.test(value.trim())) return value.trim();
    // Also match embedded session-key / thread-key forms such as "...:thread:1777737951.706329".
    const m = value.match(/(?:^|[:\s"'=,{[])(\d{10}\.\d{6})(?:$|[:\s"',}\]])/u);
    if (m) return m[1];
    return "";
  }
  if (depth > 4) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAnySlackTs(item, depth + 1, seen);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  if (seen.has(value as object)) return "";
  seen.add(value as object);
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = findAnySlackTs(v, depth + 1, seen);
    if (found) return found;
  }
  return "";
}
