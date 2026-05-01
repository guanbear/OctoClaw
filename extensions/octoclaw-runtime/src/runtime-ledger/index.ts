import fsSync from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveRuntimeLedgerDbPath } from "../resolve/env.js";
import type {
  DatabaseSync,
  LedgerMode,
  Migration,
  RuntimeLedgerOpenResult,
  SqliteProvider,
} from "./types.js";

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "create_first_slice_tables",
    sql: [
      `CREATE TABLE IF NOT EXISTS work_contracts (
  work_contract_id TEXT PRIMARY KEY,
  route TEXT NOT NULL CHECK (route IN ('reply', 'delegate')),
  intent_class TEXT,
  expected_deliverable TEXT,
  complexity_final TEXT CHECK (complexity_final IN ('simple', 'normal', 'deep') OR complexity_final IS NULL),
  complexity_reason_codes_json TEXT NOT NULL DEFAULT '[]',
  delivery_target_json TEXT NOT NULL DEFAULT '{}',
  work_contract_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sealed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0
)`,
      `CREATE INDEX IF NOT EXISTS idx_work_contracts_status ON work_contracts(status)`,
      `CREATE INDEX IF NOT EXISTS idx_work_contracts_updated_at ON work_contracts(updated_at)`,

      `CREATE TABLE IF NOT EXISTS delegation_tickets (
  ticket_id TEXT PRIMARY KEY,
  work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  delivery_target_id TEXT NOT NULL,
  expected_deliverable TEXT NOT NULL,
  complexity_final TEXT,
  status TEXT NOT NULL CHECK (status IN ('issued', 'used', 'revoked', 'expired')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  ticket_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
)`,
      `CREATE INDEX IF NOT EXISTS idx_delegation_tickets_work_contract ON delegation_tickets(work_contract_id)`,
      `CREATE INDEX IF NOT EXISTS idx_delegation_tickets_status_expires ON delegation_tickets(status, expires_at)`,

      `CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id TEXT PRIMARY KEY,
  work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  delegate_task_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('initial', 'retry', 'amendment', 'respawn')),
  status TEXT NOT NULL,
  native_flow_id TEXT,
  native_task_id TEXT,
  child_session_key TEXT,
  child_run_id TEXT,
  model_profile TEXT,
  worker_pool TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  terminal_outcome TEXT,
  terminal_summary TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(work_contract_id, attempt_no)
)`,
      `CREATE INDEX IF NOT EXISTS idx_task_attempts_work_contract ON task_attempts(work_contract_id)`,
      `CREATE INDEX IF NOT EXISTS idx_task_attempts_delegate_task ON task_attempts(delegate_task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_task_attempts_native_task ON task_attempts(native_task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_task_attempts_child_session ON task_attempts(child_session_key)`,
      `CREATE INDEX IF NOT EXISTS idx_task_attempts_status_updated ON task_attempts(status, updated_at)`,

      `CREATE TABLE IF NOT EXISTS scheduler_queue (
  queue_id TEXT PRIMARY KEY,
  work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id) ON DELETE CASCADE,
  queue_status TEXT NOT NULL CHECK (queue_status IN ('admitted', 'queued', 'blocked', 'spawning', 'running', 'terminal')),
  priority INTEGER NOT NULL DEFAULT 0,
  dependency_ids_json TEXT NOT NULL DEFAULT '[]',
  queued_after TEXT,
  blocked_by TEXT,
  blocked_reason TEXT,
  resource_keys_json TEXT NOT NULL DEFAULT '[]',
  lease_owner TEXT,
  lease_expires_at TEXT,
  wakeup_at TEXT,
  wakeup_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
)`,
      `CREATE INDEX IF NOT EXISTS idx_scheduler_queue_status_priority ON scheduler_queue(queue_status, priority, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_scheduler_queue_wakeup ON scheduler_queue(wakeup_at)`,
      `CREATE INDEX IF NOT EXISTS idx_scheduler_queue_attempt ON scheduler_queue(attempt_id)`,

      `CREATE TABLE IF NOT EXISTS completion_bindings (
  completion_id TEXT PRIMARY KEY,
  work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id) ON DELETE CASCADE,
  expected_path TEXT NOT NULL,
  expected_work_contract_id TEXT NOT NULL,
  expected_delegate_task_id TEXT NOT NULL,
  expected_native_task_id TEXT,
  expected_child_session_key TEXT,
  observed_path TEXT,
  observed_work_contract_id TEXT,
  observed_delegate_task_id TEXT,
  observed_native_task_id TEXT,
  observed_child_session_key TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('pending', 'matched', 'completion_orphaned', 'binding_mismatch', 'missing', 'invalid_json')),
  observed_at TEXT,
  completed_at TEXT,
  completion_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_bindings_expected_path ON completion_bindings(expected_path)`,
      `CREATE INDEX IF NOT EXISTS idx_completion_bindings_verdict ON completion_bindings(verdict)`,
      `CREATE INDEX IF NOT EXISTS idx_completion_bindings_attempt ON completion_bindings(attempt_id)`,

      `CREATE TABLE IF NOT EXISTS runtime_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  work_contract_id TEXT,
  attempt_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
      `CREATE INDEX IF NOT EXISTS idx_runtime_events_contract_created ON runtime_events(work_contract_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_runtime_events_attempt_created ON runtime_events(attempt_id, created_at)`,
    ].join(";\n") + ";",
  },
];

const nodeRequire = createRequire(import.meta.url);

function loadNodeSqlite(): SqliteProvider {
  try {
    return nodeRequire("node:sqlite") as SqliteProvider;
  } catch {
    return null;
  }
}

function degradedResult(
  dbPath: string,
  error: string,
  mode: LedgerMode,
): RuntimeLedgerOpenResult {
  const result: RuntimeLedgerOpenResult = {
    status: "degraded",
    db: null,
    dbPath,
    error,
  };
  if (mode === "enforce") {
    result.enforceBlocked = true;
  }
  return result;
}

function runMigrations(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );

  const applied = new Set<number>();
  const rows = db.prepare("SELECT version FROM schema_migrations").all();
  for (const row of rows) {
    applied.add(Number(row.version));
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(migration.version, migration.name);
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  }
}

export function openRuntimeLedger(options?: {
  dbPath?: string;
  mode?: LedgerMode;
  sqlite?: SqliteProvider;
}): RuntimeLedgerOpenResult {
  const mode: LedgerMode = options?.mode ?? "best_effort";
  const dbPath = options?.dbPath ?? resolveRuntimeLedgerDbPath();

  const sqlite: SqliteProvider = options?.sqlite !== undefined
    ? options.sqlite
    : loadNodeSqlite();

  if (!sqlite) {
    return degradedResult(dbPath, "node:sqlite module unavailable", mode);
  }

  try {
    fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch (err) {
    return degradedResult(
      dbPath,
      `failed to create db directory: ${err instanceof Error ? err.message : String(err)}`,
      mode,
    );
  }

  let db: DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(dbPath);
  } catch (err) {
    return degradedResult(
      dbPath,
      `failed to open database: ${err instanceof Error ? err.message : String(err)}`,
      mode,
    );
  }

  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000");

    runMigrations(db);
  } catch (err) {
    try { db.close(); } catch {}
    return degradedResult(
      dbPath,
      `failed to initialize schema: ${err instanceof Error ? err.message : String(err)}`,
      mode,
    );
  }

  return { status: "ok", db, dbPath };
}

export { MIGRATIONS };
export { resolveRuntimeLedgerMode, isShadowActive, mirrorWorkContractToRuntimeLedger } from "./shadow.js";
export { buildRuntimeLedgerShadowDiff } from "./shadow-diff.js";
