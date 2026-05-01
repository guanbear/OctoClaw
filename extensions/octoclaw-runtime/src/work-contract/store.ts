import path from "node:path";
import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { resolveWorkspaceRoot } from "../resolve/env.js";
import {
  listWorkContractsBySessionFromTaskState,
  loadWorkContractFromTaskState,
  resolveTaskStateStorePath,
  saveWorkContractToTaskState,
  updateWorkContractInTaskState,
} from "../state/task-state-store.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import { mirrorWorkContractToRuntimeLedger, resolveRuntimeLedgerMode } from "../runtime-ledger/shadow.js";

export function resolveWorkContractLedgerPath(): string {
  const explicitPath = String(process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH || "").trim();
  if (explicitPath) return explicitPath;
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "work-contracts.json");
}

export function resolveWorkContractTaskStatePath(pathOverride?: string): string {
  return resolveTaskStateStorePath(pathOverride);
}

export function saveWorkContract(contract: WorkContract, taskStatePath?: string): boolean {
  const result = saveWorkContractToTaskState(contract, taskStatePath);
  if (result) {
    try { mirrorWorkContractToRuntimeLedger(contract); } catch { /* best-effort shadow mirror */ }
  }
  return result;
}

export function loadWorkContractFromLedger(workContractId: string): WorkContract | null {
  const targetId = String(workContractId || "").trim();
  if (!targetId) return null;

  const result = openRuntimeLedger({ mode: "best_effort" });
  if (result.status !== "ok" || !result.db) return null;

  try {
    const row = result.db
      .prepare("SELECT work_contract_json FROM work_contracts WHERE work_contract_id = ?")
      .get(targetId);
    const raw = typeof row?.work_contract_json === "string" ? row.work_contract_json : "";
    return raw ? JSON.parse(raw) as WorkContract : null;
  } catch {
    return null;
  } finally {
    result.db.close();
  }
}

export function loadWorkContract(workContractId: string, taskStatePath?: string): WorkContract | null {
  const contract = loadWorkContractFromTaskState(workContractId, taskStatePath);
  if (contract || resolveRuntimeLedgerMode() !== "enforce") return contract;
  return loadWorkContractFromLedger(workContractId);
}

export function updateWorkContract(
  workContractId: string,
  mutator: (contract: WorkContract) => WorkContract,
  taskStatePath?: string,
): WorkContract | null {
  const updated = updateWorkContractInTaskState(workContractId, mutator, taskStatePath);
  if (updated) {
    try { mirrorWorkContractToRuntimeLedger(updated); } catch { /* best-effort shadow mirror */ }
  }
  return updated;
}

export function listWorkContractsBySession(sessionKey: string, taskStatePath?: string): WorkContract[] {
  const contracts = listWorkContractsBySessionFromTaskState(sessionKey, taskStatePath);
  if (contracts.length > 0 || resolveRuntimeLedgerMode() !== "enforce") return contracts;

  const targetSession = String(sessionKey || "").trim();
  if (!targetSession) return [];

  const result = openRuntimeLedger({ mode: "best_effort" });
  if (result.status !== "ok" || !result.db) return [];

  try {
    return result.db
      .prepare("SELECT work_contract_json FROM work_contracts WHERE json_extract(work_contract_json, '$.sessionKey') = ?")
      .all(targetSession)
      .map((row) => typeof row.work_contract_json === "string" ? JSON.parse(row.work_contract_json) as WorkContract : null)
      .filter((contract): contract is WorkContract => Boolean(contract))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  } catch {
    return [];
  } finally {
    result.db.close();
  }
}
