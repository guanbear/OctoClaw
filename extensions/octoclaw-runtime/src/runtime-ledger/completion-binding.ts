import fsSync from "node:fs";
import path from "node:path";
import { openRuntimeLedger } from "./index.js";
import type { DatabaseSync, SqliteProvider } from "./types.js";

type UnknownRecord = Record<string, unknown>;

export type CompletionBindingVerdict = "pending" | "matched" | "completion_orphaned" | "binding_mismatch" | "missing" | "invalid_json";

export interface CompletionBindingRow {
  completion_id: string;
  work_contract_id: string;
  attempt_id: string;
  expected_path: string;
  expected_work_contract_id: string;
  expected_delegate_task_id: string;
  expected_native_task_id: string | null;
  expected_child_session_key: string | null;
  observed_path: string | null;
  observed_work_contract_id: string | null;
  observed_delegate_task_id: string | null;
  observed_native_task_id: string | null;
  observed_child_session_key: string | null;
  verdict: CompletionBindingVerdict;
  observed_at: string | null;
  completed_at: string | null;
  completion_json: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface CreateCompletionBindingInput {
  workContractId: string;
  attemptId: string;
  expectedDelegateTaskId: string;
  expectedPath: string;
  expectedNativeTaskId?: string;
  expectedChildSessionKey?: string;
  dbPath?: string;
  sqlite?: SqliteProvider;
  now?: Date;
}

export interface CreateCompletionBindingResult {
  ok: boolean;
  completionId: string;
  verdict: CompletionBindingVerdict;
  error?: string;
}

export interface ObserveCompletionBindingInput {
  workContractId: string;
  completionFilePath: string;
  observedCompletion: unknown | null;
  delegateTaskId?: string;
  nativeTaskId?: string;
  childSessionKey?: string;
  dbPath?: string;
  sqlite?: SqliteProvider;
  now?: Date;
}

export interface ObserveCompletionBindingResult {
  verdict: CompletionBindingVerdict;
  description: string;
  completionId: string;
  error?: string;
}

export interface GetCompletionBindingInput {
  completionId?: string;
  workContractId?: string;
  dbPath?: string;
  sqlite?: SqliteProvider;
}

export interface ListCompletionBindingOptions {
  dbPath?: string;
  sqlite?: SqliteProvider;
}

export interface ScanOrphanCompletionsInput {
  completionsDir: string;
  dbPath?: string;
  sqlite?: SqliteProvider;
  now?: Date;
}

export interface ScanOrphanCompletionsResult {
  scanned: number;
  orphaned: number;
  reconciled: number;
  mismatches: number;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function completionIdFor(workContractId: string, attemptId: string): string {
  return `cb:${workContractId}:${attemptId}`;
}

function completionIdForRow(row: Record<string, unknown>): string {
  return completionIdFor(asString(row.work_contract_id), asString(row.attempt_id));
}

function normalizeRow(row: Record<string, unknown> | undefined): CompletionBindingRow | null {
  if (!row) return null;
  return {
    completion_id: asString(row.completion_id),
    work_contract_id: asString(row.work_contract_id),
    attempt_id: asString(row.attempt_id),
    expected_path: asString(row.expected_path),
    expected_work_contract_id: asString(row.expected_work_contract_id),
    expected_delegate_task_id: asString(row.expected_delegate_task_id),
    expected_native_task_id: row.expected_native_task_id == null ? null : asString(row.expected_native_task_id),
    expected_child_session_key: row.expected_child_session_key == null ? null : asString(row.expected_child_session_key),
    observed_path: row.observed_path == null ? null : asString(row.observed_path),
    observed_work_contract_id: row.observed_work_contract_id == null ? null : asString(row.observed_work_contract_id),
    observed_delegate_task_id: row.observed_delegate_task_id == null ? null : asString(row.observed_delegate_task_id),
    observed_native_task_id: row.observed_native_task_id == null ? null : asString(row.observed_native_task_id),
    observed_child_session_key: row.observed_child_session_key == null ? null : asString(row.observed_child_session_key),
    verdict: asString(row.verdict) as CompletionBindingVerdict,
    observed_at: row.observed_at == null ? null : asString(row.observed_at),
    completed_at: row.completed_at == null ? null : asString(row.completed_at),
    completion_json: row.completion_json == null ? null : asString(row.completion_json),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
    revision: Number(row.revision ?? 0),
  };
}

function openDb(opts: { dbPath?: string; sqlite?: SqliteProvider }): { db: DatabaseSync | null; error?: string } {
  const openResult = openRuntimeLedger({ dbPath: opts.dbPath, mode: "best_effort", sqlite: opts.sqlite });
  if (openResult.status !== "ok" || !openResult.db) return { db: null, error: openResult.error ?? "ledger_unavailable" };
  return { db: openResult.db };
}

function observedRecord(input: ObserveCompletionBindingInput): UnknownRecord | null {
  return isRecord(input.observedCompletion) ? input.observedCompletion : null;
}

function field(record: UnknownRecord | null, camel: string, snake: string): string {
  if (!record) return "";
  return asString(record[camel] ?? record[snake]);
}

function observedIds(input: ObserveCompletionBindingInput): {
  workContractId: string;
  delegateTaskId: string;
  nativeTaskId: string;
  childSessionKey: string;
} {
  const record = observedRecord(input);
  return {
    workContractId: field(record, "workContractId", "work_contract_id"),
    delegateTaskId: field(record, "delegateTaskId", "delegate_task_id") || asString(input.delegateTaskId),
    nativeTaskId: field(record, "nativeTaskId", "native_task_id") || asString(input.nativeTaskId),
    childSessionKey: field(record, "childSessionKey", "child_session_key") || asString(input.childSessionKey),
  };
}

function verdictFor(input: ObserveCompletionBindingInput): CompletionBindingVerdict {
  if (input.observedCompletion === null) return "missing";
  const ids = observedIds(input);
  if (!ids.workContractId) return "completion_orphaned";
  if (ids.workContractId !== input.workContractId) return "binding_mismatch";
  return "matched";
}

function descriptionFor(verdict: CompletionBindingVerdict): string {
  switch (verdict) {
    case "matched": return "completion matched expected binding";
    case "completion_orphaned": return "completion did not declare a work contract id";
    case "binding_mismatch": return "completion work contract id did not match expected binding";
    case "missing": return "completion file was missing";
    case "invalid_json": return "completion file contained invalid JSON";
    case "pending": return "completion binding is pending";
  }
}

function upsertObserved(db: DatabaseSync, input: ObserveCompletionBindingInput, verdict: CompletionBindingVerdict, nowIso: string): string | null {
  const existing = db.prepare(
    `SELECT * FROM completion_bindings
     WHERE work_contract_id = ? OR expected_work_contract_id = ? OR expected_path = ?
     ORDER BY CASE WHEN expected_path = ? THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1`,
  ).get(input.workContractId, input.workContractId, input.completionFilePath, input.completionFilePath);
  if (!existing) return null;

  const ids = observedIds(input);
  const completionJson = input.observedCompletion === null ? null : JSON.stringify(input.observedCompletion);
  db.prepare(
    `UPDATE completion_bindings
     SET observed_path = ?, observed_work_contract_id = ?, observed_delegate_task_id = ?,
         observed_native_task_id = ?, observed_child_session_key = ?, verdict = ?,
         observed_at = ?, completed_at = CASE WHEN ? = 'matched' THEN ? ELSE completed_at END,
         completion_json = ?, updated_at = ?, revision = revision + 1
     WHERE completion_id = ?`,
  ).run(
    input.completionFilePath,
    ids.workContractId || null,
    ids.delegateTaskId || null,
    ids.nativeTaskId || null,
    ids.childSessionKey || null,
    verdict,
    nowIso,
    verdict,
    nowIso,
    completionJson,
    nowIso,
    asString(existing.completion_id),
  );
  return asString(existing.completion_id);
}

function readCompletionFile(filePath: string): unknown | null | "invalid_json" {
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const code = isRecord(err) ? asString(err.code) : "";
    return code === "ENOENT" ? null : "invalid_json";
  }
}

function workContractIdFromFilename(filename: string): string {
  return filename.replace(/\.completion\.json$/, "");
}

function insertSyntheticParents(db: DatabaseSync, workContractId: string, attemptId: string, delegateTaskId: string, nowIso: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO work_contracts (
       work_contract_id, route, work_contract_json, status, created_at, updated_at
     ) VALUES (?, 'delegate', '{}', 'sealed', ?, ?)`,
  ).run(workContractId, nowIso, nowIso);
  db.prepare(
    `INSERT OR IGNORE INTO task_attempts (
       attempt_id, work_contract_id, delegate_task_id, attempt_no, attempt_kind,
       status, updated_at, attempt_json
     ) VALUES (?, ?, ?, 1, 'initial', 'observed_orphan', ?, '{}')`,
  ).run(attemptId, workContractId, delegateTaskId, nowIso);
}

function createOrphanBinding(db: DatabaseSync, filePath: string, completion: unknown, nowIso: string): CompletionBindingVerdict {
  const record = isRecord(completion) ? completion : {};
  const filenameWorkContractId = workContractIdFromFilename(filePath.split(/[\\/]/).pop() ?? filePath);
  const observedWorkContractId = asString(record.workContractId ?? record.work_contract_id);
  const workContractId = observedWorkContractId || filenameWorkContractId;
  const delegateTaskId = asString(record.delegateTaskId ?? record.delegate_task_id) || `orphan-delegate:${workContractId}`;
  const attemptId = asString(record.attemptId ?? record.attempt_id) || `orphan-attempt:${workContractId}`;
  const verdict: CompletionBindingVerdict = observedWorkContractId ? "binding_mismatch" : "completion_orphaned";

  insertSyntheticParents(db, workContractId, attemptId, delegateTaskId, nowIso);
  db.prepare(
    `INSERT INTO completion_bindings (
       completion_id, work_contract_id, attempt_id, expected_path,
       expected_work_contract_id, expected_delegate_task_id, expected_native_task_id,
       expected_child_session_key, observed_path, observed_work_contract_id,
       observed_delegate_task_id, observed_native_task_id, observed_child_session_key,
       verdict, observed_at, completion_json, created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(completion_id) DO UPDATE SET
       observed_path = excluded.observed_path,
       observed_work_contract_id = excluded.observed_work_contract_id,
       observed_delegate_task_id = excluded.observed_delegate_task_id,
       observed_native_task_id = excluded.observed_native_task_id,
       observed_child_session_key = excluded.observed_child_session_key,
       verdict = excluded.verdict,
       observed_at = excluded.observed_at,
       completion_json = excluded.completion_json,
       updated_at = excluded.updated_at,
       revision = completion_bindings.revision + 1`,
  ).run(
    completionIdFor(workContractId, attemptId),
    workContractId,
    attemptId,
    filePath,
    filenameWorkContractId,
    delegateTaskId,
    filePath,
    observedWorkContractId || null,
    delegateTaskId || null,
    asString(record.nativeTaskId ?? record.native_task_id) || null,
    asString(record.childSessionKey ?? record.child_session_key) || null,
    verdict,
    nowIso,
    JSON.stringify(completion),
    nowIso,
    nowIso,
  );
  return verdict;
}

export function createCompletionBinding(input: CreateCompletionBindingInput): CreateCompletionBindingResult {
  const completionId = completionIdFor(input.workContractId, input.attemptId);
  const opened = openDb(input);
  if (!opened.db) return { ok: false, completionId, verdict: "pending", error: opened.error };

  const db = opened.db;
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO completion_bindings (
         completion_id, work_contract_id, attempt_id, expected_path,
         expected_work_contract_id, expected_delegate_task_id, expected_native_task_id,
         expected_child_session_key, verdict, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0)
       ON CONFLICT(completion_id) DO UPDATE SET
         expected_path = excluded.expected_path,
         expected_work_contract_id = excluded.expected_work_contract_id,
         expected_delegate_task_id = excluded.expected_delegate_task_id,
         expected_native_task_id = excluded.expected_native_task_id,
         expected_child_session_key = excluded.expected_child_session_key,
         verdict = 'pending',
         updated_at = excluded.updated_at,
         revision = completion_bindings.revision + 1`,
    ).run(
      completionId,
      input.workContractId,
      input.attemptId,
      input.expectedPath,
      input.workContractId,
      input.expectedDelegateTaskId,
      asString(input.expectedNativeTaskId) || null,
      asString(input.expectedChildSessionKey) || null,
      nowIso,
      nowIso,
    );
    db.exec("COMMIT");
    return { ok: true, completionId, verdict: "pending" };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return { ok: false, completionId, verdict: "pending", error: err instanceof Error ? err.message : String(err) };
  } finally {
    db.close();
  }
}

export function observeCompletionBinding(input: ObserveCompletionBindingInput): ObserveCompletionBindingResult {
  const opened = openDb(input);
  const fallbackCompletionId = completionIdFor(input.workContractId, "unknown");
  if (!opened.db) return { verdict: "missing", description: opened.error ?? "ledger_unavailable", completionId: fallbackCompletionId, error: opened.error };

  const db = opened.db;
  const nowIso = (input.now ?? new Date()).toISOString();
  const verdict = verdictFor(input);
  try {
    db.exec("BEGIN IMMEDIATE");
    const completionId = upsertObserved(db, input, verdict, nowIso);
    if (!completionId) {
      db.exec("ROLLBACK");
      return { verdict: "missing", description: "completion binding row was not found", completionId: fallbackCompletionId };
    }
    db.exec("COMMIT");
    return { verdict, description: descriptionFor(verdict), completionId };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return { verdict: "missing", description: err instanceof Error ? err.message : String(err), completionId: fallbackCompletionId, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db.close();
  }
}

export function getCompletionBinding(input: GetCompletionBindingInput): CompletionBindingRow | null {
  const opened = openDb(input);
  if (!opened.db) return null;
  const db = opened.db;
  try {
    const row = input.completionId
      ? db.prepare("SELECT * FROM completion_bindings WHERE completion_id = ?").get(input.completionId)
      : db.prepare("SELECT * FROM completion_bindings WHERE work_contract_id = ? ORDER BY created_at DESC LIMIT 1").get(input.workContractId ?? "");
    return normalizeRow(row);
  } finally {
    db.close();
  }
}

export function listCompletionBindingsByVerdict(verdict: CompletionBindingVerdict, opts: ListCompletionBindingOptions = {}): CompletionBindingRow[] {
  const opened = openDb(opts);
  if (!opened.db) return [];
  const db = opened.db;
  try {
    return db.prepare("SELECT * FROM completion_bindings WHERE verdict = ? ORDER BY updated_at, completion_id")
      .all(verdict)
      .map(row => normalizeRow(row)!)
      .filter(Boolean);
  } finally {
    db.close();
  }
}

export function scanOrphanCompletions(input: ScanOrphanCompletionsInput): ScanOrphanCompletionsResult {
  const result: ScanOrphanCompletionsResult = { scanned: 0, orphaned: 0, reconciled: 0, mismatches: 0 };
  const opened = openDb(input);
  if (!opened.db) return result;
  const db = opened.db;
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    const entries = fsSync.existsSync(input.completionsDir) ? fsSync.readdirSync(input.completionsDir) : [];
    for (const entry of entries) {
      if (!entry.endsWith(".completion.json")) continue;
      result.scanned += 1;
      const filePath = path.join(input.completionsDir, entry);
      const parsed = readCompletionFile(filePath);
      const filenameWorkContractId = workContractIdFromFilename(entry);
      const existing = db.prepare(
        `SELECT * FROM completion_bindings WHERE expected_path = ? OR work_contract_id = ? OR expected_work_contract_id = ? LIMIT 1`,
      ).get(filePath, filenameWorkContractId, filenameWorkContractId);

      db.exec("BEGIN IMMEDIATE");
      try {
        if (!existing) {
          const verdict = parsed === "invalid_json"
            ? createOrphanBinding(db, filePath, {}, nowIso)
            : createOrphanBinding(db, filePath, parsed, nowIso);
          result.orphaned += 1;
          if (verdict === "binding_mismatch") result.mismatches += 1;
        } else if (asString(existing.verdict) === "pending") {
          const verdict = parsed === "invalid_json" ? "invalid_json" : verdictFor({
            workContractId: asString(existing.expected_work_contract_id) || filenameWorkContractId,
            completionFilePath: filePath,
            observedCompletion: parsed,
          });
          if (parsed === "invalid_json") {
            db.prepare(
              `UPDATE completion_bindings
               SET observed_path = ?, verdict = 'invalid_json', observed_at = ?, updated_at = ?, revision = revision + 1
               WHERE completion_id = ?`,
            ).run(filePath, nowIso, nowIso, asString(existing.completion_id));
          } else {
            upsertObserved(db, {
              workContractId: asString(existing.expected_work_contract_id) || filenameWorkContractId,
              completionFilePath: filePath,
              observedCompletion: parsed,
            }, verdict, nowIso);
          }
          result.reconciled += 1;
          if (verdict === "binding_mismatch") result.mismatches += 1;
        }
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    }
    return result;
  } finally {
    db.close();
  }
}

export function listOrphanedCompletionBindings(opts: ListCompletionBindingOptions = {}): CompletionBindingRow[] {
  const opened = openDb(opts);
  if (!opened.db) return [];
  const db = opened.db;
  try {
    return db.prepare(
      `SELECT * FROM completion_bindings
       WHERE verdict IN ('completion_orphaned', 'binding_mismatch')
       ORDER BY updated_at, completion_id`,
    ).all().map(row => normalizeRow(row)!).filter(Boolean);
  } finally {
    db.close();
  }
}

export const completionBindingInternals = {
  completionIdFor,
  completionIdForRow,
};
