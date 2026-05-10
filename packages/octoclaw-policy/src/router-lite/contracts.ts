export type RouterLiteRoute = "reply" | "delegate";
export type RouterLiteConfidence = "high" | "medium" | "low" | "unknown";
export type RouterLiteTriState = "yes" | "no" | "unknown";
export type RouterLiteCodingTier = "mini" | "standard" | "strong" | "frontier" | "unknown";
export type RouterLiteQuotaPressure = "low" | "medium" | "high" | "unknown";
export type RouterLiteEffectiveCostBand = "free_or_sunk" | "cheap" | "normal" | "expensive" | "unknown";
export type RouterLitePlanType = "pay_as_you_go" | "subscription" | "free_quota" | "unknown";
export type RouterLiteCapabilityEvidence = "declared" | "probed" | "observed" | "operator_override" | "heuristic";

export interface RouterLitePrice {
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
  cacheReadUsdPerMTok?: number;
  cacheWriteUsdPerMTok?: number;
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
}

export interface RouterLiteHealth {
  available: RouterLiteTriState;
  cooldown: boolean;
  quotaPressure: RouterLiteQuotaPressure;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  recentFailureRate?: number;
  toolCallFailureRate?: number;
  timeoutRate?: number;
  sources: string[];
}

export interface RouterLitePlan {
  type: RouterLitePlanType;
  quotaPressure: RouterLiteQuotaPressure;
  effectiveCostBand: RouterLiteEffectiveCostBand;
  resetAt?: string;
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
  sources: string[];
}

export interface ModelIntelSnapshot {
  schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1";
  snapshotId: string;
  generatedAt: string;
  sourceStatus: Array<{ source: string; status: "ok" | "missing" | "error"; detail?: string }>;
  models: ModelIntelLite[];
}

export interface ModelConfigProposalItem {
  id: string;
  provider: string;
  candidateModel?: string;
  priority: "low" | "medium" | "high";
  action: "add_configured_model" | "refresh_catalog" | "add_plan_override" | "add_capability_probe";
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
    complexityConfidence: number;
  };
  runtime: {
    channel?: "slack" | "feishu" | "wechat" | "cli" | "unknown";
    contextTokens?: number;
    needsTools?: boolean;
    needsReasoning?: boolean;
    minContextTokens?: number;
    statusOrProvenanceRequest?: boolean;
    sessionControlRequest?: boolean;
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
  ignoredReason?: "low_confidence" | "no_eligible_model" | "live_route_not_supported" | "not_configured";
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
}
