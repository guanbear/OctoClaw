import { describe, expect, it } from "vitest";
import type { TaskFlowBridge } from "../adapter/taskflow-bridge.js";
import { OpenClawDistTaskFlowPort, type BoundDistTaskFlowPort } from "./openclaw-dist-taskflow-port.js";

describe("TaskFlowPort adapters", () => {
  it("dispatch creates native task id findable by details", async () => {
    const bridge = buildInMemoryBridge();
    const bound: BoundDistTaskFlowPort = new OpenClawDistTaskFlowPort({ bridgeFactory: async () => bridge })
      .bindSession({ sessionKey: "session-dist" });

    const flow = await bound.createManaged({ controllerId: "controller", goal: "goal" });
    const run = await bound.runTask({ flowId: flow.flowId, task: "do work", status: "queued" });
    const details = await bound.getTaskSummary(flow.flowId);

    expect(run.taskId).toBe("task-1");
    expect(details?.taskId).toBe("task-1");
    expect(details?.status).toBe("queued");
  });

  it("status/details return same authority state for same id", async () => {
    const bridge = buildInMemoryBridge();
    const bound: BoundDistTaskFlowPort = new OpenClawDistTaskFlowPort({ bridgeFactory: async () => bridge })
      .bindSession({ sessionKey: "session-dist" });

    const flow = await bound.createManaged({ controllerId: "controller", goal: "goal", status: "running" });
    await bound.runTask({ flowId: flow.flowId, task: "do work", status: "running" });
    const status = await bound.get(flow.flowId);
    const details = await bound.getTaskSummary(flow.flowId);

    expect(status?.status).toBe("running");
    expect(details?.state).toBe("running");
    expect(details?.revision).toBe(status?.revision);
  });

  it("createManaged passes stateJson and waitJson to bridge", async () => {
    let capturedStateJson: unknown;
    let capturedWaitJson: unknown;
    const port = new OpenClawDistTaskFlowPort({
      bridgeFactory: async () => ({
        createManagedFlow: (input) => {
          capturedStateJson = input.stateJson;
          capturedWaitJson = input.waitJson;
          return { ok: true, status: "ok", flow_id: "flow-1", flow: { flowId: "flow-1", status: "queued", revision: 1 } };
        },
        runTask: () => ({ ok: true, status: "ok", flow_id: "flow-1", native_task_id: "task-1", task: { taskId: "task-1", status: "queued", state: "queued", revision: 1 } }),
        readFlow: () => ({ ok: true, status: "ok", flow_id: "flow-1", found: true, flow: { flowId: "flow-1", status: "queued", revision: 1 } }),
        readTask: () => ({ ok: false, status: "not_found", flow_id: "flow-1", task_id: "task-1", found: false, task: null }),
        setWaiting: (input) => ({ ok: true, status: "ok", flow_id: input.flowId, revision: 2 }),
        finishFlow: (input) => ({ ok: true, status: "ok", flow_id: input.flowId, revision: 2 }),
        failFlow: (input) => ({ ok: true, status: "ok", flow_id: input.flowId, revision: 2 }),
        cancelFlow: (input) => ({ ok: true, status: "ok", flow_id: input.flowId, found: true, cancelled: true }),
      }),
    });
    const bound = port.bindSession({ sessionKey: "test" });
    await bound.createManaged({
      controllerId: "octoclaw.delegate",
      goal: "test",
      stateJson: { kind: "octoclaw_delegate_ref", workContractId: "wc-1" },
      waitJson: { kind: "worker_result" },
    });
    expect(capturedStateJson).toBe('{"kind":"octoclaw_delegate_ref","workContractId":"wc-1"}');
    expect(capturedWaitJson).toBe('{"kind":"worker_result"}');
  });

});

function buildInMemoryBridge(): TaskFlowBridge {
  const flows = new Map<string, { flowId: string; status: string; revision: number; tasks: Array<{ taskId: string; status: string; state: string; revision: number }> }>();
  let nextFlow = 1;
  let nextTask = 1;
  return {
    createManagedFlow: (input) => {
      const flow = { flowId: `flow-${nextFlow}`, status: input.status || "queued", revision: nextFlow, tasks: [] };
      nextFlow += 1;
      flows.set(flow.flowId, flow);
      return { ok: true, status: "ok", flow_id: flow.flowId, flow };
    },
    runTask: (input) => {
      const flow = flows.get(input.flowId);
      if (!flow) return { ok: false, status: "not_found", flow_id: input.flowId, task: null };
      const task = { taskId: `task-${nextTask}`, status: input.status || "queued", state: input.status || "queued", revision: flow.revision };
      nextTask += 1;
      flow.tasks.push(task);
      return { ok: true, status: "ok", native_task_id: task.taskId, flow_id: flow.flowId, task };
    },
    readFlow: (input) => {
      const flow = flows.get(input.flowId);
      return flow ? { ok: true, status: "ok", flow_id: input.flowId, found: true, flow } : { ok: false, status: "not_found", flow_id: input.flowId, found: false, flow: null };
    },
    readTask: (input) => {
      const task = flows.get(input.flowId)?.tasks.find((candidate) => candidate.taskId === input.taskId) ?? null;
      return task ? { ok: true, status: "ok", flow_id: input.flowId, task_id: input.taskId, found: true, task } : { ok: false, status: "not_found", flow_id: input.flowId, task_id: input.taskId, found: false, task: null };
    },
    setWaiting: (input) => ({ ok: true, status: "ok", flow_id: input.flowId, revision: Number(input.expectedRevision || 0) + 1 }),
    finishFlow: (input) => ({ ok: true, status: "ok", flow_id: input.flowId, revision: Number(input.expectedRevision || 0) + 1 }),
    failFlow: (input) => ({ ok: true, status: "ok", flow_id: input.flowId, revision: Number(input.expectedRevision || 0) + 1 }),
    cancelFlow: (input) => ({ ok: true, status: "ok", flow_id: input.flowId, found: flows.has(input.flowId), cancelled: flows.has(input.flowId) }),
  };
}
