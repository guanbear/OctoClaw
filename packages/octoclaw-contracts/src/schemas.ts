export const OCTOCLAW_CONTRACT_SCHEMA_VERSION = "octoclaw.contracts/v1" as const;

export type SchemaVersion = typeof OCTOCLAW_CONTRACT_SCHEMA_VERSION;
export type WorkspaceMode = "isolated_workspace" | "shared_workspace" | "read_only_workspace";
export type ScopeAccessLevel = "none" | "read" | "write" | "admin";
export type ArtifactKind = "truth" | "projection" | "artifact" | "telemetry";

export interface ScopeDescriptor {
  resource: string;
  access: ScopeAccessLevel;
  reason?: string;
}

export interface ScopeMetadata {
  readScope: ScopeDescriptor[];
  writeScope: ScopeDescriptor[];
  workspaceMode: WorkspaceMode;
  writeScopeSummary?: string;
}

export interface IdempotencyMetadata {
  requestIdempotencyKey: string;
  taskIdempotencyKey?: string;
  flowIdempotencyKey?: string;
}

export interface ContractEnvelope {
  schemaVersion: SchemaVersion;
  kind: ArtifactKind;
  createdAt: string;
}

export interface RequestContext extends ContractEnvelope, ScopeMetadata, IdempotencyMetadata {
  kind: "truth";
  requestId: string;
  sessionId?: string;
  route: "reply" | "delegate.single" | "observe";
  role: string;
  backend: string;
  modelProfile: string;
}

export interface RouteDecisionContract extends ContractEnvelope, ScopeMetadata {
  kind: "projection";
  requestId: string;
  route: "reply" | "delegate.single" | "observe";
  backend: string;
  modelProfile: string;
  reasonCodes: string[];
}

export function buildContractEnvelope(kind: ArtifactKind, createdAt = new Date().toISOString()): ContractEnvelope {
  return {
    schemaVersion: OCTOCLAW_CONTRACT_SCHEMA_VERSION,
    kind,
    createdAt,
  };
}

export function withSchemaVersion<T extends Record<string, unknown>>(payload: T): T & { schemaVersion: SchemaVersion } {
  return {
    ...payload,
    schemaVersion: OCTOCLAW_CONTRACT_SCHEMA_VERSION,
  };
}

export function isWorkspaceMode(value: string): value is WorkspaceMode {
  return ["isolated_workspace", "shared_workspace", "read_only_workspace"].includes(value);
}

export function validateScopeMetadata(value: Partial<ScopeMetadata>): value is ScopeMetadata {
  return Array.isArray(value.readScope)
    && Array.isArray(value.writeScope)
    && typeof value.workspaceMode === "string"
    && isWorkspaceMode(value.workspaceMode);
}
