import { getAdapterForSession } from "./index.js";
import type { IMMessageTurnAnchorParams } from "./adapter.js";

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function genericMessageTurnAnchor(params: IMMessageTurnAnchorParams): string {
  const metadata = params.metadata ?? {};
  const state = params.state ?? {};
  const ctx = params.ctx ?? {};
  return stringValue(
    params.replyToMessageId
    || metadata.message_id
    || metadata.messageId
    || metadata.reply_to_id
    || metadata.replyToMessageId
    || state.message_id
    || state.messageId
    || state.inboundMessageTs
    || state.replyToMessageId
    || ctx.inboundMessageTs
    || ctx.message_id
    || ctx.messageId
    || ctx.replyToMessageId,
  );
}

export interface ResolveIMMessageTurnIdParams extends IMMessageTurnAnchorParams {
  sessionKey?: string;
  stateKey: string;
  fallbackTurnId: string;
}

export function resolveIMMessageTurnAnchor(params: ResolveIMMessageTurnIdParams): string {
  const adapter = params.sessionKey ? getAdapterForSession(params.sessionKey) : null;
  return stringValue(adapter?.resolveMessageTurnAnchor?.(params)) || genericMessageTurnAnchor(params);
}

export function resolveIMMessageTurnId(params: ResolveIMMessageTurnIdParams): string {
  const anchor = resolveIMMessageTurnAnchor(params);
  return anchor ? `${params.stateKey}:${anchor}` : `${params.stateKey}:${params.fallbackTurnId}`;
}
