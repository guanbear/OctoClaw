export type LeaderboardScenario = "coding_worker" | "research" | "agentic";

export interface LeaderboardSourceRecord {
  source: string;
  modelKey: string;
  scenario: LeaderboardScenario;
  rawScore: number;
  sampleCount?: number;
  lastVerifiedAt: string;
}

export function canonicalLeaderboardModelKey(modelKey: string): string {
  const trimmed = modelKey.trim();
  if (trimmed.startsWith("z-ai/glm-")) return `zhipu/${trimmed.slice("z-ai/".length)}`;
  return trimmed;
}

export function normalizeLeaderboardScore(value: number): number {
  const score = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
}
