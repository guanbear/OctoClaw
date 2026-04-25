import { describe, it, expect, vi } from "vitest";
import type { NativeBindingRef } from "@octoclaw/contracts/work-contract";
import type { BoundTaskFlowPort } from "../ports/taskflow-port.js";
import {
  buildCompactStateJson,
  createManagedWorkFlow,
  failWorkFlow,
  finishWorkFlow,
  refreshNativeBinding,
  resumeManagedWorkFlow,
  setWorkFlowWaiting,
  type CompactDelegateRef,
} from "./native-taskflow-adapter.js";

describe("native taskflow adapter", () => {
  it("createManaged creates flow and returns binding with revision", async () => {
    const port = createMockPort({
      createManaged: vi.fn().mockResolvedValue({ flowId: "flow-1", status: "queued", revision: 1 }),
    });

    const result = await createManagedWorkFlow(port, "octoclaw.delegate", "do work", ref);

    expect(port.createManaged).toHaveBeenCalledWith({
      controllerId: "octoclaw.delegate",
      goal: "do work",
      currentStep: "dispatch",
      stateJson: buildCompactStateJson(ref),
    });
    expect(result.binding.flowId).toBe("flow-1");
    expect(result.binding.revision).toBe(1);
    expect(result.binding.expectedRevision).toBe(1);
    expect(result.binding.lastMutation).toBe("createManaged");
    expect(result.binding.lastMutationApplied).toBe(true);
    expect(result.mutationApplied).toBe(true);
  });

  it("resumeManagedWorkFlow passes expectedRevision", async () => {
    const port = createMockPort({
      setWaiting: vi.fn().mockResolvedValue({ applied: true, flowId: "flow-1", status: "waiting", revision: 4 }),
    });

    const result = await resumeManagedWorkFlow(port, buildBinding({ expectedRevision: 3, revision: 3 }), "dispatch");

    expect(port.setWaiting).toHaveBeenCalledWith(expect.objectContaining({
      flowId: "flow-1",
      expectedRevision: 3,
      currentStep: "dispatch",
    }));
    expect(result.binding.revision).toBe(4);
    expect(result.binding.expectedRevision).toBe(4);
    expect(result.binding.lastMutation).toBe("resume");
  });

  it("setWorkFlowWaiting sets currentStep to await_worker", async () => {
    const port = createMockPort();

    const result = await setWorkFlowWaiting(port, buildBinding({ expectedRevision: 2, revision: 2 }), "worker_result", ref);

    expect(port.setWaiting).toHaveBeenCalledWith(expect.objectContaining({
      flowId: "flow-1",
      expectedRevision: 2,
      currentStep: expect.stringContaining("await"),
      waitJson: buildCompactStateJson(ref),
    }));
    expect(result.binding.currentStep).toBe("await_worker");
    expect(result.binding.waitKind).toBe("worker_result");
    expect(result.binding.status).toBe("waiting");
  });

  it("finishWorkFlow sets status to succeeded", async () => {
    const port = createMockPort({
      finish: vi.fn().mockResolvedValue({ applied: true, flowId: "flow-1", status: "completed", revision: 5 }),
    });

    const result = await finishWorkFlow(port, buildBinding({ expectedRevision: 4, revision: 4 }), ref);

    expect(port.finish).toHaveBeenCalledWith(expect.objectContaining({
      flowId: "flow-1",
      expectedRevision: 4,
      stateJson: buildCompactStateJson(ref),
    }));
    expect(result.binding.status).toBe("succeeded");
    expect(result.binding.lastMutation).toBe("finish");
    expect(result.binding.revision).toBe(5);
    expect(result.binding.expectedRevision).toBe(5);
  });

  it("failWorkFlow sets status to failed", async () => {
    const port = createMockPort({
      fail: vi.fn().mockResolvedValue({ applied: true, flowId: "flow-1", status: "failed", revision: 6 }),
    });

    const result = await failWorkFlow(port, buildBinding({ expectedRevision: 5, revision: 5 }), "worker failed");

    expect(port.fail).toHaveBeenCalledWith(expect.objectContaining({
      flowId: "flow-1",
      expectedRevision: 5,
      stateJson: { error: "worker failed" },
    }));
    expect(result.binding.status).toBe("failed");
    expect(result.binding.lastMutation).toBe("fail");
    expect(result.binding.revision).toBe(6);
  });

  it("revision_conflict refreshes native binding from current flow", async () => {
    const port = createMockPort({
      setWaiting: vi.fn().mockResolvedValue({ applied: false, flowId: "flow-1", status: "revision_conflict", revision: 3, error: "revision_conflict" }),
      get: vi.fn().mockResolvedValue({ flowId: "flow-1", status: "running", revision: 5 }),
    });

    const result = await resumeManagedWorkFlow(port, buildBinding({ expectedRevision: 3, revision: 3 }), "dispatch");

    expect(result.mutationApplied).toBe(false);
    expect(result.mutationError).toBe("revision_conflict");
    expect(result.binding.lastMutationApplied).toBe(false);
    expect(result.binding.lastMutationError).toBe("revision_conflict");
    expect(port.setWaiting).toHaveBeenCalledTimes(1);
    expect(port.get).toHaveBeenCalledWith("flow-1");
    expect(result.binding.revision).toBe(5);
    expect(result.binding.expectedRevision).toBe(5);
    expect(result.binding.status).toBe("running");
    expect(result.binding.ownerKey).toBe("wc-1");
    expect(result.binding.controllerId).toBe("octoclaw.delegate");
    expect(result.binding.stateRef).toBe(buildCompactStateJson(ref));
  });

  it("revision_conflict with null refresh falls back to stale binding", async () => {
    const port = createMockPort({
      setWaiting: vi.fn().mockResolvedValue({ applied: false, flowId: "flow-1", status: "revision_conflict", revision: 3, error: "revision_conflict" }),
      get: vi.fn().mockResolvedValue(null),
    });

    const result = await resumeManagedWorkFlow(port, buildBinding({ expectedRevision: 3, revision: 3 }), "dispatch");

    expect(result.mutationApplied).toBe(false);
    expect(result.mutationError).toBe("revision_conflict");
    expect(result.binding.revision).toBe(3);
    expect(port.get).toHaveBeenCalledWith("flow-1");
  });

  it("not_found returns null from refreshNativeBinding", async () => {
    const port = createMockPort({ get: vi.fn().mockResolvedValue(null) });

    const result = await refreshNativeBinding(port, "flow-missing");

    expect(port.get).toHaveBeenCalledWith("flow-missing");
    expect(result).toBeNull();
  });

  it("refreshNativeBinding updates binding from current flow", async () => {
    const port = createMockPort({
      get: vi.fn().mockResolvedValue({ flowId: "flow-1", status: "running", revision: 7 }),
    });

    const result = await refreshNativeBinding(port, "flow-1");

    expect(result).not.toBeNull();
    expect(result?.flowId).toBe("flow-1");
    expect(result?.revision).toBe(7);
    expect(result?.expectedRevision).toBe(7);
    expect(result?.status).toBe("running");
  });

  it("mutation returns not_found when flow is missing", async () => {
    const port = createMockPort({
      finish: vi.fn().mockResolvedValue({ applied: false, flowId: "flow-missing", status: "not_found", error: "not_found" }),
    });

    const result = await finishWorkFlow(port, buildBinding({ flowId: "flow-missing" }), ref);

    expect(result.mutationApplied).toBe(false);
    expect(result.mutationError).toBe("not_found");
    expect(result.binding.lastMutationApplied).toBe(false);
    expect(result.binding.lastMutationError).toBe("not_found");
  });

  it("mutation returns not_managed when port throws", async () => {
    const port = createMockPort({
      fail: vi.fn().mockRejectedValue(new Error("not managed by this controller")),
    });

    const result = await failWorkFlow(port, buildBinding(), "worker crashed");

    expect(result.mutationApplied).toBe(false);
    expect(result.mutationError).toBe("not_managed");
    expect(result.binding.lastMutationApplied).toBe(false);
    expect(result.binding.lastMutationError).toBe("not_managed");
  });
});

const ref: CompactDelegateRef = {
  kind: "octoclaw_delegate_ref",
  workContractId: "wc-1",
  delegateTaskId: "delegate-1",
  attemptId: "attempt-1",
  artifactRefs: ["artifact-1"],
};

function buildBinding(overrides: Partial<NativeBindingRef> = {}): NativeBindingRef {
  return {
    flowId: "flow-1",
    ownerKey: "wc-1",
    controllerId: "octoclaw.delegate",
    revision: 1,
    expectedRevision: 1,
    syncMode: "managed",
    status: "running",
    stateRef: buildCompactStateJson(ref),
    ...overrides,
  };
}

function createMockPort(overrides: Partial<BoundTaskFlowPort> = {}): BoundTaskFlowPort {
  return {
    createManaged: vi.fn().mockResolvedValue({ flowId: "flow-mock", status: "queued", revision: 1 }),
    runTask: vi.fn().mockResolvedValue({ created: true, flowId: "flow-mock", taskId: "task-mock" }),
    get: vi.fn().mockResolvedValue({ flowId: "flow-mock", status: "running", revision: 2 }),
    resolve: vi.fn().mockResolvedValue(null),
    getTaskSummary: vi.fn().mockResolvedValue(null),
    setWaiting: vi.fn().mockResolvedValue({ applied: true, flowId: "flow-mock", status: "waiting", revision: 3 }),
    finish: vi.fn().mockResolvedValue({ applied: true, flowId: "flow-mock", status: "completed", revision: 4 }),
    fail: vi.fn().mockResolvedValue({ applied: true, flowId: "flow-mock", status: "failed", revision: 5 }),
    cancel: vi.fn().mockResolvedValue({ cancelled: true, flowId: "flow-mock", found: true }),
    ...overrides,
  };
}
