/** IM channel identifiers */
export type IMChannel = "slack" | "feishu" | "telegram" | "discord" | "wechat" | "unknown";

/** What a specific IM channel supports */
export interface IMCapabilityMatrix {
  /** Can edit/update an already-sent message */
  canUpdateMessage: boolean;
  /** Supports native streaming (startStream/append/stop) */
  canStreamNative: boolean;
  /** Supports reply threading */
  canReplyInThread: boolean;
  /** Supports typing indicators or reactions */
  canTypingIndicator: boolean;
  /** Message ID format: "ts" (Slack), "message_id" (Telegram), "snowflake" (Discord) */
  messageIdFormat: string;
  /** User ID is case-sensitive */
  userIdCaseSensitive: boolean;
  /** Max message length */
  maxMessageLength: number;
}

/** Resolved delivery target for an IM message */
export interface IMDeliveryTarget {
  /** The IM channel */
  channel: IMChannel;
  /** Recipient: user ID, channel ID, or chat ID */
  target: string;
  /** Thread/timestamp to reply to (if applicable) */
  replyToId?: string;
  /** Session key for routing */
  sessionKey?: string;
}

/** Result of a delivery attempt */
export interface IMDeliveryResult {
  sent: boolean;
  delivered: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
  channel: IMChannel;
}

/** Streaming state for an active stream */
export interface IMStreamState {
  active: boolean;
  messageId?: string;
  channelTs?: string;
  startedAt: number;
  lastUpdatedAt: number;
}

/** Request to send a message via an IM adapter */
export interface IMSendRequest {
  sessionKey: string;
  message: string;
  target: IMDeliveryTarget;
  /** Original inbound message ID to reply to (for threading) */
  replyToMessageId?: string;
  /** Whether this is an ACK (vs regular message) */
  isAck?: boolean;
  /** Timeout in ms */
  timeoutMs?: number;
}

/** The surface adapter interface — each IM implements this */
export interface IMSurfaceAdapter {
  /** Channel this adapter handles */
  readonly channel: IMChannel;
  /** Capability matrix for this channel */
  readonly capabilities: IMCapabilityMatrix;
  /** Resolve a session key into a delivery target */
  resolveTarget(sessionKey: string): IMDeliveryTarget;
  /** Send a message */
  send(request: IMSendRequest): Promise<IMDeliveryResult>;
  /** Check if streaming is available and active for this session */
  isStreamingAvailable(sessionKey: string): boolean;
  /** Cancel any pending/streaming state for cleanup */
  cleanup(sessionKey: string): void;
}

/** Channel-specific adapter config */
export interface IMAdapterConfig {
  channel: IMChannel;
  replyToMode?: "off" | "first" | "all";
  streamingMode?: "off" | "partial" | "block" | "progress";
  nativeTransport?: boolean;
}

/** Normalize a user ID for the given channel */
export function normalizeChannelUserId(userId: string, channel: IMChannel): string {
  if (channel === "slack") {
    return userId.toUpperCase();
  }

  return userId;
}

/** Check if a channel supports threading */
export function channelSupportsThreading(channel: IMChannel): boolean {
  return channel !== "wechat";
}

/** Parse IM channel from session key like "agent:main:slack:default:direct:U123" */
export function parseIMChannelFromSessionKey(sessionKey: string): IMChannel {
  const lower = sessionKey.toLowerCase();

  if (lower.includes(":slack:")) {
    return "slack";
  }

  if (lower.includes(":feishu:")) {
    return "feishu";
  }

  if (lower.includes(":telegram:")) {
    return "telegram";
  }

  if (lower.includes(":discord:")) {
    return "discord";
  }

  if (lower.includes(":wechat:")) {
    return "wechat";
  }

  return "unknown";
}
