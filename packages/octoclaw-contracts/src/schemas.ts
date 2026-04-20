export const OCTOCLAW_CONTRACT_SCHEMA_VERSION = "octoclaw.contracts/v1" as const;

export type SchemaVersion = typeof OCTOCLAW_CONTRACT_SCHEMA_VERSION;
export type WorkspaceMode = "read_only" | "shared_workspace" | "isolated_worktree";
export type ScopeAccessLevel = "none" | "read" | "write" | "admin";
export type ArtifactKind = "truth" | "projection" | "artifact" | "telemetry";
export type ExecutionRoute = "reply" | "delegate" | "delegate.single" | "observe";
export type CanonicalRoute = "reply" | "delegate";
export type ExecutionAuthority = "main_session" | "runtime_orchestrator" | "native_runner" | "native_subagent";
export type BackendType = "openclaw-native" | "clawteam" | "legacy-python";
export type ExecutionBackend = BackendType;
export type MaterializationIntent = "reply_inline" | "observe_probe" | "runner_task" | "spawn_single" | "spawn_multi";

export type CoordinationMode =
  | "solo_worker"
  | "advisor_assisted"
  | "multi_agent_controlled";
export type CapabilityLevel = "unsupported" | "limited" | "supported" | "preferred";
// Model profiles from design doc section 9.5.0
export type ModelProfile =
  | "judge_fast"
  | "observer_probe"
  | "direct_main"
  | "worker_default"
  | "worker_research"
  | "worker_code_normal"
  | "worker_code_deep"
  | "worker_review"
  | "worker_deep";

export type ConcreteModelId = string;

export interface ModelProfileMapping {
  profile: ModelProfile;
  modelId: ConcreteModelId;
}

// Hard boundary signals from design doc section 9.2
export type HardBoundarySignal =
  | "explicit_control_action"
  | "existing_task_binding"
  | "recovery_session"
  | "permission_boundary"
  | "dangerous_write";

export type CheckpointEventType =
  | "checkpoint_emitted"
  | "deliverable_ready"
  | "waiting_input"
  | "backend_retry_scheduled"
  | "delivery_pending"
  | "stale";

export interface HardBoundaryCheckResult {
  triggered: boolean;
  signal: HardBoundarySignal | null;
  routeOverride?: string;
  reason: string;
}

export type LifecyclePhase =
  | "ingress_received"
  | "ack_pending"
  | "materialization_pending"
  | "materialized"
  | "running"
  | "waiting_input"
  | "checkpoint_pending"
  | "checkpoint_emitted"
  | "deliverable_ready"
  | "delivery_pending"
  | "backend_retry_scheduled"
  | "stale"
  | "completed"
  | "failed"
  | "timed_out"
  | "blocked"
  | "recovering";
export type DeliveryState = "not_started" | "queued" | "sent" | "acknowledged" | "failed";
export type ProvenanceSource = "direct_reply" | "runtime_orchestrator" | "runner_substrate" | "spawn_substrate" | "native_taskflow";

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

export interface AcceptanceCriterion {
  id: string;
  description: string;
  required: boolean;
}

export interface IdempotencyMetadata {
  requestIdempotencyKey: string;
  taskIdempotencyKey?: string;
  flowIdempotencyKey?: string;
}

export interface ExecutionIdentity {
  requestId: string;
  taskId: string;
  flowId: string;
  route: ExecutionRoute;
  authority: ExecutionAuthority;
  backend: BackendType;
  materializationIntent: MaterializationIntent;
}

export interface ExecutionProvenance {
  source: ProvenanceSource;
  sourceRef: string;
  decisionRef?: string;
  materializedBy?: string;
  checkpointRef?: string;
}

export interface CapabilityDescriptor {
  capabilityId: string;
  level: CapabilityLevel;
  summary: string;
  constraints?: string[];
  notes?: string[];
}

export interface LifecycleState {
  phase: LifecyclePhase;
  deliveryState: DeliveryState;
  checkpointState: "none" | "pending" | "emitted" | "stale";
  materializedAt?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  blockedAt?: string;
  lastCheckpointAt?: string;
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
  route: ExecutionRoute;
  role: string;
  backend: BackendType;
  modelProfile: ModelProfile;
}

export interface RouteDecisionContract extends ContractEnvelope, ScopeMetadata {
  kind: "projection";
  requestId: string;
  route: ExecutionRoute;
  backend: BackendType;
  modelProfile: ModelProfile;
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
  return ["read_only", "shared_workspace", "isolated_worktree"].includes(value);
}

export function validateScopeMetadata(value: Partial<ScopeMetadata>): value is ScopeMetadata {
  return Array.isArray(value.readScope)
    && Array.isArray(value.writeScope)
    && typeof value.workspaceMode === "string"
    && isWorkspaceMode(value.workspaceMode);
}
