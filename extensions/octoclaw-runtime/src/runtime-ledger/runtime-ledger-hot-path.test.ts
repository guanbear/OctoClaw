import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextCoverageSnapshot, CoverageAuthority, IntentClass, WorkContract, WorkRoute } from "@octoclaw/contracts/work-contract";
import type { NativeHelperInvoker } from "../adapter/native-helper.js";
import { envOverrides } from "../resolve/env.js";
import { buildExecutionCoverageLayer } from "../resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "../resolve/memory-coverage-precheck.js";
import { readTaskStateDocumentDetailed } from "../state/task-state-store.js";
import { getToolRegistrations } from "../tools/registration.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { loadWorkContract, saveWorkContract } from "../work-contract/store.js";
import { openRuntimeLedger } from "./index.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

const tempLedgerPaths: string[] = [];

function dispatchTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_dispatch");
  if (!tool) throw new Error("octoclaw_dispatch tool not registered");
  return tool;
}

function taskActionTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_task_action");
  if (!tool) throw new Error("octoclaw_task_action tool not registered");
  return tool;
}

function statusTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_status");
  if (!tool) throw new Error("octoclaw_status tool not registered");
  return tool;
}

function crashRecoveryTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_crash_recovery");
  if (!tool) throw new Error("octoclaw_crash_recovery tool not registered");
  return tool;
}

function delegateDecision(sessionKey = "session-runtime-ledger-hot-path") {
  return {
    request: { session_key: sessionKey },
    route_decision: {
      route: "delegate",
      worker_pool: "octoclaw-research",
      task_class: "worker_research",
    },
    model_policy: { selected_model: "worker_research" },
  };
}

function successfulHelper(): NativeHelperInvoker {
  return ((input) => {
    if (input.action === "create-managed-flow") {
      return { ok: true, flow_id: "flow-hot-path", flow: { flowId: "flow-hot-path", status: "planned", revision: 1 } };
    }
    if (input.action === "run-task") {
      return {
        ok: true,
        native_task_id: "task-hot-path",
        flow_id: "flow-hot-path",
        task: { taskId: "task-hot-path", status: "queued", syncMode: "managed", state: "queued", revision: 1 },
      };
    }
    throw new Error(`unsupported_action:${input.action}`);
  }) as NativeHelperInvoker;
}

function useTempWorkspace(prefix = "octoclaw-runtime-ledger-hot-path-"): string {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), prefix));
  tempLedgerPaths.push(dir);
  envOverrides.workspaceRoot = dir;
  return dir;
}

function buildCoverageSnapshot(): ContextCoverageSnapshot {
  const execution = buildExecutionCoverageLayer(["missing"]);
  const memory = buildMemoryCoverageLayer();
  const hasConflict = Boolean(execution.coverage !== "none" && memory.coverage !== "none");
  const authority: CoverageAuthority = hasConflict
    ? "execution_wins"
    : execution.coverage !== "none"
      ? "execution_wins"
      : memory.coverage !== "none"
        ? "memory_only"
        : "none";
  return {
    precheckOrder: ["conversation_grounding", "continuation_route_reuse", "execution_coverage", "memory_coverage", "build_judge_context_packet", "local_judge", "validator_or_remote", "route_seal_commit"],
    execution,
    memory,
    conflict: hasConflict,
    authority,
  };
}

function seedWorkContract(options: {
  route?: WorkRoute;
  status?: WorkContract["status"];
  sessionKey?: string;
  userAsk?: string;
  intentClass?: IntentClass;
  withDelegate?: boolean;
} = {}): WorkContract {
  const route = options.route ?? "delegate";
  const sessionKey = options.sessionKey ?? "session-runtime-ledger-hot-path";
  const userAsk = options.userAsk ?? "Runtime ledger hot path dispatch";
  const contract = buildWorkContractFromPolicy(
    sessionKey,
    userAsk,
    options.intentClass ?? "fresh_live_lookup",
    buildCoverageSnapshot(),
    buildWorkDecisionSeal("local_judge", route, ["runtime_ledger_hot_path_test"]),
    { status: options.status ?? "sealed" },
  );
  const contractWithDelegate = options.withDelegate
    ? {
        ...contract,
        delegate: {
          delegateTaskId: `delegate-task:${contract.workContractId}`,
          currentAttemptId: `delegate-task:${contract.workContractId}:attempt:1`,
          role: "research",
          coordinationMode: "solo_worker",
          acceptanceCriteria: [],
          scope: { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: `scope:${contract.workContractId}` },
          modelProfile: "worker_research",
          nativeBinding: null,
          childSessions: [],
          artifactRefs: [],
          nextAction: "dispatch",
        },
      } as WorkContract
    : contract;
  saveWorkContract(contractWithDelegate);
  return contractWithDelegate;
}

function openDb() {
  const result = openRuntimeLedger({ mode: "best_effort" });
  if (result.status !== "ok" || !result.db) throw new Error(result.error || "runtime ledger unavailable");
  return result.db;
}

async function executeDispatch(params: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const response = await dispatchTool().execute(params, ctx);
  expect(typeof response.text).toBe("string");
  return JSON.parse(response.text as string) as Record<string, unknown>;
}

function seedLedgerOnlyWorkContract(contract: WorkContract): void {
  const db = openDb();
  try {
    db.prepare("DELETE FROM work_contracts WHERE work_contract_id = ?").run(contract.workContractId);
    db.prepare(
      `INSERT INTO work_contracts (
         work_contract_id, route, intent_class, expected_deliverable,
         complexity_final, complexity_reason_codes_json, delivery_target_json,
         work_contract_json, status, created_at, updated_at, completed_at, revision
       ) VALUES (?, ?, ?, ?, NULL, '[]', ?, ?, ?, ?, ?, NULL, 0)`,
    ).run(
      contract.workContractId,
      contract.route,
      contract.intentClass,
      contract.mainContext.summary,
      JSON.stringify({ sessionKey: contract.sessionKey, turnId: contract.turnId }),
      JSON.stringify(contract),
      contract.status,
      contract.createdAt,
      contract.updatedAt,
    );
  } finally {
    db.close();
  }
}

vi.setConfig({ testTimeout: 30_000 });

describe("runtime ledger hot-path tool integration", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    delete process.env.OCTOCLAW_SCHEDULER_ENABLED;
    delete process.env.OCTOCLAW_TASK_STATE_REBUILD;
    delete process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH;
    envOverrides.workspaceRoot = "";
    for (const dir of tempLedgerPaths.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("dispatch tool creates scheduler queue entry in enforce mode", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "true";
    const contract = seedWorkContract({ sessionKey: "session-hot-path-dispatch" });

    const result = await executeDispatch({
      task: contract.userAsk,
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract.sessionKey)),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-dispatch-test",
    });

    expect(result.error).toBe("spawn_not_confirmed");
    expect(result.dispatch_executed).toBe(true);
    const db = openDb();
    try {
      const row = db.prepare("SELECT * FROM scheduler_queue WHERE work_contract_id = ?").get(contract.workContractId);
      expect(row).toMatchObject({ work_contract_id: contract.workContractId });
      expect(String(row?.queue_id)).toContain(`delegate-task:${contract.workContractId}`);
    } finally {
      db.close();
    }
  });

  it("dispatch tool is blocked without valid ticket in enforce mode", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "true";
    const contract = seedWorkContract({ sessionKey: "session-hot-path-no-ticket" });
    const db = openDb();
    try {
      db.prepare("DELETE FROM delegation_tickets WHERE work_contract_id = ?").run(contract.workContractId);
    } finally {
      db.close();
    }

    const result = await executeDispatch({
      task: contract.userAsk,
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract.sessionKey)),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-no-ticket-test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("delegation_ticket_rejected:no_ticket");
    expect(result.dispatch_executed).toBe(false);
    const dbAfter = openDb();
    try {
      const count = dbAfter.prepare("SELECT COUNT(*) AS count FROM scheduler_queue WHERE work_contract_id = ?").get(contract.workContractId);
      expect(Number(count?.count ?? 0)).toBe(0);
    } finally {
      dbAfter.close();
    }
  });

  it("task_action retry creates real attempt row in ledger", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    const contract = seedWorkContract({ sessionKey: "session-hot-path-retry", withDelegate: true });

    const response = await taskActionTool().execute({ action: "retry", taskId: contract.workContractId, format: "json" }, {});
    expect(response.json).toMatchObject({ ok: true, action: "retry", workContractId: contract.workContractId });
    const payload = response.json as Record<string, unknown>;

    const db = openDb();
    try {
      const row = db.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get(String(payload.attempt_id));
      expect(row).toMatchObject({ work_contract_id: contract.workContractId, attempt_kind: "retry" });
      const queue = db.prepare("SELECT * FROM scheduler_queue WHERE attempt_id = ?").get(String(payload.attempt_id));
      expect(queue).toMatchObject({ work_contract_id: contract.workContractId });
    } finally {
      db.close();
    }
  });

  it("WorkContract store reads from ledger when task-state.json is missing in enforce mode", async () => {
    const dir = useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    const contract = seedWorkContract({ sessionKey: "session-hot-path-ledger-fallback" });
    fs.rmSync(path.join(dir, "tmp", "octopus", "task-state.json"), { force: true });

    expect(readTaskStateDocumentDetailed().status).toBe("missing");
    const reloaded = loadWorkContract(contract.workContractId);
    expect(reloaded?.workContractId).toBe(contract.workContractId);
    expect(reloaded?.sessionKey).toBe("session-hot-path-ledger-fallback");
  });

  it("crash recovery operator tool runs and returns structured result", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_TASK_STATE_REBUILD = "1";
    const response = await crashRecoveryTool().execute({}, {});

    expect(response.text).toContain("crash_recovery_completed");
    expect(response.json).toMatchObject({ projectionRebuilt: true });
    const payload = response.json as Record<string, unknown>;
    expect(typeof payload.staleLeasesReleased).toBe("number");
    expect(typeof payload.attemptsReconciled).toBe("number");
    expect(Array.isArray(payload.errors)).toBe(true);
  });

  it("corrupt task-state.json is quarantined and ledger provides fallback data", async () => {
    const dir = useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    const contract = seedWorkContract({ sessionKey: "session-hot-path-corrupt-fallback", withDelegate: true });
    const taskStatePath = path.join(dir, "tmp", "octopus", "task-state.json");
    fsSync.writeFileSync(taskStatePath, "{corrupt", "utf-8");

    const before = readTaskStateDocumentDetailed();
    expect(before.status).toBe("parse_error");
    const retryResponse = await taskActionTool().execute({ text: `retry ${contract.workContractId}`, format: "json" }, {});
    expect(retryResponse.json).toMatchObject({ ok: true, workContractId: contract.workContractId });
    const after = readTaskStateDocumentDetailed();
    expect(after.status).toBe("ok");
    const quarantined = fsSync.readdirSync(path.dirname(taskStatePath)).filter((entry) => entry.startsWith("task-state.json.corrupt."));
    expect(quarantined.length).toBeGreaterThan(0);
    const reloaded = loadWorkContract(contract.workContractId);
    expect(reloaded?.workContractId).toBe(contract.workContractId);
  });

  it("status tool can read ledger-backed fallback when task-state.json is missing", async () => {
    const dir = useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    const contract = seedWorkContract({ sessionKey: "session-hot-path-status-ledger" });
    seedLedgerOnlyWorkContract(contract);
    fs.rmSync(path.join(dir, "tmp", "octopus", "task-state.json"), { force: true });

    const response = await statusTool().execute({ format: "raw" }, {});
    expect(response.json).toBeTruthy();
    const reloaded = loadWorkContract(contract.workContractId);
    expect(reloaded?.workContractId).toBe(contract.workContractId);
  });
});
