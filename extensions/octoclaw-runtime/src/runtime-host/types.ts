export type RuntimeHostId = "openclaw" | "hermes";

export interface RuntimeStatusSnapshot {
  found: boolean;
  degraded: boolean;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost" | "unknown";
  rawStatus?: string;
  source?: "run" | "flow" | "latest" | "cache" | "none";
  nativeStatus?: string;
  runId?: string;
  flowId?: string;
  taskId?: string;
  childSessionKey?: string;
  nativeKind?: string;
  agentRuntimeId?: string;
  summary?: string;
  revision?: number;
  error?: string;
  reason: string;
}

export interface RuntimeStatusRef {
  ctx?: unknown;
  sessionKey?: string;
  workContractId?: string;
  taskId?: string;
  runId?: string;
  flowId?: string;
  childSessionKey?: string;
  cache?: {
    status?: string;
    rawStatus?: string;
    summary?: string;
    corrupt?: boolean;
    missing?: boolean;
  };
  allowFindLatest?: boolean;
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
  readStatus(ref: RuntimeStatusRef): Promise<RuntimeStatusSnapshot>;
  readDelivery(ref: { runId?: string; flowId?: string; childSessionKey?: string }): Promise<RuntimeDeliverySnapshot>;
  readFallbacks(): Promise<RuntimeFallbackSnapshot>;
}
