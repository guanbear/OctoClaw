import { describe, expect, it } from "vitest";
import { applyHeartbeat, canClaim, claimTask, renewClaimLease } from "./claims.js";

describe("task claims", () => {
  it("creates a new claim with owner token and lease expiration", () => {
    const now = new Date("2026-04-18T12:00:00.000Z");
    const claim = claimTask("task-1", "worker-a", 30_000, now);

    expect(claim).toEqual({
      taskId: "task-1",
      claimOwner: "worker-a",
      claimToken: "task-1:worker-a:1776513600000",
      lastHeartbeatAt: "2026-04-18T12:00:00.000Z",
      leaseExpiresAt: "2026-04-18T12:00:30.000Z",
      resumeGeneration: 1,
      leaseDurationMs: 30_000,
    });
  });

  it("allows claiming when claim is null or expired, but not when active", () => {
    const activeClaim = claimTask("task-1", "worker-a", 30_000, new Date("2026-04-18T12:00:00.000Z"));

    expect(canClaim(null)).toBe(true);
    expect(canClaim(activeClaim, new Date("2026-04-18T12:00:10.000Z"))).toBe(false);
    expect(canClaim(activeClaim, new Date("2026-04-18T12:00:30.000Z"))).toBe(true);
  });

  it("renews lease by the configured lease duration", () => {
    const claim = claimTask("task-1", "worker-a", 30_000, new Date("2026-04-18T12:00:00.000Z"));
    const renewed = renewClaimLease(claim, new Date("2026-04-18T12:00:20.000Z"));

    expect(renewed.lastHeartbeatAt).toBe("2026-04-18T12:00:20.000Z");
    expect(renewed.leaseExpiresAt).toBe("2026-04-18T12:00:50.000Z");
    expect(renewed.claimToken).toBe(claim.claimToken);
  });

  it("rejects heartbeats with the wrong token", () => {
    const claim = claimTask("task-1", "worker-a", 30_000, new Date("2026-04-18T12:00:00.000Z"));

    expect(() => applyHeartbeat(claim, {
      claimToken: "wrong-token",
      heartbeatAt: "2026-04-18T12:00:10.000Z",
    })).toThrow("claim_token_mismatch");
  });

  it("renews lease when heartbeat token matches", () => {
    const claim = claimTask("task-1", "worker-a", 30_000, new Date("2026-04-18T12:00:00.000Z"));
    const renewed = applyHeartbeat(claim, {
      claimToken: claim.claimToken,
      heartbeatAt: "2026-04-18T12:00:15.000Z",
    });

    expect(renewed.lastHeartbeatAt).toBe("2026-04-18T12:00:15.000Z");
    expect(renewed.leaseExpiresAt).toBe("2026-04-18T12:00:45.000Z");
  });
});
