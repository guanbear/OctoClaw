export type LedgerStatus = "ok" | "degraded";

export type LedgerMode = "enforce" | "best_effort";

export type RuntimeLedgerEnvMode = "off" | "shadow" | "enforce";

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

// ── Shadow mirror result ──

export type ShadowMirrorStatus = "off" | "ok" | "degraded";

export interface ShadowMirrorResult {
  status: ShadowMirrorStatus;
  workContractId: string;
  dbPath: string;
  error?: string;
  rowsAffected?: number;
  eventsAppended?: number;
}

// ── Shadow diff result ──

export interface ShadowDiffMissingWorkContract {
  workContractId: string;
  route: string;
  sessionKey: string;
  hasAttemptInfo: boolean;
}

export interface ShadowDiffMissingAttempt {
  attemptId: string;
  workContractId: string;
  delegateTaskId: string;
}

export interface ShadowDiffReport {
  taskStatePath?: string;
  dbPath?: string;
  totalDelegateContracts: number;
  missingWorkContracts: ShadowDiffMissingWorkContract[];
  missingAttempts: ShadowDiffMissingAttempt[];
}
