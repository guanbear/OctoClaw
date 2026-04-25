import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ContextCoverageSnapshot } from "@octoclaw/contracts/work-contract";
import path from "node:path";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "./builders.js";
import { loadWorkContract, resolveWorkContractLedgerPath, saveWorkContract } from "./store.js";

const mockFs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(),
  existsSync: vi.fn((pathname: string) => mockFs.files.has(pathname) || mockFs.directories.has(pathname)),
  mkdirSync: vi.fn((pathname: string) => {
    mockFs.directories.add(pathname);
  }),
  readFileSync: vi.fn((pathname: string) => {
    const content = mockFs.files.get(pathname);
    if (content === undefined) {
      throw new Error(`missing file: ${pathname}`);
    }
    return content;
  }),
  writeFileSync: vi.fn((pathname: string, data: string) => {
    mockFs.files.set(pathname, data);
  }),
}));

vi.mock("node:fs", () => ({ default: mockFs }));

describe("work contract store", () => {
  let ledgerPath: string;

  beforeEach(() => {
    mockFs.files.clear();
    mockFs.directories.clear();
    mockFs.existsSync.mockClear();
    mockFs.mkdirSync.mockClear();
    mockFs.readFileSync.mockClear();
    mockFs.writeFileSync.mockClear();
    ledgerPath = path.join("/tmp", "octoclaw-work-contract", "nested", "work-contracts.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saveWorkContract + loadWorkContract round-trips", () => {
    const contract = buildContract("session-1", "write tests");

    expect(saveWorkContract(contract, ledgerPath)).toBe(true);

    const loaded = loadWorkContract(contract.workContractId, ledgerPath);
    expect(loaded?.workContractId).toBe(contract.workContractId);
    expect(loaded?.userAsk).toBe("write tests");
    expect(loaded?.updatedAt).toEqual(expect.any(String));
  });

  it("loadWorkContract returns null for missing workContractId", () => {
    const contract = buildContract("session-2", "missing lookup");
    saveWorkContract(contract, ledgerPath);

    expect(loadWorkContract("wc-missing", ledgerPath)).toBeNull();
  });

  it("loadWorkContract returns null when file does not exist", () => {
    expect(loadWorkContract("wc-missing", ledgerPath)).toBeNull();
  });

  it("saveWorkContract creates directory if needed", () => {
    const contract = buildContract("session-3", "create directory");

    expect(saveWorkContract(contract, ledgerPath)).toBe(true);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(path.dirname(ledgerPath), { recursive: true });
    expect(mockFs.files.has(ledgerPath)).toBe(true);
  });

  it("returns false when ledger write fails", () => {
    const contract = buildContract("session-4", "write fails");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error("not writable");
    });

    expect(saveWorkContract(contract, ledgerPath)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("octoclaw work contract ledger write failed"));
  });

  it("respects OCTOCLAW_WORK_CONTRACT_LEDGER_PATH env override", () => {
    const originalEnv = process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH;
    process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH = "/custom/path/contracts.json";

    try {
      expect(resolveWorkContractLedgerPath()).toBe("/custom/path/contracts.json");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH;
      } else {
        process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH = originalEnv;
      }
    }
  });
});

function buildContract(sessionKey: string, userAsk: string) {
  return buildWorkContractFromPolicy(
    sessionKey,
    userAsk,
    "delegated_work",
    coverage,
    buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
  );
}

const coverage: ContextCoverageSnapshot = {
  precheckOrder: [
    "conversation_grounding",
    "continuation_route_reuse",
    "execution_coverage",
    "memory_coverage",
    "build_judge_context_packet",
    "local_judge",
    "validator_or_remote",
    "route_seal_commit",
  ],
  execution: {
    coverage: "current_turn",
  },
  memory: {
    coverage: "none",
  },
  conflict: false,
  authority: "execution_wins",
};
