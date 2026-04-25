import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { ROUTE_SEAL_SCHEMA_VERSION, type RouteSeal } from "@octoclaw/contracts/route-seal";
import { WORK_CONTRACT_SCHEMA_VERSION, type WorkContract } from "@octoclaw/contracts/work-contract";
import type { NativeHelperInvoker } from "../adapter/native-helper.js";
import { policyState } from "../state/policy-state.js";
import { saveWorkContract } from "../work-contract/store.js";
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

function workContract(overrides: Partial<WorkContract> = {}): WorkContract {
  const now = "2026-04-25T00:00:00.000Z";
  const base: WorkContract = {
    schemaVersion: WORK_CONTRACT_SCHEMA_VERSION,
    workContractId: "wc-dispatch-sealed",
    turnId: "turn-wc-1",
    sessionKey: "session-wc-dispatch",
    userAsk: "Investigate sealed work contract dispatch",
    intentClass: "delegated_work",
    route: "delegate",
    status: "sealed",
    coverage: {
      precheckOrder: [
        "conversation_grounding",
        "continuation_route_reuse",
        "execution_coverage",
        "memory_coverage",
        "build_judge_context_packet",
        "local_judge",
        "validator_or_remote",
        "route_seal_commit",
      ],
      execution: { coverage: "none" },
      memory: { coverage: "none" },
      conflict: false,
      authority: "none",
    },
    decision: {
      source: "local_judge",
      route: "delegate",
      delegateRole: "research",
      confidence: 0.9,
      reasonCodes: ["test"],
      sealedAt: now,
    },
    delegate: {
      delegateTaskId: "delegate-wc-1",
      currentAttemptId: null,
      role: "research",
      coordinationMode: "solo_worker",
      acceptanceCriteria: ["report result"],
      scope: {
        read: [],
        write: [],
        workspaceMode: "read_only",
        scopeFingerprint: "scope-wc-1",
      },
      modelProfile: "worker_research",
      nativeBinding: {
        flowId: "flow-wc-1",
        ownerKey: "session-wc-dispatch",
        controllerId: "octoclaw.delegate",
        revision: 1,
        expectedRevision: 1,
        syncMode: "managed",
        status: "queued",
      },
      childSessions: [],
      artifactRefs: [],
      nextAction: "dispatch",
    },
    continuity: {
      threadBindingKey: "thread-wc-1",
      parentSessionKey: "session-wc-dispatch",
      continuationMode: "resume_preferred",
      delegateTaskId: "delegate-wc-1",
    },
    mainContext: {
      summary: "sealed work contract test",
      statusLine: "ready",
      visibleIds: { workContractId: "wc-dispatch-sealed", delegateTaskId: "delegate-wc-1" },
      artifactRefs: [],
      nextAction: "dispatch",
      tokenBudget: { maxResumeTokens: 700, maxArtifactSummaryTokens: 250 },
      forbiddenContent: [],
    },
    telemetry: {},
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides };
}

function useTempWorkContractLedger(testName: string) {
  process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH = path.join("/tmp", `octoclaw-wc-${testName}-${Date.now()}.json`);
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

describe("WP4: sealed WorkContract dispatch", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OCTOCLAW_WORK_CONTRACT_LEDGER_PATH;
    for (const { key } of policyState.entries()) policyState.clear(key);
  });

  it("dispatch with workContractId uses sealed delegate route without re-judge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T00:00:00.000Z"));
    useTempWorkContractLedger("sealed-delegate");
    const contract = workContract({ workContractId: "wc-sealed-delegate" });
    expect(saveWorkContract(contract)).toBe(true);

    const result = await executeDispatch({
      task: "Dispatch sealed delegate contract",
      workContractId: contract.workContractId,
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-wc-sealed-delegate-test",
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe("delegate");
    expect(result.work_contract_id).toBe(contract.workContractId);
  });

  it("dispatch rejects sealed reply WorkContract", async () => {
    useTempWorkContractLedger("sealed-reply");
    const contract = workContract({
      workContractId: "wc-sealed-reply",
      route: "reply",
      decision: { ...workContract().decision, route: "reply", replyMode: "answer" },
      delegate: undefined,
    });
    expect(saveWorkContract(contract)).toBe(true);

    const result = await executeDispatch({
      task: "Dispatch sealed reply contract",
      workContractId: contract.workContractId,
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("work_contract_route_not_delegate");
  });

  it("dispatch rejects missing WorkContract", async () => {
    useTempWorkContractLedger("missing");

    const result = await executeDispatch({
      task: "Dispatch missing contract",
      workContractId: "wc-does-not-exist",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("work_contract_not_found");
  });

  it("dispatch rejects non-sealed WorkContract", async () => {
    useTempWorkContractLedger("draft");
    const contract = workContract({ workContractId: "wc-draft", status: "draft" });
    expect(saveWorkContract(contract)).toBe(true);

    const result = await executeDispatch({
      task: "Dispatch draft contract",
      workContractId: contract.workContractId,
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("work_contract_not_sealed");
  });

  it("legacy policyJson without workContractId still passes compatibility path", async () => {
    const result = await executeDispatch({
      task: "Legacy policy json still dispatches",
      policyJson: JSON.stringify(delegateDecision()),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-wc-legacy-policy-test",
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe("delegate");
  });

  it("policyJson with embedded workContractId loads sealed WorkContract route", async () => {
    useTempWorkContractLedger("embedded");
    const contract = workContract({ workContractId: "wc-embedded" });
    expect(saveWorkContract(contract)).toBe(true);
    const conflictingDecision = {
      ...delegateDecision("reply"),
      workContractId: contract.workContractId,
      work_contract: { workContractId: contract.workContractId },
    };

    const result = await executeDispatch({
      task: "Embedded contract overrides legacy route",
      policyJson: JSON.stringify(conflictingDecision),
    }, {
      helperInvoker: successfulHelper(),
      sessionId: "session-wc-embedded-test",
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe("delegate");
    expect(result.work_contract_id).toBe(contract.workContractId);
  });
});
