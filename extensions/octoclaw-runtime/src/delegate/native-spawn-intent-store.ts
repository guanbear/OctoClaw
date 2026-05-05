import { openRuntimeLedger } from "../runtime-ledger/index.js";
import type { SqliteProvider } from "../runtime-ledger/types.js";
import {
  generateSpawnIntentId,
  hashSessionsSpawnArgs,
  isNativeSpawnIntentTerminal,
  type NativeSpawnIntent,
  type SessionsSpawnArgs,
} from "./native-spawn-intent.js";

export interface CreateNativeSpawnIntentInput {
  workContractId: string;
  delegateTaskId?: string;
  attemptId?: string;
  sessionKey: string;
  sessionsSpawnArgs: SessionsSpawnArgs;
  dispatchMode?: "new_spawn" | "send_to_speculative";
  speculativeSessionLabel?: string;
  ttlMs: number;
  now?: Date | number;
  sqlite?: SqliteProvider;
  dbPath?: string;
}

export interface CreateIntentParams {
  workContractId: string;
  delegateTaskId?: string;
  attemptId?: string;
  sessionKey: string;
  sessionsSpawnArgs: SessionsSpawnArgs;
  dispatchMode?: "new_spawn" | "send_to_speculative";
  speculativeSessionLabel?: string;
  ttlMs: number;
  now?: Date | number;
}

export interface ConfirmNativeSpawnIntentInput {
  spawnIntentId: string;
  workContractId: string;
  sessionKey?: string;
  runId: string;
  childRunId?: string;
  childSessionKey?: string;
  now?: Date | number;
  sqlite?: SqliteProvider;
  dbPath?: string;
}

export interface ConfirmAcceptParams {
  spawnIntentId: string;
  workContractId?: string;
  sessionKey?: string;
  runId: string;
  childRunId?: string;
  childSessionKey?: string;
  now?: Date | number;
}

export type NativeSpawnIntentTransitionResult =
  | { ok: true; intent: NativeSpawnIntent }
  | { ok: false; intent?: NativeSpawnIntent; error: string };

export type TransitionResult = NativeSpawnIntentTransitionResult;

export type ConfirmNativeSpawnIntentResult =
  | { ok: true; status: "accepted" | "idempotent"; intent: NativeSpawnIntent; idempotent: boolean }
  | { ok: false; status: "conflict" | "error"; intent?: NativeSpawnIntent; error: string; existingRunId?: string };

export type ConfirmAcceptResult =
  | { ok: true; intent: NativeSpawnIntent; idempotent: boolean }
  | { ok: false; error: string; existingRunId?: string; intent?: NativeSpawnIntent };

export type ConfirmFailResult = NativeSpawnIntentTransitionResult;

type StoreOptions = { dbPath?: string; sqlite?: SqliteProvider };
type StoreRuntimeOptions = StoreOptions & { persist?: boolean; memory?: Map<string, NativeSpawnIntent> };
type OpenedIntentDb = ReturnType<typeof openDb>;
type FindPendingOptions = { now?: Date | number; dbPath?: string; sqlite?: SqliteProvider; dispatchMode?: NativeSpawnIntent["dispatchMode"] };

const SQLITE_BUSY_RETRY_DELAYS_MS = [0, 5, 25, 75] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asErrorCode(error: unknown): string {
  const record = asRecord(error);
  return asString(record.code || record.name).toUpperCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSqliteBusyError(error: unknown): boolean {
  const code = asErrorCode(error);
  const message = errorMessage(error).toLowerCase();
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || message.includes("sqlite_busy")
    || message.includes("sqlite_locked")
    || message.includes("database is locked")
    || message.includes("database is busy");
}

function storeError(error: unknown): string {
  if (isSqliteBusyError(error)) return "sqlite_busy";
  const code = asErrorCode(error).toLowerCase();
  if (code === "sqlite_unavailable") return "sqlite_unavailable";
  const message = errorMessage(error);
  return message ? `sqlite_error:${message}` : "sqlite_error";
}

function makeStoreError(code: string, message?: string): Error {
  const error = new Error(message || code);
  (error as Error & { code?: string }).code = code;
  return error;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withSqliteBusyRetry<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < SQLITE_BUSY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === SQLITE_BUSY_RETRY_DELAYS_MS.length - 1) throw error;
      sleepSync(SQLITE_BUSY_RETRY_DELAYS_MS[attempt + 1] ?? 0);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function normalizeNow(now?: Date | number): Date {
  if (now instanceof Date) return now;
  if (typeof now === "number" && Number.isFinite(now)) return new Date(now);
  return new Date();
}

function nowIso(now?: Date | number): string {
  return normalizeNow(now).toISOString();
}

function parseTime(value: unknown): number {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseIntent(row: unknown): NativeSpawnIntent | null {
  const record = asRecord(row);
  const text = asString(record.intent_json);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const intent = parsed as NativeSpawnIntent;
    return intent.spawnIntentId ? normalizeIntent(intent) : null;
  } catch {
    return null;
  }
}

function normalizeIntent(intent: NativeSpawnIntent): NativeSpawnIntent {
  const hash = asString(intent.canonicalArgsHash || intent.planHash);
  const runId = asString(intent.runId || intent.openclawRunId);
  return {
    ...intent,
    canonicalArgsHash: hash,
    planHash: hash,
    dispatchMode: intent.dispatchMode || "new_spawn",
    runId: runId || null,
    openclawRunId: runId || undefined,
  };
}

function cloneIntent(intent: NativeSpawnIntent): NativeSpawnIntent {
  return normalizeIntent(JSON.parse(JSON.stringify(intent)) as NativeSpawnIntent);
}

const fallbackMemoryIntents = new Map<string, NativeSpawnIntent>();

function persistentRequested(opts?: StoreRuntimeOptions): boolean {
  return opts?.persist === true || Boolean(opts?.dbPath) || opts?.sqlite !== undefined;
}

function openDb(opts?: StoreRuntimeOptions) {
  if (!persistentRequested(opts)) {
    return { db: null, dbPath: "", persistent: false, error: "" };
  }
  const opened = openRuntimeLedger({ dbPath: opts?.dbPath, mode: "best_effort", sqlite: opts?.sqlite });
  if (opened.status !== "ok" || !opened.db) return { db: null, dbPath: opened.dbPath, persistent: true, error: opened.error || "sqlite_unavailable" };
  return { db: opened.db, dbPath: opened.dbPath, persistent: true, error: "" };
}

function upsertDbIntent(db: NonNullable<ReturnType<typeof openDb>["db"]>, intent: NativeSpawnIntent): void {
  const normalized = normalizeIntent(intent);
  withSqliteBusyRetry(() => db.prepare(
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
    normalized.spawnIntentId,
    normalized.workContractId,
    normalized.sessionKey,
    normalized.status,
    normalized.canonicalArgsHash,
    normalized.runId,
    normalized.childSessionKey ?? null,
    normalized.expiresAt,
    normalized.createdAt,
    normalized.updatedAt,
    JSON.stringify(normalized),
  ));
}

function readDbIntent(db: NonNullable<OpenedIntentDb["db"]>, spawnIntentId: string): NativeSpawnIntent | null {
  return withSqliteBusyRetry(() => parseIntent(db.prepare("SELECT intent_json FROM native_spawn_intents WHERE spawn_intent_id = ?").get(spawnIntentId)));
}

function closeDb(opened: OpenedIntentDb): void {
  if (!opened.db) return;
  try { opened.db.close(); } catch {}
}

function failIfPersistentUnavailable(opened: OpenedIntentDb): void {
  if (opened.persistent) {
    throw makeStoreError("SQLITE_UNAVAILABLE", opened.error || "sqlite unavailable");
  }
}

function withDbTransaction<T>(db: NonNullable<OpenedIntentDb["db"]>, operation: () => T): T {
  withSqliteBusyRetry(() => db.exec("BEGIN IMMEDIATE"));
  let committed = false;
  try {
    const result = operation();
    withSqliteBusyRetry(() => db.exec("COMMIT"));
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try { db.exec("ROLLBACK"); } catch {}
    }
  }
}

function memoryFor(opts?: StoreRuntimeOptions): Map<string, NativeSpawnIntent> {
  return opts?.memory ?? fallbackMemoryIntents;
}

function saveIntent(intent: NativeSpawnIntent, opts?: StoreRuntimeOptions): NativeSpawnIntent {
  const copy = cloneIntent(intent);
  const opened = openDb(opts);
  if (!opened.db) {
    failIfPersistentUnavailable(opened);
    memoryFor(opts).set(copy.spawnIntentId, copy);
    return cloneIntent(copy);
  }
  try {
    upsertDbIntent(opened.db, copy);
  } finally {
    try { opened.db.close(); } catch {}
  }
  return cloneIntent(copy);
}

function readIntent(spawnIntentId: string, opts?: StoreRuntimeOptions): NativeSpawnIntent | null {
  const id = asString(spawnIntentId);
  if (!id) return null;
  const opened = openDb(opts);
  if (!opened.db) {
    failIfPersistentUnavailable(opened);
    const intent = memoryFor(opts).get(id);
    return intent ? cloneIntent(intent) : null;
  }
  try {
    return readDbIntent(opened.db, id);
  } finally {
    closeDb(opened);
  }
}

function findPendingInMemory(
  memory: Map<string, NativeSpawnIntent>,
  sessionKey: string,
  nowMs: number,
  dispatchMode?: NativeSpawnIntent["dispatchMode"],
): NativeSpawnIntent | null {
  let latest: NativeSpawnIntent | null = null;
  for (const intent of memory.values()) {
    const normalized = normalizeIntent(intent);
    if (normalized.sessionKey !== sessionKey) continue;
    if (dispatchMode && normalized.dispatchMode !== dispatchMode) continue;
    if (intent.status !== "planned") continue;
    if (parseTime(intent.expiresAt) <= nowMs) {
      const expired = { ...intent, status: "expired" as const, updatedAt: new Date(nowMs).toISOString() };
      memory.set(expired.spawnIntentId, normalizeIntent(expired));
      continue;
    }
    if (!latest || parseTime(normalized.createdAt) >= parseTime(latest.createdAt)) latest = normalized;
  }
  return latest ? cloneIntent(latest) : null;
}

export class NativeSpawnIntentStore {
  private readonly memory = new Map<string, NativeSpawnIntent>();
  private readonly persistByDefault: boolean;

  constructor(options: { persist?: boolean } = {}) {
    this.persistByDefault = options.persist === true;
  }

  private options(opts?: StoreRuntimeOptions): StoreRuntimeOptions {
    return { ...(opts ?? {}), persist: opts?.persist ?? this.persistByDefault, memory: opts?.memory ?? this.memory };
  }

  create(input: CreateNativeSpawnIntentInput): NativeSpawnIntent {
    const createdAt = nowIso(input.now);
    const ttlMs = Math.max(1, input.ttlMs);
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    const canonicalArgsHash = hashSessionsSpawnArgs(input.sessionsSpawnArgs);
    const intent: NativeSpawnIntent = {
      spawnIntentId: generateSpawnIntentId(),
      workContractId: input.workContractId,
      delegateTaskId: input.delegateTaskId,
      attemptId: input.attemptId,
      sessionKey: input.sessionKey,
      canonicalArgsHash,
      planHash: canonicalArgsHash,
      sessionsSpawnArgs: input.sessionsSpawnArgs,
      dispatchMode: input.dispatchMode || "new_spawn",
      speculativeSessionLabel: input.speculativeSessionLabel || null,
      status: "planned",
      runId: null,
      ttlMs,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    };
    return saveIntent(intent, this.options(input));
  }

  get(spawnIntentId: string, opts?: StoreOptions): NativeSpawnIntent | null {
    return readIntent(spawnIntentId, this.options(opts));
  }

  findPendingForSession(sessionKey: string, opts?: FindPendingOptions | number): NativeSpawnIntent | null {
    const key = asString(sessionKey);
    if (!key) return null;
    const options = typeof opts === "number" ? { now: opts } : opts;
    const now = normalizeNow(options?.now);
    const nowMs = now.getTime();
    const runtimeOptions = this.options(options);
    const opened = openDb(runtimeOptions);
    if (!opened.db) {
      failIfPersistentUnavailable(opened);
      return findPendingInMemory(this.memory, key, nowMs, options?.dispatchMode);
    }
    try {
      const rows = withSqliteBusyRetry(() => opened.db!.prepare(
        `SELECT intent_json FROM native_spawn_intents
         WHERE session_key = ? AND status = 'planned'
         ORDER BY created_at DESC`,
      ).all(key));
      for (const row of rows) {
        const intent = parseIntent(row);
        if (!intent) continue;
        if (options?.dispatchMode && intent.dispatchMode !== options.dispatchMode) continue;
        if (parseTime(intent.expiresAt) <= nowMs) {
          upsertDbIntent(opened.db, { ...intent, status: "expired", updatedAt: now.toISOString() });
          continue;
        }
        return intent;
      }
      return null;
    } finally {
      closeDb(opened);
    }
  }

  transitionToSpawnCallStarted(input: {
    spawnIntentId: string;
    sessionKey?: string;
    sessionsSpawnArgs: SessionsSpawnArgs;
    now?: Date | number;
    dbPath?: string;
    sqlite?: SqliteProvider;
  }): NativeSpawnIntentTransitionResult {
    const runtimeOptions = this.options(input);
    const opened = openDb(runtimeOptions);
    if (opened.db) {
      try {
        return withDbTransaction(opened.db, () => {
          const intent = readDbIntent(opened.db!, input.spawnIntentId);
          if (!intent) return { ok: false, error: "intent_not_found" };
          const now = normalizeNow(input.now);
          if (input.sessionKey && intent.sessionKey !== input.sessionKey) {
            return { ok: false, intent, error: "session_mismatch" };
          }
          if (intent.status !== "planned") {
            return { ok: false, intent, error: `invalid_status:${intent.status}` };
          }
          if (parseTime(intent.expiresAt) <= now.getTime()) {
            const expired = cloneIntent({ ...intent, status: "expired", updatedAt: now.toISOString() });
            upsertDbIntent(opened.db!, expired);
            return { ok: false, intent: expired, error: "intent_expired" };
          }
          const actualHash = hashSessionsSpawnArgs(input.sessionsSpawnArgs);
          if (actualHash !== intent.canonicalArgsHash) {
            return { ok: false, intent, error: "args_hash_mismatch" };
          }
          const started = cloneIntent({ ...intent, status: "spawn_call_started", updatedAt: now.toISOString() });
          upsertDbIntent(opened.db!, started);
          return { ok: true, intent: started };
        });
      } catch (error) {
        return { ok: false, error: storeError(error) };
      } finally {
        closeDb(opened);
      }
    }
    if (opened.persistent) return { ok: false, error: "sqlite_unavailable" };

    const intent = readIntent(input.spawnIntentId, runtimeOptions);
    if (!intent) return { ok: false, error: "intent_not_found" };
    const now = normalizeNow(input.now);
    if (input.sessionKey && intent.sessionKey !== input.sessionKey) {
      return { ok: false, intent, error: "session_mismatch" };
    }
    if (intent.status !== "planned") {
      return { ok: false, intent, error: `invalid_status:${intent.status}` };
    }
    if (parseTime(intent.expiresAt) <= now.getTime()) {
      return {
        ok: false,
        intent: saveIntent({ ...intent, status: "expired", updatedAt: now.toISOString() }, runtimeOptions),
        error: "intent_expired",
      };
    }
    const actualHash = hashSessionsSpawnArgs(input.sessionsSpawnArgs);
    if (actualHash !== intent.canonicalArgsHash) {
      return { ok: false, intent, error: "args_hash_mismatch" };
    }
    return {
      ok: true,
      intent: saveIntent({ ...intent, status: "spawn_call_started", updatedAt: now.toISOString() }, runtimeOptions),
    };
  }

  confirmAccepted(input: ConfirmNativeSpawnIntentInput): ConfirmNativeSpawnIntentResult {
    const runId = asString(input.runId);
    if (!runId) return { ok: false, status: "error", error: "run_id_required" };
    const runtimeOptions = this.options(input);
    const opened = openDb(runtimeOptions);
    if (opened.db) {
      try {
        return withDbTransaction(opened.db, () => {
          const intent = readDbIntent(opened.db!, input.spawnIntentId);
          if (!intent) return { ok: false, status: "error", error: "intent_not_found" };
          if (intent.workContractId !== input.workContractId) {
            return { ok: false, status: "error", intent, error: "work_contract_mismatch" };
          }
          if (input.sessionKey && intent.sessionKey !== input.sessionKey) {
            return { ok: false, status: "error", intent, error: "session_mismatch" };
          }
          if (intent.status === "accepted") {
            if (intent.runId === runId) return { ok: true, status: "idempotent", intent, idempotent: true };
            return {
              ok: false,
              status: "conflict",
              intent,
              error: "run_id_conflict",
              existingRunId: intent.runId ?? undefined,
            };
          }
          if (intent.status !== "spawn_call_started") {
            return { ok: false, status: "error", intent, error: `invalid_status:${intent.status}` };
          }
          const now = normalizeNow(input.now);
          if (parseTime(intent.expiresAt) <= now.getTime()) {
            const expired = cloneIntent({ ...intent, status: "expired", updatedAt: now.toISOString() });
            upsertDbIntent(opened.db!, expired);
            return {
              ok: false,
              status: "error",
              intent: expired,
              error: "intent_expired",
            };
          }
          const accepted: NativeSpawnIntent = {
            ...intent,
            status: "accepted",
            runId,
            openclawRunId: runId,
            childRunId: asString(input.childRunId) || runId,
            childSessionKey: asString(input.childSessionKey) || intent.childSessionKey || null,
            acceptedAt: now.toISOString(),
            confirmedAt: now.toISOString(),
            updatedAt: now.toISOString(),
            error: null,
          };
          const normalized = cloneIntent(accepted);
          upsertDbIntent(opened.db!, normalized);
          return { ok: true, status: "accepted", intent: normalized, idempotent: false };
        });
      } catch (error) {
        return { ok: false, status: "error", error: storeError(error) };
      } finally {
        closeDb(opened);
      }
    }
    if (opened.persistent) return { ok: false, status: "error", error: "sqlite_unavailable" };

    const intent = readIntent(input.spawnIntentId, runtimeOptions);
    if (!intent) return { ok: false, status: "error", error: "intent_not_found" };
    if (intent.workContractId !== input.workContractId) {
      return { ok: false, status: "error", intent, error: "work_contract_mismatch" };
    }
    if (input.sessionKey && intent.sessionKey !== input.sessionKey) {
      return { ok: false, status: "error", intent, error: "session_mismatch" };
    }
    if (intent.status === "accepted") {
      if (intent.runId === runId) return { ok: true, status: "idempotent", intent, idempotent: true };
      return {
        ok: false,
        status: "conflict",
        intent,
        error: "run_id_conflict",
        existingRunId: intent.runId ?? undefined,
      };
    }
    if (intent.status !== "spawn_call_started") {
      return { ok: false, status: "error", intent, error: `invalid_status:${intent.status}` };
    }
    const now = normalizeNow(input.now);
    if (parseTime(intent.expiresAt) <= now.getTime()) {
      return {
        ok: false,
        status: "error",
        intent: saveIntent({ ...intent, status: "expired", updatedAt: now.toISOString() }, runtimeOptions),
        error: "intent_expired",
      };
    }
    const accepted: NativeSpawnIntent = {
      ...intent,
      status: "accepted",
      runId,
      openclawRunId: runId,
      childRunId: asString(input.childRunId) || runId,
      childSessionKey: asString(input.childSessionKey) || intent.childSessionKey || null,
      acceptedAt: now.toISOString(),
      confirmedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      error: null,
    };
    return { ok: true, status: "accepted", intent: saveIntent(accepted, runtimeOptions), idempotent: false };
  }

  confirmAccept(params: ConfirmAcceptParams): ConfirmAcceptResult {
    if (!asString(params.workContractId)) return { ok: false, error: "workContractId_required" };
    const result = this.confirmAccepted({
      spawnIntentId: params.spawnIntentId,
      workContractId: params.workContractId ?? "",
      sessionKey: params.sessionKey,
      runId: params.runId,
      childRunId: params.childRunId,
      childSessionKey: params.childSessionKey,
      now: params.now,
    });
    if (result.ok) return { ok: true, intent: result.intent, idempotent: result.idempotent };
    const legacyError = result.error === "run_id_required"
      ? "runId_required"
      : result.error === "run_id_conflict"
        ? "runId_conflict"
        : result.error;
    return {
      ok: false,
      error: legacyError,
      ...(result.existingRunId ? { existingRunId: result.existingRunId } : {}),
    };
  }

  markFailed(input: {
    spawnIntentId: string;
    workContractId?: string;
    sessionKey?: string;
    error: string;
    now?: Date | number;
    dbPath?: string;
    sqlite?: SqliteProvider;
  }): NativeSpawnIntentTransitionResult {
    try {
      const runtimeOptions = this.options(input);
      const intent = readIntent(input.spawnIntentId, runtimeOptions);
      if (!intent) return { ok: false, error: "intent_not_found" };
      if (input.workContractId && intent.workContractId !== input.workContractId) {
        return { ok: false, intent, error: "work_contract_mismatch" };
      }
      if (input.sessionKey && intent.sessionKey !== input.sessionKey) {
        return { ok: false, intent, error: "session_mismatch" };
      }
      if (isNativeSpawnIntentTerminal(intent.status)) return { ok: false, intent, error: intent.status === "accepted" ? "already_accepted" : "already_terminal" };
      const now = normalizeNow(input.now);
      return {
        ok: true,
        intent: saveIntent({ ...intent, status: "failed", error: input.error, failedAt: now.toISOString(), updatedAt: now.toISOString() }, runtimeOptions),
      };
    } catch (error) {
      return { ok: false, error: storeError(error) };
    }
  }

  confirmFailed(spawnIntentId: string, error: string, now?: number): ConfirmFailResult {
    return this.markFailed({ spawnIntentId, error, now });
  }

  markAckSent(spawnIntentId: string, opts?: { now?: Date | number; dbPath?: string; sqlite?: SqliteProvider }): NativeSpawnIntentTransitionResult {
    try {
      const runtimeOptions = this.options(opts);
      const intent = readIntent(spawnIntentId, runtimeOptions);
      if (!intent) return { ok: false, error: "intent_not_found" };
      if (intent.ackSentAt) return { ok: true, intent };
      const now = normalizeNow(opts?.now);
      return { ok: true, intent: saveIntent({ ...intent, ackSentAt: now.toISOString(), updatedAt: now.toISOString() }, runtimeOptions) };
    } catch (error) {
      return { ok: false, error: storeError(error) };
    }
  }

  expire(spawnIntentId: string, opts?: { now?: Date | number; dbPath?: string; sqlite?: SqliteProvider }): NativeSpawnIntent | null {
    const runtimeOptions = this.options(opts);
    const intent = readIntent(spawnIntentId, runtimeOptions);
    if (!intent) return null;
    const now = normalizeNow(opts?.now);
    return saveIntent({ ...intent, status: "expired", updatedAt: now.toISOString() }, runtimeOptions);
  }

  expireElapsed(now?: number): number {
    const nowMs = now ?? Date.now();
    let expired = 0;
    for (const intent of this.memory.values()) {
      if ((intent.status === "planned" || intent.status === "spawn_call_started") && parseTime(intent.expiresAt) <= nowMs) {
        this.memory.set(intent.spawnIntentId, normalizeIntent({ ...intent, status: "expired", updatedAt: new Date(nowMs).toISOString() }));
        expired += 1;
      }
    }
    return expired;
  }

  clear(): void {
    this.clearForTests();
  }

  size(): number {
    return this.memory.size;
  }

  clearForTests(opts?: StoreOptions): void {
    this.memory.clear();
    const opened = openDb(this.options(opts));
    if (!opened.db) return;
    try {
      opened.db.prepare("DELETE FROM native_spawn_intents").run();
    } finally {
      try { opened.db.close(); } catch {}
    }
  }
}

export const nativeSpawnIntentStore = new NativeSpawnIntentStore({ persist: true });
