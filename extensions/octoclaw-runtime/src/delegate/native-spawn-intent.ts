import { createHash, randomBytes } from "node:crypto";

export interface SessionsSpawnArgs {
  task: string;
  model?: string;
  role?: string;
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
  canonicalArgsHash: string;
  sessionsSpawnArgs: SessionsSpawnArgs;
  status: NativeSpawnIntentStatus;
  runId: string | null;
  ttlMs: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
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

export function hashSessionsSpawnArgs(args: SessionsSpawnArgs): string {
  const canonical = canonicalizeSessionsSpawnArgs(args);
  return createHash("sha256").update(canonical).digest("hex");
}

export function generateSpawnIntentId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `si_${ts}_${rand}`;
}
