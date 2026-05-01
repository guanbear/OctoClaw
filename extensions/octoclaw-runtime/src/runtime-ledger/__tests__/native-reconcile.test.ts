import { describe, it, expect, afterEach } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { openRuntimeLedger } from "../index.js";
import {
  reconcileAllNonTerminal,
  reconcileAttempt,
  type NativeLifecycleState,
} from "../native-reconcile.js";

interface TestFs {
  mkdtempSync(prefix: string): string;
  rmSync(p: string, opts: { recursive?: boolean; force?: boolean }): void;
}

interface TestOs {
  tmpdir(): string;
}

const fs = fsSync as unknown as TestFs;
const osModule = os as unknown as TestOs;
const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-native-reconcile-"));
  tmpDirs.push(dir);
  return path.join(dir, "runtime.sqlite");
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function nativeState(overrides: Partial<NativeLifecycleState> = {}): NativeLifecycleState {
  return {
    flowExists: true,
    flowStatus: "running",
    taskExists: true,
    taskStatus: "running",
    childSessionKey: null,
    childRunId: null,
    terminalOutcome: null,
    terminalSummary: null,
    ...overrides,
  };
}

function seedAttempt(
  dbPath: string,
  suffix: string,
  opts: { status?: string; nativeFlowId?: string | null; nativeTaskId?: string | null; childSessionKey?: string | null } = {},
): { workContractId: string; attemptId: string; nativeFlowId: string | null; nativeTaskId: string | null } {
  const workContractId = `wc-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const nativeFlowId = opts.nativeFlowId === undefined ? `flow-${suffix}` : opts.nativeFlowId;
  const nativeTaskId = opts.nativeTaskId === undefined ? `task-${suffix}` : opts.nativeTaskId;
  const ledger = openRuntimeLedger({ dbPath });
  expect(ledger.status).toBe("ok");
  const db = ledger.db!;
  try {
    db.prepare(
      `INSERT INTO work_contracts (
         work_contract_id, route, work_contract_json, status, created_at, updated_at
       ) VALUES (?, 'delegate', '{}', 'sealed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(workContractId);
    db.prepare(
      `INSERT INTO task_attempts (
         attempt_id, work_contract_id, delegate_task_id, attempt_no, attempt_kind,
         status, native_flow_id, native_task_id, child_session_key, updated_at, attempt_json
       ) VALUES (?, ?, ?, 1, 'initial', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '{}')`,
    ).run(attemptId, workContractId, `delegate-${suffix}`, opts.status ?? "running", nativeFlowId, nativeTaskId, opts.childSessionKey ?? null);
  } finally {
    db.close();
  }
  return { workContractId, attemptId, nativeFlowId, nativeTaskId };
}

function getAttempt(dbPath: string, attemptId: string): Record<string, unknown> {
  const ledger = openRuntimeLedger({ dbPath });
  expect(ledger.status).toBe("ok");
  try {
    return ledger.db!.prepare(`SELECT * FROM task_attempts WHERE attempt_id = ?`).get(attemptId)!;
  } finally {
    ledger.db!.close();
  }
}

describe("native-reconcile", () => {
  describe("reconcileAttempt", () => {
    it("spawn confirmed when flow and task both exist", () => {
      const dbPath = tmpDbPath();
      const attempt = seedAttempt(dbPath, "flow-task");

      const result = reconcileAttempt({ ...attempt, dbPath, nativeState: nativeState() });

      expect(result.reconciled).toBe(true);
      expect(result.spawnConfirmed).toBe(true);
      expect(result.previousStatus).toBe("running");
      expect(result.newStatus).toBeNull();
    });

    it("spawn confirmed when flow exists with child session key", () => {
      const dbPath = tmpDbPath();
      const attempt = seedAttempt(dbPath, "child", { nativeTaskId: null });

      const result = reconcileAttempt({
        ...attempt,
        dbPath,
        nativeState: nativeState({ taskExists: false, childSessionKey: "child-session-1", childRunId: "run-1" }),
      });

      expect(result.spawnConfirmed).toBe(true);
      const row = getAttempt(dbPath, attempt.attemptId);
      expect(row.child_session_key).toBe("child-session-1");
      expect(row.child_run_id).toBe("run-1");
    });

    it("not spawn confirmed when only flow exists (no task, no child session)", () => {
      const dbPath = tmpDbPath();
      const attempt = seedAttempt(dbPath, "flow-only", { nativeTaskId: null });

      const result = reconcileAttempt({
        ...attempt,
        dbPath,
        nativeState: nativeState({ taskExists: false, childSessionKey: null }),
      });

      expect(result.spawnConfirmed).toBe(false);
      expect(result.newStatus).toBe("dispatch_materialized_but_no_spawn_evidence");
      expect(getAttempt(dbPath, attempt.attemptId).status).toBe("dispatch_materialized_but_no_spawn_evidence");
    });

    it("not spawn confirmed when neither flow nor task exists", () => {
      const dbPath = tmpDbPath();
      const attempt = seedAttempt(dbPath, "missing-all");

      const result = reconcileAttempt({
        ...attempt,
        dbPath,
        nativeState: nativeState({ flowExists: false, taskExists: false }),
      });

      expect(result.spawnConfirmed).toBe(false);
      expect(result.newStatus).toBe("binding_mismatch");
    });

    it("updates terminal outcome from native state", () => {
      const dbPath = tmpDbPath();
      const attempt = seedAttempt(dbPath, "terminal");

      const result = reconcileAttempt({
        ...attempt,
        dbPath,
        nativeState: nativeState({ taskStatus: "completed", terminalOutcome: "completed", terminalSummary: "done" }),
      });

      expect(result.terminalOutcome).toBe("completed");
      expect(result.newStatus).toBe("completed");
      const row = getAttempt(dbPath, attempt.attemptId);
      expect(row.status).toBe("completed");
      expect(row.terminal_outcome).toBe("completed");
      expect(row.terminal_summary).toBe("done");
      expect(row.ended_at).toBeTruthy();
    });

    it("marks binding_mismatch when native IDs point to missing rows", () => {
      const dbPath = tmpDbPath();
      const attempt = seedAttempt(dbPath, "mismatch");

      const result = reconcileAttempt({
        ...attempt,
        dbPath,
        nativeState: nativeState({ flowExists: true, taskExists: false }),
      });

      expect(result.spawnConfirmed).toBe(false);
      expect(result.newStatus).toBe("binding_mismatch");
      expect(getAttempt(dbPath, attempt.attemptId).status).toBe("binding_mismatch");
    });

    it("no-op when native state is null (bridge unavailable)", () => {
      const dbPath = tmpDbPath();
      const attempt = seedAttempt(dbPath, "no-bridge");

      const result = reconcileAttempt({ ...attempt, dbPath, nativeState: null });

      expect(result.reconciled).toBe(false);
      expect(result.spawnConfirmed).toBe(false);
      expect(getAttempt(dbPath, attempt.attemptId).status).toBe("running");
    });

    it("idempotent on re-reconciliation", () => {
      const dbPath = tmpDbPath();
      const attempt = seedAttempt(dbPath, "idempotent");
      const state = nativeState({ terminalOutcome: "completed", terminalSummary: "done" });

      const first = reconcileAttempt({ ...attempt, dbPath, nativeState: state });
      const second = reconcileAttempt({ ...attempt, dbPath, nativeState: state });

      expect(first.reconciled).toBe(true);
      expect(second.reconciled).toBe(true);
      expect(getAttempt(dbPath, attempt.attemptId).terminal_outcome).toBe("completed");
    });
  });

  describe("reconcileAllNonTerminal", () => {
    it("reconciles multiple non-terminal attempts", () => {
      const dbPath = tmpDbPath();
      seedAttempt(dbPath, "all-a");
      seedAttempt(dbPath, "all-b", { nativeTaskId: null });

      const result = reconcileAllNonTerminal({
        dbPath,
        queryNativeState: attempt => nativeState({
          taskExists: attempt.nativeTaskId !== null,
          childSessionKey: attempt.nativeTaskId === null ? "child-all-b" : null,
        }),
      });

      expect(result.totalAttempts).toBe(2);
      expect(result.reconciled).toBe(2);
      expect(result.spawnConfirmed).toBe(2);
      expect(result.errors).toEqual([]);
    });

    it("skips attempts without native IDs", () => {
      const dbPath = tmpDbPath();
      seedAttempt(dbPath, "without-native", { nativeFlowId: null, nativeTaskId: null });

      const result = reconcileAllNonTerminal({
        dbPath,
        queryNativeState: () => {
          throw new Error("should_not_query");
        },
      });

      expect(result.totalAttempts).toBe(1);
      expect(result.reconciled).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("returns summary stats", () => {
      const dbPath = tmpDbPath();
      seedAttempt(dbPath, "stats-a");
      seedAttempt(dbPath, "stats-b");

      const result = reconcileAllNonTerminal({
        dbPath,
        queryNativeState: attempt => attempt.nativeTaskId === "task-stats-a"
          ? nativeState({ terminalOutcome: "completed", terminalSummary: "done" })
          : nativeState({ flowExists: true, taskExists: false }),
      });

      expect(result.totalAttempts).toBe(2);
      expect(result.reconciled).toBe(2);
      expect(result.spawnConfirmed).toBe(1);
      expect(result.terminalUpdated).toBe(1);
    });

    it("handles query errors gracefully", () => {
      const dbPath = tmpDbPath();
      seedAttempt(dbPath, "error-a");
      seedAttempt(dbPath, "error-b");

      const result = reconcileAllNonTerminal({
        dbPath,
        queryNativeState: attempt => {
          if (attempt.nativeTaskId === "task-error-a") throw new Error("native unavailable");
          return nativeState();
        },
      });

      expect(result.totalAttempts).toBe(2);
      expect(result.reconciled).toBe(1);
      expect(result.spawnConfirmed).toBe(1);
      expect(result.errors).toEqual(["native unavailable"]);
    });
  });
});
