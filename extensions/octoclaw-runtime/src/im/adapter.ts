export interface IMSendParams {
  sessionKey: string;
  message: string;
  replyToMessageId?: string;
  timeoutMs?: number;
  cwd?: string;
  suppressProjectionFooter?: boolean;
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
  canHandle(sessionKey: string): boolean;
  resolveTarget(sessionKey: string): IMDeliveryTarget;
  send(params: IMSendParams): Promise<IMSendResult>;
  react(params: IMReactParams): Promise<IMReactResult>;
}
