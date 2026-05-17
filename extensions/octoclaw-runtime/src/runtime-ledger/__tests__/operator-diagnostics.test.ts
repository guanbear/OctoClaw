import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRuntimeLedger } from "../index.js";
import { inspectLedgerHealth, operatorRebuildProjection } from "../operator-diagnostics.js";
import type { DatabaseSync } from "../types.js";

const fsSync = fs as unknown as {
  existsSync(pathname: string): boolean;
  mkdtempSync(prefix: string): string;
  rmSync(pathname: string, options?: { force?: boolean; recursive?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

const nowIso = "2026-05-01T00:00:00.000Z";
const futureIso = "2026-05-02T00:00:00.000Z";

function tempPath(name: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(osModule.tmpdir(), `octoclaw-od-test-${name}-${suffix}.sqlite`);
}

function removeSqliteFiles(dbPath: string): void {
  for (const filePath of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
    fsSync.rmSync(filePath, { force: true });
  }
}

function openTempLedger(dbPath: string): DatabaseSync {
  const result = openRuntimeLedger({ dbPath });
  expect(result.status).toBe("ok");
  if (!result.db) {
    throw new Error(result.error ?? "failed to open temp runtime ledger");
  }
  return result.db;
}

function workContractJson(workContractId: string, route: "reply" | "delegate" = "delegate"): string {
  return JSON.stringify({
    schemaVersion: "octoclaw.work_contract.v1",
    workContractId,
    turnId: `turn-${workContractId}`,
    sessionKey: `session-${workContractId}`,
    userAsk: `Complete ${workContractId}`,
    intentClass: route === "delegate" ? "delegated_work" : "plain_chat",
    route,
    status: "sealed",
    continuity: {
      threadBindingKey: `thread-${workContractId}`,
      parentSessionKey: `parent-${workContractId}`,
      continuationMode: "new_attempt",
      delegateTaskId: `task-${workContractId}`,
    },
    mainContext: {
      summary: `Summary for ${workContractId}`,
      statusLine: "sealed",
      visibleIds: { workContractId },
      artifactRefs: [],
      nextAction: route === "delegate" ? "dispatch" : "answer",
      tokenBudget: { maxResumeTokens: 700, maxArtifactSummaryTokens: 250 },
      forbiddenContent: [],
    },
    telemetry: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

function seedWorkContract(db: DatabaseSync, workContractId: string, route: "reply" | "delegate" = "delegate", status = "sealed"): void {
  db.prepare(
    `INSERT INTO work_contracts (
      work_contract_id, route, intent_class, expected_deliverable,
      delivery_target_json, work_contract_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workContractId,
    route,
    route === "delegate" ? "delegated_work" : "plain_chat",
    `deliverable-${workContractId}`,
    JSON.stringify({ id: `target-${workContractId}` }),
    workContractJson(workContractId, route),
    status,
    nowIso,
    nowIso,
  );
}

function seedAttempt(db: DatabaseSync, attemptId: string, workContractId: string, attemptNo: number, status = "queued"): void {
  db.prepare(
    `INSERT INTO task_attempts (
      attempt_id, work_contract_id, delegate_task_id, attempt_no,
      attempt_kind, status, updated_at, attempt_json
    ) VALUES (?, ?, ?, ?, 'initial', ?, ?, ?)`,
  ).run(attemptId, workContractId, `task-${workContractId}`, attemptNo, status, nowIso, JSON.stringify({ attemptId }));
}

function seedTicket(db: DatabaseSync, ticketId: string, workContractId: string): void {
  db.prepare(
    `INSERT INTO delegation_tickets (
      ticket_id, work_contract_id, turn_id, session_key, delivery_target_id,
      expected_deliverable, complexity_final, status, issued_at, expires_at, ticket_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'normal', 'issued', ?, ?, ?)`,
  ).run(
    ticketId,
    workContractId,
    `turn-${workContractId}`,
    `session-${workContractId}`,
    `target-${workContractId}`,
    `deliverable-${workContractId}`,
    nowIso,
    futureIso,
    JSON.stringify({ ticketId }),
  );
}

describe("operator-diagnostics", () => {
  const originalEnv = { ...process.env };
  let dbPath = "";
  let db: DatabaseSync | null = null;
  let workspaceRoot = "";

  beforeEach(() => {
    process.env = { ...originalEnv };
    dbPath = tempPath("ledger");
    workspaceRoot = fsSync.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-od-workspace-"));
    process.env.WORKSPACE = workspaceRoot;
  });

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (dbPath) {
      removeSqliteFiles(dbPath);
      dbPath = "";
    }
    if (workspaceRoot) {
      fsSync.rmSync(workspaceRoot, { force: true, recursive: true });
      workspaceRoot = "";
    }
    process.env = originalEnv;
  });

  describe("inspectLedgerHealth", () => {
    it("returns error report when ledger is unavailable", () => {
      const result = inspectLedgerHealth({ dbPath, sqlite: null });
      expect(result.dbOpen).toBe(false);
      expect(result.dbPath).toBe(dbPath);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("returns healthy report with counts", () => {
      db = openTempLedger(dbPath);
      for (let index = 1; index <= 5; index += 1) {
        seedWorkContract(db, `wc-${index}`);
      }
      for (let index = 1; index <= 10; index += 1) {
        const workContractId = `wc-${((index - 1) % 5) + 1}`;
        seedAttempt(db, `att-${index}`, workContractId, index <= 5 ? 1 : 2);
      }
      for (let index = 1; index <= 3; index += 1) {
        seedTicket(db, `ticket-${index}`, `wc-${index}`);
      }
      db.prepare(
        "INSERT INTO runtime_events (event_type, work_contract_id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("operator_test_event", "wc-1", "att-1", JSON.stringify({ ok: true }), nowIso);

      const result = inspectLedgerHealth({ dbPath });

      expect(result.dbOpen).toBe(true);
      expect(result.dbPath).toBe(dbPath);
      expect(result.schemaVersion).toBe(2);
      expect(result.workContractCount).toBe(5);
      expect(result.attemptCount).toBe(10);
      expect(result.ticketCount).toBe(3);
      expect(result.runtimeEventCount).toBe(1);
      expect(result.errors).toEqual([]);
    });
  });

  describe("operatorRebuildProjection", () => {
    it("returns disabled when flag is off", () => {
      db = openTempLedger(dbPath);
      process.env.OCTOCLAW_TASK_STATE_REBUILD = "0";

      const result = operatorRebuildProjection({ dbPath });

      expect(result.enabled).toBe(false);
      expect(result.rebuilt).toBe(false);
      expect(result.taskCount).toBe(0);
      expect(result.writtenAt).toBeNull();
    });

    it("attempts rebuild when flag is on", () => {
      db = openTempLedger(dbPath);
      seedWorkContract(db, "wc-1", "delegate", "queued");
      seedAttempt(db, "att-1", "wc-1", 1, "queued");
      process.env.OCTOCLAW_TASK_STATE_REBUILD = "1";

      const result = operatorRebuildProjection({ dbPath });

      expect(result.enabled).toBe(true);
      expect(result.rebuilt).toBe(true);
      expect(result.taskCount).toBe(1);
      expect(result.writtenAt).toEqual(expect.any(String));
      expect(result.error).toBeUndefined();
      expect(fsSync.existsSync(path.join(workspaceRoot, "tmp", "octopus", "task-state.json"))).toBe(true);
    });
  });
});
