export type RuntimeHostId = "openclaw" | "hermes";

export interface RuntimeStatusSnapshot {
  found: boolean;
  degraded: boolean;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost" | "unknown";
  runId?: string;
  flowId?: string;
  childSessionKey?: string;
  nativeKind?: string;
  agentRuntimeId?: string;
  reason: string;
}

export interface RuntimeDeliverySnapshot {
  found: boolean;
  delivered: boolean;
  degraded: boolean;
  messageId?: string;
  channelId?: string;
  reason: string;
}

export interface RuntimeFallbackSnapshot {
  status: "ok" | "unavailable" | "not_configured";
  primaryRuntimeId?: string;
  fallbackRuntimeIds: string[];
  source: "openclaw_config" | "openclaw_status" | "hermes_config" | "none";
  observedAt: string;
  reason?: string;
}

export interface HostRuntimeAdapter {
  readonly host: RuntimeHostId;
  readStatus(ref: { runId?: string; flowId?: string; childSessionKey?: string }): Promise<RuntimeStatusSnapshot>;
  readDelivery(ref: { runId?: string; flowId?: string; childSessionKey?: string }): Promise<RuntimeDeliverySnapshot>;
  readFallbacks(): Promise<RuntimeFallbackSnapshot>;
}
