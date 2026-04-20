import { describe, expect, it } from "vitest";
import type { RuntimeStateSurfaceRecord } from "@octoclaw/runtime/state-surface";
import { runStatusSurfaceOperator } from "./index.js";

function createRecord(): RuntimeStateSurfaceRecord {
  return {
    taskId: "task-123",
    flowId: "flow-456",
    runtime: "openclaw-native",
    syncMode: "managed",
    substrateState: "running",
    substrateRevision: 13,
    ownership: {
      claimOwner: "worker-operator",
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
      substrateRevision: 13,
      managedDisposition: "managed",
      ownership: {
        claimOwner: "worker-operator",
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
      substrateRevision: 13,
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
      substrateRevision: 13,
      syncMode: "managed",
      claimOwner: "worker-operator",
    },
  };
}

describe("operator", () => {
  it("runStatusSurfaceOperator status/details/queue produce text output and timeline returns placeholder text", () => {
    const record = createRecord();

    expect(runStatusSurfaceOperator("status", record, "text")).toContain("Status: task-123");
    expect(runStatusSurfaceOperator("details", record, "text")).toContain("Details: task-123");
    expect(runStatusSurfaceOperator("queue", record, "text")).toContain("Queue: task-123");
    expect(runStatusSurfaceOperator("timeline", record, "text")).toContain("timeline placeholder for task-123");
  });

  it("format parameter selects text and rich renderers", () => {
    const record = createRecord();
    const text = runStatusSurfaceOperator("status", record, "text");
    const rich = runStatusSurfaceOperator("status", record, "rich");

    expect(typeof text).toBe("string");
    expect(text).toContain("state=running");
    expect(rich).toMatchObject({
      kind: "status_card",
      title: "task-123",
      state: "running",
      route: "delegate",
    });
  });
});
