import fsSync from "node:fs";
import path from "node:path";

const fs = fsSync as unknown as { mkdtempSync(prefix: string): string; mkdirSync(pathname: string, options?: { recursive?: boolean }): void; readFileSync(pathname: string, encoding: string): string; writeFileSync(pathname: string, data: string, encoding: string): void };
import { afterEach, describe, expect, it, vi } from "vitest";
import { envOverrides } from "../resolve/env.js";
import { finalizeChildSessionOnce, scheduleChildCompletionFinalizer } from "./child-finalizer.js";

function writeCompletionFile(workspaceRoot: string, workContractId: string, completion: Record<string, unknown>): string {
  const completionDir = path.join(workspaceRoot, ".octoclaw", "completions");
  fs.mkdirSync(completionDir, { recursive: true });
  const filePath = path.join(completionDir, `${workContractId}.completion.json`);
  fs.writeFileSync(filePath, JSON.stringify(completion, null, 2), "utf-8");
  return filePath;
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
