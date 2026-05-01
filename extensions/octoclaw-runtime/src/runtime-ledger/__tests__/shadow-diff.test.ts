import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ContextCoverageSnapshot, DelegateContract, WorkContract } from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../../work-contract/builders.js";
import { mirrorWorkContractToRuntimeLedger } from "../shadow.js";
import { buildRuntimeLedgerShadowDiff } from "../shadow-diff.js";
import { atomicWriteJsonSync } from "../../util/atomic-write.js";

interface TestFs {
  mkdtempSync(prefix: string): string;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  rmSync(p: string, opts: { recursive?: boolean; force?: boolean }): void;
}

interface TestOs {
  tmpdir(): string;
}

const fs = fsSync as unknown as TestFs;
const osModule = os as unknown as TestOs;

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-shadow-diff-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const coverage: ContextCoverageSnapshot = {
  precheckOrder: [
    "conversation_grounding", "continuation_route_reuse", "execution_coverage",
    "memory_coverage", "build_judge_context_packet", "local_judge",
    "validator_or_remote", "route_seal_commit",
  ],
  execution: { coverage: "current_turn" },
  memory: { coverage: "none" },
  conflict: false,
  authority: "execution_wins",
};

function buildDelegateContract(
  sessionKey: string,
  userAsk: string,
  delegateOverrides?: Partial<DelegateContract>,
): WorkContract {
  const base = buildWorkContractFromPolicy(
    sessionKey,
    userAsk,
    "delegated_work",
    coverage,
    buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
  );
  if (!delegateOverrides) return base;
  return {
    ...base,
    delegate: {
      delegateTaskId: delegateOverrides.delegateTaskId ?? "delegate-task-1",
      currentAttemptId: delegateOverrides.currentAttemptId ?? null,
      role: delegateOverrides.role ?? "default",
      coordinationMode: "solo_worker",
      acceptanceCriteria: [],
      scope: { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "" },
      modelProfile: "",
      nativeBinding: null,
      childSessions: [],
      artifactRefs: [],
      nextAction: "dispatch",
      ...delegateOverrides,
    },
  };
}

function writeTaskState(taskStatePath: string, contracts: WorkContract[]): void {
  const tasks = contracts.map((contract) => ({
    id: contract.workContractId,
    workContractId: contract.workContractId,
    route: contract.route,
    sessionKey: contract.sessionKey,
    status: contract.status,
    workContract: contract,
    workContractStatus: contract.status,
    updated_at: contract.updatedAt,
    created_at: contract.createdAt,
  }));
  atomicWriteJsonSync(taskStatePath, {
    schemaVersion: "octoclaw.task_state.v1",
    updated_at: new Date().toISOString(),
    tasks,
  });
}

describe("buildRuntimeLedgerShadowDiff", () => {
  let dir: string;
  let taskStatePath: string;
  let dbPath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    taskStatePath = path.join(dir, "task-state.json");
    dbPath = path.join(dir, "shadow-diff.sqlite");
  });

  it("reports empty diff when no delegate contracts in task-state", () => {
    writeTaskState(taskStatePath, []);

    const report = buildRuntimeLedgerShadowDiff({
      taskStatePath,
      dbPath,
    });

    expect(report.totalDelegateContracts).toBe(0);
    expect(report.missingWorkContracts).toHaveLength(0);
    expect(report.missingAttempts).toHaveLength(0);
  });

  it("reports missing work contracts when task-state has delegate but ledger does not", () => {
    const contract = buildDelegateContract("session-diff-1", "diff test 1", {
      delegateTaskId: "delegate-diff-1",
    });
    writeTaskState(taskStatePath, [contract]);

    const report = buildRuntimeLedgerShadowDiff({
      taskStatePath,
      dbPath,
    });

    expect(report.totalDelegateContracts).toBe(1);
    expect(report.missingWorkContracts).toHaveLength(1);
    expect(report.missingWorkContracts[0].workContractId).toBe(contract.workContractId);
    expect(report.missingWorkContracts[0].route).toBe("delegate");
  });

  it("reports no missing work contracts after mirrored delegate contract", () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";
    try {
      const contract = buildDelegateContract("session-diff-2", "diff test 2", {
        delegateTaskId: "delegate-diff-2",
        currentAttemptId: "attempt-diff-2",
      });
      writeTaskState(taskStatePath, [contract]);

      mirrorWorkContractToRuntimeLedger(contract, { dbPath });

      const report = buildRuntimeLedgerShadowDiff({
        taskStatePath,
        dbPath,
      });

      expect(report.totalDelegateContracts).toBe(1);
      expect(report.missingWorkContracts).toHaveLength(0);
      expect(report.missingAttempts).toHaveLength(0);
    } finally {
      if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
      else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    }
  });

  it("reports missing attempt when task-state has attempt info not in ledger", () => {
    const contract = buildDelegateContract("session-diff-3", "diff test 3", {
      delegateTaskId: "delegate-diff-3",
      currentAttemptId: "attempt-diff-3",
    });
    writeTaskState(taskStatePath, [contract]);

    const report = buildRuntimeLedgerShadowDiff({
      taskStatePath,
      dbPath,
    });

    expect(report.totalDelegateContracts).toBe(1);
    expect(report.missingWorkContracts).toHaveLength(1);
  });

  it("handles multiple contracts with some mirrored and some missing", () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";
    try {
      const contract1 = buildDelegateContract("session-diff-4a", "mirrored", {
        delegateTaskId: "delegate-4a",
      });
      const contract2 = buildDelegateContract("session-diff-4b", "not mirrored", {
        delegateTaskId: "delegate-4b",
      });

      mirrorWorkContractToRuntimeLedger(contract1, { dbPath });
      writeTaskState(taskStatePath, [contract1, contract2]);

      const report = buildRuntimeLedgerShadowDiff({
        taskStatePath,
        dbPath,
      });

      expect(report.totalDelegateContracts).toBe(2);
      expect(report.missingWorkContracts).toHaveLength(1);
      expect(report.missingWorkContracts[0].workContractId).toBe(contract2.workContractId);
    } finally {
      if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
      else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    }
  });

  it("returns empty missing when sqlite is unavailable (best-effort)", () => {
    const contract = buildDelegateContract("session-diff-5", "unavailable sqlite", {
      delegateTaskId: "delegate-5",
    });
    writeTaskState(taskStatePath, [contract]);

    const report = buildRuntimeLedgerShadowDiff({
      taskStatePath,
      dbPath,
      sqlite: null,
    });

    expect(report.totalDelegateContracts).toBe(1);
    expect(report.missingWorkContracts).toHaveLength(1);
  });

  it("ignores reply route contracts", () => {
    const replyContract = buildWorkContractFromPolicy(
      "session-reply-diff",
      "reply route",
      "plain_chat",
      coverage,
      buildWorkDecisionSeal("local_judge", "reply", ["simple"]),
    );
    writeTaskState(taskStatePath, [replyContract]);

    const report = buildRuntimeLedgerShadowDiff({
      taskStatePath,
      dbPath,
    });

    expect(report.totalDelegateContracts).toBe(0);
  });
});
