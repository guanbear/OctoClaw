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
  nativeFallbackOrder?: string[];
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

function confidenceAllowsTierPromotion(confidence?: string): boolean {
  return confidence === "high";
}

function confidenceWeight(confidence?: string): number {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.6;
  if (confidence === "low") return 0.1;
  return 0;
}

function calibratedNamePrior(modelKey: string, tier: ModelIntelLite["capability"]["codingTier"]): number {
  const key = modelKey.toLowerCase();
  const base = TIER_SCORE[tier] ?? TIER_SCORE.unknown;
  const roleBonus = roleModifierScore(key);
  const generationBonus = generationModifierScore(key);
  const rawPrior = base + roleBonus + generationBonus;

  if (hasCompactModifier(key)) {
    return Math.min(rawPrior, TIER_SCORE.mini + 3);
  }

  const cappedPrior = Math.min(tierCeiling(tier), rawPrior);
  return Math.max(TIER_SCORE.unknown, Math.round(cappedPrior * 100) / 100);
}

function tierCeiling(tier: ModelIntelLite["capability"]["codingTier"]): number {
  if (tier === "frontier") return 96;
  if (tier === "strong") return 88;
  if (tier === "standard") return 73;
  if (tier === "mini") return 43;
  return 35;
}

function hasCompactModifier(key: string): boolean {
  return /(^|[/._-])(mini|flash|lite|haiku|small|air)([/._-]|$)/.test(key);
}

function roleModifierScore(key: string): number {
  if (hasCompactModifier(key)) return -8;
  if (/(^|[/._-])(opus|ultra)([/._-]|$)/.test(key)) return 0.8;
  if (/(^|[/._-])(max)([/._-]|$)/.test(key)) return 0.6;
  if (/(^|[/._-])(pro)([/._-]|$)/.test(key)) return 0.5;
  if (/(^|[/._-])(sonnet)([/._-]|$)/.test(key)) return 0.6;
  if (/(^|[/._-])(plus)([/._-]|$)/.test(key)) return 0.4;
  return 0;
}

function generationModifierScore(key: string): number {
  if (/(^|[/._-])[a-z]+[0-9]+[._-][0-9]+([/._-]|$)/.test(key)) {
    const namedSeriesVersions = Array.from(key.matchAll(/(?:^|[/._-])[a-z]+(\d+)[._-](\d+)(?:[/._-]|$)/g))
      .map((match) => ({
        major: Number(match[1]),
        minor: Number(`0.${match[2]}`),
      }))
      .filter((version) => Number.isFinite(version.major) && Number.isFinite(version.minor));
    if (namedSeriesVersions.length > 0) {
      const version = namedSeriesVersions.reduce((best, item) => {
        if (item.major !== best.major) return item.major > best.major ? item : best;
        return item.minor > best.minor ? item : best;
      });
      return 0.8 + Math.min(0.35, version.major * 0.03 + version.minor * 0.2);
    }
  }

  const versions = Array.from(key.matchAll(/(?:^|[/._-]|[a-z])(?:v)?(\d+)(?:[._-](\d+))?/g))
    .map((match) => ({
      major: Number(match[1]),
      minor: match[2] === undefined ? 0 : Number(`0.${match[2]}`),
    }))
    .filter((version) => Number.isFinite(version.major));
  if (versions.length === 0) return 0;

  const version = versions.reduce((best, item) => {
    if (item.major !== best.major) return item.major > best.major ? item : best;
    return item.minor > best.minor ? item : best;
  });

  if (version.major >= 5) return 1 + version.minor * 0.4;
  if (version.major === 4) return 0.4 + version.minor * 0.4;
  if (version.major === 3) return version.minor * 0.4;
  if (version.major === 2) return version.minor * 0.2;
  return 0;
}

function blendWithTierPrior(
  modelKey: string,
  score: number,
  confidence: string | undefined,
  tier: ModelIntelLite["capability"]["codingTier"],
): number {
  const weight = confidenceWeight(confidence);
  const prior = calibratedNamePrior(modelKey, tier);
  const blended = Math.round((score * weight + prior * (1 - weight)) * 100) / 100;
  if (confidenceAllowsTierPromotion(confidence)) return blended;
  if (confidence === "medium") return Math.max(blended, prior);
  if (confidence === "low") return prior;
  return prior;
}

function effectiveCodingTier(model: ModelIntelLite): ModelIntelLite["capability"]["codingTier"] {
  const capabilityScore = model.capability.capabilityScore;
  if (capabilityScore === undefined || !confidenceAllowsTierPromotion(capabilityScore.confidence)) return model.capability.codingTier;
  const score = capabilityScore.score;
  if (score >= 90) return "frontier";
  if (score >= 75) return "strong";
  if (score >= 60) return "standard";
  if (score >= 45) return "mini";
  return "unknown";
}

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
          .map((entry) => TIER_LEVEL[effectiveCodingTier(entry.model)]),
      );
      return TIER_LEVEL[effectiveCodingTier(candidate.model)] === minEligibleLevel;
    })
    .sort((left, right) => {
      if (Math.abs(right.score - left.score) > 0.01) return right.score - left.score;
      return compareNativeFallbackTieBreak(left.model, right.model, context.nativeFallbackOrder ?? []);
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
  const unified = model.capability.capabilityScore;
  if (unified !== undefined && unified.confidence !== "unknown") {
    return blendWithTierPrior(model.modelKey, unified.score, unified.confidence, model.capability.codingTier);
  }
  const scenario = scenarioForComplexity(complexity);
  const fused = model.capability.scoreByScenario?.[scenario];
  if (fused !== undefined && fused.confidence !== "unknown") {
    return blendWithTierPrior(model.modelKey, fused.score, fused.confidence, model.capability.codingTier);
  }
  const baseScore = calibratedNamePrior(model.modelKey, model.capability.codingTier);
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
  return TIER_LEVEL[effectiveCodingTier(model)] >= TIER_LEVEL[MIN_TIER_BY_COMPLEXITY[complexity]];
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
      && rejected !== undefined
      && rejected.provider !== model.provider
      && effectiveCodingTier(rejected) === effectiveCodingTier(model);
  });
  if (switchedFromCooldownPeer) reasonCodes.push("switched_provider_for_stability");
  for (const rejected of rejectedModels) {
    const rejectedModel = allModels.find((candidate) => candidate.modelKey === rejected.model);
    if (rejected.reason === "cooldown_active" && rejectedModel?.health.cooldownReason) {
      reasonCodes.push(`cooldown:${rejectedModel.health.cooldownReason}:${rejectedModel.modelKey}`);
    }
  }
  return reasonCodes;
}

function compareNativeFallbackTieBreak(left: ModelIntelLite, right: ModelIntelLite, nativeFallbackOrder: string[]): number {
  const leftRank = nativeFallbackRank(left, nativeFallbackOrder);
  const rightRank = nativeFallbackRank(right, nativeFallbackOrder);
  if (leftRank !== rightRank) return leftRank - rightRank;
  const priceDiff = (left.marketPrice.blendedUsdPerMTok ?? Number.POSITIVE_INFINITY)
    - (right.marketPrice.blendedUsdPerMTok ?? Number.POSITIVE_INFINITY);
  if (priceDiff !== 0) return priceDiff;
  return left.modelKey.localeCompare(right.modelKey);
}

function nativeFallbackRank(model: ModelIntelLite, nativeFallbackOrder: string[]): number {
  if (model.tags.includes("default")) return 0;
  const explicitIndex = nativeFallbackOrder.findIndex((entry) => entry.toLowerCase() === model.modelKey.toLowerCase());
  if (explicitIndex >= 0) return 1 + explicitIndex;
  const tagRank = model.tags
    .map((tag) => /^fallback#(\d+)$/iu.exec(tag)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)[0];
  if (tagRank !== undefined) return 1 + tagRank;
  return 10_000;
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
