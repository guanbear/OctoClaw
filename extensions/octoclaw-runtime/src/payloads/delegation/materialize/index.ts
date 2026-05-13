import type { ScopeDescriptor, WorkspaceMode } from "@octoclaw/contracts/schemas";
import { evaluateAdmission, type AdmissionDecision } from "@octoclaw/policy/admission";
import type { PolicyRole } from "@octoclaw/policy/roles";
import { buildWorkerBrief } from "../brief/index.js";
import { decideConflictPolicy, type ConflictDecision } from "../conflicts/index.js";
import { selectDelegationBackend } from "../profiles/index.js";

export interface DelegatedMaterialization {
  requestId: string;
  taskId: string;
  flowId: string;
  delegateTaskId?: string;
  attemptId?: string;
  attemptGeneration?: number;
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
  backend: "openclaw-native" | "clawteam";
  modelProfile: string;
  allowedTools: string[];
  outputContract: string;
  admission: AdmissionDecision;
  conflict: ConflictDecision;
  brief: ReturnType<typeof buildWorkerBrief>;
}

export function materializeDelegatedWork(input: {
  requestId: string;
  taskId: string;
  flowId: string;
  delegateTaskId?: string;
  attemptId?: string;
  attemptGeneration?: number;
  role: PolicyRole;
  goal: string;
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
  const backendSelection = selectDelegationBackend(input.role);
  const conflict = decideConflictPolicy(input.workspaceMode, input.writeConflict);
  const admission = evaluateAdmission({
    route: "delegate",
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
    delegateTaskId: input.delegateTaskId,
    attemptId: input.attemptId,
    attemptGeneration: input.attemptGeneration,
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
    backend: backendSelection.backend,
    modelProfile: backendSelection.profile.modelProfile,
    allowedTools: backendSelection.profile.allowedTools,
    outputContract: backendSelection.profile.outputContract,
    admission,
    conflict,
    brief: buildWorkerBrief(input.role, input.goal),
  };
}
