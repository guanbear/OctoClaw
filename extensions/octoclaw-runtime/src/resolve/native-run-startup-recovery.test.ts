import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDeliveryOutbox } from "./delivery-outbox.js";
import {
  readPendingNativeTaskRuns,
  recoverNativeRunsOnGatewayStart,
  resolveNativeTaskRunsSqlitePath,
} from "./native-run-startup-recovery.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

describe("native run startup recovery", () => {
  it("reads succeeded pending task_runs rows with structured terminal result", () => {
    const dbPath = createRunsDb();
    insertTaskRun(dbPath, {
      taskId: "task-1",
      runId: "run-1",
      status: "succeeded",
      deliveryStatus: "pending",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:slack:default:direct:user:thread:1",
      terminalSummary: "完成：key 有效。",
    });
    insertTaskRun(dbPath, {
      taskId: "task-2",
      runId: "run-2",
      status: "succeeded",
      deliveryStatus: "delivered",
      terminalSummary: "already sent",
    });

    expect(readPendingNativeTaskRuns({ dbPath })).toMatchObject([{
      taskId: "task-1",
      runId: "run-1",
      status: "succeeded",
      deliveryStatus: "pending",
      resultText: "完成：key 有效。",
    }]);
  });

  it("persists outbox before IM redelivery and marks sqlite delivered after send", async () => {
    const dbPath = createRunsDb();
    insertTaskRun(dbPath, {
      taskId: "task-1",
      runId: "run-1",
      status: "succeeded",
      deliveryStatus: "pending",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:slack:default:direct:user:thread:1",
      terminalSummary: "完成：key 有效。",
    });
    const outbox = createDeliveryOutbox();
    const sent: Array<{ sessionKey: string; message: string; outboxCountAtSend: number }> = [];

    const result = await recoverNativeRunsOnGatewayStart({
      dbPath,
      outbox,
      sendMessage: async (params) => {
        sent.push({
          sessionKey: params.sessionKey,
          message: params.message,
          outboxCountAtSend: outbox.listPending().length,
        });
        return { sent: true, messageId: "m-1" };
      },
      now: new Date("2026-05-26T06:30:00.000Z"),
    });

    expect(result.deliveredCount).toBe(1);
    expect(sent).toEqual([{
      sessionKey: "agent:main:slack:default:direct:user:thread:1",
      message: "完成：key 有效。",
      outboxCountAtSend: 1,
    }]);
    expect(outbox.list()[0]).toMatchObject({ status: "delivered", deliveredAt: "2026-05-26T06:30:00.000Z" });
    expect(readDeliveryStatus(dbPath, "task-1")).toBe("delivered");
  });

  it("resolves the native task registry path override", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octoclaw-openclaw-home-"));
    const previousRunsPath = process.env.OCTOCLAW_NATIVE_RUNS_SQLITE_PATH;
    const dbPath = path.join(dir, "custom-runs.sqlite");
    process.env.OCTOCLAW_NATIVE_RUNS_SQLITE_PATH = dbPath;
    try {
      expect(resolveNativeTaskRunsSqlitePath()).toBe(dbPath);
    } finally {
      process.env.OCTOCLAW_NATIVE_RUNS_SQLITE_PATH = previousRunsPath;
    }
  });
});

function createRunsDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octoclaw-runs-sqlite-"));
  const dbPath = path.join(dir, "runs.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE task_runs (
      task_id TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      source_id TEXT,
      owner_key TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      child_session_key TEXT,
      parent_task_id TEXT,
      agent_id TEXT,
      run_id TEXT,
      label TEXT,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      last_event_at INTEGER,
      cleanup_after INTEGER,
      error TEXT,
      progress_summary TEXT,
      terminal_summary TEXT,
      terminal_outcome TEXT,
      parent_flow_id TEXT,
      requester_session_key TEXT,
      task_kind TEXT
    );
  `);
  db.close();
  return dbPath;
}

function insertTaskRun(dbPath: string, input: {
  taskId: string;
  runId: string;
  status: string;
  deliveryStatus: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  terminalSummary?: string;
  error?: string;
}): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, owner_key, scope_kind, child_session_key, agent_id,
      run_id, task, status, delivery_status, notify_policy, created_at,
      requester_session_key, terminal_summary, error
    ) VALUES (?, 'subagent', ?, 'user', ?, 'main', ?, 'task', ?, ?, 'requester', 1779772918000, ?, ?, ?)
  `).run(
    input.taskId,
    input.requesterSessionKey || "agent:main:slack:default:direct:user:thread:1",
    input.childSessionKey || "",
    input.runId,
    input.status,
    input.deliveryStatus,
    input.requesterSessionKey || "",
    input.terminalSummary || "",
    input.error || "",
  );
  db.close();
}

function readDeliveryStatus(dbPath: string, taskId: string): string {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT delivery_status FROM task_runs WHERE task_id = ?").get(taskId);
  db.close();
  return String(row?.delivery_status ?? "");
}
