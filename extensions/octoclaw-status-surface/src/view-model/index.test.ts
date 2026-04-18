import { describe, expect, it } from "vitest";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
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

describe("view-model", () => {
  it("buildStatusSurface produces all required minimum fields", () => {
    const view = buildStatusSurface(createRecord());

    expect(view.taskId).toBe("task-123");
    expect(view.state).toBe("running");
    expect(view.route).toBe("delegate.single");
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
