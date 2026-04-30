export type IMCapabilityLevel = "L0" | "L1" | "L2";

export interface IMProjectionFooter {
  route: "reply" | "delegate";
  model: string;
  via?: string;
  workerPool?: string;
  workContractId?: string;
  thread?: boolean;
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
  replyToMessageId?: string;
  timeoutMs?: number;
  cwd?: string;
  suppressProjectionFooter?: boolean;
  projectionFooter?: IMProjectionFooter;
}

export interface IMSendResult {
  sent: boolean;
  delivered: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
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
