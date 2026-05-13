export type MessageDeliveryKind =
  | "neutral_ack"
  | "accepted_ack"
  | "native_child_final"
  | "router_wizard_onboarding"
  | "status_reply"
  | "legacy_fallback";

export type MessageDeliveryTargetSource =
  | "delivery_context"
  | "inbound_anchor"
  | "event_metadata"
  | "session_fallback";

export interface MessageDeliveryTarget {
  to?: string;
  channelId?: string;
  threadTs?: string;
  replyToMessageId?: string;
  source: MessageDeliveryTargetSource;
}

export interface MessageDeliveryProvenance {
  route?: "reply" | "delegate";
  model?: string;
  modelId?: string;
  via?: string;
  workContractId?: string;
  runId?: string;
  childSessionKey?: string;
}

export interface MessageDeliveryEnvelope {
  kind: MessageDeliveryKind;
  channel: string;
  target: MessageDeliveryTarget;
  content: string;
  interactiveBlocks?: Array<Record<string, unknown>>;
  provenance?: MessageDeliveryProvenance;
  footerMode?: "off" | "debug";
  dedupeKey?: string;
}

export interface MessageDeliveryResult {
  ok: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
  transport?: "slack_api" | "legacy_cli" | string;
  targetSource?: MessageDeliveryTargetSource;
  footerSource?: "envelope" | "adapter" | "none" | string;
}

export interface MessageDeliveryPort {
  readonly channel: string;
  sendText(envelope: MessageDeliveryEnvelope): Promise<MessageDeliveryResult>;
  react?(envelope: MessageDeliveryEnvelope & { emoji: string }): Promise<MessageDeliveryResult>;
}
