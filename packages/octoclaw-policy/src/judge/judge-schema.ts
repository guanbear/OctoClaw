/**
 * judge_fast — LLM-based semantic routing judge
 *
 * Schema definitions for judge input/output. This file lives in @octoclaw/policy
 * so it can be imported by both the policy package and the runtime extension.
 */

/** Route values the judge is allowed to return. */
export type JudgeRoute = "reply" | "delegate";

/** Reply-mode hint for direct responses. */
export type ReplyMode = "answer" | "clarify";

/** Delegate role contract from the canonical policy spec. */
export type DelegateRole = "observer" | "default" | "code" | "research" | "review";

/** Coordination mode hint from the canonical policy spec. */
export type CoordinationModeHint = "solo_worker" | "advisor_assisted" | "multi_agent_controlled";

/** Scope hint from the canonical policy spec. */
export type JudgeScope = "local" | "remote" | "both" | "unknown";

/** Tool-need hint from the canonical policy spec. */
export type ToolNeedHint = "none" | "maybe" | "required";

/** Duration hint from the canonical policy spec. */
export type DurationHint = "short" | "medium" | "long";

/** Budget band hint for downstream model-profile selection. */
export type JudgeBudgetBand = "low" | "medium" | "high";

/** Spawn complexity band for downstream model-profile selection. */
export type SpawnComplexityBand = "simple" | "normal" | "deep";

/** Delegate reason codes — structured reasons why judge recommends delegation. */
export type DelegateReasonCode =
  | "context_hygiene"
  | "fast_first_response"
  | "background_execution"
  | "cost_tiering"
  | "specialized_tools"
  | "quality_isolation";

// ─── Judge Context Packet (4-layer, per design §9.3) ───

/** Layer A: Core turn — every judge call must have this. */
export interface JudgeCoreTurnLayer {
  /** Current user input (the only raw natural language the judge sees) */
  current_turn: string;
  /** Message origin, channel, timestamps, edit/resend flags */
  turn_metadata?: {
    channel?: string;
    edited?: boolean;
    timestamp?: string;
  };
  /** Compressed summary of the thread so far */
  thread_summary?: string;
}

/** Layer B: Continuation state — reduces misclassification of ongoing work. */
export interface JudgeContinuationStateLayer {
  /** Current thread's active intent (e.g. "write_script", "debug_issue") */
  active_intent?: string;
  /** Status of the active intent */
  intent_status?: "collecting_info" | "executing" | "waiting_input" | "delivering" | "idle";
  /** What the system explicitly did last */
  last_agent_act?: string;
  /** Slots still needed (e.g. ["language", "task", "environment"]) */
  pending_slots?: string[];
  /** Last question the agent explicitly asked the user */
  open_question?: string;
}

/** Layer C: Binding/control — prevents re-classifying bound messages as new tasks. */
export interface JudgeBindingControlLayer {
  /** Whether this message is bound to an existing task/thread/anchor */
  anchor_or_task_binding?: string | null;
  /** Surface context (e.g. "chat", "details", "queue", "task_reply") */
  surface_context?: string;
  /** Lifecycle flags (e.g. "waiting_input", "recovery", "approval_pending") */
  lifecycle_flags?: string[];
}

/** Layer D: Minimal evidence — only when summary+state are insufficient. */
export interface JudgeMinimalEvidenceLayer {
  /** Last 1-3 most relevant raw turns (not full transcript) */
  recent_excerpt?: string[];
  /** Short references to artifacts/task results the current turn mentions */
  artifact_refs?: string[];
}

/**
 * Full judge context packet — structured input for the LLM judge.
 *
 * Construction principles (design §9.3):
 * 1. summary_first — prefer thread_summary / continuation_state over raw text
 * 2. state_over_prose — use structured fields, not prose for judge to guess
 * 3. excerpt_last — only add excerpts when summary+state are insufficient
 * 4. bounded_size — token/field budget; compress before truncating
 */
export interface JudgeContextPacket {
  core: JudgeCoreTurnLayer;
  continuation?: JudgeContinuationStateLayer;
  binding?: JudgeBindingControlLayer;
  evidence?: JudgeMinimalEvidenceLayer;
}

/** Escalation reason codes for invoking remote adjudication. */
export type EscalationReason =
  | "low_confidence"
  | "short_turn_context_dependent"
  | "multiple_active_intents"
  | "scope_unknown"
  | "high_risk_write"
  | "unstable_classification"
  | "validator_conflict"
  | "main_agent_judge_disagreement";

/** Minimal config the runtime extension reads from pluginConfig. */
export interface JudgeFastConfig {
  enabled: boolean;
  shadowMode: boolean;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  timeoutLocalMs: number;
  minConfidence: number;
  local: boolean;
  judgeAckEnabled?: boolean;
}

/** Input to the LLM judge. */
export interface JudgeInput {
  userMessage: string;
  sessionBinding?: string;
  recentLedgerSummary?: string;
  availableTargets: string[];
  availableActions: string[];
  /** Structured context packet (design §9.3). When present, judge uses this as primary routing input. */
  contextPacket?: JudgeContextPacket;
}

/**
 * Output from the LLM judge.
 *
 * Hot-path consumers only read `route`, `confidence`, `abstainReason`.
 * All other fields are written to replay log for offline analysis.
 */
export interface JudgeOutput {
  route: JudgeRoute;
  confidence: number;
  abstainReason: string | null;
  ackText: string | null;

  // Canonical policy-spec fields
  reply_mode?: ReplyMode | null;
  delegate_role?: DelegateRole | null;
  coordination_mode_hint?: CoordinationModeHint | null;
  tool_need_hint?: ToolNeedHint;
  duration_hint?: DurationHint;
  replyMode?: ReplyMode | null;
  delegateRole?: DelegateRole | null;
  coordinationModeHint?: CoordinationModeHint | null;
  complexity?: SpawnComplexityBand | null;
  scope?: JudgeScope;
  toolNeedHint?: ToolNeedHint | null;
  durationHint?: DurationHint | null;
  reasonCodes?: string[];

  // Design §9.3 extended fields
  role?: "main_reply" | "observer_probe" | "worker_research" | "worker_code" | "worker_review";
  complexityBand?: SpawnComplexityBand;
  expectedDurationBand?: "instant" | "short" | "medium" | "long";
  qualityBar?: "standard" | "high" | "critical";
  riskFlags?: string[];
  delegateReasonCodes?: DelegateReasonCode[];
  routeConfidence?: number;

  // Legacy replay fields
  requestKind?: string;
  target?: string;
  budgetBand?: JudgeBudgetBand;
  evidenceRequired?: boolean;
  ackRequired?: boolean;
}

/** Remote judge expanded context — includes local judge candidate for adjudication. */
export interface RemoteJudgeExpandedPacket {
  /** The small packet that was already sent to local judge */
  basePacket: JudgeContextPacket;
  /** The local judge's candidate decision */
  candidate_decision_from_local: {
    route: JudgeRoute;
    reply_mode?: ReplyMode | null;
    delegate_role?: DelegateRole | null;
    coordination_mode_hint?: CoordinationModeHint | null;
    confidence: number;
    complexity?: SpawnComplexityBand | null;
    scope?: JudgeScope | null;
    tool_need_hint?: ToolNeedHint | null;
    duration_hint?: DurationHint | null;
    role?: string;
    complexityBand?: SpawnComplexityBand;
    riskFlags?: string[];
    delegateReasonCodes?: DelegateReasonCode[];
  };
  /** Why we escalated to remote judge */
  escalation_reason: EscalationReason | string;
  /** Optional task snapshot for context */
  optional_task_snapshot?: Record<string, unknown>;
  /** Optional system state summary */
  optional_system_state_summary?: Record<string, unknown>;
}

/** Remote judge output — extends local judge with adjudication fields. */
export interface RemoteJudgeOutput extends JudgeOutput {
  adjudication_reason?: string;
  override_recommendation?: "accept_local" | "override_local";
  confidence_delta?: number;
}

/** Dual judge config — replaces single JudgeFastConfig for dual mode. */
export interface DualJudgeConfig {
  local: JudgeFastConfig;
  remote: {
    enabled: boolean;
    modelId: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    shadowMode: boolean;
  };
  escalation: {
    minConfidence: number;
    alwaysEscalateRiskFlags: string[];
    maxLatencyMs: number;
  };
}

/** Size caps to prevent prompt inflation / injection amplification. */
export const JUDGE_INPUT_CAPS = {
  userMessage: 500,
  recentLedgerSummary: 200,
} as const;

/** Default config values. */
export const JUDGE_FAST_DEFAULTS: Omit<JudgeFastConfig, "modelId" | "baseUrl" | "apiKey"> = {
  enabled: true,
  shadowMode: false,
  timeoutMs: 1500,
  timeoutLocalMs: 800,
  minConfidence: 0.6,
  local: false,
};

export const REMOTE_JUDGE_DEFAULTS = {
  enabled: false,
  timeoutMs: 8000,
  shadowMode: true,
  modelId: "omniroute/cx/gpt-5.4-mini",
} as const;

export const ESCALATION_DEFAULTS = {
  minConfidence: 0.6,
  alwaysEscalateRiskFlags: ["high_risk_write", "destructive_operation"],
  maxLatencyMs: 4000,
} as const;

/** Validate a parsed JudgeOutput. Returns true if hot-path fields are present and valid. */
export function isValidJudgeOutput(value: unknown): value is JudgeOutput {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!["reply", "delegate"].includes(obj.route as string)) return false;
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) return false;
  return true;
}

/** Validate remote judge output. */
export function isRemoteJudgeOutput(value: unknown): value is RemoteJudgeOutput {
  if (!isValidJudgeOutput(value)) return false;
  const obj = value as unknown as Record<string, unknown>;
  if (obj.override_recommendation !== undefined) {
    if (obj.override_recommendation !== "accept_local" && obj.override_recommendation !== "override_local") return false;
  }
  if (obj.confidence_delta !== undefined && typeof obj.confidence_delta !== "number") return false;
  if (obj.adjudication_reason !== undefined && typeof obj.adjudication_reason !== "string") return false;
  return true;
}

/** Check if a judge output should be used (not abstained, high enough confidence). */
export function isActionableJudgeResult(result: JudgeOutput | null, minConfidence: number): result is JudgeOutput {
  if (!result) return false;
  if (result.confidence < minConfidence) return false;
  return true;
}
