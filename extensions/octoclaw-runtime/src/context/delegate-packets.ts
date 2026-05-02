import type {
  ContextEscalationReason,
  DelegateArtifactRef,
  DelegateHandoffPacket,
  DelegateStatusPacket,
  WorkerResultPacket,
} from "@octoclaw/contracts/delegate-context";

export interface BuildDelegateHandoffPacketInput {
  delegateTaskId: string;
  attemptId: string;
  threadBindingKey: string;
  currentUserAsk: string;
  taskBrief: string;
  acceptanceCriteria?: string[];
  readScope?: string[];
  writeScope?: string[];
  workspaceMode?: DelegateHandoffPacket["workspaceMode"];
  role?: DelegateHandoffPacket["role"];
  modelProfile: string;
  maxInputTokens?: number;
  maxSummaryTokens?: number;
  threadSummary?: string;
  relevantExcerpts?: string[];
  artifactRefs?: DelegateArtifactRef[];
  forbiddenContent?: string[];
  contextEscalationReason?: ContextEscalationReason;
}

export interface BuildWorkerResultPacketInput {
  delegateTaskId: string;
  attemptId: string;
  status: WorkerResultPacket["status"];
  summary: string;
  keyFindings?: string[];
  changedFiles?: string[];
  testsRun?: string[];
  artifactRefs?: string[];
  blockers?: string[];
  confidence?: WorkerResultPacket["confidence"];
  metrics?: WorkerResultPacket["metrics"];
}

export interface BuildDelegateStatusPacketInput {
  threadBindingKey: string;
  delegateTaskId: string;
  nativeFlowId: string;
  nativeTaskId: string;
  status: DelegateStatusPacket["status"];
  attemptStatus?: string | null;
  role: string;
  modelProfile: string;
  createdAt?: string;
  lastEventAt?: string;
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
  retryable?: boolean;
  artifactRefs?: string[];
}

export interface MainResumePacket {
  schemaVersion: "octoclaw.main_resume.v1";
  statusPacket: DelegateStatusPacket;
  threadSummary?: string;
  artifactRefs: string[];
}

export function buildDelegateHandoffPacket(input: BuildDelegateHandoffPacketInput): DelegateHandoffPacket {
  const excerpts = input.relevantExcerpts?.filter((excerpt) => excerpt.trim().length > 0);
  if (excerpts && excerpts.length > 0 && !input.contextEscalationReason) {
    throw new Error("context_escalation_reason_required");
  }

  return {
    schemaVersion: "octoclaw.delegate_handoff.v1",
    delegateTaskId: input.delegateTaskId,
    attemptId: input.attemptId,
    threadBindingKey: input.threadBindingKey,
    currentUserAsk: input.currentUserAsk,
    taskBrief: input.taskBrief,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    readScope: input.readScope ?? [],
    writeScope: input.writeScope ?? [],
    workspaceMode: input.workspaceMode ?? "read_only",
    role: input.role ?? "default",
    modelProfile: input.modelProfile,
    contextBudget: {
      maxInputTokens: input.maxInputTokens ?? 1800,
      maxSummaryTokens: input.maxSummaryTokens ?? 250,
      allowRawTranscript: false,
    },
    threadSummary: input.threadSummary,
    relevantExcerpts: excerpts,
    contextEscalationReason: input.contextEscalationReason,
    artifactRefs: input.artifactRefs ?? [],
    forbiddenContent: [
      "full_transcript",
      "internal_route_rationale",
      "contamination_guard_text",
      "worker_chain_of_thought",
      ...(input.forbiddenContent ?? []),
    ],
  };
}

export function buildWorkerResultPacket(input: BuildWorkerResultPacketInput): WorkerResultPacket {
  return {
    schemaVersion: "octoclaw.worker_result.v1",
    delegateTaskId: input.delegateTaskId,
    attemptId: input.attemptId,
    status: input.status,
    summary: input.summary,
    keyFindings: input.keyFindings ?? [],
    changedFiles: input.changedFiles ?? [],
    testsRun: input.testsRun ?? [],
    artifactRefs: input.artifactRefs ?? [],
    blockers: input.blockers ?? [],
    confidence: input.confidence ?? "medium",
    metrics: input.metrics ?? {},
  };
}

export function buildDelegateStatusPacket(input: BuildDelegateStatusPacketInput): DelegateStatusPacket {
  const now = new Date().toISOString();

  return {
    schemaVersion: "octoclaw.delegate_status.v1",
    threadBindingKey: input.threadBindingKey,
    delegateTaskId: input.delegateTaskId,
    nativeFlowId: input.nativeFlowId,
    nativeTaskId: input.nativeTaskId,
    status: input.status,
    attemptStatus: input.attemptStatus ?? null,
    role: input.role,
    modelProfile: input.modelProfile,
    createdAt: input.createdAt ?? now,
    lastEventAt: input.lastEventAt ?? now,
    progressSummary: input.progressSummary ?? "",
    terminalSummary: input.terminalSummary ?? "",
    error: input.error ?? "",
    retryable: input.retryable ?? false,
    artifactRefs: input.artifactRefs ?? [],
  };
}

export function buildMainResumePacket(
  statusPacket: DelegateStatusPacket,
  options: { threadSummary?: string; artifactRefs?: string[] } = {},
): MainResumePacket {
  return {
    schemaVersion: "octoclaw.main_resume.v1",
    statusPacket,
    threadSummary: options.threadSummary,
    artifactRefs: options.artifactRefs ?? statusPacket.artifactRefs,
  };
}
