import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { openRuntimeLedger } from "./index.js";
import type { DatabaseSync, SqliteProvider } from "./types.js";

type UnknownRecord = Record<string, unknown>;

export interface SchedulerConfig {
  enabled: boolean;
  maxConcurrentSpawns: number;
  leaseDurationMs: number;
}

export type QueueStatus = "admitted" | "queued" | "blocked" | "spawning" | "running" | "terminal";

export interface PromoteToQueuedInput {
  queueId: string;
  contract?: WorkContract | null;
  resourceKeys?: string[];
  dependencyIds?: string[];
  dbPath?: string;
  sqlite?: SqliteProvider;
  now?: Date;
}

export interface PromoteToQueuedResult {
  ok: boolean;
  queueId: string;
  queueStatus: QueueStatus;
  blockedBy?: string;
  blockedReason?: string;
  queuedAfter?: string;
  error?: string;
}

export interface AcquireLeaseInput {
  leaseOwner: string;
  maxConcurrentSpawns?: number;
  dbPath?: string;
  sqlite?: SqliteProvider;
  now?: Date;
  leaseDurationMs?: number;
}

export interface AcquireLeaseResult {
  acquired: boolean;
  queueId?: string;
  workContractId?: string;
  attemptId?: string;
  resourceKeys?: string[];
  leaseOwner?: string;
  leaseExpiresAt?: string;
  blockedBy?: string;
  blockedReason?: string;
  reason?: string;
}

export interface MaterializeInput {
  queueId: string;
  nativeFlowId?: string;
  nativeTaskId?: string;
  childSessionKey?: string;
  childRunId?: string;
  dbPath?: string;
  sqlite?: SqliteProvider;
  now?: Date;
}

export interface MaterializeResult {
  ok: boolean;
  queueId: string;
  attemptId?: string;
  queueStatus?: QueueStatus;
  error?: string;
}

export interface ReleaseInput {
  queueId: string;
  outcome: "completed" | "failed" | "cancelled";
  errorCode?: string;
  errorMessage?: string;
  terminalSummary?: string;
  dbPath?: string;
  sqlite?: SqliteProvider;
  now?: Date;
}

export interface ReleaseResult {
  ok: boolean;
  queueId: string;
  unblockedCount?: number;
  error?: string;
}

export interface RequeueExpiredInput {
  maxRequeue?: number;
  dbPath?: string;
  sqlite?: SqliteProvider;
  now?: Date;
}

export interface RequeueExpiredResult {
  requeued: number;
  skippedRunning: number;
  queueIds: string[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizePath(p: string): string {
  return p.replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
}

export function deriveSchedulerResourceKeys(contract: WorkContract): string[] {
  const writePaths = contract.delegate?.scope?.write;
  if (!Array.isArray(writePaths) || writePaths.length === 0) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const p of writePaths) {
    if (typeof p !== "string" || !p.trim()) continue;
    const normalized = normalizePath(p);
    const key = `write:${normalized}`;
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function writeKeysFromResourceKeys(resourceKeysJson: string): string[] {
  try {
    const keys: unknown[] = JSON.parse(resourceKeysJson || "[]");
    return keys.filter((k): k is string => typeof k === "string" && k.startsWith("write:"));
  } catch {
    return [];
  }
}

function appendRuntimeEvent(
  db: DatabaseSync,
  eventType: string,
  workContractId: string,
  attemptId: string | null,
  payload: Record<string, unknown>,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO runtime_events (event_type, work_contract_id, attempt_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventType, workContractId, attemptId, JSON.stringify(payload), nowIso);
}

function unblockRowsBlockedBy(db: DatabaseSync, releasedQueueId: string, nowIso: string): number {
  const rows = db.prepare(
    `SELECT queue_id, work_contract_id, attempt_id FROM scheduler_queue WHERE blocked_by = ? AND queue_status = 'blocked'`,
  ).all(releasedQueueId);

  if (rows.length === 0) return 0;

  for (const row of rows) {
    const queueId = asString(row.queue_id);
    const workContractId = asString(row.work_contract_id);
    const attemptId = asString(row.attempt_id);
    db.prepare(
      `UPDATE scheduler_queue
       SET queue_status = 'queued', blocked_by = NULL, blocked_reason = NULL,
           queued_after = NULL, updated_at = ?, revision = revision + 1
       WHERE queue_id = ?`,
    ).run(nowIso, queueId);

    appendRuntimeEvent(db, "scheduler_queue_unblocked", workContractId, attemptId, {
      queueId,
      unblockedBy: releasedQueueId,
      reason: "blocker_released",
    }, nowIso);
  }

  return rows.length;
}

export function resolveSchedulerConfig(): SchedulerConfig {
  const schedulerEnabledValue = String(process.env.OCTOCLAW_SCHEDULER_ENABLED || "").trim().toLowerCase();
  const enabled = schedulerEnabledValue === "1" || schedulerEnabledValue === "true";
  const maxConcurrentSpawns = Math.max(1, Number(process.env.OCTOCLAW_MAX_CONCURRENT_SPAWNS) || 1);
  const leaseDurationMs = 5 * 60 * 1000;
  return { enabled, maxConcurrentSpawns, leaseDurationMs };
}

export function promoteToQueued(input: PromoteToQueuedInput): PromoteToQueuedResult {
  const openResult = openRuntimeLedger({ dbPath: input.dbPath, mode: "best_effort", sqlite: input.sqlite });
  if (openResult.status !== "ok" || !openResult.db) {
    return { ok: false, queueId: input.queueId, queueStatus: "admitted", error: "ledger_unavailable" };
  }

  const db = openResult.db;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const resourceKeys = input.resourceKeys
    ?? (input.contract ? deriveSchedulerResourceKeys(input.contract) : []);
  const dependencyIds = input.dependencyIds ?? [];

  try {
    db.exec("BEGIN");

    const row = db.prepare(
      `SELECT queue_id, work_contract_id, attempt_id, queue_status, resource_keys_json
       FROM scheduler_queue WHERE queue_id = ?`,
    ).get(input.queueId);

    if (!row) {
      db.exec("ROLLBACK");
      return { ok: false, queueId: input.queueId, queueStatus: "admitted", error: "queue_row_not_found" };
    }

    if (asString(row.queue_status) !== "admitted") {
      db.exec("ROLLBACK");
      return {
        ok: false,
        queueId: input.queueId,
        queueStatus: asString(row.queue_status) as QueueStatus,
        error: "not_admitted",
      };
    }

    const myWriteKeys = resourceKeys.filter(k => k.startsWith("write:"));
    if (myWriteKeys.length > 0) {
      const conflictingRows = db.prepare(
        `SELECT queue_id, work_contract_id, resource_keys_json
         FROM scheduler_queue
         WHERE queue_status IN ('queued', 'spawning', 'running')
           AND queue_id != ?`,
      ).all(input.queueId);

      for (const conflict of conflictingRows) {
        const theirWriteKeys = writeKeysFromResourceKeys(asString(conflict.resource_keys_json));
        const overlap = myWriteKeys.some(k => theirWriteKeys.includes(k));
        if (overlap) {
          const blockedBy = asString(conflict.queue_id);
          db.prepare(
            `UPDATE scheduler_queue
             SET queue_status = 'blocked', blocked_by = ?, blocked_reason = 'write_scope_conflict',
                 resource_keys_json = ?, updated_at = ?, revision = revision + 1
             WHERE queue_id = ?`,
          ).run(blockedBy, JSON.stringify(resourceKeys), nowIso, input.queueId);

          const workContractId = asString(row.work_contract_id);
          const attemptId = asString(row.attempt_id);
          appendRuntimeEvent(db, "scheduler_queue_blocked", workContractId, attemptId, {
            queueId: input.queueId,
            blockedBy,
            reason: "write_scope_conflict",
            conflictingKeys: myWriteKeys,
          }, nowIso);

          db.exec("COMMIT");
          return {
            ok: false,
            queueId: input.queueId,
            queueStatus: "blocked",
            blockedBy,
            blockedReason: "write_scope_conflict",
          };
        }
      }
    }

    db.prepare(
      `UPDATE scheduler_queue
       SET queue_status = 'queued', resource_keys_json = ?, dependency_ids_json = ?,
           updated_at = ?, revision = revision + 1
       WHERE queue_id = ?`,
    ).run(JSON.stringify(resourceKeys), JSON.stringify(dependencyIds), nowIso, input.queueId);

    const workContractId = asString(row.work_contract_id);
    const attemptId = asString(row.attempt_id);
    appendRuntimeEvent(db, "scheduler_queue_promoted", workContractId, attemptId, {
      queueId: input.queueId,
      resourceKeys,
      dependencyIds,
    }, nowIso);

    db.exec("COMMIT");
    return { ok: true, queueId: input.queueId, queueStatus: "queued" };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return {
      ok: false,
      queueId: input.queueId,
      queueStatus: "admitted",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try { db.close(); } catch {}
  }
}

export function tryAcquireLease(input: AcquireLeaseInput): AcquireLeaseResult {
  const openResult = openRuntimeLedger({ dbPath: input.dbPath, mode: "best_effort", sqlite: input.sqlite });
  if (openResult.status !== "ok" || !openResult.db) {
    return { acquired: false, reason: "ledger_unavailable" };
  }

  const db = openResult.db;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseDurationMs = input.leaseDurationMs ?? 5 * 60 * 1000;
  const maxConcurrent = input.maxConcurrentSpawns ?? 1;

  try {
    db.exec("BEGIN IMMEDIATE");

    const activeCount = db.prepare(
      `SELECT COUNT(*) AS cnt FROM scheduler_queue WHERE queue_status IN ('spawning', 'running')`,
    ).get();
    const currentActive = Number(asRecord(activeCount).cnt ?? 0);

    if (currentActive >= maxConcurrent) {
      db.exec("ROLLBACK");
      return { acquired: false, reason: "capacity_full" };
    }

    const candidates = db.prepare(
      `SELECT q.queue_id, q.work_contract_id, q.attempt_id, q.resource_keys_json, q.priority, q.created_at
       FROM scheduler_queue q
       WHERE q.queue_status = 'queued'
       ORDER BY q.priority DESC, q.created_at ASC
       LIMIT ?`,
    ).all(maxConcurrent - currentActive + 10);

    if (candidates.length === 0) {
      db.exec("ROLLBACK");
      return { acquired: false, reason: "no_queued_work" };
    }

    const activeRows = db.prepare(
      `SELECT queue_id, resource_keys_json
       FROM scheduler_queue
       WHERE queue_status IN ('spawning', 'running')`,
    ).all();

    const activeWriteKeys: string[] = [];
    for (const ar of activeRows) {
      activeWriteKeys.push(...writeKeysFromResourceKeys(asString(ar.resource_keys_json)));
    }

    let acquired: AcquireLeaseResult | null = null;
    let lastConflict: AcquireLeaseResult | null = null;

    for (const candidate of candidates) {
      if (acquired) break;

      const queueId = asString(candidate.queue_id);
      const workContractId = asString(candidate.work_contract_id);
      const attemptId = asString(candidate.attempt_id);
      const candidateWriteKeys = writeKeysFromResourceKeys(asString(candidate.resource_keys_json));

      const hasConflict = candidateWriteKeys.length > 0
        && candidateWriteKeys.some(k => activeWriteKeys.includes(k));

      if (hasConflict) {
        const conflictingActive = activeRows.find(ar =>
          writeKeysFromResourceKeys(asString(ar.resource_keys_json))
            .some(ak => candidateWriteKeys.includes(ak)),
        );

        const blockedBy = asString(conflictingActive?.queue_id ?? "");
        db.prepare(
          `UPDATE scheduler_queue
           SET queue_status = 'blocked', blocked_by = ?, blocked_reason = 'write_scope_conflict',
               updated_at = ?, revision = revision + 1
           WHERE queue_id = ?`,
        ).run(blockedBy, nowIso, queueId);

        appendRuntimeEvent(db, "scheduler_lease_blocked", workContractId, attemptId, {
          queueId,
          blockedBy,
          reason: "write_scope_conflict",
        }, nowIso);

        if (!lastConflict) {
          lastConflict = {
            acquired: false,
            queueId,
            workContractId,
            attemptId,
            blockedBy,
            blockedReason: "write_scope_conflict",
            reason: "write_scope_conflict",
          };
        }
        continue;
      }

      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

      db.prepare(
        `UPDATE scheduler_queue
         SET queue_status = 'spawning', lease_owner = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
         WHERE queue_id = ?`,
      ).run(input.leaseOwner, leaseExpiresAt, nowIso, queueId);

      db.prepare(
        `UPDATE task_attempts
         SET status = 'spawning', updated_at = ?, revision = revision + 1
         WHERE attempt_id = ?`,
      ).run(nowIso, attemptId);

      appendRuntimeEvent(db, "scheduler_lease_acquired", workContractId, attemptId, {
        queueId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
      }, nowIso);

      activeWriteKeys.push(...candidateWriteKeys);

      acquired = {
        acquired: true,
        queueId,
        workContractId,
        attemptId,
        resourceKeys: candidateWriteKeys.length > 0 ? candidateWriteKeys : [],
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
      };
    }

    db.exec("COMMIT");

    if (acquired) return acquired;
    if (lastConflict) return lastConflict;
    return { acquired: false, reason: "no_queued_work" };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return { acquired: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    try { db.close(); } catch {}
  }
}

export function materializeNativeIds(input: MaterializeInput): MaterializeResult {
  const openResult = openRuntimeLedger({ dbPath: input.dbPath, mode: "best_effort", sqlite: input.sqlite });
  if (openResult.status !== "ok" || !openResult.db) {
    return { ok: false, queueId: input.queueId, error: "ledger_unavailable" };
  }

  const db = openResult.db;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  try {
    db.exec("BEGIN");

    const row = db.prepare(
      `SELECT queue_id, work_contract_id, attempt_id, queue_status
       FROM scheduler_queue WHERE queue_id = ?`,
    ).get(input.queueId);

    if (!row) {
      db.exec("ROLLBACK");
      return { ok: false, queueId: input.queueId, error: "queue_row_not_found" };
    }

    const status = asString(row.queue_status);
    if (status !== "spawning") {
      db.exec("ROLLBACK");
      return { ok: false, queueId: input.queueId, queueStatus: status as QueueStatus, error: "not_spawning" };
    }

    const attemptId = asString(row.attempt_id);

    db.prepare(
      `UPDATE scheduler_queue
       SET queue_status = 'running', updated_at = ?, revision = revision + 1
       WHERE queue_id = ?`,
    ).run(nowIso, input.queueId);

    db.prepare(
      `UPDATE task_attempts
       SET status = 'running',
           native_flow_id = ?, native_task_id = ?,
           child_session_key = ?, child_run_id = ?,
           started_at = ?, updated_at = ?, revision = revision + 1
       WHERE attempt_id = ?`,
    ).run(
      input.nativeFlowId ?? null,
      input.nativeTaskId ?? null,
      input.childSessionKey ?? null,
      input.childRunId ?? null,
      nowIso,
      nowIso,
      attemptId,
    );

    const workContractId = asString(row.work_contract_id);
    appendRuntimeEvent(db, "scheduler_materialized", workContractId, attemptId, {
      queueId: input.queueId,
      nativeFlowId: input.nativeFlowId ?? null,
      nativeTaskId: input.nativeTaskId ?? null,
      childSessionKey: input.childSessionKey ?? null,
    }, nowIso);

    db.exec("COMMIT");
    return { ok: true, queueId: input.queueId, attemptId, queueStatus: "running" };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return {
      ok: false,
      queueId: input.queueId,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try { db.close(); } catch {}
  }
}

export function releaseOrComplete(input: ReleaseInput): ReleaseResult {
  const openResult = openRuntimeLedger({ dbPath: input.dbPath, mode: "best_effort", sqlite: input.sqlite });
  if (openResult.status !== "ok" || !openResult.db) {
    return { ok: false, queueId: input.queueId, error: "ledger_unavailable" };
  }

  const db = openResult.db;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  try {
    db.exec("BEGIN");

    const row = db.prepare(
      `SELECT queue_id, work_contract_id, attempt_id, queue_status
       FROM scheduler_queue WHERE queue_id = ?`,
    ).get(input.queueId);

    if (!row) {
      db.exec("ROLLBACK");
      return { ok: false, queueId: input.queueId, error: "queue_row_not_found" };
    }

    const status = asString(row.queue_status);
    if (status === "terminal") {
      db.exec("ROLLBACK");
      return { ok: false, queueId: input.queueId, error: "already_terminal" };
    }

    const workContractId = asString(row.work_contract_id);
    const attemptId = asString(row.attempt_id);

    db.prepare(
      `UPDATE scheduler_queue
       SET queue_status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
           updated_at = ?, revision = revision + 1
       WHERE queue_id = ?`,
    ).run(nowIso, input.queueId);

    db.prepare(
      `UPDATE task_attempts
       SET status = ?, error_code = ?, error_message = ?,
           terminal_outcome = ?, terminal_summary = ?,
           ended_at = ?, updated_at = ?, revision = revision + 1
       WHERE attempt_id = ?`,
    ).run(
      input.outcome,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.outcome,
      input.terminalSummary ?? null,
      nowIso,
      nowIso,
      attemptId,
    );

    if (input.outcome === "completed") {
      db.prepare(
        `UPDATE work_contracts SET status = 'completed', completed_at = ?, updated_at = ?, revision = revision + 1
         WHERE work_contract_id = ?`,
      ).run(nowIso, nowIso, workContractId);
    } else if (input.outcome === "failed" || input.outcome === "cancelled") {
      db.prepare(
        `UPDATE work_contracts SET status = ?, updated_at = ?, revision = revision + 1
         WHERE work_contract_id = ?`,
      ).run(input.outcome, nowIso, workContractId);
    }

    const unblockedCount = unblockRowsBlockedBy(db, input.queueId, nowIso);

    appendRuntimeEvent(db, "scheduler_released", workContractId, attemptId, {
      queueId: input.queueId,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      unblockedCount,
    }, nowIso);

    db.exec("COMMIT");
    return { ok: true, queueId: input.queueId, unblockedCount };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return {
      ok: false,
      queueId: input.queueId,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try { db.close(); } catch {}
  }
}

export function requeueExpiredLeases(input: RequeueExpiredInput = {}): RequeueExpiredResult {
  const openResult = openRuntimeLedger({ dbPath: input.dbPath, mode: "best_effort", sqlite: input.sqlite });
  if (openResult.status !== "ok" || !openResult.db) {
    return { requeued: 0, skippedRunning: 0, queueIds: [] };
  }

  const db = openResult.db;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const maxRequeue = input.maxRequeue ?? 10;

  try {
    db.exec("BEGIN IMMEDIATE");

    const expiredSpawning = db.prepare(
      `SELECT queue_id, work_contract_id, attempt_id, lease_owner, lease_expires_at
       FROM scheduler_queue
       WHERE queue_status = 'spawning'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?
       LIMIT ?`,
    ).all(nowIso, maxRequeue);

    const expiredRunning = db.prepare(
      `SELECT queue_id, work_contract_id, attempt_id, lease_owner, lease_expires_at
       FROM scheduler_queue
       WHERE queue_status = 'running'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?
       LIMIT ?`,
    ).all(nowIso, maxRequeue);

    if (expiredSpawning.length === 0 && expiredRunning.length === 0) {
      db.exec("COMMIT");
      return { requeued: 0, skippedRunning: 0, queueIds: [] };
    }

    const requeuedIds: string[] = [];
    for (const row of expiredSpawning) {
      const queueId = asString(row.queue_id);
      const workContractId = asString(row.work_contract_id);
      const attemptId = asString(row.attempt_id);
      const previousOwner = asString(row.lease_owner);

      db.prepare(
        `UPDATE scheduler_queue
         SET queue_status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?, revision = revision + 1
         WHERE queue_id = ?`,
      ).run(nowIso, queueId);

      db.prepare(
        `UPDATE task_attempts
         SET status = 'queued', native_flow_id = NULL, native_task_id = NULL,
             child_session_key = NULL, child_run_id = NULL,
             updated_at = ?, revision = revision + 1
         WHERE attempt_id = ?`,
      ).run(nowIso, attemptId);

      appendRuntimeEvent(db, "scheduler_lease_expired_requeued", workContractId, attemptId, {
        queueId,
        previousOwner,
        requeuedAt: nowIso,
      }, nowIso);

      requeuedIds.push(queueId);
    }

    for (const row of expiredRunning) {
      const queueId = asString(row.queue_id);
      const workContractId = asString(row.work_contract_id);
      const attemptId = asString(row.attempt_id);
      const previousOwner = asString(row.lease_owner);

      db.prepare(
        `UPDATE scheduler_queue
         SET lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?, revision = revision + 1
         WHERE queue_id = ?`,
      ).run(nowIso, queueId);

      appendRuntimeEvent(db, "scheduler_lease_expired_running_preserved", workContractId, attemptId, {
        queueId,
        previousOwner,
        preservedAt: nowIso,
      }, nowIso);
    }

    db.exec("COMMIT");
    return {
      requeued: requeuedIds.length,
      skippedRunning: expiredRunning.length,
      queueIds: requeuedIds,
    };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return { requeued: 0, skippedRunning: 0, queueIds: [] };
  } finally {
    try { db.close(); } catch {}
  }
}
