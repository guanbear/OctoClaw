import type { MessageDeliveryKind, MessageDeliveryProvenance, MessageDeliveryTargetSource } from "./delivery-port.js";

export type IMCapabilityLevel = "L0" | "L1" | "L2";

export interface IMProjectionFooter {
  route: "reply" | "delegate";
  model: string;
  mode?: "compact" | "debug";
  via?: string;
  workerPool?: string;
  workContractId?: string;
  complexityBand?: string;
  thread?: boolean;
  healthNote?: string;
  /** Wall-clock turn duration in ms, from openclaw `reply_payload_sending.usageState`. */
  durationMs?: number;
  /** True when the model fallback chain fired for this turn. */
  fallbackUsed?: boolean;
  /** The route-selected model, shown alongside the actual model when fallbackUsed. */
  requestedModel?: string;
  /** Whether `model` came from a live usage snapshot or a degraded guess. */
  usageSource?: "live" | "degraded";
}

export interface IMMessageTurnAnchorParams {
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
}

export interface IMSendParams {
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
  footerMode?: "off" | "compact" | "debug";
  dedupeKey?: string;
}

export interface IMSendResult {
  sent: boolean;
  delivered: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
  transport?: string;
  targetSource?: string;
  footerSource?: string;
}

export interface IMReactParams {
  sessionKey: string;
  messageId: string;
  emoji: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface IMReactResult {
  ok: boolean;
  error?: string;
}

export interface IMDeliveryTarget {
  channel: string;
  target: string;
  threadTs?: string;
  replyToMessageId?: string;
}

export interface IMAdapter {
  readonly channel: string;
  readonly capabilityLevel?: IMCapabilityLevel;
  canHandle(sessionKey: string): boolean;
  resolveTarget(sessionKey: string): IMDeliveryTarget;
  send(params: IMSendParams): Promise<IMSendResult>;
  react(params: IMReactParams): Promise<IMReactResult>;
  renderProjectionFooter?(message: string, projection: IMProjectionFooter): string;
  resolveMessageTurnAnchor?(params: IMMessageTurnAnchorParams): string;
}
