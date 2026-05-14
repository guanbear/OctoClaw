#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PINCHBENCH_LEADERBOARD_URL = "https://api.pinchbench.com/api/leaderboard?official=true&limit=200";
const PACKAGED_SNAPSHOT = resolve("packages/octoclaw-router/src/data/leaderboard-snapshot.json");
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

Environment:
  OCTOCLAW_ROUTER_SNAPSHOT_OUT           Output path override.
  OCTOCLAW_ROUTER_MODELS                 Comma-separated model ids.
  OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON    Test fixture: {"openrouter":...,"pinchbench":...}
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

async function loadSources() {
  const fixture = process.env.OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON;
  if (fixture) {
    const parsed = JSON.parse(fixture);
    return {
      openrouter: { ok: true, data: parsed.openrouter },
      pinchbench: { ok: true, data: parsed.pinchbench },
    };
  }

  const [openrouter, pinchbench] = await Promise.allSettled([
    fetchJson(OPENROUTER_MODELS_URL),
    fetchJson(PINCHBENCH_LEADERBOARD_URL),
  ]);
  return {
    openrouter: openrouter.status === "fulfilled" ? { ok: true, data: openrouter.value } : { ok: false, error: openrouter.reason },
    pinchbench: pinchbench.status === "fulfilled" ? { ok: true, data: pinchbench.value } : { ok: false, error: pinchbench.reason },
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

function buildModelRecord(modelKey, openrouterModel, pinchEntry, generatedAt) {
  const input = pricePerMTok(openrouterModel?.pricing?.prompt);
  const output = pricePerMTok(openrouterModel?.pricing?.completion);
  const price = round(blendedPrice(input, output));
  const tier = inferTier(modelKey);
  const score = scoreFromPercentage(pinchEntry?.best_score_percentage) ?? heuristicScoreForTier(tier);
  const confidence = pinchEntry ? confidenceFromSampleCount(pinchEntry.submission_count) : "low";
  return {
    tier,
    ...(price !== undefined ? { price } : {}),
    scores: {
      coding_worker: { score, confidence },
      research: { score: Math.max(0, Math.min(100, score - 3)), confidence },
      agentic: { score: Math.max(0, Math.min(100, score - 5)), confidence },
    },
    lastVerifiedAt: generatedAt,
  };
}

function buildSnapshot(openrouterData, pinchbenchData, requestedModels, generatedAt) {
  const openrouterModels = Array.isArray(openrouterData?.data) ? openrouterData.data : [];
  const pinchRows = Array.isArray(pinchbenchData?.leaderboard) ? pinchbenchData.leaderboard : [];
  const openrouterById = new Map(openrouterModels.map((model) => [canonicalModelKey(model.id), model]));
  const pinchByModel = new Map(pinchRows.map((entry) => [canonicalModelKey(entry.model), entry]));
  const canonicalRequestedModels = requestedModels.map(canonicalModelKey);
  const modelIds = requestedModels.length > 0
    ? canonicalRequestedModels
    : [...new Set([...DEFAULT_MODEL_IDS, ...openrouterById.keys()].filter((modelKey) => openrouterById.has(modelKey) || pinchByModel.has(modelKey)))];
  const models = {};
  for (const modelKey of modelIds) {
    const openrouterModel = openrouterById.get(modelKey);
    const pinchEntry = pinchByModel.get(modelKey);
    if (!openrouterModel && !pinchEntry) continue;
    models[modelKey] = buildModelRecord(modelKey, openrouterModel, pinchEntry, generatedAt);
  }
  return {
    snapshotVersion: generatedAt.slice(0, 10),
    schemaVersion: "1.0",
    sources: ["openrouter", "pinchbench"],
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

  const snapshot = buildSnapshot(
    sources.openrouter.ok ? sources.openrouter.data : {},
    sources.pinchbench.ok ? sources.pinchbench.data : {},
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
