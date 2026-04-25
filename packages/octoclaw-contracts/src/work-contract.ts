// WorkContract — canonical semantic and delegation contract.
// Design ref: docs/octoclaw-work-contract-centered-delegation-design-2026-04-25.md
// Invariants: TaskFlow=lifecycle truth, WorkContract=semantic truth; flowId+expectedRevision for mutations;
// TaskFlow created ≠ spawnExecuted; execution coverage sufficient → reply.answer; resume preferred child.

import type { CoordinationMode } from "./delegate.js";
import type { DelegateArtifactKind } from "./delegate-context.js";

// ── Route & intent ──

export type WorkRoute = "reply" | "delegate";

export type IntentClass =
  | "plain_chat"
  | "runtime_read_model"
  | "execution_followup"
  | "local_surface_lookup"
  | "fresh_live_lookup"
  | "delegated_work"
  | "undetermined";

// ── WorkContract status ──

export type WorkContractStatus =
  | "draft"
  | "sealed"
  | "materializing"
  | "planned"
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

// ── Context coverage snapshot ──

export type CoverageAuthority = "execution_wins" | "memory_only" | "none";

export interface ContextCoverageSnapshot {
  precheckOrder: [
    "conversation_grounding",
    "continuation_route_reuse",
    "execution_coverage",
    "memory_coverage",
    "build_judge_context_packet",
    "local_judge",
    "validator_or_remote",
    "route_seal_commit",
  ];
  execution: JudgeExecutionLayer;
  memory: JudgeMemoryLayer;
  conflict: boolean;
  authority: CoverageAuthority;
}

export interface ExecutionCoveragePacket {
  packetId: string;
  requestId?: string;
  turnId?: string;
  sessionKey: string;
  coverage: ContextCoverageSnapshot;
  route: WorkRoute;
  replyMode?: "answer" | "clarify";
  dispatchExecuted: boolean;
  spawnExecuted: boolean;
  resultMaterialized: boolean;
  nativeBinding?: NativeBindingRef;
  evidenceRefs: string[];
  evidenceSummary?: string;
  createdAt: string;
}

// ── Coverage layers (mirrors @octoclaw/policy/judge-schema but lives in contracts for portability) ──

export interface JudgeExecutionLayer {
  coverage?: "none" | "current_turn" | "recent_turn" | "thread";
  freshness?: "current" | "recent" | "stale";
  supports_provenance_reply?: boolean;
  supports_status_reply?: boolean;
  requires_control_plane_refresh?: boolean;
  last_route?: "reply" | "delegate" | "unknown";
  last_reply_mode?: "answer" | "clarify" | null;
  last_delegate_role?: "observer" | "default" | "code" | "research" | "review" | null;
  tools_used?: string[];
  dispatch_executed?: boolean;
  spawn_executed?: boolean;
  native_task_id?: string;
  native_flow_id?: string;
  result_materialized?: boolean;
  delivery_status?: "none" | "pending" | "delivered" | "failed";
  evidence_summary?: string;
  conflict?: boolean;
}

export interface JudgeMemoryLayer {
  coverage?: "none" | "partial" | "strong";
  freshness_risk?: "low" | "high";
  source?: Array<"bootstrap" | "memory_search" | "active_memory">;
  supports_direct_reply?: boolean;
  supports_fresh_lookup?: boolean;
  evidence_summary?: string;
  conflict?: boolean;
}

// ── Decision seal ──

export type WorkDecisionSource =
  | "continuation"
  | "execution_coverage"
  | "memory_coverage"
  | "local_judge"
  | "remote_judge"
  | "validator"
  | "main_agent_route_hint"
  | "policy_rule";

export interface WorkDecisionSeal {
  source: WorkDecisionSource;
  route: WorkRoute;
  replyMode?: "answer" | "clarify";
  delegateRole?: "observer" | "default" | "code" | "research" | "review";
  confidence?: number;
  reasonCodes: string[];
  routeSealId?: string;
  judgeTraceRef?: string;
  sealedAt: string;
}

// ── Reply contract ──

export type ReplyGrounding =
  | "none"
  | "memory"
  | "execution_receipt"
  | "control_plane_status"
  | "artifact_summary";

export interface ReplyContract {
  replyMode: "answer" | "clarify" | "status_summary";
  grounding: ReplyGrounding;
  allowedTools: string[];
  forbiddenTools: string[];
  evidenceRefs: string[];
}

// ── Delegate contract ──

export type DelegateNextAction =
  | "dispatch"
  | "wait"
  | "open_artifact"
  | "ask_user"
  | "retry"
  | "deliver";

export interface DelegateContract {
  delegateTaskId: string;
  currentAttemptId: string | null;
  role: "observer" | "default" | "code" | "research" | "review";
  coordinationMode: CoordinationMode;
  acceptanceCriteria: string[];
  scope: {
    read: string[];
    write: string[];
    workspaceMode: "read_only" | "write_allowed";
    scopeFingerprint: string;
  };
  modelProfile: string;
  nativeBinding: NativeBindingRef | null;
  childSessions: ChildSessionContinuity[];
  artifactRefs: DelegateArtifactRef[];
  nextAction: DelegateNextAction;
  blocker?: string;
}

// ── Native binding ref ──

export type NativeFlowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type NativeFlowMutation =
  | "createManaged"
  | "runTask"
  | "setWaiting"
  | "resume"
  | "finish"
  | "fail"
  | "requestCancel"
  | "cancel";

export type NativeFlowMutationError =
  | "not_found"
  | "not_managed"
  | "revision_conflict";

export interface NativeBindingRef {
  flowId: string;
  nativeFlowId?: string;
  ownerKey: string;
  controllerId: "octoclaw.delegate" | string;
  revision: number;
  expectedRevision: number;
  taskId?: string;
  nativeTaskId?: string;
  runId?: string;
  childRunId?: string;
  childSessionKey?: string;
  syncMode: "managed" | "task_mirrored";
  status: NativeFlowStatus;
  currentStep?: string;
  waitKind?: string;
  stateRef?: string;
  waitRef?: string;
  requesterOriginRef?: string;
  boundAt?: string;
  lastMutation?: NativeFlowMutation;
  lastMutationApplied?: boolean;
  lastMutationError?: NativeFlowMutationError;
}

// ── Child session continuity (OMO borrowing) ──

export type ChildSessionStatus =
  | "created"
  | "running"
  | "idle"
  | "blocked"
  | "completed"
  | "failed"
  | "retired";

export type ChildReuseState = "preferred" | "eligible" | "blocked" | "retired";

export type ProviderKind = "codex" | "claude-code" | "acp" | string;

export interface ProviderSessionBinding {
  provider: ProviderKind;
  sessionId?: string;
  runtimeSessionName?: string;
  sessionFile?: string;
}

export interface ChildSessionContinuity {
  childSessionKey: string;
  childSessionId?: string;
  providerSessionBinding?: ProviderSessionBinding;
  runId?: string;
  expectsCompletionMessage?: boolean;
  directThreadDelivery?: boolean;
  delegateTaskId: string;
  firstAttemptId: string;
  latestAttemptId: string;
  agentRole: string;
  modelProfile: string;
  category?: string;
  parentSessionKey: string;
  threadBindingKey: string;
  scopeFingerprint: string;
  status: ChildSessionStatus;
  reuseState: ChildReuseState;
  reuseBlockedReason?: string;
  lastPromptHash?: string;
  lastResultArtifactRef?: string;
  lastEventAt?: string;
}

// ── Delegate artifact ref (typed) ──

export interface DelegateArtifactRef {
  artifactId: string;
  artifactKind: DelegateArtifactKind;
  uri?: string;
  title?: string;
  summary?: string;
  tokenEstimate?: number;
  createdAt: string;
}

// ── Main context packet ──

export type ForbiddenContentType =
  | "full_transcript"
  | "internal_route_rationale"
  | "delegation_rationale"
  | "contamination_guard_text"
  | "worker_chain_of_thought"
  | "raw_execution_log";

export type ContinuationPreferredMode =
  | "resume_preferred"
  | "status_only"
  | "new_attempt";

export interface MainContextPacket {
  summary: string;
  statusLine: string;
  visibleIds: {
    workContractId: string;
    delegateTaskId?: string;
    attemptId?: string;
    nativeTaskId?: string;
    nativeFlowId?: string;
    childSessionKey?: string;
    childSessionId?: string;
  };
  continuationHint?: {
    handle: string;
    preferredMode: ContinuationPreferredMode;
    text: "resume_dont_restart";
  };
  artifactRefs: string[];
  nextAction: string;
  tokenBudget: {
    maxResumeTokens: 700;
    maxArtifactSummaryTokens: 250;
  };
  forbiddenContent: ForbiddenContentType[];
}

// ── Work contract telemetry ──

export interface WorkContractTelemetry {
  executionCoverage?: string;
  executionSupportsProvenanceReply?: boolean;
  executionSupportsStatusReply?: boolean;
  executionRequiresControlPlaneRefresh?: boolean;
  memoryCoverage?: string;
  memoryFreshnessRisk?: string;
  authority?: CoverageAuthority;
  dispatchExecuted?: boolean;
  spawnExecuted?: boolean;
  nativeTaskId?: string;
  nativeFlowId?: string;
  nativeFlowRevision?: number;
  nativeFlowExpectedRevision?: number;
  nativeFlowMutation?: string;
  nativeFlowMutationApplied?: boolean;
  nativeFlowMutationError?: string;
  childSessionKey?: string;
  childSessionId?: string;
  childRunId?: string;
  resultMaterialized?: boolean;
  deliveryStatus?: string;
  decisionSource?: WorkDecisionSource;
  ackMs?: number;
  routeDecisionMs?: number;
  taskMaterializeMs?: number;
  queueWaitMs?: number;
  firstProgressMs?: number;
  finalDeliveryMs?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  parentContextTokensAdded?: number;
  resultPacketTokens?: number;
  artifactReopenCount?: number;
}

// ── Work contract ──

export const WORK_CONTRACT_SCHEMA_VERSION = "octoclaw.work_contract.v1" as const;

export interface WorkContract {
  schemaVersion: typeof WORK_CONTRACT_SCHEMA_VERSION;
  workContractId: string;
  turnId: string;
  sessionKey: string;
  userAsk: string;
  intentClass: IntentClass;
  route: WorkRoute;
  status: WorkContractStatus;

  coverage: ContextCoverageSnapshot;
  decision: WorkDecisionSeal;
  reply?: ReplyContract;
  delegate?: DelegateContract;
  continuity: WorkContinuity;
  mainContext: MainContextPacket;
  telemetry: WorkContractTelemetry;

  createdAt: string;
  updatedAt: string;
}

// ── Work continuity ──

export interface WorkContinuity {
  threadBindingKey: string;
  parentSessionKey: string;
  preferredChildSessionKey?: string;
  preferredChildSessionId?: string;
  preferredRunId?: string;
  continuationMode: ContinuationPreferredMode;
  delegateTaskId?: string;
}

// ── Compact view for legacy embedding ──

export interface CompactWorkContractView {
  workContractId: string;
  turnId: string;
  route: WorkRoute;
  status: WorkContractStatus;
  intentClass: IntentClass;
  decisionSource: WorkDecisionSource;
  replyMode?: string;
  delegateRole?: string;
  delegateTaskId?: string;
  nativeFlowId?: string;
  childSessionKey?: string;
  nextAction?: string;
  allowedTools?: string[];
  forbiddenTools?: string[];
}

/**
 * Build a compact view of a WorkContract for embedding in legacy PolicyDecision.
 */
export function compactWorkContractView(contract: WorkContract): CompactWorkContractView {
  return {
    workContractId: contract.workContractId,
    turnId: contract.turnId,
    route: contract.route,
    status: contract.status,
    intentClass: contract.intentClass,
    decisionSource: contract.decision.source,
    replyMode: contract.reply?.replyMode,
    delegateRole: contract.delegate?.role,
    delegateTaskId: contract.delegate?.delegateTaskId,
    nativeFlowId: contract.delegate?.nativeBinding?.flowId,
    childSessionKey: contract.delegate?.nativeBinding?.childSessionKey,
    nextAction: contract.delegate?.nextAction ?? contract.mainContext.nextAction,
    allowedTools: contract.reply?.allowedTools,
    forbiddenTools: contract.reply?.forbiddenTools,
  };
}
