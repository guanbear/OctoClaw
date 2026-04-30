import { getAdapterForSession } from "./index.js";
import { resolveWorkspaceRoot } from "../resolve/env.js";
import type { IMProjectionFooter } from "./adapter.js";

export interface SendIMParams {
  sessionKey: string;
  message: string;
  replyToMessageId?: string;
  timeoutMs?: number;
  cwd?: string;
  suppressProjectionFooter?: boolean;
  projectionFooter?: IMProjectionFooter;
}

export interface SendIMResult {
  sent: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
}

export async function sendIMMessage(params: SendIMParams): Promise<SendIMResult> {
  const adapter = getAdapterForSession(params.sessionKey);
  if (!adapter) {
    return { sent: false, error: "no_im_adapter" };
  }
  const result = await adapter.send({
    sessionKey: params.sessionKey,
    message: params.message,
    replyToMessageId: params.replyToMessageId,
    timeoutMs: params.timeoutMs ?? 5000,
    cwd: params.cwd ?? resolveWorkspaceRoot(),
    suppressProjectionFooter: params.suppressProjectionFooter,
    projectionFooter: params.projectionFooter,
  });
  return {
    sent: result.sent || result.delivered,
    messageId: result.messageId,
    threadTs: result.threadTs,
    error: result.error,
  };
}
