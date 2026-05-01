import { describe, it, expect, afterEach } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { openRuntimeLedger } from "../index.js";
import {
  createCompletionBinding,
  getCompletionBinding,
  listCompletionBindingsByVerdict,
  listOrphanedCompletionBindings,
  observeCompletionBinding,
  scanOrphanCompletions,
} from "../completion-binding.js";

interface TestFs {
  mkdtempSync(prefix: string): string;
  rmSync(p: string, opts: { recursive?: boolean; force?: boolean }): void;
  mkdirSync(p: string, opts?: { recursive?: boolean }): string | undefined;
  writeFileSync(p: string, data: string): void;
}

interface TestOs {
  tmpdir(): string;
}

const fs = fsSync as unknown as TestFs;
const osModule = os as unknown as TestOs;
const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-completion-binding-"));
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

function seedParents(dbPath: string, workContractId: string, attemptId = `attempt-${workContractId}`, delegateTaskId = `delegate-${workContractId}`): void {
  const ledger = openRuntimeLedger({ dbPath });
  expect(ledger.status).toBe("ok");
  const db = ledger.db!;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO work_contracts (
         work_contract_id, route, work_contract_json, status, created_at, updated_at
       ) VALUES (?, 'delegate', '{}', 'sealed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(workContractId);
    db.prepare(
      `INSERT OR IGNORE INTO task_attempts (
         attempt_id, work_contract_id, delegate_task_id, attempt_no, attempt_kind,
         status, updated_at, attempt_json
       ) VALUES (?, ?, ?, 1, 'initial', 'running', '2026-01-01T00:00:00.000Z', '{}')`,
    ).run(attemptId, workContractId, delegateTaskId);
  } finally {
    db.close();
  }
}

function createBinding(dbPath: string, suffix: string, expectedPath?: string): string {
  const workContractId = `wc-${suffix}`;
  seedParents(dbPath, workContractId);
  const result = createCompletionBinding({
    workContractId,
    attemptId: `attempt-${workContractId}`,
    expectedDelegateTaskId: `delegate-${workContractId}`,
    expectedNativeTaskId: `native-${suffix}`,
    expectedChildSessionKey: `child-${suffix}`,
    expectedPath: expectedPath ?? `/tmp/${workContractId}.completion.json`,
    dbPath,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  expect(result.ok).toBe(true);
  return result.completionId;
}

describe("createCompletionBinding", () => {
  it("creates row with expected fields", () => {
    const dbPath = tmpDbPath();
    const completionId = createBinding(dbPath, "create");

    const row = getCompletionBinding({ completionId, dbPath });
    expect(row?.completion_id).toBe("cb:wc-create:attempt-wc-create");
    expect(row?.work_contract_id).toBe("wc-create");
    expect(row?.attempt_id).toBe("attempt-wc-create");
    expect(row?.expected_path).toBe("/tmp/wc-create.completion.json");
    expect(row?.expected_work_contract_id).toBe("wc-create");
    expect(row?.expected_delegate_task_id).toBe("delegate-wc-create");
    expect(row?.expected_native_task_id).toBe("native-create");
    expect(row?.expected_child_session_key).toBe("child-create");
    expect(row?.verdict).toBe("pending");
  });

  it("is idempotent on duplicate completion_id", () => {
    const dbPath = tmpDbPath();
    const completionId = createBinding(dbPath, "dupe", "/tmp/first.completion.json");
    const second = createCompletionBinding({
      workContractId: "wc-dupe",
      attemptId: "attempt-wc-dupe",
      expectedDelegateTaskId: "delegate-wc-dupe",
      expectedPath: "/tmp/second.completion.json",
      dbPath,
    });

    expect(second.ok).toBe(true);
    expect(second.completionId).toBe(completionId);
    const rows = listCompletionBindingsByVerdict("pending", { dbPath });
    expect(rows).toHaveLength(1);
    expect(rows[0].expected_path).toBe("/tmp/second.completion.json");
    expect(rows[0].revision).toBe(1);
  });
});

describe("observeCompletionBinding", () => {
  it("sets matched when all IDs match", () => {
    const dbPath = tmpDbPath();
    const completionId = createBinding(dbPath, "match");

    const result = observeCompletionBinding({
      workContractId: "wc-match",
      completionFilePath: "/tmp/wc-match.completion.json",
      observedCompletion: {
        workContractId: "wc-match",
        delegateTaskId: "delegate-wc-match",
        nativeTaskId: "native-match",
        childSessionKey: "child-match",
      },
      dbPath,
    });

    expect(result.verdict).toBe("matched");
    expect(result.completionId).toBe(completionId);
    const row = getCompletionBinding({ completionId, dbPath });
    expect(row?.observed_work_contract_id).toBe("wc-match");
    expect(row?.observed_delegate_task_id).toBe("delegate-wc-match");
    expect(row?.observed_native_task_id).toBe("native-match");
    expect(row?.observed_child_session_key).toBe("child-match");
    expect(row?.completed_at).toBeTruthy();
  });

  it("sets completion_orphaned for empty workContractId", () => {
    const dbPath = tmpDbPath();
    const completionId = createBinding(dbPath, "empty");

    const result = observeCompletionBinding({
      workContractId: "wc-empty",
      completionFilePath: "/tmp/wc-empty.completion.json",
      observedCompletion: { workContractId: "" },
      dbPath,
    });

    expect(result.verdict).toBe("completion_orphaned");
    expect(getCompletionBinding({ completionId, dbPath })?.verdict).toBe("completion_orphaned");
  });

  it("sets binding_mismatch for wrong workContractId", () => {
    const dbPath = tmpDbPath();
    const completionId = createBinding(dbPath, "wrong");

    const result = observeCompletionBinding({
      workContractId: "wc-wrong",
      completionFilePath: "/tmp/wc-wrong.completion.json",
      observedCompletion: { workContractId: "wc-other" },
      dbPath,
    });

    expect(result.verdict).toBe("binding_mismatch");
    expect(getCompletionBinding({ completionId, dbPath })?.observed_work_contract_id).toBe("wc-other");
  });

  it("sets missing for null completion", () => {
    const dbPath = tmpDbPath();
    const completionId = createBinding(dbPath, "missing");

    const result = observeCompletionBinding({
      workContractId: "wc-missing",
      completionFilePath: "/tmp/wc-missing.completion.json",
      observedCompletion: null,
      dbPath,
    });

    expect(result.verdict).toBe("missing");
    expect(getCompletionBinding({ completionId, dbPath })?.verdict).toBe("missing");
  });

  it("is idempotent on re-observe", () => {
    const dbPath = tmpDbPath();
    const completionId = createBinding(dbPath, "reobserve");
    const input = {
      workContractId: "wc-reobserve",
      completionFilePath: "/tmp/wc-reobserve.completion.json",
      observedCompletion: { workContractId: "wc-reobserve" },
      dbPath,
    };

    expect(observeCompletionBinding(input).verdict).toBe("matched");
    expect(observeCompletionBinding(input).verdict).toBe("matched");
    expect(getCompletionBinding({ completionId, dbPath })?.completion_id).toBe(completionId);
    expect(listCompletionBindingsByVerdict("matched", { dbPath })).toHaveLength(1);
  });
});

describe("getCompletionBinding", () => {
  it("selects by completionId", () => {
    const dbPath = tmpDbPath();
    const completionId = createBinding(dbPath, "get-id");

    expect(getCompletionBinding({ completionId, dbPath })?.work_contract_id).toBe("wc-get-id");
  });

  it("selects by workContractId", () => {
    const dbPath = tmpDbPath();
    createBinding(dbPath, "get-wc");

    expect(getCompletionBinding({ workContractId: "wc-get-wc", dbPath })?.completion_id).toBe("cb:wc-get-wc:attempt-wc-get-wc");
  });
});

describe("listCompletionBindingsByVerdict", () => {
  it("filters correctly", () => {
    const dbPath = tmpDbPath();
    createBinding(dbPath, "pending-a");
    createBinding(dbPath, "matched-a");
    observeCompletionBinding({
      workContractId: "wc-matched-a",
      completionFilePath: "/tmp/wc-matched-a.completion.json",
      observedCompletion: { workContractId: "wc-matched-a" },
      dbPath,
    });

    expect(listCompletionBindingsByVerdict("pending", { dbPath }).map(row => row.work_contract_id)).toEqual(["wc-pending-a"]);
    expect(listCompletionBindingsByVerdict("matched", { dbPath }).map(row => row.work_contract_id)).toEqual(["wc-matched-a"]);
  });
});

describe("scanOrphanCompletions", () => {
  it("detects file with no binding", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "runtime.sqlite");
    const completionsDir = path.join(dir, "completions");
    fs.mkdirSync(completionsDir, { recursive: true });
    fs.writeFileSync(path.join(completionsDir, "wc-orphan.completion.json"), JSON.stringify({ workContractId: "" }));

    const result = scanOrphanCompletions({ completionsDir, dbPath });

    expect(result.scanned).toBe(1);
    expect(result.orphaned).toBe(1);
    const orphaned = listOrphanedCompletionBindings({ dbPath });
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].verdict).toBe("completion_orphaned");
  });

  it("reconciles pending bindings", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "runtime.sqlite");
    const completionsDir = path.join(dir, "completions");
    fs.mkdirSync(completionsDir, { recursive: true });
    const completionFilePath = path.join(completionsDir, "wc-scan.completion.json");
    fs.writeFileSync(completionFilePath, JSON.stringify({ workContractId: "wc-scan", delegateTaskId: "delegate-wc-scan" }));
    createBinding(dbPath, "scan", completionFilePath);

    const result = scanOrphanCompletions({ completionsDir, dbPath });

    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(getCompletionBinding({ workContractId: "wc-scan", dbPath })?.verdict).toBe("matched");
  });

  it("handles empty dir", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "runtime.sqlite");
    const completionsDir = path.join(dir, "completions");
    fs.mkdirSync(completionsDir, { recursive: true });

    expect(scanOrphanCompletions({ completionsDir, dbPath })).toEqual({
      scanned: 0,
      orphaned: 0,
      reconciled: 0,
      mismatches: 0,
    });
  });
});

describe("listOrphanedCompletionBindings", () => {
  it("returns only orphaned/mismatched", () => {
    const dbPath = tmpDbPath();
    createBinding(dbPath, "orphan-list-a");
    createBinding(dbPath, "orphan-list-b");
    createBinding(dbPath, "orphan-list-c");
    observeCompletionBinding({
      workContractId: "wc-orphan-list-a",
      completionFilePath: "/tmp/wc-orphan-list-a.completion.json",
      observedCompletion: { workContractId: "" },
      dbPath,
    });
    observeCompletionBinding({
      workContractId: "wc-orphan-list-b",
      completionFilePath: "/tmp/wc-orphan-list-b.completion.json",
      observedCompletion: { workContractId: "wc-other" },
      dbPath,
    });
    observeCompletionBinding({
      workContractId: "wc-orphan-list-c",
      completionFilePath: "/tmp/wc-orphan-list-c.completion.json",
      observedCompletion: { workContractId: "wc-orphan-list-c" },
      dbPath,
    });

    expect(listOrphanedCompletionBindings({ dbPath }).map(row => row.verdict)).toEqual([
      "completion_orphaned",
      "binding_mismatch",
    ]);
  });
});
