import { describe, it, expect, afterEach } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { openRuntimeLedger, MIGRATIONS } from "../index.js";
import { resolveRuntimeLedgerDbPath } from "../../resolve/env.js";
import type { DatabaseSync, SqliteProvider } from "../types.js";

interface TestFs {
  mkdtempSync(prefix: string): string;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  rmSync(p: string, opts: { recursive?: boolean; force?: boolean }): void;
}

interface TestOs {
  tmpdir(): string;
}

const fs = fsSync as unknown as TestFs;
const osModule = os as unknown as TestOs;

const EXPECTED_TABLES = [
  "schema_migrations",
  "work_contracts",
  "delegation_tickets",
  "task_attempts",
  "scheduler_queue",
  "completion_bindings",
  "runtime_events",
] as const;

const FORBIDDEN_TABLES = ["resource_locks", "delivery_outbox", "amendments"] as const;

const REQUIRED_COLUMNS: Record<string, string[]> = {
  schema_migrations: ["version", "name", "applied_at"],
  work_contracts: [
    "work_contract_id", "route", "intent_class", "expected_deliverable",
    "complexity_final", "complexity_reason_codes_json", "delivery_target_json",
    "work_contract_json", "status", "created_at", "updated_at", "completed_at", "revision",
  ],
  delegation_tickets: [
    "ticket_id", "work_contract_id", "turn_id", "session_key", "delivery_target_id",
    "expected_deliverable", "complexity_final", "status", "issued_at", "expires_at",
    "used_at", "revoked_at", "revoke_reason", "ticket_json", "revision",
  ],
  task_attempts: [
    "attempt_id", "work_contract_id", "delegate_task_id", "attempt_no", "attempt_kind",
    "status", "native_flow_id", "native_task_id", "child_session_key", "child_run_id",
    "model_profile", "worker_pool", "started_at", "updated_at", "ended_at",
    "terminal_outcome", "terminal_summary", "error_code", "error_message",
    "attempt_json", "revision",
  ],
  scheduler_queue: [
    "queue_id", "work_contract_id", "attempt_id", "queue_status", "priority",
    "dependency_ids_json", "queued_after", "blocked_by", "blocked_reason",
    "resource_keys_json", "lease_owner", "lease_expires_at", "wakeup_at",
    "wakeup_reason", "created_at", "updated_at", "revision",
  ],
  completion_bindings: [
    "completion_id", "attempt_id", "work_contract_id", "expected_path",
    "expected_work_contract_id", "expected_delegate_task_id", "expected_native_task_id",
    "expected_child_session_key", "observed_path", "observed_work_contract_id",
    "observed_delegate_task_id", "observed_native_task_id", "observed_child_session_key",
    "verdict", "observed_at", "completed_at", "completion_json", "created_at",
    "updated_at", "revision",
  ],
  runtime_events: [
    "event_id", "event_type", "work_contract_id", "attempt_id",
    "payload_json", "created_at",
  ],
};

const EXPECTED_INDEXES = [
  "idx_work_contracts_status",
  "idx_work_contracts_updated_at",
  "idx_delegation_tickets_work_contract",
  "idx_delegation_tickets_status_expires",
  "idx_task_attempts_work_contract",
  "idx_task_attempts_delegate_task",
  "idx_task_attempts_native_task",
  "idx_task_attempts_child_session",
  "idx_task_attempts_status_updated",
  "idx_scheduler_queue_status_priority",
  "idx_scheduler_queue_wakeup",
  "idx_scheduler_queue_attempt",
  "idx_completion_bindings_expected_path",
  "idx_completion_bindings_verdict",
  "idx_completion_bindings_attempt",
  "idx_runtime_events_contract_created",
  "idx_runtime_events_attempt_created",
];

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-ledger-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function getTableNames(db: DatabaseSync): string[] {
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const rows = stmt.all();
  return rows.map((r) => String(r.name));
}

function getIndexNames(db: DatabaseSync): string[] {
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const rows = stmt.all();
  return rows.map((r) => String(r.name));
}

function getColumnNames(db: DatabaseSync, tableName: string): string[] {
  const stmt = db.prepare(`PRAGMA table_info('${tableName}')`);
  const rows = stmt.all();
  return rows.map((r) => String(r.name));
}

describe("resolveRuntimeLedgerDbPath", () => {
  it("returns default path under .octoclaw/runtime", () => {
    const dbPath = resolveRuntimeLedgerDbPath();
    expect(dbPath).toMatch(/\.octoclaw\/runtime\/octoclaw-runtime\.sqlite$/);
  });

  it("respects OCTOCLAW_RUNTIME_DB_PATH env override", () => {
    const original = process.env.OCTOCLAW_RUNTIME_DB_PATH;
    try {
      process.env.OCTOCLAW_RUNTIME_DB_PATH = "/custom/path/my.db";
      expect(resolveRuntimeLedgerDbPath()).toBe("/custom/path/my.db");
    } finally {
      if (original !== undefined) {
        process.env.OCTOCLAW_RUNTIME_DB_PATH = original;
      } else {
        delete process.env.OCTOCLAW_RUNTIME_DB_PATH;
      }
    }
  });
});

describe("openRuntimeLedger", () => {
  it("creates parent directory and opens database", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "nested", "dir", "test.sqlite");

    const result = openRuntimeLedger({ dbPath });

    expect(result.status).toBe("ok");
    expect(result.db).not.toBeNull();
    expect(result.dbPath).toBe(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    result.db!.close();
  });

  it("creates exactly the required table set", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "tables.sqlite");

    const result = openRuntimeLedger({ dbPath });
    expect(result.status).toBe("ok");

    const tables = getTableNames(result.db!);
    result.db!.close();

    for (const t of EXPECTED_TABLES) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
    for (const t of FORBIDDEN_TABLES) {
      expect(tables, `forbidden table present: ${t}`).not.toContain(t);
    }
    expect(tables).toHaveLength(EXPECTED_TABLES.length);
  });

  it("schema_migrations records version 1 exactly once across two opens", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "idempotent.sqlite");

    const r1 = openRuntimeLedger({ dbPath });
    expect(r1.status).toBe("ok");
    const rows1 = r1.db!.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    r1.db!.close();

    expect(rows1).toHaveLength(1);
    expect(Number(rows1[0].version)).toBe(1);
    expect(String(rows1[0].name)).toBe("create_first_slice_tables");

    const r2 = openRuntimeLedger({ dbPath });
    expect(r2.status).toBe("ok");
    const rows2 = r2.db!.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    r2.db!.close();

    expect(rows2).toHaveLength(1);
    expect(Number(rows2[0].version)).toBe(1);
    expect(String(rows2[0].name)).toBe("create_first_slice_tables");
  });

  it("tables and column names remain stable across two opens", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "stable.sqlite");

    const r1 = openRuntimeLedger({ dbPath });
    expect(r1.status).toBe("ok");
    const tables1 = getTableNames(r1.db!);
    r1.db!.close();

    const r2 = openRuntimeLedger({ dbPath });
    expect(r2.status).toBe("ok");
    const tables2 = getTableNames(r2.db!);
    r2.db!.close();

    expect(tables1).toEqual(tables2);
  });

  it("sets WAL, NORMAL, foreign_keys, busy_timeout pragmas", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "pragmas.sqlite");

    const result = openRuntimeLedger({ dbPath });
    expect(result.status).toBe("ok");
    const db = result.db!;

    const journalMode = db.prepare("PRAGMA journal_mode").get();
    expect(String(journalMode!.journal_mode)).toBe("wal");

    const synchronous = db.prepare("PRAGMA synchronous").get();
    expect(Number(synchronous!.synchronous)).toBe(1);

    const fk = db.prepare("PRAGMA foreign_keys").get();
    expect(Number(fk!.foreign_keys)).toBe(1);

    const busyTimeout = db.prepare("PRAGMA busy_timeout").get();
    expect(Number(busyTimeout!.timeout)).toBe(5000);

    db.close();
  });

  it("all required columns exist in each table", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "columns.sqlite");

    const result = openRuntimeLedger({ dbPath });
    expect(result.status).toBe("ok");
    const db = result.db!;

    for (const [table, requiredCols] of Object.entries(REQUIRED_COLUMNS)) {
      const actualCols = getColumnNames(db, table);
      for (const col of requiredCols) {
        expect(actualCols, `${table} missing column: ${col}`).toContain(col);
      }
    }

    db.close();
  });

  it("all expected indexes exist", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "indexes.sqlite");

    const result = openRuntimeLedger({ dbPath });
    expect(result.status).toBe("ok");
    const db = result.db!;

    const indexes = getIndexNames(db);
    db.close();

    for (const idx of EXPECTED_INDEXES) {
      expect(indexes, `missing index: ${idx}`).toContain(idx);
    }
  });

  it("MIGRATIONS list has version 1 as first entry", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    expect(MIGRATIONS[0].version).toBe(1);
    expect(MIGRATIONS[0].name).toBe("create_first_slice_tables");
    expect(MIGRATIONS[0].sql.length).toBeGreaterThan(0);
  });
});

describe("openRuntimeLedger — injectable sqlite unavailable", () => {
  it("returns degraded with enforceBlocked=true in enforce mode when sqlite is null", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "unavailable.sqlite");

    const result = openRuntimeLedger({ dbPath, mode: "enforce", sqlite: null });

    expect(result.status).toBe("degraded");
    expect(result.db).toBeNull();
    expect(result.enforceBlocked).toBe(true);
    expect(result.error).toContain("unavailable");
  });

  it("returns degraded without enforceBlocked in best_effort mode when sqlite is null", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "best-effort.sqlite");

    const result = openRuntimeLedger({ dbPath, mode: "best_effort", sqlite: null });

    expect(result.status).toBe("degraded");
    expect(result.db).toBeNull();
    expect(result.enforceBlocked).toBeUndefined();
  });

  it("returns degraded when injected sqlite throws on construction", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "throw.sqlite");

    const throwingSqlite: SqliteProvider = {
      DatabaseSync: class { constructor() { throw new Error("injected open failure"); } },
    } as unknown as SqliteProvider;

    const result = openRuntimeLedger({ dbPath, mode: "enforce", sqlite: throwingSqlite });

    expect(result.status).toBe("degraded");
    expect(result.db).toBeNull();
    expect(result.enforceBlocked).toBe(true);
    expect(result.error).toContain("injected open failure");
  });
});
