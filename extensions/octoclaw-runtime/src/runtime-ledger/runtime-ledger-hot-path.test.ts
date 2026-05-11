import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextCoverageSnapshot, CoverageAuthority, IntentClass, WorkContract, WorkRoute } from "@octoclaw/contracts/work-contract";
import type { NativeHelperInvoker } from "../adapter/native-helper.js";
import { envOverrides } from "../resolve/env.js";
import { buildExecutionCoverageLayer } from "../resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "../resolve/memory-coverage-precheck.js";
import { resolveStatelessPolicyDecision } from "../resolve/policy-resolver.js";
import { policyState } from "../state/policy-state.js";
import { readTaskStateDocumentDetailed } from "../state/task-state-store.js";
import { getToolRegistrations } from "../tools/registration.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { loadWorkContract, saveWorkContract } from "../work-contract/store.js";
import { confirmNativeSpawn } from "../delegate/native-spawn-confirm.js";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
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

function delegateDecision(sessionKey = "session-runtime-ledger-hot-path", expectedDeliverable = "Runtime ledger hot path dispatch") {
  return {
    request: { session_key: sessionKey },
    route_decision: {
      route: "delegate",
      worker_pool: "octoclaw-research",
      task_class: "worker_research",
      expected_deliverable: expectedDeliverable,
    },
    model_policy: { selected_model: "worker_research" },
    is_new_work: true,
    expected_deliverable: expectedDeliverable,
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

async function resolveDelegatePolicy(task: string, sessionKey: string, metadata: Record<string, unknown> = {}) {
  return resolveStatelessPolicyDecision(task, {
    metadata: {
      _judgeFastConfig: {
        enabled: true,
        shadowMode: false,
        modelId: "test-local-judge",
        baseUrl: "http://localhost:19999/v1",
        apiKey: "test-key",
        timeoutMs: 1500,
        timeoutLocalMs: 800,
        minConfidence: 0.6,
        local: true,
        judgeAckEnabled: true,
      },
      session_key: sessionKey,
      conversation_control: {
        intent_class: "fresh_live_lookup",
        route_hint: "delegate",
        require_fresh_lookup: true,
      },
      ...metadata,
    },
    routeHint: { route_hint: "delegate", source: "system", trusted: true },
  });
}

function expectNoDispatchSideEffects(workContractId: string): void {
  const db = openDb();
  try {
    const usedTickets = db.prepare("SELECT COUNT(*) AS count FROM delegation_tickets WHERE work_contract_id = ? AND status = 'used'").get(workContractId);
    expect(Number(usedTickets?.count ?? 0)).toBe(0);
    const attempts = db.prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE work_contract_id = ?").get(workContractId);
    expect(Number(attempts?.count ?? 0)).toBe(0);
    const queue = db.prepare("SELECT COUNT(*) AS count FROM scheduler_queue WHERE work_contract_id = ?").get(workContractId);
    expect(Number(queue?.count ?? 0)).toBe(0);
    const ticketUsedEvents = db.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE work_contract_id = ? AND event_type = 'delegation_ticket_used'").get(workContractId);
    expect(Number(ticketUsedEvents?.count ?? 0)).toBe(0);
  } finally {
    db.close();
  }
}

function expectDispatchSideEffects(workContractId: string): void {
  const db = openDb();
  try {
    const usedTickets = db.prepare("SELECT COUNT(*) AS count FROM delegation_tickets WHERE work_contract_id = ? AND status = 'used'").get(workContractId);
    expect(Number(usedTickets?.count ?? 0)).toBe(1);
    const attempts = db.prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE work_contract_id = ?").get(workContractId);
    expect(Number(attempts?.count ?? 0)).toBe(1);
    const queue = db.prepare("SELECT COUNT(*) AS count FROM scheduler_queue WHERE work_contract_id = ?").get(workContractId);
    expect(Number(queue?.count ?? 0)).toBe(1);
    const ticketUsedEvents = db.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE work_contract_id = ? AND event_type = 'delegation_ticket_used'").get(workContractId);
    expect(Number(ticketUsedEvents?.count ?? 0)).toBe(1);
  } finally {
    db.close();
  }
}

function clearPolicyState(): void {
  for (const entry of policyState.entries()) {
    policyState.clear(entry.key);
  }
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

function seedDelegationTicket(contract: WorkContract): void {
  const db = openDb();
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const ticketId = `candidate:${contract.workContractId}`;
  const expectedDeliverable = contract.mainContext.summary.slice(0, 200);
  try {
    db.prepare("DELETE FROM delegation_tickets WHERE work_contract_id = ?").run(contract.workContractId);
    db.prepare(
      `INSERT INTO delegation_tickets (
         ticket_id, work_contract_id, turn_id, session_key,
         delivery_target_id, expected_deliverable, complexity_final,
         status, issued_at, expires_at, ticket_json, revision
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'issued', ?, ?, ?, 0)`,
    ).run(
      ticketId,
      contract.workContractId,
      contract.turnId,
      contract.sessionKey,
      contract.turnId,
      expectedDeliverable,
      nowIso,
      expiresIso,
      JSON.stringify({ ticket_id: ticketId, work_contract_id: contract.workContractId }),
    );
  } finally {
    db.close();
  }
}

vi.setConfig({ testTimeout: 30_000 });

describe("runtime ledger hot-path tool integration", () => {
  beforeEach(() => {
    clearPolicyState();
    process.env.OCTOCLAW_SPAWN_BACKEND = "legacy";
    delete process.env.OCTOCLAW_PLANNER_ALLOWLIST;
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    delete process.env.OCTOCLAW_SPAWN_BACKEND;
    delete process.env.OCTOCLAW_PLANNER_ALLOWLIST;
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
    seedDelegationTicket(contract);

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
      const events = db.prepare(
        "SELECT event_type, payload_json FROM runtime_events WHERE work_contract_id = ? ORDER BY created_at",
      ).all(contract.workContractId);
      const eventTypes = events.map((event) => String(event.event_type));
      expect(eventTypes).toContain("delegation_ticket_used");
      expect(eventTypes).toContain("scheduler_queue_promoted");
      expect(eventTypes).toContain("scheduler_lease_acquired");
      expect(eventTypes).toContain("scheduler_released");
      expect(row?.queue_status).toBe("terminal");
      const attempt = db.prepare("SELECT status FROM task_attempts WHERE work_contract_id = ?").get(contract.workContractId);
      expect(attempt?.status).not.toBe("admitted");
      expect(attempt?.status).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("scheduler lease lifecycle produces correct events and terminal state on spawn failure", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "true";
    const contract = seedWorkContract({ sessionKey: "session-hot-path-lease-lifecycle" });
    seedDelegationTicket(contract);

    const result = await executeDispatch({
      task: contract.userAsk,
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract.sessionKey)),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-lease-lifecycle-test",
    });

    expect(result.error).toBe("spawn_not_confirmed");
    expect(result.dispatch_executed).toBe(true);
    const db = openDb();
    try {
      const row = db.prepare("SELECT * FROM scheduler_queue WHERE work_contract_id = ?").get(contract.workContractId);
      expect(row).toMatchObject({ work_contract_id: contract.workContractId, queue_status: "terminal" });
      expect(row?.lease_owner).toBeNull();
      expect(row?.lease_expires_at).toBeNull();

      const events = db.prepare(
        "SELECT event_type, payload_json FROM runtime_events WHERE work_contract_id = ? ORDER BY created_at",
      ).all(contract.workContractId);
      const eventTypes = events.map((event) => String(event.event_type));
      expect(eventTypes).toEqual(expect.arrayContaining([
        "delegation_ticket_used",
        "scheduler_queue_promoted",
        "scheduler_lease_acquired",
        "scheduler_released",
      ]));
      expect(eventTypes.indexOf("delegation_ticket_used")).toBeLessThan(eventTypes.indexOf("scheduler_queue_promoted"));
      expect(eventTypes.indexOf("scheduler_queue_promoted")).toBeLessThan(eventTypes.indexOf("scheduler_lease_acquired"));
      expect(eventTypes.indexOf("scheduler_lease_acquired")).toBeLessThan(eventTypes.indexOf("scheduler_released"));

      const leaseAcquiredEvent = events.find((event) => event.event_type === "scheduler_lease_acquired");
      expect(leaseAcquiredEvent).toBeTruthy();
      expect(String(leaseAcquiredEvent?.payload_json ?? "")).toContain("leaseOwner");

      const attempt = db.prepare("SELECT status FROM task_attempts WHERE work_contract_id = ?").get(contract.workContractId);
      expect(attempt?.status).not.toBe("admitted");
      expect(attempt?.status).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("policy seal issues a ledger ticket in enforce mode without manual seeding", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "true";
    const task = "Delegate a subagent to research runtime ledger ticket issuance and return a concise implementation summary.";
    const decision = await resolveDelegatePolicy(task, "session-hot-path-auto-ticket", {
      relation_to_recent_execution: "new_work",
      is_new_work: true,
      expected_deliverable: "concise implementation summary for runtime ledger ticket issuance",
      conversation_control: {
        intent_class: "delegated_work",
        route_hint: "delegate",
        explicit_delegate_request: true,
        require_fresh_lookup: true,
      },
    });
    const workContractId = String(decision.workContractId ?? "");
    expect(workContractId).not.toBe("");

    const result = await executeDispatch({
      task,
      delegateTaskId: `delegate-task:${workContractId}`,
      workContractId,
      policyJson: JSON.stringify(decision),
      metadataJson: JSON.stringify({
        relation_to_recent_execution: "new_work",
        is_new_work: true,
        expected_deliverable: "concise implementation summary for runtime ledger ticket issuance",
        conversation_control: {
          intent_class: "delegated_work",
          route_hint: "delegate",
          explicit_delegate_request: true,
          require_fresh_lookup: true,
        },
      }),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-auto-ticket-test",
    });

    expect(result.error).toBe("spawn_not_confirmed");
    expect(result.dispatch_executed).toBe(true);
    expectDispatchSideEffects(workContractId);
  });

  it("planner dispatch admits ledger ticket and confirm records native attempt refs", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SPAWN_BACKEND = "planner";
    const contract = seedWorkContract({ sessionKey: "session-hot-path-planner-ledger" });
    seedDelegationTicket(contract);

    const result = await executeDispatch({
      task: contract.userAsk,
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract.sessionKey)),
    }, {
      sessionKey: contract.sessionKey,
      sessionId: "session-hot-path-planner-ledger-test",
    });

    expect(result).toMatchObject({
      ok: true,
      status: "requires_native_spawn",
      delegation_method: "octoclaw_dispatch_planner",
      ticket_enforced: true,
      ticket_admission_reason: "ticket_admitted",
    });

    const spawnIntentId = String(result.spawn_intent_id);
    const attemptId = String(result.attempt_id);
    const sessionsSpawnArgs = result.sessions_spawn_args as Record<string, unknown>;
    expect(spawnIntentId).not.toBe("");
    expect(attemptId).toBe(`delegate-task:${contract.workContractId}:attempt:1`);

    let db = openDb();
    try {
      const ticket = db.prepare("SELECT status FROM delegation_tickets WHERE work_contract_id = ?").get(contract.workContractId);
      expect(ticket?.status).toBe("used");
      const attempt = db.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get(attemptId);
      expect(attempt).toMatchObject({
        work_contract_id: contract.workContractId,
        delegate_task_id: `delegate-task:${contract.workContractId}`,
        status: "admitted",
      });
      const queue = db.prepare("SELECT * FROM scheduler_queue WHERE attempt_id = ?").get(attemptId);
      expect(queue).toMatchObject({ work_contract_id: contract.workContractId, queue_status: "admitted" });
    } finally {
      db.close();
    }

    const started = nativeSpawnIntentStore.transitionToSpawnCallStarted({
      spawnIntentId,
      sessionKey: contract.sessionKey,
      sessionsSpawnArgs: sessionsSpawnArgs as never,
    });
    expect(started.ok).toBe(true);

    const confirmed = await confirmNativeSpawn({
      spawnIntentId,
      workContractId: contract.workContractId,
      sessionKey: contract.sessionKey,
      sessionsSpawnStatus: "accepted",
      runId: "run-planner-ledger",
      childRunId: "child-run-planner-ledger",
      childSessionKey: "agent:main:subagent:planner-ledger",
      notify: false,
    });
    expect(confirmed).toMatchObject({ ok: true, status: "accepted" });

    db = openDb();
    try {
      const attempt = db.prepare("SELECT * FROM task_attempts WHERE attempt_id = ?").get(attemptId);
      expect(attempt).toMatchObject({
        status: "running",
        native_flow_id: "sessions_spawn:run-planner-ledger",
        child_session_key: "agent:main:subagent:planner-ledger",
        child_run_id: "child-run-planner-ledger",
      });
      const queue = db.prepare("SELECT * FROM scheduler_queue WHERE attempt_id = ?").get(attemptId);
      expect(queue?.queue_status).toBe("running");
      const events = db.prepare(
        "SELECT event_type FROM runtime_events WHERE work_contract_id = ? ORDER BY event_id",
      ).all(contract.workContractId).map((event) => String(event.event_type));
      expect(events).toContain("delegation_ticket_used");
      expect(events).toContain("task_attempt_spawn_confirmed");
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

  it("enforce mode with scheduler disabled blocks dispatch", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    delete process.env.OCTOCLAW_SCHEDULER_ENABLED;
    const contract = seedWorkContract({ sessionKey: "session-hot-path-scheduler-disabled" });
    seedDelegationTicket(contract);

    const result = await executeDispatch({
      task: contract.userAsk,
      delegateTaskId: `delegate-task:${contract.workContractId}`,
      workContractId: contract.workContractId,
      policyJson: JSON.stringify(delegateDecision(contract.sessionKey)),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-scheduler-disabled-test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("blocked_by_scheduler_mandatory:scheduler_not_enabled");
    expect(result.dispatch_executed).toBe(false);
    expect(result.spawn_executed).toBe(false);
    expect(result.scheduler_status).toBe("blocked_by_scheduler_mandatory");
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

  it("follow-up query with existing_execution_followup creates no dispatch side effects", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "1";
    const task = "Why did the previous dispatch not succeed?";
    const decision = await resolveDelegatePolicy(task, "session-hot-path-followup", {
      relation_to_recent_execution: "existing_execution_followup",
    });
    const workContractId = String(decision.workContractId ?? "");
    expect(workContractId).not.toBe("");
    seedDelegationTicket(loadWorkContract(workContractId) as WorkContract);
    clearPolicyState();

    const result = await executeDispatch({
      task,
      delegateTaskId: `delegate-task:${workContractId}`,
      workContractId,
      policyJson: JSON.stringify(decision),
      metadataJson: JSON.stringify({ relation_to_recent_execution: "existing_execution_followup" }),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-followup-test",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/^work_contract_route_not_dispatchable:.*:reply$/u);
    expect(result.dispatch_executed).toBe(false);
    expect(result.spawn_executed).toBe(false);
    expect(result.materialized).toBe(false);
    expectNoDispatchSideEffects(workContractId);
  });

  it("follow-up query with existing_execution_provenance_query creates no dispatch side effects", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "1";
    const task = "Who handled the previous delegated task?";
    const decision = await resolveDelegatePolicy(task, "session-hot-path-provenance", {
      relation_to_recent_execution: "existing_execution_provenance_query",
    });
    const workContractId = String(decision.workContractId ?? "");
    expect(workContractId).not.toBe("");
    seedDelegationTicket(loadWorkContract(workContractId) as WorkContract);
    clearPolicyState();

    const result = await executeDispatch({
      task,
      delegateTaskId: `delegate-task:${workContractId}`,
      workContractId,
      policyJson: JSON.stringify(decision),
      metadataJson: JSON.stringify({ relation_to_recent_execution: "existing_execution_provenance_query" }),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-provenance-test",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/^work_contract_route_not_dispatchable:.*:reply$/u);
    expect(result.dispatch_executed).toBe(false);
    expect(result.spawn_executed).toBe(false);
    expect(result.materialized).toBe(false);
    expectNoDispatchSideEffects(workContractId);
  });

  it("follow-up status query (为啥没派发成功呢) creates no dispatch side effects", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "1";
    const dispatchedContract = seedWorkContract({ sessionKey: "session-hot-path-status-question-initial" });
    seedDelegationTicket(dispatchedContract);

    const dispatched = await executeDispatch({
      task: dispatchedContract.userAsk,
      delegateTaskId: `delegate-task:${dispatchedContract.workContractId}`,
      workContractId: dispatchedContract.workContractId,
      policyJson: JSON.stringify(delegateDecision(dispatchedContract.sessionKey)),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-status-question-initial-test",
    });
    expect(dispatched.dispatch_executed).toBe(true);

    const task = "为啥没派发成功呢";
    const decision = await resolveDelegatePolicy(task, "session-hot-path-status-question", {
      relation_to_recent_execution: "existing_execution_followup",
    });
    const workContractId = String(decision.workContractId ?? "");
    expect(workContractId).not.toBe("");
    seedDelegationTicket(loadWorkContract(workContractId) as WorkContract);
    clearPolicyState();

    const result = await executeDispatch({
      task,
      delegateTaskId: `delegate-task:${workContractId}`,
      workContractId,
      policyJson: JSON.stringify(decision),
      metadataJson: JSON.stringify({ relation_to_recent_execution: "existing_execution_followup" }),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-status-question-test",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/^work_contract_route_not_dispatchable:.*:reply$/u);
    expect(result.dispatch_executed).toBe(false);
    expect(result.spawn_executed).toBe(false);
    expect(result.materialized).toBe(false);
    expectNoDispatchSideEffects(workContractId);
  });

  it("new work with explicit new task request dispatches normally", async () => {
    useTempWorkspace();
    process.env.OCTOCLAW_RUNTIME_LEDGER = "enforce";
    process.env.OCTOCLAW_SCHEDULER_ENABLED = "1";
    const task = "Delegate a subagent to research the runtime ledger scheduler queue hot path and summarize the dispatch flow.";
    const decision = await resolveDelegatePolicy(task, "session-hot-path-new-work", {
      relation_to_recent_execution: "new_work",
      is_new_work: true,
      expected_deliverable: "summary of runtime ledger scheduler queue dispatch flow",
      conversation_control: {
        intent_class: "delegated_work",
        route_hint: "delegate",
        explicit_delegate_request: true,
        require_fresh_lookup: true,
      },
    });
    const workContractId = String(decision.workContractId ?? "");
    expect(workContractId).not.toBe("");
    const result = await executeDispatch({
      task,
      delegateTaskId: `delegate-task:${workContractId}`,
      workContractId,
      policyJson: JSON.stringify(decision),
      metadataJson: JSON.stringify({
        relation_to_recent_execution: "new_work",
        is_new_work: true,
        expected_deliverable: "summary of runtime ledger scheduler queue dispatch flow",
        conversation_control: {
          intent_class: "delegated_work",
          route_hint: "delegate",
          explicit_delegate_request: true,
          require_fresh_lookup: true,
        },
      }),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-hot-path-new-work-test",
    });

    expect(result.error).toBe("spawn_not_confirmed");
    expect(result.dispatch_executed).toBe(true);
    expect(result.spawn_executed).toBe(false);
    expect(result.materialized).toBe(true);
    expectDispatchSideEffects(workContractId);
  });
});
