import { describe, expect, it } from "vitest";
import type { TaskFlowBridge } from "../adapter/taskflow-bridge.js";
import { OpenClawDistTaskFlowPort, type BoundDistTaskFlowPort } from "./openclaw-dist-taskflow-port.js";
import { createOpenClawRuntimeTaskFlowPort, type OpenClawRuntimeTaskFlowApiContainer } from "./openclaw-runtime-taskflow-port.js";

describe("TaskFlowPort adapters", () => {
  it("fake api.runtime.taskFlow injection does not trigger dist scan", async () => {
    const calls: string[] = [];
    const api: OpenClawRuntimeTaskFlowApiContainer = {
      runtime: {
        taskFlow: {
          bindSession: (input) => {
            calls.push(`bind:${input.sessionKey}`);
            return {
              createManaged: () => ({ flowId: "flow-runtime", status: "queued", revision: 1 }),
              runTask: () => ({ created: true, task: { taskId: "task-runtime" } }),
              getFlow: ({ flowId }) => ({ flowId, status: "running", revision: 2, tasks: [] }),
              setWaiting: () => ({ applied: true, flow: { flowId: "flow-runtime", revision: 3 } }),
              finish: () => ({ applied: true, flow: { flowId: "flow-runtime", revision: 4 } }),
              fail: () => ({ applied: true, flow: { flowId: "flow-runtime", revision: 5 } }),
              cancel: () => ({ cancelled: true, flowId: "flow-runtime", found: true }),
            };
          },
        },
      },
    };

    const bound = createOpenClawRuntimeTaskFlowPort(api).bindSession({ sessionKey: "session-runtime" });
    const managed = await bound.createManaged({ controllerId: "controller", goal: "goal" });

    expect(managed.flowId).toBe("flow-runtime");
    expect(calls).toEqual(["bind:session-runtime"]);
  });

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

  it("native status maps to OctoClaw projection", async () => {
    const api: OpenClawRuntimeTaskFlowApiContainer = {
      runtime: {
        taskFlow: {
          bindSession: () => ({
            createManaged: () => ({ flowId: "flow-wait", status: "waiting", revision: 8 }),
            runTask: () => ({ created: true, flowId: "flow-wait", task: { taskId: "task-wait", state: "waiting", status: "waiting", revision: 8 } }),
            getFlow: ({ flowId }) => ({ flowId, status: "waiting", revision: 8 }),
            setWaiting: (input) => ({ applied: true, flow: { flowId: input.flowId, status: "waiting", revision: 9 } }),
            finish: (input) => ({ applied: true, flow: { flowId: input.flowId, status: "completed", revision: 10 } }),
            fail: (input) => ({ applied: true, flow: { flowId: input.flowId, status: "failed", revision: 11 } }),
            cancel: (input) => ({ cancelled: true, flowId: input.flowId, found: true }),
          }),
        },
      },
    };

    const bound = createOpenClawRuntimeTaskFlowPort(api).bindSession({ sessionKey: "session-runtime" });
    const flow = await bound.get("flow-wait");
    const waiting = await bound.setWaiting({ flowId: "flow-wait", expectedRevision: 8 });
    const projection = flow?.state ?? flow?.status ?? null;

    expect(projection).toBe("waiting");
    expect(waiting.status).toBe("ok");
    expect(waiting.flow?.status).toBe("waiting");
  });

  it("requesterOrigin passes through to OpenClaw task delivery", () => {
    const origins: unknown[] = [];
    const api: OpenClawRuntimeTaskFlowApiContainer = {
      runtime: {
        taskFlow: {
          bindSession: (input) => {
            origins.push(input.requesterOrigin);
            return {
              createManaged: () => ({ flowId: "flow-origin" }),
              runTask: () => ({ created: true, flowId: "flow-origin", task: { taskId: "task-origin" } }),
              getFlow: ({ flowId }) => ({ flowId }),
              setWaiting: () => ({ applied: true }),
              finish: () => ({ applied: true }),
              fail: () => ({ applied: true }),
              cancel: () => ({ cancelled: true }),
            };
          },
        },
      },
    };
    const requesterOrigin = { channel: "slack", threadId: "thread-1" };

    createOpenClawRuntimeTaskFlowPort(api).bindSession({ sessionKey: "session-origin", requesterOrigin });

    expect(origins).toEqual([requesterOrigin]);
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
