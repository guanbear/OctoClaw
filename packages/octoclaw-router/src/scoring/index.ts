import type {
  ModelIntelLite,
  RouterLiteRecommendation,
  RouterLiteRequest,
} from "../decision/contracts.js";
import { getPromotionState } from "../promotion/index.js";
import type { PromotionStateMap } from "../promotion/index.js";
import type { BudgetStatus } from "../cost/index.js";

export type Complexity = RouterLiteRequest["judge"]["complexity"];

export interface ScoringWeights {
  capability: number;
  qualityFloor: number;
  cost: number;
  stability: number;
  speed: number;
}

export interface ScoringContext {
  complexity: Complexity;
  allModels: ModelIntelLite[];
  runtimeSignals: {
    needsTools?: boolean;
  };
  userBans: Record<string, Complexity[]>;
  userDispreferred: Record<string, Complexity[]>;
  scoreOverrides: Record<string, Partial<Record<Complexity, number>>>;
  promotionState?: PromotionStateMap;
  budget?: BudgetStatus;
}

export const BALANCED_WEIGHTS: ScoringWeights = {
  capability: 0.35,
  qualityFloor: 0.20,
  cost: 0.20,
  stability: 0.15,
  speed: 0.10,
};

const TIER_SCORE = {
  frontier: 95,
  strong: 80,
  standard: 65,
  mini: 40,
  unknown: 30,
} as const;

const TIER_LEVEL = {
  frontier: 4,
  strong: 3,
  standard: 2,
  mini: 1,
  unknown: 0,
} as const;

const MIN_TIER_BY_COMPLEXITY = {
  simple: "mini",
  normal: "standard",
  complex: "strong",
  deep: "frontier",
} as const;

export function scoreModel(
  model: ModelIntelLite,
  context: ScoringContext,
  modeWeights: ScoringWeights = BALANCED_WEIGHTS,
): number {
  if (getRejectionReason(model, context) !== "unknown") return Number.NEGATIVE_INFINITY;

  const override = context.scoreOverrides[model.modelKey]?.[context.complexity];
  if (override !== undefined) return override;

  const capabilityScore = capabilityScoreFor(model, context.complexity);
  const qualityFloorPass = qualityFloorPassesFor(model, context.complexity) ? 100 : 0;
  const costScore = costScoreFor(model, context);
  const stabilityScore = stabilityScoreFor(model);
  const speedScore = speedScoreFor(model);

  let total =
    capabilityScore * modeWeights.capability +
    qualityFloorPass * modeWeights.qualityFloor +
    costScore * modeWeights.cost +
    stabilityScore * modeWeights.stability +
    speedScore * modeWeights.speed;

  if (context.userDispreferred[model.modelKey]?.includes(context.complexity)) {
    total -= 0.5;
  }

  return total;
}

export function buildRecommendation(models: ModelIntelLite[], context: ScoringContext): RouterLiteRecommendation {
  const scoredCandidates = models.map((model) => ({ model, score: scoreModel(model, context) }));
  const rejectedModels = scoredCandidates
    .filter((candidate) => candidate.score === Number.NEGATIVE_INFINITY)
    .map((candidate) => ({ model: candidate.model.modelKey, reason: getRejectionReason(candidate.model, context) }));
  const eligible = scoredCandidates
    .filter((candidate) => candidate.score > Number.NEGATIVE_INFINITY)
    .filter((candidate, _index, candidates) => {
      const minEligibleLevel = Math.min(
        ...candidates
          .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
          .map((entry) => TIER_LEVEL[entry.model.capability.codingTier]),
      );
      return TIER_LEVEL[candidate.model.capability.codingTier] === minEligibleLevel;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return (left.model.marketPrice.blendedUsdPerMTok ?? Number.POSITIVE_INFINITY)
        - (right.model.marketPrice.blendedUsdPerMTok ?? Number.POSITIVE_INFINITY);
    });

  const ignoredReason = getIgnoredReason(models, rejectedModels);
  const winner = eligible[0]?.model;
  const isLivePromotion = winner === undefined ? false : getPromotionState(context.promotionState ?? {}, winner.modelKey, context.complexity).state === "live";
  const reasonCodes = winner
    ? buildReasonCodes(winner, context, rejectedModels, models, isLivePromotion)
    : ["no_eligible_model", ...(context.budget?.reasonCodes ?? [])];

  return {
    recommendedModel: winner?.modelKey,
    outputBudget: outputBudgetFor(context.complexity),
    qualityFloor: MIN_TIER_BY_COMPLEXITY[context.complexity],
    eligibleModels: eligible.map((candidate) => candidate.model.modelKey),
    rejectedModels,
    reasonCodes,
    mode: isLivePromotion ? "live" : "shadow",
    scoringMode: "balanced",
    ignoredReason,
  };
}

export function capabilityScoreFor(model: ModelIntelLite, complexity: Complexity): number {
  const scenario = scenarioForComplexity(complexity);
  const fused = model.capability.scoreByScenario?.[scenario];
  if (fused !== undefined && fused.confidence !== "unknown") {
    return fused.score;
  }
  const baseScore = TIER_SCORE[model.capability.codingTier] ?? 30;
  const multiplier = model.capability.confidence === "high" ? 1
    : model.capability.confidence === "medium" ? 0.9
      : model.capability.confidence === "low" ? 0.75
        : 0.5;
  return baseScore * multiplier;
}

function scenarioForComplexity(_complexity: Complexity): "coding_worker" {
  return "coding_worker";
}

export function qualityFloorPassesFor(model: ModelIntelLite, complexity: Complexity): boolean {
  return TIER_LEVEL[model.capability.codingTier] >= TIER_LEVEL[MIN_TIER_BY_COMPLEXITY[complexity]];
}

export function costScoreFor(model: ModelIntelLite, context: ScoringContext): number {
  if (model.plan.type === "subscription" && model.plan.quotaPressure === "low") return 100;
  if (model.plan.type === "subscription" && model.plan.quotaPressure === "medium") return 80;

  const sameTierModels = context.allModels.filter(
    (candidate) => candidate.capability.codingTier === model.capability.codingTier && candidate.configured,
  );
  if (sameTierModels.length === 0) return 50;

  const prices = sameTierModels
    .map((candidate) => candidate.marketPrice.blendedUsdPerMTok)
    .filter((price): price is number => price !== undefined && price !== null);
  if (prices.length === 0) return 50;

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const myPrice = model.marketPrice.blendedUsdPerMTok ?? maxPrice;
  if (maxPrice === minPrice) return 60;
  const priceRank = (myPrice - minPrice) / (maxPrice - minPrice);
  return Math.round(80 - priceRank * 60);
}

export function stabilityScoreFor(model: ModelIntelLite): number {
  const failureRate = model.health.recentFailureRate;
  if (failureRate === undefined) return 80;
  if (failureRate <= 0.02) return 100;
  if (failureRate <= 0.05) return 90;
  if (failureRate <= 0.10) return 70;
  if (failureRate <= 0.15) return 50;
  if (failureRate <= 0.20) return 30;
  return 0;
}

export function speedScoreFor(model: ModelIntelLite): number {
  const p95 = model.health.p95LatencyMs ?? model.health.p95FirstTokenMs;
  if (p95 === undefined) return 70;
  if (p95 <= 800) return 100;
  if (p95 <= 1500) return 80;
  if (p95 <= 3000) return 60;
  if (p95 <= 5000) return 40;
  return 20;
}

export function getRejectionReason(model: ModelIntelLite, context: ScoringContext): string {
  if (!model.configured) return "not_configured";
  if (model.health.cooldown) return "cooldown_active";
  if (model.health.available === "no" || model.available === "no") return "unavailable";
  if (context.userBans[model.modelKey]?.includes(context.complexity)) return "user_ban_active";
  if (context.budget?.action === "plan_only" && !isPlanIncluded(model)) return "budget_exceeded_plan_only";
  if (!hasCapabilityFor(model)) return "capability_evidence_missing";
  if (!qualityFloorPassesFor(model, context.complexity)) return "quality_floor_not_met";
  if (context.runtimeSignals.needsTools && model.capability.toolUse !== "yes") return "tool_support_insufficient";
  return "unknown";
}

function hasCapabilityFor(model: ModelIntelLite): boolean {
  return model.capability.codingTier !== "unknown"
    && model.capability.confidence !== "unknown"
    && model.capability.sources.length > 0;
}

function getIgnoredReason(
  models: ModelIntelLite[],
  rejectedModels: RouterLiteRecommendation["rejectedModels"],
): RouterLiteRecommendation["ignoredReason"] {
  if (models.length === 0) return "no_capability_data";
  if (rejectedModels.length === 0) return undefined;
  if (rejectedModels.length !== models.length) return undefined;
  if (rejectedModels.every((entry) => entry.reason === "not_configured")) return "all_unconfigured";
  if (rejectedModels.every((entry) => entry.reason === "cooldown_active")) return "all_cooldown";
  if (rejectedModels.every((entry) => entry.reason === "quality_floor_not_met")) return "no_quality_floor_match";
  if (rejectedModels.every((entry) => entry.reason === "user_ban_active")) return "all_banned";
  if (rejectedModels.every((entry) => entry.reason === "budget_exceeded_plan_only")) return "budget_exceeded_no_plan";
  if (rejectedModels.every((entry) => entry.reason === "capability_evidence_missing")) return "no_capability_data";
  return "no_eligible_model";
}

function buildReasonCodes(
  model: ModelIntelLite,
  context: ScoringContext,
  rejectedModels: RouterLiteRecommendation["rejectedModels"],
  allModels: ModelIntelLite[],
  isLivePromotion: boolean,
): string[] {
  const qualityFloor = MIN_TIER_BY_COMPLEXITY[context.complexity];
  const reasonCodes = [
    `quality_floor_pass:${qualityFloor}`,
    `recommended_model:${model.modelKey}`,
    isLivePromotion ? "promotion_live" : "promotion_shadow",
    ...(context.budget?.reasonCodes ?? []),
  ];
  if (Object.keys(context.userBans).length > 0) reasonCodes.push("user_ban_active");
  if (context.userDispreferred[model.modelKey]?.includes(context.complexity) === false
    || Object.keys(context.userDispreferred).length > 0) {
    reasonCodes.push("user_dispreferred_tiebreak");
  }
  const switchedFromCooldownPeer = rejectedModels.some((entry) => {
    const rejected = allModels.find((candidate) => candidate.modelKey === entry.model);
    return entry.reason === "cooldown_active"
      && rejected?.provider !== model.provider
      && rejected?.capability.codingTier === model.capability.codingTier;
  });
  if (switchedFromCooldownPeer) reasonCodes.push("switched_provider_for_stability");
  return reasonCodes;
}

function outputBudgetFor(complexity: Complexity): RouterLiteRecommendation["outputBudget"] {
  return complexity === "simple" ? "short"
    : complexity === "normal" ? "medium"
      : complexity === "complex" ? "long"
        : "deep";
}

function isPlanIncluded(model: ModelIntelLite): boolean {
  return model.plan.effectiveCostBand === "free_or_sunk";
}
