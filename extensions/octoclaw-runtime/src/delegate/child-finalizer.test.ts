import fsSync from "node:fs";
import path from "node:path";

const fs = fsSync as unknown as { mkdtempSync(prefix: string): string; mkdirSync(pathname: string, options?: { recursive?: boolean }): void; readFileSync(pathname: string, encoding: string): string; writeFileSync(pathname: string, data: string, encoding: string): void };
import { afterEach, describe, expect, it, vi } from "vitest";
import { envOverrides } from "../resolve/env.js";
import { finalizeChildSessionOnce, scheduleChildCompletionFinalizer, recoverPendingChildCompletionFinalizers, resetChildCompletionFinalizers } from "./child-finalizer.js";

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

describe("child completion finalizer — completion file protocol", () => {
  let tmpDir = "";

  afterEach(() => {
    vi.useRealTimers();
    if (tmpDir) {
      envOverrides.workspaceRoot = "";
    }
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

  it("returns missing_identity when workContractId is empty", async () => {
    const result = await finalizeChildSessionOnce({
      childSessionKey: "",
      delegateTaskId: "",
      workContractId: "",
      parentSessionKey: "",
    });

    expect(result.status).toBe("missing_identity");
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

    scheduleChildCompletionFinalizer({
      taskStatePath,
      childSessionKey: "child-timeout",
      delegateTaskId: "delegate-timeout",
      workContractId: "wc-timeout",
      parentSessionKey: "slack:channel:C123",
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
    expect(sent[0]).toContain("❌");
    expect(sent[0]).toContain("TypeScript compilation failed");
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

    expect(recovery.scanned).toBe(8);
    expect(recovery.scheduled).toBe(1);
    expect(recovery.skipped).toBe(0);
  });
});
