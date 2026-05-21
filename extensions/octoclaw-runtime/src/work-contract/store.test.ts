import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ContextCoverageSnapshot } from "@octoclaw/contracts/work-contract";
import path from "node:path";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "./builders.js";
import {
  listWorkContractsBySession,
  loadWorkContract,
  resolveWorkContractLedgerPath,
  resolveWorkContractTaskStatePath,
  saveWorkContract,
  updateWorkContract,
} from "./store.js";

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
  renameSync: vi.fn((oldPath: string, newPath: string) => {
    const data = mockFs.files.get(oldPath);
    if (data !== undefined) {
      mockFs.files.delete(oldPath);
      mockFs.files.set(newPath, data);
    }
  }),
  unlinkSync: vi.fn((pathname: string) => {
    mockFs.files.delete(pathname);
  }),
}));

vi.mock("node:fs", () => ({ default: mockFs }));

describe("work contract task-state store", () => {
  let legacyLedgerPath: string;
  let taskStatePath: string;
  let originalRuntimeLedger: string | undefined;

  beforeEach(() => {
    originalRuntimeLedger = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
    mockFs.files.clear();
    mockFs.directories.clear();
    mockFs.existsSync.mockClear();
    mockFs.mkdirSync.mockClear();
    mockFs.readFileSync.mockClear();
    mockFs.writeFileSync.mockClear();
    mockFs.renameSync.mockClear();
    mockFs.unlinkSync.mockClear();
    legacyLedgerPath = path.join("/tmp", "octoclaw-work-contract", "nested", "work-contracts.json");
    taskStatePath = path.join("/tmp", "octoclaw-work-contract", "nested", "task-state.json");
  });

  afterEach(() => {
    if (originalRuntimeLedger !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = originalRuntimeLedger;
    else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    vi.restoreAllMocks();
  });

  it("saveWorkContract + loadWorkContract round-trips through task-state.json", () => {
    const contract = buildContract("session-1", "write tests");

    expect(saveWorkContract(contract, legacyLedgerPath)).toBe(true);

    expect(mockFs.files.has(legacyLedgerPath)).toBe(false);
    expect(mockFs.files.has(taskStatePath)).toBe(true);
    const taskState = JSON.parse(mockFs.files.get(taskStatePath) || "{}") as { tasks: Array<Record<string, unknown>> };
    expect(taskState.tasks[0]).toMatchObject({
      id: contract.workContractId,
      workContractId: contract.workContractId,
      route: "delegate",
      intentClass: "delegated_work",
      dispatchExecuted: false,
      spawnExecuted: false,
      resultMaterialized: false,
    });
    expect((taskState.tasks[0].workContract as { userAsk: string }).userAsk).toBe("write tests");

    const loaded = loadWorkContract(contract.workContractId, legacyLedgerPath);
    expect(loaded?.workContractId).toBe(contract.workContractId);
    expect(loaded?.userAsk).toBe("write tests");
    expect(loaded?.updatedAt).toEqual(expect.any(String));
  });

  it("loadWorkContract returns null for missing workContractId", () => {
    const contract = buildContract("session-2", "missing lookup");
    saveWorkContract(contract, legacyLedgerPath);

    expect(loadWorkContract("wc-missing", legacyLedgerPath)).toBeNull();
  });

  it("loadWorkContract returns null when task-state does not exist", () => {
    expect(loadWorkContract("wc-missing", legacyLedgerPath)).toBeNull();
  });

  it("saveWorkContract creates task-state directory if needed", () => {
    const contract = buildContract("session-3", "create directory");

    expect(saveWorkContract(contract, legacyLedgerPath)).toBe(true);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(path.dirname(taskStatePath), { recursive: true });
    expect(mockFs.files.has(taskStatePath)).toBe(true);
  });

  it("returns false when task-state write fails", () => {
    const contract = buildContract("session-4", "write fails");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error("not writable");
    });

    expect(saveWorkContract(contract, legacyLedgerPath)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("octoclaw atomic write failed"));
    warnSpy.mockRestore();
  });

  it("uses atomic write for task-state.json", () => {
    const contract = buildContract("session-5", "atomic verify");
    expect(saveWorkContract(contract, legacyLedgerPath)).toBe(true);

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const writeCall = mockFs.writeFileSync.mock.calls[0];
    expect(writeCall[0]).toMatch(/task-state\.json\.tmp\.\d+\.[a-z0-9]+$/);

    expect(mockFs.renameSync).toHaveBeenCalledTimes(1);
    const renameCall = mockFs.renameSync.mock.calls[0];
    expect(renameCall[1]).toBe(taskStatePath);
    expect(renameCall[0]).toMatch(/task-state\.json\.tmp\.\d+\.[a-z0-9]+$/);
  });

  it("updates and lists WorkContracts from task-state records", () => {
    const contract = buildContract("session-list", "list me");
    saveWorkContract(contract, legacyLedgerPath);

    const updated = updateWorkContract(contract.workContractId, (current) => ({ ...current, status: "running" }), legacyLedgerPath);

    expect(updated?.status).toBe("running");
    expect(loadWorkContract(contract.workContractId, legacyLedgerPath)?.status).toBe("running");
    expect(listWorkContractsBySession("session-list", legacyLedgerPath).map((item) => item.workContractId)).toEqual([contract.workContractId]);
  });

  it("resolves deprecated ledger path and canonical task-state path", () => {
    const originalEnv = process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH;
    process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH = "/custom/path/contracts.json";

    try {
      expect(resolveWorkContractLedgerPath()).toBe("/custom/path/contracts.json");
      expect(resolveWorkContractTaskStatePath("/custom/path/contracts.json")).toBe("/custom/path/task-state.json");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH;
      } else {
        process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH = originalEnv;
      }
    }
  });

  it("with OCTOCLAW_RUNTIME_LEDGER unset, saveWorkContract uses default enforce mode and fails when ledger is unavailable", () => {
    delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    const contract = buildContract("session-default-enforce", "default enforce mode test");
    const result = saveWorkContract(contract, legacyLedgerPath);

    expect(result).toBe(false);
    expect(mockFs.files.has(taskStatePath)).toBe(false);
  });

  it("with OCTOCLAW_RUNTIME_LEDGER=off, saveWorkContract does not create runtime DB", () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
    try {
      const contract = buildContract("session-shadow-off-explicit", "off explicit test");
      const result = saveWorkContract(contract, legacyLedgerPath);

      expect(result).toBe(true);
      const sqliteFiles = [...mockFs.files.keys()].filter((p) => p.endsWith(".sqlite"));
      expect(sqliteFiles).toHaveLength(0);
    } finally {
      if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
      else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    }
  });

  it("saveWorkContract returns true even when shadow mirror degrades (sqlite unavailable)", () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";
    try {
      const contract = buildContract("session-shadow-degraded", "degraded mirror test");

      const result = saveWorkContract(contract, legacyLedgerPath);

      expect(result).toBe(true);
      expect(mockFs.files.has(taskStatePath)).toBe(true);
    } finally {
      if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
      else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    }
  });

  it("updateWorkContract returns updated contract even when shadow mirror degrades", () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";
    try {
      const contract = buildContract("session-update-shadow", "update shadow test");
      saveWorkContract(contract, legacyLedgerPath);

      const updated = updateWorkContract(
        contract.workContractId,
        (current) => ({ ...current, status: "running" }),
        legacyLedgerPath,
      );

      expect(updated?.status).toBe("running");
    } finally {
      if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
      else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    }
  });

  it("in enforce mode, loadWorkContract returns null when ledger is unavailable even if task-state has old WorkContract", () => {
    withRuntimeLedgerEnv("enforce", "/unavailable/runtime.sqlite", () => {
      const contract = buildContract("session-enforce-unavailable-load", "old task-state contract");
      const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
      process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
      try {
        expect(saveWorkContract(contract, legacyLedgerPath)).toBe(true);
      } finally {
        if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
        else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
      }

      expect(loadWorkContract(contract.workContractId, legacyLedgerPath)).toBeNull();
    });
  });

  it("in enforce mode, listWorkContractsBySession returns [] when ledger is unavailable", () => {
    withRuntimeLedgerEnv("enforce", "/unavailable/runtime.sqlite", () => {
      const contract = buildContract("session-enforce-unavailable-list", "old listed task-state contract");
      const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
      process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
      try {
        expect(saveWorkContract(contract, legacyLedgerPath)).toBe(true);
      } finally {
        if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
        else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
      }

      expect(listWorkContractsBySession("session-enforce-unavailable-list", legacyLedgerPath)).toEqual([]);
    });
  });

  it("in enforce mode, load/list use ledger data when task-state is stale", () => {
    withRuntimeLedgerEnv("enforce", uniqueRuntimeLedgerDbPath("stale"), () => {
      const stale = {
        ...buildContract("session-enforce-ledger", "stale task-state contract"),
        updatedAt: "2024-01-01T00:00:00.000Z",
      };
      const newer = {
        ...stale,
        userAsk: "new ledger contract",
        status: "running" as const,
        updatedAt: "2024-01-02T00:00:00.000Z",
      };

      expect(saveWorkContract(newer, legacyLedgerPath)).toBe(true);

      const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
      process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
      try {
        expect(saveWorkContract(stale, legacyLedgerPath)).toBe(true);
      } finally {
        if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
        else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
      }

      expect(loadWorkContract(newer.workContractId, legacyLedgerPath)?.userAsk).toBe("new ledger contract");
      expect(listWorkContractsBySession("session-enforce-ledger", legacyLedgerPath).map((item) => item.userAsk)).toEqual([
        "new ledger contract",
      ]);
    });
  });

  it("in enforce mode, saveWorkContract succeeds and ledger is readable when projection write fails", () => {
    withRuntimeLedgerEnv("enforce", uniqueRuntimeLedgerDbPath("projection"), () => {
      const contract = buildContract("session-enforce-projection-fails", "ledger survives projection failure");
      mockFs.writeFileSync.mockImplementationOnce(() => {
        throw new Error("projection not writable");
      });

      expect(saveWorkContract(contract, legacyLedgerPath)).toBe(true);
      expect(loadWorkContract(contract.workContractId, legacyLedgerPath)?.userAsk).toBe("ledger survives projection failure");
      expect(listWorkContractsBySession("session-enforce-projection-fails", legacyLedgerPath).map((item) => item.workContractId)).toEqual([
        contract.workContractId,
      ]);
    });
  });
});

function uniqueRuntimeLedgerDbPath(label: string): string {
  return `/tmp/octoclaw-runtime-${process.pid}-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`;
}

function withRuntimeLedgerEnv(mode: string, dbPath: string, run: () => void): void {
  const originalMode = process.env.OCTOCLAW_RUNTIME_LEDGER;
  const originalDbPath = process.env.OCTOCLAW_RUNTIME_DB_PATH;
  process.env.OCTOCLAW_RUNTIME_LEDGER = mode;
  process.env.OCTOCLAW_RUNTIME_DB_PATH = dbPath;
  try {
    run();
  } finally {
    if (originalMode !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = originalMode;
    else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    if (originalDbPath !== undefined) process.env.OCTOCLAW_RUNTIME_DB_PATH = originalDbPath;
    else delete process.env.OCTOCLAW_RUNTIME_DB_PATH;
  }
}

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
