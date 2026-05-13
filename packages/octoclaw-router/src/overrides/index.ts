import type { ScoringContext } from "../scoring/index.js";

export type RouterComplexity = "simple" | "normal" | "complex" | "deep";

export interface RouterOverrideEntry {
  model: string;
  tier: RouterComplexity;
  type: "score" | "dispreferred" | "ban";
  value?: number;
  reason?: string;
  since: string;
}

export interface RouterOverrideConfig {
  scoreOverrides: Record<string, Partial<Record<RouterComplexity, number>>>;
  userBans: Record<string, RouterComplexity[]>;
  userDispreferred: Record<string, RouterComplexity[]>;
  entries: RouterOverrideEntry[];
}

export function createEmptyOverrides(): RouterOverrideConfig {
  return { scoreOverrides: {}, userBans: {}, userDispreferred: {}, entries: [] };
}

export function setScoreOverride(
  config: RouterOverrideConfig,
  model: string,
  tier: RouterComplexity,
  score: number,
  since: string,
): RouterOverrideConfig {
  const next = cloneOverrides(config);
  next.scoreOverrides[model] = { ...(next.scoreOverrides[model] ?? {}), [tier]: score };
  upsertEntry(next, { model, tier, type: "score", value: score, since });
  return next;
}

export function markDispreferred(
  config: RouterOverrideConfig,
  model: string,
  tier: RouterComplexity,
  since: string,
  reason?: string,
): RouterOverrideConfig {
  const next = cloneOverrides(config);
  next.userDispreferred[model] = unique([...(next.userDispreferred[model] ?? []), tier]);
  upsertEntry(next, { model, tier, type: "dispreferred", reason, since });
  return next;
}

export function banModel(
  config: RouterOverrideConfig,
  model: string,
  tier: RouterComplexity,
  since: string,
  reason?: string,
): RouterOverrideConfig {
  const next = cloneOverrides(config);
  next.userBans[model] = unique([...(next.userBans[model] ?? []), tier]);
  upsertEntry(next, { model, tier, type: "ban", reason, since });
  return next;
}

export function resetModelOverrides(config: RouterOverrideConfig, model: string): RouterOverrideConfig {
  const next = cloneOverrides(config);
  delete next.scoreOverrides[model];
  delete next.userBans[model];
  delete next.userDispreferred[model];
  next.entries = next.entries.filter((entry) => entry.model !== model);
  return next;
}

export function toScoringOverrides(config: RouterOverrideConfig): Pick<ScoringContext, "scoreOverrides" | "userBans" | "userDispreferred"> {
  return {
    scoreOverrides: config.scoreOverrides,
    userBans: config.userBans,
    userDispreferred: config.userDispreferred,
  };
}

export function renderOverrideList(config: RouterOverrideConfig, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify({ overrides: config.entries }, null, 2);
  if (config.entries.length === 0) return "No router model overrides.";
  return [
    "Router model overrides",
    ...config.entries.map((entry) => `${entry.model}  ${entry.tier}  ${entry.type}  ${entry.value ?? ""}  ${entry.reason ?? ""}  ${entry.since}`.trim()),
  ].join("\n");
}

function cloneOverrides(config: RouterOverrideConfig): RouterOverrideConfig {
  return {
    scoreOverrides: Object.fromEntries(Object.entries(config.scoreOverrides).map(([model, tiers]) => [model, { ...tiers }])),
    userBans: Object.fromEntries(Object.entries(config.userBans).map(([model, tiers]) => [model, [...tiers]])),
    userDispreferred: Object.fromEntries(Object.entries(config.userDispreferred).map(([model, tiers]) => [model, [...tiers]])),
    entries: config.entries.map((entry) => ({ ...entry })),
  };
}

function upsertEntry(config: RouterOverrideConfig, entry: RouterOverrideEntry): void {
  config.entries = config.entries.filter((candidate) => !(candidate.model === entry.model && candidate.tier === entry.tier && candidate.type === entry.type));
  config.entries.push(entry);
}

function unique(values: RouterComplexity[]): RouterComplexity[] {
  return [...new Set(values)];
}
