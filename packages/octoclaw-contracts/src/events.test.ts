import { describe, expect, it } from "vitest";
import { buildContractEnvelope } from "./schemas.js";
import { isOwnershipMetadata, type FlowEvent, type TaskEvent } from "./events.js";

describe("events", () => {
  it("validates complete ownership metadata objects", () => {
    expect(isOwnershipMetadata({
      claimOwner: "octoclaw-runtime",
      claimToken: "claim-1",
      leaseExpiresAt: "2026-04-18T00:01:00.000Z",
      lastHeartbeatAt: "2026-04-18T00:00:00.000Z",
    })).toBe(true);

    expect(isOwnershipMetadata({
      claimOwner: "octoclaw-runtime",
      claimToken: "claim-1",
      leaseExpiresAt: "2026-04-18T00:01:00.000Z",
    })).toBe(false);
  });

  it("supports task event shapes", () => {
    const taskEvent: TaskEvent = {
      ...buildContractEnvelope("telemetry", "2026-04-18T00:00:00.000Z"),
      claimOwner: "octoclaw-runtime",
      claimToken: "claim-1",
      leaseExpiresAt: "2026-04-18T00:01:00.000Z",
      lastHeartbeatAt: "2026-04-18T00:00:00.000Z",
      requestIdempotencyKey: "request-1",
      taskIdempotencyKey: "task-1",
      flowIdempotencyKey: "flow-1",
      readScope: [{ resource: "docs", access: "read" }],
      writeScope: [{ resource: "workspace", access: "write" }],
      workspaceMode: "shared_workspace",
      taskId: "task-1",
      flowId: "flow-1",
      eventType: "checkpoint_emitted",
      eventAt: "2026-04-18T00:00:05.000Z",
      detail: "first checkpoint",
    };

    expect(taskEvent.taskId).toBe("task-1");
    expect(taskEvent.eventType).toBe("checkpoint_emitted");
  });

  it("supports flow event shapes", () => {
    const flowEvent: FlowEvent = {
      ...buildContractEnvelope("telemetry", "2026-04-18T00:00:00.000Z"),
      claimOwner: "octoclaw-runtime",
      claimToken: "claim-1",
      leaseExpiresAt: "2026-04-18T00:01:00.000Z",
      lastHeartbeatAt: "2026-04-18T00:00:00.000Z",
      requestIdempotencyKey: "request-1",
      taskIdempotencyKey: "task-1",
      flowIdempotencyKey: "flow-1",
      readScope: [{ resource: "docs", access: "read" }],
      writeScope: [{ resource: "workspace", access: "write" }],
      workspaceMode: "shared_workspace",
      flowId: "flow-1",
      eventType: "deliverable_ready",
      eventAt: "2026-04-18T00:00:10.000Z",
      activeTaskIds: ["task-1"],
    };

    expect(flowEvent.flowId).toBe("flow-1");
    expect(flowEvent.activeTaskIds).toEqual(["task-1"]);
  });
});
