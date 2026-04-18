import { afterEach, describe, expect, it, vi } from "vitest";
import { judgeFast } from "../../packages/octoclaw-policy/src/judge/index.js";
import { normalizeRuntimeRequest } from "../../packages/octoclaw-runtime-core/src/requests/index.js";
import { applyRecoveryHook, assessRecoveryNeed } from "../../packages/octoclaw-runtime-core/src/recovery/index.js";
import { renewWorkflowHeartbeat, startRuntimeWorkflow } from "../../packages/octoclaw-runtime-core/src/workflow/index.js";
import { materializeDelegatedWork } from "../../extensions/octoclaw-delegation/src/materialize/index.js";

function buildWorkflowAt(queuedAt: string) {
  const request = normalizeRuntimeRequest({
    prompt: "Investigate a flaky delegated task",
    sessionKey: "session-recovery",
    channel: "slack",
    requestId: "req-recovery",
    taskId: "task-recovery",
    flowId: "flow-recovery",
    idempotencyKey: "idem-recovery",
    workspaceMode: "isolated_workspace",
    readScope: [{ resource: "repo:src", access: "read" }],
  });

  const judged = judgeFast({
    requiresDelegation: true,
    workspaceMode: request.scope.workspaceMode,
    queueBudget: 2,
    inflightCount: 0,
    capabilitySatisfied: true,
    writeConflict: false,
    intent: { delegatedWork: true },
  });

  const workflow = startRuntimeWorkflow({
    requestId: request.requestId,
    taskId: request.taskId,
    flowId: request.flowId,
    decision: judged.decision,
    role: judged.decision.role,
    claimOwner: "worker-recovery",
    leaseDurationMs: 30_000,
    deadlineBudget: {
      queuedAt,
      queueMs: 10_000,
      startMs: 20_000,
      progressMs: 30_000,
      runtimeMs: 40_000,
      deliveryMs: 50_000,
    },
    scope: request.scope,
  });

  return { request, judged, workflow };
}

describe("WS recovery integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks workflow timed_out when queue deadline is exceeded", () => {
    const { workflow } = buildWorkflowAt("2026-04-18T15:00:00.000Z");
    const now = new Date("2026-04-18T15:00:11.000Z");

    const assessment = assessRecoveryNeed(workflow, now);
    const recovered = applyRecoveryHook(workflow, now);

    expect(assessment).toMatchObject({
      required: true,
      trigger: "queue_deadline_exceeded",
      timedOut: true,
      deadlineField: "queueDeadline",
    });
    expect(recovered.workflowOrchestration).toBe("failed");
    expect(recovered.lifecycle.phase).toBe("failed");
    expect(recovered.lifecycle.failedAt).toBe("2026-04-18T15:00:11.000Z");
  });

  it("marks workflow for recovery when the lease expires", () => {
    const { workflow } = buildWorkflowAt("2026-04-18T16:00:00.000Z");
    const expiredLeaseWorkflow = {
      ...workflow,
      claim: workflow.claim
        ? {
          ...workflow.claim,
          leaseExpiresAt: "2026-04-18T16:00:01.000Z",
        }
        : null,
    };
    const now = new Date("2026-04-18T16:00:05.000Z");

    const assessment = assessRecoveryNeed(expiredLeaseWorkflow, now);
    const recovered = applyRecoveryHook(expiredLeaseWorkflow, now);

    expect(assessment).toMatchObject({
      required: true,
      trigger: "lease_expired",
      timedOut: false,
      deadlineField: null,
    });
    expect(recovered.reconcileOrRecovery).toBe("recovering");
    expect(recovered.lifecycle.phase).toBe("recovering");
  });

  it("reports healthy workflows after heartbeat renewal", () => {
    const { workflow } = buildWorkflowAt("2026-04-18T17:00:00.000Z");
    const renewed = renewWorkflowHeartbeat(workflow, "2026-04-18T17:00:05.000Z");
    const assessment = assessRecoveryNeed(renewed, new Date("2026-04-18T17:00:06.000Z"));

    expect(renewed.claim?.lastHeartbeatAt).toBe("2026-04-18T17:00:05.000Z");
    expect(assessment).toEqual({
      required: false,
      trigger: null,
      timedOut: false,
      deadlineField: null,
      reason: "workflow_healthy",
    });
  });

  it("materialization stays idempotent for the same request idempotency key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T18:00:00.000Z"));

    const request = normalizeRuntimeRequest({
      prompt: "Materialize delegated work exactly once",
      requestId: "req-idem",
      taskId: "task-idem",
      flowId: "flow-idem",
      idempotencyKey: "idem-fixed",
      workspaceMode: "shared_workspace",
      readScope: [{ resource: "repo:docs", access: "read" }],
      writeScope: [{ resource: "repo:src", access: "write" }],
      writeScopeSummary: "repo:src",
    });
    const judged = judgeFast({
      requiresDelegation: true,
      workType: "code",
      workspaceMode: request.scope.workspaceMode,
      queueBudget: 2,
      inflightCount: 0,
      capabilitySatisfied: true,
      writeConflict: false,
      intent: { delegatedWork: true },
    });

    const input = {
      requestId: request.requestId,
      taskId: request.taskId,
      flowId: request.flowId,
      role: judged.decision.role,
      objective: request.prompt,
      requestIdempotencyKey: request.idempotencyKey,
      deliveryId: "delivery-idem",
      deliveryReceiptId: "receipt-idem",
      claimOwner: "worker-idem",
      leaseDurationMs: 60_000,
      queueBudget: judged.decision.admission.queueBudget,
      inflightCount: 0,
      capabilitySatisfied: true,
      writeConflict: false,
      readScope: request.scope.readScope,
      writeScope: request.scope.writeScope,
      workspaceMode: request.scope.workspaceMode,
    } as const;

    const first = materializeDelegatedWork(input);
    vi.setSystemTime(new Date("2026-04-18T18:00:00.000Z"));
    const second = materializeDelegatedWork(input);

    expect(first.taskId).toBe("task-idem");
    expect(second.taskId).toBe(first.taskId);
    expect(second.requestIdempotencyKey).toBe("idem-fixed");
    expect(second).toEqual(first);
  });
});
