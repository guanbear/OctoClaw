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
  accessSync(pathname: string, mode?: number): void;
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
  const explicitPath = String(process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH || "").trim();
  if (explicitPath) {
    return explicitPath;
  }

  const workspacePath = path.join(resolveWorkspaceRoot(), "tmp", "octopus", "work-contracts.json");
  const workspaceDir = path.dirname(workspacePath);
  try {
    if (fs.existsSync(workspaceDir) || isDirCreatable(workspaceDir)) {
      return workspacePath;
    }
  } catch {
    // Fall through to cwd fallback.
  }

  return path.join(process.cwd(), "tmp", "octopus", "work-contracts.json");
}

function isDirCreatable(dirPath: string): boolean {
  try {
    const parent = path.dirname(dirPath);
    if (!fs.existsSync(parent)) return false;
    fs.accessSync(parent, (fsSync.constants as { W_OK?: number } | undefined)?.W_OK ?? 2);
    return true;
  } catch {
    return false;
  }
}

export function saveWorkContract(contract: WorkContract, ledgerPath?: string): boolean {
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

  try {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(targetPath, JSON.stringify(ledger, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.warn?.(`octoclaw work contract ledger write failed: ${String(err)}`);
    return false;
  }
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
