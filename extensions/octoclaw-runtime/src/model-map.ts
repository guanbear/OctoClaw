/**
 * Dynamic model map: reads OpenClaw's configured models (openclaw models list --json)
 * and maps complexity/budget bands to actual model IDs based on fallback rank.
 *
 * Fallback rank is the user's implicit capability ordering:
 *   default     = most capable (main model)
 *   fallback#1  = balanced
 *   fallback#2  = fast/cheap
 *   local       = cheap when no explicit cheap fallback exists
 *
 * Users can override any band in ~/.octoclaw/config.json models.overrides.
 * Falls back to hardcoded defaults if openclaw CLI is unavailable.
 */

import { runCommand, resolveWorkspaceRoot } from "./resolve/env.js";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJsonSync } from "./util/atomic-write.js";

export interface ModelBandMap {
  simple: string;
  normal: string;
  complex: string;
  deep: string;
}

export interface BudgetBandMap {
  low: string;
  medium: string;
  high: string;
}

export interface ResolvedModelMap {
  complexity: ModelBandMap;
  budget: BudgetBandMap;
  generatedAt: string;
  source: "openclaw_models" | "fallback_defaults" | "user_override";
}

// Hardcoded defaults — used when openclaw CLI is unavailable
const FALLBACK_DEFAULTS: ResolvedModelMap = {
  complexity: {
    simple: "minimax-portal/MiniMax-M2.7-highspeed",
    normal: "zhipu/GLM-5.1",
    complex: "zhipu/GLM-5.1",
    deep: "cliproxyapi/gpt-5.5",
  },
  budget: {
    low: "minimax-portal/MiniMax-M2.7-highspeed",
    medium: "zhipu/GLM-5.1",
    high: "cliproxyapi/gpt-5.5",
  },
  generatedAt: new Date().toISOString(),
  source: "fallback_defaults",
};

// In-memory cache: refresh every 5 minutes
let _cache: ResolvedModelMap | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface OpenClawModel {
  key: string;
  local?: boolean;
  available?: boolean;
  tags?: string[];
}

type CodingTier = "mini" | "standard" | "strong" | "frontier" | "unknown";

const TIER_FLOOR: Record<string, number> = { mini: 1, standard: 2, strong: 3, frontier: 4, unknown: 0 };

interface SnapshotModel {
  modelKey: string;
  configured?: boolean;
  available?: string | boolean;
  proposalOnly?: boolean;
  health?: { available?: string | boolean; cooldown?: boolean };
  capability?: { codingTier?: CodingTier };
  marketPrice?: { blendedUsdPerMTok?: number };
}

function meetsFloor(model: SnapshotModel, floor: CodingTier): boolean {
  const tier = model.capability?.codingTier ?? "unknown";
  return TIER_FLOOR[tier] >= TIER_FLOOR[floor];
}

function isSelectable(model: SnapshotModel): boolean {
  if (model.proposalOnly) return false;
  if (model.configured !== true) return false;
  const health = model.health;
  if (health?.cooldown) return false;
  const avail = health?.available ?? model.available;
  if (avail === "no" || avail === false) return false;
  return true;
}

function priceSortKey(price: number | undefined): number {
  if (price === undefined || price <= 0) return Infinity;
  return price;
}

function compareForCost(a: SnapshotModel, b: SnapshotModel): number {
  const priceA = priceSortKey(a.marketPrice?.blendedUsdPerMTok);
  const priceB = priceSortKey(b.marketPrice?.blendedUsdPerMTok);
  if (priceA !== priceB) return priceA - priceB;
  const tierA = TIER_FLOOR[a.capability?.codingTier ?? "unknown"];
  const tierB = TIER_FLOOR[b.capability?.codingTier ?? "unknown"];
  if (tierA !== tierB) return tierB - tierA;
  return (a.modelKey ?? "").localeCompare(b.modelKey ?? "");
}

function cheapestMeetingFloor(models: SnapshotModel[], floor: CodingTier): string | undefined {
  const eligible = models.filter((m) => isSelectable(m) && meetsFloor(m, floor));
  if (eligible.length === 0) return undefined;
  eligible.sort(compareForCost);
  return eligible[0].modelKey;
}

function nativeModelMeetingFloor(models: SnapshotModel[], modelKey: string, floor: CodingTier): string | undefined {
  const model = models.find((candidate) => candidate.modelKey.toLowerCase() === modelKey.toLowerCase()
    && isSelectable(candidate)
    && meetsFloor(candidate, floor));
  return model?.modelKey;
}

function parseSnapshotModels(raw: string): SnapshotModel[] | undefined {
  const parsed = JSON.parse(raw) as { models?: SnapshotModel[] };
  return Array.isArray(parsed.models) ? parsed.models : undefined;
}

function defaultSnapshotPath(): string {
  return path.join(os.homedir(), ".openclaw", "workspace", "tmp", "octopus", "router-lite", "model-intel-snapshot.json");
}

function readSnapshotModels(): SnapshotModel[] | undefined {
  const raw = process.env.OCTOCLAW_ROUTER_SNAPSHOT_JSON;
  if (raw) {
    try {
      return parseSnapshotModels(raw);
    } catch {
      return undefined;
    }
  }

  const snapshotPath = process.env.OCTOCLAW_ROUTER_SNAPSHOT_PATH?.trim() || defaultSnapshotPath();
  try {
    return parseSnapshotModels(fsSync.readFileSync(snapshotPath, "utf-8"));
  } catch {
    return undefined;
  }
}

function applySnapshotTierSelection(map: ResolvedModelMap, snapshotModels: SnapshotModel[]): ResolvedModelMap {
  const simple = cheapestMeetingFloor(snapshotModels, "mini");
  const normal = cheapestMeetingFloor(snapshotModels, "standard");
  const complex = nativeModelMeetingFloor(snapshotModels, map.complexity.complex, "strong")
    ?? cheapestMeetingFloor(snapshotModels, "strong");
  const deep = cheapestMeetingFloor(snapshotModels, "frontier");

  return {
    ...map,
    complexity: {
      simple: simple ?? map.complexity.simple,
      normal: normal ?? map.complexity.normal,
      complex: complex ?? map.complexity.complex,
      deep: deep ?? map.complexity.deep,
    },
  };
}

function mapFromOpenClawModels(models: OpenClawModel[]): ResolvedModelMap {
  const available = models.filter((m) => m.available !== false);

  const defaultModel  = available.find((m) => m.tags?.includes("default"))?.key;
  const fallback1     = available.find((m) => m.tags?.includes("fallback#1"))?.key;
  const fallback2     = available.find((m) => m.tags?.includes("fallback#2"))?.key;
  const fallback3     = available.find((m) => m.tags?.includes("fallback#3"))?.key;
  const localModel    = available.find((m) => m.local === true)?.key;

  const cheap = fallback3 ?? fallback2 ?? localModel ?? fallback1 ?? defaultModel ?? "";
  const balanced = fallback1 ?? defaultModel ?? cheap;
  const capable = defaultModel ?? fallback1 ?? balanced;

  return {
    complexity: {
      simple: cheap,
      normal: balanced,
      complex: fallback1 ?? balanced,
      deep: capable,
    },
    budget: {
      low: cheap,
      medium: balanced,
      high: capable,
    },
    generatedAt: new Date().toISOString(),
    source: "openclaw_models",
  };
}

function applyUserOverrides(map: ResolvedModelMap, overrides: Record<string, string>): ResolvedModelMap {
  if (!overrides || Object.keys(overrides).length === 0) return map;
  return {
    ...map,
    complexity: {
      simple: overrides["simple"] ?? map.complexity.simple,
      normal: overrides["normal"] ?? map.complexity.normal,
      complex: overrides["complex"] ?? map.complexity.complex,
      deep:   overrides["deep"]   ?? map.complexity.deep,
    },
    budget: {
      low:    overrides["low"]    ?? map.budget.low,
      medium: overrides["medium"] ?? map.budget.medium,
      high:   overrides["high"]   ?? map.budget.high,
    },
    source: "user_override",
  };
}

function readUserOverrides(): Record<string, string> {
  try {
    const configPath = path.join(resolveWorkspaceRoot(), "..", ".octoclaw", "config.json");
    const raw = JSON.parse(fsSync.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const models = raw.models as Record<string, unknown> | undefined;
    const overrides = models?.overrides;
    if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
      return overrides as Record<string, string>;
    }
  } catch { /* config not found or invalid */ }
  return {};
}

export async function buildModelMap(): Promise<ResolvedModelMap> {
  try {
    const result = await runCommand("openclaw", ["models", "list", "--json"], {
      timeoutMs: 5000,
    });
    if (result.code !== 0 || !result.stdout.trim()) {
      return applyUserOverrides(FALLBACK_DEFAULTS, readUserOverrides());
    }
    const parsed = JSON.parse(result.stdout) as { models?: OpenClawModel[] };
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    if (models.length === 0) {
      return applyUserOverrides(FALLBACK_DEFAULTS, readUserOverrides());
    }
    let map = mapFromOpenClawModels(models);
    const snapshotModels = readSnapshotModels();
    if (snapshotModels && snapshotModels.length > 0) {
      map = applySnapshotTierSelection(map, snapshotModels);
    }
    return applyUserOverrides(map, readUserOverrides());
  } catch {
    return applyUserOverrides(FALLBACK_DEFAULTS, readUserOverrides());
  }
}

/** Get model map with in-memory cache (5-min TTL). Never throws. */
export async function getModelMap(): Promise<ResolvedModelMap> {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  try {
    _cache = await buildModelMap();
    _cacheAt = now;
    // Persist to disk for debugging / octoclawctl status
    try {
      const cachePath = path.join(resolveWorkspaceRoot(), ".octoclaw", "model-map.json");
      fsSync.mkdirSync(path.dirname(cachePath), { recursive: true });
      atomicWriteJsonSync(cachePath, _cache);
    } catch { /* best effort */ }
    return _cache;
  } catch {
    return FALLBACK_DEFAULTS;
  }
}

/** Invalidate cache (call after config changes) */
export function invalidateModelMapCache(): void {
  _cache = null;
  _cacheAt = 0;
}
