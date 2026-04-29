import { buildContractEnvelope, type ScopeMetadata } from "@octoclaw/contracts/schemas";

export * from "./surface-binding.js";

export interface RuntimeIngressRequestInput {
  prompt: string;
  sessionKey?: string;
  channel?: string;
  requestId?: string;
  taskId?: string;
  flowId?: string;
  idempotencyKey?: string;
  workspaceMode?: ScopeMetadata["workspaceMode"];
  readScope?: ScopeMetadata["readScope"];
  writeScope?: ScopeMetadata["writeScope"];
  writeScopeSummary?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeAckPlan {
  required: boolean;
  mode: "none" | "pre_dispatch";
  ackKey: string;
  reason: string;
}

export interface NormalizedRuntimeRequest {
  schemaVersion: string;
  createdAt: string;
  requestId: string;
  taskId: string;
  flowId: string;
  sessionKey: string;
  channel: string;
  prompt: string;
  idempotencyKey: string;
  scope: ScopeMetadata;
  metadata: Record<string, unknown>;
  ack: RuntimeAckPlan;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function compactPrompt(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, " ");
}

function buildStableId(prefix: string, seed: string): string {
  const normalized = seed || `${prefix}-default`;
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${prefix}-${compact || "default"}`;
}

function normalizeScope(input: RuntimeIngressRequestInput): ScopeMetadata {
  return {
    workspaceMode: input.workspaceMode || "isolated_worktree",
    readScope: Array.isArray(input.readScope) ? input.readScope : [],
    writeScope: Array.isArray(input.writeScope) ? input.writeScope : [],
    writeScopeSummary: normalizeText(input.writeScopeSummary),
  };
}

function buildAckPlan(requestId: string, prompt: string): RuntimeAckPlan {
  return {
    required: true,
    mode: "pre_dispatch",
    ackKey: `${requestId}:ack`,
    reason: prompt ? "independent_ack_required" : "empty_prompt_ack_guard",
  };
}

export function normalizeRuntimeRequest(input: RuntimeIngressRequestInput): NormalizedRuntimeRequest {
  const prompt = compactPrompt(input.prompt);
  if (!prompt) {
    throw new Error("runtime_request_prompt_missing");
  }

  const sessionKey = normalizeText(input.sessionKey) || "session-anonymous";
  const channel = normalizeText(input.channel) || "direct";
  const requestId = normalizeText(input.requestId)
    || buildStableId("req", normalizeText(input.idempotencyKey) || `${sessionKey}-${prompt.slice(0, 48)}`);
  const taskId = normalizeText(input.taskId) || buildStableId("task", `${requestId}-${channel}`);
  const flowId = normalizeText(input.flowId) || buildStableId("flow", `${sessionKey}-${taskId}`);
  const idempotencyKey = normalizeText(input.idempotencyKey) || requestId;
  const createdAt = new Date().toISOString();

  return {
    ...buildContractEnvelope("truth", createdAt),
    requestId,
    taskId,
    flowId,
    sessionKey,
    channel,
    prompt,
    idempotencyKey,
    scope: normalizeScope(input),
    metadata: input.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {},
    ack: buildAckPlan(requestId, prompt),
  };
}
