import fsSync from "node:fs";
import path from "node:path";
import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { resolveWorkspaceRoot } from "../resolve/env.js";

interface WorkContractLedger {
  schema_version: "octoclaw.work_contract_ledger.v1";
  updated_at: string;
  contracts: Record<string, WorkContract>;
}

interface FsSyncLike {
  existsSync(pathname: string): boolean;
  mkdirSync(pathname: string, options?: { recursive?: boolean }): void;
  readFileSync(pathname: string, encoding: string): string;
  writeFileSync(pathname: string, data: string, encoding: string): void;
}

const fs = fsSync as unknown as FsSyncLike;

function emptyLedger(): WorkContractLedger {
  return {
    schema_version: "octoclaw.work_contract_ledger.v1",
    updated_at: new Date().toISOString(),
    contracts: {},
  };
}

export function resolveWorkContractLedgerPath(): string {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "work-contracts.json");
}

export function saveWorkContract(contract: WorkContract, ledgerPath?: string): void {
  const targetPath = ledgerPath || resolveWorkContractLedgerPath();
  const directory = path.dirname(targetPath);

  let ledger: WorkContractLedger;
  if (fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<WorkContractLedger>;
      ledger = parsed.schema_version && parsed.contracts ? parsed as WorkContractLedger : emptyLedger();
    } catch {
      ledger = emptyLedger();
    }
  } else {
    ledger = emptyLedger();
  }

  ledger.contracts[contract.workContractId] = { ...contract, updatedAt: new Date().toISOString() };
  ledger.updated_at = new Date().toISOString();

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(targetPath, JSON.stringify(ledger, null, 2), "utf-8");
}

export function loadWorkContract(workContractId: string, ledgerPath?: string): WorkContract | null {
  const targetPath = ledgerPath || resolveWorkContractLedgerPath();
  if (!fs.existsSync(targetPath)) return null;

  try {
    const raw = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(raw) as { contracts?: Record<string, WorkContract> };
    if (!parsed.contracts || typeof parsed.contracts !== "object") return null;
    return parsed.contracts[workContractId] || null;
  } catch {
    return null;
  }
}

export function listWorkContractsBySession(sessionKey: string, ledgerPath?: string): WorkContract[] {
  const targetPath = ledgerPath || resolveWorkContractLedgerPath();
  if (!fs.existsSync(targetPath)) return [];
  try {
    const raw = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(raw) as { contracts?: Record<string, WorkContract> };
    if (!parsed.contracts || typeof parsed.contracts !== "object") return [];
    return Object.values(parsed.contracts)
      .filter((c) => c.sessionKey === sessionKey)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch {
    return [];
  }
}
