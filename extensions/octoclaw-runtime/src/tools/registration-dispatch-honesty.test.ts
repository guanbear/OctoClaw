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
import { getToolRegistrations } from "./registration.js";
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

function statusTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_status");
  if (!tool) throw new Error("octoclaw_status tool not registered");
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
      return { ok: true, native_task_id: "task-honesty", flow_id: "flow-honesty", task: { taskId: "task-honesty", status: "queued", state: "running", revision: 1 } };
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
  const ledgerPath = path.join(dir, "work-contracts.json");
  tempLedgerPaths.push(dir);
  process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH = ledgerPath;
  return ledgerPath;
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

describe("octoclaw_dispatch honesty", () => {
  afterEach(() => {
    delete process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH;
    policyState.clear("session-runtime-stub-without-evidence");
    envOverrides.workspaceRoot = "";
    for (const dir of tempLedgerPaths.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("filters leaked synthetic test tasks from status history", async () => {
    const dir = fs.mkdtempSync(path.join(osModule.tmpdir(), "octoclaw-status-synthetic-"));
    tempLedgerPaths.push(dir);
    envOverrides.workspaceRoot = dir;
    const stateDir = path.join(dir, "tmp", "octopus");
    fsSync.mkdirSync(stateDir, { recursive: true });
    fsSync.writeFileSync(path.join(stateDir, "task-state.json"), JSON.stringify({
      tasks: [{
        id: "task-honesty",
        flow_id: "flow-honesty",
        session_key: "session-dispatch-honesty-leak",
        status: "running",
        route: "delegate",
        summary: "Delegated task materialized natively as task-honesty",
        updated_at: "2026-04-25T00:00:00.000Z",
      }],
    }), "utf-8");

    const response = await statusTool().execute({ format: "table" }, {});
    const output = String((response.json as Record<string, unknown>).raw_output);

    expect(output).not.toContain("task-honesty");
    expect(output).not.toContain("flow-honesty");
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

    expect(tableOutput).toContain("Fields: task_id | projected_status(raw_status) | route | elapsed | delegated_at | model | backend");
    expect(tableOutput).toContain("Retention: archived=1, archive_deleted=0");
    expect(tableOutput).toContain("task-status-panel-1 | timed_out(running) | delegate");
    expect(tableOutput).toContain("model=zhipu/GLM-5.1");
    expect(tableOutput).toContain("backend=octoclaw-research");
    expect(tableOutput).toContain("delegated_at=2026-04-25T00:00:00.000Z");
    expect(tableOutput).toContain("reason=stale_status_no_progress>5m");

    const anchorsResponse = await statusTool().execute({ format: "anchors" }, {});
    const anchorsOutput = String((anchorsResponse.json as Record<string, unknown>).raw_output);
    expect(anchorsOutput).toContain("Expired hidden: 0");
    expect(anchorsOutput).not.toContain("task-status-panel-1 | timed_out(running) | delegate");
  });

  it("returns structured ok:true on success", async () => {
    const result = await executeDispatch({
      task: "Investigate runtime dispatch honesty",
      policyJson: JSON.stringify(delegateDecision()),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-dispatch-honesty-test",
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe("delegate");
    expect(result.worker_pool).toBe("octoclaw-research");
    expect(result.task_id).toBeTruthy();
    expect(result.delegation_method).toBe("octoclaw_dispatch");
    expect(result.dispatch_executed).toBeDefined();
    expect(result.native_task_id).toBeDefined();
    expect(result.native_flow_id).toBeDefined();
    expect(result.result_materialized).toBeDefined();
    expect(result.delivery_status).toBeDefined();
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

    expect(result.ok).toBe(true);
    expect(result.route).toBe("delegate");
    expect(result.work_contract_id).toBe(contract.workContractId);
    expect(result.delegate_task_id).toBeTruthy();
    expect(result.native_task_id).toBe("task-honesty");
    expect(result.native_flow_id).toBe("flow-honesty");
    const taskStatePath = path.join(envOverrides.workspaceRoot, "tmp", "octopus", "task-state.json");
    expect(fsSync.existsSync(taskStatePath)).toBe(false);
    expect(result.result_materialized).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    const reloaded = loadWorkContract(contract.workContractId);
    expect(reloaded?.status).toBe("queued");
    expect(reloaded?.delegate?.nativeBinding?.flowId).toBe("flow-honesty");
    expect(reloaded?.delegate?.nativeBinding?.nativeTaskId).toBe("task-honesty");
    expect(reloaded?.delegate?.nativeBinding?.status).toBe("running");
    expect(reloaded?.telemetry.dispatchExecuted).toBe(true);
    expect(reloaded?.telemetry.spawnExecuted).toBe(false);
    expect(reloaded?.telemetry.nativeTaskId).toBe("task-honesty");
    expect(reloaded?.telemetry.nativeFlowId).toBe("flow-honesty");
    expect(reloaded?.telemetry.resultMaterialized).toBe(false);
    expect(reloaded?.telemetry.deliveryStatus).toBe("none");
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

    expect(result.ok).toBe(true);
    expect(result.route).toBe("delegate");
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

    expect(result.ok).toBe(true);
    expect(result.route).toBe("delegate");
    expect(result.work_contract_id).toBe(contract.workContractId);
  });
});
