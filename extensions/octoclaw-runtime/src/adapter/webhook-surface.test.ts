import { describe, expect, it } from "vitest";
import { createRuntimeWebhookSurface } from "./webhook-surface.js";
import type { NativeHelperInvoker } from "./native-helper.js";
import { OCTOCLAW_CONTRACT_SCHEMA_VERSION, type ScopeMetadata } from "@octoclaw/contracts/schemas";
import { startRuntimeWorkflow } from "../core/workflow/index.js";
import type { PolicyDecision } from "@octoclaw/policy/judge";

interface HelperRecorder {
  calls: Array<{ action: string; args: Record<string, string> }>;
  invoker: NativeHelperInvoker;
}

function buildDecision(): PolicyDecision {
  return {
    route: "delegate",
    role: "worker_research",
    coordinationMode: "solo_worker",
    backend: "openclaw-native",
    executionProfile: "worker",
    workspaceMode: "shared_workspace",
    modelProfile: "worker_research",
    caps: {
      queueBudget: 2,
      maxWorkers: 1,
      latencyTarget: "background",
      workerPool: "octoclaw-research",
      capReason: "runtime_test",
    },
    admission: {
      admission: "allow",
      queueBudget: 2,
      maxWorkers: 1,
      latencyTarget: "background",
      reason: "admission_allowed",
    },
    decisionStack: ["route", "role", "coordination_mode", "backend", "workspace_mode", "model_profile", "caps"],
  };
}

function buildScope(): ScopeMetadata {
  return {
    workspaceMode: "shared_workspace",
    readScope: [{ resource: "repo", access: "read" }],
    writeScope: [{ resource: "repo/tmp", access: "write" }],
    writeScopeSummary: "tmp output",
  };
}

function buildWorkflow() {
  return startRuntimeWorkflow({
    requestId: "req-webhook",
    taskId: "task-webhook-seed",
    flowId: "flow-webhook-seed",
    decision: buildDecision(),
    role: "worker_research",
    claimOwner: "runtime-webhook",
    leaseDurationMs: 30_000,
    deadlineBudget: {
      queuedAt: "2026-04-18T15:00:00.000Z",
      queueMs: 1_000,
      startMs: 2_000,
      progressMs: 5_000,
      runtimeMs: 10_000,
      deliveryMs: 5_000,
    },
    scope: buildScope(),
  });
}

function buildHelperInvoker(): HelperRecorder {
  const calls: Array<{ action: string; args: Record<string, string> }> = [];
  const impl: NativeHelperInvoker = ((input) => {
    calls.push({ action: input.action, args: input.args });
    switch (input.action) {
      case "cancel-flow":
        return {
          ok: true,
          status: "cancelled",
          flow_id: input.args.flow_id,
          found: true,
          cancelled: true,
          reason: "requested",
        };
      case "create-managed-flow":
        return {
          ok: true,
          flow_id: "flow-managed",
          flow: {
            flowId: "flow-managed",
            status: "planned",
            revision: 1,
          },
        };
      case "run-task":
        return {
          ok: true,
          native_task_id: "task-runtime",
          flow_id: "flow-runtime",
          task: {
            taskId: "task-runtime",
            status: "queued",
            syncMode: "managed",
            state: "running",
            revision: 2,
          },
        };
      case "read-flow":
        return {
          ok: true,
          status: "ok",
          flow_id: input.args.flow_id,
          found: true,
          flow: {
            flowId: input.args.flow_id,
            status: "running",
            revision: 3,
            currentStep: "observe",
          },
        };
      case "read-task":
        return {
          ok: true,
          status: "ok",
          flow_id: input.args.flow_id,
          task_id: input.args.task_id,
          found: true,
          task: {
            taskId: input.args.task_id,
            status: "running",
            revision: 4,
            syncMode: "managed",
            state: "running",
            progressSummary: "in flight",
          },
        };
    }
  }) as NativeHelperInvoker;
  return { calls, invoker: impl };
}

describe("runtime webhook surface", () => {
  it("maps actions to runtime taskFlow operations", () => {
    const workflow = buildWorkflow();
    const helper = buildHelperInvoker();
    const surface = createRuntimeWebhookSurface({ helperInvoker: helper.invoker });

    const managed = surface.createManaged({ sessionKey: "session-a", workflow });
    const task = surface.runTask({ sessionKey: "session-a", workflow });
    const cancelled = surface.cancelFlow({ sessionKey: "session-a", flowId: "flow-runtime" });
    const flowState = surface.readFlowState({ sessionKey: "session-a", flowId: "flow-runtime" });
    const taskState = surface.readTaskState({ sessionKey: "session-a", flowId: "flow-runtime", taskId: "task-runtime" });

    expect(helper.calls[0]).toEqual(expect.objectContaining({
      action: "create-managed-flow",
      args: expect.objectContaining({ session_key: "session-a" }),
    }));
    expect(helper.calls[1]).toEqual(expect.objectContaining({
      action: "run-task",
      args: expect.objectContaining({ session_key: "session-a" }),
    }));
    expect(helper.calls[2]).toEqual({
      action: "cancel-flow",
      args: { session_key: "session-a", flow_id: "flow-runtime" },
    });
    expect(helper.calls[3]).toEqual({
      action: "read-flow",
      args: { session_key: "session-a", flow_id: "flow-runtime" },
    });
    expect(helper.calls[4]).toEqual({
      action: "read-task",
      args: { session_key: "session-a", flow_id: "flow-runtime", task_id: "task-runtime" },
    });
    expect(managed.flowId).toBe("flow-managed");
    expect(task.taskId).toBe("task-runtime");
    expect(cancelled.cancelled).toBe(true);
    expect(flowState.summary).toBe("flow flow-runtime is running");
    expect(taskState.summary).toBe("task task-runtime on flow-runtime is running");
  });

  it("delivery envelopes carry the correct schema version", () => {
    const workflow = buildWorkflow();
    const surface = createRuntimeWebhookSurface({ helperInvoker: buildHelperInvoker().invoker });
    const managed = surface.createManaged({ sessionKey: "session-managed", workflow });
    const task = surface.runTask({ sessionKey: "session-task", workflow });

    expect(managed.truth.schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
    expect(managed.projection.schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
    expect(task.truth.schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
    expect(task.projection.schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
    expect(surface.readStatusView(task).schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
  });
});
