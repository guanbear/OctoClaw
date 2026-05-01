import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ContextCoverageSnapshot, DelegateContract, WorkContract, NativeBindingRef } from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../../work-contract/builders.js";
import { resolveRuntimeLedgerMode, isShadowActive, mirrorWorkContractToRuntimeLedger } from "../shadow.js";
import type { SqliteProvider } from "../types.js";
import { openRuntimeLedger } from "../index.js";

interface TestFs {
  mkdtempSync(prefix: string): string;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  existsSync(p: string): boolean;
  rmSync(p: string, opts: { recursive?: boolean; force?: boolean }): void;
}

interface TestOs {
  tmpdir(): string;
}

const fs = fsSync as unknown as TestFs;
const osModule = os as unknown as TestOs;

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-shadow-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const coverage: ContextCoverageSnapshot = {
  precheckOrder: [
    "conversation_grounding", "continuation_route_reuse", "execution_coverage",
    "memory_coverage", "build_judge_context_packet", "local_judge",
    "validator_or_remote", "route_seal_commit",
  ],
  execution: { coverage: "current_turn" },
  memory: { coverage: "none" },
  conflict: false,
  authority: "execution_wins",
};

function buildDelegateContract(
  sessionKey: string,
  userAsk: string,
  delegateOverrides?: Partial<DelegateContract>,
): WorkContract {
  const base = buildWorkContractFromPolicy(
    sessionKey,
    userAsk,
    "delegated_work",
    coverage,
    buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
  );
  if (!delegateOverrides) return base;
  return {
    ...base,
    delegate: {
      delegateTaskId: delegateOverrides.delegateTaskId ?? "delegate-task-1",
      currentAttemptId: delegateOverrides.currentAttemptId ?? null,
      role: delegateOverrides.role ?? "default",
      coordinationMode: "solo_worker",
      acceptanceCriteria: [],
      scope: { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "" },
      modelProfile: "",
      nativeBinding: null,
      childSessions: [],
      artifactRefs: [],
      nextAction: "dispatch",
      ...delegateOverrides,
    },
  };
}

describe("resolveRuntimeLedgerMode", () => {
  it('returns "off" when OCTOCLAW_RUNTIME_LEDGER is unset', () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    try {
      expect(resolveRuntimeLedgerMode()).toBe("off");
    } finally {
      if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
    }
  });

  it('returns "off" for unrecognized values', () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "garbage";
    try {
      expect(resolveRuntimeLedgerMode()).toBe("off");
    } finally {
      if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
      else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    }
  });

  it('returns "shadow" for OCTOCLAW_RUNTIME_LEDGER=shadow', () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";
    try {
      expect(resolveRuntimeLedgerMode()).toBe("shadow");
    } finally {
      if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
      else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    }
  });

  it('returns "enforce" for OCTOCLAW_RUNTIME_LEDGER=enforce', () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    try {
      expect(resolveRuntimeLedgerMode()).toBe("enforce");
    } finally {
      if (original !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = original;
      else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    }
  });
});

describe("isShadowActive", () => {
  it("returns false when mode is off", () => {
    expect(isShadowActive("off")).toBe(false);
  });

  it("returns true when mode is shadow", () => {
    expect(isShadowActive("shadow")).toBe(true);
  });

  it("returns true when mode is enforce", () => {
    expect(isShadowActive("enforce")).toBe(true);
  });
});

describe("mirrorWorkContractToRuntimeLedger", () => {
  let dbPath: string;

  beforeEach(() => {
    const dir = makeTmpDir();
    dbPath = path.join(dir, "shadow-test.sqlite");
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";
    storeOriginal("OCTOCLAW_RUNTIME_LEDGER", original);
  });

  afterEach(() => {
    restoreOriginal("OCTOCLAW_RUNTIME_LEDGER");
  });

  it("returns off when ledger mode is off", () => {
    const original = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
    try {
      const contract = buildDelegateContract("session-off", "off test");
      const result = mirrorWorkContractToRuntimeLedger(contract, { dbPath });
      expect(result.status).toBe("off");
      expect(result.workContractId).toBe(contract.workContractId);
    } finally {
      process.env.OCTOCLAW_RUNTIME_LEDGER = original;
    }
  });

  it("mirrors a delegate work contract with ticket candidate and runtime events", () => {
    const contract = buildDelegateContract("session-shadow-1", "shadow mirror test", {
      delegateTaskId: "delegate-shadow-1",
      currentAttemptId: null,
    });

    const result = mirrorWorkContractToRuntimeLedger(contract, { dbPath });

    expect(result.status).toBe("ok");
    expect(result.workContractId).toBe(contract.workContractId);
    expect(result.rowsAffected).toBeGreaterThanOrEqual(1);
    expect(result.eventsAppended).toBeGreaterThanOrEqual(1);

    const ledger = openRuntimeLedger({ dbPath });
    expect(ledger.status).toBe("ok");
    const db = ledger.db!;

    const wcRow = db.prepare("SELECT * FROM work_contracts WHERE work_contract_id = ?").get(contract.workContractId);
    expect(wcRow).toBeDefined();
    expect(String(wcRow!.route)).toBe("delegate");
    expect(String(wcRow!.status)).toBe("sealed");

    const ticketRow = db.prepare("SELECT * FROM delegation_tickets WHERE work_contract_id = ?").get(contract.workContractId);
    expect(ticketRow).toBeDefined();
    expect(String(ticketRow!.ticket_id)).toBe(`candidate:${contract.workContractId}`);
    expect(String(ticketRow!.status)).toBe("issued");

    const events = db.prepare("SELECT * FROM runtime_events WHERE work_contract_id = ? ORDER BY event_id").all(contract.workContractId);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const eventTypes = events.map((e) => String(e.event_type));
    expect(eventTypes).toContain("work_contract_mirror");
    expect(eventTypes).toContain("delegation_ticket_candidate_mirror");

    db.close();
  });

  it("mirrors a task attempt when delegate has currentAttemptId and delegateTaskId", () => {
    const nativeBinding: NativeBindingRef = {
      flowId: "flow-attempt-test",
      ownerKey: "owner",
      controllerId: "octoclaw.delegate",
      revision: 1,
      expectedRevision: 1,
      nativeTaskId: "native-task-attempt",
      nativeFlowId: "flow-attempt-test",
      syncMode: "managed",
      status: "running",
      childSessionKey: "child-session-attempt",
    };

    const contract = buildDelegateContract("session-attempt", "attempt mirror test", {
      delegateTaskId: "delegate-attempt-1",
      currentAttemptId: "attempt-id-1",
      role: "code",
      modelProfile: "claude-sonnet",
      nativeBinding,
    });

    const result = mirrorWorkContractToRuntimeLedger(contract, { dbPath });

    expect(result.status).toBe("ok");
    expect(result.rowsAffected).toBeGreaterThanOrEqual(2);
    expect(result.eventsAppended).toBeGreaterThanOrEqual(3);

    const ledger = openRuntimeLedger({ dbPath });
    const db = ledger.db!;

    const attemptRow = db.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get("attempt-id-1");
    expect(attemptRow).toBeDefined();
    expect(Number(attemptRow!.attempt_no)).toBe(1);
    expect(String(attemptRow!.attempt_kind)).toBe("initial");
    expect(String(attemptRow!.delegate_task_id)).toBe("delegate-attempt-1");
    expect(String(attemptRow!.native_flow_id)).toBe("flow-attempt-test");
    expect(String(attemptRow!.native_task_id)).toBe("native-task-attempt");
    expect(String(attemptRow!.child_session_key)).toBe("child-session-attempt");
    expect(String(attemptRow!.model_profile)).toBe("claude-sonnet");
    expect(String(attemptRow!.worker_pool)).toBe("code");

    const events = db.prepare("SELECT event_type FROM runtime_events WHERE work_contract_id = ?").all(contract.workContractId);
    const eventTypes = events.map((e) => String(e.event_type));
    expect(eventTypes).toContain("task_attempt_mirror");

    db.close();
  });

  it("preserves existing attempt_no for same attempt_id on re-mirror", () => {
    const contract1 = buildDelegateContract("session-retry", "retry attempt test", {
      delegateTaskId: "delegate-retry",
      currentAttemptId: "attempt-1",
    });

    mirrorWorkContractToRuntimeLedger(contract1, { dbPath });

    const contract2 = buildDelegateContract("session-retry-2", "second attempt test", {
      delegateTaskId: "delegate-retry",
      currentAttemptId: "attempt-2",
    });

    const ledger = openRuntimeLedger({ dbPath });
    const db = ledger.db!;

    const wcRow = db.prepare("SELECT work_contract_id FROM work_contracts WHERE work_contract_id = ?").get(contract1.workContractId);
    expect(wcRow).toBeDefined();

    const attempt1 = db.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get("attempt-1");
    expect(attempt1).toBeDefined();

    db.close();

    mirrorWorkContractToRuntimeLedger({
      ...contract2,
      workContractId: contract1.workContractId,
    }, { dbPath });

    const ledger2 = openRuntimeLedger({ dbPath });
    const db2 = ledger2.db!;

    const a1 = db2.prepare("SELECT attempt_no FROM task_attempts WHERE attempt_id = ?").get("attempt-1");
    const a2 = db2.prepare("SELECT attempt_no FROM task_attempts WHERE attempt_id = ?").get("attempt-2");

    expect(Number(a1!.attempt_no)).toBe(1);
    if (a2) {
      expect(Number(a2.attempt_no)).toBeGreaterThanOrEqual(2);
    }

    db2.close();
  });

  it("mirrors complexity_final as null in work_contracts and delegation_tickets for normal WorkContract input", () => {
    const contract = buildDelegateContract("session-complexity-null", "complexity null test", {
      delegateTaskId: "delegate-complexity",
    });

    const result = mirrorWorkContractToRuntimeLedger(contract, { dbPath });
    expect(result.status).toBe("ok");

    const ledger = openRuntimeLedger({ dbPath });
    const db = ledger.db!;

    const wcRow = db.prepare("SELECT complexity_final FROM work_contracts WHERE work_contract_id = ?").get(contract.workContractId);
    expect(wcRow).toBeDefined();
    expect(wcRow!.complexity_final).toBeNull();

    const ticketRow = db.prepare("SELECT complexity_final FROM delegation_tickets WHERE work_contract_id = ?").get(contract.workContractId);
    expect(ticketRow).toBeDefined();
    expect(ticketRow!.complexity_final).toBeNull();

    db.close();
  });

  it("updates existing attempt row with native ids on later mirror of same attempt_id", () => {
    const contract1 = buildDelegateContract("session-backfill", "backfill test step 1", {
      delegateTaskId: "delegate-backfill",
      currentAttemptId: "attempt-backfill-1",
    });

    mirrorWorkContractToRuntimeLedger(contract1, { dbPath });

    const ledger1 = openRuntimeLedger({ dbPath });
    const db1 = ledger1.db!;

    const row1 = db1.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get("attempt-backfill-1");
    expect(row1).toBeDefined();
    const originalAttemptNo = Number(row1!.attempt_no);
    expect(originalAttemptNo).toBe(1);
    db1.close();

    const nativeBinding: NativeBindingRef = {
      flowId: "flow-backfill",
      ownerKey: "owner",
      controllerId: "octoclaw.delegate",
      revision: 1,
      expectedRevision: 1,
      nativeTaskId: "native-task-backfill",
      nativeFlowId: "flow-backfill-native",
      syncMode: "managed",
      status: "running",
      childSessionKey: "child-session-backfill",
      childRunId: "child-run-backfill",
    };

    const contract2 = buildDelegateContract("session-backfill-2", "backfill test step 2", {
      delegateTaskId: "delegate-backfill",
      currentAttemptId: "attempt-backfill-1",
      role: "code",
      modelProfile: "claude-sonnet",
      nativeBinding,
    });

    mirrorWorkContractToRuntimeLedger({
      ...contract2,
      workContractId: contract1.workContractId,
    }, { dbPath });

    const ledger2 = openRuntimeLedger({ dbPath });
    const db2 = ledger2.db!;

    const row2 = db2.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get("attempt-backfill-1");
    expect(row2).toBeDefined();
    expect(Number(row2!.attempt_no)).toBe(originalAttemptNo);
    expect(String(row2!.native_task_id)).toBe("native-task-backfill");
    expect(String(row2!.native_flow_id)).toBe("flow-backfill-native");
    expect(String(row2!.child_session_key)).toBe("child-session-backfill");
    expect(String(row2!.child_run_id)).toBe("child-run-backfill");
    expect(String(row2!.model_profile)).toBe("claude-sonnet");
    expect(String(row2!.worker_pool)).toBe("code");
    expect(Number(row2!.revision)).toBe(1);

    db2.close();
  });

  it("returns degraded when sqlite is unavailable and never throws", () => {
    const contract = buildDelegateContract("session-degraded", "degraded test", {
      delegateTaskId: "delegate-degraded",
      currentAttemptId: "attempt-degraded",
    });

    const result = mirrorWorkContractToRuntimeLedger(contract, {
      dbPath,
      sqlite: null,
    });

    expect(result.status).toBe("degraded");
    expect(result.error).toContain("unavailable");
  });

  it("returns degraded when ledger open throws and never throws to caller", () => {
    const throwingSqlite: SqliteProvider = {
      DatabaseSync: class { constructor() { throw new Error("injected open failure"); } },
    } as unknown as SqliteProvider;

    const contract = buildDelegateContract("session-throw", "throwing test", {
      delegateTaskId: "delegate-throw",
    });

    const result = mirrorWorkContractToRuntimeLedger(contract, {
      dbPath,
      sqlite: throwingSqlite,
    });

    expect(result.status).toBe("degraded");
    expect(result.error).toContain("injected open failure");
  });

  it("handles reply route contract without ticket or attempt", () => {
    const contract = buildWorkContractFromPolicy(
      "session-reply",
      "reply test",
      "plain_chat",
      coverage,
      buildWorkDecisionSeal("local_judge", "reply", ["simple_reply"]),
    );

    const result = mirrorWorkContractToRuntimeLedger(contract, { dbPath });

    expect(result.status).toBe("ok");
    expect(result.rowsAffected).toBe(1);

    const ledger = openRuntimeLedger({ dbPath });
    const db = ledger.db!;

    const wcRow = db.prepare("SELECT * FROM work_contracts WHERE work_contract_id = ?").get(contract.workContractId);
    expect(wcRow).toBeDefined();
    expect(String(wcRow!.route)).toBe("reply");

    const tickets = db.prepare("SELECT * FROM delegation_tickets WHERE work_contract_id = ?").all(contract.workContractId);
    expect(tickets).toHaveLength(0);

    db.close();
  });

  it("idempotent upsert does not duplicate work_contracts row", () => {
    const contract = buildDelegateContract("session-idempotent", "idempotent test", {
      delegateTaskId: "delegate-idem",
    });

    mirrorWorkContractToRuntimeLedger(contract, { dbPath });
    mirrorWorkContractToRuntimeLedger(contract, { dbPath });
    mirrorWorkContractToRuntimeLedger(contract, { dbPath });

    const ledger = openRuntimeLedger({ dbPath });
    const db = ledger.db!;

    const rows = db.prepare("SELECT * FROM work_contracts WHERE work_contract_id = ?").all(contract.workContractId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].revision)).toBeGreaterThanOrEqual(2);

    const tickets = db.prepare("SELECT * FROM delegation_tickets WHERE work_contract_id = ?").all(contract.workContractId);
    expect(tickets).toHaveLength(1);

    db.close();
  });
});

const envStore: Map<string, string | undefined> = new Map();
function storeOriginal(key: string, value: string | undefined) {
  envStore.set(key, value);
}
function restoreOriginal(key: string) {
  const original = envStore.get(key);
  if (original !== undefined) {
    process.env[key] = original;
  } else {
    delete process.env[key];
  }
  envStore.delete(key);
}
