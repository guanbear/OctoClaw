import { describe, expect, it, vi, afterEach } from "vitest";
import type { ScopeMetadata } from "../../packages/octoclaw-contracts/src/schemas.js";
import { checkHardBoundary } from "../../packages/octoclaw-policy/src/gate/index.js";
import { judgeFast } from "../../packages/octoclaw-policy/src/judge/index.js";
import { normalizeRuntimeRequest } from "../../packages/octoclaw-runtime-core/src/requests/index.js";
import {
  advanceWorkflowToRunning,
  buildWorkflowFinalDelivery,
  emitWorkflowTelemetry,
  enqueueWorkflowDelivery,
  markWorkflowCheckpointEmitted,
  markWorkflowCompleted,
  markWorkflowDeliverableReady,
  startRuntimeWorkflow,
} from "../../packages/octoclaw-runtime-core/src/workflow/index.js";
import { createRuntimeTaskflowAdapter } from "../../extensions/octoclaw-runtime/src/adapter/runtime-taskflow.js";
import type { NativeHelperInvoker } from "../../extensions/octoclaw-runtime/src/adapter/native-helper.js";
import { materializeDelegatedWork } from "../../extensions/octoclaw-delegation/src/materialize/index.js";
import { buildDirectReply, buildDirectReplyContext } from "../../extensions/octoclaw-fast-reply/src/direct/index.js";
import { buildFastReplyAck } from "../../extensions/octoclaw-fast-reply/src/ack/index.js";
import { buildStatusSurface } from "../../extensions/octoclaw-status-surface/src/view-model/index.js";
import { runStatusSurfaceOperator } from "../../extensions/octoclaw-status-surface/src/operator/index.js";

function buildDeadlineBudget(queuedAt: string) {
  return {
    queuedAt,
    queueMs: 10_000,
    startMs: 20_000,
    progressMs: 30_000,
    runtimeMs: 40_000,
    deliveryMs: 50_000,
  };
}

function createRecordFromWorkflow(
  sessionKey: string,
  workflow: ReturnType<typeof startRuntimeWorkflow>,
  substrateState: ReturnType<typeof startRuntimeWorkflow>["workflowOrchestration"] = workflow.workflowOrchestration,
) {
  const helperInvoker: NativeHelperInvoker = (({ action }) => {
    if (action === "create-managed-flow") {
      return {
        ok: true,
        flow_id: workflow.identity.flowId,
        flow: {
          flowId: workflow.identity.flowId,
          status: substrateState,
          revision: 13,
        },
      };
    }

    throw new Error(`unsupported_action:${action}`);
  }) as NativeHelperInvoker;
  const adapter = createRuntimeTaskflowAdapter(helperInvoker);

  return adapter.bindSession(sessionKey).createManaged({
    ...workflow,
    workflowOrchestration: substrateState,
  });
}

function expectStatusSurfaceMinimumFields(view: ReturnType<typeof buildStatusSurface>) {
  expect(view).toMatchObject({
    taskId: expect.any(String),
    flowId: expect.any(String),
    state: expect.any(String),
    route: expect.any(String),
    workerPool: expect.any(String),
    substrateSummary: expect.any(String),
    actionAvailability: expect.any(Array),
    claimOwner: expect.any(String),
    workspaceMode: expect.any(String),
  });
  expect(Object.prototype.hasOwnProperty.call(view, "queuePosition")).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(view, "modelSummary")).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(view, "costEstimate")).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(view, "leaseState")).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(view, "writeScopeSummary")).toBe(true);
}

describe("WS0-WS6 happy path integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes the full reply path end-to-end with ACK and direct reply metrics", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T12:00:00.000Z"));

    const request = normalizeRuntimeRequest({
      prompt: "What is OctoClaw?",
      sessionKey: "session-reply",
      channel: "direct",
      requestId: "req-reply",
      taskId: "task-reply",
      flowId: "flow-reply",
      workspaceMode: "isolated_workspace",
      metadata: { intent: "simple" },
    });

    const judged = judgeFast({
      workspaceMode: request.scope.workspaceMode,
      queueBudget: 1,
      inflightCount: 0,
      capabilitySatisfied: true,
      writeConflict: false,
      intent: { intentClass: "plain_chat" },
    });

    expect(judged.decision.route).toBe("reply");
    expect(judged.decision.role).toBe("main_reply");
    expect(judged.decision.backend).toBe("main");

    const ack = buildFastReplyAck(
      "pre_dispatch",
      { required: true, text: "On it" },
      { routeDecisionStartedAt: 100, ackSentAt: 140, replyCompletedAt: 220 },
    );
    const directReply = buildDirectReply(
      buildDirectReplyContext({
        userText: request.prompt,
        route: judged.decision.route,
        requestKind: judged.intent.intentClass,
      }),
      "OctoClaw is a runtime-first orchestration layer.",
      { routeDecisionStartedAt: 100, ackSentAt: 140, replyCompletedAt: 220 },
    );

    expect(ack.required).toBe(true);
    expect(ack.metrics).toEqual({ ack_ms: 40, total_latency_ms: 120 });
    expect(directReply.replyText).toContain("runtime-first orchestration layer");
    expect(directReply.handoff.kind).toBe("reply");
    expect(directReply.metrics).toEqual({ ack_ms: 40, total_latency_ms: 120 });
  });

  it("executes the full delegate.single path across requests, policy, workflow, delivery, telemetry, and WS6 status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T13:00:00.000Z"));

    const request = normalizeRuntimeRequest({
      prompt: "Refactor the runtime adapter and add integration coverage",
      sessionKey: "session-delegate",
      channel: "slack",
      requestId: "req-delegate",
      taskId: "task-delegate",
      flowId: "flow-delegate",
      idempotencyKey: "idem-delegate",
      workspaceMode: "shared_workspace",
      readScope: [{ resource: "repo:docs", access: "read" }],
      writeScope: [{ resource: "repo:src", access: "write" }],
      writeScopeSummary: "repo:src",
    });

    const judged = judgeFast({
      workspaceMode: request.scope.workspaceMode,
      queueBudget: 4,
      inflightCount: 0,
      capabilitySatisfied: true,
      writeConflict: false,
      requiresDelegation: true,
      workType: "code",
      intent: { delegatedWork: true },
    });

    expect(judged.intent.intentClass).toBe("delegated_work");
    expect(judged.decision.route).toBe("delegate.single");
    expect(judged.decision.role).toBe("worker_code");
    expect(judged.decision.backend).toBe("worker");
    expect(judged.decision.modelProfile).toBe("worker_code_deep");

    const ack = buildFastReplyAck(
      "pre_dispatch",
      { required: true, text: "Delegating now" },
      { routeDecisionStartedAt: 1_000, ackSentAt: 1_050 },
    );
    expect(ack.required).toBe(true);
    expect(ack.metrics.ack_ms).toBe(50);

    vi.setSystemTime(new Date("2026-04-18T13:00:01.000Z"));
    const materialized = materializeDelegatedWork({
      requestId: request.requestId,
      taskId: request.taskId,
      flowId: request.flowId,
      role: judged.decision.role,
      objective: request.prompt,
      requestIdempotencyKey: request.idempotencyKey,
      deliveryId: "delivery:flow-delegate:task-delegate:final",
      deliveryReceiptId: "receipt:flow-delegate:task-delegate:final",
      claimOwner: "worker-1",
      leaseDurationMs: 60_000,
      queueBudget: judged.decision.admission.queueBudget,
      inflightCount: 0,
      capabilitySatisfied: true,
      writeConflict: false,
      readScope: request.scope.readScope,
      writeScope: request.scope.writeScope,
      workspaceMode: request.scope.workspaceMode,
    });

    expect(ack.metrics.ack_ms).toBeLessThan(60_000);
    expect(materialized).toMatchObject({
      taskId: "task-delegate",
      flowId: "flow-delegate",
      claimOwner: "worker-1",
      workspaceMode: "shared_workspace",
      backend: "openclaw-native",
      writeScopeSummary: "repo:src",
      modelProfile: "code",
      admission: { admission: "allow" },
    });
    expect(materialized.claimToken).toContain("task-delegate:worker-1:");
    expect(materialized.allowedTools).toEqual(["read", "edit", "write", "bash", "lsp"]);

    const workflow = startRuntimeWorkflow({
      requestId: request.requestId,
      taskId: request.taskId,
      flowId: request.flowId,
      decision: judged.decision,
      role: judged.decision.role,
      claimOwner: materialized.claimOwner,
      leaseDurationMs: 60_000,
      deadlineBudget: buildDeadlineBudget("2026-04-18T13:00:00.000Z"),
      scope: request.scope,
    });
    expect(workflow.lifecycle.phase).toBe("materialization_pending");

    const running = advanceWorkflowToRunning(workflow, materialized.claimOwner);
    expect(running.workflowOrchestration).toBe("running");
    expect(running.claim?.claimOwner).toBe("worker-1");

    const checkpointed = markWorkflowCheckpointEmitted(running, "2026-04-18T13:00:10.000Z");
    expect(checkpointed.checkpoints.checkpointState).toBe("emitted");

    const ready = markWorkflowDeliverableReady(checkpointed);
    expect(ready.checkpoints.deliverableReady).toBe(true);
    expect(ready.lifecycle.deliveryState).toBe("queued");

    const delivery = buildWorkflowFinalDelivery(ready, {
      channel: request.channel,
      summary: "Refactor completed",
      detail: "Added full pipeline integration coverage",
      artifactRefs: ["tests/integration/happy-path.test.ts"],
    });
    expect(delivery.envelope.channel).toBe("slack");
    expect(delivery.payload.kind).toBe("final");
    expect(delivery.payload.deliverableReady).toBe(true);

    const enqueued = enqueueWorkflowDelivery(ready, delivery);
    expect(Object.keys(enqueued.outbox.entries)).toHaveLength(1);
    expect(Object.values(enqueued.outbox.entries)[0]).toMatchObject({ deliveryId: delivery.envelope.deliveryId });

    const completed = markWorkflowCompleted(enqueued, "2026-04-18T13:00:20.000Z");
    expect(completed.workflowOrchestration).toBe("completed");
    expect(completed.lifecycle.phase).toBe("completed");

    const telemetry = emitWorkflowTelemetry(request, completed);
    expect(telemetry.request.selectedRoute).toBe("delegate.single");
    expect(telemetry.request.selectedRole).toBe("worker_code");
    expect(telemetry.task.taskId).toBe("task-delegate");
    expect(telemetry.flow.flowId).toBe("flow-delegate");

    const record = createRecordFromWorkflow(request.sessionKey, completed);
    const view = buildStatusSurface(record);
    expectStatusSurfaceMinimumFields(view);
    expect(view.taskId).toBe("task-delegate");
    expect(view.flowId).toBe("flow-delegate");
    expect(view.state).toBe("completed");
    expect(view.route).toBe("delegate.single");
    expect(view.writeScopeSummary).toBe("repo:src");
    expect(view.actionAvailability).toEqual(["status", "details", "queue", "timeline"]);

    const statusText = runStatusSurfaceOperator("status", record, "text");
    expect(statusText).toContain("Status: task-delegate");
    expect(statusText).toContain("state=completed");
  });

  it("executes the observe path from hard-boundary gate with read-only scope and no new task materialization", () => {
    const hardBoundary = checkHardBoundary({ existingTaskBinding: "task-existing" });
    expect(hardBoundary).toMatchObject({
      triggered: true,
      signal: "existing_task_binding",
      routeOverride: "observe",
    });

    const request = normalizeRuntimeRequest({
      prompt: "Show me the status of task-existing",
      sessionKey: "session-observe",
      channel: "slack",
      requestId: "req-observe",
      taskId: "task-existing",
      flowId: "flow-existing",
      workspaceMode: "read_only_workspace",
      readScope: [{ resource: "repo:status", access: "read" }],
      writeScope: [],
      writeScopeSummary: "",
    });

    const judged = judgeFast({
      requestedRoute: hardBoundary.routeOverride,
      requiresObservation: true,
      workspaceMode: request.scope.workspaceMode,
      queueBudget: 1,
      inflightCount: 0,
      capabilitySatisfied: true,
      writeConflict: false,
      intent: { surfaceBound: true, executionFollowup: true },
    });

    expect(judged.decision.route).toBe("observe");
    expect(judged.decision.role).toBe("observer_probe");
    expect(judged.decision.backend).toBe("observer");

    const observeScope: ScopeMetadata = {
      workspaceMode: "read_only_workspace",
      readScope: request.scope.readScope,
      writeScope: [],
      writeScopeSummary: "",
    };
    const workflow = startRuntimeWorkflow({
      requestId: request.requestId,
      taskId: request.taskId,
      flowId: request.flowId,
      decision: judged.decision,
      role: judged.decision.role,
      claimOwner: "observer-1",
      leaseDurationMs: 30_000,
      deadlineBudget: buildDeadlineBudget("2026-04-18T14:00:00.000Z"),
      scope: observeScope,
    });

    expect(workflow.identity.route).toBe("observe");
    expect(workflow.identity.materializationIntent).toBe("observe_probe");
    expect(workflow.scope.workspaceMode).toBe("read_only_workspace");
    expect(workflow.scope.writeScope).toEqual([]);

    const record = createRecordFromWorkflow(request.sessionKey, workflow);
    const detailsText = runStatusSurfaceOperator("details", record, "text");
    const statusView = buildStatusSurface(record);

    expect(statusView.route).toBe("delegate.single");
    expect(statusView.workspaceMode).toBe("read_only_workspace");
    expect(detailsText).toContain("Details: task-existing");
    expect(statusView.writeScopeSummary).toBe("");
  });
});
