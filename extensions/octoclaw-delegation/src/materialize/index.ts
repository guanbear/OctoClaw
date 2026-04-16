import type { ScopeDescriptor, WorkspaceMode } from "../../../../packages/octoclaw-contracts/src/schemas.ts";
import { evaluateAdmission, type AdmissionDecision } from "../../../../packages/octoclaw-policy/src/admission/index.ts";
import type { PolicyRole } from "../../../../packages/octoclaw-policy/src/roles/index.ts";
import { buildWorkerBrief } from "../brief/index.ts";

export interface DelegatedMaterialization {
  requestId: string;
  taskId: string;
  flowId: string;
  role: PolicyRole;
  requestIdempotencyKey: string;
  deliveryId: string;
  deliveryReceiptId: string;
  claimOwner: string;
  claimToken: string;
  leaseExpiresAt: string;
  readScope: ScopeDescriptor[];
  writeScope: ScopeDescriptor[];
  workspaceMode: WorkspaceMode;
  writeScopeSummary: string;
  admission: AdmissionDecision;
  brief: ReturnType<typeof buildWorkerBrief>;
}

export function materializeDelegatedWork(input: {
  requestId: string;
  taskId: string;
  flowId: string;
  role: PolicyRole;
  objective: string;
  requestIdempotencyKey: string;
  deliveryId: string;
  deliveryReceiptId: string;
  claimOwner: string;
  leaseDurationMs: number;
  queueBudget: number;
  inflightCount: number;
  capabilitySatisfied: boolean;
  writeConflict: boolean;
  readScope: ScopeDescriptor[];
  writeScope: ScopeDescriptor[];
  workspaceMode: WorkspaceMode;
}): DelegatedMaterialization {
  const now = new Date();
  const claimToken = `${input.taskId}:${input.claimOwner}:${now.getTime()}`;
  const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs).toISOString();
  const admission = evaluateAdmission({
    route: "delegate.single",
    queueBudget: input.queueBudget,
    inflightCount: input.inflightCount,
    capabilitySatisfied: input.capabilitySatisfied,
    workspaceMode: input.workspaceMode,
    writeConflict: input.writeConflict,
  });

  return {
    requestId: input.requestId,
    taskId: input.taskId,
    flowId: input.flowId,
    role: input.role,
    requestIdempotencyKey: input.requestIdempotencyKey,
    deliveryId: input.deliveryId,
    deliveryReceiptId: input.deliveryReceiptId,
    claimOwner: input.claimOwner,
    claimToken,
    leaseExpiresAt,
    readScope: input.readScope,
    writeScope: input.writeScope,
    workspaceMode: input.workspaceMode,
    writeScopeSummary: input.writeScope.map((scope) => scope.resource).join(", ") || "read_only",
    admission,
    brief: buildWorkerBrief(input.role, input.objective),
  };
}
