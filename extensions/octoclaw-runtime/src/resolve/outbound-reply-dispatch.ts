import { firstStringValue, stringValue } from "../extension-entry-shared.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import { guardOutboundMessageForPolicyState } from "../hooks/footer-mode.js";

type ReplyDispatchKind = "tool" | "block" | "final";
type ReplyPayloadLike = UnknownRecord & { text?: unknown };

const replyDispatchProjectionWrapped = new WeakSet<object>();

export function replyDispatchSourceContext(event: UnknownRecord): UnknownRecord {
  return asRecord(event.ctx);
}

function buildReplyDispatchDeliveryContext(event: UnknownRecord): UnknownRecord {
  const source = replyDispatchSourceContext(event);
  const channelId = firstStringValue(
    source.OriginatingChannel,
    source.Surface,
    source.Provider,
    event.originatingChannel,
    event.channelId,
  );
  const conversationId = firstStringValue(
    source.OriginatingTo,
    source.To,
    source.NativeChannelId,
    event.originatingTo,
  );
  const inboundTs = firstStringValue(
    source.MessageSid,
    source.MessageSidFull,
    source.MessageSidFirst,
    source.MessageSidLast,
    source.ReplyToId,
    source.MessageThreadId,
  );
  return {
    channelId,
    channel: channelId,
    conversationId,
    conversation_id: conversationId,
    sessionKey: firstStringValue(event.sessionKey, source.SessionKey),
    session_key: firstStringValue(event.sessionKey, source.SessionKey),
    accountId: firstStringValue(source.AccountId, event.accountId),
    senderId: firstStringValue(source.SenderId, source.From),
    model: firstStringValue(event.model, source.Model, source.model),
    inboundMessageTs: inboundTs,
    messageId: inboundTs,
    message_id: inboundTs,
    replyToMessageId: firstStringValue(source.ReplyToId, source.MessageThreadId, inboundTs),
    reply_to_id: firstStringValue(source.ReplyToId, source.MessageThreadId, inboundTs),
    threadTs: firstStringValue(source.MessageThreadId, source.ReplyToId, inboundTs),
    thread_ts: firstStringValue(source.MessageThreadId, source.ReplyToId, inboundTs),
  };
}

function buildReplyDispatchDeliveryEvent(
  payload: ReplyPayloadLike,
  event: UnknownRecord,
  kind: ReplyDispatchKind,
): UnknownRecord {
  const source = replyDispatchSourceContext(event);
  const to = firstStringValue(
    source.OriginatingTo,
    source.To,
    source.NativeChannelId,
    event.originatingTo,
  );
  const channel = firstStringValue(source.OriginatingChannel, source.Surface, source.Provider, event.originatingChannel);
  const channelId = firstStringValue(source.NativeChannelId, source.OriginatingTo, source.To, event.originatingTo);
  const replyToMessageId = firstStringValue(source.ReplyToId, source.MessageThreadId, source.MessageSid);
  return {
    content: stringValue(payload.text),
    to,
    channel,
    channelId,
    channel_id: channelId,
    conversationId: to,
    conversation_id: to,
    replyToMessageId,
    reply_to_id: replyToMessageId,
    threadTs: firstStringValue(source.MessageThreadId, source.ReplyToId, source.MessageSid),
    thread_ts: firstStringValue(source.MessageThreadId, source.ReplyToId, source.MessageSid),
    sessionKey: firstStringValue(event.sessionKey, source.SessionKey),
    session_key: firstStringValue(event.sessionKey, source.SessionKey),
    metadata: {
      channel,
      channelId,
      channel_id: channelId,
      accountId: firstStringValue(source.AccountId, event.accountId),
      threadTs: firstStringValue(source.MessageThreadId, source.ReplyToId, source.MessageSid),
      thread_ts: firstStringValue(source.MessageThreadId, source.ReplyToId, source.MessageSid),
      replyKind: kind,
    },
  };
}

function projectReplyDispatchPayloadForPolicyState(
  payload: unknown,
  kind: ReplyDispatchKind,
  event: UnknownRecord,
  now = Date.now(),
): ReplyPayloadLike | null {
  const payloadRecord = asRecord(payload) as ReplyPayloadLike;
  if (kind !== "final") return payloadRecord;
  const text = stringValue(payloadRecord.text);
  if (!text) return payloadRecord;
  const deliveryEvent = buildReplyDispatchDeliveryEvent(payloadRecord, event, kind);
  const deliveryCtx = buildReplyDispatchDeliveryContext(event);
  const guarded = guardOutboundMessageForPolicyState(deliveryEvent, deliveryCtx, now);
  if (guarded?.cancel) return null;
  if (guarded?.content && guarded.content !== text) {
    return { ...payloadRecord, text: guarded.content };
  }
  return payloadRecord;
}

export function wrapReplyDispatchFooterProjection(event: UnknownRecord, hookCtx: UnknownRecord, now?: number): boolean {
  const dispatcher = asRecord(hookCtx.dispatcher);
  if (Object.keys(dispatcher).length === 0 || replyDispatchProjectionWrapped.has(dispatcher)) return false;
  const sendFinalReply = dispatcher.sendFinalReply;
  if (typeof sendFinalReply !== "function") return false;
  replyDispatchProjectionWrapped.add(dispatcher);
  dispatcher.sendFinalReply = function wrappedSendFinalReply(payload: unknown): boolean {
    const projected = projectReplyDispatchPayloadForPolicyState(payload, "final", event, now ?? Date.now());
    if (!projected) return false;
    return sendFinalReply.call(this, projected);
  };
  return true;
}
