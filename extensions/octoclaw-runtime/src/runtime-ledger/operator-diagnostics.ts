import { openRuntimeLedger } from "./index.js";
import type { DatabaseSync, SqliteProvider } from "./types.js";
import { isTaskStateRebuildEnabled } from "./feature-flags.js";
import { rebuildTaskStateProjection, writeRebuiltTaskState } from "./projection-rebuild.js";
import { requeueExpiredLeases } from "./scheduler.js";

// ── DB health ────────────────────────────────────────────────────────

export interface LedgerHealthReport {
  dbOpen: boolean;
  dbPath: string;
  schemaVersion: number | null;
  workContractCount: number;
  attemptCount: number;
  ticketCount: number;
  queueCount: number;
  completionBindingCount: number;
  runtimeEventCount: number;
  orphanedCompletions: number;
  staleLeases: number;
  errors: string[];
}

export interface LedgerDiagnosticsInput {
  dbPath?: string;
  sqlite?: SqliteProvider;
}

export function inspectLedgerHealth(input: LedgerDiagnosticsInput = {}): LedgerHealthReport {
  const report: LedgerHealthReport = {
    dbOpen: false,
    dbPath: "",
    schemaVersion: null,
    workContractCount: 0,
    attemptCount: 0,
    ticketCount: 0,
    queueCount: 0,
    completionBindingCount: 0,
    runtimeEventCount: 0,
    orphanedCompletions: 0,
    staleLeases: 0,
    errors: [],
  };

  const openResult = openRuntimeLedger({ dbPath: input.dbPath, mode: "best_effort", sqlite: input.sqlite });
  report.dbPath = openResult.dbPath;

  if (openResult.status !== "ok" || !openResult.db) {
    report.errors.push(openResult.error ?? "ledger_unavailable");
    return report;
  }

  const db = openResult.db;
  report.dbOpen = true;

  try {
    report.schemaVersion = readSchemaVersion(db);
    report.workContractCount = countRows(db, "work_contracts");
    report.attemptCount = countRows(db, "task_attempts");
    report.ticketCount = countRows(db, "delegation_tickets");
    report.queueCount = countRows(db, "scheduler_queue");
    report.completionBindingCount = countRows(db, "completion_bindings");
    report.runtimeEventCount = countRows(db, "runtime_events");
    report.orphanedCompletions = countRows(db, "completion_bindings", "verdict IN ('completion_orphaned','binding_mismatch')");

    const now = new Date().toISOString();
    report.staleLeases = countRows(db, "scheduler_queue", "lease_expires_at IS NOT NULL AND lease_expires_at < ?", [now]);
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }

  return report;
}

// ── Orphan list ──────────────────────────────────────────────────────

export interface OrphanSummary {
  completionId: string;
  workContractId: string;
  attemptId: string;
  expectedPath: string;
  verdict: string;
  createdAt: string;
}

export function listOrphanCompletions(input: LedgerDiagnosticsInput = {}): OrphanSummary[] {
  const orphans: OrphanSummary[] = [];

  const openResult = openRuntimeLedger({ dbPath: input.dbPath, mode: "best_effort", sqlite: input.sqlite });
  if (openResult.status !== "ok" || !openResult.db) return orphans;

  const db = openResult.db;
  try {
    const rows = db.prepare(
      `SELECT completion_id, work_contract_id, attempt_id, expected_path, verdict, created_at
       FROM completion_bindings
       WHERE verdict IN ('completion_orphaned','binding_mismatch','missing')
       ORDER BY created_at DESC`,
    ).all();

    for (const row of rows) {
      orphans.push({
        completionId: String(row.completion_id),
        workContractId: String(row.work_contract_id),
        attemptId: String(row.attempt_id),
        expectedPath: String(row.expected_path),
        verdict: String(row.verdict),
        createdAt: String(row.created_at),
      });
    }
  } finally {
    db.close();
  }

  return orphans;
}

// ── Stale lease release ──────────────────────────────────────────────

export interface ReleaseStaleLeasesResult {
  released: number;
  errors: string[];
}

export function releaseStaleLeases(input: LedgerDiagnosticsInput = {}): ReleaseStaleLeasesResult {
  const result: ReleaseStaleLeasesResult = { released: 0, errors: [] };

  try {
    const requeued = requeueExpiredLeases({ dbPath: input.dbPath, sqlite: input.sqlite });
    result.released = requeued.requeued;
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

// ── Projection rebuild operator command ──────────────────────────────

export interface RebuildProjectionResult {
  enabled: boolean;
  rebuilt: boolean;
  taskCount: number;
  writtenAt: string | null;
  error?: string;
}

export function operatorRebuildProjection(input: LedgerDiagnosticsInput = {}): RebuildProjectionResult {
  if (!isTaskStateRebuildEnabled()) {
    return { enabled: false, rebuilt: false, taskCount: 0, writtenAt: null };
  }

  try {
    const projection = rebuildTaskStateProjection({ dbPath: input.dbPath, sqlite: input.sqlite });
    const writeResult = writeRebuiltTaskState({ dbPath: input.dbPath, sqlite: input.sqlite });

    return {
      enabled: true,
      rebuilt: writeResult.written,
      taskCount: projection.tasks.length,
      writtenAt: writeResult.written ? projection.rebuiltAt : null,
      error: writeResult.written ? undefined : (writeResult.error ?? "unknown_error"),
    };
  } catch (err) {
    return { enabled: true, rebuilt: false, taskCount: 0, writtenAt: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function readSchemaVersion(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
  return row?.v !== undefined && row?.v !== null ? Number(row.v) : null;
}

function countRows(db: DatabaseSync, table: string, where?: string, params?: unknown[]): number {
  const sql = where
    ? `SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`
    : `SELECT COUNT(*) AS c FROM ${table}`;
  const stmt = db.prepare(sql);
  const row = params ? stmt.all(...params)[0] : stmt.all()[0];
  return Number(row?.c ?? 0);
}
