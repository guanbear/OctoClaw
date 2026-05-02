import fsSync from "node:fs";
import path from "node:path";

const fs = fsSync as unknown as { existsSync(pathname: string): boolean; mkdtempSync(prefix: string): string; mkdirSync(pathname: string, options?: { recursive?: boolean }): void; readFileSync(pathname: string, encoding: string): string; utimesSync(pathname: string, atime: Date, mtime: Date): void; writeFileSync(pathname: string, data: string, encoding: string): void };
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IMAdapter, IMReactParams, IMSendParams } from "../im/adapter.js";
import { registerIMAdapter } from "../im/index.js";
import { resetExecTransitionState } from "../ack/execution-transition-notifier.js";
import { envOverrides } from "../resolve/env.js";
import { finalizeChildSessionOnce, scheduleChildCompletionFinalizer, recoverPendingChildCompletionFinalizers, resetChildCompletionFinalizers } from "./child-finalizer.js";
import { saveWorkContract } from "../work-contract/store.js";
import type { WorkContract } from "@octoclaw/contracts/work-contract";

function writeCompletionFile(workspaceRoot: string, workContractId: string, completion: Record<string, unknown>): string {
  const completionDir = path.join(workspaceRoot, ".octoclaw", "completions");
  fs.mkdirSync(completionDir, { recursive: true });
  const filePath = path.join(completionDir, `${workContractId}.completion.json`);
  fs.writeFileSync(filePath, JSON.stringify(completion, null, 2), "utf-8");
  return filePath;
}

function writeOpenClawSessionRegistry(openclawHome: string, sessionId: string, controlKey: string): void {
  fs.mkdirSync(path.join(openclawHome, "agents", "main", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(openclawHome, "openclaw.json"), "{}", "utf-8");
  fs.writeFileSync(path.join(openclawHome, "agents", "main", "sessions", "sessions.json"), JSON.stringify({
    [controlKey]: {
      sessionId,
      origin: { provider: "slack", surface: "slack", chatType: "direct", to: "user:U123", nativeChannelId: "D123", threadId: "1777556160.478629" },
      deliveryContext: { channel: "slack", to: "user:U123", threadId: "1777556160.478629" },
      updatedAt: 1777557114934,
    },
  }, null, 2), "utf-8");
}

function registerCapturingSlackAdapter(captured: string[], matcher: (sessionKey: string) => boolean): void {
  const adapter: IMAdapter = {
    channel: "slack",
    capabilityLevel: "L2",
    canHandle: matcher,
    resolveTarget: () => ({ channel: "slack", target: "channel:CNOTIFY" }),
    send: async (params: IMSendParams) => {
      captured.push(params.message);
      return { sent: true, delivered: true, messageId: "1777557115.000001" };
    },
    react: async (_params: IMReactParams) => ({ ok: true }),
  };
  registerIMAdapter(adapter);
}

describe("child completion finalizer — completion file protocol", () => {
  let tmpDir = "";

  afterEach(() => {
    vi.useRealTimers();
    resetChildCompletionFinalizers();
    resetExecTransitionState();
    if (tmpDir) {
      envOverrides.workspaceRoot = "";
    }
    delete process.env.OCTOCLAW_RUNTIME_LEDGER;
  });

  it("returns pending when no completion file exists", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;

    const result = await finalizeChildSessionOnce({
      childSessionKey: "child-key",
      delegateTaskId: "delegate-1",
      workContractId: "wc-1",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-1",
    });

    expect(result.status).toBe("pending");
  });

  it("treats native-announce materialized WorkContract as completed without completion file", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");
    const now = new Date().toISOString();
    const contract = {
      workContractId: "wc-native-announce-materialized",
      route: "delegate",
      status: "completed",
      sessionKey: "slack:channel:C123",
      userAsk: "native announce child final",
      intentClass: "delegated_work",
      createdAt: now,
      updatedAt: now,
      decision: { reasonCodes: [] },
      nativeSpawnRefs: {
        openclawRunId: "run-native-announce",
        childSessionKey: "child-native-announce",
        requesterSessionKey: "slack:channel:C123",
        spawnIntentId: "nsp-native-announce",
        spawnBackend: "sessions_spawn_planner",
      },
      continuity: {
        preferredChildSessionKey: "child-native-announce",
        preferredRunId: "run-native-announce",
      },
      telemetry: {
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: true,
        deliveryStatus: "delivered",
        childSessionKey: "child-native-announce",
        childRunId: "run-native-announce",
      },
      mainContext: {
        summary: "native announce child final",
        statusLine: "Child result delivered.",
        nextAction: "none",
        visibleIds: {
          childSessionKey: "child-native-announce",
          openclawRunId: "run-native-announce",
          spawnIntentId: "nsp-native-announce",
        },
      },
      delegate: {
        delegateTaskId: "delegate-native-announce",
        currentAttemptId: "attempt-native-announce",
        role: "default",
        coordinationMode: "solo_worker",
        acceptanceCriteria: [],
        scope: { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "" },
        modelProfile: "",
        nativeBinding: {
          flowId: "sessions_spawn:run-native-announce",
          ownerKey: "delegate-native-announce",
          controllerId: "octoclaw.delegate",
          revision: 1,
          expectedRevision: 1,
          runId: "run-native-announce",
          childRunId: "run-native-announce",
          childSessionKey: "child-native-announce",
          syncMode: "managed",
          status: "succeeded",
          lastMutation: "runTask",
          lastMutationApplied: true,
        },
        childSessions: [],
        artifactRefs: [],
        nextAction: "deliver",
      },
    } as unknown as WorkContract;
    expect(saveWorkContract(contract, taskStatePath)).toBe(true);

    const result = await finalizeChildSessionOnce({
      childSessionKey: "child-native-announce",
      delegateTaskId: "delegate-native-announce",
      workContractId: "wc-native-announce-materialized",
      parentSessionKey: "slack:channel:C123",
      taskStatePath,
    });

    expect(result).toMatchObject({ status: "completed", sent: false });
  });

  it("returns completed when completion file exists and delivery succeeds", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");

    writeCompletionFile(tmpDir, "wc-2", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-2",
      childSessionKey: "child-key-2",
      delegateTaskId: "delegate-2",
      status: "success",
      summary: "任务完成：所有文件已重构，测试通过。",
      artifacts: [],
      completedAt: new Date().toISOString(),
    });

    const sent: string[] = [];
    const result = await finalizeChildSessionOnce({
      taskStatePath,
      childSessionKey: "child-key-2",
      delegateTaskId: "delegate-2",
      workContractId: "wc-2",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-2",
      modelId: "test-model",
      sendFinalMessage: async ({ message }) => {
        sent.push(message);
        return { sent: true, delivered: true };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.resultText).toContain("任务完成");
    expect(sent[0]).toContain("子任务完成");
    expect(sent[0]).toContain("route=delegate");
    expect(sent[0]).toContain("model=test-model");
    expect(sent[0]).not.toContain("rawTranscript");

    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({
      id: "wc-2",
      workContractId: "wc-2",
      taskId: "native-2",
      status: "completed",
      dispatchExecuted: true,
      spawnExecuted: true,
      resultMaterialized: true,
    });
  });

  it("blocks final delivery when completion binding mismatches expected child session", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");
    writeCompletionFile(tmpDir, "wc-binding-mismatch", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-binding-mismatch",
      childSessionKey: "wrong-child",
      delegateTaskId: "delegate-binding-mismatch",
      nativeTaskId: "native-binding-mismatch",
      status: "success",
      summary: "should not deliver",
      artifacts: [],
      completedAt: new Date().toISOString(),
    });

    const sent: string[] = [];
    const result = await finalizeChildSessionOnce({
      taskStatePath,
      childSessionKey: "expected-child",
      delegateTaskId: "delegate-binding-mismatch",
      workContractId: "wc-binding-mismatch",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-binding-mismatch",
      sendFinalMessage: async ({ message }) => {
        sent.push(message);
        return { sent: true, delivered: true };
      },
    });

    expect(result.status).toBe("binding_mismatch");
    expect(sent).toHaveLength(0);
    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({
      status: "binding_mismatch",
      resultMaterialized: false,
      delivery_status: "blocked",
    });
    delete process.env.OCTOCLAW_RUNTIME_LEDGER;
  });

  it("uses a durable delivery claim so concurrent finalizers do not duplicate the final result", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");
    writeCompletionFile(tmpDir, "wc-concurrent", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-concurrent",
      childSessionKey: "child-concurrent",
      delegateTaskId: "delegate-concurrent",
      status: "success",
      summary: "concurrent final result",
      completedAt: new Date().toISOString(),
    });

    let sendCalls = 0;
    const baseOptions = {
      taskStatePath,
      childSessionKey: "child-concurrent",
      delegateTaskId: "delegate-concurrent",
      workContractId: "wc-concurrent",
      parentSessionKey: "slack:channel:CCONCURRENT",
      sendFinalMessage: async () => {
        sendCalls++;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { sent: true, delivered: true };
      },
    };

    const results = await Promise.all([
      finalizeChildSessionOnce(baseOptions),
      finalizeChildSessionOnce(baseOptions),
    ]);

    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(sendCalls).toBe(1);
    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({
      id: "wc-concurrent",
      status: "completed",
      delivery_status: "delivered",
      resultMaterialized: true,
    });
  });

  it("does not redeliver a completion that is already materialized", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = writeTaskState(tmpDir, [{
      id: "wc-materialized",
      workContractId: "wc-materialized",
      route: "delegate",
      resultMaterialized: true,
      result_materialized: true,
      status: "completed",
    }]);
    writeCompletionFile(tmpDir, "wc-materialized", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-materialized",
      childSessionKey: "child-materialized",
      delegateTaskId: "delegate-materialized",
      status: "success",
      summary: "already delivered",
      completedAt: new Date().toISOString(),
    });

    let sendCalls = 0;
    const result = await finalizeChildSessionOnce({
      taskStatePath,
      childSessionKey: "child-materialized",
      delegateTaskId: "delegate-materialized",
      workContractId: "wc-materialized",
      parentSessionKey: "slack:channel:CMAT",
      sendFinalMessage: async () => {
        sendCalls++;
        return { sent: true, delivered: true };
      },
    });

    expect(result.status).toBe("completed");
    expect(sendCalls).toBe(0);
  });

  it("delivers through canonical Slack session when parent key is an internal session id", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const priorOpenClawHome = process.env.OPENCLAW_HOME;
    const openclawHome = path.join(tmpDir, "openclaw-home");
    const controlKey = "agent:main:slack:default:direct:u123:thread:1777556160.478629";
    writeOpenClawSessionRegistry(openclawHome, "b36be030-16a2-41f6-aa78-cd3bb6c3a288", controlKey);
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");
      writeCompletionFile(tmpDir, "wc-delivery-map", {
        schemaVersion: "octoclaw.worker_completion/v1",
        workContractId: "wc-delivery-map",
        childSessionKey: "child-delivery-map",
        delegateTaskId: "delegate-delivery-map",
        status: "success",
        summary: "完成",
        completedAt: new Date().toISOString(),
      });

      let deliveredSessionKey = "";
      const result = await finalizeChildSessionOnce({
        taskStatePath,
        childSessionKey: "child-delivery-map",
        delegateTaskId: "delegate-delivery-map",
        workContractId: "wc-delivery-map",
        parentSessionKey: "b36be030-16a2-41f6-aa78-cd3bb6c3a288",
        nativeTaskId: "native-delivery-map",
        sendFinalMessage: async ({ sessionKey }) => {
          deliveredSessionKey = sessionKey;
          return { sent: true, delivered: true };
        },
      });

      expect(result.status).toBe("completed");
      expect(deliveredSessionKey).toBe(controlKey);
      const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
      expect(taskState.tasks[0]).toMatchObject({
        sessionKey: "b36be030-16a2-41f6-aa78-cd3bb6c3a288",
        deliverySessionKey: controlKey,
        delivery_status: "delivered",
      });
    } finally {
      if (priorOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = priorOpenClawHome;
    }
  });

  it("returns delivery_failed when adapter is unavailable and queues to outbox", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");

    writeCompletionFile(tmpDir, "wc-3", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-3",
      childSessionKey: "child-key-3",
      delegateTaskId: "delegate-3",
      status: "success",
      summary: "已完成",
      completedAt: new Date().toISOString(),
    });

    const result = await finalizeChildSessionOnce({
      taskStatePath,
      childSessionKey: "child-key-3",
      delegateTaskId: "delegate-3",
      workContractId: "wc-3",
      parentSessionKey: "no-adapter-session",
      nativeTaskId: "native-3",
    });

    expect(result.status).toBe("delivery_failed");
    expect(result.error).toContain("no_im_adapter_queued_for_retry");

    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({
      id: "wc-3",
      workContractId: "wc-3",
      status: "deliverable_ready",
      resultMaterialized: true,
      delivery_status: "queued_for_retry",
    });

    const outboxPath = path.join(tmpDir, ".octoclaw", "delivery-outbox.json");
    const outbox = JSON.parse(fs.readFileSync(outboxPath, "utf-8")) as unknown[];
    expect(outbox.length).toBeGreaterThan(0);
    expect((outbox[0] as Record<string, unknown>).workContractId).toBe("wc-3");
  });

  it("emits a transition notification when final result delivery fails", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");
    const progressMessages: string[] = [];
    registerCapturingSlackAdapter(progressMessages, (sessionKey) => sessionKey === "slack:channel:CDELIVERYFAIL");

    writeCompletionFile(tmpDir, "wc-delivery-fail", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-delivery-fail",
      childSessionKey: "child-delivery-fail",
      delegateTaskId: "delegate-delivery-fail",
      status: "success",
      summary: "已完成但暂时投递失败",
      completedAt: new Date().toISOString(),
    });

    const result = await finalizeChildSessionOnce({
      taskStatePath,
      childSessionKey: "child-delivery-fail",
      delegateTaskId: "delegate-delivery-fail",
      workContractId: "wc-delivery-fail",
      parentSessionKey: "slack:channel:CDELIVERYFAIL",
      deliverySessionKey: "slack:channel:CDELIVERYFAIL",
      nativeTaskId: "native-delivery-fail",
      sendFinalMessage: async () => ({ sent: false, delivered: false, error: "synthetic_delivery_failure" }),
    });

    expect(result.status).toBe("delivery_failed");
    expect(progressMessages).toContain("任务结果投递失败。");
  });

  it("returns missing_identity when workContractId is empty", async () => {
    const result = await finalizeChildSessionOnce({
      childSessionKey: "",
      delegateTaskId: "",
      workContractId: "",
      parentSessionKey: "",
    });

    expect(result.status).toBe("missing_identity");
  });

  it("schedules only one active finalizer per WorkContract", () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;

    const first = scheduleChildCompletionFinalizer({
      childSessionKey: "child-one",
      delegateTaskId: "delegate-one",
      workContractId: "wc-singleton",
      parentSessionKey: "slack:channel:CSINGLE",
      initialDelayMs: 0,
    });
    const second = scheduleChildCompletionFinalizer({
      childSessionKey: "child-two",
      delegateTaskId: "delegate-two",
      workContractId: "wc-singleton",
      parentSessionKey: "slack:channel:CSINGLE",
      initialDelayMs: 0,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("scheduleChildCompletionFinalizer polls and detects completion", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;

    const scheduled = scheduleChildCompletionFinalizer({
      childSessionKey: "child-poll",
      delegateTaskId: "delegate-poll",
      workContractId: "wc-poll",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-poll",
      timeoutMs: 30_000,
      pollIntervalMs: 1_000,
      initialDelayMs: 0,
      sendFinalMessage: async () => ({ sent: true, delivered: true }),
    });

    expect(scheduled).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    writeCompletionFile(tmpDir, "wc-poll", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-poll",
      childSessionKey: "child-poll",
      delegateTaskId: "delegate-poll",
      status: "success",
      summary: "轮询检测到的完成结果",
      completedAt: new Date().toISOString(),
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");
    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({
      id: "wc-poll",
      workContractId: "wc-poll",
      taskId: "native-poll",
      resultMaterialized: true,
    });
  });

  it("scheduleChildCompletionFinalizer marks timed_out when no completion file is written", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");

    const progressMessages: string[] = [];
    registerCapturingSlackAdapter(progressMessages, (sessionKey) => sessionKey === "slack:channel:CTIMEOUT");

    scheduleChildCompletionFinalizer({
      taskStatePath,
      childSessionKey: "child-timeout",
      delegateTaskId: "delegate-timeout",
      workContractId: "wc-timeout",
      parentSessionKey: "slack:channel:CTIMEOUT",
      nativeTaskId: "native-timeout",
      timeoutMs: 30_000,
      pollIntervalMs: 1_000,
      initialDelayMs: 0,
    });

    await vi.advanceTimersByTimeAsync(31_000);

    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({
      id: "wc-timeout",
      workContractId: "wc-timeout",
      taskId: "native-timeout",
      status: "timed_out",
      dispatchExecuted: true,
      spawnExecuted: true,
      resultMaterialized: false,
      failureCode: "completion_file_not_written",
    });
    expect(progressMessages).toContain("任务超时。");
  });

  it("extends timeout while child session is still active and then delivers completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T14:50:00.000Z"));
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const openclawHome = path.join(tmpDir, "openclaw-home");
    const sessionDir = path.join(openclawHome, "agents", "main", "sessions");
    const childSessionFile = path.join(sessionDir, "child-active.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(openclawHome, "openclaw.json"), "{}", "utf-8");
    fs.writeFileSync(childSessionFile, "{\"type\":\"assistant\"}\n", "utf-8");
    fs.utimesSync(childSessionFile, new Date(Date.now()), new Date(Date.now()));
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      const progressMessages: string[] = [];
      registerCapturingSlackAdapter(progressMessages, (sessionKey) => sessionKey === "slack:channel:CACTIVE");

      scheduleChildCompletionFinalizer({
        taskStatePath,
        childSessionKey: "child-active",
        delegateTaskId: "delegate-active",
        workContractId: "wc-active",
        parentSessionKey: "slack:channel:CACTIVE",
        nativeTaskId: "native-active",
        timeoutMs: 30_000,
        pollIntervalMs: 1_000,
        initialDelayMs: 0,
        sendFinalMessage: async () => ({ sent: true, delivered: true }),
      });

      await vi.advanceTimersByTimeAsync(31_000);
      expect(progressMessages).not.toContain("任务超时。");
      expect(fs.existsSync(taskStatePath)).toBe(false);

      writeCompletionFile(tmpDir, "wc-active", {
        schemaVersion: "octoclaw.worker_completion/v1",
        workContractId: "wc-active",
        childSessionKey: "child-active",
        delegateTaskId: "delegate-active",
        status: "success",
        summary: "active child eventually completed",
        completedAt: new Date().toISOString(),
      });
      await vi.advanceTimersByTimeAsync(2_000);

      const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
      expect(taskState.tasks[0]).toMatchObject({
        id: "wc-active",
        status: "completed",
        resultMaterialized: true,
      });
    } finally {
      if (previousOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
  });

  it("delivers a completion only once across concurrent finalizers", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");

    writeCompletionFile(tmpDir, "wc-once", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-once",
      childSessionKey: "child-once",
      delegateTaskId: "delegate-once",
      status: "success",
      summary: "只应投递一次",
      completedAt: new Date().toISOString(),
    });

    let sendCalls = 0;
    const baseOptions = {
      taskStatePath,
      childSessionKey: "child-once",
      delegateTaskId: "delegate-once",
      workContractId: "wc-once",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-once",
      sendFinalMessage: async () => {
        sendCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { sent: true, delivered: true };
      },
    };

    const results = await Promise.all([
      finalizeChildSessionOnce(baseOptions),
      finalizeChildSessionOnce(baseOptions),
    ]);

    expect(sendCalls).toBe(1);
    expect(results.some((result) => result.status === "completed")).toBe(true);
  });

  it("does not mark timed_out while completion delivery is in progress", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;
    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");

    writeCompletionFile(tmpDir, "wc-delivering", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-delivering",
      childSessionKey: "child-delivering",
      delegateTaskId: "delegate-delivering",
      status: "success",
      summary: "正在投递",
      completedAt: new Date().toISOString(),
    });

    let releaseSend: (() => void) | undefined;
    scheduleChildCompletionFinalizer({
      taskStatePath,
      childSessionKey: "child-delivering",
      delegateTaskId: "delegate-delivering",
      workContractId: "wc-delivering",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-delivering",
      timeoutMs: 30_000,
      pollIntervalMs: 1_000,
      initialDelayMs: 0,
      sendFinalMessage: async () => new Promise((resolve) => {
        releaseSend = () => resolve({ sent: true, delivered: true });
      }),
    });

    await vi.advanceTimersByTimeAsync(31_000);
    expect(() => fs.readFileSync(taskStatePath, "utf-8")).toThrow();

    releaseSend?.();
    await vi.runOnlyPendingTimersAsync();

    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({
      id: "wc-delivering",
      resultMaterialized: true,
      delivery_status: "delivered",
    });
    expect(taskState.tasks[0].status).not.toBe("timed_out");
  });

  it("handles failure status in completion file", async () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-completion-"));
    envOverrides.workspaceRoot = tmpDir;

    writeCompletionFile(tmpDir, "wc-fail", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-fail",
      childSessionKey: "child-fail",
      delegateTaskId: "delegate-fail",
      status: "failure",
      summary: "任务执行失败",
      errorCode: "build_error",
      errorMessage: "TypeScript compilation failed with 3 errors",
      completedAt: new Date().toISOString(),
    });

    const sent: string[] = [];
    const result = await finalizeChildSessionOnce({
      childSessionKey: "child-fail",
      delegateTaskId: "delegate-fail",
      workContractId: "wc-fail",
      parentSessionKey: "slack:channel:C123",
      sendFinalMessage: async ({ message }) => {
        sent.push(message);
        return { sent: true, delivered: true };
      },
    });

    expect(result.status).toBe("completed");
    expect(sent[0]).toContain("❌ 子任务失败");
    expect(sent[0]).toContain("TypeScript compilation failed");

    const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");
    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({
      id: "wc-fail",
      status: "failed",
      resultMaterialized: true,
      delivery_status: "delivered",
      failureCode: "build_error",
    });
  });
});

function writeTaskState(tmpDir: string, tasks: Record<string, unknown>[]): string {
  const taskStatePath = path.join(tmpDir, "tmp", "octopus", "task-state.json");
  fs.mkdirSync(path.dirname(taskStatePath), { recursive: true });
  fs.writeFileSync(taskStatePath, JSON.stringify({ schemaVersion: "octoclaw.task_state.v1", tasks }, null, 2), "utf-8");
  return taskStatePath;
}

describe("child completion finalizer — durable recovery", () => {
  let tmpDir = "";

  afterEach(() => {
    vi.useRealTimers();
    resetChildCompletionFinalizers();
    resetExecTransitionState();
    if (tmpDir) {
      envOverrides.workspaceRoot = "";
    }
  });

  it("recovery schedules a pending durable record and delivers when completion file appears", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-recovery-"));
    envOverrides.workspaceRoot = tmpDir;

    const taskStatePath = writeTaskState(tmpDir, [{
      id: "wc-recover-1",
      workContractId: "wc-recover-1",
      work_contract_id: "wc-recover-1",
      taskId: "delegate-recover-1",
      task_id: "delegate-recover-1",
      nativeTaskId: "native-recover-1",
      native_task_id: "native-recover-1",
      route: "delegate",
      sessionKey: "slack:channel:C999",
      session_key: "slack:channel:C999",
      childSessionKey: "child-recover-1",
      child_session_key: "child-recover-1",
      dispatchExecuted: true,
      dispatch_executed: true,
      spawnExecuted: true,
      spawn_executed: true,
      resultMaterialized: false,
      result_materialized: false,
      status: "running",
      modelProfile: "test-recovery-model",
      model_profile: "test-recovery-model",
    }]);

    const recovery = recoverPendingChildCompletionFinalizers({
      taskStatePath,
      cwd: tmpDir,
      sendFinalMessage: async () => ({ sent: true, delivered: true }),
    });

    expect(recovery.scanned).toBe(1);
    expect(recovery.scheduled).toBe(1);
    expect(recovery.skipped).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);

    writeCompletionFile(tmpDir, "wc-recover-1", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-recover-1",
      childSessionKey: "child-recover-1",
      delegateTaskId: "delegate-recover-1",
      status: "success",
      summary: "Recovered task completed successfully",
      completedAt: new Date().toISOString(),
    });

    await vi.advanceTimersByTimeAsync(6_000);

    const updatedState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(updatedState.tasks[0]).toMatchObject({
      id: "wc-recover-1",
      resultMaterialized: true,
      result_materialized: true,
    });
  });

  it("recovery skips already materialized or missing identity records", () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-recovery-"));
    envOverrides.workspaceRoot = tmpDir;

    const taskStatePath = writeTaskState(tmpDir, [
      {
        id: "wc-mat",
        workContractId: "wc-mat",
        route: "delegate",
        sessionKey: "slack:channel:C1",
        childSessionKey: "child-mat",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: true,
        status: "completed",
      },
      {
        id: "wc-no-child",
        workContractId: "wc-no-child",
        route: "delegate",
        sessionKey: "slack:channel:C2",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "running",
      },
      {
        id: "wc-no-parent",
        workContractId: "wc-no-parent",
        route: "delegate",
        childSessionKey: "child-no-parent",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "running",
      },
      {
        id: "wc-no-dispatch",
        workContractId: "wc-no-dispatch",
        route: "delegate",
        sessionKey: "slack:channel:C4",
        childSessionKey: "child-no-dispatch",
        dispatchExecuted: false,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "running",
      },
    ]);

    const recovery = recoverPendingChildCompletionFinalizers({ taskStatePath, cwd: tmpDir });

    expect(recovery.scanned).toBe(4);
    expect(recovery.scheduled).toBe(0);
    expect(recovery.skipped).toBe(0);
  });

  it("duplicate recovery does not create duplicate scheduling", () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-recovery-"));
    envOverrides.workspaceRoot = tmpDir;

    const taskStatePath = writeTaskState(tmpDir, [{
      id: "wc-dup",
      workContractId: "wc-dup",
      route: "delegate",
      sessionKey: "slack:channel:CDUP",
      childSessionKey: "child-dup",
      dispatchExecuted: true,
      spawnExecuted: true,
      resultMaterialized: false,
      status: "running",
    }]);

    const first = recoverPendingChildCompletionFinalizers({ taskStatePath, cwd: tmpDir });
    expect(first.scheduled).toBe(1);

    const second = recoverPendingChildCompletionFinalizers({ taskStatePath, cwd: tmpDir });
    expect(second.scheduled).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("recovery reconciles a late completion after timeout and clears stale failure fields", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-recovery-"));
    envOverrides.workspaceRoot = tmpDir;

    const taskStatePath = writeTaskState(tmpDir, [{
      id: "wc-late",
      workContractId: "wc-late",
      route: "delegate",
      sessionKey: "slack:channel:CLATE",
      childSessionKey: "child-late",
      taskId: "delegate-late",
      nativeTaskId: "native-late",
      dispatchExecuted: true,
      spawnExecuted: true,
      resultMaterialized: false,
      status: "timed_out",
      failedAt: "2026-04-30T14:53:11.000Z",
      failed_at: "2026-04-30T14:53:11.000Z",
      failureCode: "completion_file_not_written",
      failureMessage: "Worker did not write completion file within 240s",
    }]);
    writeCompletionFile(tmpDir, "wc-late", {
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: "wc-late",
      childSessionKey: "child-late",
      delegateTaskId: "delegate-late",
      status: "success",
      summary: "Late completion should win over prior timeout",
      completedAt: new Date().toISOString(),
    });

    const recovery = recoverPendingChildCompletionFinalizers({
      taskStatePath,
      cwd: tmpDir,
      sendFinalMessage: async () => ({ sent: true, delivered: true }),
    });
    expect(recovery.scanned).toBe(1);
    expect(recovery.scheduled).toBe(1);

    await vi.advanceTimersByTimeAsync(1);

    const updatedState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(updatedState.tasks[0]).toMatchObject({
      id: "wc-late",
      status: "completed",
      resultMaterialized: true,
      delivery_status: "delivered",
    });
    expect(updatedState.tasks[0]).not.toHaveProperty("failedAt");
    expect(updatedState.tasks[0]).not.toHaveProperty("failed_at");
    expect(updatedState.tasks[0]).not.toHaveProperty("failureCode");
    expect(updatedState.tasks[0]).not.toHaveProperty("failureMessage");
  });

  it("recovery skips terminal records even when resultMaterialized=false", () => {
    tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-recovery-"));
    envOverrides.workspaceRoot = tmpDir;

    const taskStatePath = writeTaskState(tmpDir, [
      {
        id: "wc-term-failed",
        workContractId: "wc-term-failed",
        route: "delegate",
        sessionKey: "slack:channel:CF",
        childSessionKey: "child-failed",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "failed",
      },
      {
        id: "wc-term-cancelled",
        workContractId: "wc-term-cancelled",
        route: "delegate",
        sessionKey: "slack:channel:CC",
        childSessionKey: "child-cancelled",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "cancelled",
      },
      {
        id: "wc-term-completed",
        workContractId: "wc-term-completed",
        route: "delegate",
        sessionKey: "slack:channel:CD",
        childSessionKey: "child-completed",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "completed",
      },
      {
        id: "wc-term-blocked",
        workContractId: "wc-term-blocked",
        route: "delegate",
        sessionKey: "slack:channel:CB",
        childSessionKey: "child-blocked",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "blocked",
      },
      {
        id: "wc-term-canceled-alt",
        workContractId: "wc-term-canceled-alt",
        route: "delegate",
        sessionKey: "slack:channel:CZ",
        childSessionKey: "child-canceled",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "canceled",
      },
      {
        id: "wc-term-timed-out",
        workContractId: "wc-term-timed-out",
        route: "delegate",
        sessionKey: "slack:channel:CT",
        childSessionKey: "child-timed-out",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "timed_out",
      },
      {
        id: "wc-term-work-contract-status",
        workContractId: "wc-term-wcs",
        route: "delegate",
        sessionKey: "slack:channel:CWS",
        childSessionKey: "child-wcs",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "running",
        workContractStatus: "failed",
      },
      {
        id: "wc-term-embedded-status",
        workContractId: "wc-term-embedded",
        route: "delegate",
        sessionKey: "slack:channel:CE",
        childSessionKey: "child-embedded",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "running",
        workContract: { status: "cancelled" },
      },
      {
        id: "wc-nonterm-running",
        workContractId: "wc-nonterm-running",
        route: "delegate",
        sessionKey: "slack:channel:CR",
        childSessionKey: "child-running",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: false,
        status: "running",
      },
    ]);

    const recovery = recoverPendingChildCompletionFinalizers({ taskStatePath, cwd: tmpDir });

    expect(recovery.scanned).toBe(9);
    expect(recovery.scheduled).toBe(1);
    expect(recovery.skipped).toBe(0);
  });
});
