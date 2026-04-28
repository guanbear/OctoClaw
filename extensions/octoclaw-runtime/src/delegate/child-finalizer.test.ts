import fsSync from "node:fs";
import path from "node:path";

const fsTest = fsSync as unknown as { mkdtempSync(prefix: string): string };
import { describe, expect, it } from "vitest";
import { finalizeChildSessionOnce, findChildFinalResult } from "./child-finalizer.js";

function writeSession(dir: string, lines: unknown[]): string {
  fsSync.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "child.jsonl");
  fsSync.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
  return file;
}

describe("child completion finalizer", () => {
  it("extracts only the final assistant result packet from a child session", () => {
    const dir = fsTest.mkdtempSync(path.join("/tmp", "octoclaw-child-final-"));
    writeSession(dir, [
      { type: "session", id: "child" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "[OctoClaw Delegated Task]\nchildSessionKey: child-key\ndelegateTaskId: delegate-1\nworkContractId: wc-1\nDo work" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "[thinking] [toolCall]" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "任务状态字段：status、elapsed、model、artifact refs。" }] } },
    ]);

    const result = findChildFinalResult({ sessionsDir: dir, childSessionKey: "child-key", delegateTaskId: "delegate-1", workContractId: "wc-1", sessionFallbackIdleMs: 0 });
    expect(result?.text).toContain("任务状态字段");
    expect(result?.text).not.toContain("toolCall");
  });

  it("materializes and sends a compact final result without raw transcript", async () => {
    const dir = fsTest.mkdtempSync(path.join("/tmp", "octoclaw-child-final-"));
    const taskStatePath = path.join(dir, "task-state.json");
    writeSession(dir, [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "[OctoClaw Delegated Task]\nchildSessionKey: child-key\ndelegateTaskId: delegate-1\nworkContractId: wc-1" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "任务状态面板字段包括任务、状态、字段、模型和结果位置。" }] } },
    ]);
    const sent: string[] = [];
    const result = await finalizeChildSessionOnce({
      sessionsDir: dir,
      taskStatePath,
      childSessionKey: "child-key",
      delegateTaskId: "delegate-1",
      workContractId: "wc-1",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-1",
      sessionFallbackIdleMs: 0,
      recordReplay: false,
      sendFinalMessage: async ({ message }) => {
        sent.push(message);
        return { sent: true, delivered: true };
      },
    });

    expect(result.status).toBe("completed");
    expect(sent[0]).toContain("子任务完成");
    expect(sent[0]).toContain("resultMaterialized=true");
    expect(sent[0]).not.toContain("rawTranscript");
    const taskState = JSON.parse(fsSync.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({ id: "native-1", status: "completed", resultMaterialized: true, report_path: "child_session:child-key" });
  });

  it("does not materialize an active child session before the result packet is stable", async () => {
    const dir = fsTest.mkdtempSync(path.join("/tmp", "octoclaw-child-final-"));
    const file = writeSession(dir, [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "[OctoClaw Delegated Task]\nchildSessionKey: child-key\ndelegateTaskId: delegate-1\nworkContractId: wc-1" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Now let me inspect the status renderer before finalizing." }] } },
    ]);
    const active = await finalizeChildSessionOnce({
      sessionsDir: dir,
      childSessionKey: "child-key",
      delegateTaskId: "delegate-1",
      workContractId: "wc-1",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-1",
      sessionFallbackIdleMs: 60_000,
      recordReplay: false,
      sendFinalMessage: async () => ({ sent: true, delivered: true }),
    });
    expect(active.status).toBe("pending");

    fsSync.writeFileSync(file, fsSync.readFileSync(file, "utf-8") + JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "renderer files inspected" }] } }) + "\n", "utf-8");
    fsSync.writeFileSync(file, fsSync.readFileSync(file, "utf-8") + JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "任务状态面板字段包括任务、状态、字段、模型、耗时和结果位置。" }] } }) + "\n", "utf-8");
    const completed = await finalizeChildSessionOnce({
      sessionsDir: dir,
      childSessionKey: "child-key",
      delegateTaskId: "delegate-1",
      workContractId: "wc-1",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-1",
      sessionFallbackIdleMs: 0,
      recordReplay: false,
      sendFinalMessage: async () => ({ sent: true, delivered: true }),
    });
    expect(completed.status).toBe("completed");
    expect(completed.resultText).toContain("结果位置");
  });


  it("does not treat a parent session dispatch receipt as a child result", () => {
    const dir = fsTest.mkdtempSync(path.join("/tmp", "octoclaw-child-final-"));
    writeSession(dir, [
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "dispatch childSessionKey=child-key delegateTaskId=delegate-1 workContractId=wc-1" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "这是父会话里的其它回答，不是子任务结果。" }] } },
    ]);

    const result = findChildFinalResult({ sessionsDir: dir, childSessionKey: "child-key", delegateTaskId: "delegate-1", workContractId: "wc-1", sessionFallbackIdleMs: 0 });
    expect(result).toBeNull();
  });

  it("uses runtime waitForRun/getSessionMessages before session-file fallback", async () => {
    const dir = fsTest.mkdtempSync(path.join("/tmp", "octoclaw-child-final-"));
    const sent: string[] = [];
    const result = await finalizeChildSessionOnce({
      sessionsDir: dir,
      childSessionKey: "child-runtime",
      delegateTaskId: "delegate-runtime",
      workContractId: "wc-runtime",
      parentSessionKey: "slack:channel:C123",
      nativeTaskId: "native-runtime",
      runId: "run-runtime",
      recordReplay: false,
      runtime: {
        waitForRun: async () => ({ status: "ok" }),
        getSessionMessages: async () => ({
          messages: [
            { role: "assistant", content: [{ type: "text", text: "运行时结果包：任务、状态、字段、模型、结果位置均已梳理。" }] },
          ],
        }),
      },
      sendFinalMessage: async ({ message }) => {
        sent.push(message);
        return { sent: true, delivered: true };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.sessionFile).toBeUndefined();
    expect(sent[0]).toContain("运行时结果包");
  });

});
