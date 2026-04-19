/**
 * judge_fast — LLM-based semantic routing judge
 *
 * Schema definitions for judge input/output. This file lives in @octoclaw/policy
 * so it can be imported by both the policy package and the runtime extension.
 */

/** Route values the judge is allowed to return. */
export type JudgeRoute = "reply" | "delegate.single" | "observe" | "undetermined";

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
  scope?: string;
  target?: string;
  budgetBand?: JudgeBudgetBand;
  reasonCodes?: string[];
  evidenceRequired?: boolean;
  ackRequired?: boolean;
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

/** Validate a parsed JudgeOutput. Returns true if hot-path fields are present and valid. */
export function isValidJudgeOutput(value: unknown): value is JudgeOutput {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!["reply", "delegate.single", "observe", "undetermined"].includes(obj.route as string)) return false;
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) return false;
  return true;
}

/** Check if a judge output should be used (not abstained, high enough confidence). */
export function isActionableJudgeResult(result: JudgeOutput | null, minConfidence: number): result is JudgeOutput {
  if (!result) return false;
  if (result.route === "undetermined") return false;
  if (result.confidence < minConfidence) return false;
  return true;
}
