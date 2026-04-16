import type { ContractEnvelope, IdempotencyMetadata, ScopeMetadata } from "./schemas";
import type { OwnershipMetadata, TaskIdentity } from "./events";

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
  allowedTools: string[];
  doneDefinition: string[];
}

export interface WorkerBrief extends ContractEnvelope, ScopeMetadata {
  briefId: string;
  role: string;
  backend: string;
  modelProfile: string;
  objective: string;
  constraints: string[];
}
