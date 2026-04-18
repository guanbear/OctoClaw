import { describe, expect, it } from "vitest";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import { executeStatusSurfaceAction } from "./index.js";

function createRecord(): RuntimeStateSurfaceRecord {
  return {
    taskId: "task-123",
    flowId: "flow-456",
    runtime: "openclaw-native",
    syncMode: "managed",
    substrateState: "running",
    substrateRevision: 11,
    ownership: {
      claimOwner: "worker-action",
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
      substrateRevision: 11,
      managedDisposition: "managed",
      ownership: {
        claimOwner: "worker-action",
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
      status: "projection-status",
      runtime: "openclaw-native",
      flowId: "flow-456",
      taskId: "task-123",
      substrateState: "running",
      substrateRevision: 11,
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
      substrateRevision: 11,
      syncMode: "managed",
      claimOwner: "worker-action",
    },
  };
}

describe("actions", () => {
  it("status, details, queue, and timeline actions are callable", () => {
    const record = createRecord();

    expect(executeStatusSurfaceAction("status", record)).toBeTruthy();
    expect(executeStatusSurfaceAction("details", record)).toBeTruthy();
    expect(executeStatusSurfaceAction("queue", record)).toBeTruthy();
    expect(executeStatusSurfaceAction("timeline", record)).toBeTruthy();
  });

  it("unknown action returns empty result", () => {
    const invokeUnknown = executeStatusSurfaceAction as unknown as (
      action: string,
      record: RuntimeStateSurfaceRecord,
    ) => unknown;

    expect(invokeUnknown("unknown", createRecord())).toBeUndefined();
  });

  it("each action reads from substrate truth", () => {
    const record = createRecord();
    const status = executeStatusSurfaceAction("status", record);
    const details = executeStatusSurfaceAction("details", record);
    const queue = executeStatusSurfaceAction("queue", record);
    const timeline = executeStatusSurfaceAction("timeline", record);

    expect(status).toMatchObject({
      taskId: record.truth.taskId,
      flowId: record.truth.flowId,
      state: record.substrateState,
      claimOwner: record.ownership.claimOwner,
    });
    expect(details).toMatchObject({
      taskId: record.truth.taskId,
      flowId: record.truth.flowId,
      substrateState: record.substrateState,
      summary: "openclaw-native managed running",
    });
    expect(queue).toMatchObject({
      taskId: record.truth.taskId,
      flowId: record.truth.flowId,
      substrateSummary: "openclaw-native managed running",
      claimOwner: record.ownership.claimOwner,
    });
    expect(timeline).toMatchObject({
      taskId: record.truth.taskId,
      flowId: record.truth.flowId,
      available: true,
      summary: "timeline placeholder for task-123",
    });
  });
});
