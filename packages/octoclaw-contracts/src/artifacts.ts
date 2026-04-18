import type {
  AcceptanceCriterion,
  CapabilityDescriptor,
  ContractEnvelope,
  ExecutionIdentity,
  ExecutionProvenance,
  IdempotencyMetadata,
  LifecycleState,
  ScopeMetadata,
} from "./schemas.js";
import type { OwnershipMetadata, TaskIdentity } from "./events.js";

export type ArtifactSurface = "truth" | "projection" | "artifact" | "telemetry";

export interface ArtifactDescriptor extends ContractEnvelope, OwnershipMetadata, IdempotencyMetadata, ScopeMetadata, TaskIdentity {
  artifactId: string;
  artifactKind: string;
  artifactSurface: ArtifactSurface;
  uri?: string;
  title?: string;
  summary?: string;
}

export interface TaskPacket extends ContractEnvelope, OwnershipMetadata, IdempotencyMetadata, ScopeMetadata, TaskIdentity {
  briefId: string;
  objective: string;
  acceptanceCriteria: AcceptanceCriterion[];
  deliveryContract: {
    mode: "reply" | "notify" | "silent";
    target: string;
  };
  allowedTools: string[];
  doneDefinition: string[];
  capabilityRequirements?: CapabilityDescriptor[];
}

export interface LifecycleArtifact extends ContractEnvelope, ExecutionIdentity, ExecutionProvenance, LifecycleState, OwnershipMetadata, IdempotencyMetadata, ScopeMetadata, TaskIdentity {
  artifactId: string;
  artifactKind: "execution_lifecycle";
  summary: string;
}

export interface WorkerBrief extends ContractEnvelope, ScopeMetadata {
  briefId: string;
  role: string;
  backend: string;
  modelProfile: string;
  objective: string;
  constraints: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  capabilityRequirements?: CapabilityDescriptor[];
}

export interface TruthArtifact<TTruth extends Record<string, unknown> = Record<string, unknown>> extends ContractEnvelope {
  kind: "truth";
  truth: TTruth;
}

export interface ProjectionArtifact<TProjection extends Record<string, unknown> = Record<string, unknown>> extends ContractEnvelope {
  kind: "projection";
  projection: TProjection;
}

export interface ArtifactPayload<TArtifact extends Record<string, unknown> = Record<string, unknown>> extends ContractEnvelope {
  kind: "artifact";
  artifact: TArtifact;
}

export interface TelemetryPayload<TTelemetry extends Record<string, unknown> = Record<string, unknown>> extends ContractEnvelope {
  kind: "telemetry";
  telemetry: TTelemetry;
}

export const NATIVE_TRUTH_ARTIFACT_KINDS = ["truth", "projection", "artifact", "telemetry"] as const;

export function createNativeTruthArtifactKinds(): Array<typeof NATIVE_TRUTH_ARTIFACT_KINDS[number]> {
  return [...NATIVE_TRUTH_ARTIFACT_KINDS];
}
