import { describe, expect, it } from "vitest";
import type { NativeHelperInvoker } from "./native-helper.js";
import { createRuntimeTaskflowAdapter } from "./runtime-taskflow.js";
import { startRuntimeWorkflow, type RuntimeWorkflowState } from "../core/workflow/index.js";
import type { PolicyDecision } from "@octoclaw/policy/judge";
import { OCTOCLAW_CONTRACT_SCHEMA_VERSION, type ScopeMetadata } from "@octoclaw/contracts/schemas";

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
    workspaceMode: "shared_workspace",
    readScope: [{ resource: "repo:/workspace", access: "read" }],
    writeScope: [{ resource: "repo:/workspace/tmp", access: "write" }],
    writeScopeSummary: "tmp output",
  };
}

function buildWorkflow(): RuntimeWorkflowState {
  return startRuntimeWorkflow({
    requestId: "req-1",
    taskId: "task-seed",
    flowId: "flow-seed",
    decision: buildDecision(),
    role: "worker_research",
    claimOwner: "runtime-core",
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
          flow_id: "flow-managed",
          flow: {
            flowId: "flow-managed",
            status: "planned",
            revision: 7,
          },
        };
      case "run-task":
        return {
          ok: true,
          native_task_id: "task-native",
          flow_id: "flow-run",
          task: {
            taskId: "task-native",
            status: "queued",
            syncMode: "managed",
            state: "running",
            revision: 9,
          },
        };
      case "cancel-flow":
        return {
          ok: true,
          status: "cancelled",
          flow_id: input.args.flow_id,
          found: true,
          cancelled: true,
          reason: "requested_by_test",
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
            revision: 11,
            currentStep: "step-2",
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
            revision: 13,
            syncMode: "mirrored",
            state: "waiting",
            progressSummary: "blocked on input",
          },
        };
    }
  }) as NativeHelperInvoker;
  return { calls, invoker: impl };
}

function expectPlaneSeparation(record: {
  truth: { kind: string; schemaVersion: string; taskId: string; flowId: string };
  projection: { kind: string; schemaVersion: string; taskId: string; flowId: string };
  artifact: { kind: string; schemaVersion: string; schemaPlanes: string[] };
  telemetry: { kind: string; schemaVersion: string; syncMode: string };
}) {
  expect(record.truth.kind).toBe("truth");
  expect(record.projection.kind).toBe("projection");
  expect(record.artifact.kind).toBe("artifact");
  expect(record.telemetry.kind).toBe("telemetry");
  expect(record.truth.schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
  expect(record.projection.schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
  expect(record.artifact.schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
  expect(record.telemetry.schemaVersion).toBe(OCTOCLAW_CONTRACT_SCHEMA_VERSION);
  expect(record.truth.taskId).toBe(record.projection.taskId);
  expect(record.truth.flowId).toBe(record.projection.flowId);
  expect(record.artifact.schemaPlanes).toEqual(["truth", "projection", "artifact", "telemetry"]);
}

describe("runtime taskflow adapter", () => {
  it("returns adapter with bindSession", () => {
    const adapter = createRuntimeTaskflowAdapter(buildHelperInvoker().invoker);

    expect(adapter).toHaveProperty("bindSession");
    expect(typeof adapter.bindSession).toBe("function");
  });

  it("bindSession createManaged produces managed record with all planes", () => {
    const helper = buildHelperInvoker();
    const workflow = buildWorkflow();
    const record = createRuntimeTaskflowAdapter(helper.invoker).bindSession("session-1").createManaged(workflow);

    expect(helper.calls).toContainEqual(expect.objectContaining({ action: "create-managed-flow" }));
    expect(record.flowId).toBe("flow-managed");
    expect(record.managed).toBe(true);
    expect(record.runtime).toBe("openclaw-native");
    expect(record.syncMode).toBe("managed");
    expect(record.substrateState).toBe("planned");
    expect(record.substrateRevision).toBe(7);
    expect(record.truth.sessionKey).toBe("session-1");
    expect(record.truth.requestId).toBe("req-1");
    expect(record.truth.scope).toEqual({
      workspaceMode: "shared_workspace",
      readScopeCount: 1,
      writeScopeCount: 1,
      writeScopeSummary: "tmp output",
    });
    expect(record.projection.workspaceMode).toBe("shared_workspace");
    expect(record.telemetry.claimOwner).toBe("runtime-core");
    expectPlaneSeparation(record);
  });

  it("runTask produces task record with all planes", () => {
    const helper = buildHelperInvoker();
    const workflow = buildWorkflow();
    const record = createRuntimeTaskflowAdapter(helper.invoker).bindSession("session-2").runTask(workflow);

    expect(helper.calls).toContainEqual(expect.objectContaining({ action: "run-task" }));
    expect(record.taskId).toBe("task-native");
    expect(record.flowId).toBe("flow-run");
    expect(record.runtime).toBe("openclaw-native");
    expect(record.syncMode).toBe("managed");
    expect(record.substrateState).toBe("running");
    expect(record.substrateRevision).toBe(9);
    expect(record.truth.taskId).toBe("task-native");
    expect(record.truth.flowId).toBe("flow-run");
    expect(record.projection.status).toBe("running");
    expect(record.artifact.taskPacketRef).toBe(workflow.taskMaterialization.taskPacketRef);
    expectPlaneSeparation(record);
  });

  it("runTask uses managedFlowId when createManaged was called first", () => {
    const helper = buildHelperInvoker();
    const workflow = buildWorkflow();
    const binding = createRuntimeTaskflowAdapter(helper.invoker).bindSession("session-chain");
    binding.createManaged(workflow);
    binding.runTask(workflow);

    expect(helper.calls).toHaveLength(2);
    expect(helper.calls[0].action).toBe("create-managed-flow");
    expect(helper.calls[1].action).toBe("run-task");
    expect(helper.calls[1].args.flow_id).toBe("flow-managed");
  });

  it("cancelFlow returns ok found cancelled result", () => {
    const result = createRuntimeTaskflowAdapter(buildHelperInvoker().invoker)
      .bindSession("session-3")
      .cancelFlow("flow-cancel");

    expect(result).toEqual({
      ok: true,
      status: "cancelled",
      flowId: "flow-cancel",
      found: true,
      cancelled: true,
      reason: "requested_by_test",
    });
  });

  it("readFlow returns state and revision", () => {
    const result = createRuntimeTaskflowAdapter(buildHelperInvoker().invoker)
      .bindSession("session-4")
      .readFlow("flow-read");

    expect(result).toEqual({
      ok: true,
      status: "ok",
      flowId: "flow-read",
      found: true,
      substrateState: "running",
      substrateRevision: 11,
      currentStep: "step-2",
    });
  });

  it("readTask returns state revision and syncMode", () => {
    const result = createRuntimeTaskflowAdapter(buildHelperInvoker().invoker)
      .bindSession("session-5")
      .readTask("flow-read", "task-read");

    expect(result).toEqual({
      ok: true,
      status: "ok",
      flowId: "flow-read",
      taskId: "task-read",
      found: true,
      substrateState: "waiting",
      substrateRevision: 13,
      syncMode: "mirrored",
      progressSummary: "blocked on input",
    });
  });
});
