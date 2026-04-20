import { describe, expect, it } from "vitest";
import { createOctoClawRuntimePlugin } from "./plugin.js";
import { judgePolicy, type PolicyJudgeInput, type PolicyDecision } from "@octoclaw/policy/judge";
import { startRuntimeWorkflow } from "@octoclaw/runtime-core/workflow";
import type { ScopeMetadata } from "@octoclaw/contracts/schemas";
import type { NativeHelperInvoker } from "./adapter/native-helper.js";

interface HelperRecorder {
  calls: Array<{ action: string; args: Record<string, string> }>;
  invoker: NativeHelperInvoker;
}

function buildDecision(): PolicyDecision {
  return {
    route: "delegate.single",
    role: "worker_research",
    coordinationMode: "solo_worker",
    backend: "openclaw-native",
    executionProfile: "worker",
    workspaceMode: "isolated_worktree",
    modelProfile: "worker_research",
    caps: {
      queueBudget: 4,
      maxWorkers: 2,
      latencyTarget: "background",
      workerPool: "octoclaw-research",
      capReason: "runtime_test",
    },
    admission: {
      admission: "allow",
      queueBudget: 4,
      maxWorkers: 2,
      latencyTarget: "background",
      reason: "admission_allowed",
    },
    decisionStack: ["route", "role", "coordination_mode", "backend", "workspace_mode", "model_profile", "caps"],
  };
}

function buildScope(): ScopeMetadata {
  return {
    workspaceMode: "isolated_worktree",
    readScope: [{ resource: "repo", access: "read" }],
    writeScope: [],
    writeScopeSummary: "",
  };
}

function buildWorkflow() {
  return startRuntimeWorkflow({
    requestId: "req-plugin",
    taskId: "task-plugin",
    flowId: "flow-plugin",
    decision: buildDecision(),
    role: "worker_research",
    claimOwner: "runtime-plugin",
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
      case "create-managed-flow":
        return {
          ok: true,
          flow_id: "flow-plugin-managed",
          flow: {
            flowId: "flow-plugin-managed",
            status: "planned",
            revision: 2,
          },
        };
      case "run-task":
        return {
          ok: true,
          native_task_id: "task-plugin-native",
          flow_id: "flow-plugin-run",
          task: {
            taskId: "task-plugin-native",
            status: "queued",
            syncMode: "managed",
            state: "running",
            revision: 3,
          },
        };
      case "cancel-flow":
        return {
          ok: true,
          status: "cancelled",
          flow_id: input.args.flow_id,
          found: true,
          cancelled: true,
          reason: "ok",
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
            revision: 4,
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
            revision: 5,
            syncMode: "managed",
          },
        };
    }
  }) as NativeHelperInvoker;
  return { calls, invoker: impl };
}

describe("octoclaw runtime plugin", () => {
  it("returns plugin with expected interface", () => {
    const plugin = createOctoClawRuntimePlugin({ helperInvoker: buildHelperInvoker().invoker });

    expect(plugin.name).toBe("octoclaw-runtime-ts");
    expect(typeof plugin.createAdapter).toBe("function");
    expect(typeof plugin.createWebhookSurface).toBe("function");
    expect(typeof plugin.bindWorkflow).toBe("function");
    expect(typeof plugin.judgeRoute).toBe("function");
  });

  it("judgeRoute delegates to judgePolicy", () => {
    const plugin = createOctoClawRuntimePlugin({ helperInvoker: buildHelperInvoker().invoker });
    const input: PolicyJudgeInput = {
      requestedRoute: "delegate.single",
      workType: "research",
      workspaceMode: "isolated_worktree",
      queueBudget: 3,
      inflightCount: 0,
      capabilitySatisfied: true,
      writeConflict: false,
    };

    expect(plugin.judgeRoute(input)).toEqual(judgePolicy(input));
  });

  it("bindWorkflow creates managed flow then runs task", () => {
    const helper = buildHelperInvoker();
    const plugin = createOctoClawRuntimePlugin({ helperInvoker: helper.invoker });
    const binding = plugin.bindWorkflow(buildWorkflow());

    expect(binding).toMatchObject({
      taskId: "task-plugin-native",
      flowId: "flow-plugin-run",
      status: "running",
      runtime: "openclaw-native",
      syncMode: "managed",
      substrateState: "running",
      substrateRevision: 3,
    });
    expect(binding.truth.taskId).toBe("task-plugin-native");
    expect(binding.projection.taskId).toBe("task-plugin-native");

    expect(helper.calls.length).toBe(2);
    expect(helper.calls[0].action).toBe("create-managed-flow");
    expect(helper.calls[1].action).toBe("run-task");
  });

  it("createAdapter returns valid adapter", () => {
    const plugin = createOctoClawRuntimePlugin({ helperInvoker: buildHelperInvoker().invoker });
    const adapter = plugin.createAdapter();

    expect(adapter).toHaveProperty("bindSession");
    expect(typeof adapter.bindSession).toBe("function");
  });

  it("createWebhookSurface returns valid surface", () => {
    const plugin = createOctoClawRuntimePlugin({ helperInvoker: buildHelperInvoker().invoker });
    const surface = plugin.createWebhookSurface();

    expect(surface).toHaveProperty("createManaged");
    expect(surface).toHaveProperty("runTask");
    expect(surface).toHaveProperty("cancelFlow");
    expect(surface).toHaveProperty("readFlowState");
    expect(surface).toHaveProperty("readTaskState");
  });
});
