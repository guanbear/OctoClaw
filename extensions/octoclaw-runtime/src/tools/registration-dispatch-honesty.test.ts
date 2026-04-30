import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTE_SEAL_SCHEMA_VERSION, type RouteSeal } from "@octoclaw/contracts/route-seal";
import type { ContextCoverageSnapshot, CoverageAuthority, IntentClass, WorkContract, WorkRoute } from "@octoclaw/contracts/work-contract";
import type { NativeHelperInvoker } from "../adapter/native-helper.js";
import { envOverrides } from "../resolve/env.js";
import { buildExecutionCoverageLayer } from "../resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "../resolve/memory-coverage-precheck.js";
import { policyState } from "../state/policy-state.js";
import { dispatchReplyToMessageId, getToolRegistrations } from "./registration.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";
import { loadWorkContract, saveWorkContract } from "../work-contract/store.js";

const fs = fsSync as unknown as {
  mkdtempSync(pathname: string): string;
  rmSync(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
};
const osModule = os as unknown as { tmpdir(): string };

function dispatchTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_dispatch");
  if (!tool) throw new Error("octoclaw_dispatch tool not registered");
  return tool;
}

function dispatchToolWithRuntime(subagentRuntime: NonNullable<Parameters<typeof getToolRegistrations>[0]>["subagentRuntime"]) {
  const tool = getToolRegistrations({ subagentRuntime }).find((registration) => registration.name === "octoclaw_dispatch");
  if (!tool) throw new Error("octoclaw_dispatch tool not registered");
  return tool;
}

function statusTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_status");
  if (!tool) throw new Error("octoclaw_status tool not registered");
  return tool;
}

function routeHintTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_route_hint");
  if (!tool) throw new Error("octoclaw_route_hint tool not registered");
  return tool;
}

function taskActionTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_task_action");
  if (!tool) throw new Error("octoclaw_task_action tool not registered");
  return tool;
}

function delegateDecision(route = "delegate") {
  return {
    request: { session_key: "session-dispatch-honesty" },
    route_decision: {
      route,
      worker_pool: "octoclaw-research",
      task_class: "worker_research",
    },
    model_policy: { selected_model: "worker_research" },
  };
}

function seal(overrides: Partial<RouteSeal> = {}): RouteSeal {
  return {
    schemaVersion: ROUTE_SEAL_SCHEMA_VERSION,
    requestId: "req-1",
    turnId: "turn-1",
    threadBindingKey: "thread-1",
    route: "delegate",
    source: "local_judge",
    reasonCodes: ["test"],
    createdAt: "2026-04-24T00:00:00.000Z",
    inputHash: "hash-1",
    stateGeneration: 1,
    ...overrides,
  };
}

function successfulHelper(): NativeHelperInvoker {
  return ((input) => {
    if (input.action === "create-managed-flow") {
      return { ok: true, flow_id: "flow-honesty", flow: { flowId: "flow-honesty", status: "planned", revision: 1 } };
    }
    if (input.action === "run-task") {
      return { ok: true, native_task_id: "task-honesty", flow_id: "flow-honesty", task: { taskId: "task-honesty", status: "queued", state: "queued", revision: 1 } };
    }
    throw new Error(`unsupported_action:${input.action}`);
  }) as NativeHelperInvoker;
}

function spawnedHelper(): NativeHelperInvoker {
  return ((input) => {
    if (input.action === "create-managed-flow") {
      return { ok: true, flow_id: "flow-spawned", flow: { flowId: "flow-spawned", status: "planned", revision: 1 } };
    }
    if (input.action === "run-task") {
      return {
        ok: true,
        native_task_id: "task-spawned",
        flow_id: "flow-spawned",
        task: {
          taskId: "task-spawned",
          status: "running",
          state: "running",
          revision: 1,
          runId: "run-spawned",
          childSessionKey: "child-session-spawned",
          childSessionId: "child-session-id-spawned",
        },
      };
    }
    throw new Error(`unsupported_action:${input.action}`);
  }) as NativeHelperInvoker;
}

function materializedNoSpawnHelper(): NativeHelperInvoker {
  return ((input) => {
    if (input.action === "create-managed-flow") {
      return { ok: true, flow_id: "flow-no-spawn", flow: { flowId: "flow-no-spawn", status: "planned", revision: 1 } };
    }
    if (input.action === "run-task") {
      return { ok: true, native_task_id: "task-no-spawn", flow_id: "flow-no-spawn", task: { taskId: "task-no-spawn", status: "queued", state: "queued", revision: 1 } };
    }
    throw new Error(`unsupported_action:${input.action}`);
  }) as NativeHelperInvoker;
}

function failingHelper(): NativeHelperInvoker {
  return ((input) => {
    if (input.action === "create-managed-flow") {
      throw new Error("no worker available");
    }
    throw new Error("no worker available");
  }) as NativeHelperInvoker;
}

const tempLedgerPaths: string[] = [];

function useTempWorkContractLedger(): string {
  const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-wp4-"));
  tempLedgerPaths.push(dir);
  envOverrides.workspaceRoot = dir;
  return path.join(dir, "tmp", "octopus", "work-contracts.json");
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
} = {}): WorkContract {
  const route = options.route ?? "delegate";
  const sessionKey = options.sessionKey ?? "session-dispatch-work-contract";
  const userAsk = options.userAsk ?? "Dispatch from sealed WorkContract";
  const contract = buildWorkContractFromPolicy(
    sessionKey,
    userAsk,
    options.intentClass ?? "fresh_live_lookup",
    buildCoverageSnapshot(),
    buildWorkDecisionSeal("local_judge", route, ["wp4_test"]),
    {
      status: options.status ?? "sealed",
    },
  );
  saveWorkContract(contract);
  return contract;
}

async function executeDispatch(params: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const response = await dispatchTool().execute(params, ctx);
  expect(typeof response.text).toBe("string");
  return JSON.parse(response.text as string) as Record<string, unknown>;
}

async function executeDispatchWithRuntime(params: Record<string, unknown>, subagentRuntime: NonNullable<Parameters<typeof getToolRegistrations>[0]>["subagentRuntime"], ctx: Record<string, unknown> = {}) {
  const response = await dispatchToolWithRuntime(subagentRuntime).execute(params, ctx);
  expect(typeof response.text).toBe("string");
  return JSON.parse(response.text as string) as Record<string, unknown>;
}

describe("dispatchReplyToMessageId", () => {
  it("resolves Slack thread anchor from metadata, state, or ctx", () => {
    expect(dispatchReplyToMessageId({ message_id: "111.222" }, {}, {})).toBe("111.222");
    expect(dispatchReplyToMessageId({}, { inboundMessageTs: "222.333" }, {})).toBe("222.333");
    expect(dispatchReplyToMessageId({}, {}, { thread_ts: "333.444" })).toBe("333.444");
  });

  it("skips invalid zero reply anchors before dispatch", () => {
    expect(dispatchReplyToMessageId({ thread_ts: "0", message_id: "111.222" }, {}, {})).toBe("111.222");
    expect(dispatchReplyToMessageId({ thread_ts: "0" }, {}, {})).toBe("");
  });
});

describe("octoclaw_dispatch honesty", () => {
  afterEach(() => {
    delete process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH;
    policyState.clear("session-runtime-stub-without-evidence");
    policyState.clear("session-route-hint-sealed-reply");
    envOverrides.workspaceRoot = "";
    for (const dir of tempLedgerPaths.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("resolves task details by native and delegate aliases", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-task-alias-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;
    const stateDir = path.join(dir, "tmp", "octopus");
    fsSync.mkdirSync(stateDir, { recursive: true });
    fsSync.writeFileSync(path.join(stateDir, "task-state.json"), JSON.stringify({
      tasks: [{
        id: "wc-alias-1",
        workContractId: "wc-alias-1",
        work_contract_id: "wc-alias-1",
        taskId: "delegate-task:parent:1",
        task_id: "delegate-task:parent:1",
        nativeTaskId: "native-alias-1",
        native_task_id: "native-alias-1",
        flow_id: "flow-alias-1",
        status: "completed",
        route: "delegate",
        summary: "Alias lookup task",
        updated_at: "2026-04-30T00:00:00.000Z",
        workContract: {
          delegate: {
            childSessions: [{ delegateTaskId: "delegate-task:nested:1" }],
          },
        },
        artifacts: { runtime_truth: { binding: { nativeTaskId: "nested-native-alias" } } },
      }],
    }, null, 2));

    const byNative = await taskActionTool().execute({ action: "details", taskId: "native-alias-1", format: "json" }, {});
    expect(byNative.json).toMatchObject({ found: true, taskId: "wc-alias-1" });

    const byDelegate = await taskActionTool().execute({ action: "details", taskId: "delegate-task:parent:1", format: "json" }, {});
    expect(byDelegate.json).toMatchObject({ found: true, taskId: "wc-alias-1" });

    const byNestedDelegate = await taskActionTool().execute({ action: "details", taskId: "delegate-task:nested:1", format: "json" }, {});
    expect(byNestedDelegate.json).toMatchObject({ found: true, taskId: "wc-alias-1" });
  });

  it("filters leaked synthetic test tasks from status history", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-status-synthetic-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;
    const stateDir = path.join(dir, "tmp", "octopus");
    fsSync.mkdirSync(stateDir, { recursive: true });
    fsSync.writeFileSync(path.join(stateDir, "task-state.json"), JSON.stringify({
      tasks: [
        {
          id: "task-honesty",
          flow_id: "flow-honesty",
          session_key: "session-dispatch-honesty-leak",
          status: "running",
          route: "delegate",
          summary: "Delegated task materialized natively as task-honesty",
          updated_at: "2026-04-25T00:00:00.000Z",
        },
        {
          id: "task-no-spawn",
          flow_id: "flow-no-spawn",
          session_key: "session-work-contract-prior-continuity",
          status: "queued",
          route: "delegate",
          summary: "TaskFlow materialized; child session spawn not confirmed",
          updated_at: "2026-04-25T00:00:01.000Z",
        },
        {
          id: "task-spawned",
          flow_id: "flow-spawned",
          session_key: "session-dispatch-spawned-test",
          status: "running",
          route: "delegate",
          summary: "Delegated task materialized natively as task-spawned",
          updated_at: "2026-04-25T00:00:02.000Z",
        },
      ],
    }), "utf-8");

    const response = await statusTool().execute({ format: "table" }, {});
    const output = String((response.json as Record<string, unknown>).raw_output);

    expect(output).not.toContain("task-honesty");
    expect(output).not.toContain("flow-honesty");
    expect(output).not.toContain("task-no-spawn");
    expect(output).not.toContain("task-spawned");
  });

  it("does not project runtime truth stubs as completed tasks without execution evidence", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-status-stub-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;
    policyState.set("session-runtime-stub-without-evidence", {
      prompt: "stub should not become a fake task",
      delegated: false,
      decision: {
        request: { session_key: "session-runtime-stub-without-evidence" },
        route_decision: { route: "delegate", worker_pool: "octoclaw-research" },
        runtime_truth: {
          binding: {
            taskId: "task-runtime-stub-no-evidence",
            flowId: "flow-runtime-stub-no-evidence",
            status: "completed",
            substrateState: "completed",
          },
          recovery: { status: "healthy", reason: "workflow_healthy" },
        },
      },
    });

    const response = await statusTool().execute({ format: "table" }, {});
    const output = String((response.json as Record<string, unknown>).raw_output);

    expect(output).not.toContain("task-runtime-stub-no-evidence");
    expect(output).not.toContain("completed(completed) | delegate | elapsed=0s");
    expect(output).not.toContain("workflow_healthy");
  });

  it("does not project policyState runtime truth even when it has spawn evidence", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-status-policy-only-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;
    policyState.set("session-runtime-policy-only", {
      prompt: "policy-only task should not survive status projection",
      delegated: true,
      dispatchExecuted: true,
      spawnExecuted: true,
      resultMaterialized: false,
      decision: {
        request: { session_key: "session-runtime-policy-only" },
        route_decision: { route: "delegate", worker_pool: "octoclaw-research" },
        runtime_truth: {
          binding: { taskId: "task-policy-only", flowId: "flow-policy-only", status: "running", spawnExecuted: true },
          evidence: { dispatchExecuted: true, spawnExecuted: true },
        },
      },
    });

    const response = await statusTool().execute({ format: "table" }, {});
    const output = String((response.json as Record<string, unknown>).raw_output);

    expect(output).not.toContain("task-policy-only");
    expect(output).not.toContain("flow-policy-only");

    const details = await taskActionTool().execute({ action: "details", taskId: "task-policy-only", format: "json" }, {});
    expect(details.json).toMatchObject({ found: false, taskId: "task-policy-only" });
  });

  it("status panel hides reply records and shows delegate title plus complexity", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-status-delegate-only-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;
    const stateDir = path.join(dir, "tmp", "octopus");
    fsSync.mkdirSync(stateDir, { recursive: true });
    fsSync.writeFileSync(path.join(stateDir, "task-state.json"), JSON.stringify({
      tasks: [
        {
          id: "task-reply-hidden",
          status: "completed",
          route: "reply",
          summary: "Reply projection should stay out of status panel",
          updated_at: new Date().toISOString(),
        },
        {
          id: "task-delegate-visible",
          status: "running",
          summary: "Delegate execution is active",
          updated_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          flow_id: "flow-delegate-visible",
          childSessionKey: "child-session-visible",
          workContract: {
            route: "delegate",
            userAsk: "Migrate cron jobs",
            mainContext: { summary: "Migrate JAVDB cron jobs" },
            decision: { _judge_complexity_band: "normal" },
          },
        },
      ],
    }), "utf-8");

    const response = await statusTool().execute({ format: "table" }, {});
    const output = String((response.json as Record<string, unknown>).raw_output);

    expect(output).toContain("Total records: 1");
    expect(output).toContain("task-delegate-visible | running(running) | delegate");
    expect(output).toContain("title=Migrate JAVDB cron jobs");
    expect(output).toContain("complexity=normal");
    expect(output).not.toContain("task-reply-hidden");
    expect(output).not.toContain("Reply projection should stay out of status panel");
  });

  it("status panel projects stale running tasks with elapsed/model/backend fields", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-status-panel-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;
    const stateDir = path.join(dir, "tmp", "octopus");
    fsSync.mkdirSync(stateDir, { recursive: true });
    fsSync.writeFileSync(path.join(stateDir, "task-state.json"), JSON.stringify({
      tasks: [{
        id: "task-status-panel-1",
        status: "running",
        route: "delegate",
        summary: "Delegated task materialized natively",
        updated_at: "2026-04-25T00:00:00.000Z",
        started_at: "2026-04-25T00:00:00.000Z",
        spawned_at: "2026-04-25T00:00:00.000Z",
        model: "zhipu/GLM-5.1",
        worker_pool: "octoclaw-research",
        flow_id: "flow-status-panel-1",
      }],
    }), "utf-8");

    const tableResponse = await statusTool().execute({ format: "table" }, {});
    const tableOutput = String((tableResponse.json as Record<string, unknown>).raw_output);

    expect(tableOutput).toContain("Fields: task_id | projected_status(raw_status) | route | title | complexity | elapsed | delegated_at | model | backend");
    expect(tableOutput).toContain("result_location/artifact_refs");
    expect(tableOutput).toContain("Retention: archived=1, archive_deleted=0");
    expect(tableOutput).toContain("task-status-panel-1 | timed_out(running) | delegate");
    expect(tableOutput).toContain("title=Delegated task materialized natively");
    expect(tableOutput).toContain("complexity=unknown");
    expect(tableOutput).toContain("model=zhipu/GLM-5.1");
    expect(tableOutput).toContain("backend=octoclaw-research");
    expect(tableOutput).toContain("result=none");
    expect(tableOutput).toContain("delegated_at=2026-04-25T00:00:00.000Z");
    expect(tableOutput).toContain("reason=stale_status_no_progress>5m");

    const anchorsResponse = await statusTool().execute({ format: "anchors" }, {});
    const anchorsOutput = String((anchorsResponse.json as Record<string, unknown>).raw_output);
    expect(anchorsOutput).toContain("Expired hidden: 0");
    expect(anchorsOutput).not.toContain("task-status-panel-1 | timed_out(running) | delegate");
  });

  it("does not project explicit spawnExecuted=false plus continuity key as running", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-status-continuity-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;
    const stateDir = path.join(dir, "tmp", "octopus");
    fsSync.mkdirSync(stateDir, { recursive: true });
    fsSync.writeFileSync(path.join(stateDir, "task-state.json"), JSON.stringify({
      tasks: [{
        id: "task-continuity-no-spawn",
        status: "running",
        route: "delegate",
        summary: "Old child session key should not prove current spawn",
        updated_at: new Date().toISOString(),
        flow_id: "flow-continuity-no-spawn",
        dispatchExecuted: true,
        spawnExecuted: false,
        childSessionKey: "prior-child-key",
      }],
    }), "utf-8");

    const tableResponse = await statusTool().execute({ format: "table" }, {});
    const tableOutput = String((tableResponse.json as Record<string, unknown>).raw_output);

    expect(tableOutput).toContain("task-continuity-no-spawn | queued(running) | delegate");
    expect(tableOutput).toContain("reason=dispatch_materialized_but_no_spawn_evidence");
    expect(tableOutput).not.toContain("task-continuity-no-spawn | running(running)");
  });

  it("executes subagent runtime after native materialization to produce spawn evidence", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-runtime-spawn-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;
    const calls: Array<Record<string, unknown>> = [];
    const subagentRuntime = {
      run: vi.fn(async (params: Record<string, unknown>) => {
        calls.push(params);
        return { runId: "child-run-runtime" };
      }),
    };

    const result = await executeDispatchWithRuntime({
      task: "Spawn via runtime after materialization",
      policyJson: JSON.stringify({
        ...delegateDecision(),
        request: { session_key: "session-runtime-subagent" },
      }),
    }, subagentRuntime, {
      helperInvoker: materializedNoSpawnHelper(),
      sessionId: "session-runtime-subagent-test",
      agentId: "main",
    });

    expect(result.ok).toBe(true);
    expect(result.execution_state).toBe("spawn_confirmed");
    expect(result.dispatch_executed).toBe(true);
    expect(result.spawn_executed).toBe(true);
    expect(result.child_session_key).toContain(":subagent:");
    expect(result.child_run_id).toBe("child-run-runtime");
    expect(subagentRuntime.run).toHaveBeenCalledTimes(1);
    expect(String(calls[0]?.message)).toContain("[OctoClaw Delegated Task]");
    expect(String(calls[0]?.message)).not.toContain("raw transcript");

    const taskStatePath = path.join(dir, "tmp", "octopus", "task-state.json");
    const taskState = JSON.parse(fsSync.readFileSync(taskStatePath, "utf-8")) as { tasks: Array<Record<string, unknown>> };
    expect(taskState.tasks[0].status).toBe("running");
    expect(taskState.tasks[0].spawnExecuted).toBe(true);
    expect(taskState.tasks[0].runId).toBe("child-run-runtime");
  });

  it("returns structured ok:true only when spawn evidence exists", async () => {
    const result = await executeDispatch({
      task: "Investigate runtime dispatch honesty",
      policyJson: JSON.stringify(delegateDecision()),
    }, {
      helperInvoker: spawnedHelper(),
      sessionId: "session-dispatch-spawned-test",
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe("delegate");
    expect(result.worker_pool).toBe("octoclaw-research");
    expect(result.task_id).toBeTruthy();
    expect(result.delegation_method).toBe("octoclaw_dispatch");
    expect(result.materialized).toBe(true);
    expect(result.execution_state).toBe("spawn_confirmed");
    expect(result.dispatch_executed).toBe(true);
    expect(result.spawn_executed).toBe(true);
    expect(result.child_session_key).toBe("child-session-spawned");
    expect(result.native_task_id).toBeDefined();
    expect(result.native_flow_id).toBeDefined();
    expect(result.result_materialized).toBeDefined();
    expect(result.delivery_status).toBeDefined();
  });

  it("does not project materialized-only delegate as spawned or running", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-no-spawn-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;

    const result = await executeDispatch({
      task: "Materialize without child session evidence",
      policyJson: JSON.stringify({
        ...delegateDecision(),
        request: { session_key: "session-no-spawn-runtime" },
      }),
    }, {
      helperInvoker: materializedNoSpawnHelper(),
      sessionId: "session-no-spawn-test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn_not_confirmed");
    expect(result.materialized).toBe(true);
    expect(result.execution_state).toBe("materialized_no_spawn");
    expect(result.dispatch_executed).toBe(true);
    expect(result.spawn_executed).toBe(false);

    const taskStatePath = path.join(dir, "tmp", "octopus", "task-state.json");
    const taskState = JSON.parse(fsSync.readFileSync(taskStatePath, "utf-8")) as { tasks: Array<Record<string, unknown>> };
    expect(taskState.tasks[0].status).toBe("queued");
    expect(taskState.tasks[0].materialized_at).toBeTruthy();
    expect(taskState.tasks[0].spawned_at).toBeUndefined();
    expect(taskState.tasks[0].started_at).toBeUndefined();
    expect(taskState.tasks[0].spawnExecuted).toBe(false);

    const details = await getToolRegistrations()
      .find((registration) => registration.name === "octoclaw_task_action")!
      .execute({ action: "details", taskId: "task-no-spawn", format: "json" }, {});
    const payload = details.json as Record<string, unknown>;
    expect(payload.status).toBe("queued");
    expect(payload.statusReason).toBe("dispatch_materialized_but_no_spawn_evidence");
    expect(JSON.stringify(payload.timeline)).toContain("materialized");
    expect(JSON.stringify(payload.timeline)).not.toContain("spawned");
  });

  it("returns structured ok:false on failure", async () => {
    const result = await executeDispatch({
      task: "Dispatch with no worker available",
      policyJson: JSON.stringify(delegateDecision()),
    }, {
      helperInvoker: failingHelper(),
      sessionId: "session-dispatch-honesty-failure-test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns ok:false with seal_mismatch:true on seal mismatch", async () => {
    const stateKey = "session-dispatch-honesty-seal";
    const routeSeal = seal({ route: "delegate" });
    policyState.set(stateKey, {
      prompt: "Dispatch with mismatched seal",
      decision: {
        ...delegateDecision("delegate"),
        routeSeal,
      },
      routeSeal,
    });

    const result = await executeDispatch({
      task: "Dispatch with mismatched seal",
      forceRoute: "reply",
      metadataJson: JSON.stringify({
        turnId: "turn-1",
        threadBindingKey: "thread-1",
        session_key: stateKey,
      }),
    }, {
      sessionKey: stateKey,
      canonicalSessionKey: stateKey,
      sessionId: "session-dispatch-honesty-seal-test",
      turnId: "turn-1",
      threadBindingKey: "thread-1",
      helperInvoker: successfulHelper(),
    });

    expect(result.ok).toBe(false);
    expect(result.seal_mismatch).toBe(true);
    expect(result.retryable).toBe(false);
  });

  it("includes terminal:true for terminal dispatch honesty failures", async () => {
    const stateKey = "session-dispatch-honesty-terminal";
    const routeSeal = seal({ route: "delegate" });
    policyState.set(stateKey, {
      prompt: "Dispatch with terminal seal mismatch",
      decision: {
        ...delegateDecision("delegate"),
        routeSeal,
      },
      routeSeal,
    });

    const result = await executeDispatch({
      task: "Dispatch with terminal seal mismatch",
      forceRoute: "reply",
      metadataJson: JSON.stringify({
        turnId: "turn-1",
        threadBindingKey: "thread-1",
        session_key: stateKey,
      }),
    }, {
      sessionKey: stateKey,
      canonicalSessionKey: stateKey,
      sessionId: "session-dispatch-honesty-terminal-test",
      turnId: "turn-1",
      threadBindingKey: "thread-1",
      helperInvoker: successfulHelper(),
    });

    expect(result.ok).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.retryable).toBe(false);
  });

  it("never returns plain string", async () => {
    const results = await Promise.all([
      executeDispatch({ task: "success path", policyJson: JSON.stringify(delegateDecision()) }, { helperInvoker: successfulHelper(), sessionId: "plain-success" }),
      executeDispatch({ task: "failure path", policyJson: JSON.stringify(delegateDecision()) }, { helperInvoker: failingHelper(), sessionId: "plain-failure" }),
    ]);

    for (const result of results) {
      expect(Object.prototype.hasOwnProperty.call(result, "ok")).toBe(true);
    }
  });

  it("dispatches a sealed delegate WorkContract without resolving policy again", async () => {
    useTempWorkContractLedger();
    const contract = seedWorkContract();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await executeDispatch({
      task: contract.userAsk,
      workContractId: contract.workContractId,
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-work-contract-dispatch",
    });

    expect(result.ok).toBe(false);
    expect(result.route).toBe("delegate");
    expect(result.error).toBe("spawn_not_confirmed");
    expect(result.retryable).toBe(true);
    expect(result.materialized).toBe(true);
    expect(result.execution_state).toBe("materialized_no_spawn");
    expect(result.work_contract_id).toBe(contract.workContractId);
    expect(result.delegate_task_id).toBeTruthy();
    expect(result.native_task_id).toBe("task-honesty");
    expect(result.native_flow_id).toBe("flow-honesty");
    expect(result.dispatch_executed).toBe(true);
    expect(result.spawn_executed).toBe(false);
    const taskStatePath = path.join(envOverrides.workspaceRoot, "tmp", "octopus", "task-state.json");
    expect(fsSync.existsSync(taskStatePath)).toBe(true);
    const taskState = JSON.parse(fsSync.readFileSync(taskStatePath, "utf-8")) as { tasks: Array<Record<string, unknown>> };
    expect(taskState.tasks[0]).toMatchObject({
      id: contract.workContractId,
      workContractId: contract.workContractId,
      taskId: "task-honesty",
      flowId: "flow-honesty",
      status: "queued",
      dispatchExecuted: true,
      spawnExecuted: false,
    });
    expect(taskState.tasks[0].workContract).toBeTruthy();
    expect(result.result_materialized).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    const reloaded = loadWorkContract(contract.workContractId);
    expect(reloaded?.status).toBe("planned");
    expect(reloaded?.delegate?.nativeBinding?.flowId).toBe("flow-honesty");
    expect(reloaded?.delegate?.nativeBinding?.nativeTaskId).toBe("task-honesty");
    expect(reloaded?.delegate?.nativeBinding?.status).toBe("queued");
    expect(reloaded?.telemetry.dispatchExecuted).toBe(true);
    expect(reloaded?.telemetry.spawnExecuted).toBe(false);
    expect(reloaded?.telemetry.nativeTaskId).toBe("task-honesty");
    expect(reloaded?.telemetry.nativeFlowId).toBe("flow-honesty");
    expect(reloaded?.telemetry.resultMaterialized).toBe(false);
    expect(reloaded?.telemetry.deliveryStatus).toBe("none");
  });

  it("does not treat prior WorkContract continuity as current spawn evidence", async () => {
    useTempWorkContractLedger();
    const contract = seedWorkContract();
    saveWorkContract({
      ...contract,
      continuity: {
        ...contract.continuity,
        preferredChildSessionKey: "prior-child-key",
        preferredChildSessionId: "prior-provider-session",
        preferredRunId: "prior-run-id",
      },
      delegate: {
        delegateTaskId: "prior-delegate-task",
        currentAttemptId: "prior-attempt",
        role: "research",
        coordinationMode: "solo_worker",
        acceptanceCriteria: [],
        scope: { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "prior" },
        modelProfile: "worker_research",
        nativeBinding: {
          flowId: "prior-flow",
          nativeFlowId: "prior-flow",
          ownerKey: "prior-delegate-task",
          controllerId: "octoclaw.delegate",
          revision: 3,
          expectedRevision: 3,
          taskId: "prior-task",
          nativeTaskId: "prior-task",
          runId: "prior-run-id",
          childRunId: "prior-child-run",
          childSessionKey: "prior-child-key",
          syncMode: "managed",
          status: "running",
        },
        childSessions: [],
        artifactRefs: [],
        nextAction: "dispatch",
      },
    } as WorkContract);

    const result = await executeDispatch({
      task: contract.userAsk,
      workContractId: contract.workContractId,
    }, {
      helperInvoker: materializedNoSpawnHelper(),
      sessionId: "session-work-contract-prior-continuity",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn_not_confirmed");
    expect(result.execution_state).toBe("materialized_no_spawn");
    expect(result.dispatch_executed).toBe(true);
    expect(result.spawn_executed).toBe(false);

    const reloaded = loadWorkContract(contract.workContractId);
    expect(reloaded?.delegate?.nativeBinding?.runId).toBe("prior-run-id");
    expect(reloaded?.delegate?.nativeBinding?.childSessionKey).toBe("prior-child-key");
    expect(reloaded?.telemetry.spawnExecuted).toBe(false);
  });

  it("marks sealed WorkContract failed when native materialization returns a payload failure", async () => {
    useTempWorkContractLedger();
    const contract = seedWorkContract({ userAsk: "contract failure is materialized" });

    const result = await executeDispatch({
      task: contract.userAsk,
      workContractId: contract.workContractId,
    }, {
      helperInvoker: failingHelper(),
      sessionId: "session-work-contract-failure",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("ts_runtime_materialization_failed");

    const reloaded = loadWorkContract(contract.workContractId);
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.delegate?.nextAction).toBe("retry");
    expect(reloaded?.delegate?.blocker).toContain("ts_runtime_materialization_failed");
    expect(reloaded?.telemetry.resultMaterialized).toBe(false);
    expect(reloaded?.telemetry.deliveryStatus).toBe("failed");
  });

  it("rejects a sealed reply WorkContract dispatch", async () => {
    useTempWorkContractLedger();
    const contract = seedWorkContract({ route: "reply", intentClass: "execution_followup" });

    const result = await executeDispatch({
      task: contract.userAsk,
      workContractId: contract.workContractId,
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-work-contract-reply",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("work_contract_route_not_dispatchable");
    expect(result.terminal).toBe(true);
  });

  it("preserves a sealed reply WorkContract when the main agent later hints delegate", async () => {
    const task = "解释上一轮为什么投递失败";
    policyState.set("session-route-hint-sealed-reply", {
      prompt: task,
      decision: {
        request: { session_key: "session-route-hint-sealed-reply", metadata: {} },
        route_decision: { route: "reply", dispatch_required: false, reason_codes: ["execution_followup"] },
        tool_policy: { block_tool_patterns: ["octoclaw_dispatch", "spawn"] },
        work_contract: { workContractId: "wc-sealed-reply", route: "reply" },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const response = await routeHintTool().execute({
      task,
      routeHint: "delegate",
      reason: "main agent tried to diagnose via delegate",
    }, {
      sessionKey: "session-route-hint-sealed-reply",
      sessionId: "session-route-hint-sealed-reply",
    });

    const payload = response.json as Record<string, any>;
    expect(payload.route_decision.route).toBe("reply");
    expect(payload.route_hint_policy).toMatchObject({
      submitted: true,
      blocked_by_sealed_work_contract: true,
    });
    expect(payload.route_decision.reason_codes).toContain("route_hint_blocked_by_sealed_work_contract");
  });

  it("rejects missing and non-sealed WorkContracts", async () => {
    useTempWorkContractLedger();
    const pending = seedWorkContract({ status: "materializing" });

    const missing = await executeDispatch({
      task: "missing contract",
      workContractId: "wc-missing",
    }, { helperInvoker: successfulHelper(), sessionId: "session-work-contract-missing" });
    const nonSealed = await executeDispatch({
      task: pending.userAsk,
      workContractId: pending.workContractId,
    }, { helperInvoker: successfulHelper(), sessionId: "session-work-contract-nonsealed" });

    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toContain("work_contract_not_found");
    expect(nonSealed.ok).toBe(false);
    expect(String(nonSealed.error)).toContain("work_contract_not_sealed");
  });

  it("keeps legacy policyJson compatibility without a WorkContract id", async () => {
    const ledgerPath = useTempWorkContractLedger();
    const result = await executeDispatch({
      task: "legacy compatibility path",
      policyJson: JSON.stringify(delegateDecision()),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-legacy-policy-json",
    });

    expect(result.ok).toBe(false);
    expect(result.route).toBe("delegate");
    expect(result.error).toBe("spawn_not_confirmed");
    expect(result.materialized).toBe(true);
    expect(result.spawn_executed).toBe(false);
    expect(result.work_contract_id).toBeNull();
    expect(fsSync.existsSync(ledgerPath)).toBe(false);
  });

  it("uses sealed WorkContract route over conflicting legacy policyJson", async () => {
    useTempWorkContractLedger();
    const contract = seedWorkContract({ route: "delegate", userAsk: "contract wins" });
    const conflictingPolicy = {
      ...delegateDecision("reply"),
      workContractId: contract.workContractId,
      work_contract: { workContractId: contract.workContractId, route: "reply" },
    };

    const result = await executeDispatch({
      task: contract.userAsk,
      policyJson: JSON.stringify(conflictingPolicy),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-contract-wins",
    });

    expect(result.ok).toBe(false);
    expect(result.route).toBe("delegate");
    expect(result.error).toBe("spawn_not_confirmed");
    expect(result.work_contract_id).toBe(contract.workContractId);
  });
});
