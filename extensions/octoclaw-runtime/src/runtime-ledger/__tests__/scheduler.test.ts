import { describe, it, expect, afterEach } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ContextCoverageSnapshot, WorkContract } from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../../work-contract/builders.js";
import { openRuntimeLedger } from "../index.js";
import { mirrorWorkContractToRuntimeLedger } from "../shadow.js";
import { admitDelegationTicketForDispatch } from "../ticket-enforcement.js";
import { buildDelegationTicketDryRun } from "../ticket-dry-run.js";
import {
  resolveSchedulerConfig,
  deriveSchedulerResourceKeys,
  promoteToQueued,
  tryAcquireLease,
  materializeNativeIds,
  releaseOrComplete,
  requeueExpiredLeases,
} from "../scheduler.js";

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
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-scheduler-"));
  tmpDirs.push(dir);
  return path.join(dir, "runtime.sqlite");
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
  execution: { coverage: "none" },
  memory: { coverage: "none" },
  conflict: false,
  authority: "none",
};

function makeContract(suffix: string, writePaths: string[] = []): WorkContract {
  const wc = buildWorkContractFromPolicy(
    `agent:main:scheduler-test-${suffix}`,
    `Scheduler test ${suffix}`,
    "delegated_work",
    coverage,
    buildWorkDecisionSeal("local_judge", "delegate", ["needs_code_change"]),
    {
      delegate: {
        delegateTaskId: `delegate-task-${suffix}`,
        currentAttemptId: `attempt-${suffix}`,
        role: "code",
        coordinationMode: "solo_worker",
        acceptanceCriteria: [],
        scope: {
          read: [],
          write: writePaths,
          workspaceMode: writePaths.length > 0 ? "write_allowed" : "read_only",
          scopeFingerprint: `scope-${suffix}`,
        },
        modelProfile: "default",
        nativeBinding: null,
        childSessions: [],
        artifactRefs: [],
        nextAction: "dispatch",
      },
    },
  );
  return wc;
}

function mirrorAndAdmit(contractToAdmit: WorkContract, dbPath: string): string {
  const previous = process.env.OCTOCLAW_RUNTIME_LEDGER;
  process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";
  try {
    const mirrorResult = mirrorWorkContractToRuntimeLedger(contractToAdmit, { dbPath });
    expect(mirrorResult.status).toBe("ok");
  } finally {
    if (previous === undefined) delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    else process.env.OCTOCLAW_RUNTIME_LEDGER = previous;
  }

  const candidate = buildDelegationTicketDryRun({
    contract: contractToAdmit,
    decision: {
      route_decision: { route: "delegate" },
      is_new_work: true,
      expected_deliverable: contractToAdmit.mainContext.summary,
    },
  });
  const admission = admitDelegationTicketForDispatch({
    contract: contractToAdmit,
    candidate,
    dbPath,
    mode: "enforce",
    delegateTaskId: `delegate-${contractToAdmit.workContractId}`,
    attemptId: `attempt-${contractToAdmit.workContractId}`,
  });
  expect(admission.allowed).toBe(true);
  expect(admission.queue_id).toBeTruthy();
  return admission.queue_id!;
}

function getQueueRow(dbPath: string, queueId: string) {
  const ledger = openRuntimeLedger({ dbPath });
  expect(ledger.status).toBe("ok");
  const row = ledger.db!.prepare(`SELECT * FROM scheduler_queue WHERE queue_id = ?`).get(queueId)!;
  ledger.db!.close();
  return row;
}

describe("resolveSchedulerConfig", () => {
  it("returns disabled by default", () => {
    const prev = process.env.OCTOCLAW_SCHEDULER_ENABLED;
    delete process.env.OCTOCLAW_SCHEDULER_ENABLED;
    try {
      const config = resolveSchedulerConfig();
      expect(config.enabled).toBe(false);
      expect(config.maxConcurrentSpawns).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev !== undefined) process.env.OCTOCLAW_SCHEDULER_ENABLED = prev;
    }
  });

  it("returns enabled when OCTOCLAW_SCHEDULER_ENABLED=1", () => {
    const prev = process.env.OCTOCLAW_SCHEDULER_ENABLED;
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "1";
    try {
      expect(resolveSchedulerConfig().enabled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OCTOCLAW_SCHEDULER_ENABLED;
      else process.env.OCTOCLAW_SCHEDULER_ENABLED = prev;
    }
  });

  it("respects OCTOCLAW_MAX_CONCURRENT_SPAWNS", () => {
    const prev = process.env.OCTOCLAW_MAX_CONCURRENT_SPAWNS;
    process.env.OCTOCLAW_MAX_CONCURRENT_SPAWNS = "4";
    try {
      expect(resolveSchedulerConfig().maxConcurrentSpawns).toBe(4);
    } finally {
      if (prev === undefined) delete process.env.OCTOCLAW_MAX_CONCURRENT_SPAWNS;
      else process.env.OCTOCLAW_MAX_CONCURRENT_SPAWNS = prev;
    }
  });
});

describe("targeted lease acquisition", () => {
  it("does not lease or cancel a different queue when a target queue is requested", () => {
    const dbPath = tmpDbPath();
    const first = makeContract("target-a");
    const second = makeContract("target-b");
    const q1 = mirrorAndAdmit(first, dbPath);
    const q2 = mirrorAndAdmit(second, dbPath);
    promoteToQueued({ queueId: q1, contract: first, dbPath });
    promoteToQueued({ queueId: q2, contract: second, dbPath });

    const lease = tryAcquireLease({ queueId: q2, leaseOwner: "targeted-test", maxConcurrentSpawns: 1, dbPath });

    expect(lease.acquired).toBe(true);
    expect(lease.queueId).toBe(q2);
    expect(getQueueRow(dbPath, q1)).toMatchObject({ queue_status: "queued" });
    expect(getQueueRow(dbPath, q2)).toMatchObject({ queue_status: "spawning" });
  });
});

describe("deriveSchedulerResourceKeys", () => {
  it("derives write keys from contract delegate scope write paths", () => {
    const wc = makeContract("derive-write", ["src/runtime", "src/shared"]);
    const keys = deriveSchedulerResourceKeys(wc);
    expect(keys).toContain("write:src/runtime");
    expect(keys).toContain("write:src/shared");
    expect(keys.length).toBe(2);
  });

  it("produces no blocking keys for read-only contracts", () => {
    const wc = makeContract("derive-readonly");
    const keys = deriveSchedulerResourceKeys(wc);
    expect(keys).toEqual([]);
  });

  it("normalizes paths and deduplicates", () => {
    const wc = makeContract("derive-norm", ["src/runtime/", "src/runtime"]);
    const keys = deriveSchedulerResourceKeys(wc);
    expect(keys).toEqual(["write:src/runtime"]);
  });
});

describe("promoteToQueued", () => {
  it("promotes admitted row to queued with explicit resource keys", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("promote-ok");
    const queueId = mirrorAndAdmit(wc, dbPath);

    const result = promoteToQueued({
      queueId,
      resourceKeys: ["write:src/runtime"],
      dbPath,
    });

    expect(result.ok).toBe(true);
    expect(result.queueStatus).toBe("queued");

    const row = getQueueRow(dbPath, queueId);
    expect(row.queue_status).toBe("queued");
    expect(JSON.parse(row.resource_keys_json as string)).toContain("write:src/runtime");
  });

  it("promotes with auto-derived keys from WorkContract", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("promote-auto", ["src/module-x"]);
    const queueId = mirrorAndAdmit(wc, dbPath);

    const result = promoteToQueued({
      queueId,
      contract: wc,
      dbPath,
    });

    expect(result.ok).toBe(true);
    expect(result.queueStatus).toBe("queued");

    const row = getQueueRow(dbPath, queueId);
    expect(JSON.parse(row.resource_keys_json as string)).toContain("write:src/module-x");
  });

  it("blocks when write keys conflict with running task", () => {
    const dbPath = tmpDbPath();
    const wc1 = makeContract("conflict-a");
    const wc2 = makeContract("conflict-b");
    const q1 = mirrorAndAdmit(wc1, dbPath);
    const q2 = mirrorAndAdmit(wc2, dbPath);

    promoteToQueued({ queueId: q1, resourceKeys: ["write:src/shared"], dbPath });
    const lease1 = tryAcquireLease({ leaseOwner: "worker-1", dbPath, maxConcurrentSpawns: 2 });
    expect(lease1.acquired).toBe(true);
    materializeNativeIds({ queueId: q1, nativeTaskId: "native-1", dbPath });

    const result = promoteToQueued({ queueId: q2, resourceKeys: ["write:src/shared"], dbPath });
    expect(result.ok).toBe(false);
    expect(result.queueStatus).toBe("blocked");
    expect(result.blockedBy).toBe(q1);
    expect(result.blockedReason).toBe("write_scope_conflict");
  });

  it("allows independent tasks without write conflicts", () => {
    const dbPath = tmpDbPath();
    const wc1 = makeContract("independent-a");
    const wc2 = makeContract("independent-b");
    const q1 = mirrorAndAdmit(wc1, dbPath);
    const q2 = mirrorAndAdmit(wc2, dbPath);

    promoteToQueued({ queueId: q1, resourceKeys: ["write:src/module-a"], dbPath });
    const lease1 = tryAcquireLease({ leaseOwner: "worker-1", dbPath, maxConcurrentSpawns: 2 });
    expect(lease1.acquired).toBe(true);
    materializeNativeIds({ queueId: q1, nativeTaskId: "native-1", dbPath });

    const result = promoteToQueued({ queueId: q2, resourceKeys: ["write:src/module-b"], dbPath });
    expect(result.ok).toBe(true);
    expect(result.queueStatus).toBe("queued");
  });

  it("allows read-only tasks to proceed regardless of other read-only tasks", () => {
    const dbPath = tmpDbPath();
    const wc1 = makeContract("readonly-a");
    const wc2 = makeContract("readonly-b");
    const q1 = mirrorAndAdmit(wc1, dbPath);
    const q2 = mirrorAndAdmit(wc2, dbPath);

    promoteToQueued({ queueId: q1, resourceKeys: ["read:docs"], dbPath });
    const lease1 = tryAcquireLease({ leaseOwner: "worker-1", dbPath, maxConcurrentSpawns: 2 });
    expect(lease1.acquired).toBe(true);
    materializeNativeIds({ queueId: q1, nativeTaskId: "native-1", dbPath });

    const result = promoteToQueued({ queueId: q2, resourceKeys: ["read:docs"], dbPath });
    expect(result.ok).toBe(true);
    expect(result.queueStatus).toBe("queued");
  });
});

describe("tryAcquireLease", () => {
  it("acquires lease for queued work", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("lease-acquire");
    const queueId = mirrorAndAdmit(wc, dbPath);
    promoteToQueued({ queueId, dbPath });

    const result = tryAcquireLease({ leaseOwner: "worker-1", dbPath });

    expect(result.acquired).toBe(true);
    expect(result.queueId).toBe(queueId);
    expect(result.leaseOwner).toBe("worker-1");
    expect(result.leaseExpiresAt).toBeTruthy();

    const row = getQueueRow(dbPath, queueId);
    expect(row.queue_status).toBe("spawning");
  });

  it("returns capacity_full when max concurrent reached", () => {
    const dbPath = tmpDbPath();
    const wc1 = makeContract("cap-1");
    const wc2 = makeContract("cap-2");
    const q1 = mirrorAndAdmit(wc1, dbPath);
    const q2 = mirrorAndAdmit(wc2, dbPath);

    promoteToQueued({ queueId: q1, dbPath });
    promoteToQueued({ queueId: q2, dbPath });

    const lease1 = tryAcquireLease({ leaseOwner: "worker-1", dbPath, maxConcurrentSpawns: 1 });
    expect(lease1.acquired).toBe(true);

    const lease2 = tryAcquireLease({ leaseOwner: "worker-2", dbPath, maxConcurrentSpawns: 1 });
    expect(lease2.acquired).toBe(false);
    expect(lease2.reason).toBe("capacity_full");
  });

  it("two independent read-only tasks acquire leases concurrently when maxConcurrent >= 2", () => {
    const dbPath = tmpDbPath();
    const wc1 = makeContract("concurrent-ro-1");
    const wc2 = makeContract("concurrent-ro-2");
    const q1 = mirrorAndAdmit(wc1, dbPath);
    const q2 = mirrorAndAdmit(wc2, dbPath);

    promoteToQueued({ queueId: q1, resourceKeys: ["read:docs"], dbPath });
    promoteToQueued({ queueId: q2, resourceKeys: ["read:docs"], dbPath });

    const lease1 = tryAcquireLease({ leaseOwner: "worker-1", dbPath, maxConcurrentSpawns: 2 });
    expect(lease1.acquired).toBe(true);
    materializeNativeIds({ queueId: q1, nativeTaskId: "native-1", dbPath });

    const lease2 = tryAcquireLease({ leaseOwner: "worker-2", dbPath, maxConcurrentSpawns: 2 });
    expect(lease2.acquired).toBe(true);
  });

  it("conflicting first queued candidate blocked, independent second candidate leases", () => {
    const dbPath = tmpDbPath();
    const wc1 = makeContract("multi-cand-conflict");
    const wc2 = makeContract("multi-cand-independent");
    const q1 = mirrorAndAdmit(wc1, dbPath);
    const q2 = mirrorAndAdmit(wc2, dbPath);

    promoteToQueued({ queueId: q1, resourceKeys: ["write:src/shared"], dbPath });
    promoteToQueued({ queueId: q2, resourceKeys: ["write:src/other"], dbPath });

    const lease1 = tryAcquireLease({ leaseOwner: "worker-1", dbPath, maxConcurrentSpawns: 2 });
    expect(lease1.acquired).toBe(true);
    materializeNativeIds({ queueId: q1, nativeTaskId: "native-1", dbPath });

    const ledger = openRuntimeLedger({ dbPath });
    ledger.db!.prepare(
      `UPDATE scheduler_queue SET resource_keys_json = ? WHERE queue_id = ?`,
    ).run(JSON.stringify(["write:src/shared"]), q2);
    ledger.db!.close();

    const wc3 = makeContract("multi-cand-third");
    const q3 = mirrorAndAdmit(wc3, dbPath);
    promoteToQueued({ queueId: q3, resourceKeys: ["read:docs"], dbPath });

    const lease2 = tryAcquireLease({ leaseOwner: "worker-2", dbPath, maxConcurrentSpawns: 2 });
    expect(lease2.acquired).toBe(true);
    expect(lease2.queueId).toBe(q3);

    const q2row = getQueueRow(dbPath, q2);
    expect(q2row.queue_status).toBe("blocked");
  });

  it("returns no_queued_work when queue is empty", () => {
    const dbPath = tmpDbPath();
    openRuntimeLedger({ dbPath }).db?.close();

    const result = tryAcquireLease({ leaseOwner: "worker-1", dbPath });
    expect(result.acquired).toBe(false);
    expect(result.reason).toBe("no_queued_work");
  });
});

describe("materializeNativeIds", () => {
  it("moves spawning to running and writes native ids", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("materialize-ok");
    const queueId = mirrorAndAdmit(wc, dbPath);
    promoteToQueued({ queueId, dbPath });
    tryAcquireLease({ leaseOwner: "worker-1", dbPath });

    const result = materializeNativeIds({
      queueId,
      nativeFlowId: "flow-123",
      nativeTaskId: "task-456",
      childSessionKey: "sess-789",
      dbPath,
    });

    expect(result.ok).toBe(true);
    expect(result.queueStatus).toBe("running");

    const ledger = openRuntimeLedger({ dbPath });
    const attempt = ledger.db!.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get(`attempt-${wc.workContractId}`)!;
    ledger.db!.close();
    expect(attempt.native_flow_id).toBe("flow-123");
    expect(attempt.native_task_id).toBe("task-456");
    expect(attempt.child_session_key).toBe("sess-789");
    expect(attempt.status).toBe("running");
  });

  it("rejects non-spawning queue row", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("materialize-not-spawning");
    const queueId = mirrorAndAdmit(wc, dbPath);

    const result = materializeNativeIds({ queueId, nativeTaskId: "native-1", dbPath });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_spawning");
  });
});

describe("releaseOrComplete", () => {
  it("completes running task and marks work_contract completed", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("release-complete");
    const queueId = mirrorAndAdmit(wc, dbPath);
    promoteToQueued({ queueId, dbPath });
    tryAcquireLease({ leaseOwner: "worker-1", dbPath });
    materializeNativeIds({ queueId, nativeTaskId: "native-1", dbPath });

    const result = releaseOrComplete({
      queueId,
      outcome: "completed",
      terminalSummary: "All done",
      dbPath,
    });

    expect(result.ok).toBe(true);

    const row = getQueueRow(dbPath, queueId);
    expect(row.queue_status).toBe("terminal");

    const ledger = openRuntimeLedger({ dbPath });
    const attempt = ledger.db!.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get(`attempt-${wc.workContractId}`)!;
    const contract = ledger.db!.prepare("SELECT status FROM work_contracts WHERE work_contract_id = ?").get(wc.workContractId)!;
    ledger.db!.close();
    expect(attempt.status).toBe("completed");
    expect(attempt.terminal_summary).toBe("All done");
    expect(contract.status).toBe("completed");
  });

  it("marks failed outcome on work_contract and attempt", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("release-fail");
    const queueId = mirrorAndAdmit(wc, dbPath);
    promoteToQueued({ queueId, dbPath });
    tryAcquireLease({ leaseOwner: "worker-1", dbPath });

    const result = releaseOrComplete({
      queueId,
      outcome: "failed",
      errorCode: "spawn_timeout",
      errorMessage: "Native task did not start",
      dbPath,
    });

    expect(result.ok).toBe(true);

    const ledger = openRuntimeLedger({ dbPath });
    const attempt = ledger.db!.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get(`attempt-${wc.workContractId}`)!;
    const contract = ledger.db!.prepare("SELECT status FROM work_contracts WHERE work_contract_id = ?").get(wc.workContractId)!;
    ledger.db!.close();
    expect(attempt.status).toBe("failed");
    expect(attempt.error_code).toBe("spawn_timeout");
    expect(contract.status).toBe("failed");
  });

  it("unblocks rows blocked by released queue id", () => {
    const dbPath = tmpDbPath();
    const wc1 = makeContract("unblock-a");
    const wc2 = makeContract("unblock-b");
    const q1 = mirrorAndAdmit(wc1, dbPath);
    const q2 = mirrorAndAdmit(wc2, dbPath);

    promoteToQueued({ queueId: q1, resourceKeys: ["write:src/shared"], dbPath });
    promoteToQueued({ queueId: q2, resourceKeys: ["write:src/shared"], dbPath });

    const lease1 = tryAcquireLease({ leaseOwner: "worker-1", dbPath, maxConcurrentSpawns: 2 });
    expect(lease1.acquired).toBe(true);
    materializeNativeIds({ queueId: q1, nativeTaskId: "native-1", dbPath });

    const q2rowBefore = getQueueRow(dbPath, q2);
    expect(q2rowBefore.queue_status).toBe("blocked");
    expect(q2rowBefore.blocked_by).toBe(q1);

    releaseOrComplete({ queueId: q1, outcome: "completed", dbPath });

    const q2rowAfter = getQueueRow(dbPath, q2);
    expect(q2rowAfter.queue_status).toBe("queued");
    expect(q2rowAfter.blocked_by).toBeNull();
    expect(q2rowAfter.blocked_reason).toBeNull();
    expect(q2rowAfter.queued_after).toBeNull();

    const lease2 = tryAcquireLease({ leaseOwner: "worker-2", dbPath, maxConcurrentSpawns: 2 });
    expect(lease2.acquired).toBe(true);
    expect(lease2.queueId).toBe(q2);
  });
});

describe("requeueExpiredLeases", () => {
  it("requeues expired spawning leases back to queued", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("requeue-expired");
    const queueId = mirrorAndAdmit(wc, dbPath);
    promoteToQueued({ queueId, dbPath });

    const now = new Date();
    const past = new Date(now.getTime() - 10_000);
    tryAcquireLease({ leaseOwner: "worker-1", dbPath, now: past, leaseDurationMs: 5000 });

    const rowBefore = getQueueRow(dbPath, queueId);
    expect(rowBefore.queue_status).toBe("spawning");

    const result = requeueExpiredLeases({ dbPath, now });
    expect(result.requeued).toBe(1);
    expect(result.queueIds).toContain(queueId);
    expect(result.skippedRunning).toBe(0);

    const rowAfter = getQueueRow(dbPath, queueId);
    expect(rowAfter.queue_status).toBe("queued");
    expect(rowAfter.lease_owner).toBeNull();
  });

  it("does not requeue active leases", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("requeue-active");
    const queueId = mirrorAndAdmit(wc, dbPath);
    promoteToQueued({ queueId, dbPath });

    tryAcquireLease({ leaseOwner: "worker-1", dbPath, leaseDurationMs: 60000 });

    const result = requeueExpiredLeases({ dbPath });
    expect(result.requeued).toBe(0);

    const row = getQueueRow(dbPath, queueId);
    expect(row.queue_status).toBe("spawning");
  });

  it("clears native ids from expired spawning attempts on requeue", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("requeue-clear");
    const queueId = mirrorAndAdmit(wc, dbPath);
    promoteToQueued({ queueId, dbPath });

    const now = new Date();
    const past = new Date(now.getTime() - 10_000);
    tryAcquireLease({ leaseOwner: "worker-1", dbPath, now: past, leaseDurationMs: 5000 });

    requeueExpiredLeases({ dbPath, now });

    const ledger = openRuntimeLedger({ dbPath });
    const attempt = ledger.db!.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get(`attempt-${wc.workContractId}`)!;
    ledger.db!.close();
    expect(attempt.status).toBe("queued");
    expect(attempt.native_task_id).toBeNull();
  });

  it("preserves native ids on expired running row without requeue", () => {
    const dbPath = tmpDbPath();
    const wc = makeContract("requeue-running");
    const queueId = mirrorAndAdmit(wc, dbPath);
    promoteToQueued({ queueId, dbPath });

    const now = new Date();
    const past = new Date(now.getTime() - 10_000);
    tryAcquireLease({ leaseOwner: "worker-1", dbPath, now: past, leaseDurationMs: 5000 });
    materializeNativeIds({ queueId, nativeTaskId: "native-preserved", nativeFlowId: "flow-preserved", dbPath, now: past });

    const rowBefore = getQueueRow(dbPath, queueId);
    expect(rowBefore.queue_status).toBe("running");

    const result = requeueExpiredLeases({ dbPath, now });
    expect(result.requeued).toBe(0);
    expect(result.skippedRunning).toBe(1);

    const rowAfter = getQueueRow(dbPath, queueId);
    expect(rowAfter.queue_status).toBe("running");
    expect(rowAfter.lease_owner).toBeNull();

    const ledger = openRuntimeLedger({ dbPath });
    const attempt = ledger.db!.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get(`attempt-${wc.workContractId}`)!;
    ledger.db!.close();
    expect(attempt.status).toBe("running");
    expect(attempt.native_task_id).toBe("native-preserved");
    expect(attempt.native_flow_id).toBe("flow-preserved");
  });
});

describe("busy unrelated main-turn resource does not block independent task", () => {
  it("main-turn write:workspace does not block independent write:src/module", () => {
    const dbPath = tmpDbPath();
    const wcMain = makeContract("main-turn");
    const wcOther = makeContract("other-module");
    const qMain = mirrorAndAdmit(wcMain, dbPath);
    const qOther = mirrorAndAdmit(wcOther, dbPath);

    promoteToQueued({ queueId: qMain, resourceKeys: ["write:workspace"], dbPath });
    const leaseMain = tryAcquireLease({ leaseOwner: "worker-main", dbPath, maxConcurrentSpawns: 2 });
    expect(leaseMain.acquired).toBe(true);
    materializeNativeIds({ queueId: qMain, nativeTaskId: "native-main", dbPath });

    const promoteResult = promoteToQueued({ queueId: qOther, resourceKeys: ["write:src/module"], dbPath });
    expect(promoteResult.ok).toBe(true);
    expect(promoteResult.queueStatus).toBe("queued");

    const leaseOther = tryAcquireLease({ leaseOwner: "worker-other", dbPath, maxConcurrentSpawns: 2 });
    expect(leaseOther.acquired).toBe(true);
  });
});
