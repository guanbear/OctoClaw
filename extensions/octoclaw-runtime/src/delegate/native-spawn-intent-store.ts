import type { DatabaseSync, SqliteProvider } from "../runtime-ledger/types.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import {
  generateSpawnIntentId,
  hashSessionsSpawnArgs,
  type NativeSpawnIntent,
  type SessionsSpawnArgs,
} from "./native-spawn-intent.js";

type UnknownRecord = Record<string, unknown>;

export interface CreateNativeSpawnIntentInput {
  workContractId: string;
  delegateTaskId?: string;
  attemptId?: string;
  sessionKey: string;
  sessionsSpawnArgs: SessionsSpawnArgs;
  ttlMs: number;
  now?: Date;
  sqlite?: SqliteProvider;
  dbPath?: string;
}

export interface NativeSpawnIntentTransitionResult {
  ok: boolean;
  intent?: NativeSpawnIntent;
  error?: string;
}

export interface ConfirmNativeSpawnIntentInput {
  spawnIntentId: string;
  workContractId: string;
  sessionKey?: string;
  runId: string;
  childRunId?: string;
  childSessionKey?: string;
  now?: Date;
  sqlite?: SqliteProvider;
  dbPath?: string;
}

export interface ConfirmNativeSpawnIntentResult extends NativeSpawnIntentTransitionResult {
  status: "accepted" | "idempotent" | "conflict" | "error";
}

function asRecord(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function parseIntent(row: unknown): NativeSpawnIntent | null {
  const record = asRecord(row);
  const text = asString(record.intent_json);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as NativeSpawnIntent;
    return parsed && typeof parsed === "object" && parsed.spawnIntentId ? parsed : null;
  } catch {
    return null;
  }
}

function cloneIntent(intent: NativeSpawnIntent): NativeSpawnIntent {
  return JSON.parse(JSON.stringify(intent)) as NativeSpawnIntent;
}

const memoryIntents = new Map<string, NativeSpawnIntent>();

function openDb(opts?: { dbPath?: string; sqlite?: SqliteProvider }): { db: DatabaseSync | null; dbPath?: string } {
  const opened = openRuntimeLedger({ dbPath: opts?.dbPath, mode: "best_effort", sqlite: opts?.sqlite });
  if (opened.status !== "ok" || !opened.db) return { db: null, dbPath: opened.dbPath };
  return { db: opened.db, dbPath: opened.dbPath };
}

function upsertDbIntent(db: DatabaseSync, intent: NativeSpawnIntent): void {
  db.prepare(
    `INSERT INTO native_spawn_intents (
       spawn_intent_id, work_contract_id, session_key, status, args_hash,
       run_id, child_session_key, expires_at, created_at, updated_at, intent_json, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(spawn_intent_id) DO UPDATE SET
       work_contract_id = excluded.work_contract_id,
       session_key = excluded.session_key,
       status = excluded.status,
       args_hash = excluded.args_hash,
       run_id = excluded.run_id,
       child_session_key = excluded.child_session_key,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at,
       intent_json = excluded.intent_json,
       revision = native_spawn_intents.revision + 1`,
  ).run(
    intent.spawnIntentId,
    intent.workContractId,
    intent.sessionKey,
    intent.status,
    intent.canonicalArgsHash,
    intent.runId,
    intent.childSessionKey ?? null,
    intent.expiresAt,
    intent.createdAt,
    intent.updatedAt,
    JSON.stringify(intent),
  );
}

function saveIntent(intent: NativeSpawnIntent, opts?: { dbPath?: string; sqlite?: SqliteProvider }): NativeSpawnIntent {
  const copy = cloneIntent(intent);
  const opened = openDb(opts);
  if (!opened.db) {
    memoryIntents.set(copy.spawnIntentId, copy);
    return cloneIntent(copy);
  }
  try {
    upsertDbIntent(opened.db, copy);
  } finally {
    try { opened.db.close(); } catch {}
  }
  return cloneIntent(copy);
}

function readIntent(spawnIntentId: string, opts?: { dbPath?: string; sqlite?: SqliteProvider }): NativeSpawnIntent | null {
  const id = asString(spawnIntentId);
  if (!id) return null;
  const opened = openDb(opts);
  if (!opened.db) {
    const intent = memoryIntents.get(id);
    return intent ? cloneIntent(intent) : null;
  }
  try {
    return parseIntent(opened.db.prepare("SELECT intent_json FROM native_spawn_intents WHERE spawn_intent_id = ?").get(id));
  } finally {
    try { opened.db.close(); } catch {}
  }
}

function findPendingInMemory(sessionKey: string, nowMs: number): NativeSpawnIntent | null {
  let latest: NativeSpawnIntent | null = null;
  for (const intent of memoryIntents.values()) {
    if (intent.sessionKey !== sessionKey) continue;
    if (intent.status !== "planned") continue;
    if (Date.parse(intent.expiresAt) <= nowMs) {
      const expired = { ...intent, status: "expired" as const, updatedAt: new Date(nowMs).toISOString() };
      memoryIntents.set(expired.spawnIntentId, expired);
      continue;
    }
    if (!latest || Date.parse(intent.createdAt) >= Date.parse(latest.createdAt)) {
      latest = intent;
    }
  }
  return latest ? cloneIntent(latest) : null;
}

export class NativeSpawnIntentStore {
  create(input: CreateNativeSpawnIntentInput): NativeSpawnIntent {
    const createdAt = nowIso(input.now);
    const expiresAt = new Date(Date.parse(createdAt) + Math.max(1, input.ttlMs)).toISOString();
    const intent: NativeSpawnIntent = {
      spawnIntentId: generateSpawnIntentId(),
      workContractId: input.workContractId,
      delegateTaskId: input.delegateTaskId,
      attemptId: input.attemptId,
      sessionKey: input.sessionKey,
      canonicalArgsHash: hashSessionsSpawnArgs(input.sessionsSpawnArgs),
      sessionsSpawnArgs: input.sessionsSpawnArgs,
      status: "planned",
      runId: null,
      ttlMs: input.ttlMs,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    };
    return saveIntent(intent, input);
  }

  get(spawnIntentId: string, opts?: { dbPath?: string; sqlite?: SqliteProvider }): NativeSpawnIntent | null {
    return readIntent(spawnIntentId, opts);
  }

  findPendingForSession(sessionKey: string, opts?: { now?: Date; dbPath?: string; sqlite?: SqliteProvider }): NativeSpawnIntent | null {
    const key = asString(sessionKey);
    if (!key) return null;
    const now = opts?.now ?? new Date();
    const nowMs = now.getTime();
    const opened = openDb(opts);
    if (!opened.db) return findPendingInMemory(key, nowMs);
    try {
      const rows = opened.db.prepare(
        `SELECT intent_json FROM native_spawn_intents
         WHERE session_key = ? AND status = 'planned'
         ORDER BY created_at DESC`,
      ).all(key);
      for (const row of rows) {
        const intent = parseIntent(row);
        if (!intent) continue;
        if (Date.parse(intent.expiresAt) <= nowMs) {
          upsertDbIntent(opened.db, { ...intent, status: "expired", updatedAt: now.toISOString() });
          continue;
        }
        return intent;
      }
      return null;
    } finally {
      try { opened.db.close(); } catch {}
    }
  }

  transitionToSpawnCallStarted(input: {
    spawnIntentId: string;
    sessionKey?: string;
    sessionsSpawnArgs: SessionsSpawnArgs;
    now?: Date;
    dbPath?: string;
    sqlite?: SqliteProvider;
  }): NativeSpawnIntentTransitionResult {
    const intent = readIntent(input.spawnIntentId, input);
    if (!intent) return { ok: false, error: "intent_not_found" };
    const now = input.now ?? new Date();
    if (input.sessionKey && intent.sessionKey !== input.sessionKey) return { ok: false, intent, error: "session_mismatch" };
    if (intent.status !== "planned") return { ok: false, intent, error: `invalid_status:${intent.status}` };
    if (Date.parse(intent.expiresAt) <= now.getTime()) {
      return { ok: false, intent: saveIntent({ ...intent, status: "expired", updatedAt: now.toISOString() }, input), error: "intent_expired" };
    }
    const actualHash = hashSessionsSpawnArgs(input.sessionsSpawnArgs);
    if (actualHash !== intent.canonicalArgsHash) {
      return { ok: false, intent, error: "args_hash_mismatch" };
    }
    return { ok: true, intent: saveIntent({ ...intent, status: "spawn_call_started", updatedAt: now.toISOString() }, input) };
  }

  confirmAccepted(input: ConfirmNativeSpawnIntentInput): ConfirmNativeSpawnIntentResult {
    const runId = asString(input.runId);
    if (!runId) return { ok: false, status: "error", error: "run_id_required" };
    const intent = readIntent(input.spawnIntentId, input);
    if (!intent) return { ok: false, status: "error", error: "intent_not_found" };
    if (intent.workContractId !== input.workContractId) return { ok: false, status: "error", intent, error: "work_contract_mismatch" };
    if (input.sessionKey && intent.sessionKey !== input.sessionKey) return { ok: false, status: "error", intent, error: "session_mismatch" };
    if (intent.status === "accepted") {
      if (intent.runId === runId) return { ok: true, status: "idempotent", intent };
      return { ok: false, status: "conflict", intent, error: "run_id_conflict" };
    }
    if (intent.status !== "spawn_call_started") {
      return { ok: false, status: "error", intent, error: `invalid_status:${intent.status}` };
    }
    const now = input.now ?? new Date();
    if (Date.parse(intent.expiresAt) <= now.getTime()) {
      return { ok: false, status: "error", intent: saveIntent({ ...intent, status: "expired", updatedAt: now.toISOString() }, input), error: "intent_expired" };
    }
    const accepted: NativeSpawnIntent = {
      ...intent,
      status: "accepted",
      runId,
      childRunId: asString(input.childRunId) || runId,
      childSessionKey: asString(input.childSessionKey) || intent.childSessionKey || null,
      acceptedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      error: null,
    };
    return { ok: true, status: "accepted", intent: saveIntent(accepted, input) };
  }

  markFailed(input: {
    spawnIntentId: string;
    workContractId?: string;
    sessionKey?: string;
    error: string;
    now?: Date;
    dbPath?: string;
    sqlite?: SqliteProvider;
  }): NativeSpawnIntentTransitionResult {
    const intent = readIntent(input.spawnIntentId, input);
    if (!intent) return { ok: false, error: "intent_not_found" };
    if (input.workContractId && intent.workContractId !== input.workContractId) return { ok: false, intent, error: "work_contract_mismatch" };
    if (input.sessionKey && intent.sessionKey !== input.sessionKey) return { ok: false, intent, error: "session_mismatch" };
    if (intent.status === "accepted") return { ok: false, intent, error: "already_accepted" };
    const now = input.now ?? new Date();
    return {
      ok: true,
      intent: saveIntent({ ...intent, status: "failed", error: input.error, failedAt: now.toISOString(), updatedAt: now.toISOString() }, input),
    };
  }

  markAckSent(spawnIntentId: string, opts?: { now?: Date; dbPath?: string; sqlite?: SqliteProvider }): NativeSpawnIntentTransitionResult {
    const intent = readIntent(spawnIntentId, opts);
    if (!intent) return { ok: false, error: "intent_not_found" };
    if (intent.ackSentAt) return { ok: true, intent };
    const now = opts?.now ?? new Date();
    return { ok: true, intent: saveIntent({ ...intent, ackSentAt: now.toISOString(), updatedAt: now.toISOString() }, opts) };
  }

  expire(spawnIntentId: string, opts?: { now?: Date; dbPath?: string; sqlite?: SqliteProvider }): NativeSpawnIntent | null {
    const intent = readIntent(spawnIntentId, opts);
    if (!intent) return null;
    const now = opts?.now ?? new Date();
    return saveIntent({ ...intent, status: "expired", updatedAt: now.toISOString() }, opts);
  }

  clearForTests(opts?: { dbPath?: string; sqlite?: SqliteProvider }): void {
    memoryIntents.clear();
    const opened = openDb(opts);
    if (!opened.db) return;
    try {
      opened.db.prepare("DELETE FROM native_spawn_intents").run();
    } finally {
      try { opened.db.close(); } catch {}
    }
  }
}

export const nativeSpawnIntentStore = new NativeSpawnIntentStore();
