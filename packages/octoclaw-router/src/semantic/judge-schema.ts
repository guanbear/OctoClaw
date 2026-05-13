export type JudgeRoute = "reply" | "delegate";
export type JudgeComplexity = "simple" | "normal" | "complex" | "deep";

export type ReplyMode = "answer" | "clarify";
export type DelegateRole = "observer" | "default" | "code" | "research" | "review";
export type CoordinationModeHint = "solo_worker" | "advisor_assisted" | "multi_agent_controlled";
export type JudgeScope = "local" | "remote" | "both" | "unknown";
export type ToolNeedHint = "none" | "maybe" | "required";
export type DurationHint = "short" | "medium" | "long";
export type DecisionBucket = "must_reply" | "must_delegate" | "budgeted_main_then_delegate";
export type JudgeBudgetBand = "low" | "medium" | "high";
export type SpawnComplexityBand = JudgeComplexity;
export type DelegateReasonCode =
  | "context_hygiene"
  | "background_execution"
  | "parallelism"
  | "cost_tiering"
  | "specialized_tools"
  | "quality_isolation";

export interface JudgeCoreTurnLayer {
  current_turn: string;
  turn_metadata?: { channel?: string; edited?: boolean; timestamp?: string };
  thread_summary?: string;
}

export interface JudgeContinuationStateLayer {
  active_intent?: string;
  intent_status?: "collecting_info" | "executing" | "waiting_input" | "delivering" | "idle";
  last_agent_act?: string;
  pending_slots?: string[];
  open_question?: string;
}

export interface JudgeBindingControlLayer {
  anchor_or_task_binding?: string | null;
  surface_context?: string;
  lifecycle_flags?: string[];
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

export interface JudgeExecutionLayer {
  coverage?: "none" | "current_turn" | "recent_turn" | "thread";
  freshness?: "current" | "recent" | "stale";
  supports_provenance_reply?: boolean;
  supports_status_reply?: boolean;
  requires_control_plane_refresh?: boolean;
  last_route?: "reply" | "delegate" | "unknown";
  last_reply_mode?: ReplyMode | null;
  last_delegate_role?: DelegateRole | null;
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

export interface JudgeMinimalEvidenceLayer {
  recent_excerpt?: string[];
  artifact_refs?: string[];
}

export interface JudgeContextPacket {
  core: JudgeCoreTurnLayer;
  continuation?: JudgeContinuationStateLayer;
  binding?: JudgeBindingControlLayer;
  memory?: JudgeMemoryLayer;
  execution?: JudgeExecutionLayer;
  evidence?: JudgeMinimalEvidenceLayer;
}

export interface JudgeRuntimeSignals {
  statusOrProvenanceRequest?: boolean;
  sessionControlRequest?: boolean;
  explicitDelegate?: boolean;
}

export interface JudgeRecentExecution {
  taskId: string;
  status: string;
}

export interface JudgeInput {
  prompt?: string;
  userMessage?: string;
  sessionKey?: string;
  sessionBinding?: string;
  recentExecution?: JudgeRecentExecution | null;
  snapshotId?: string;
  runtimeSignals?: JudgeRuntimeSignals;
  recentLedgerSummary?: string;
  availableTargets?: string[];
  availableActions?: string[];
  contextPacket?: JudgeContextPacket;
}

export interface JudgeOutput {
  route: JudgeRoute;
  confidence: number;
  complexity: JudgeComplexity;
}

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
  cacheEnabled?: boolean;
}

export const JUDGE_INPUT_CAPS = {
  userMessage: 500,
  recentLedgerSummary: 200,
} as const;

export const JUDGE_FAST_DEFAULTS: Omit<JudgeFastConfig, "modelId" | "baseUrl" | "apiKey"> = {
  enabled: true,
  shadowMode: false,
  timeoutMs: 2000,
  timeoutLocalMs: 2000,
  minConfidence: 0.65,
  local: false,
  cacheEnabled: true,
};

export interface JudgeValidationResult {
  valid: boolean;
  degraded: boolean;
  degradedReasons: string[];
}

const VALID_ROUTES = new Set<JudgeRoute>(["reply", "delegate"]);
const VALID_COMPLEXITIES = new Set<JudgeComplexity>(["simple", "normal", "complex", "deep"]);
const VALID_KEYS = new Set(["route", "confidence", "complexity"]);

export function validateJudgeOutputDetailed(value: unknown): JudgeValidationResult {
  if (!isValidJudgeOutput(value)) {
    return { valid: false, degraded: false, degradedReasons: [] };
  }
  return { valid: true, degraded: false, degradedReasons: [] };
}

export function isValidJudgeOutput(value: unknown): value is JudgeOutput {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 3) return false;
  for (const key of keys) {
    if (!VALID_KEYS.has(key)) return false;
  }
  if (typeof obj.route !== "string" || !VALID_ROUTES.has(obj.route as JudgeRoute)) return false;
  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) return false;
  if (obj.confidence < 0 || obj.confidence > 1) return false;
  if (typeof obj.complexity !== "string" || !VALID_COMPLEXITIES.has(obj.complexity as JudgeComplexity)) return false;
  return true;
}

export function isActionableJudgeResult(result: JudgeOutput | null, minConfidence: number): result is JudgeOutput {
  return Boolean(result && result.confidence >= minConfidence);
}
