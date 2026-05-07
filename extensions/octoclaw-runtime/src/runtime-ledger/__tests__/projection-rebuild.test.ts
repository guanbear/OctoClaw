import { afterEach, describe, expect, it } from "vitest";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRuntimeLedger } from "../index.js";
import {
  isTaskStateRebuildable,
  rebuildTaskStateProjection,
  writeRebuiltTaskState,
} from "../projection-rebuild.js";

interface TestFs {
  mkdtempSync(prefix: string): string;
  rmSync(p: string, opts: { recursive?: boolean; force?: boolean }): void;
  writeFileSync(p: string, data: string): void;
  readFileSync(p: string, encoding: string): string;
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
}

interface TestOs {
  tmpdir(): string;
}

const fs = fsSync as unknown as TestFs;
const osModule = os as unknown as TestOs;
const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-projection-rebuild-"));
  tmpDirs.push(dir);
  return dir;
}

function tmpDbPath(): string {
  return path.join(tmpDir(), "runtime.sqlite");
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function withDb(dbPath: string, fn: (db: NonNullable<ReturnType<typeof openRuntimeLedger>["db"]>) => void): void {
  const ledger = openRuntimeLedger({ dbPath });
  expect(ledger.status).toBe("ok");
  const db = ledger.db!;
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function seedWorkContract(dbPath: string, opts: {
  workContractId: string;
  route?: "reply" | "delegate";
  status?: string;
  complexityFinal?: string;
  deliveryTarget?: Record<string, unknown>;
  workContract?: Record<string, unknown>;
}): void {
  withDb(dbPath, (db) => {
    db.prepare(
      `INSERT INTO work_contracts (
         work_contract_id, route, intent_class, expected_deliverable, complexity_final,
         delivery_target_json, work_contract_json, status, created_at, updated_at
       ) VALUES (?, ?, 'delegated_work', 'deliverable', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z')`,
    ).run(
      opts.workContractId,
      opts.route ?? "delegate",
      opts.complexityFinal ?? "normal",
      JSON.stringify(opts.deliveryTarget ?? { kind: "completion_file" }),
      JSON.stringify(opts.workContract ?? {
        workContractId: opts.workContractId,
        route: opts.route ?? "delegate",
        sessionKey: `session-${opts.workContractId}`,
        turnId: `turn-${opts.workContractId}`,
      }),
      opts.status ?? "sealed",
    );
  });
}

function seedAttempt(dbPath: string, opts: {
  attemptId: string;
  workContractId: string;
  delegateTaskId?: string;
  attemptNo?: number;
  attemptKind?: "initial" | "retry" | "amendment" | "respawn";
  status?: string;
  nativeTaskId?: string;
  nativeFlowId?: string;
  childSessionKey?: string;
}): void {
  withDb(dbPath, (db) => {
    db.prepare(
      `INSERT INTO task_attempts (
         attempt_id, work_contract_id, delegate_task_id, attempt_no, attempt_kind,
         status, native_flow_id, native_task_id, child_session_key, child_run_id,
         model_profile, worker_pool, started_at, updated_at, attempt_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'child-run-1', 'default', 'code',
         '2026-01-01T00:02:00.000Z', ?, '{}')`,
    ).run(
      opts.attemptId,
      opts.workContractId,
      opts.delegateTaskId ?? `delegate-${opts.workContractId}`,
      opts.attemptNo ?? 1,
      opts.attemptKind ?? "initial",
      opts.status ?? "running",
      opts.nativeFlowId ?? null,
      opts.nativeTaskId ?? null,
      opts.childSessionKey ?? null,
      `2026-01-01T00:0${opts.attemptNo ?? 1}:30.000Z`,
    );
  });
}

function seedCompletionBinding(dbPath: string, opts: {
  workContractId: string;
  attemptId: string;
  verdict: string;
}): void {
  withDb(dbPath, (db) => {
    db.prepare(
      `INSERT INTO completion_bindings (
         completion_id, work_contract_id, attempt_id, expected_path,
         expected_work_contract_id, expected_delegate_task_id, verdict,
         observed_at, completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:05:00.000Z', '2026-01-01T00:05:01.000Z',
         '2026-01-01T00:04:00.000Z', '2026-01-01T00:05:01.000Z')`,
    ).run(
      `cb:${opts.workContractId}:${opts.attemptId}`,
      opts.workContractId,
      opts.attemptId,
      `/tmp/${opts.workContractId}.completion.json`,
      opts.workContractId,
      `delegate-${opts.workContractId}`,
      opts.verdict,
    );
  });
}

describe("projection-rebuild", () => {
  describe("rebuildTaskStateProjection", () => {
    it("returns empty array when ledger has no work contracts", () => {
      const dbPath = tmpDbPath();
      openRuntimeLedger({ dbPath }).db?.close();

      const projection = rebuildTaskStateProjection({ dbPath });

      expect(projection.source).toBe("ledger");
      expect(projection.rebuiltAt).toBeTruthy();
      expect(projection.tasks).toEqual([]);
    });

    it("maps work_contract fields to TaskStateRecord format", () => {
      const dbPath = tmpDbPath();
      seedWorkContract(dbPath, {
        workContractId: "wc-map",
        complexityFinal: "deep",
        deliveryTarget: { target: "completion" },
      });

      const [record] = rebuildTaskStateProjection({ dbPath }).tasks;

      expect(record.id).toBe("wc-map");
      expect(record.taskId).toBe("wc-map");
      expect(record.workContractId).toBe("wc-map");
      expect(record.work_contract_id).toBe("wc-map");
      expect(record.route).toBe("delegate");
      expect(record.status).toBe("sealed");
      expect(record.workContractStatus).toBe("sealed");
      expect(record.complexity_final).toBe("deep");
      expect(record.delivery_target).toEqual({ target: "completion" });
    });

    it("includes latest attempt info for each work contract", () => {
      const dbPath = tmpDbPath();
      seedWorkContract(dbPath, { workContractId: "wc-attempt" });
      seedAttempt(dbPath, { workContractId: "wc-attempt", attemptId: "attempt-1", attemptNo: 1, status: "queued" });
      seedAttempt(dbPath, {
        workContractId: "wc-attempt",
        attemptId: "attempt-2",
        attemptNo: 2,
        attemptKind: "retry",
        status: "running",
        nativeTaskId: "native-2",
        nativeFlowId: "flow-2",
        childSessionKey: "child-2",
      });

      const [record] = rebuildTaskStateProjection({ dbPath }).tasks;

      expect(record.attempt_id).toBe("attempt-2");
      expect(record.delegate_task_id).toBe("delegate-wc-attempt");
      expect(record.native_task_id).toBe("native-2");
      expect(record.child_session_key).toBe("child-2");
      expect(record.attempt_kind).toBe("retry");
      expect(record.status).toBe("running");
    });

    it("includes completion verdict when available", () => {
      const dbPath = tmpDbPath();
      seedWorkContract(dbPath, { workContractId: "wc-verdict" });
      seedAttempt(dbPath, { workContractId: "wc-verdict", attemptId: "attempt-verdict" });
      seedCompletionBinding(dbPath, { workContractId: "wc-verdict", attemptId: "attempt-verdict", verdict: "matched" });

      const [record] = rebuildTaskStateProjection({ dbPath }).tasks;

      expect(record.completionVerdict).toBe("matched");
      expect(record.completion_verdict).toBe("matched");
      expect(record.completion_binding).toMatchObject({ verdict: "matched" });
    });

    it("skips terminal work contracts (completed, canceled, failed)", () => {
      const dbPath = tmpDbPath();
      seedWorkContract(dbPath, { workContractId: "wc-active", status: "sealed" });
      seedWorkContract(dbPath, { workContractId: "wc-completed", status: "completed" });
      seedWorkContract(dbPath, { workContractId: "wc-canceled", status: "canceled" });
      seedWorkContract(dbPath, { workContractId: "wc-failed", status: "failed" });

      expect(rebuildTaskStateProjection({ dbPath }).tasks.map((record) => record.workContractId)).toEqual(["wc-active"]);
    });
  });

  describe("writeRebuiltTaskState", () => {
    it("creates new task-state.json when none exists", () => {
      const dir = tmpDir();
      const dbPath = path.join(dir, "runtime.sqlite");
      const taskStatePath = path.join(dir, "task-state.json");
      seedWorkContract(dbPath, { workContractId: "wc-write" });

      const result = writeRebuiltTaskState({ dbPath, taskStatePath });

      expect(result).toMatchObject({ written: true, path: taskStatePath, taskCount: 1 });
      const parsed = JSON.parse(fs.readFileSync(taskStatePath, "utf-8")) as { tasks: Array<Record<string, unknown>>; source: string };
      expect(parsed.source).toBe("ledger");
      expect(parsed.tasks[0].workContractId).toBe("wc-write");
    });

    it("quarantines corrupt cache before writing rebuilt projection", () => {
      const dir = tmpDir();
      const dbPath = path.join(dir, "runtime.sqlite");
      const taskStatePath = path.join(dir, "task-state.json");
      fs.writeFileSync(taskStatePath, "{not json");
      seedWorkContract(dbPath, { workContractId: "wc-corrupt-rebuild" });

      const result = writeRebuiltTaskState({ dbPath, taskStatePath });
      const parsed = JSON.parse(fs.readFileSync(taskStatePath, "utf-8")) as { tasks: Array<Record<string, unknown>>; source: string };

      expect(result).toMatchObject({ written: true, taskCount: 1, quarantined: true });
      expect(parsed.source).toBe("ledger");
      expect(parsed.tasks[0].workContractId).toBe("wc-corrupt-rebuild");
      expect(fs.readdirSync(dir).some((entry) => entry.startsWith("task-state.json.corrupt."))).toBe(true);
    });

    it("does not merge stale cache records when cache is corrupt", () => {
      const dir = tmpDir();
      const dbPath = path.join(dir, "runtime.sqlite");
      const taskStatePath = path.join(dir, "task-state.json");
      fs.writeFileSync(taskStatePath, "{bad json with stale cache");
      seedWorkContract(dbPath, { workContractId: "wc-ledger-only" });

      const result = writeRebuiltTaskState({ dbPath, taskStatePath });
      const parsed = JSON.parse(fs.readFileSync(taskStatePath, "utf-8")) as { tasks: Array<Record<string, unknown>> };

      expect(result.written).toBe(true);
      expect(parsed.tasks.map((record) => record.workContractId)).toEqual(["wc-ledger-only"]);
    });

    it("merges with existing task-state.json (keeps non-ledger records)", () => {
      const dir = tmpDir();
      const dbPath = path.join(dir, "runtime.sqlite");
      const taskStatePath = path.join(dir, "task-state.json");
      fs.writeFileSync(taskStatePath, JSON.stringify({
        tasks: [
          { id: "legacy", workContractId: "legacy", status: "legacy" },
          { id: "wc-ledger", workContractId: "wc-ledger", status: "old" },
        ],
      }));
      seedWorkContract(dbPath, { workContractId: "wc-ledger", status: "sealed" });

      const result = writeRebuiltTaskState({ dbPath, taskStatePath });
      const parsed = JSON.parse(fs.readFileSync(taskStatePath, "utf-8")) as { tasks: Array<Record<string, unknown>> };

      expect(result.taskCount).toBe(2);
      expect(parsed.tasks.map((record) => record.workContractId)).toEqual(["wc-ledger", "legacy"]);
      expect(parsed.tasks[0].status).toBe("sealed");
    });

    it("writes atomically", () => {
      const dir = tmpDir();
      const dbPath = path.join(dir, "runtime.sqlite");
      const taskStatePath = path.join(dir, "task-state.json");
      seedWorkContract(dbPath, { workContractId: "wc-atomic" });

      const result = writeRebuiltTaskState({ dbPath, taskStatePath });

      expect(result.written).toBe(true);
      expect(fs.existsSync(taskStatePath)).toBe(true);
      expect(fs.readdirSync(dir).filter((entry) => entry.includes("task-state.json.tmp"))).toEqual([]);
    });
  });

  describe("isTaskStateRebuildable", () => {
    it("returns false when ledger is empty", () => {
      const dbPath = tmpDbPath();
      openRuntimeLedger({ dbPath }).db?.close();

      expect(isTaskStateRebuildable({ dbPath })).toEqual({
        rebuildable: false,
        workContractCount: 0,
        attemptCount: 0,
      });
    });

    it("returns true with counts when ledger has data", () => {
      const dbPath = tmpDbPath();
      seedWorkContract(dbPath, { workContractId: "wc-count" });
      seedAttempt(dbPath, { workContractId: "wc-count", attemptId: "attempt-count" });

      expect(isTaskStateRebuildable({ dbPath })).toEqual({
        rebuildable: true,
        workContractCount: 1,
        attemptCount: 1,
      });
    });
  });
});
