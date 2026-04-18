import type { OwnershipMetadata } from "@octoclaw/contracts/events";

export interface RuntimeClaim extends OwnershipMetadata {
  taskId: string;
  claimOwner: string;
  claimToken: string;
  leaseExpiresAt: string;
  leaseDurationMs: number;
}

export interface ClaimHeartbeat {
  claimToken: string;
  heartbeatAt: string;
}

export function claimTask(taskId: string, claimOwner: string, leaseDurationMs: number, now = new Date()): RuntimeClaim {
  const issuedAt = now.toISOString();
  return {
    taskId,
    claimOwner,
    claimToken: `${taskId}:${claimOwner}:${now.getTime()}`,
    lastHeartbeatAt: issuedAt,
    leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    leaseDurationMs,
  };
}

export function canClaim(existingClaim: RuntimeClaim | null | undefined, now = new Date()): boolean {
  if (!existingClaim) {
    return true;
  }
  return new Date(existingClaim.leaseExpiresAt).getTime() <= now.getTime();
}

export function renewClaimLease(existingClaim: RuntimeClaim, heartbeatAt = new Date()): RuntimeClaim {
  const renewedAt = heartbeatAt.toISOString();
  return {
    ...existingClaim,
    lastHeartbeatAt: renewedAt,
    leaseExpiresAt: new Date(heartbeatAt.getTime() + existingClaim.leaseDurationMs).toISOString(),
  };
}

export function applyHeartbeat(existingClaim: RuntimeClaim, heartbeat: ClaimHeartbeat): RuntimeClaim {
  if (existingClaim.claimToken !== heartbeat.claimToken) {
    throw new Error("claim_token_mismatch");
  }
  return renewClaimLease(existingClaim, new Date(heartbeat.heartbeatAt));
}
