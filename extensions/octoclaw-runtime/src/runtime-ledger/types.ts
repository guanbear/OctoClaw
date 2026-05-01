export type LedgerStatus = "ok" | "degraded";

export type LedgerMode = "enforce" | "best_effort";

export interface RuntimeLedgerOpenResult {
  status: LedgerStatus;
  db: DatabaseSync | null;
  dbPath: string;
  error?: string;
  enforceBlocked?: boolean;
}

export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

export interface StatementSync {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  finalize(): void;
}

export interface SqliteModule {
  DatabaseSync: new (location: string, options?: { open?: boolean }) => DatabaseSync;
}

export type SqliteProvider = SqliteModule | null;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}
