import { createHash, randomUUID } from "node:crypto";

export interface SessionsSpawnArgs {
  task: string;
  model?: string;
  role?: string;
  cwd?: string;
  workspacePath?: string;
  [key: string]: unknown;
}

export type NativeSpawnIntentStatus =
  | "planned"
  | "spawn_call_started"
  | "accepted"
  | "failed"
  | "expired";

export interface NativeSpawnIntent {
  spawnIntentId: string;
  workContractId: string;
  sessionKey: string;
  planHash: string;
  sessionsSpawnArgs: SessionsSpawnArgs;
  status: NativeSpawnIntentStatus;
  openclawRunId?: string;
  childSessionKey?: string;
  confirmedAt?: number;
  updatedAt?: number;
  error?: string;
  ttlMs: number;
  createdAt: number;
  expiresAt: number;
}

function deepSorted(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(deepSorted);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] !== undefined) {
        sorted[key] = deepSorted(obj[key]);
      }
    }
    return sorted;
  }
  return value;
}

export function canonicalizeSessionsSpawnArgs(args: SessionsSpawnArgs): string {
  return JSON.stringify(deepSorted(args));
}

export function computePlanHash(args: SessionsSpawnArgs): string {
  const canonical = canonicalizeSessionsSpawnArgs(args);
  return createHash("sha256").update(canonical).digest("hex");
}

export { computePlanHash as hashSessionsSpawnArgs };

export function generateSpawnIntentId(): string {
  const now = Date.now();
  const ts = now.toString(36);
  const rand = randomUUID().slice(0, 8).replace(/-/g, "");
  return `nsp_${ts}_${rand}`;
}
