import { describe, expect, it } from "vitest";
import type { DelegateProgressEvent } from "@octoclaw/contracts/delegate";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { buildTaskStatusProjection } from "@octoclaw/contracts/status-projection";
import { buildStatusProjection } from "../read-model/index.js";
import {
  buildDetailsSurface,
  buildQueueSurface,
  buildStatusSurface,
  buildTimelinePlaceholder,
} from "./index.js";

function createRecord(): RuntimeStateSurfaceRecord {
  return {
    taskId: "task-123",
    flowId: "flow-456",
    runtime: "openclaw-native",
    syncMode: "managed",
    substrateState: "running",
    substrateRevision: 7,
    ownership: {
      claimOwner: "worker-alpha",
      claimToken: "claim-token",
      controllerId: "controller-1",
    },
    scope: {
      readScope: [{ resource: "repo:src", access: "read" }],
      writeScope: [{ resource: "repo:src", access: "write" }],
      workspaceMode: "isolated_worktree",
      writeScopeSummary: "repo:src",
    },
    truth: {
      schemaVersion: "octoclaw.truth/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "truth",
      sessionKey: "session-1",
      requestId: "req-789",
      flowId: "flow-456",
      taskId: "task-123",
      runtime: "openclaw-native",
      syncMode: "managed",
      substrateState: "running",
      substrateRevision: 7,
      managedDisposition: "managed",
      ownership: {
        claimOwner: "worker-alpha",
        claimToken: "claim-token",
        controllerId: "controller-1",
      },
      scope: {
        workspaceMode: "isolated_worktree",
        readScopeCount: 1,
        writeScopeCount: 1,
        writeScopeSummary: "repo:src",
      },
    },
    projection: {
      schemaVersion: "octoclaw.projection/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "projection",
      status: "projection-stale",
      runtime: "openclaw-native",
      flowId: "flow-456",
      taskId: "task-123",
      substrateState: "running",
      substrateRevision: 7,
      workspaceMode: "isolated_worktree",
    },
    artifact: {
      schemaVersion: "octoclaw.artifact/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "artifact",
      taskPacketRef: "packet-ref",
      schemaPlanes: ["truth", "projection"],
    },
    telemetry: {
      schemaVersion: "octoclaw.telemetry/v1",
      createdAt: "2026-04-18T00:00:00.000Z",
      kind: "telemetry",
      substrateRevision: 7,
      syncMode: "managed",
      claimOwner: "worker-alpha",
    },
  };
}

function createProgressEvents(): DelegateProgressEvent[] {
  return [
    {
      schemaVersion: "octoclaw.contracts/v1",
      createdAt: "2026-04-18T00:02:00.000Z",
      kind: "artifact",
      eventId: "evt-1",
      delegateTaskId: "delegate-task-1",
      attemptId: "attempt-1",
      eventType: "checkpoint",
      eventAt: "2026-04-18T00:02:00.000Z",
      summary: "Fetched repository state",
    },
    {
      schemaVersion: "octoclaw.contracts/v1",
      createdAt: "2026-04-18T00:03:00.000Z",
      kind: "artifact",
      eventId: "evt-2",
      delegateTaskId: "delegate-task-1",
      attemptId: "attempt-1",
      eventType: "deliverable_ready",
      eventAt: "2026-04-18T00:03:00.000Z",
      summary: "Prepared operator summary",
    },
  ];
}

function createTaskStatusProjection() {
  const contract: WorkContract = {
    schemaVersion: "octoclaw.work_contract.v1",
    workContractId: "wc-1",
    turnId: "req-789",
    sessionKey: "session-1",
    userAsk: "status task",
    intentClass: "delegated_work",
    route: "delegate",
    status: "running",
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
      execution: { coverage: "thread" },
      memory: { coverage: "partial" },
      conflict: false,
      authority: "execution_wins",
    },
    decision: { source: "local_judge", route: "delegate", reasonCodes: ["test"], sealedAt: "2026-04-18T00:00:00.000Z" },
    delegate: {
      delegateTaskId: "delegate-1",
      currentAttemptId: "attempt-1",
      role: "code",
      coordinationMode: "solo_worker",
      acceptanceCriteria: [],
      scope: { read: [], write: [], workspaceMode: "write_allowed", scopeFingerprint: "scope" },
      modelProfile: "worker_code_normal",
      nativeBinding: {
        flowId: "flow-456",
        ownerKey: "wc-1",
        controllerId: "openclaw-native",
        revision: 7,
        expectedRevision: 7,
        nativeTaskId: "task-123",
        runId: "run-1",
        childRunId: "child-run-1",
        childSessionKey: "child-key-1",
        syncMode: "managed",
        status: "running",
      },
      childSessions: [],
      artifactRefs: [{ artifactId: "artifact-1", artifactKind: "worker_report", createdAt: "2026-04-18T00:03:00.000Z" }],
      nextAction: "deliver",
    },
    continuity: {
      threadBindingKey: "thread-1",
      parentSessionKey: "session-1",
      preferredChildSessionKey: "child-key-1",
      preferredChildSessionId: "provider-session-1",
      preferredRunId: "run-1",
      continuationMode: "status_only",
    },
    mainContext: {
      summary: "status task",
      statusLine: "delivery pending",
      visibleIds: { workContractId: "wc-1" },
      artifactRefs: ["artifact-1"],
      nextAction: "deliver",
      tokenBudget: { maxResumeTokens: 700, maxArtifactSummaryTokens: 250 },
      forbiddenContent: ["full_transcript"],
    },
    telemetry: {
      dispatchExecuted: true,
      spawnExecuted: true,
      resultMaterialized: true,
      deliveryStatus: "pending",
      estimatedCostUsd: 0.01,
      actualCostUsd: 0.02,
    },
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:02:00.000Z",
  };

  return buildTaskStatusProjection({
    contract,
    now: "2026-04-18T00:00:12.345Z",
    deliveryAcknowledged: false,
    failureCode: "delivery_pending",
    failureMessage: "delivery pending",
  });
}

describe("view-model", () => {
  it("buildStatusSurface produces all required minimum fields", () => {
    const view = buildStatusSurface(createRecord());

    expect(view.taskId).toBe("task-123");
    expect(view.state).toBe("running");
    expect(view.route).toBe("delegate");
    expect(view.workerPool).toBe("octoclaw-worker");
    expect(view.substrateSummary).toBe("openclaw-native managed running");
    expect(view.actionAvailability).toEqual(["status", "details", "queue", "timeline"]);
    expect(view.queuePosition).toBe(0);
    expect(view.modelSummary).toBe("unreported");
    expect(view.costEstimate).toBe("unreported");
    expect(view.claimOwner).toBe("worker-alpha");
    expect(view.leaseState).toBe("active");
    expect(view.workspaceMode).toBe("isolated_worktree");
    expect(view.writeScopeSummary).toBe("repo:src");
    expect(view.threadCount).toBe(1);
    expect(view.advisorUsageSummary).toBe("none");
  });

  it("buildStatusProjection exposes TaskStatusProjection continuity and cost fields", () => {
    const view = buildStatusProjection({
      record: createRecord(),
      taskStatusProjection: createTaskStatusProjection(),
    });

    expect(view.state).toBe("deliverable_ready");
    expect(view.elapsedMs).toBe(12_345);
    expect(view.modelSummary).toBe("worker_code_normal");
    expect(view.costEstimate).toBe("$0.0200 actual");
    expect(view.failureCode).toBe("delivery_pending");
    expect(view.artifactRefs).toEqual(["artifact-1"]);
    expect(view.childSessionKey).toBe("child-key-1");
    expect(view.runId).toBe("run-1");
  });

  it("buildQueueSurface produces RuntimeQueueSurface", () => {
    const queue = buildQueueSurface(createRecord(), 3);

    expect(queue).toEqual({
      taskId: "task-123",
      flowId: "flow-456",
      queuePosition: 3,
      workerPool: "octoclaw-worker",
      substrateSummary: "openclaw-native managed running",
      claimOwner: "worker-alpha",
      leaseState: undefined,
      isStale: false,
      conflictQueued: false,
    });
  });

  it("buildTimelinePlaceholder produces available=true with summary", () => {
    const timeline = buildTimelinePlaceholder(createRecord());

    expect(timeline.available).toBe(true);
    expect(timeline.taskId).toBe("task-123");
    expect(timeline.flowId).toBe("flow-456");
    expect(timeline.summary).toBe("timeline placeholder for task-123");
    expect(timeline.events).toEqual([]);
  });

  it("buildTimelinePlaceholder projects delegate progress events", () => {
    const timeline = buildTimelinePlaceholder(createRecord(), createProgressEvents());

    expect(timeline.available).toBe(true);
    expect(timeline.summary).toBe("2 timeline events available for task-123");
    expect(timeline.events).toEqual([
      {
        timestamp: "2026-04-18T00:02:00.000Z",
        phase: "checkpoint",
        summary: "Fetched repository state",
      },
      {
        timestamp: "2026-04-18T00:03:00.000Z",
        phase: "deliverable_ready",
        summary: "Prepared operator summary",
      },
    ]);
  });

  it("buildDetailsSurface produces RuntimeStateDetailsSurface", () => {
    const details = buildDetailsSurface(createRecord());

    expect(details.taskId).toBe("task-123");
    expect(details.flowId).toBe("flow-456");
    expect(details.substrateState).toBe("running");
    expect(details.substrateRevision).toBe(7);
    expect(details.runtime).toBe("openclaw-native");
    expect(details.syncMode).toBe("managed");
    expect(details.claimOwner).toBe("worker-alpha");
    expect(details.workspaceMode).toBe("isolated_worktree");
    expect(details.writeScopeSummary).toBe("repo:src");
    expect(details.summary).toBe("openclaw-native managed running");
  });
});
