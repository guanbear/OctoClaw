# Auto Router v3 — Algorithm Pseudocode

Date: 2026-05-13
Related: `docs/octoclaw-auto-router-v3-design-2026-05-13.md`, `docs/octoclaw-auto-router-v3-bdd.md`

## Purpose

These are the **implementation contracts** for algorithms that cannot be left to individual interpretation. Every algorithm here must be implemented **exactly** as specified. When tests in the BDD document fail, trace back to this document.

Every function here is pure (except where explicitly marked I/O).

---

## 1. Judge — Semantic Layer

### 1.1 Cache Key

```typescript
function computeJudgeCacheKey(input: {
  prompt: string;
  sessionKey: string;
  recentExecution: { taskId: string; status: string } | null;
  judgeModelId: string;
  snapshotId: string;
}): string {
  const normalizedPrompt = input.prompt
    .toLowerCase()
    .replace(/[[:punct:]]/g, "")  // remove all punctuation
    .replace(/\s+/g, " ")
    .trim();
  
  const execFingerprint = input.recentExecution
    ? `${input.recentExecution.taskId}:${input.recentExecution.status}`
    : "none";
  
  const material = [
    normalizedPrompt,
    input.sessionKey,
    execFingerprint,
    input.judgeModelId,
    input.snapshotId,
  ].join("::");
  
  return sha256(material);
}
```

### 1.2 Cache Lookup + Storage

```typescript
class JudgeCache {
  private entries: Map<string, { result: JudgeOutput; expiresAt: number }>;
  private readonly TTL_MS = 120_000;
  private readonly MAX_ENTRIES = 1000;

  get(key: string): JudgeOutput | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.result;  // negative cache is also returned (confidence < 0.65)
  }

  set(key: string, result: JudgeOutput): void {
    if (this.entries.size >= this.MAX_ENTRIES) {
      // Evict oldest by expiresAt (simple LRU-ish)
      const [oldestKey] = [...this.entries.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, {
      result,
      expiresAt: Date.now() + this.TTL_MS,
    });
  }
}
```

### 1.3 Judge Call Flow

```typescript
async function judge(input: JudgeInput): Promise<JudgeOutput> {
  // 1. Fast bypass — status/provenance and session control skip judge
  if (input.runtimeSignals.statusOrProvenanceRequest) {
    return fallbackResult("status_or_provenance_request");
  }
  if (input.runtimeSignals.sessionControlRequest) {
    return fallbackResult("session_control_request");
  }

  // 2. Cache lookup
  const cacheKey = computeJudgeCacheKey({
    prompt: input.prompt,
    sessionKey: input.sessionKey,
    recentExecution: input.recentExecution,
    judgeModelId: config.judgeModelId,
    snapshotId: input.snapshotId,
  });
  const cached = cache.get(cacheKey);
  if (cached) {
    emit("router_judge_cache_hit", { cacheKey });
    return cached;
  }

  // 3. Cooldown check
  if (isJudgeInCooldown()) {
    emit("router_judge_fallback", { reason: "cooldown_active" });
    return fallbackResult("cooldown_active");
  }

  // 4. Call the model with hard timeout
  try {
    const rawResponse = await callJudgeModel(input.prompt, {
      timeoutMs: 2000,  // hard ceiling
    });

    // 5. Parse and validate
    const parsed = tryParseJudgeJson(rawResponse);
    if (!parsed) {
      recordJudgeFailure("parse_failed");
      emit("router_judge_fallback", { reason: "parse_failed" });
      return fallbackResult("parse_failed");
    }

    if (!isValidJudgeOutput(parsed)) {
      recordJudgeFailure("validation_failed");
      emit("router_judge_fallback", { reason: "validation_failed" });
      return fallbackResult("validation_failed");
    }

    // 6. Cache and return (cache applies to low confidence too)
    cache.set(cacheKey, parsed);
    recordJudgeSuccess();
    return parsed;
  } catch (err) {
    if (isTimeout(err)) {
      recordJudgeFailure("timeout");
      emit("router_judge_fallback", { reason: "timeout" });
      return fallbackResult("timeout");
    }
    recordJudgeFailure("exception");
    emit("router_judge_fallback", { reason: "exception" });
    return fallbackResult("exception");
  }
}
```

### 1.4 Judge Output Validation

Judge MUST produce exactly these 3 fields, no more, no less.

```typescript
function isValidJudgeOutput(value: unknown): value is JudgeOutput {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;

  // Exact field count: 3
  if (Object.keys(obj).length !== 3) return false;

  // Required fields
  if (typeof obj.route !== "string") return false;
  if (!["reply", "delegate"].includes(obj.route)) return false;

  if (typeof obj.confidence !== "number") return false;
  if (!Number.isFinite(obj.confidence)) return false;
  if (obj.confidence < 0 || obj.confidence > 1) return false;

  if (typeof obj.complexity !== "string") return false;
  if (!["simple", "normal", "complex", "deep"].includes(obj.complexity)) return false;

  // No extra fields: object must have exactly {route, confidence, complexity}
  const validKeys = new Set(["route", "confidence", "complexity"]);
  for (const key of Object.keys(obj)) {
    if (!validKeys.has(key)) return false;
  }

  return true;
}
```

### 1.5 Judge Failure Tracking + Cooldown

```typescript
class JudgeHealthTracker {
  private callLog: Array<{ timestamp: number; success: boolean }> = [];
  private cooldownUntil: number = 0;

  recordSuccess(): void {
    this.callLog.push({ timestamp: Date.now(), success: true });
    this.trim();
  }

  recordFailure(reason: string): void {
    this.callLog.push({ timestamp: Date.now(), success: false });
    this.trim();
    this.maybeEnterCooldown();
  }

  private trim(): void {
    // Keep last 50 calls
    if (this.callLog.length > 50) {
      this.callLog = this.callLog.slice(-50);
    }
  }

  private maybeEnterCooldown(): void {
    if (this.callLog.length < 10) return;  // Need enough data

    const recent10 = this.callLog.slice(-10);
    const failures = recent10.filter(c => !c.success).length;

    if (failures >= 5) {
      this.cooldownUntil = Date.now() + 30 * 60 * 1000;  // 30 min
    }
  }

  isInCooldown(): boolean {
    return Date.now() < this.cooldownUntil;
  }
}
```

### 1.6 Fallback Rules

```typescript
function fallbackResult(reason: string): JudgeOutput {
  // Deterministic rules based on structured runtime signals
  // No keyword matching, no natural language parsing
  const signals = context.runtimeSignals;

  // High-signal bypasses
  if (signals.statusOrProvenanceRequest) {
    return { route: "reply", confidence: 0.9, complexity: "simple" };
  }
  if (signals.sessionControlRequest) {
    return { route: "reply", confidence: 0.9, complexity: "simple" };
  }
  if (signals.explicitDelegate) {
    return { route: "delegate", confidence: 0.9, complexity: "normal" };
  }

  // Default: conservative reply with low confidence
  // Runtime's minConfidence threshold (0.65) will make this go through normal admission
  return { route: "reply", confidence: 0.5, complexity: "normal" };
}
```

---

## 2. Scoring Engine

### 2.1 Main Score Calculation

```typescript
function scoreModel(
  model: ModelIntel,
  context: ScoringContext,
  modeWeights: ScoringWeights = BALANCED_WEIGHTS,
): number {
  // Hard gates first — if any fail, return -Infinity (excluded)
  if (!model.configured) return -Infinity;
  if (model.health.cooldown) return -Infinity;
  if (model.health.available === "no") return -Infinity;
  if (context.userBans[model.modelKey]?.includes(context.complexity)) return -Infinity;

  // Capability check — required for routing decisions
  if (!hasCapabilityFor(model, context.complexity)) return -Infinity;

  // Tool requirement
  if (context.runtimeSignals.needsTools && model.capability.toolUse !== "yes") {
    return -Infinity;
  }

  // Compute component scores
  const capabilityScore = capabilityScoreFor(model, context.complexity);
  const qualityFloorPass = qualityFloorPassesFor(model, context.complexity) ? 100 : 0;
  const costScore = costScoreFor(model, context);
  const stabilityScore = stabilityScoreFor(model);
  const speedScore = speedScoreFor(model, context);

  // Weighted sum
  let total = 
    capabilityScore * modeWeights.capability +
    qualityFloorPass * modeWeights.qualityFloor +
    costScore * modeWeights.cost +
    stabilityScore * modeWeights.stability +
    speedScore * modeWeights.speed;

  // Dispreferred penalty — breaks ties only
  if (context.userDispreferred[model.modelKey]?.includes(context.complexity)) {
    total -= 0.5;  // Small enough that score differences > 0.5 still dominate
  }

  return total;
}

const BALANCED_WEIGHTS: ScoringWeights = {
  capability: 0.35,
  qualityFloor: 0.20,
  cost: 0.20,
  stability: 0.15,
  speed: 0.10,
};
```

### 2.2 Capability Score (0-100)

```typescript
function capabilityScoreFor(model: ModelIntel, complexity: Complexity): number {
  // V1: use the model's tier as primary capability signal
  // Map tier to a base score, higher tier = higher score
  const tierMap: Record<string, number> = {
    frontier: 95,
    strong: 80,
    standard: 65,
    mini: 40,
    unknown: 30,
  };

  const baseScore = tierMap[model.capability.codingTier] ?? 30;

  // Adjust by confidence
  const confidenceMultiplier = 
    model.capability.confidence === "high" ? 1.0 :
    model.capability.confidence === "medium" ? 0.9 :
    model.capability.confidence === "low" ? 0.75 :
    0.5;

  return baseScore * confidenceMultiplier;
}
```

### 2.3 Quality Floor Check

```typescript
function qualityFloorPassesFor(model: ModelIntel, complexity: Complexity): boolean {
  const minTierByComplexity: Record<Complexity, TierLevel> = {
    simple: 1,    // mini or above
    normal: 2,    // standard or above
    complex: 3,   // strong or above
    deep: 4,      // frontier only
  };

  const tierLevel = tierToLevel(model.capability.codingTier);
  const requiredLevel = minTierByComplexity[complexity];

  return tierLevel >= requiredLevel;
}

function tierToLevel(tier: string): number {
  return {
    frontier: 4,
    strong: 3,
    standard: 2,
    mini: 1,
  }[tier] ?? 0;
}
```

### 2.4 Cost Score (0-100)

```typescript
function costScoreFor(model: ModelIntel, context: ScoringContext): number {
  // Priority 1: Plan + low quota pressure = best score
  if (model.plan.type === "subscription" && model.plan.quotaPressure === "low") {
    return 100;
  }
  if (model.plan.type === "subscription" && model.plan.quotaPressure === "medium") {
    return 80;
  }
  // NOTE: unknown quota pressure is NEVER treated as free/low

  // Priority 2: Compare price within the same tier
  const sameTierModels = context.allModels.filter(
    m => m.capability.codingTier === model.capability.codingTier && m.configured
  );

  if (sameTierModels.length === 0) return 50;  // No comparison possible

  const prices = sameTierModels
    .map(m => m.marketPrice.blendedUsdPerMTok)
    .filter(p => p !== undefined && p !== null) as number[];

  if (prices.length === 0) return 50;

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const myPrice = model.marketPrice.blendedUsdPerMTok ?? maxPrice;

  if (maxPrice === minPrice) return 60;  // All same price

  // Cheapest gets 80, most expensive gets 20, linear interpolation
  const priceRange = maxPrice - minPrice;
  const priceRank = (myPrice - minPrice) / priceRange;  // 0 = cheapest, 1 = most expensive
  return Math.round(80 - priceRank * 60);  // 80 down to 20
}
```

### 2.5 Stability Score (0-100)

```typescript
function stabilityScoreFor(model: ModelIntel): number {
  const failureRate = model.health.recentFailureRate;

  if (failureRate === undefined) return 80;  // No data, assume OK

  // Linear mapping
  if (failureRate <= 0.02) return 100;  // < 2% is excellent
  if (failureRate <= 0.05) return 90;
  if (failureRate <= 0.10) return 70;
  if (failureRate <= 0.15) return 50;
  if (failureRate <= 0.20) return 30;  // Near cooldown threshold
  return 0;
}
```

### 2.6 Speed Score (0-100)

```typescript
function speedScoreFor(model: ModelIntel, context: ScoringContext): number {
  const p95 = model.health.p95LatencyMs;

  if (p95 === undefined) return 70;  // No data, assume OK

  // Baseline: under 800ms is excellent
  if (p95 <= 800) return 100;
  if (p95 <= 1500) return 80;
  if (p95 <= 3000) return 60;
  if (p95 <= 5000) return 40;
  return 20;
}
```

### 2.7 Recommendation Output Builder

```typescript
function buildRecommendation(
  scoredCandidates: Array<{ model: ModelIntel; score: number }>,
  context: ScoringContext,
): Recommendation {
  // Filter out excluded (score === -Infinity)
  const eligible = scoredCandidates.filter(c => c.score > -Infinity);
  const rejected = scoredCandidates
    .filter(c => c.score === -Infinity)
    .map(c => ({ model: c.model.modelKey, reason: getRejectionReason(c.model, context) }));

  if (eligible.length === 0) {
    return {
      recommendedModel: null,
      eligibleModels: [],
      rejectedModels: rejected,
      reasonCodes: ["no_eligible_model"],
      ignoredReason: getIgnoredReason(scoredCandidates),
    };
  }

  // Sort by score descending; tiebreak by lower price
  const sorted = eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.model.marketPrice.blendedUsdPerMTok ?? Infinity)
         - (b.model.marketPrice.blendedUsdPerMTok ?? Infinity);
  });

  return {
    recommendedModel: sorted[0].model.modelKey,
    eligibleModels: sorted.map(s => s.model.modelKey),
    rejectedModels: rejected,
    reasonCodes: buildReasonCodes(sorted[0].model, context),
  };
}

function getRejectionReason(model: ModelIntel, context: ScoringContext): string {
  if (!model.configured) return "not_configured";
  if (model.health.cooldown) return "cooldown_active";
  if (model.health.available === "no") return "unavailable";
  if (context.userBans[model.modelKey]?.includes(context.complexity)) return "user_ban_active";
  if (!qualityFloorPassesFor(model, context.complexity)) return "quality_floor_not_met";
  if (context.runtimeSignals.needsTools && model.capability.toolUse !== "yes") return "tool_support_insufficient";
  return "unknown";
}
```

---

## 3. Promotion (Shadow → Live)

### 3.1 Sample Aggregation

```typescript
function aggregateShadowEvents(
  events: ShadowEvent[],
  model: string,
  complexityTier: string,
): AggregatedMetrics {
  const filtered = events.filter(e => 
    e.recommendation.recommendedModel === model 
    && e.recommendation.complexityTier === complexityTier
  );

  const samples = filtered.length;
  if (samples === 0) {
    return { samples: 0 };  // Not enough data
  }

  // Actual vs recommended deltas
  const actualOutcomes = filtered.map(e => ({
    success: e.actualSuccess,
    cost: e.actualCostUsd,
    latency: e.actualLatencyMs,
  }));
  const recommendedOutcomes = filtered.map(e => ({
    // These come from shadow simulation, not actual use
    success: e.recommendation.expectedSuccess,
    cost: e.recommendation.expectedCostUsd,
  }));

  const actualSuccessRate = actualOutcomes.filter(o => o.success).length / samples;
  const baselineSuccessRate = /* baseline is the currently live model's 7-day success rate */;

  const actualMedianCost = median(actualOutcomes.map(o => o.cost));
  const baselineMedianCost = /* baseline live model's cost */;

  return {
    samples,
    successRateDelta: actualSuccessRate - baselineSuccessRate,
    costDelta: (actualMedianCost - baselineMedianCost) / baselineMedianCost,
    qualityRegression: Math.max(0, baselineSuccessRate - actualSuccessRate),
  };
}
```

### 3.2 Promotion Decision

```typescript
function evaluatePromotion(
  model: string,
  tier: string,
  metrics: AggregatedMetrics,
  todayPromotionCount: number,
): PromotionDecision {
  // Enforce: max 1 promotion per day
  if (todayPromotionCount >= 1) {
    return { action: "hold", reason: "daily_limit_reached" };
  }

  // Not enough data
  if (metrics.samples < 30) {
    return { action: "hold", reason: "insufficient_samples" };
  }

  // Quality regression check
  if (metrics.qualityRegression > 0.05) {
    return { action: "mark_failed", reason: "quality_regression", retryBlockDays: 30 };
  }

  // Cost check
  if (metrics.costDelta >= 0) {
    return { action: "reject", reason: "no_cost_benefit" };
  }

  // Promote if: quality within tolerance AND cost saved
  if (metrics.successRateDelta >= -0.02 && metrics.costDelta < -0.10) {
    return { 
      action: "promote", 
      reason: "meets_promotion_criteria",
      evidence: metrics,
    };
  }

  // Hold if in grey zone
  if (metrics.successRateDelta >= -0.05 && metrics.successRateDelta < -0.02) {
    // Keep observing; if samples >= 100, re-evaluate with tighter criteria
    if (metrics.samples >= 100 && metrics.costDelta < -0.15) {
      return { action: "promote", reason: "extended_observation_met_criteria", evidence: metrics };
    }
    return { action: "hold", reason: "observing_in_grey_zone" };
  }

  // Failure-like success rate but not hit regression threshold yet
  return { action: "hold", reason: "observing_weak_data" };
}
```

### 3.3 Post-Promotion Regression Monitoring

```typescript
function evaluateRevert(
  model: string,
  tier: string,
  recentEvents: ShadowEvent[],  // last 7 days
): RevertDecision | null {
  // Check if currently live
  if (!isPromoted(model, tier)) return null;

  const recentFailures = recentEvents.filter(e => !e.actualSuccess).length;
  const recentSamples = recentEvents.length;

  if (recentSamples < 20) return null;  // Not enough recent data

  const currentFailureRate = recentFailures / recentSamples;

  if (currentFailureRate > 0.20) {
    return {
      action: "revert",
      reason: "failure_rate_exceeded",
      retryBlockDays: 30,
      evidence: { recentFailureRate: currentFailureRate, recentSamples },
    };
  }

  return null;
}
```

---

## 4. Capability Snapshot Merging

### 4.1 Merge Priority

When multiple sources provide data for the same model:

1. **User override** — highest priority (stored separately in wizard config)
2. **Packaged leaderboard snapshot** — shipped with project
3. **OpenRouter API** — most complete for pricing
4. **models.dev** — supplementary
5. **OpenClaw provider catalog** — hardware of what's actually callable
6. **Local replay** (V1 optional) — only augments, doesn't replace

### 4.2 Conflict Detection

```typescript
function mergePriceData(
  model: string,
  sources: Array<{ source: string; price: number }>,
): { price: number; conflict: boolean; sources: string[] } {
  if (sources.length === 0) return { price: NaN, conflict: false, sources: [] };
  if (sources.length === 1) return { price: sources[0].price, conflict: false, sources: [sources[0].source] };

  const prices = sources.map(s => s.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  // Flag as conflict if > 20% difference
  const conflict = (max - min) / min > 0.20;

  // If conflict: take the median (robust to outlier)
  // If no conflict: take the mean
  const price = conflict 
    ? prices.sort()[Math.floor(prices.length / 2)]
    : prices.reduce((a, b) => a + b, 0) / prices.length;

  return {
    price,
    conflict,
    sources: sources.map(s => s.source),
  };
}
```

### 4.3 Freshness Tracking

```typescript
function computeFreshness(model: ModelIntel): "fresh" | "stale" | "very_stale" {
  const now = Date.now();
  const lastVerified = Date.parse(model.capability.lastVerifiedAt ?? model.freshness ?? "");
  
  if (isNaN(lastVerified)) return "very_stale";
  
  const ageDays = (now - lastVerified) / (1000 * 60 * 60 * 24);
  
  if (ageDays < 14) return "fresh";
  if (ageDays < 90) return "stale";
  return "very_stale";
}
```

---

## 5. Health Tracking

### 5.1 Sliding Window Failure Rate

```typescript
class ModelHealthTracker {
  private readonly WINDOW_SIZE = 50;
  private readonly WINDOW_MS = 30 * 60 * 1000;  // 30 minutes

  private callLog: Map<string, Array<{ timestamp: number; success: boolean; errorCode?: string; latencyMs?: number }>> = new Map();

  recordCall(model: string, result: {
    success: boolean;
    errorCode?: string;
    latencyMs?: number;
  }): void {
    const log = this.callLog.get(model) ?? [];
    log.push({ timestamp: Date.now(), ...result });

    // Trim by time window + count
    const cutoff = Date.now() - this.WINDOW_MS;
    const trimmed = log
      .filter(c => c.timestamp >= cutoff)
      .slice(-this.WINDOW_SIZE);
    
    this.callLog.set(model, trimmed);

    // Check cooldown triggers
    this.evaluateCooldown(model);
  }

  getHealthFor(model: string): HealthSignals {
    const log = this.callLog.get(model) ?? [];
    
    if (log.length === 0) {
      return {
        recentFailureRate: undefined,
        p50LatencyMs: undefined,
        p95LatencyMs: undefined,
        cooldown: false,
      };
    }

    const failures = log.filter(c => !c.success).length;
    const latencies = log
      .map(c => c.latencyMs)
      .filter(l => l !== undefined)
      .sort((a, b) => a - b) as number[];

    return {
      recentFailureRate: failures / log.length,
      p50LatencyMs: latencies[Math.floor(latencies.length * 0.5)],
      p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)],
      cooldown: this.isInCooldown(model),
    };
  }

  private evaluateCooldown(model: string): void {
    const log = this.callLog.get(model) ?? [];
    if (log.length < 10) return;

    // Rate limit immediate cooldown (10 min)
    const lastCall = log[log.length - 1];
    if (lastCall.errorCode === "429" || lastCall.errorCode === "rate_limit") {
      this.setCooldown(model, 10 * 60 * 1000);
      return;
    }

    // Failure rate threshold (30 min)
    const recent10 = log.slice(-10);
    const failureRate = recent10.filter(c => !c.success).length / 10;
    if (failureRate > 0.20) {
      this.setCooldown(model, 30 * 60 * 1000);
    }
  }

  private cooldowns: Map<string, number> = new Map();

  private setCooldown(model: string, durationMs: number): void {
    this.cooldowns.set(model, Date.now() + durationMs);
  }

  private isInCooldown(model: string): boolean {
    const until = this.cooldowns.get(model);
    return until !== undefined && Date.now() < until;
  }
}
```

---

## 6. Cost Accounting

### 6.1 Per-Call Cost Computation

```typescript
function computeCostForCall(
  model: ModelIntel,
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): number {
  const prices = model.marketPrice;
  let total = 0;

  total += (tokens.input / 1_000_000) * (prices.inputUsdPerMTok ?? 0);
  total += (tokens.output / 1_000_000) * (prices.outputUsdPerMTok ?? 0);
  total += ((tokens.cacheRead ?? 0) / 1_000_000) * (prices.cacheReadUsdPerMTok ?? 0);
  total += ((tokens.cacheWrite ?? 0) / 1_000_000) * (prices.cacheWriteUsdPerMTok ?? 0);

  // If plan-covered and within quota, effective cost is 0 (for accounting)
  if (model.plan.type === "subscription" && model.plan.quotaPressure === "low") {
    return 0;  // Plan absorbs this
  }
  if (model.plan.type === "subscription" && model.plan.quotaPressure === "medium") {
    return total * 0.5;  // Partially absorbed (rough estimate)
  }

  return total;
}
```

### 6.2 Budget Prediction

```typescript
function predictMonthEndSpend(
  events: CostEvent[],
  today: Date = new Date(),
): number {
  // Get last 7 days of events
  const cutoff = today.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recent = events.filter(e => Date.parse(e.ts) >= cutoff);

  if (recent.length === 0) return 0;

  const totalSpend = recent.reduce((sum, e) => sum + e.costUsd, 0);
  const avgPerDay = totalSpend / 7;

  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dayOfMonth = today.getDate();
  const remainingDays = daysInMonth - dayOfMonth;

  const monthToDate = events
    .filter(e => {
      const eDate = new Date(Date.parse(e.ts));
      return eDate.getFullYear() === today.getFullYear() 
          && eDate.getMonth() === today.getMonth();
    })
    .reduce((sum, e) => sum + e.costUsd, 0);

  return monthToDate + avgPerDay * remainingDays;
}
```

---

## 7. Error Handling

### 7.1 Standard error handling matrix

For EVERY function that talks to external resources (files, network, DB), follow this pattern:

| Error | Action |
|---|---|
| File not found | Fall back to default; log `warn` |
| File corrupt (JSON parse fail) | Fall back to default; log `error`; do NOT delete the corrupt file (user may recover) |
| Network timeout | Fall back to cached data; log `warn` |
| Network 5xx | Fall back to cached; increment failure counter |
| Network 429 | Trigger cooldown for source; log `warn` |
| SQLite busy / locked | Retry 3 times with 10ms exponential backoff; if still busy, fall back to read-only in-memory copy |
| SQLite corrupt | Log `error`; rename corrupt file to `.broken`; create fresh empty DB |
| Invalid input (e.g. malformed tier) | Log `error`; throw typed error; do NOT default silently |

### 7.2 Never swallow errors silently

Every fallback must emit a telemetry event for observability.

```typescript
function safeCall<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`[router] ${context} failed: ${String(err)}`);
    emit("router_fallback_triggered", { context, error: String(err) });
    return fallback;
  }
}
```

---

## 8. Data Schema Summary (JSON-like)

### 8.1 `leaderboard-snapshot.json`

```jsonc
{
  "snapshotVersion": "2026-05-13",
  "schemaVersion": "1.0",
  "sources": ["pinchbench@...", "aider@...", "bfcl@...", "artificial_analysis@..."],
  "models": {
    "openai/gpt-5.5": {
      "tier": "frontier",
      "scores": {
        "coding_worker": { "score": 87, "confidence": "high" },
        "research": { "score": 91, "confidence": "high" },
        "agentic": { "score": 89, "confidence": "medium" }
      },
      "lastVerifiedAt": "2026-05-12T..."
    }
  }
}
```

### 8.2 `router-wizard.json`

```jsonc
{
  "schemaVersion": "octoclaw.router.wizard/v1",
  "completedAt": "2026-05-13T...",
  "plans": {
    "openai/gpt-5.5": { "isPlan": true, "type": "subscription" },
    "zhipu/glm-5.1": { "isPlan": false, "type": "pay_as_you_go" }
  },
  "budget": { "monthly": 100, "currency": "USD" },
  "privacy": "any_cloud",
  "language": "mixed",
  "restrictedModels": ["anthropic/claude-opus-4-restricted"],
  "autoAddDiscovered": true,
  "overrides": {
    "scoreOverrides": {
      "openai/gpt-5.5:complex": 75
    },
    "dispreferredMarks": [
      { "model": "openai/gpt-5.5", "tier": "complex", "reason": "..." }
    ],
    "bans": [
      { "model": "openai/gpt-5.5", "tier": "normal" }
    ]
  }
}
```

### 8.3 `cost.sqlite` Schema

```sql
CREATE TABLE cost_events (
  ts TEXT NOT NULL,
  session_key TEXT,
  turn_id TEXT,
  model TEXT NOT NULL,
  provider TEXT,
  complexity TEXT NOT NULL CHECK(complexity IN ('simple', 'normal', 'complex', 'deep')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL,
  route TEXT CHECK(route IN ('reply', 'delegate')) NOT NULL,
  outcome TEXT CHECK(outcome IN ('success', 'failure', 'timeout', 'cancelled')) NOT NULL,
  is_plan_call INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER
);
CREATE INDEX idx_cost_ts ON cost_events(ts);
CREATE INDEX idx_cost_model ON cost_events(model);
CREATE INDEX idx_cost_complexity ON cost_events(complexity);

CREATE TABLE budget_config (
  monthly_usd REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  set_at TEXT NOT NULL
);
```

### 8.4 Shadow Event JSONL

Each line is one event:

```jsonc
{
  "ts": "2026-05-13T10:30:00Z",
  "sessionKey": "slack:C123:U456:ts789",
  "turnId": "turn-xyz",
  "snapshotId": "snap-abc",
  "judge": { "route": "delegate", "confidence": 0.82, "complexity": "complex" },
  "actualModel": "openai/gpt-5.5",
  "recommendedModel": "zhipu/glm-5.1",  // if different
  "eligibleModels": ["zhipu/glm-5.1", "openai/gpt-5.5"],
  "rejectedModels": [...],
  "reasonCodes": ["quality_floor_pass:complex", "cost_score_winner"],
  "promotionState": "shadow",  // "shadow" | "live"
  "outcome": { "success": true, "costUsd": 0.024, "latencyMs": 1430 }
}
```

---

## 9. Ambiguity Resolution

If ANY rule in this document is unclear:

1. STOP implementation
2. Check `docs/octoclaw-auto-router-v3-bdd.md` for clarifying scenario
3. If still unclear, ask in PR/issue before continuing
4. Do NOT guess — interpret conservatively (lean toward fail-open, lean toward reject recommendation, lean toward keep existing behavior)

Under this rule, "implementation latitude" is zero for the algorithms above. Every number matters.
