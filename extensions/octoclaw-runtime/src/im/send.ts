import { getAdapterForSession, sendWithDegradation } from "./index.js";
import { resolveWorkspaceRoot } from "../resolve/env.js";
import type { IMProjectionFooter } from "./adapter.js";
import type { MessageDeliveryKind, MessageDeliveryProvenance, MessageDeliveryTargetSource } from "./delivery-port.js";

export interface SendIMParams {
  sessionKey: string;
  message: string;
  interactiveBlocks?: Array<Record<string, unknown>>;
  replyToMessageId?: string;
  timeoutMs?: number;
  cwd?: string;
  suppressProjectionFooter?: boolean;
  projectionFooter?: IMProjectionFooter;
  deliveryKind?: MessageDeliveryKind;
  deliveryTargetSource?: MessageDeliveryTargetSource;
  deliveryProvenance?: MessageDeliveryProvenance;
  footerMode?: "off" | "debug";
  dedupeKey?: string;
}

export interface SendIMResult {
  sent: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
  transport?: string;
  targetSource?: string;
  footerSource?: string;
}

export async function sendIMMessage(params: SendIMParams): Promise<SendIMResult> {
  const adapter = getAdapterForSession(params.sessionKey);
  if (!adapter) {
    return { sent: false, error: "no_im_adapter" };
  }
  const result = await sendWithDegradation(adapter, {
    sessionKey: params.sessionKey,
    message: params.message,
    interactiveBlocks: params.interactiveBlocks,
    replyToMessageId: params.replyToMessageId,
    timeoutMs: params.timeoutMs ?? 5000,
    cwd: params.cwd ?? resolveWorkspaceRoot(),
    suppressProjectionFooter: params.suppressProjectionFooter,
    projectionFooter: params.projectionFooter,
    deliveryKind: params.deliveryKind,
    deliveryTargetSource: params.deliveryTargetSource,
    deliveryProvenance: params.deliveryProvenance,
    footerMode: params.footerMode,
    dedupeKey: params.dedupeKey,
  });
  return {
    sent: result.sent || result.delivered,
    messageId: result.messageId,
    threadTs: result.threadTs,
    error: result.error,
    transport: result.transport,
    targetSource: result.targetSource,
    footerSource: result.footerSource,
  };
}
