import { describe, expect, it } from "vitest";
import { ROUTE_SEAL_SCHEMA_VERSION, type RouteSeal } from "@octoclaw/contracts/route-seal";
import type { NativeHelperInvoker } from "../adapter/native-helper.js";
import { policyState } from "../state/policy-state.js";
import { getToolRegistrations } from "./registration.js";

function dispatchTool() {
  const tool = getToolRegistrations().find((registration) => registration.name === "octoclaw_dispatch");
  if (!tool) throw new Error("octoclaw_dispatch tool not registered");
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

async function executeDispatch(params: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const response = await dispatchTool().execute(params, ctx);
  expect(typeof response.text).toBe("string");
  return JSON.parse(response.text as string) as Record<string, unknown>;
}

describe("octoclaw_dispatch honesty", () => {
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
});
