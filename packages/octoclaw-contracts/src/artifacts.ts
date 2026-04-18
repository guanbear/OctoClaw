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
  goal: string;
  constraints: string[];
  expectedOutput: string;
  acceptanceCriteria: AcceptanceCriterion[];
  acceptance_criteria?: AcceptanceCriterion[];
  artifactRefs: string[];
  deliveryContract: {
    mode: "reply" | "notify" | "silent";
    target: string;
  };
  objective?: string;
  allowedTools?: string[];
  doneDefinition?: string[];
  capabilityRequirements?: CapabilityDescriptor[];
}

export interface LifecycleArtifact extends ContractEnvelope, ExecutionIdentity, ExecutionProvenance, LifecycleState, OwnershipMetadata, IdempotencyMetadata, ScopeMetadata, TaskIdentity {
  artifactId: string;
  artifactKind: "execution_lifecycle";
  summary: string;
}

export interface WorkerBrief extends ContractEnvelope, ScopeMetadata {
  briefId: string;
  goal: string;
  constraints: string[];
  expectedOutput: string;
  relevantArtifactRefs: string[];
  runtimeLimits: {
    maxDurationMs?: number;
    maxTokens?: number;
  };
  deliveryContract: string;
  role?: string;
  backend?: string;
  modelProfile?: string;
  objective?: string;
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

export interface SessionThreadMetadata {
  threadId: string;
  flowId: string;
  taskId: string;
  role: string;
  modelProfile: string;
  workspaceMode: string;
  terminalState?: string;
}

export interface AgentInstanceMetadata {
  instanceId: string;
  role: string;
  modelProfile: string;
  workspaceMode: string;
  toolSet: string[];
}

export interface AdvisorPolicy {
  enabled: boolean;
  advisorModelProfile: string;
  maxUsesPerTask: number;
  maxCostUsd?: number;
  allowedStages: Array<"before_commit" | "when_stuck" | "before_done">;
}

export interface AdvicePacket {
  adviceId: string;
  advisorModelProfile: string;
  stage: string;
  summary: string;
  recommendations: string[];
}

export interface ThreadHandoffPacket {
  handoffId: string;
  fromThreadId: string;
  toThreadId: string;
  summary: string;
  artifactRefs: string[];
}

export interface InboxMessage {
  messageId: string;
  threadId: string;
  kind: "handoff" | "advisor_response" | "user_input" | "system";
  payload: string;
}

export interface SurfaceAnchor {
  anchorId: string;
  surfaceKind: "slack" | "discord" | "telegram" | "web" | "cli";
  channel?: string;
  sessionId: string;
  threadId?: string;
  taskId?: string;
  flowId?: string;
}

export interface ActiveContextBudget {
  maxTokens: number;
  usedTokens: number;
  priorityOrder: Array<"task_summary" | "artifact_refs" | "structured_state" | "transcript_excerpt">;
}

export interface SummarySnapshotMetadata {
  snapshotId: string;
  summaryKind: "thread" | "task" | "flow";
  tokenCount: number;
  createdAt: string;
}

export const NATIVE_TRUTH_ARTIFACT_KINDS = ["truth", "projection", "artifact", "telemetry"] as const;

export function createNativeTruthArtifactKinds(): Array<typeof NATIVE_TRUTH_ARTIFACT_KINDS[number]> {
  return [...NATIVE_TRUTH_ARTIFACT_KINDS];
}
