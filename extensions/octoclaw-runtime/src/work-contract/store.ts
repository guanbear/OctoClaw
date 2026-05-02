import path from "node:path";
import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { resolveWorkspaceRoot } from "../resolve/env.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import { mirrorWorkContractToRuntimeLedger, resolveRuntimeLedgerMode } from "../runtime-ledger/shadow.js";
import type { DatabaseSync } from "../runtime-ledger/types.js";
import {
  listWorkContractsBySessionFromTaskState,
  loadWorkContractFromTaskState,
  readTaskStateRecords,
  resolveTaskStateStorePath,
  saveWorkContractToTaskState,
  updateWorkContractInTaskState,
} from "../state/task-state-store.js";

interface WorkContractLedgerRow {
  work_contract_json?: unknown;
  revision?: unknown;
  updated_at?: unknown;
}

export interface WorkContractBackfillResult {
  backfilled: number;
  skipped: number;
  errors: string[];
}

export function resolveWorkContractLedgerPath(): string {
  const explicitPath = String(process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH || "").trim();
  if (explicitPath) return explicitPath;
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "work-contracts.json");
}

export function resolveWorkContractTaskStatePath(pathOverride?: string): string {
  return resolveTaskStateStorePath(pathOverride);
}

function contractRevision(contract: WorkContract): number {
  const revision = (contract as unknown as { revision?: unknown }).revision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : 0;
}

function rowRevision(row: WorkContractLedgerRow | null): number {
  const revision = row?.revision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : Number(revision ?? 0);
}

function upsertWorkContract(db: DatabaseSync, contract: WorkContract): number {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT revision FROM work_contracts WHERE work_contract_id = ?")
    .get(contract.workContractId) as WorkContractLedgerRow | null;
  const nextRevision = existing ? rowRevision(existing) + 1 : contractRevision(contract);

  db.prepare(
    `INSERT INTO work_contracts (
       work_contract_id, route, intent_class, expected_deliverable,
       complexity_final, complexity_reason_codes_json, delivery_target_json,
       work_contract_json, status, created_at, updated_at, completed_at, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_contract_id) DO UPDATE SET
       route = excluded.route,
       intent_class = excluded.intent_class,
       expected_deliverable = excluded.expected_deliverable,
       complexity_final = excluded.complexity_final,
       complexity_reason_codes_json = excluded.complexity_reason_codes_json,
       delivery_target_json = excluded.delivery_target_json,
       work_contract_json = excluded.work_contract_json,
       status = excluded.status,
       updated_at = excluded.updated_at,
       completed_at = excluded.completed_at,
       revision = excluded.revision`,
  ).run(
    contract.workContractId,
    contract.route,
    contract.intentClass ?? null,
    contract.mainContext?.summary?.slice(0, 200) ?? null,
    null,
    JSON.stringify(contract.decision?.reasonCodes ?? []),
    JSON.stringify({
      sessionKey: contract.sessionKey,
      turnId: contract.turnId,
    }),
    JSON.stringify(contract),
    contract.status,
    contract.createdAt ?? now,
    contract.updatedAt ?? now,
    ["completed", "failed", "cancelled"].includes(contract.status) ? now : null,
    nextRevision,
  );

  return 1;
}

function loadLedgerRow(db: DatabaseSync, workContractId: string): WorkContractLedgerRow | null {
  return db
    .prepare("SELECT work_contract_json, revision, updated_at FROM work_contracts WHERE work_contract_id = ?")
    .get(workContractId) as WorkContractLedgerRow | null;
}

function rowToWorkContract(row: WorkContractLedgerRow | null): WorkContract | null {
  const raw = typeof row?.work_contract_json === "string" ? row.work_contract_json : "";
  return raw ? JSON.parse(raw) as WorkContract : null;
}

function shouldBackfillContract(existing: WorkContractLedgerRow | null, contract: WorkContract): boolean {
  if (!existing) return true;
  const existingRevision = rowRevision(existing);
  const incomingRevision = contractRevision(contract);
  if (existingRevision < incomingRevision) return true;
  if (existingRevision > incomingRevision) return false;
  const existingUpdatedAt = Date.parse(String(existing.updated_at ?? ""));
  const incomingUpdatedAt = Date.parse(contract.updatedAt ?? "");
  if (!Number.isFinite(incomingUpdatedAt)) return false;
  if (!Number.isFinite(existingUpdatedAt)) return true;
  return incomingUpdatedAt > existingUpdatedAt;
}

export function saveWorkContract(contract: WorkContract, taskStatePath?: string): boolean {
  if (resolveRuntimeLedgerMode() === "enforce") {
    const result = openRuntimeLedger({ mode: "best_effort" });
    if (result.status !== "ok" || !result.db) return false;

    try {
      result.db.exec("BEGIN");
      upsertWorkContract(result.db, contract);
      result.db.exec("COMMIT");
    } catch {
      try { result.db.exec("ROLLBACK"); } catch {}
      return false;
    } finally {
      result.db.close();
    }

    try { saveWorkContractToTaskState(contract, taskStatePath); } catch {}
    return true;
  }

  const result = saveWorkContractToTaskState(contract, taskStatePath);
  if (result) {
    try { mirrorWorkContractToRuntimeLedger(contract); } catch {}
  }
  return result;
}

export function loadWorkContractFromLedger(workContractId: string): WorkContract | null {
  const targetId = String(workContractId || "").trim();
  if (!targetId) return null;

  const result = openRuntimeLedger({ mode: "best_effort" });
  if (result.status !== "ok" || !result.db) return null;

  try {
    return rowToWorkContract(loadLedgerRow(result.db, targetId));
  } catch {
    return null;
  } finally {
    result.db.close();
  }
}

export function loadWorkContract(workContractId: string, taskStatePath?: string): WorkContract | null {
  if (resolveRuntimeLedgerMode() === "enforce") {
    const targetId = String(workContractId || "").trim();
    if (!targetId) return null;

    const result = openRuntimeLedger({ mode: "best_effort" });
    if (result.status !== "ok" || !result.db) return null;

    try {
      return rowToWorkContract(loadLedgerRow(result.db, targetId));
    } catch {
      return null;
    } finally {
      result.db.close();
    }
  }

  return loadWorkContractFromTaskState(workContractId, taskStatePath);
}

export function updateWorkContract(
  workContractId: string,
  mutator: (contract: WorkContract) => WorkContract,
  taskStatePath?: string,
): WorkContract | null {
  if (resolveRuntimeLedgerMode() === "enforce") {
    const targetId = String(workContractId || "").trim();
    if (!targetId) return null;

    const result = openRuntimeLedger({ mode: "best_effort" });
    if (result.status !== "ok" || !result.db) return null;

    let updated: WorkContract | null = null;
    try {
      result.db.exec("BEGIN");
      const contract = rowToWorkContract(loadLedgerRow(result.db, targetId));
      if (!contract) {
        result.db.exec("ROLLBACK");
        return null;
      }
      updated = mutator(contract);
      upsertWorkContract(result.db, updated);
      result.db.exec("COMMIT");
    } catch {
      try { result.db.exec("ROLLBACK"); } catch {}
      return null;
    } finally {
      result.db.close();
    }

    try { saveWorkContractToTaskState(updated, taskStatePath); } catch {}
    return updated;
  }

  const updated = updateWorkContractInTaskState(workContractId, mutator, taskStatePath);
  if (updated) {
    try { mirrorWorkContractToRuntimeLedger(updated); } catch {}
  }
  return updated;
}

export function listWorkContractsBySession(sessionKey: string, taskStatePath?: string): WorkContract[] {
  if (resolveRuntimeLedgerMode() === "enforce") {
    const targetSession = String(sessionKey || "").trim();
    if (!targetSession) return [];

    const result = openRuntimeLedger({ mode: "best_effort" });
    if (result.status !== "ok" || !result.db) return [];

    try {
      return result.db
        .prepare("SELECT work_contract_json FROM work_contracts WHERE json_extract(work_contract_json, '$.sessionKey') = ?")
        .all(targetSession)
        .map((row) => rowToWorkContract(row as WorkContractLedgerRow))
        .filter((contract): contract is WorkContract => Boolean(contract))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    } catch {
      return [];
    } finally {
      result.db.close();
    }
  }

  return listWorkContractsBySessionFromTaskState(sessionKey, taskStatePath);
}

function workContractChildSessionCandidates(contract: WorkContract): string[] {
  const delegate = contract.delegate;
  return Array.from(new Set([
    contract.nativeSpawnRefs?.childSessionKey,
    contract.continuity?.preferredChildSessionKey,
    contract.telemetry?.childSessionKey,
    contract.mainContext?.visibleIds?.childSessionKey,
    delegate?.nativeBinding?.childSessionKey,
    ...(Array.isArray(delegate?.childSessions) ? delegate.childSessions.map((child) => child.childSessionKey) : []),
  ].map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function contractMatchesChildSession(contract: WorkContract, childSessionKey: string): boolean {
  const target = String(childSessionKey || "").trim();
  return Boolean(target) && workContractChildSessionCandidates(contract).includes(target);
}

function sortWorkContractsByUpdatedAt(contracts: WorkContract[]): WorkContract[] {
  return contracts
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function listWorkContractsFromTaskState(taskStatePath?: string): WorkContract[] {
  return readTaskStateRecords(taskStatePath)
    .map((record) => {
      const candidate = record.workContract ?? record.work_contract;
      return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as WorkContract : null;
    })
    .filter((contract): contract is WorkContract => Boolean(contract?.workContractId));
}

export function findWorkContractByNativeChildSessionKey(childSessionKey: string, taskStatePath?: string): WorkContract | null {
  const target = String(childSessionKey || "").trim();
  if (!target) return null;

  if (resolveRuntimeLedgerMode() === "enforce") {
    const result = openRuntimeLedger({ mode: "best_effort" });
    if (result.status === "ok" && result.db) {
      try {
        const rows = result.db
          .prepare(`
            SELECT work_contract_json, revision, updated_at
            FROM work_contracts
            WHERE json_extract(work_contract_json, '$.nativeSpawnRefs.childSessionKey') = ?
               OR json_extract(work_contract_json, '$.continuity.preferredChildSessionKey') = ?
               OR json_extract(work_contract_json, '$.telemetry.childSessionKey') = ?
               OR json_extract(work_contract_json, '$.mainContext.visibleIds.childSessionKey') = ?
               OR json_extract(work_contract_json, '$.delegate.nativeBinding.childSessionKey') = ?
          `)
          .all(target, target, target, target, target)
          .map((row) => rowToWorkContract(row as WorkContractLedgerRow))
          .filter((contract): contract is WorkContract => Boolean(contract));
        const match = sortWorkContractsByUpdatedAt(rows).find((contract) => contractMatchesChildSession(contract, target));
        if (match) return match;
      } catch {
        // Fall back to task-state below. confirmNativeSpawn mirrors ledger refs
        // there best-effort so native announce delivery can still fail soft.
      } finally {
        result.db.close();
      }
    }
  }

  return sortWorkContractsByUpdatedAt(listWorkContractsFromTaskState(taskStatePath))
    .find((contract) => contractMatchesChildSession(contract, target)) ?? null;
}

export function backfillWorkContractsFromTaskState(taskStatePath?: string): WorkContractBackfillResult {
  const result: WorkContractBackfillResult = { backfilled: 0, skipped: 0, errors: [] };
  const contracts = readTaskStateRecords(taskStatePath)
    .map((record) => {
      const candidate = record.workContract ?? record.work_contract;
      return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as WorkContract : null;
    })
    .filter((contract): contract is WorkContract => Boolean(contract?.workContractId));

  const ledger = openRuntimeLedger({ mode: "best_effort" });
  if (ledger.status !== "ok" || !ledger.db) {
    return { ...result, errors: [ledger.error ?? "ledger_unavailable"] };
  }

  try {
    for (const contract of contracts) {
      try {
        const existing = loadLedgerRow(ledger.db, contract.workContractId);
        if (!shouldBackfillContract(existing, contract)) {
          result.skipped++;
          continue;
        }

        ledger.db.exec("BEGIN");
        upsertWorkContract(ledger.db, contract);
        ledger.db.exec("COMMIT");
        result.backfilled++;
      } catch (error) {
        try { ledger.db.exec("ROLLBACK"); } catch {}
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    ledger.db.close();
  }

  return result;
}
