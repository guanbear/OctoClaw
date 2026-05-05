import { createHash, randomUUID } from "node:crypto";

export type NativeSpawnIntentStatus =
  | "planned"
  | "spawn_call_started"
  | "accepted"
  | "failed"
  | "expired";

export interface SessionsSpawnAttachment {
  name: string;
  content: string;
  encoding?: "utf8" | "base64";
  mimeType?: string;
}

export interface SessionsSpawnArgs {
  task: string;
  message?: string;
  label?: string;
  runtime?: "subagent" | "acp";
  agentId?: string;
  sessionKey?: string;
  resumeSessionId?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  runTimeoutSeconds?: number;
  timeoutSeconds?: number;
  thread?: boolean;
  mode?: "run" | "session";
  cleanup?: "delete" | "keep";
  sandbox?: "inherit" | "require";
  streamTo?: "parent";
  context?: "isolated";
  lightContext?: boolean;
  attachments?: SessionsSpawnAttachment[];
  attachAs?: { mountPath?: string };
  [key: string]: unknown;
}

export interface NativeSpawnIntent {
  spawnIntentId: string;
  workContractId: string;
  delegateTaskId?: string;
  attemptId?: string;
  sessionKey: string;
  canonicalArgsHash: string;
  planHash: string;
  sessionsSpawnArgs: SessionsSpawnArgs;
  dispatchMode?: "new_spawn" | "send_to_speculative";
  speculativeSessionLabel?: string | null;
  status: NativeSpawnIntentStatus;
  runId: string | null;
  openclawRunId?: string;
  childRunId?: string | null;
  childSessionKey?: string | null;
  error?: string | null;
  ttlMs: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  acceptedAt?: string | null;
  confirmedAt?: string | null;
  failedAt?: string | null;
  ackSentAt?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function normalizeSessionsSpawnArgs(args: SessionsSpawnArgs): Record<string, unknown> {
  const record = asRecord(args);
  const normalized: Record<string, unknown> = {
    task: asNonEmptyString(record.task),
  };

  const message = asNonEmptyString(record.message);
  if (message) normalized.message = message;

  const label = asNonEmptyString(record.label);
  if (label) normalized.label = label;

  const runtime = record.runtime === "acp" ? "acp" : record.runtime === "subagent" ? "subagent" : "";
  if (runtime && runtime !== "subagent") normalized.runtime = runtime;

  for (const key of ["agentId", "sessionKey", "resumeSessionId", "model", "thinking", "cwd", "streamTo"] as const) {
    const value = asNonEmptyString(record[key]);
    if (value) normalized[key] = value;
  }

  const explicitRunTimeout = normalizedNonNegativeInteger(record.runTimeoutSeconds);
  const backCompatTimeout = normalizedNonNegativeInteger(record.timeoutSeconds);
  if (explicitRunTimeout !== undefined) {
    normalized.runTimeoutSeconds = explicitRunTimeout;
  } else if (backCompatTimeout !== undefined && backCompatTimeout > 0) {
    normalized.runTimeoutSeconds = backCompatTimeout;
  }
  if (message && backCompatTimeout !== undefined) normalized.timeoutSeconds = backCompatTimeout;

  if (record.thread === true) normalized.thread = true;
  if (record.mode === "run" || record.mode === "session") normalized.mode = record.mode;
  if (record.cleanup === "delete") normalized.cleanup = "delete";
  if (record.sandbox === "require") normalized.sandbox = "require";
  if (record.context === "isolated") normalized.context = "isolated";
  if (record.lightContext === true) normalized.lightContext = true;

  if (Array.isArray(record.attachments) && record.attachments.length > 0) {
    normalized.attachments = record.attachments.map((attachment) => {
      const item = asRecord(attachment);
      const next: Record<string, unknown> = {
        name: asNonEmptyString(item.name),
        content: typeof item.content === "string" ? item.content : "",
      };
      const encoding = asNonEmptyString(item.encoding);
      const mimeType = asNonEmptyString(item.mimeType);
      if (encoding) next.encoding = encoding;
      if (mimeType) next.mimeType = mimeType;
      return next;
    });
  }

  const attachMountPath = asNonEmptyString(asRecord(record.attachAs).mountPath);
  if (attachMountPath) normalized.attachAs = { mountPath: attachMountPath };

  return normalized;
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const next = normalizeForCanonicalJson(record[key]);
      if (next !== undefined) sorted[key] = next;
    }
    return sorted;
  }
  return value === undefined ? undefined : value;
}

export function canonicalizeSessionsSpawnArgs(args: SessionsSpawnArgs): string {
  return JSON.stringify(normalizeForCanonicalJson(normalizeSessionsSpawnArgs(args)));
}

export function hashSessionsSpawnArgs(args: SessionsSpawnArgs): string {
  return createHash("sha256").update(canonicalizeSessionsSpawnArgs(args)).digest("hex");
}

export const computePlanHash = hashSessionsSpawnArgs;

export function generateSpawnIntentId(): string {
  const ts = Date.now().toString(36);
  const rand = randomUUID().slice(0, 8).replace(/-/gu, "");
  return `nsp_${ts}_${rand}`;
}

export function isNativeSpawnIntentTerminal(status: NativeSpawnIntentStatus): boolean {
  return status === "accepted" || status === "failed" || status === "expired";
}
