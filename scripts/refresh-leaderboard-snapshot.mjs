#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PINCHBENCH_LEADERBOARD_URL = "https://api.pinchbench.com/api/leaderboard?official=true&limit=200";
const AIDER_EDIT_LEADERBOARD_URL = "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml";
const BFCL_LEADERBOARD_URL = "https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/result/leaderboard.json";
const PACKAGED_SNAPSHOT = resolve("packages/octoclaw-router/src/data/leaderboard-snapshot.json");
const SOURCE_WEIGHTS = resolve("packages/octoclaw-router/src/data/source-weights.json");
const DEFAULT_TARGET = resolve("packages/octoclaw-router/src/data/leaderboard-snapshot.json");
const DEFAULT_MODEL_IDS = [
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5-mini",
  "openai/gpt-4o-mini",
  "z-ai/glm-5.1",
  "z-ai/glm-4.7",
  "deepseek/deepseek-v4",
  "deepseek/deepseek-v4-pro",
  "anthropic/claude-sonnet-4.6",
  "qwen/qwen3-coder",
];

function parseArgs(argv) {
	  const args = {
	    output: process.env.OCTOCLAW_ROUTER_SNAPSHOT_OUT ?? DEFAULT_TARGET,
	    models: (process.env.OCTOCLAW_ROUTER_MODELS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
	    checkSeed: false,
	  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      args.output = argv[++index] ?? args.output;
    } else if (arg.startsWith("--output=")) {
      args.output = arg.slice("--output=".length);
    } else if (arg === "--models") {
      args.models = (argv[++index] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
	    } else if (arg.startsWith("--models=")) {
	      args.models = arg.slice("--models=".length).split(",").map((item) => item.trim()).filter(Boolean);
	    } else if (arg === "--check-seed") {
	      args.checkSeed = true;
	    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/refresh-leaderboard-snapshot.mjs [options]

Options:
	  --output <file>   Output leaderboard-snapshot.json path.
	  --models <csv>   Comma-separated model ids to include.
	  --check-seed     Exit non-zero if generated seed has fewer than 30 models.

Environment:
  OCTOCLAW_ROUTER_SNAPSHOT_OUT           Output path override.
  OCTOCLAW_ROUTER_MODELS                 Comma-separated model ids.
	  OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON    Test fixture: {"openrouter":...,"pinchbench":...,"aider":"...","bfcl":...}
	`);
	}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "octoclaw-router-snapshot/0.6" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "text/plain, application/json", "user-agent": "octoclaw-router-snapshot/0.6" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function loadSources() {
  const fixture = process.env.OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON;
  if (fixture) {
    const parsed = JSON.parse(fixture);
	    return {
	      openrouter: { ok: true, data: parsed.openrouter },
	      pinchbench: { ok: true, data: parsed.pinchbench },
	      aider: { ok: true, data: parsed.aider ?? "" },
	      bfcl: { ok: true, data: parsed.bfcl ?? {} },
	    };
	  }

	  const [openrouter, pinchbench, aider, bfcl] = await Promise.allSettled([
	    fetchJson(OPENROUTER_MODELS_URL),
	    fetchJson(PINCHBENCH_LEADERBOARD_URL),
	    fetchText(AIDER_EDIT_LEADERBOARD_URL),
	    fetchJson(BFCL_LEADERBOARD_URL),
	  ]);
	  return {
	    openrouter: openrouter.status === "fulfilled" ? { ok: true, data: openrouter.value } : { ok: false, error: openrouter.reason },
	    pinchbench: pinchbench.status === "fulfilled" ? { ok: true, data: pinchbench.value } : { ok: false, error: pinchbench.reason },
	    aider: aider.status === "fulfilled" ? { ok: true, data: aider.value } : { ok: false, error: aider.reason },
	    bfcl: bfcl.status === "fulfilled" ? { ok: true, data: bfcl.value } : { ok: false, error: bfcl.reason },
	  };
	}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function round(value, digits = 6) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pricePerMTok(value) {
  const parsed = asNumber(value);
  return parsed === undefined ? undefined : parsed * 1_000_000;
}

function blendedPrice(input, output) {
  if (input === undefined && output === undefined) return undefined;
  return ((input ?? 0) * 3 + (output ?? 0)) / 4;
}

function inferTier(modelKey) {
  const normalized = modelKey.toLowerCase();
  if (normalized.includes("mini") || normalized.includes("nano") || normalized.includes("flash") || normalized.includes("haiku")) return "mini";
  if (normalized.includes("5.5") || normalized.includes("opus")) return "frontier";
  if (normalized.includes("5.4") || normalized.includes("5.1") || normalized.includes("glm-4.7") || normalized.includes("sonnet")) return "strong";
  return "standard";
}

function canonicalModelKey(modelKey) {
  if (modelKey.startsWith("z-ai/glm-")) return `zhipu/${modelKey.slice("z-ai/".length)}`;
  return modelKey;
}

function normalizeScore(value) {
  const parsed = asNumber(value);
  if (parsed === undefined) return undefined;
  const score = parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, Math.round(score * 100) / 100));
}

const AiderRowSchema = z.object({
  model: z.string().min(1),
  pass_rate_2: z.coerce.number().optional(),
  pass_rate: z.coerce.number().optional(),
  score: z.coerce.number().optional(),
  exercises: z.coerce.number().optional(),
  sample_count: z.coerce.number().optional(),
  date: z.string().optional(),
  last_updated: z.string().optional(),
});

const AiderSchema = z.union([
  z.object({ results: z.array(AiderRowSchema) }),
  z.object({ leaderboard: z.array(AiderRowSchema) }),
  z.array(AiderRowSchema),
]);

const BfclRowSchema = z.object({
  model: z.string().min(1),
  overall_accuracy: z.coerce.number().optional(),
  accuracy: z.coerce.number().optional(),
  score: z.coerce.number().optional(),
  sample_count: z.coerce.number().optional(),
  total_count: z.coerce.number().optional(),
  last_updated: z.string().optional(),
  date: z.string().optional(),
});

const BfclSchema = z.union([
  z.object({ leaderboard: z.array(BfclRowSchema) }),
  z.object({ results: z.array(BfclRowSchema) }),
  z.array(BfclRowSchema),
]);

function rowsFromParsed(parsed, primaryKey) {
  if (Array.isArray(parsed)) return parsed;
  return parsed[primaryKey] ?? parsed.results ?? [];
}

function parseAiderLeaderboard(raw) {
  try {
    const parsed = AiderSchema.safeParse(parseYaml(String(raw ?? "")));
    if (!parsed.success) return [];
    return rowsFromParsed(parsed.data, "leaderboard").flatMap((row) => {
      const rawScore = normalizeScore(row.pass_rate_2 ?? row.pass_rate ?? row.score);
      if (rawScore === undefined) return [];
      return [{
        source: "aider",
        modelKey: canonicalModelKey(row.model),
        scenario: "coding_worker",
        rawScore,
        sampleCount: row.exercises ?? row.sample_count,
        lastVerifiedAt: row.date ?? row.last_updated ?? new Date(0).toISOString(),
      }];
    });
  } catch {
    return [];
  }
}

function parseBfclLeaderboard(raw) {
  try {
    const parsed = BfclSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (!parsed.success) return [];
    return rowsFromParsed(parsed.data, "leaderboard").flatMap((row) => {
      const rawScore = normalizeScore(row.overall_accuracy ?? row.accuracy ?? row.score);
      if (rawScore === undefined) return [];
      return [{
        source: "bfcl",
        modelKey: canonicalModelKey(row.model),
        scenario: "agentic",
        rawScore,
        sampleCount: row.sample_count ?? row.total_count,
        lastVerifiedAt: row.last_updated ?? row.date ?? new Date(0).toISOString(),
      }];
    });
  } catch {
    return [];
  }
}

function computeFreshnessFactor(lastVerifiedAt, now = Date.now()) {
  const timestamp = Date.parse(lastVerifiedAt ?? "");
  if (Number.isNaN(timestamp)) return 0.15;
  const ageDays = (now - timestamp) / (1000 * 60 * 60 * 24);
  if (ageDays < 30) return 1;
  if (ageDays < 90) return 0.7;
  if (ageDays < 180) return 0.4;
  return 0.15;
}

function fuseScenarioScore(contributions, weights, health, now) {
  if (contributions.length === 0) {
    return { score: 0, confidence: "unknown", contributions: [], reasonCodes: ["no_contributions"] };
  }
  const rows = contributions
    .filter((entry) => Number.isFinite(entry.rawScore) && entry.rawScore >= 0 && entry.rawScore <= 100)
    .map((entry) => {
      const baseWeight = weights[entry.source] ?? 0;
      const freshnessFactor = computeFreshnessFactor(entry.lastVerifiedAt, now);
      const sourceHealth = health[entry.source] ?? 0;
      return {
        source: entry.source,
        rawScore: entry.rawScore,
        baseWeight,
        freshnessFactor,
        sourceHealth,
        effectiveWeight: baseWeight * freshnessFactor * sourceHealth,
      };
    });
  const totalEffectiveWeight = rows.reduce((sum, entry) => sum + entry.effectiveWeight, 0);
  if (totalEffectiveWeight <= 0) {
    return { score: 0, confidence: "unknown", contributions: rows, reasonCodes: ["no_usable_contributions"] };
  }
  const score = rows.reduce((sum, entry) => sum + entry.rawScore * (entry.effectiveWeight / totalEffectiveWeight), 0);
  const confidence = totalEffectiveWeight >= 0.7 ? "high" : totalEffectiveWeight >= 0.4 ? "medium" : "low";
  return {
    score: Math.round(score * 100) / 100,
    confidence,
    contributions: rows,
    reasonCodes: [`fusion_sources:${rows.filter((entry) => entry.effectiveWeight > 0).length}`],
  };
}

function loadSourceWeights() {
  const parsed = JSON.parse(readFileSync(SOURCE_WEIGHTS, "utf8"));
  for (const [scenario, weights] of Object.entries(parsed.weights ?? {})) {
    const sum = Object.values(weights).reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > 0.000001) {
      throw new Error(`source weights for ${scenario} must sum to 1.0; got ${sum}`);
    }
  }
  return parsed.weights;
}

function confidenceFromSampleCount(count) {
  const parsed = asNumber(count) ?? 0;
  if (parsed >= 10) return "high";
  if (parsed >= 3) return "medium";
  return "low";
}

function scoreFromPercentage(value) {
  const parsed = asNumber(value);
  if (parsed === undefined) return undefined;
  return Math.round(parsed <= 1 ? parsed * 100 : parsed);
}

function heuristicScoreForTier(tier) {
  if (tier === "frontier") return 90;
  if (tier === "strong") return 76;
  if (tier === "standard") return 65;
  if (tier === "mini") return 45;
  return 40;
}

function buildModelRecord(modelKey, openrouterModel, pinchEntry, leaderboardRecords, sourceWeights, sourceHealth, generatedAt) {
  const input = pricePerMTok(openrouterModel?.pricing?.prompt);
  const output = pricePerMTok(openrouterModel?.pricing?.completion);
  const price = round(blendedPrice(input, output));
  const tier = inferTier(modelKey);
	  const score = scoreFromPercentage(pinchEntry?.best_score_percentage) ?? heuristicScoreForTier(tier);
	  const confidence = pinchEntry ? confidenceFromSampleCount(pinchEntry.submission_count) : "low";
	  const scenarioContributions = {
	    coding_worker: [
	      ...(pinchEntry ? [{ source: "pinchbench", rawScore: score, lastVerifiedAt: generatedAt }] : []),
	      ...leaderboardRecords.filter((entry) => entry.scenario === "coding_worker"),
	    ],
	    agentic: leaderboardRecords.filter((entry) => entry.scenario === "agentic"),
	  };
	  const scoreByScenario = {};
	  for (const [scenario, contributions] of Object.entries(scenarioContributions)) {
	    const fused = fuseScenarioScore(contributions, sourceWeights[scenario] ?? {}, sourceHealth, Date.parse(generatedAt));
	    if (fused.confidence !== "unknown") {
	      scoreByScenario[scenario] = fused;
	    }
	  }
	  return {
	    tier,
	    ...(price !== undefined ? { price } : {}),
    scores: {
      coding_worker: { score, confidence },
      research: { score: Math.max(0, Math.min(100, score - 3)), confidence },
      agentic: { score: Math.max(0, Math.min(100, score - 5)), confidence },
	    },
	    ...(Object.keys(scoreByScenario).length > 0 ? { scoreByScenario } : {}),
	    lastVerifiedAt: generatedAt,
	  };
	}

function buildSnapshot(openrouterData, pinchbenchData, leaderboardRecords, sourceStatus, requestedModels, generatedAt) {
	  const sourceWeights = loadSourceWeights();
	  const sourceHealth = {
	    openrouter: sourceStatus.openrouter ? 1 : 0,
	    pinchbench: sourceStatus.pinchbench ? 1 : 0,
	    aider: sourceStatus.aider ? 1 : 0,
	    bfcl: sourceStatus.bfcl ? 1 : 0,
	    artificial_analysis: 1,
	  };
	  const openrouterModels = Array.isArray(openrouterData?.data) ? openrouterData.data : [];
	  const pinchRows = Array.isArray(pinchbenchData?.leaderboard) ? pinchbenchData.leaderboard : [];
	  const openrouterById = new Map(openrouterModels.map((model) => [canonicalModelKey(model.id), model]));
	  const pinchByModel = new Map(pinchRows.map((entry) => [canonicalModelKey(entry.model), entry]));
	  const leaderboardByModel = new Map();
	  for (const record of leaderboardRecords) {
	    const current = leaderboardByModel.get(record.modelKey) ?? [];
	    current.push(record);
	    leaderboardByModel.set(record.modelKey, current);
	  }
	  const canonicalRequestedModels = requestedModels.map(canonicalModelKey);
	  const modelIds = requestedModels.length > 0
	    ? canonicalRequestedModels
	    : [...new Set([...DEFAULT_MODEL_IDS.map(canonicalModelKey), ...openrouterById.keys(), ...pinchByModel.keys(), ...leaderboardByModel.keys()].filter((modelKey) => openrouterById.has(modelKey) || pinchByModel.has(modelKey) || leaderboardByModel.has(modelKey)))];
	  const models = {};
	  for (const modelKey of modelIds) {
	    const openrouterModel = openrouterById.get(modelKey);
	    const pinchEntry = pinchByModel.get(modelKey);
	    const records = leaderboardByModel.get(modelKey) ?? [];
	    if (!openrouterModel && !pinchEntry && records.length === 0) continue;
	    models[modelKey] = buildModelRecord(modelKey, openrouterModel, pinchEntry, records, sourceWeights, sourceHealth, generatedAt);
	  }
	  return {
	    snapshotVersion: generatedAt.slice(0, 10),
	    schemaVersion: "1.0",
	    sources: ["openrouter", "pinchbench", "aider", "bfcl"],
	    models,
	  };
	}

function fallbackCopy(target, reason) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(PACKAGED_SNAPSHOT, target);
  console.warn(`[router-lite] external refresh failed; copied packaged snapshot to ${target}: ${reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolve(args.output);
  const generatedAt = new Date().toISOString();
  const sources = await loadSources();

  if (!sources.openrouter.ok && !sources.pinchbench.ok) {
    fallbackCopy(target, `${sources.openrouter.error}; ${sources.pinchbench.error}`);
    return;
  }

	  const aiderRecords = sources.aider.ok ? parseAiderLeaderboard(sources.aider.data) : [];
	  const bfclRecords = sources.bfcl.ok ? parseBfclLeaderboard(sources.bfcl.data) : [];
	  const snapshot = buildSnapshot(
	    sources.openrouter.ok ? sources.openrouter.data : {},
	    sources.pinchbench.ok ? sources.pinchbench.data : {},
	    [...aiderRecords, ...bfclRecords],
	    {
	      openrouter: sources.openrouter.ok,
	      pinchbench: sources.pinchbench.ok,
	      aider: sources.aider.ok && aiderRecords.length > 0,
	      bfcl: sources.bfcl.ok && bfclRecords.length > 0,
	    },
	    args.models,
	    generatedAt,
	  );

  if (Object.keys(snapshot.models).length === 0) {
    const packaged = JSON.parse(readFileSync(PACKAGED_SNAPSHOT, "utf8"));
    snapshot.models = packaged.models ?? {};
    snapshot.sources.push("packaged_fallback");
  }

	  mkdirSync(dirname(target), { recursive: true });
	  writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	  console.log(`[router-lite] refreshed leaderboard snapshot: ${target} models=${Object.keys(snapshot.models).length}`);
	  if (args.checkSeed && Object.keys(snapshot.models).length < 30) {
	    console.error(`[router-lite] seed check failed: expected >=30 models, got ${Object.keys(snapshot.models).length}`);
	    process.exit(1);
	  }
	}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
