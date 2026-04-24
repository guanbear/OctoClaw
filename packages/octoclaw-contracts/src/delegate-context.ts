export type DelegateArtifactKind =
  | "worker_report"
  | "worker_log_excerpt"
  | "context_pack"
  | "diff_or_patch"
  | "verification_evidence"
  | "operator_surface";

export interface DelegateArtifactRef {
  artifactId: string;
  artifactKind: DelegateArtifactKind;
  uri?: string;
  title?: string;
  summary?: string;
  tokenEstimate?: number;
  createdAt: string;
}

export interface DelegateHandoffPacket {
  schemaVersion: "octoclaw.delegate_handoff.v1";
  delegateTaskId: string;
  attemptId: string;
  threadBindingKey: string;
  currentUserAsk: string;
  taskBrief: string;
  acceptanceCriteria: string[];
  readScope: string[];
  writeScope: string[];
  workspaceMode: "read_only" | "write_allowed";
  role: "observer" | "default" | "code" | "research" | "review";
  modelProfile: string;
  contextBudget: {
    maxInputTokens: number;
    maxSummaryTokens: number;
    allowRawTranscript: false;
  };
  threadSummary?: string;
  relevantExcerpts?: string[];
  artifactRefs: DelegateArtifactRef[];
  forbiddenContent: string[];
}

export interface WorkerResultPacket {
  schemaVersion: "octoclaw.worker_result.v1";
  delegateTaskId: string;
  attemptId: string;
  status: "completed" | "failed" | "blocked" | "timed_out" | "cancelled";
  summary: string;
  keyFindings: string[];
  changedFiles: string[];
  testsRun: string[];
  artifactRefs: string[];
  blockers: string[];
  confidence: "low" | "medium" | "high";
  metrics: {
    childInputTokens?: number;
    childOutputTokens?: number;
    resultPacketTokens?: number;
    artifactBytes?: number;
  };
}

export interface DelegateStatusPacket {
  schemaVersion: "octoclaw.delegate_status.v1";
  threadBindingKey: string;
  delegateTaskId: string;
  nativeFlowId: string;
  nativeTaskId: string;
  status: "planned" | "queued" | "running" | "completed" | "failed" | "timed_out" | "blocked" | "cancelled";
  attemptStatus: string | null;
  role: string;
  modelProfile: string;
  createdAt: string;
  lastEventAt: string;
  progressSummary: string;
  terminalSummary: string;
  error: string;
  retryable: boolean;
  artifactRefs: string[];
}

export interface ContextBudgetReport {
  parentContextTokensAdded: number;
  childInputTokens: number;
  childOutputTokens: number;
  injectedResultTokens: number;
  artifactBytes: number;
  artifactReopenCount: number;
  directWouldHaveEstimatedTokens?: number;
  delegationCostBand: "lower" | "similar" | "higher" | "unknown";
}

export type ContextEscalationReason =
  | "summary_insufficient"
  | "artifact_ref_insufficient"
  | "user_asked_for_exact_prior_wording"
  | "debugging_context_pack";
