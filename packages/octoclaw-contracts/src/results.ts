import type {
  AcceptanceCriterion,
  CapabilityDescriptor,
  ContractEnvelope,
  ExecutionIdentity,
  ExecutionProvenance,
  ScopeMetadata,
} from "./schemas.js";
import type { OwnershipMetadata, TaskIdentity } from "./events.js";

export type WorkerResultStatus = "success" | "partial" | "blocked" | "failed";
export type LeaseState = "active" | "expiring" | "expired" | "released";

export interface CapabilityBoundFailure {
  capabilityId: string;
  reason: string;
  detail?: string;
  retryable?: boolean;
}

export interface WorkerResult extends ContractEnvelope, OwnershipMetadata, ScopeMetadata, TaskIdentity {
  resultId: string;
  status: WorkerResultStatus;
  summary: string;
  details?: string;
  artifactRefs: string[];
  acceptanceResults: Array<{
    criterion: AcceptanceCriterion;
    satisfied: boolean;
    evidence?: string;
  }>;
  capabilityFailure?: CapabilityBoundFailure;
}

export interface DelegatedMaterialization extends ContractEnvelope, ExecutionIdentity, ExecutionProvenance, OwnershipMetadata, ScopeMetadata, TaskIdentity {
  materializationId: string;
  substrateState: string;
  substrateRevision: number;
  syncMode: "managed";
  delegatedAt: string;
  capabilityRequirements?: CapabilityDescriptor[];
}

export interface StatusSurfaceViewModel extends ContractEnvelope {
  taskId: string;
  flowId: string;
  state: string;
  route: string;
  role: string;
  coordinationMode: string;
  backendSummary: string;
  workerPool: string;
  substrateSummary: string;
  actionAvailability: string[];
  queuePosition: number;
  modelSummary: string;
  costEstimate: string;
  claimOwner: string;
  leaseState: LeaseState;
  workspaceMode: string;
  writeScopeSummary: string;
  threadCount: number;
  advisorUsageSummary: string;
  elapsedMs?: number;
  success?: boolean;
  failureCode?: string;
  failureMessage?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  artifactRefs?: string[];
  childSessionKey?: string;
  childSessionId?: string;
  runId?: string;
  childRunId?: string;
  timelinePreview?: Array<{
    eventType: string;
    eventAt: string;
    summary: string;
  }>;
}
