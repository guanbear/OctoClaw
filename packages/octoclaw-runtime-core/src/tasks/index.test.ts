import { describe, expect, it } from "vitest";
import type { ExecutionIdentity } from "@octoclaw/contracts/schemas";
import {
  buildRuntimeTaskInterface,
  renewTaskInterfaceHeartbeat,
  resolveTaskClaimOwner,
} from "./index.js";

function buildIdentity(): ExecutionIdentity {
  return {
    requestId: "req-1",
    taskId: "task-1",
    flowId: "flow-1",
    route: "delegate.single",
    authority: "runtime_orchestrator",
    backend: "openclaw-native",
    materializationIntent: "spawn_single",
  };
}

function buildTaskState() {
  return buildRuntimeTaskInterface({
    requestId: "req-1",
    taskId: "task-1",
    flowId: "flow-1",
    claimOwner: "worker-a",
    leaseDurationMs: 30_000,
    identity: buildIdentity(),
    deadlineBudget: {
      queuedAt: "2026-04-18T14:00:00.000Z",
      queueMs: 1_000,
      startMs: 2_000,
      progressMs: 3_000,
      runtimeMs: 4_000,
      deliveryMs: 5_000,
    },
  });
}

describe("runtime task interface", () => {
  it("builds claim deadlines and materialization together", () => {
    const state = buildTaskState();

    expect(state.claim.claimOwner).toBe("worker-a");
    expect(state.deadlines.deliveryDeadline).toBe("2026-04-18T14:00:05.000Z");
    expect(state.materialization).toMatchObject({
      requestId: "req-1",
      taskId: "task-1",
      flowId: "flow-1",
      requestIdempotencyKey: "req-1",
      taskIdempotencyKey: "req-1:task-1",
      flowIdempotencyKey: "req-1:flow-1",
      route: "delegate.single",
      authority: "runtime_orchestrator",
      backend: "openclaw-native",
      materializationIntent: "spawn_single",
      claimOwner: state.claim.claimOwner,
      claimToken: state.claim.claimToken,
      leaseExpiresAt: state.claim.leaseExpiresAt,
      taskPacketRef: "req-1:flow-1:req-1:task-1",
    });
  });

  it("updates claim and materialization on heartbeat renewal", () => {
    const state = buildTaskState();
    const renewed = renewTaskInterfaceHeartbeat(state, {
      claimToken: state.claim.claimToken,
      heartbeatAt: "2026-04-18T14:00:20.000Z",
    });

    expect(renewed.claim.lastHeartbeatAt).toBe("2026-04-18T14:00:20.000Z");
    expect(renewed.materialization.claimToken).toBe(state.claim.claimToken);
    expect(renewed.materialization.leaseExpiresAt).toBe(renewed.claim.leaseExpiresAt);
  });

  it("renews the existing claim when the same owner resolves it", () => {
    const state = buildTaskState();
    const resolved = resolveTaskClaimOwner(state, "worker-a");

    expect(resolved.claim.claimOwner).toBe("worker-a");
    expect(new Date(resolved.claim.leaseExpiresAt).getTime()).toBeGreaterThanOrEqual(
      new Date(state.claim.leaseExpiresAt).getTime(),
    );
  });

  it("reclaims with a new owner when the existing lease is expired", () => {
    const initial = buildTaskState();
    const expiredState = {
      ...initial,
      claim: {
        ...initial.claim,
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
      },
    };
    const resolved = resolveTaskClaimOwner(expiredState, "worker-b");

    expect(resolved.claim.claimOwner).toBe("worker-b");
    expect(resolved.claim.claimToken).toContain("task-1:worker-b:");
  });
});
