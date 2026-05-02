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
  label?: string;
  runtime?: "subagent" | "acp";
  agentId?: string;
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
  lightContext?: boolean;
  attachments?: SessionsSpawnAttachment[];
  attachAs?: { mountPath?: string };
}

export interface NativeSpawnIntent {
  spawnIntentId: string;
  workContractId: string;
  delegateTaskId?: string;
  attemptId?: string;
  sessionKey: string;
  canonicalArgsHash: string;
  sessionsSpawnArgs: SessionsSpawnArgs;
  status: NativeSpawnIntentStatus;
  runId: string | null;
  childRunId?: string | null;
  childSessionKey?: string | null;
  error?: string | null;
  ttlMs: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  acceptedAt?: string | null;
  failedAt?: string | null;
  ackSentAt?: string | null;
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForCanonicalJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const next = normalizeForCanonicalJson(record[key]);
      if (next !== undefined) {
        sorted[key] = next;
      }
    }
    return sorted;
  }
  return value === undefined ? undefined : value;
}

export function canonicalizeSessionsSpawnArgs(args: SessionsSpawnArgs): string {
  return JSON.stringify(normalizeForCanonicalJson(args));
}

export function hashSessionsSpawnArgs(args: SessionsSpawnArgs): string {
  return createHash("sha256").update(canonicalizeSessionsSpawnArgs(args)).digest("hex");
}

export function generateSpawnIntentId(): string {
  return `si_${randomUUID()}`;
}

export function isNativeSpawnIntentTerminal(status: NativeSpawnIntentStatus): boolean {
  return status === "accepted" || status === "failed" || status === "expired";
}
