export type RouterLiteRoute = "reply" | "delegate";
export type RouterLiteConfidence = "high" | "medium" | "low" | "unknown";
export type RouterLiteTriState = "yes" | "no" | "unknown";
export type RouterLiteCodingTier = "mini" | "standard" | "strong" | "frontier" | "unknown";
export type RouterLiteQuotaPressure = "low" | "medium" | "high" | "unknown";
export type RouterLiteEffectiveCostBand = "free_or_sunk" | "cheap" | "normal" | "expensive" | "unknown";
export type RouterLitePlanType = "pay_as_you_go" | "subscription" | "free_quota" | "unknown";
export type RouterLiteCapabilityEvidence = "declared" | "probed" | "observed" | "operator_override" | "heuristic";
export type RouterLiteScenario =
  | "codingWorker"
  | "agenticToolTask"
  | "researchLookup"
  | "dataLogAnalysis"
  | "mainReasoning"
  | "defaultDelegate";

export type ScenarioAbilitySource =
  | "pinchbench" | "aider" | "swe_bench" | "bfcl"
  | "artificial_analysis" | "local_replay" | "operator_override";

export type RouterLiteScoringMode = "cost_first" | "balanced" | "reliable_fast";

export interface ScenarioAbilityScore {
  score?: number;
  tier: "S" | "A" | "B" | "C" | "unknown";
  confidence: "high" | "medium" | "low" | "unknown";
  sources: Array<{
    source: ScenarioAbilitySource;
    score?: number;
    version?: string;
    sampleCount?: number;
    fetchedAt: string;
  }>;
}

export interface ScenarioAbilityLite {
  codingWorker: ScenarioAbilityScore;
  agenticToolTask: ScenarioAbilityScore;
  researchLookup: ScenarioAbilityScore;
  dataLogAnalysis: ScenarioAbilityScore;
  mainReasoning: ScenarioAbilityScore;
  defaultDelegate: ScenarioAbilityScore;
}

export interface RouterLitePrice {
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
  cacheReadUsdPerMTok?: number;
  cacheWriteUsdPerMTok?: number;
  blendedUsdPerMTok?: number;
  ratioBaselineModel?: string;
  ratioToBaseline?: number;
  conflict?: boolean;
  confidence: RouterLiteConfidence;
  sources: string[];
  missingCostReason?: string;
}

export interface RouterLiteCapability {
  contextWindow?: number;
  input: Array<"text" | "image" | "audio" | "video">;
  toolUse: RouterLiteTriState;
  structuredOutput: RouterLiteTriState;
  reasoning: RouterLiteTriState;
  promptCache: RouterLiteTriState;
  codingTier: RouterLiteCodingTier;
  confidence: RouterLiteConfidence;
  evidence: RouterLiteCapabilityEvidence[];
  sources: string[];
  scoreByScenario?: RouterLiteScoreByScenario;
  capabilityScore?: RouterLiteFusedScore;
}

export interface RouterLiteScoredSourceContribution {
  source: string;
  rawScore: number;
  baseWeight: number;
  freshnessFactor: number;
  sourceHealth: number;
  effectiveWeight: number;
}

export interface RouterLiteFusedScore {
  score: number;
  confidence: RouterLiteConfidence;
  contributions: RouterLiteScoredSourceContribution[];
  reasonCodes: string[];
}

export interface RouterLiteScoreByScenario {
  coding_worker?: RouterLiteFusedScore;
  research?: RouterLiteFusedScore;
  agentic?: RouterLiteFusedScore;
}

export interface RouterLiteHealth {
  available: RouterLiteTriState;
  cooldown: boolean;
  cooldownUntil?: number;
  cooldownReason?: string;
  quotaPressure: RouterLiteQuotaPressure;
  p50FirstTokenMs?: number;
  p95FirstTokenMs?: number;
  p50OutputTokensPerSecond?: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  baselineP95LatencyMs?: number;
  baselineP95WindowCount?: number;
  recentFailureRate?: number;
  toolCallFailureRate?: number;
  timeoutRate?: number;
  lastSuccessfulCallAt?: string;
  lastFailedCallAt?: string;
  lastErrorCodes?: Array<{ code: string; count: number }>;
  sources: string[];
}

export interface RouterLitePlan {
  type: RouterLitePlanType;
  quotaPressure: RouterLiteQuotaPressure;
  effectiveCostBand: RouterLiteEffectiveCostBand;
  resetAt?: string;
  sources: string[];
}

export interface RouterLiteBenchmarkEfficiency {
  taskCostScore?: number;
  taskSpeedScore?: number;
  valueScore: number;
  sources: string[];
}

export interface ModelIntelLite {
  provider: string;
  model: string;
  modelKey: string;
  name?: string;
  configured: boolean;
  available: RouterLiteTriState;
  proposalOnly: boolean;
  tags: string[];
  marketPrice: RouterLitePrice;
  capability: RouterLiteCapability;
  health: RouterLiteHealth;
  plan: RouterLitePlan;
  benchmarkEfficiency?: RouterLiteBenchmarkEfficiency;
  scenarioAbility?: ScenarioAbilityLite;
  freshness?: string;
  sources: string[];
}

export interface ModelIntelSnapshot {
  schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1";
  snapshotId: string;
  generatedAt: string;
  nativeFallbackOrder?: string[];
  sourceStatus: Array<{ source: string; status: "ok" | "missing" | "error"; detail?: string }>;
  models: ModelIntelLite[];
}

export interface ModelConfigProposalItem {
  id: string;
  provider: string;
  candidateModel?: string;
  priority: "low" | "medium" | "high";
  action: "add_configured_model" | "refresh_catalog" | "add_plan_override" | "add_compatibility_probe";
  reason: string;
  expectedUse: string;
  risk: string;
  requiredAuth: string;
  whyNotLive: string;
  sources: string[];
}

export interface ModelConfigProposal {
  schemaVersion: "octoclaw.router_lite.model_config_proposal/v1";
  generatedAt: string;
  snapshotId: string;
  proposals: ModelConfigProposalItem[];
  summary: {
    configuredModels: number;
    proposalOnlyModels: number;
    providers: number;
  };
}

export interface RouterLiteRequest {
  sessionKey: string;
  turnId: string;
  liveRoute: RouterLiteRoute;
  liveModel?: string;
  judge: {
    route: RouterLiteRoute;
    confidence: number;
    complexity: "simple" | "normal" | "complex" | "deep";
  };
  runtime: {
    channel?: "slack" | "feishu" | "wechat" | "cli" | "unknown";
    contextTokens?: number;
    needsTools?: boolean;
    needsReasoning?: boolean;
    needsStructuredOutput?: boolean;
    minContextTokens?: number;
    statusOrProvenanceRequest?: boolean;
    sessionControlRequest?: boolean;
    explicitOverride?: string;
    scenario?: RouterLiteScenario;
  };
  snapshotId: string;
}

export interface RouterLiteRecommendation {
  recommendedModel?: string;
  outputBudget: "short" | "medium" | "long" | "deep";
  qualityFloor: RouterLiteCodingTier;
  eligibleModels: string[];
  rejectedModels: Array<{ model: string; reason: string }>;
  reasonCodes: string[];
  mode: "shadow" | "live";
  scoringMode?: RouterLiteScoringMode;
  scenario?: RouterLiteScenario;
  ignoredReason?:
    | "low_confidence"
    | "no_eligible_model"
    | "live_route_not_supported"
    | "not_configured"
    | "status_or_provenance_request"
    | "stale_evidence"
    | "explicit_override"
    | "no_capability_data"
    | "all_unconfigured"
    | "all_cooldown"
    | "no_quality_floor_match"
    | "all_banned"
    | "budget_exceeded_no_plan";
}

export interface RouterLiteShadowEvent {
  event: "router_lite_recommendation";
  turnId: string;
  snapshotId: string;
  liveRoute: RouterLiteRoute;
  actualModel?: string;
  recommendation: RouterLiteRecommendation;
  estimatedCostDeltaUsd?: number;
  qualityGate: "unknown" | "pass" | "fail";
  judge?: {
    route: RouterLiteRoute;
    confidence: number;
    complexity: "simple" | "normal" | "complex" | "deep";
  };
  scenario?: RouterLiteScenario;
}
