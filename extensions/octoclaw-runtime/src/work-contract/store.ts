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

export function resolveWorkContractLedgerPath(): string {
  const explicitPath = String(process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH || "").trim();
  if (explicitPath) return explicitPath;
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "work-contracts.json");
}

export function resolveWorkContractTaskStatePath(pathOverride?: string): string {
  return resolveTaskStateStorePath(pathOverride);
}

export function saveWorkContract(contract: WorkContract, taskStatePath?: string): boolean {
  return saveWorkContractToTaskState(contract, taskStatePath);
}

export function loadWorkContract(workContractId: string, taskStatePath?: string): WorkContract | null {
  return loadWorkContractFromTaskState(workContractId, taskStatePath);
}

export function updateWorkContract(
  workContractId: string,
  mutator: (contract: WorkContract) => WorkContract,
  taskStatePath?: string,
): WorkContract | null {
  return updateWorkContractInTaskState(workContractId, mutator, taskStatePath);
}

export function listWorkContractsBySession(sessionKey: string, taskStatePath?: string): WorkContract[] {
  return listWorkContractsBySessionFromTaskState(sessionKey, taskStatePath);
}
