import { openRuntimeLedger } from "./index.js";
import type { DatabaseSync, SqliteProvider } from "./types.js";
import { asString } from "../util/type-coercion.js";

export interface NativeLifecycleState {
  flowExists: boolean;
  flowStatus: string | null;
  taskExists: boolean;
  taskStatus: string | null;
  childSessionKey: string | null;
  childRunId: string | null;
  terminalOutcome: string | null;
  terminalSummary: string | null;
}

export interface ReconcileAttemptInput {
  attemptId: string;
  workContractId: string;
  nativeFlowId: string | null;
  nativeTaskId: string | null;
  nativeState?: NativeLifecycleState | null;
  dbPath?: string;
  sqlite?: SqliteProvider;
}

export interface ReconcileAttemptResult {
  reconciled: boolean;
  spawnConfirmed: boolean;
  previousStatus: string;
  newStatus: string | null;
  terminalOutcome: string | null;
  error?: string;
}

export interface ReconcileAllInput {
  dbPath?: string;
  sqlite?: SqliteProvider;
  queryNativeState?: (attempt: { nativeFlowId: string | null; nativeTaskId: string | null }) => NativeLifecycleState | null;
}

export interface ReconcileAllResult {
  totalAttempts: number;
  reconciled: number;
  spawnConfirmed: number;
  terminalUpdated: number;
  errors: string[];
}

interface AttemptRow {
  attempt_id: string;
  work_contract_id: string;
  status: string;
  native_flow_id: string | null;
  native_task_id: string | null;
  child_session_key: string | null;
  child_run_id: string | null;
  terminal_outcome: string | null;
}

const TERMINAL_STATUSES = new Set(["completed", "canceled", "cancelled", "failed", "timeout_no_result"]);

function nullableString(value: unknown): string | null {
  const text = asString(value);
  return text || null;
}

function openDb(opts: { dbPath?: string; sqlite?: SqliteProvider }): { db: DatabaseSync | null; error?: string } {
  const openResult = openRuntimeLedger({ dbPath: opts.dbPath, mode: "best_effort", sqlite: opts.sqlite });
  if (openResult.status !== "ok" || !openResult.db) return { db: null, error: openResult.error ?? "ledger_unavailable" };
  return { db: openResult.db };
}

function normalizeAttempt(row: Record<string, unknown> | undefined): AttemptRow | null {
  if (!row) return null;
  return {
    attempt_id: asString(row.attempt_id),
    work_contract_id: asString(row.work_contract_id),
    status: asString(row.status),
    native_flow_id: nullableString(row.native_flow_id),
    native_task_id: nullableString(row.native_task_id),
    child_session_key: nullableString(row.child_session_key),
    child_run_id: nullableString(row.child_run_id),
    terminal_outcome: nullableString(row.terminal_outcome),
  };
}

function appendRuntimeEvent(
  db: DatabaseSync,
  eventType: string,
  workContractId: string,
  attemptId: string,
  payload: Record<string, unknown>,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO runtime_events (event_type, work_contract_id, attempt_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventType, workContractId, attemptId, JSON.stringify(payload), nowIso);
}

function hasNativeEvidence(state: NativeLifecycleState): boolean {
  return state.flowExists && (state.taskExists || Boolean(nullableString(state.childSessionKey)));
}

function hasMissingNativeBinding(input: ReconcileAttemptInput, state: NativeLifecycleState): boolean {
  const expectsFlow = Boolean(nullableString(input.nativeFlowId));
  const expectsTask = Boolean(nullableString(input.nativeTaskId));
  return (expectsFlow && !state.flowExists) || (expectsTask && !state.taskExists);
}

function isTerminalStatus(status: string | null): boolean {
  return TERMINAL_STATUSES.has(asString(status));
}

function statusForTerminalOutcome(outcome: string): string {
  if (outcome === "cancelled") return "canceled";
  if (isTerminalStatus(outcome)) return outcome;
  return "failed";
}

function deriveNewStatus(row: AttemptRow, input: ReconcileAttemptInput, state: NativeLifecycleState): string | null {
  const outcome = nullableString(state.terminalOutcome);
  if (outcome && !isTerminalStatus(row.status)) return statusForTerminalOutcome(outcome);
  if (outcome && row.status !== statusForTerminalOutcome(outcome) && !isTerminalStatus(row.status)) return statusForTerminalOutcome(outcome);
  if (hasMissingNativeBinding(input, state)) return "binding_mismatch";
  if (!hasNativeEvidence(state)) return "dispatch_materialized_but_no_spawn_evidence";
  return null;
}

export function reconcileAttempt(input: ReconcileAttemptInput): ReconcileAttemptResult {
  const opened = openDb(input);
  if (!opened.db) {
    return { reconciled: false, spawnConfirmed: false, previousStatus: "", newStatus: null, terminalOutcome: null, error: opened.error };
  }

  const db = opened.db;
  const nowIso = new Date().toISOString();
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = normalizeAttempt(db.prepare(
      `SELECT attempt_id, work_contract_id, status, native_flow_id, native_task_id,
              child_session_key, child_run_id, terminal_outcome
       FROM task_attempts
       WHERE attempt_id = ? AND work_contract_id = ?`,
    ).get(input.attemptId, input.workContractId));

    if (!row) {
      db.exec("ROLLBACK");
      return { reconciled: false, spawnConfirmed: false, previousStatus: "", newStatus: null, terminalOutcome: null, error: "attempt_not_found" };
    }

    if (!input.nativeState) {
      db.exec("ROLLBACK");
      return { reconciled: false, spawnConfirmed: false, previousStatus: row.status, newStatus: null, terminalOutcome: row.terminal_outcome };
    }

    const state = input.nativeState;
    const spawnConfirmed = hasNativeEvidence(state);
    const terminalOutcome = nullableString(state.terminalOutcome);
    const terminalSummary = nullableString(state.terminalSummary);
    const newStatus = deriveNewStatus(row, input, state);
    const childSessionKey = nullableString(state.childSessionKey) ?? row.child_session_key;
    const childRunId = nullableString(state.childRunId) ?? row.child_run_id;

    db.prepare(
      `UPDATE task_attempts
       SET status = COALESCE(?, status),
           child_session_key = COALESCE(?, child_session_key),
           child_run_id = COALESCE(?, child_run_id),
           terminal_outcome = COALESCE(?, terminal_outcome),
           terminal_summary = COALESCE(?, terminal_summary),
           ended_at = CASE WHEN ? IS NOT NULL AND ended_at IS NULL THEN ? ELSE ended_at END,
           updated_at = ?,
           revision = revision + 1
       WHERE attempt_id = ? AND work_contract_id = ?`,
    ).run(
      newStatus,
      childSessionKey,
      childRunId,
      terminalOutcome,
      terminalSummary,
      terminalOutcome,
      nowIso,
      nowIso,
      input.attemptId,
      input.workContractId,
    );

    appendRuntimeEvent(db, "native_lifecycle_reconciled", input.workContractId, input.attemptId, {
      nativeFlowId: input.nativeFlowId,
      nativeTaskId: input.nativeTaskId,
      flowExists: state.flowExists,
      taskExists: state.taskExists,
      spawnConfirmed,
      previousStatus: row.status,
      newStatus,
      terminalOutcome,
    }, nowIso);

    db.exec("COMMIT");
    return { reconciled: true, spawnConfirmed, previousStatus: row.status, newStatus, terminalOutcome };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    return {
      reconciled: false,
      spawnConfirmed: false,
      previousStatus: "",
      newStatus: null,
      terminalOutcome: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db.close();
  }
}

export function reconcileAllNonTerminal(input: ReconcileAllInput = {}): ReconcileAllResult {
  const result: ReconcileAllResult = { totalAttempts: 0, reconciled: 0, spawnConfirmed: 0, terminalUpdated: 0, errors: [] };
  const opened = openDb(input);
  if (!opened.db) {
    result.errors.push(opened.error ?? "ledger_unavailable");
    return result;
  }

  const db = opened.db;
  try {
    const rows = db.prepare(
      `SELECT attempt_id, work_contract_id, status, native_flow_id, native_task_id,
              child_session_key, child_run_id, terminal_outcome
       FROM task_attempts
       WHERE status NOT IN ('completed', 'canceled', 'failed', 'timeout_no_result')
       ORDER BY updated_at, attempt_id`,
    ).all().map(row => normalizeAttempt(row)!).filter(Boolean);

    result.totalAttempts = rows.length;
    for (const row of rows) {
      if (!row.native_flow_id && !row.native_task_id) continue;
      let nativeState: NativeLifecycleState | null = null;
      try {
        nativeState = input.queryNativeState?.({ nativeFlowId: row.native_flow_id, nativeTaskId: row.native_task_id }) ?? null;
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
        continue;
      }

      const attemptResult = reconcileAttempt({
        attemptId: row.attempt_id,
        workContractId: row.work_contract_id,
        nativeFlowId: row.native_flow_id,
        nativeTaskId: row.native_task_id,
        nativeState,
        dbPath: input.dbPath,
        sqlite: input.sqlite,
      });

      if (attemptResult.error) result.errors.push(attemptResult.error);
      if (!attemptResult.reconciled) continue;
      result.reconciled += 1;
      if (attemptResult.spawnConfirmed) result.spawnConfirmed += 1;
      if (attemptResult.terminalOutcome !== null) result.terminalUpdated += 1;
    }
    return result;
  } finally {
    db.close();
  }
}
