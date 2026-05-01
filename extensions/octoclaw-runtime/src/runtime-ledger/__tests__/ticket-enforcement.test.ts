import { describe, it, expect, afterEach } from "vitest";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ContextCoverageSnapshot, WorkContract } from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../../work-contract/builders.js";
import { openRuntimeLedger } from "../index.js";
import { mirrorWorkContractToRuntimeLedger } from "../shadow.js";
import { buildDelegationTicketDryRun } from "../ticket-dry-run.js";
import { admitDelegationTicketForDispatch } from "../ticket-enforcement.js";

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
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-ticket-enforce-"));
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

function contract(): WorkContract {
  return buildWorkContractFromPolicy(
    "agent:main:ticket-enforcement",
    "实现 N1 ticket enforcement",
    "delegated_work",
    coverage,
    buildWorkDecisionSeal("local_judge", "delegate", ["needs_code_change"]),
  );
}

function mirror(contractToMirror: WorkContract, dbPath: string): void {
  const previous = process.env.OCTOCLAW_RUNTIME_LEDGER;
  process.env.OCTOCLAW_RUNTIME_LEDGER = "shadow";
  try {
    const result = mirrorWorkContractToRuntimeLedger(contractToMirror, { dbPath });
    expect(result.status).toBe("ok");
  } finally {
    if (previous === undefined) delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    else process.env.OCTOCLAW_RUNTIME_LEDGER = previous;
  }
}

function candidateFor(workContract: WorkContract) {
  return buildDelegationTicketDryRun({
    contract: workContract,
    decision: {
      route_decision: { route: "delegate" },
      is_new_work: true,
      expected_deliverable: workContract.mainContext.summary,
    },
  });
}

function countRows(dbPath: string, table: string): number {
  const ledger = openRuntimeLedger({ dbPath });
  expect(ledger.status).toBe("ok");
  const row = ledger.db!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  ledger.db!.close();
  return Number(row?.count ?? 0);
}

describe("admitDelegationTicketForDispatch", () => {
  it("valid ticket is consumed once and creates one attempt plus queue row", () => {
    const dbPath = tmpDbPath();
    const workContract = contract();
    mirror(workContract, dbPath);
    const candidate = candidateFor(workContract);

    const result = admitDelegationTicketForDispatch({
      contract: workContract,
      candidate,
      dbPath,
      mode: "enforce",
      delegateTaskId: "delegate-n1",
      attemptId: "attempt-n1-1",
    });

    expect(result.allowed).toBe(true);
    expect(result.enforced).toBe(true);
    expect(result.reason).toBe("ticket_admitted");
    expect(result.attempt_id).toBe("attempt-n1-1");
    expect(countRows(dbPath, "task_attempts")).toBe(1);
    expect(countRows(dbPath, "scheduler_queue")).toBe(1);

    const replay = admitDelegationTicketForDispatch({
      contract: workContract,
      candidate,
      dbPath,
      mode: "enforce",
      delegateTaskId: "delegate-n1",
      attemptId: "attempt-n1-1",
    });
    expect(replay.allowed).toBe(false);
    expect(replay.reason).toBe("ticket_used");
    expect(countRows(dbPath, "task_attempts")).toBe(1);
  });

  it("rejects missing ticket without creating attempts", () => {
    const dbPath = tmpDbPath();
    openRuntimeLedger({ dbPath }).db?.close();
    const workContract = contract();
    const candidate = candidateFor(workContract);

    const result = admitDelegationTicketForDispatch({
      contract: workContract,
      candidate,
      dbPath,
      mode: "enforce",
      delegateTaskId: "delegate-missing",
      attemptId: "attempt-missing-1",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_ticket");
    expect(countRows(dbPath, "task_attempts")).toBe(0);
  });

  it.each([
    ["used", "ticket_used"],
    ["revoked", "ticket_revoked"],
    ["expired", "ticket_expired"],
  ] as const)("rejects %s ticket without creating attempts", (status, reason) => {
    const dbPath = tmpDbPath();
    const workContract = contract();
    mirror(workContract, dbPath);
    const ledger = openRuntimeLedger({ dbPath });
    expect(ledger.status).toBe("ok");
    if (status === "expired") {
      ledger.db!.prepare("UPDATE delegation_tickets SET expires_at = ? WHERE work_contract_id = ?")
        .run("2000-01-01T00:00:00.000Z", workContract.workContractId);
    } else {
      ledger.db!.prepare("UPDATE delegation_tickets SET status = ? WHERE work_contract_id = ?")
        .run(status, workContract.workContractId);
    }
    ledger.db!.close();

    const result = admitDelegationTicketForDispatch({
      contract: workContract,
      candidate: candidateFor(workContract),
      dbPath,
      mode: "enforce",
      delegateTaskId: `delegate-${status}`,
      attemptId: `attempt-${status}-1`,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(reason);
    expect(countRows(dbPath, "task_attempts")).toBe(0);
  });

  it("rejects scope mismatch without creating attempts", () => {
    const dbPath = tmpDbPath();
    const workContract = contract();
    mirror(workContract, dbPath);
    const candidate = {
      ...candidateFor(workContract),
      expected_deliverable: "different deliverable",
    };

    const result = admitDelegationTicketForDispatch({
      contract: workContract,
      candidate,
      dbPath,
      mode: "enforce",
      delegateTaskId: "delegate-scope",
      attemptId: "attempt-scope-1",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("scope_mismatch");
    expect(countRows(dbPath, "task_attempts")).toBe(0);
  });

  it("allows dispatch without enforcement in off mode", () => {
    const result = admitDelegationTicketForDispatch({
      mode: "off",
      candidate: { ticket_decision: "ticket_would_issue" },
    });
    expect(result.allowed).toBe(true);
    expect(result.enforced).toBe(false);
    expect(result.reason).toBe("not_enforced");
  });

  it("allows dispatch without enforcement in shadow mode", () => {
    const result = admitDelegationTicketForDispatch({
      mode: "shadow",
      candidate: { ticket_decision: "ticket_would_issue" },
    });
    expect(result.allowed).toBe(true);
    expect(result.enforced).toBe(false);
    expect(result.reason).toBe("not_enforced");
  });

  it("rejects followup (not_new_work) in enforce mode without creating attempts", () => {
    const dbPath = tmpDbPath();
    const result = admitDelegationTicketForDispatch({
      mode: "enforce",
      candidate: {
        ticket_decision: "ticket_not_issued",
        ticket_denial_reason: "not_new_work",
        is_new_work: false,
        expected_deliverable: "status check",
      },
      dbPath,
    });
    expect(result.allowed).toBe(false);
    expect(result.enforced).toBe(true);
    expect(result.reason).toBe("not_new_work");
    expect(countRows(dbPath, "task_attempts")).toBe(0);
    expect(countRows(dbPath, "scheduler_queue")).toBe(0);
  });

  it("rejects missing_expected_deliverable in enforce mode without creating attempts", () => {
    const dbPath = tmpDbPath();
    const result = admitDelegationTicketForDispatch({
      mode: "enforce",
      candidate: {
        ticket_decision: "ticket_not_issued",
        ticket_denial_reason: "missing_expected_deliverable",
        is_new_work: false,
        expected_deliverable: "",
      },
      dbPath,
    });
    expect(result.allowed).toBe(false);
    expect(result.enforced).toBe(true);
    expect(result.reason).toBe("missing_expected_deliverable");
    expect(countRows(dbPath, "task_attempts")).toBe(0);
    expect(countRows(dbPath, "scheduler_queue")).toBe(0);
  });

  it("allows ticket_not_issued in off mode (no enforcement)", () => {
    const result = admitDelegationTicketForDispatch({
      mode: "off",
      candidate: {
        ticket_decision: "ticket_not_issued",
        ticket_denial_reason: "not_new_work",
        is_new_work: false,
        expected_deliverable: "",
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.enforced).toBe(false);
  });

  it("allows ticket_not_issued in shadow mode (no enforcement)", () => {
    const result = admitDelegationTicketForDispatch({
      mode: "shadow",
      candidate: {
        ticket_decision: "ticket_not_issued",
        ticket_denial_reason: "not_new_work",
        is_new_work: false,
        expected_deliverable: "",
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.enforced).toBe(false);
  });
});
