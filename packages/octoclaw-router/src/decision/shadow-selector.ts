import type {
  ModelIntelLite,
  ModelIntelSnapshot,
  RouterLiteCodingTier,
  RouterLiteRecommendation,
  RouterLiteRequest,
  RouterLiteScoringMode,
  RouterLiteScenario,
  ScenarioAbilityLite,
} from "./contracts.js";

type ScoreWeights = {
  quality: number;
  cost: number;
  stability: number;
  speed: number;
};

type Rejection = RouterLiteRecommendation["rejectedModels"][number];

const SCORING_WEIGHTS: Record<RouterLiteScoringMode, ScoreWeights> = {
  cost_first: { quality: 20, cost: 45, stability: 25, speed: 10 },
  balanced: { quality: 35, cost: 25, stability: 25, speed: 15 },
  reliable_fast: { quality: 35, cost: 10, stability: 35, speed: 20 },
};

const TIER_RANK: Record<RouterLiteCodingTier, number> = {
  unknown: 0,
  mini: 1,
  standard: 2,
  strong: 3,
  frontier: 4,
};

const TIER_QUALITY_SCORE: Record<RouterLiteCodingTier, number> = {
  unknown: 10,
  mini: 20,
  standard: 40,
  strong: 70,
  frontier: 90,
};

const SCENARIO_TIER_RANK: Record<NonNullable<ScenarioAbilityLite["codingWorker"]["tier"]>, number> = {
  unknown: 0,
  C: 1,
  B: 2,
  A: 3,
  S: 4,
};

const SCENARIO_CONFIDENCE_RANK: Record<NonNullable<ScenarioAbilityLite["codingWorker"]["confidence"]>, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const SCENARIO_FLOOR_BY_QUALITY: Record<RouterLiteCodingTier, ScenarioAbilityLite["codingWorker"]["tier"]> = {
  unknown: "unknown",
  mini: "C",
  standard: "B",
  strong: "A",
  frontier: "S",
};

const QUALITY_FLOOR_BY_COMPLEXITY: Record<RouterLiteRequest["judge"]["complexity"], RouterLiteCodingTier> = {
  simple: "mini",
  normal: "standard",
  complex: "strong",
  deep: "frontier",
};

const OUTPUT_BUDGET_BY_COMPLEXITY: Record<RouterLiteRequest["judge"]["complexity"], RouterLiteRecommendation["outputBudget"]> = {
  simple: "short",
  normal: "medium",
  complex: "long",
  deep: "deep",
};

export function selectShadowRecommendation(
  request: RouterLiteRequest,
  snapshot: ModelIntelSnapshot,
  mode: RouterLiteScoringMode = "balanced",
): RouterLiteRecommendation {
  const qualityFloor = QUALITY_FLOOR_BY_COMPLEXITY[request.judge.complexity];
  const outputBudget = OUTPUT_BUDGET_BY_COMPLEXITY[request.judge.complexity];
  const rejectedModels: Rejection[] = [];
  const eligible = snapshot.models.filter((model) => {
    const rejectionReason = getHardGateRejectionReason(request, model, qualityFloor);

    if (rejectionReason !== undefined) {
      rejectedModels.push({ model: model.modelKey, reason: rejectionReason });
      return false;
    }

    return true;
  });

  const maxBlendedPrice = Math.max(
    0,
    ...eligible.flatMap((model) => {
      const price = model.marketPrice.blendedUsdPerMTok;
      return price === undefined ? [] : [price];
    }),
  );
  const maxP50 = Math.max(
    0,
    ...eligible.flatMap((model) => {
      const p50 = model.health.p50FirstTokenMs;
      return p50 === undefined ? [] : [p50];
    }),
  );

  const scoredModels = eligible
    .map((model) => ({
      model: model.modelKey,
      score: scoreModel(request, model, mode, maxBlendedPrice, maxP50),
    }))
    .sort((left, right) => right.score - left.score || left.model.localeCompare(right.model));

  const eligibleModels = scoredModels.map((entry) => entry.model);
  const recommendedModel = eligibleModels[0];
  const ignoredReason = getIgnoredReason(request, rejectedModels, eligibleModels.length);
  const reasonCodes = [
    eligibleModels.length > 0 ? "hard_gate_pass" : "hard_gate_rejected",
    mode,
    `quality_floor_${qualityFloor}`,
    ...(ignoredReason ? [`ignored_${ignoredReason}`] : []),
  ];

  return {
    recommendedModel: ignoredReason === undefined || ignoredReason === "explicit_override" ? recommendedModel : undefined,
    outputBudget,
    qualityFloor,
    eligibleModels,
    rejectedModels,
    reasonCodes,
    mode: "shadow",
    scoringMode: mode,
    scenario: getScenario(request),
    ignoredReason,
  };
}

function getHardGateRejectionReason(
  request: RouterLiteRequest,
  model: ModelIntelLite,
  qualityFloor: RouterLiteCodingTier,
): string | undefined {
  if (model.configured !== true) {
    return "not_configured";
  }

  if (model.available !== "yes") {
    return "not_available";
  }

  if (model.health.cooldown === true) {
    return "cooldown_active";
  }

  if (model.health.quotaPressure === "high") {
    return "quota_pressure_high";
  }

  if (model.marketPrice.conflict === true) {
    return "price_conflict";
  }

  if (model.marketPrice.confidence === "unknown" || model.marketPrice.sources.length === 0) {
    return "cost_evidence_missing";
  }

  if (model.capability.confidence === "unknown" || model.capability.evidence.length === 0 || model.capability.sources.length === 0) {
    return "capability_evidence_missing";
  }

  if (isStaleFreshness(model.freshness)) {
    return "stale_evidence";
  }

  if (request.runtime.needsTools === true && model.capability.toolUse !== "yes") {
    return "tool_support_insufficient";
  }

  if (request.runtime.needsReasoning === true && model.capability.reasoning !== "yes") {
    return "reasoning_support_insufficient";
  }

  if (request.runtime.needsStructuredOutput === true && model.capability.structuredOutput !== "yes") {
    return "structured_output_insufficient";
  }

  if (
    request.runtime.minContextTokens !== undefined &&
    model.capability.contextWindow !== undefined &&
    model.capability.contextWindow < request.runtime.minContextTokens
  ) {
    return "context_window_too_small";
  }

  if (
    request.runtime.contextTokens !== undefined &&
    model.capability.contextWindow !== undefined &&
    model.capability.contextWindow < request.runtime.contextTokens
  ) {
    return "context_insufficient_for_prompt";
  }

  if (TIER_RANK[model.capability.codingTier] < TIER_RANK[qualityFloor]) {
    return "quality_floor_not_met";
  }

  const scenario = getScenario(request);
  const scenarioRejection = getScenarioRejectionReason(model.scenarioAbility, scenario, qualityFloor);
  if (scenarioRejection) {
    return scenarioRejection;
  }

  return undefined;
}

function getScenarioRejectionReason(
  scenarioAbility: ScenarioAbilityLite | undefined,
  scenario: RouterLiteScenario | undefined,
  qualityFloor: RouterLiteCodingTier,
): string | undefined {
  if (!scenario) return undefined;
  const score = scenarioAbility?.[scenario];
  if (!score || score.tier === "unknown" || score.confidence === "unknown") {
    return "scenario_ability_missing";
  }
  if (score.sources.length === 0 || SCENARIO_CONFIDENCE_RANK[score.confidence] < SCENARIO_CONFIDENCE_RANK.medium) {
    return "scenario_evidence_insufficient";
  }
  const floor = SCENARIO_FLOOR_BY_QUALITY[qualityFloor];
  if (SCENARIO_TIER_RANK[score.tier] < SCENARIO_TIER_RANK[floor]) {
    return "scenario_ability_below_floor";
  }
  return undefined;
}

function scoreModel(
  request: RouterLiteRequest,
  model: ModelIntelLite,
  mode: RouterLiteScoringMode,
  maxBlendedPrice: number,
  maxP50: number,
): number {
  const weights = SCORING_WEIGHTS[mode];
  const quality = getQualityScore(request, model);
  const cost = getCostScore(model, maxBlendedPrice);
  const stability = getStabilityScore(model);
  const speed = getSpeedScore(model, maxP50);

  return (
    quality * weights.quality +
    cost * weights.cost +
    stability * weights.stability +
    speed * weights.speed
  ) / 100;
}

function getQualityScore(request: RouterLiteRequest, model: ModelIntelLite): number {
  const tierScore = TIER_QUALITY_SCORE[model.capability.codingTier];
  const scenario = getScenario(request);
  const scenarioScore = scenario === undefined ? undefined : getScenarioAbilityScore(model.scenarioAbility, scenario);
  const evidencePenalty = getEvidencePenalty(model);

  return Math.min(100, tierScore + (scenarioScore ?? 0)) * evidencePenalty;
}

function getEvidencePenalty(model: ModelIntelLite): number {
  let penalty = 1;

  if (isStaleFreshness(model.freshness)) {
    penalty *= 0.7;
  }

  if (model.capability.evidence.length > 0 && model.capability.evidence.every((evidence) => evidence === "heuristic")) {
    penalty *= 0.8;
  }

  return penalty;
}

function isStaleFreshness(freshness: string | undefined): boolean {
  if (freshness === undefined) {
    return false;
  }

  const fetchedAt = Date.parse(freshness);
  if (Number.isNaN(fetchedAt)) {
    return false;
  }

  return Date.now() - fetchedAt > 7 * 24 * 60 * 60 * 1000;
}

function getScenarioAbilityScore(
  scenarioAbility: ScenarioAbilityLite | undefined,
  scenario: keyof ScenarioAbilityLite,
): number | undefined {
  return scenarioAbility?.[scenario].score;
}

function getCostScore(model: ModelIntelLite, maxBlendedPrice: number): number {
  const blendedPrice = model.marketPrice.blendedUsdPerMTok;
  if (blendedPrice === undefined || maxBlendedPrice <= 0) {
    return 0;
  }

  const baseScore = clampScore(100 * (1 - blendedPrice / maxBlendedPrice));
  const planBonus = model.plan.quotaPressure === "low" && model.plan.effectiveCostBand === "free_or_sunk" ? 20 : 0;

  return clampScore(baseScore + planBonus);
}

function getSpeedScore(model: ModelIntelLite, maxP50: number): number {
  const p50 = model.health.p50FirstTokenMs;
  if (p50 === undefined || maxP50 <= 0) {
    return 50;
  }

  return clampScore(100 * (1 - p50 / maxP50));
}

function getStabilityScore(model: ModelIntelLite): number {
  const recentFailureRate = model.health.recentFailureRate;
  if (recentFailureRate === undefined) {
    return 50;
  }

  return clampScore(100 * (1 - recentFailureRate));
}

function getIgnoredReason(
  request: RouterLiteRequest,
  rejectedModels: Rejection[],
  eligibleModelCount: number,
): RouterLiteRecommendation["ignoredReason"] {
  if (request.runtime.statusOrProvenanceRequest === true) {
    return "status_or_provenance_request";
  }

  if (request.runtime.explicitOverride !== undefined) {
    return "explicit_override";
  }

  if (request.liveRoute === "reply" && request.judge.route !== "delegate") {
    return "live_route_not_supported";
  }

  if (request.judge.confidence < 0.65) {
    return "low_confidence";
  }

  if (eligibleModelCount === 0) {
    if (rejectedModels.length > 0 && rejectedModels.every((entry) => entry.reason === "not_configured")) {
      return "not_configured";
    }
    if (rejectedModels.some((entry) => entry.reason === "stale_evidence")) {
      return "stale_evidence";
    }
    return "no_eligible_model";
  }

  return undefined;
}

function getScenario(request: RouterLiteRequest): RouterLiteScenario | undefined {
  if (request.runtime.scenario) {
    return request.runtime.scenario;
  }

  if (request.judge.route === "delegate") {
    return "defaultDelegate";
  }

  return undefined;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}
