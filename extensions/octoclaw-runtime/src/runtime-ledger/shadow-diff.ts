import type { DatabaseSync, ShadowDiffReport, ShadowDiffMissingWorkContract, ShadowDiffMissingAttempt, SqliteProvider } from "./types.js";
import { readTaskStateRecords } from "../state/task-state-store.js";
import { resolveTaskStateStorePath } from "../state/task-state-store.js";
import { openRuntimeLedger } from "./index.js";
import { asString, asRecord } from "../util/type-coercion.js";

function collectAttemptIds(record: Record<string, unknown>): Array<{ attemptId: string; delegateTaskId: string; workContractId: string }> {
  const results: Array<{ attemptId: string; delegateTaskId: string; workContractId: string }> = [];
  const workContractId = asString(record.workContractId || record.work_contract_id || record.id);
  if (!workContractId) return results;

  const contract = asRecord(record.workContract || record.work_contract);
  const delegate = asRecord(contract.delegate);

  const candidates = [
    asString(record.attemptId || record.attempt_id || record.currentAttemptId || record.current_attempt_id),
    asString(delegate.currentAttemptId || delegate.current_attempt_id),
    asString(delegate.firstAttemptId || delegate.first_attempt_id),
    asString(delegate.latestAttemptId || delegate.latest_attempt_id),
  ].filter(Boolean);

  const seen = new Set<string>();
  for (const attemptId of candidates) {
    if (seen.has(attemptId)) continue;
    seen.add(attemptId);
    const delegateTaskId = asString(
      delegate.delegateTaskId || delegate.delegate_task_id,
      asString(record.taskId || record.task_id || record.delegateTaskId || record.delegate_task_id),
    );
    results.push({ attemptId, delegateTaskId, workContractId });
  }

  return results;
}

export function buildRuntimeLedgerShadowDiff(options?: {
  taskStatePath?: string;
  dbPath?: string;
  sqlite?: SqliteProvider;
}): ShadowDiffReport {
  const taskStatePath = options?.taskStatePath ?? resolveTaskStateStorePath();
  const records = readTaskStateRecords(taskStatePath);

  const delegateRecords = records.filter((record) => {
    const route = asString(record.route);
    const workContractId = asString(record.workContractId || record.work_contract_id || record.id);
    const contract = asRecord(record.workContract || record.work_contract);
    const contractRoute = asString(contract.route);
    const effectiveRoute = route || contractRoute;
    return effectiveRoute === "delegate" && Boolean(workContractId);
  });

  if (delegateRecords.length === 0) {
    return {
      taskStatePath,
      dbPath: options?.dbPath,
      totalDelegateContracts: 0,
      missingWorkContracts: [],
      missingAttempts: [],
    };
  }

  const ledgerWorkContractIds = new Set<string>();
  const ledgerAttemptIds = new Set<string>();

  let db: DatabaseSync | null = null;
  try {
    const openResult = openRuntimeLedger({
      dbPath: options?.dbPath,
      mode: "best_effort",
      sqlite: options?.sqlite,
    });

    if (openResult.status === "ok" && openResult.db) {
      db = openResult.db;

      const wcRows = db.prepare("SELECT work_contract_id FROM work_contracts").all();
      for (const row of wcRows) {
        ledgerWorkContractIds.add(asString(row.work_contract_id));
      }

      const attemptRows = db.prepare("SELECT attempt_id FROM task_attempts").all();
      for (const row of attemptRows) {
        const id = asString(row.attempt_id);
        if (id) ledgerAttemptIds.add(id);
      }
    }
  } catch {
    // best-effort: if ledger can't be read, everything is "missing"
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }

  const missingWorkContracts: ShadowDiffMissingWorkContract[] = [];
  const missingAttempts: ShadowDiffMissingAttempt[] = [];

  for (const record of delegateRecords) {
    const workContractId = asString(record.workContractId || record.work_contract_id || record.id);
    const contract = asRecord(record.workContract || record.work_contract);
    const route = asString(record.route || contract.route);
    const sessionKey = asString(record.sessionKey || record.session_key || contract.sessionKey);

    if (!ledgerWorkContractIds.has(workContractId)) {
      const attemptIds = collectAttemptIds(record);
      missingWorkContracts.push({
        workContractId,
        route,
        sessionKey,
        hasAttemptInfo: attemptIds.length > 0,
      });
    }

    const attemptInfos = collectAttemptIds(record);
    for (const info of attemptInfos) {
      if (info.attemptId && !ledgerAttemptIds.has(info.attemptId)) {
        missingAttempts.push({
          attemptId: info.attemptId,
          workContractId: info.workContractId,
          delegateTaskId: info.delegateTaskId,
        });
      }
    }
  }

  return {
    taskStatePath,
    dbPath: options?.dbPath,
    totalDelegateContracts: delegateRecords.length,
    missingWorkContracts,
    missingAttempts,
  };
}
