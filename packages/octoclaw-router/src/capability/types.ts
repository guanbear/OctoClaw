import type { ModelIntelLite, ModelIntelSnapshot, RouterLiteCodingTier, RouterLiteConfidence } from "../decision/contracts.js";

export interface LeaderboardScore {
  score: number;
  confidence: RouterLiteConfidence;
}

export interface LeaderboardModelRecord {
  tier: RouterLiteCodingTier;
  price?: number;
  scores: {
    coding_worker?: LeaderboardScore;
    research?: LeaderboardScore;
    agentic?: LeaderboardScore;
  };
  lastVerifiedAt?: string;
}

export interface LeaderboardSnapshot {
  snapshotVersion: string;
  schemaVersion: "1.0";
  sources: string[];
  models: Record<string, LeaderboardModelRecord>;
}

export interface CapabilitySourceRecord {
  modelKey: string;
  price?: number;
  tier?: RouterLiteCodingTier;
  confidence?: RouterLiteConfidence;
  source?: string;
}

export interface CapabilitySource {
  name: string;
  fetch: () => Promise<CapabilitySourceRecord[]>;
}

export interface CapabilityOverrideConfig {
  scoreOverrides: Record<string, Partial<Record<ModelIntelLite["capability"]["codingTier"] | "simple" | "normal" | "complex" | "deep", number>>>;
  userBans?: Record<string, string[]>;
  userDispreferred?: Record<string, string[]>;
}

export interface MergedCapabilitySnapshot {
  snapshot: ModelIntelSnapshot;
  overrides: CapabilityOverrideConfig;
}
