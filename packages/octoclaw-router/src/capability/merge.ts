import type { ModelIntelLite, ModelIntelSnapshot, RouterLiteCodingTier, RouterLiteConfidence } from "../decision/contracts.js";
import type { CapabilityOverrideConfig, CapabilitySourceRecord, LeaderboardSnapshot, MergedCapabilitySnapshot } from "./types.js";

export function mergePriceData(
  _model: string,
  sources: Array<{ source: string; price: number }>,
): { price: number; conflict: boolean; sources: string[] } {
  if (sources.length === 0) return { price: Number.NaN, conflict: false, sources: [] };
  if (sources.length === 1) return { price: sources[0]!.price, conflict: false, sources: [sources[0]!.source] };

  const prices = sources.map((source) => source.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const conflict = min > 0 && (max - min) / min > 0.20;
  const price = conflict
    ? [...prices].sort((left, right) => left - right)[Math.floor(prices.length / 2)]!
    : prices.reduce((sum, value) => sum + value, 0) / prices.length;

  return { price, conflict, sources: sources.map((source) => source.source) };
}

export function computeFreshness(lastVerifiedAt: string | undefined, now = Date.now()): "fresh" | "stale" | "very_stale" {
  const timestamp = Date.parse(lastVerifiedAt ?? "");
  if (Number.isNaN(timestamp)) return "very_stale";

  const ageDays = (now - timestamp) / (1000 * 60 * 60 * 24);
  if (ageDays < 14) return "fresh";
  if (ageDays < 90) return "stale";
  return "very_stale";
}

export function modelFromLeaderboard(modelKey: string, snapshot: LeaderboardSnapshot): ModelIntelLite | null {
  const record = snapshot.models[modelKey];
  if (!record) return null;
  return createModelIntel({
    modelKey,
    tier: record.tier,
    price: record.price,
    confidence: record.scores.coding_worker?.confidence ?? "medium",
    source: "packaged_leaderboard",
    freshness: record.lastVerifiedAt,
  });
}

export function modelFromSourceRecord(record: CapabilitySourceRecord, fallbackSource = "external"): ModelIntelLite {
  return createModelIntel({
    modelKey: record.modelKey,
    tier: record.tier ?? "unknown",
    price: record.price,
    confidence: record.confidence ?? "low",
    source: record.source ?? fallbackSource,
  });
}

export function createHeuristicModel(modelKey: string): ModelIntelLite {
  return createModelIntel({
    modelKey,
    tier: "unknown",
    confidence: "low",
    source: "heuristic",
  });
}

export function mergeCapabilitySnapshot(
  snapshot: ModelIntelSnapshot,
  overrides: CapabilityOverrideConfig,
): MergedCapabilitySnapshot {
  return { snapshot, overrides };
}

function createModelIntel(input: {
  modelKey: string;
  tier: RouterLiteCodingTier;
  price?: number;
  confidence: RouterLiteConfidence;
  source: string;
  freshness?: string;
}): ModelIntelLite {
  const [provider = "unknown", model = input.modelKey] = input.modelKey.split("/");
  return {
    provider,
    model,
    modelKey: input.modelKey,
    configured: true,
    available: "yes",
    proposalOnly: false,
    tags: [],
    marketPrice: {
      blendedUsdPerMTok: input.price,
      confidence: input.price === undefined ? "unknown" : input.confidence,
      sources: input.price === undefined ? [] : [input.source],
    },
    capability: {
      input: ["text"],
      toolUse: "yes",
      structuredOutput: "yes",
      reasoning: "yes",
      promptCache: "unknown",
      codingTier: input.tier,
      confidence: input.confidence,
      evidence: [input.source === "heuristic" ? "heuristic" : "declared"],
      sources: [input.source],
    },
    health: {
      available: "yes",
      cooldown: false,
      quotaPressure: "unknown",
      sources: [],
    },
    plan: {
      type: "unknown",
      quotaPressure: "unknown",
      effectiveCostBand: "unknown",
      sources: [],
    },
    freshness: input.freshness,
    sources: [input.source],
  };
}
