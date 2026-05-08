import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import type { ContextCoverageSnapshot, NativeBindingRef } from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "./builders.js";
import { loadWorkContract, saveWorkContract } from "./store.js";
import { materializeWorkContractSuccess, materializeWorkContractFailure } from "./materializer.js";

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

describe("work contract materializer", () => {
  let ledgerPath: string;
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
    ledgerPath = path.join("/tmp", "octoclaw-wp5-test", "work-contracts.json");
  });

  afterEach(() => {
    if (originalRuntimeLedger !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = originalRuntimeLedger;
    else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    vi.restoreAllMocks();
  });

  function seedSealedContract(sessionKey = "session-wp5", userAsk = "Implement WP5 materializer") {
    const contract = buildWorkContractFromPolicy(
      sessionKey,
      userAsk,
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
    );
    saveWorkContract(contract, ledgerPath);
    return contract;
  }

  const nativeBinding: NativeBindingRef = {
    flowId: "flow-wp5-1",
    ownerKey: "wc-wp5",
    controllerId: "octoclaw.delegate",
    revision: 1,
    expectedRevision: 1,
    nativeTaskId: "native-task-wp5",
    nativeFlowId: "flow-wp5-1",
    syncMode: "managed",
    status: "queued",
    lastMutation: "createManaged",
    lastMutationApplied: true,
  };

  it("sealed delegate WorkContract dispatch success updates ledger status/telemetry/native ids", () => {
    const contract = seedSealedContract();

    const result = materializeWorkContractSuccess({
      workContractId: contract.workContractId,
      ledgerPath,
      nativeBinding,
      delegateTaskId: "delegate-wp5-1",
      attemptId: "attempt-wp5-1",
      nativeTaskId: "native-task-wp5",
      nativeFlowId: "flow-wp5-1",
      childSessionKey: "child-session-wp5",
      substrateState: "queued",
      spawnExecuted: false,
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("planned");
    expect(result!.delegate?.delegateTaskId).toBe("delegate-wp5-1");
    expect(result!.delegate?.currentAttemptId).toBe("attempt-wp5-1");
    expect(result!.delegate?.nativeBinding).toStrictEqual(expect.objectContaining({
      flowId: "flow-wp5-1",
      ownerKey: "wc-wp5",
      controllerId: "octoclaw.delegate",
      revision: 1,
      expectedRevision: 1,
      nativeTaskId: "native-task-wp5",
      nativeFlowId: "flow-wp5-1",
      syncMode: "managed",
      status: "queued",
      lastMutation: "createManaged",
      lastMutationApplied: true,
    }));
    expect(result!.telemetry.dispatchExecuted).toBe(true);
    expect(result!.telemetry.spawnExecuted).toBe(false);
    expect(result!.telemetry.nativeTaskId).toBe("native-task-wp5");
    expect(result!.telemetry.nativeFlowId).toBe("flow-wp5-1");
    expect(result!.telemetry.resultMaterialized).toBe(false);
    expect(result!.telemetry.deliveryStatus).toBe("none");
    expect(result!.telemetry.childSessionKey).toBe("child-session-wp5");
    expect(result!.mainContext.visibleIds.delegateTaskId).toBe("delegate-wp5-1");
    expect(result!.mainContext.visibleIds.nativeTaskId).toBe("native-task-wp5");
    expect(result!.mainContext.visibleIds.childSessionKey).toBe("child-session-wp5");

    const reloaded = loadWorkContract(contract.workContractId, ledgerPath);
    expect(reloaded?.status).toBe("planned");
    expect(reloaded?.delegate?.delegateTaskId).toBe("delegate-wp5-1");
  });

  it("only marks resultMaterialized when an explicit result packet/artifact is supplied", () => {
    const contract = seedSealedContract();

    const result = materializeWorkContractSuccess({
      workContractId: contract.workContractId,
      ledgerPath,
      nativeBinding,
      delegateTaskId: "delegate-wp5-1",
      attemptId: "attempt-wp5-1",
      nativeTaskId: "native-task-wp5",
      nativeFlowId: "flow-wp5-1",
      substrateState: "succeeded",
      spawnExecuted: true,
      resultMaterialized: true,
      deliveryStatus: "pending",
    });

    expect(result!.telemetry.resultMaterialized).toBe(true);
    expect(result!.telemetry.deliveryStatus).toBe("pending");
  });

  it("does not map substrate running to running without TaskRun/session evidence", () => {
    const contract = seedSealedContract("session-running", "Running task");

    const result = materializeWorkContractSuccess({
      workContractId: contract.workContractId,
      ledgerPath,
      nativeBinding: { ...nativeBinding, status: "running" },
      delegateTaskId: "delegate-running",
      attemptId: "attempt-running",
      substrateState: "running",
      spawnExecuted: false,
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("queued");
    expect(result!.mainContext.nextAction).toBe("dispatch");
  });

  it("does not map substrate completed to completed without result materialization", () => {
    const contract = seedSealedContract("session-completed", "Completed task");

    const result = materializeWorkContractSuccess({
      workContractId: contract.workContractId,
      ledgerPath,
      nativeBinding: { ...nativeBinding, status: "succeeded" },
      delegateTaskId: "delegate-completed",
      attemptId: "attempt-completed",
      substrateState: "completed",
      spawnExecuted: false,
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("queued");
    expect(result!.mainContext.nextAction).toBe("dispatch");
  });

  it("maps substrate state completed to contract status completed with explicit result materialization", () => {
    const contract = seedSealedContract("session-completed-materialized", "Completed task with result");

    const result = materializeWorkContractSuccess({
      workContractId: contract.workContractId,
      ledgerPath,
      nativeBinding: { ...nativeBinding, status: "succeeded" },
      delegateTaskId: "delegate-completed-materialized",
      attemptId: "attempt-completed-materialized",
      substrateState: "completed",
      spawnExecuted: true,
      resultMaterialized: true,
      deliveryStatus: "pending",
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    expect(result!.mainContext.nextAction).toBe("deliver");
  });

  it("maps lost substrate state to failed instead of queued", () => {
    const contract = seedSealedContract("session-lost", "Lost native flow");

    const result = materializeWorkContractSuccess({
      workContractId: contract.workContractId,
      ledgerPath,
      nativeBinding: { ...nativeBinding, status: "lost" },
      delegateTaskId: "delegate-lost",
      attemptId: "attempt-lost",
      substrateState: "lost",
      spawnExecuted: true,
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("failed");
    expect(loadWorkContract(contract.workContractId, ledgerPath)?.status).toBe("failed");
  });

  it("materialization failure updates ledger failed/blocked and error info", () => {
    const contract = seedSealedContract("session-fail", "Failing task");

    const result = materializeWorkContractFailure({
      workContractId: contract.workContractId,
      ledgerPath,
      errorMessage: "ts_runtime_materialization_failed:no worker available",
      nativeBinding,
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("failed");
    expect(result!.telemetry.dispatchExecuted).toBe(false);
    expect(result!.telemetry.resultMaterialized).toBe(false);
    expect(result!.telemetry.deliveryStatus).toBe("failed");
    expect(result!.telemetry.nativeFlowMutationError).toBe("ts_runtime_materialization_failed:no worker available");
    expect(result!.delegate?.nextAction).toBe("retry");
    expect(result!.delegate?.blocker).toBe("ts_runtime_materialization_failed:no worker available");
    expect(result!.mainContext.statusLine).toContain("failed");

    const reloaded = loadWorkContract(contract.workContractId, ledgerPath);
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.telemetry.nativeFlowMutationError).toBeTruthy();
  });

  it("materialization failure without nativeBinding preserves existing delegate binding", () => {
    const contract = seedSealedContract("session-fail-no-binding", "Fail no binding");

    const result = materializeWorkContractFailure({
      workContractId: contract.workContractId,
      ledgerPath,
      errorMessage: "capability_failure",
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("failed");
    expect(result!.telemetry.nativeFlowMutationError).toBe("capability_failure");
  });

  it("returns null for missing workContractId", () => {
    const result = materializeWorkContractSuccess({
      workContractId: "wc-nonexistent",
      ledgerPath,
      nativeBinding,
      delegateTaskId: "delegate-ghost",
      attemptId: "attempt-ghost",
      substrateState: "queued",
      spawnExecuted: false,
    });

    expect(result).toBeNull();
  });

  it("WorkContract storage writes task-state only, not a legacy ledger", () => {
    const emptyBefore = mockFs.files.has(ledgerPath);
    expect(emptyBefore).toBe(false);

    const contract = seedSealedContract("session-legacy", "Legacy path");

    expect(loadWorkContract(contract.workContractId, ledgerPath)).not.toBeNull();
    expect(mockFs.files.has(ledgerPath)).toBe(false);

    const taskStatePath = path.join(path.dirname(ledgerPath), "task-state.json");
    const taskState = JSON.parse(mockFs.files.get(taskStatePath) || '{"tasks":[]}') as { tasks: Array<Record<string, unknown>> };
    expect(taskState.tasks).toHaveLength(1);
    expect(taskState.tasks[0]).toMatchObject({
      id: contract.workContractId,
      workContractId: contract.workContractId,
    });
  });

  it("spawnExecuted stays false when only TaskFlow created, no TaskRun evidence", () => {
    const contract = seedSealedContract("session-spawn-honesty", "Spawn honesty");

    const result = materializeWorkContractSuccess({
      workContractId: contract.workContractId,
      ledgerPath,
      nativeBinding,
      delegateTaskId: "delegate-spawn",
      attemptId: "attempt-spawn",
      nativeTaskId: "native-task-spawn",
      substrateState: "queued",
      spawnExecuted: false,
    });

    expect(result).not.toBeNull();
    expect(result!.telemetry.dispatchExecuted).toBe(true);
    expect(result!.telemetry.spawnExecuted).toBe(false);
  });

  it("spawnExecuted stays false even when substrate state is running without evidence", () => {
    const contract = seedSealedContract("session-spawn-running", "Spawn running honesty");

    const result = materializeWorkContractSuccess({
      workContractId: contract.workContractId,
      ledgerPath,
      nativeBinding: { ...nativeBinding, status: "running" },
      delegateTaskId: "delegate-spawn-r",
      attemptId: "attempt-spawn-r",
      substrateState: "running",
      spawnExecuted: false,
    });

    expect(result).not.toBeNull();
    expect(result!.telemetry.dispatchExecuted).toBe(true);
    expect(result!.telemetry.spawnExecuted).toBe(false);
    expect(result!.status).toBe("queued");
  });
});

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
  execution: { coverage: "none" },
  memory: { coverage: "none" },
  conflict: false,
  authority: "none",
};
