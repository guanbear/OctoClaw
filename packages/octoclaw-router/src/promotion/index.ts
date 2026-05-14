export type PromotionAction = "promote" | "hold" | "reject" | "mark_failed" | "revert";

export interface ShadowOutcome {
  success: boolean;
  costUsd?: number;
  latencyMs?: number;
}

export interface RouterShadowEvent {
  ts: string;
  sessionKey?: string;
  turnId?: string;
  actualModel?: string;
  recommendedModel?: string;
  eligibleModels?: string[];
  reasonCodes?: string[];
  promotionState?: "shadow" | "live";
  judge?: {
    complexity?: string;
  };
  outcome?: ShadowOutcome;
  recommendation?: {
    expectedSuccess?: boolean;
    expectedCostUsd?: number;
  };
}

export interface AggregatedMetrics {
  samples: number;
  successRateDelta: number;
  costDelta: number;
  qualityRegression: number;
}

export interface PromotionCandidateMetrics extends AggregatedMetrics {
  model: string;
  tier: string;
}

export interface PromotionDecision {
  action: PromotionAction;
  reason: string;
  retryBlockDays?: number;
  evidence?: AggregatedMetrics | Record<string, unknown>;
}

export interface PromotionDecisionEvent {
  ts: string;
  model: string;
  tier: string;
  decision: PromotionAction;
  reason: string;
  evidence?: Record<string, unknown>;
}

export type PromotionRuntimeState = "shadow" | "live" | "failed";

export interface PromotionStateEntry {
  model: string;
  tier: string;
  state: PromotionRuntimeState;
  since: string;
  reason: string;
  decision: PromotionAction;
}

export type PromotionStateMap = Record<string, PromotionStateEntry>;

export interface PromotionReviewSummary {
  failureRates: Record<string, number>;
  costDeltaByModel: Record<string, number>;
  ignoredReasonCounts: Record<string, number>;
  alerts: Array<{ model: string; reason: string }>;
}

export function aggregateShadowEvents(events: RouterShadowEvent[]): PromotionCandidateMetrics[] {
  const groups = new Map<string, RouterShadowEvent[]>();
  for (const event of events) {
    if (!event.recommendedModel) continue;
    const tier = event.judge?.complexity ?? "unknown";
    const key = `${event.recommendedModel}\u0000${tier}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const [model, tier] = key.split("\u0000", 2) as [string, string];
    const baselineSuccessRate = rate(group.map((event) => event.outcome?.success));
    const recommendedSuccessRate = rate(group.map((event) => event.recommendation?.expectedSuccess ?? event.outcome?.success));
    const baselineMedianCost = median(group.map((event) => event.outcome?.costUsd).filter(isNumber));
    const recommendedMedianCost = median(
      group
        .map((event) => event.recommendation?.expectedCostUsd)
        .filter(isNumber),
    ) ?? baselineMedianCost;
    const successRateDelta = recommendedSuccessRate - baselineSuccessRate;
    const costDelta = baselineMedianCost === undefined || baselineMedianCost === 0 || recommendedMedianCost === undefined
      ? 0
      : (recommendedMedianCost - baselineMedianCost) / baselineMedianCost;
    return {
      model,
      tier,
      samples: group.length,
      successRateDelta,
      costDelta,
      qualityRegression: Math.max(0, baselineSuccessRate - recommendedSuccessRate),
    };
  });
}

export function evaluatePromotion(
  _model: string,
  _tier: string,
  metrics: AggregatedMetrics,
  todayPromotionCount: number,
): PromotionDecision {
  if (todayPromotionCount >= 1) {
    return { action: "hold", reason: "daily_limit_reached" };
  }
  if (metrics.samples < 30) {
    return { action: "hold", reason: "insufficient_samples" };
  }
  if (metrics.qualityRegression > 0.05) {
    return { action: "mark_failed", reason: "quality_regression", retryBlockDays: 30 };
  }
  if (metrics.costDelta >= 0) {
    return { action: "reject", reason: "no_cost_benefit" };
  }
  if (metrics.successRateDelta >= -0.02 && metrics.costDelta < -0.10) {
    return { action: "promote", reason: "meets_promotion_criteria", evidence: metrics };
  }
  if (metrics.successRateDelta >= -0.05 && metrics.successRateDelta < -0.02) {
    if (metrics.samples >= 100 && metrics.costDelta < -0.15) {
      return { action: "promote", reason: "extended_observation_met_criteria", evidence: metrics };
    }
    return { action: "hold", reason: "observing_in_grey_zone" };
  }
  return { action: "hold", reason: "observing_weak_data" };
}

export function evaluatePromotionForConfiguredModel(input: {
  model: string;
  tier: string;
  metrics: AggregatedMetrics;
  todayPromotionCount: number;
  configuredModels: string[];
  failedAt?: string;
  now?: number;
}): PromotionDecision {
  if (!input.configuredModels.includes(input.model)) {
    return { action: "reject", reason: "not_configured" };
  }
  if (input.failedAt !== undefined) {
    const failedAt = Date.parse(input.failedAt);
    const now = input.now ?? Date.now();
    if (!Number.isNaN(failedAt) && now - failedAt < 30 * 24 * 60 * 60 * 1000) {
      return { action: "hold", reason: "retry_block_active" };
    }
  }
  return evaluatePromotion(input.model, input.tier, input.metrics, input.todayPromotionCount);
}

export function evaluateRevert(
  _model: string,
  _tier: string,
  recentEvents: RouterShadowEvent[],
  isPromoted: boolean,
): PromotionDecision | null {
  if (!isPromoted) return null;
  if (recentEvents.length < 20) return null;
  const failureRate = recentEvents.filter((event) => event.outcome?.success === false).length / recentEvents.length;
  if (failureRate > 0.20) {
    return {
      action: "revert",
      reason: "failure_rate_exceeded",
      retryBlockDays: 30,
      evidence: { recentFailureRate: failureRate, recentSamples: recentEvents.length },
    };
  }
  return null;
}

export function createPromotionDecisionEvent(input: {
  ts: string;
  model: string;
  tier: string;
  decision: PromotionDecision;
}): PromotionDecisionEvent {
  return {
    ts: input.ts,
    model: input.model,
    tier: input.tier,
    decision: input.decision.action,
    reason: input.decision.reason,
    evidence: input.decision.evidence as Record<string, unknown> | undefined,
  };
}

export function parsePromotionDecisionLog(text: string): PromotionDecisionEvent[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PromotionDecisionEvent);
}

export function buildPromotionState(
  decisions: PromotionDecisionEvent[],
  configuredModels: string[] = [],
): PromotionStateMap {
  const configured = new Set(configuredModels);
  const sorted = [...decisions].sort((left, right) => {
    const leftTime = Date.parse(left.ts);
    const rightTime = Date.parse(right.ts);
    const normalizedLeft = Number.isNaN(leftTime) ? 0 : leftTime;
    const normalizedRight = Number.isNaN(rightTime) ? 0 : rightTime;
    return normalizedLeft - normalizedRight;
  });
  const state: PromotionStateMap = {};

  for (const decision of sorted) {
    const key = promotionStateKey(decision.model, decision.tier);
    const isConfigured = configured.size === 0 || configured.has(decision.model);
    const runtimeState: PromotionRuntimeState = decision.decision === "promote" && isConfigured
      ? "live"
      : decision.decision === "mark_failed"
        ? "failed"
        : "shadow";

    state[key] = {
      model: decision.model,
      tier: decision.tier,
      state: runtimeState,
      since: decision.ts,
      reason: decision.decision === "promote" && !isConfigured ? "not_configured" : decision.reason,
      decision: decision.decision,
    };
  }

  return state;
}

export function getPromotionState(
  state: PromotionStateMap,
  model: string,
  tier: string,
): PromotionStateEntry {
  return state[promotionStateKey(model, tier)] ?? {
    model,
    tier,
    state: "shadow",
    since: "",
    reason: "no_promotion_decision",
    decision: "hold",
  };
}

export function filterPromotionDecisions(
  decisions: PromotionDecisionEvent[],
  since?: string,
  now = Date.now(),
): PromotionDecisionEvent[] {
  const cutoff = since === undefined ? undefined : now - parseDurationMs(since);
  if (cutoff === undefined) return decisions;
  return decisions.filter((decision) => {
    const ts = Date.parse(decision.ts);
    return !Number.isNaN(ts) && ts >= cutoff;
  });
}

export function renderPromotionDecisions(decisions: PromotionDecisionEvent[], format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify({ decisions }, null, 2);
  if (decisions.length === 0) return "No router promotion decisions found.";
  return [
    "Router promotion decisions",
    ...decisions.map((decision) => `${decision.ts}  ${decision.model}  ${decision.tier}  ${decision.decision}  ${decision.reason}`),
  ].join("\n");
}

export function runLightweightPromotionReview(events: RouterShadowEvent[]): PromotionReviewSummary {
  const byModel = new Map<string, RouterShadowEvent[]>();
  const ignoredReasonCounts: Record<string, number> = {};
  for (const event of events) {
    const model = event.recommendedModel ?? event.actualModel;
    if (model) byModel.set(model, [...(byModel.get(model) ?? []), event]);
    for (const reason of event.reasonCodes ?? []) {
      if (reason.startsWith("ignored_")) ignoredReasonCounts[reason] = (ignoredReasonCounts[reason] ?? 0) + 1;
    }
  }

  const failureRates: Record<string, number> = {};
  const costDeltaByModel: Record<string, number> = {};
  const alerts: Array<{ model: string; reason: string }> = [];
  for (const [model, modelEvents] of byModel) {
    const failures = modelEvents.filter((event) => event.outcome?.success === false).length;
    failureRates[model] = modelEvents.length === 0 ? 0 : failures / modelEvents.length;
    const metrics = aggregateShadowEvents(modelEvents.filter((event) => event.recommendedModel === model))[0];
    costDeltaByModel[model] = metrics?.costDelta ?? 0;
    if (failureRates[model] > 0.20) alerts.push({ model, reason: "consecutive_failures_or_failure_rate" });
    if ((metrics?.costDelta ?? 0) > 0.25) alerts.push({ model, reason: "cost_anomaly" });
  }

  return { failureRates, costDeltaByModel, ignoredReasonCounts, alerts };
}

export function parseDurationMs(value: string): number {
  const match = /^(\d+)([dhm])$/u.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2];
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 60 * 1000;
}

function rate(values: Array<boolean | undefined>): number {
  const known = values.filter((value): value is boolean => value !== undefined);
  if (known.length === 0) return 0;
  return known.filter(Boolean).length / known.length;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function promotionStateKey(model: string, tier: string): string {
  return `${model}\u0000${tier}`;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
