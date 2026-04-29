import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { TaskStatusProjection } from "@octoclaw/contracts/status-projection";
import type { AnomalyNotice } from "@octoclaw/contracts/work-contract";
import type { NativeHelperInvoker } from "../../adapter/native-helper.js";
import {
  buildCompactParentPacket,
  detectExecutionTransition,
  emitExecutionTransitionNotification,
  resetExecTransitionState,
  type CompactParentPacket,
  type ExecutionTransitionKind,
} from "../execution-transition-notifier.js";
import { watchdogTick } from "../ack-guard.js";
import { envOverrides } from "../../resolve/env.js";
import {
  buildTurnExecutionReceipt,
  emitResultReadyIfTransition,
} from "../../replay/replay-logger.js";
import { getToolRegistrations } from "../../tools/registration.js";

const adapter = {
  send: vi.fn(),
  react: vi.fn(),
  resolveTarget: vi.fn(),
};

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
  mkdirSync(pathname: string, options?: { recursive?: boolean }): void;
  readFileSync(pathname: string, encoding: string): string;
  writeFileSync(pathname: string, data: string, encoding: string): void;
};
const osModule = os as unknown as { tmpdir(): string };

vi.mock("../../im/index.js", () => ({
  getAdapterForSession: () => adapter,
}));

type ReplaySpy = MockInstance<typeof import("../../replay/replay-logger.js").recordPolicyReplay>;
type RunCommandSpy = MockInstance<typeof import("../../resolve/env.js").runCommand>;

const tempDirs: string[] = [];

describe("execution transition integration", () => {
  beforeEach(() => {
    resetExecTransitionState();
    vi.restoreAllMocks();
    vi.useRealTimers();
    adapter.send.mockReset();
    adapter.react.mockReset();
    adapter.resolveTarget.mockReset();
    adapter.send.mockResolvedValue({ sent: true, delivered: true, threadTs: "1700000000.000200" });
    adapter.resolveTarget.mockReturnValue({ target: "C123ABC" });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetExecTransitionState();
    envOverrides.workspaceRoot = "";
    delete process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("real dispatch path emits dispatch_materialized replay with queued parent packet", async () => {
    const { replaySpy } = await mockDelivery();
    const dir = useTempWorkspace("octoclaw-dispatch-transition-");

    const dispatch = getToolRegistrations().find((registration) => registration.name === "octoclaw_dispatch");
    expect(dispatch).toBeDefined();

    const response = await dispatch!.execute({
      task: "Materialize without child session evidence",
      policyJson: JSON.stringify(delegateDecision("slack:default:channel:C123ABC")),
      metadataJson: JSON.stringify({ inboundMessageTs: "1700000000.000100" }),
    }, {
      helperInvoker: materializedNoSpawnHelper(),
      sessionId: "dispatch-transition-session",
    });
    const dispatchResult = JSON.parse(String(response.text)) as Record<string, unknown>;

    expect(dispatchResult.materialized).toBe(true);
    expect(dispatchResult.dispatch_executed).toBe(true);
    expect(dispatchResult.spawn_executed).toBe(false);

    await waitForFireAndForget();

    const payload = findReplayPayload(replaySpy, "dispatch_materialized");
    expect(payload).toEqual(expect.objectContaining({
      transitionKind: "dispatch_materialized",
      dispatchExecuted: true,
      spawnExecuted: false,
      projectionStatus: "queued",
    }));
    const packet = expectCompactPacket(payload, "dispatch_materialized");
    expect(packet.status).toBe("queued");
    expect(packet.status).not.toBe("running");
    expectNoTranscriptKeys(packet);

    const taskState = JSON.parse(fs.readFileSync(path.join(dir, "tmp", "octopus", "task-state.json"), "utf-8")) as { tasks: Array<Record<string, unknown>> };
    expect(taskState.tasks[0]).toEqual(expect.objectContaining({
      status: "queued",
      dispatchExecuted: true,
      spawnExecuted: false,
    }));
  });

  it("watchdog stale/timed_out path emits notifications with parent-visible packets", async () => {
    const { replaySpy } = await mockDelivery();
    const now = new Date("2026-04-26T10:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    useTempWorkspace("octoclaw-watchdog-transition-");
    writeTaskState({
      tasks: [{
        id: "task-watchdog-stale",
        flow_id: "flow-watchdog-stale",
        session_key: "slack:default:channel:C123ABC",
        status: "queued",
        updated_at: now - 91 * 60_000,
        created_at: new Date(now - 100 * 60_000).toISOString(),
        dispatchExecuted: true,
        spawnExecuted: false,
        latestAnomalyNotice: anomalyNotice("task-watchdog-stale"),
      }],
    });
    vi.doMock("../../adapter/native-helper.js", () => ({
      invokeNativeHelper: watchdogNativeHelper(),
    }));

    await watchdogTick({ debug: vi.fn(), warn: vi.fn() });
    await vi.runAllTimersAsync();

    const stalePayload = findReplayPayload(replaySpy, "queued_stale");
    expect(stalePayload).toEqual(expect.objectContaining({ transitionKind: "queued_stale", projectionStatus: "queued" }));
    const stalePacket = expectCompactPacket(stalePayload, "queued_stale");
    expect(stalePacket.status).toBe("queued");
    expectNoTranscriptKeys(stalePacket);

    const timedOutPayload = findReplayPayload(replaySpy, "timed_out");
    expect(timedOutPayload).toEqual(expect.objectContaining({ transitionKind: "timed_out", projectionStatus: "timed_out" }));
    const timedOutPacket = expectCompactPacket(timedOutPayload, "timed_out");
    expect(timedOutPacket.status).toBe("timed_out");
    expectNoTranscriptKeys(timedOutPacket);
  });

  it("result_ready is emitted from receipt handling", async () => {
    const { replaySpy } = await mockDelivery();
    const previousReceipt = buildTurnExecutionReceipt(receiptState({ resultMaterialized: false }), 1000, Date.now());
    const currentReceipt = buildTurnExecutionReceipt(receiptState({ resultMaterialized: true }), 2000, Date.now());

    emitResultReadyIfTransition({
      previousReceipt,
      currentReceipt,
      stateKey: "slack:default:channel:C123ABC",
      replyToMessageId: "1700000000.000100",
    });
    await waitForFireAndForget();

    const payload = findReplayPayload(replaySpy, "result_ready");
    expect(payload).toEqual(expect.objectContaining({
      transitionKind: "result_ready",
      dispatchExecuted: true,
      spawnExecuted: true,
      resultMaterialized: true,
    }));
    const packet = expectCompactPacket(payload, "result_ready");
    expect(packet.status).toBe("deliverable_ready");
    expectNoTranscriptKeys(packet);
  });

  it("no-target skips do not claim dedupe keys", async () => {
    const { replaySpy } = await mockDelivery();
    const projection = baseProjection({ taskId: "task-no-target" });

    const skipped = await emitExecutionTransitionNotification({
      transitionKind: "result_ready",
      projection,
      attemptId: "attempt-no-target",
      workContractId: "wc-no-target",
      sessionKey: "agent:main:main",
      stateKey: "agent:main:main",
      replyToMessageId: "1700000000.000100",
    });
    expect(skipped).toEqual(expect.objectContaining({ sent: false, skipped: true, reason: "no_valid_target" }));

    const sent = await emitExecutionTransitionNotification({
      transitionKind: "result_ready",
      projection,
      attemptId: "attempt-no-target",
      workContractId: "wc-no-target",
      sessionKey: "slack:default:channel:C123ABC",
      stateKey: "slack:default:channel:C123ABC",
      replyToMessageId: "1700000000.000100",
    });
    expect(sent.sent).toBe(true);

    const payload = findReplayPayload(replaySpy, "result_ready", { sent: true });
    expect(payload).toEqual(expect.objectContaining({ transitionKind: "result_ready", sent: true }));
    expectNoTranscriptKeys(expectCompactPacket(payload, "result_ready"));
  });

  it("includes AnomalyNotice in CompactParentPacket when projection carries it", () => {
    const packet = buildCompactParentPacket(baseProjection({ latestAnomalyNotice: anomalyNotice("task-anomaly") }));

    expect(packet.latestAnomalyNotice).toEqual(expect.objectContaining({
      kind: "watchdog_stale",
      taskId: "task-anomaly",
    }));
    expectNoTranscriptKeys(packet);
  });

  it("detectExecutionTransition covers only boolean edges", () => {
    expect(detectExecutionTransition(null, {
      dispatchExecuted: true,
      spawnExecuted: false,
      resultMaterialized: false,
    })).toBe("dispatch_materialized");
    expect(detectExecutionTransition(
      { dispatchExecuted: true, spawnExecuted: false, resultMaterialized: false },
      { dispatchExecuted: true, spawnExecuted: true, resultMaterialized: false },
    )).toBe("spawn_started");
    expect(detectExecutionTransition(
      { dispatchExecuted: true, spawnExecuted: true, resultMaterialized: false },
      { dispatchExecuted: true, spawnExecuted: true, resultMaterialized: true },
    )).toBe("result_ready");

    for (const current of [
      { dispatchExecuted: false, spawnExecuted: false, resultMaterialized: false },
      { dispatchExecuted: true, spawnExecuted: false, resultMaterialized: false, latestAnomalyNotice: anomalyNotice("task-edge") },
      { dispatchExecuted: true, spawnExecuted: true, resultMaterialized: false, latestAnomalyNotice: anomalyNotice("task-edge") },
      { dispatchExecuted: true, spawnExecuted: true, resultMaterialized: true, latestAnomalyNotice: anomalyNotice("task-edge") },
    ]) {
      expect(detectExecutionTransition(
        { dispatchExecuted: current.dispatchExecuted, spawnExecuted: current.spawnExecuted, resultMaterialized: current.resultMaterialized },
        current,
      )).toBeNull();
    }
  });

  it("real dispatch no-spawn path emits materialized_no_spawn replay and parent-visible anomaly packet", async () => {
    const { replaySpy } = await mockDelivery();
    useTempWorkspace("octoclaw-no-spawn-transition-");

    const dispatch = getToolRegistrations().find((registration) => registration.name === "octoclaw_dispatch");
    expect(dispatch).toBeDefined();

    const response = await dispatch!.execute({
      task: "Materialize without child session evidence",
      policyJson: JSON.stringify(delegateDecision("slack:default:channel:C123ABC")),
      metadataJson: JSON.stringify({ inboundMessageTs: "1700000000.000100" }),
    }, {
      helperInvoker: materializedNoSpawnHelper(),
      sessionId: "dispatch-no-spawn-session",
    });
    const result = JSON.parse(String(response.text)) as Record<string, unknown>;
    expect(result.materialized).toBe(true);
    expect(result.spawn_executed).toBe(false);

    await waitForFireAndForget();

    const payload = findReplayPayload(replaySpy, "materialized_no_spawn");
    expect(payload).toEqual(expect.objectContaining({
      transitionKind: "materialized_no_spawn",
      dispatchExecuted: true,
      spawnExecuted: false,
    }));
    const packet = expectCompactPacket(payload, "materialized_no_spawn");
    expect(packet.status).toBe("queued");
    expect(packet.status).not.toBe("running");
    expectNoTranscriptKeys(packet);

    expect(packet.latestAnomalyNotice).toEqual(expect.objectContaining({
      kind: "spawn_not_confirmed",
      taskId: expect.any(String),
    }));
  });

  it("real spawn failure path emits spawn_failed replay and packet", async () => {
    const { replaySpy } = await mockDelivery();
    useTempWorkspace("octoclaw-spawn-failed-");

    const dispatch = getToolRegistrations().find((registration) => registration.name === "octoclaw_dispatch");
    expect(dispatch).toBeDefined();

    const response = await dispatch!.execute({
      task: "Task that fails during spawn",
      policyJson: JSON.stringify(delegateDecision("slack:default:channel:C123ABC")),
      metadataJson: JSON.stringify({ inboundMessageTs: "1700000000.000100" }),
    }, {
      helperInvoker: spawnFailureHelper(),
      sessionId: "spawn-failed-session",
    });
    const result = JSON.parse(String(response.text)) as Record<string, unknown>;
    expect(result.error).toBeDefined();

    await waitForFireAndForget();

    const payload = findReplayPayload(replaySpy, "spawn_failed");
    expect(payload).toEqual(expect.objectContaining({
      transitionKind: "spawn_failed",
    }));
    const packet = expectCompactPacket(payload, "spawn_failed");
    expect(packet.status).toBe("failed");
    expectNoTranscriptKeys(packet);
  });

  it("watchdog path stores parent-visible anomaly notice even when Slack send is skipped", async () => {
    vi.useFakeTimers();
    const baseTime = new Date("2026-04-26T10:00:00.000Z").getTime();
    const now = baseTime + 60_000;
    vi.setSystemTime(now);
    const dir = useTempWorkspace("octoclaw-watchdog-anomaly-");
    writeTaskState({
      tasks: [{
        id: "task-no-slack-target",
        flow_id: "flow-no-target",
        session_key: "agent:main:main",
        status: "queued",
        updated_at: now - 91 * 60_000,
        created_at: new Date(now - 100 * 60_000).toISOString(),
        dispatchExecuted: true,
        spawnExecuted: false,
      }],
    });
    vi.doMock("../../adapter/native-helper.js", () => ({
      invokeNativeHelper: watchdogNativeHelper(),
    }));

    await watchdogTick({ debug: vi.fn(), warn: vi.fn() });
    await vi.runAllTimersAsync();

    const taskState = JSON.parse(fs.readFileSync(path.join(dir, "tmp", "octopus", "task-state.json"), "utf-8")) as { tasks: Array<Record<string, unknown>> };
    const task = taskState.tasks.find((taskRecord) => taskRecord.id === "task-no-slack-target");
    expect(task).toBeDefined();
    expect(task!.latestAnomalyNotice).toEqual(expect.objectContaining({
      kind: expect.stringMatching(/queued_stale|watchdog_timeout/),
      taskId: "task-no-slack-target",
    }));
  });

  it("snake_case evidence fields project correctly via watchdog", async () => {
    const { replaySpy } = await mockDelivery();
    vi.useFakeTimers();
    const baseTime = new Date("2026-04-26T10:00:00.000Z").getTime();
    const now = baseTime + 120_000;
    vi.setSystemTime(now);
    useTempWorkspace("octoclaw-snake-case-");
    writeTaskState({
      tasks: [{
        id: "task-snake-case",
        flow_id: "flow-snake-case",
        session_key: "slack:default:channel:C123ABC",
        status: "queued",
        updated_at: now - 91 * 60_000,
        created_at: new Date(now - 100 * 60_000).toISOString(),
        dispatch_executed: true,
        spawn_executed: false,
        result_materialized: false,
        latest_anomaly_notice: { kind: "test_anomaly", severity: "warning", taskId: "task-snake-case", message: "test", createdAt: new Date(now).toISOString() },
      }],
    });
    vi.doMock("../../adapter/native-helper.js", () => ({
      invokeNativeHelper: watchdogNativeHelper(),
    }));

    await watchdogTick({ debug: vi.fn(), warn: vi.fn() });
    await vi.runAllTimersAsync();

    const payload = findReplayPayload(replaySpy, "queued_stale");
    expect(payload.dispatchExecuted).toBe(true);
    expect(payload.spawnExecuted).toBe(false);
    const packet = expectCompactPacket(payload, "queued_stale");
    expect(packet.latestAnomalyNotice).toEqual(expect.objectContaining({
      kind: "test_anomaly",
      taskId: "task-snake-case",
    }));
  });
});

async function mockDelivery(): Promise<{ runCommandSpy: RunCommandSpy; replaySpy: ReplaySpy }> {
  const envModule = await import("../../resolve/env.js");
  const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({ ok: true }),
    stderr: "",
    timedOut: false,
  });
  const replaySpy = vi.spyOn(await import("../../replay/replay-logger.js"), "recordPolicyReplay");
  return { runCommandSpy, replaySpy };
}

function useTempWorkspace(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), prefix));
  tempDirs.push(dir);
  envOverrides.workspaceRoot = dir;
  process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH = path.join(dir, "tmp", "octopus", "work-contracts.json");
  fs.mkdirSync(path.join(dir, "tmp", "octopus"), { recursive: true });
  return dir;
}

function writeTaskState(payload: Record<string, unknown>): void {
  const taskStatePath = path.join(envOverrides.workspaceRoot, "tmp", "octopus", "task-state.json");
  fs.writeFileSync(taskStatePath, JSON.stringify(payload), "utf-8");
}

function delegateDecision(sessionKey: string): Record<string, unknown> {
  return {
    request: { session_key: sessionKey },
    route_decision: {
      route: "delegate",
      worker_pool: "octoclaw-research",
      task_class: "worker_research",
    },
    model_policy: { selected_model: "worker_research" },
  };
}

function materializedNoSpawnHelper(): NativeHelperInvoker {
  return ((input) => {
    if (input.action === "create-managed-flow") {
      return { ok: true, flow_id: "flow-no-spawn", flow: { flowId: "flow-no-spawn", status: "planned", revision: 1 } };
    }
    if (input.action === "run-task") {
      return { ok: true, native_task_id: "task-no-spawn", flow_id: "flow-no-spawn", task: { taskId: "task-no-spawn", status: "queued", state: "queued", revision: 1 } };
    }
    throw new Error(`unsupported_action:${input.action}`);
  }) as NativeHelperInvoker;
}

function spawnFailureHelper(): NativeHelperInvoker {
  return ((input) => {
    if (input.action === "create-managed-flow") {
      return { ok: true, flow_id: "flow-spawn-fail", flow: { flowId: "flow-spawn-fail", status: "planned", revision: 1 } };
    }
    if (input.action === "run-task") {
      const err = new Error("ts_runtime_spawn_failed:native spawn failure");
      throw Object.assign(err, { payload: { executed: false, status: "failed", route: "delegate" } });
    }
    throw new Error(`unsupported_action:${input.action}`);
  }) as NativeHelperInvoker;
}

function watchdogNativeHelper(): NativeHelperInvoker {
  return ((input) => {
    if (input.action === "read-task") {
      return { found: true, task: { taskId: "task-watchdog-stale", state: "queued", status: "queued" } };
    }
    if (input.action === "fail-flow") {
      return { ok: true, status: "timed_out" };
    }
    throw new Error(`unsupported_action:${input.action}`);
  }) as NativeHelperInvoker;
}

function receiptState(options: { resultMaterialized: boolean }): Record<string, unknown> {
  return {
    canonicalSessionKey: "slack:default:channel:C123ABC",
    delegated: true,
    dispatchExecuted: true,
    spawnExecuted: true,
    delegateTaskContext: { delegateTaskId: "task-result-ready", taskStatus: "running" },
    decision: {
      route_decision: { route: "delegate", worker_pool: "octoclaw-research" },
      runtime_truth: {
        binding: { taskId: "task-result-ready", flowId: "flow-result-ready", childSessionKey: "child-session" },
        evidence: { spawnExecuted: true, childRunId: "child-run" },
      },
      delivery: options.resultMaterialized ? { status: "pending", result_path: "/tmp/result.md" } : {},
      workContractId: "wc-result-ready",
    },
  };
}

function baseProjection(overrides: Partial<TaskStatusProjection> = {}): TaskStatusProjection {
  return {
    schemaVersion: "octoclaw.task_status_projection/v1",
    projectionId: "projection-integration-1",
    generatedAt: new Date().toISOString(),
    requestId: "req-1",
    flowId: "flow-1",
    taskId: "task-1",
    workContractId: "wc-1",
    title: "Test task",
    summary: "Test summary",
    taskSummary: "Test task",
    route: "delegate",
    role: "default",
    backend: "octoclaw.delegate",
    modelProfile: "coding",
    status: "deliverable_ready",
    statusReason: "final_result_exists_delivery_pending",
    success: false,
    createdAt: "2026-04-26T00:00:00.000Z",
    elapsedMs: 5000,
    dispatchExecuted: true,
    spawnExecuted: true,
    resultMaterialized: true,
    artifactRefs: [],
    artifactRefIds: [],
    actions: ["details", "copy_ref"],
    ...overrides,
  };
}

function anomalyNotice(taskId: string): AnomalyNotice {
  return {
    kind: "watchdog_stale",
    severity: "warning",
    taskId,
    message: "Task heartbeat is stale.",
    createdAt: "2026-04-26T00:00:00.000Z",
  } as AnomalyNotice;
}

function findReplayPayload(
  replaySpy: ReplaySpy,
  transitionKind: ExecutionTransitionKind,
  match: Record<string, unknown> = {},
): Record<string, unknown> {
  const call = replaySpy.mock.calls.find(([eventType, payload]) => {
    const record = payload as Record<string, unknown>;
    return eventType === "execution_transition"
      && record.transitionKind === transitionKind
      && Object.entries(match).every(([key, value]) => record[key] === value);
  });
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

function expectCompactPacket(payload: Record<string, unknown>, transitionKind: ExecutionTransitionKind): CompactParentPacket {
  expect(payload.transitionKind).toBe(transitionKind);
  const packet = payload.compactParentPacket as CompactParentPacket | undefined;
  expect(packet).toBeDefined();
  expectNoTranscriptKeys(packet!);
  return packet!;
}

function expectNoTranscriptKeys(packet: CompactParentPacket): void {
  expect(packet).not.toHaveProperty("transcript");
  expect(packet).not.toHaveProperty("rawTranscript");
  expect(packet).not.toHaveProperty("childTranscript");
  expect(Object.keys(packet).every((key) => !key.toLowerCase().includes("transcript"))).toBe(true);
}

async function waitForFireAndForget(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
