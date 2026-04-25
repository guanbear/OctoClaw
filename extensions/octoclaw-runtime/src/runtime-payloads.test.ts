import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import { buildTsRuntimeDispatchPayload } from "./runtime-payloads.js";
import type { NativeHelperInvoker } from "./adapter/native-helper.js";

function buildDecision(): PolicyDecision {
  return {
    route: "delegate",
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

function buildHelperInvoker(): NativeHelperInvoker {
  return ((input) => {
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
      default:
        throw new Error(`unsupported_action:${input.action}`);
    }
  }) as NativeHelperInvoker;
}

describe("buildTsRuntimeDispatchPayload", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("binds delegate task and attempt ids to native materialization", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T11:00:00.000Z"));

    const decisionRecord = {
      route_decision: {
        route: "delegate",
        worker_pool: "octoclaw-research",
      },
      model_policy: {
        selected_model: "worker_research",
      },
    };
    const payload = buildTsRuntimeDispatchPayload(
      {
        task: "Investigate delegate runtime binding",
        decision: decisionRecord,
        metadata: {
          session_key: "session-77",
          channel: "direct",
          workspaceMode: "isolated_worktree",
        },
        helperInvoker: buildHelperInvoker(),
      },
      {
        runtimeRouteDecision: (decision) => (decision?.route_decision as Record<string, unknown>) || {},
        normalizeLiveRoute: (route, fallback = "reply") => typeof route === "string" ? route : fallback,
        runtimeExecutionIds: () => ({
          requestId: "req-runtime-1",
          taskId: "task-runtime-1",
          flowId: "flow-runtime-1",
        }),
        buildWorkflowDecision: () => buildDecision(),
        buildWorkflowScope: () => ({
          workspaceMode: "isolated_worktree",
          readScope: [{ resource: "repo", access: "read" }],
          writeScope: [],
          writeScopeSummary: "",
        }),
        truncateText: (value, maxLength = 80) => String(value).slice(0, maxLength),
      },
    );

    if (payload.route !== "delegate") {
      throw new Error(`unexpected_route:${payload.route}`);
    }
    if (!("delegateTaskId" in payload) || !("attemptId" in payload)) {
      throw new Error("missing_delegate_binding");
    }

    expect(payload.route).toBe("delegate");
    expect(payload.materialization).toMatchObject({
      task_id: "task-plugin-native",
      flow_id: "flow-plugin-run",
      delegateTaskId: "delegate-task:session-77:1776769200000",
      attemptId: "delegate-task:session-77:1776769200000:attempt:1",
      attemptGeneration: 1,
      delegation: {
        handoff: {
          schemaVersion: "octoclaw.delegate_handoff.v1",
          delegateTaskId: "delegate-task:session-77:1776769200000",
          attemptId: "delegate-task:session-77:1776769200000:attempt:1",
          threadBindingKey: "session-77:delegate-task:session-77:1776769200000",
          currentUserAsk: "Investigate delegate runtime binding",
          contextBudget: {
            maxInputTokens: 1800,
            maxSummaryTokens: 500,
            allowRawTranscript: false,
          },
        },
      },
    });
    expect(payload.materialization.delegation?.handoff.contextBudget.allowRawTranscript).toBe(false);
    expect(payload.materialization.delegation?.handoff.contextBudget.maxInputTokens).toBeLessThanOrEqual(1800);
    expect(JSON.stringify(payload.materialization.delegation?.handoff)).not.toContain("[Thread history]");
    expect(JSON.stringify(payload.materialization.delegation?.handoff)).not.toContain("full transcript");
    expect(payload.delegateTaskId).toBe("delegate-task:session-77:1776769200000");
    expect(payload.attemptId).toBe("delegate-task:session-77:1776769200000:attempt:1");
    expect(payload.runtime_truth).toMatchObject({
      workflow: {
        lifecycle: {
          phase: "materialization_pending",
        },
      },
      delegateTask: {
        delegateTaskId: "delegate-task:session-77:1776769200000",
      },
      delegateAttempt: {
        attemptId: "delegate-task:session-77:1776769200000:attempt:1",
        nativeBinding: {
          nativeFlowId: "flow-plugin-run",
          nativeTaskId: "task-plugin-native",
        },
      },
      nativeTaskBinding: {
        nativeFlowId: "flow-plugin-run",
        nativeTaskId: "task-plugin-native",
      },
    });
    expect(payload.deliveries).toMatchObject({
      progress: undefined,
    });
    expect(payload.deliveries?.final).toBeUndefined();
  });

  it("prefers sealed requested_route over stale decision route", () => {
    const payload = buildTsRuntimeDispatchPayload(
      {
        task: "查下 openclaw 4.22 的新特性",
        decision: {
          route_decision: {
            route: "reply",
            worker_pool: "octoclaw-worker",
          },
          model_policy: {
            selected_model: "direct_main",
          },
        },
        metadata: {
          requested_route: "delegate",
          session_key: "session-88",
          channel: "slack",
          workspaceMode: "isolated_worktree",
        },
        helperInvoker: buildHelperInvoker(),
      },
      {
        runtimeRouteDecision: (decision) => (decision?.route_decision as Record<string, unknown>) || {},
        normalizeLiveRoute: (route, fallback = "reply") => typeof route === "string" ? route : fallback,
        runtimeExecutionIds: () => ({
          requestId: "req-runtime-2",
          taskId: "task-runtime-2",
          flowId: "flow-runtime-2",
        }),
        buildWorkflowDecision: () => buildDecision(),
        buildWorkflowScope: () => ({
          workspaceMode: "isolated_worktree",
          readScope: [{ resource: "repo", access: "read" }],
          writeScope: [],
          writeScopeSummary: "",
        }),
        truncateText: (value, maxLength = 80) => String(value).slice(0, maxLength),
      },
    );

    expect(payload.route).toBe("delegate");
    expect(payload.policy_decision).toMatchObject({
      route_decision: {
        route: "delegate",
        dispatch_required: true,
      },
    });
    expect(payload.materialization).toMatchObject({
      type: "delegate",
      task_id: "task-plugin-native",
    });
  });
});
