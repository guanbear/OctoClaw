import { openRuntimeLedger } from "./index.js";
import type { DatabaseSync, SqliteProvider } from "./types.js";
import { isTaskStateRebuildEnabled } from "./feature-flags.js";
import { rebuildTaskStateProjection, writeRebuiltTaskState } from "./projection-rebuild.js";

// ── DB health ────────────────────────────────────────────────────────

export interface LedgerHealthReport {
  dbOpen: boolean;
  dbPath: string;
  schemaVersion: number | null;
  workContractCount: number;
  attemptCount: number;
  ticketCount: number;
  runtimeEventCount: number;
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
    runtimeEventCount: 0,
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
    report.runtimeEventCount = countRows(db, "runtime_events");
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }

  return report;
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
