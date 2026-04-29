import type {
  ExecutionIdentity,
  MaterializationIntent,
} from "@octoclaw/contracts/schemas";
import {
  applyHeartbeat,
  canClaim,
  claimTask,
  renewClaimLease,
  type ClaimHeartbeat,
  type RuntimeClaim,
} from "./claims.js";
import {
  buildRuntimeDeadlines,
  hasDeadlineExpired,
  nextDeadlineToEnforce,
  type DeadlineBudgetInput,
  type RuntimeDeadlines,
} from "./deadlines.js";

export interface RuntimeTaskMaterializationPacket {
  requestId: string;
  taskId: string;
  flowId: string;
  requestIdempotencyKey: string;
  taskIdempotencyKey: string;
  flowIdempotencyKey: string;
  route: ExecutionIdentity["route"];
  authority: ExecutionIdentity["authority"];
  backend: ExecutionIdentity["backend"];
  materializationIntent: MaterializationIntent;
  claimOwner: string;
  claimToken: string;
  leaseExpiresAt: string;
  taskPacketRef: string;
}

export interface RuntimeTaskInterfaceInput {
  requestId: string;
  taskId: string;
  flowId: string;
  requestIdempotencyKey?: string;
  taskIdempotencyKey?: string;
  flowIdempotencyKey?: string;
  claimOwner: string;
  leaseDurationMs: number;
  identity: ExecutionIdentity;
  deadlineBudget: DeadlineBudgetInput;
}

export interface RuntimeTaskInterfaceState {
  claim: RuntimeClaim;
  deadlines: RuntimeDeadlines;
  materialization: RuntimeTaskMaterializationPacket;
}

export {
  applyHeartbeat,
  buildRuntimeDeadlines,
  canClaim,
  claimTask,
  hasDeadlineExpired,
  nextDeadlineToEnforce,
  renewClaimLease,
};

export type {
  ClaimHeartbeat,
  DeadlineBudgetInput,
  RuntimeClaim,
  RuntimeDeadlines,
};

export function buildTaskMaterializationPacket(
  input: Pick<RuntimeTaskInterfaceInput, "requestId" | "taskId" | "flowId" | "requestIdempotencyKey" | "taskIdempotencyKey" | "flowIdempotencyKey" | "identity">,
  claim: RuntimeClaim,
): RuntimeTaskMaterializationPacket {
  const requestIdempotencyKey = input.requestIdempotencyKey || input.requestId;
  const taskIdempotencyKey = input.taskIdempotencyKey || `${requestIdempotencyKey}:${input.taskId}`;
  const flowIdempotencyKey = input.flowIdempotencyKey || `${requestIdempotencyKey}:${input.flowId}`;
  return {
    requestId: input.requestId,
    taskId: input.taskId,
    flowId: input.flowId,
    requestIdempotencyKey,
    taskIdempotencyKey,
    flowIdempotencyKey,
    route: input.identity.route,
    authority: input.identity.authority,
    backend: input.identity.backend,
    materializationIntent: input.identity.materializationIntent,
    claimOwner: claim.claimOwner,
    claimToken: claim.claimToken,
    leaseExpiresAt: claim.leaseExpiresAt,
    taskPacketRef: `${flowIdempotencyKey}:${taskIdempotencyKey}`,
  };
}

export function refreshTaskMaterializationPacket(
  materialization: RuntimeTaskMaterializationPacket,
  claim: RuntimeClaim,
): RuntimeTaskMaterializationPacket {
  return {
    ...materialization,
    claimOwner: claim.claimOwner,
    claimToken: claim.claimToken,
    leaseExpiresAt: claim.leaseExpiresAt,
    taskPacketRef: `${materialization.flowIdempotencyKey}:${materialization.taskIdempotencyKey}`,
  };
}

export function buildRuntimeTaskInterface(input: RuntimeTaskInterfaceInput): RuntimeTaskInterfaceState {
  const claim = claimTask(input.taskId, input.claimOwner, input.leaseDurationMs);
  return {
    claim,
    deadlines: buildRuntimeDeadlines(input.deadlineBudget),
    materialization: buildTaskMaterializationPacket(input, claim),
  };
}

export function renewTaskInterfaceHeartbeat(
  state: RuntimeTaskInterfaceState,
  heartbeat: ClaimHeartbeat,
): RuntimeTaskInterfaceState {
  const claim = applyHeartbeat(state.claim, heartbeat);
  return {
    ...state,
    claim,
    materialization: refreshTaskMaterializationPacket(state.materialization, claim),
  };
}

export function resolveTaskClaimOwner(
  state: RuntimeTaskInterfaceState,
  nextClaimOwner: string,
): RuntimeTaskInterfaceState {
  const claim = state.claim.claimOwner === nextClaimOwner
    ? renewClaimLease(state.claim)
    : canClaim(state.claim)
      ? claimTask(state.claim.taskId, nextClaimOwner, state.claim.leaseDurationMs)
      : (() => {
        throw new Error("claim_owner_conflict");
      })();

  return {
    ...state,
    claim,
    materialization: refreshTaskMaterializationPacket(state.materialization, claim),
  };
}
