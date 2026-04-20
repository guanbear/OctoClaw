import type {
  BackendType,
  ContractEnvelope,
  ModelProfile,
  ScopeMetadata,
  WorkspaceMode,
} from "./schemas.js";

// ── Coordination modes ──

export type CoordinationMode =
  | "solo_worker"
  | "advisor_assisted"
  | "multi_agent_controlled";

// ── Attempt lifecycle ──

export type AttemptStatus =
  | "pending"
  | "queued"
  | "running"
  | "checkpoint"
  | "deliverable_ready"
  | "waiting_input"
  | "completed"
  | "failed"
  | "timed_out"
  | "recovering"
  | "cancelled";

export type DelegateTaskStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "timed_out"
  | "recovering"
  | "cancelled";

// ── Timeout categories ──

export type TimeoutCategory =
  | "queue_timeout"
  | "start_timeout"
  | "progress_timeout"
  | "runtime_timeout"
  | "delivery_timeout"
  | "stale_timeout";

// ── Recovery taxonomy ──

export type RecoveryCategory =
  | "transient_error"
  | "timeout"
  | "stale_claim"
  | "worker_crash"
  | "backend_unavailable"
  | "scope_conflict"
  | "input_required";

export interface RecoveryInfo {
  category: RecoveryCategory;
  reason: string;
  retryEligible: boolean;
  maxRetries: number;
  timeoutCategory?: TimeoutCategory;
}

// ── Native binding ──

export interface NativeTaskBinding {
  delegateTaskId: string;
  attemptId: string;
  nativeFlowId: string;
  nativeTaskId: string;
  claimOwner: string;
  resumeGeneration: number;
  boundAt?: string;
}

// ── Delegate task (user-visible work unit) ──

export interface DelegateTask extends ContractEnvelope, ScopeMetadata {
  kind: "projection";
  delegateTaskId: string;
  sessionId: string;
  route: "delegate";
  role: string;
  coordinationMode: CoordinationMode;
  goal: string;
  status: DelegateTaskStatus;
  currentAttemptId: string | null;
  totalAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastEventAt?: string;
}

// ── Delegate attempt (single execution try) ──

export interface DelegateAttempt extends ContractEnvelope {
  kind: "truth";
  attemptId: string;
  delegateTaskId: string;
  attemptGeneration: number;
  nativeBinding: NativeTaskBinding | null;
  status: AttemptStatus;
  claimOwner: string | null;
  modelProfile: ModelProfile;
  backend: BackendType;
  workspaceMode: WorkspaceMode;
  recoveryInfo?: RecoveryInfo;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

// ── Progress events ──

export type DelegateProgressEventType =
  | "checkpoint"
  | "deliverable_ready"
  | "waiting_input"
  | "backend_retry"
  | "delivery_pending"
  | "status_change"
  | "heartbeat";

export interface DelegateProgressEvent extends ContractEnvelope {
  kind: "artifact";
  eventId: string;
  delegateTaskId: string;
  attemptId: string;
  eventType: DelegateProgressEventType;
  eventAt: string;
  summary: string;
  artifactRefs?: string[];
  metadata?: Record<string, unknown>;
}

// ── Resume packet ──

export interface ResumePacket extends ContractEnvelope {
  kind: "artifact";
  delegateTaskId: string;
  attemptId: string;
  nativeBinding: NativeTaskBinding;
  goal: string;
  accumulatedArtifactRefs: string[];
  stateSnapshot: Record<string, unknown>;
  pendingSlots: string[];
  recoveryInfo?: RecoveryInfo;
}

// ── Timeline summary (for status projection) ──

export interface TimelineEntry {
  eventAt: string;
  eventType: DelegateProgressEventType | "created" | "attempt_started" | "attempt_completed" | "attempt_failed";
  summary: string;
  attemptGeneration?: number;
}

export interface TimelineSummary {
  entries: TimelineEntry[];
  lastEventAt: string | null;
  totalEvents: number;
}

// ── Status query packet (for main-agent to query) ──

export interface StatusQueryPacket extends ContractEnvelope {
  kind: "projection";
  delegateTaskId: string;
  currentAttemptId: string | null;
  currentAttemptStatus: AttemptStatus | null;
  nativeBinding: NativeTaskBinding | null;
  taskStatus: DelegateTaskStatus;
  role: string;
  coordinationMode: CoordinationMode;
  modelProfile: ModelProfile | null;
  backend: BackendType | null;
  totalAttempts: number;
  timeline: TimelineSummary;
  recoveryInfo: RecoveryInfo | null;
  queriedAt: string;
}

// ── Artifact ref (for typed artifact references) ──

export interface ArtifactRef {
  artifactId: string;
  artifactKind: string;
  uri?: string;
  title?: string;
}

// ── Failure info (structured alternative to bare string) ──

export interface FailureInfo {
  reason: string;
  recoveryInfo?: RecoveryInfo;
  failedAt: string;
  attemptGeneration: number;
}
