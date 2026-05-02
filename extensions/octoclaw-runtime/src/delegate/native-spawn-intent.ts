import { createHash } from "node:crypto";

/**
 * Canonical sessions_spawn arguments that OctoClaw will plan and the main agent will execute.
 * These are the fields that MUST be hashed for intent verification.
 */
export interface SessionsSpawnArgs {
  task: string;
  label?: string;
  runtime?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  mode?: string;
  cleanup?: string;
  lightContext?: boolean;
  cwd?: string;
  sandbox?: string;
  attachments?: Array<{ uri: string; title?: string }>;
  thread?: boolean;
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
  status: NativeSpawnIntentStatus;
  sessionsSpawnArgs: SessionsSpawnArgs;
  createdAt: number;   // epoch ms
  expiresAt: number;   // epoch ms
  confirmedAt?: number;
  openclawRunId?: string;
  childSessionKey?: string;
  error?: string;
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

/**
 * Deterministic JSON serialization of sessions_spawn args.
 * Keys are sorted recursively. Undefined values are omitted.
 */
export function canonicalizeSessionsSpawnArgs(args: SessionsSpawnArgs): string {
  return JSON.stringify(deepSorted(args));
}

/**
 * Compute SHA-256 hash of canonicalized sessions_spawn args.
 * This hash is stored in the intent and used for args verification.
 */
export function computePlanHash(args: SessionsSpawnArgs): string {
  const canonical = canonicalizeSessionsSpawnArgs(args);
  return createHash("sha256").update(canonical).digest("hex");
}

let intentCounter = 0;

export function createSpawnIntentId(): string {
  intentCounter += 1;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `nsp_${ts}_${rand}_${intentCounter}`;
}
