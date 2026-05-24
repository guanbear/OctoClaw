#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PINCHBENCH_LEADERBOARD_URL = "https://api.pinchbench.com/api/leaderboard?official=true&limit=200";
const AIDER_EDIT_LEADERBOARD_URL = "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml";
const BFCL_LEADERBOARD_URL = "https://gorilla.cs.berkeley.edu/data_overall.csv";
const SWEBENCH_VERIFIED_LEADERBOARD_URL = "https://huggingface.co/api/datasets/SWE-bench/SWE-bench_Verified/leaderboard";
const SWEBENCH_PRO_LEADERBOARD_URL = "https://huggingface.co/api/datasets/ScaleAI/SWE-bench_Pro/leaderboard";
const LMARENA_ROWS_BASE_URL = "https://datasets-server.huggingface.co/rows";
const ARTIFICIAL_ANALYSIS_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
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
	  OCTOCLAW_ROUTER_SOURCE_FIXTURE_JSON    Test fixture: {"openrouter":...,"pinchbench":...,"aider":"...","bfcl":...,"sweBenchVerified":[...],"sweBenchPro":[...],"lmarenaText":...,"artificialAnalysis":...}
	`);
	}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "octoclaw-router-snapshot/0.6", ...headers },
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

async function fetchArtificialAnalysisModels() {
  const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "missing_auth", authMissing: true };
  try {
    const data = await fetchJson(ARTIFICIAL_ANALYSIS_MODELS_URL, { "x-api-key": apiKey });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error };
  }
}

function lmArenaRowsUrl(config) {
  const url = new URL(LMARENA_ROWS_BASE_URL);
  url.searchParams.set("dataset", "lmarena-ai/leaderboard-dataset");
  url.searchParams.set("config", config);
  url.searchParams.set("split", "latest");
  url.searchParams.set("offset", "0");
  url.searchParams.set("length", "100");
  return url.toString();
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
	      sweBenchVerified: { ok: true, data: parsed.sweBenchVerified ?? [] },
	      sweBenchPro: { ok: true, data: parsed.sweBenchPro ?? [] },
	      lmarenaText: { ok: true, data: parsed.lmarenaText ?? { rows: [] } },
	      lmarenaWebdev: { ok: true, data: parsed.lmarenaWebdev ?? { rows: [] } },
	      lmarenaSearch: { ok: true, data: parsed.lmarenaSearch ?? { rows: [] } },
	      artificialAnalysis: parsed.artificialAnalysis === undefined
	        ? { ok: false, error: "missing_auth", authMissing: true }
	        : { ok: true, data: parsed.artificialAnalysis },
	    };
	  }

	  const [openrouter, pinchbench, aider, bfcl, sweBenchVerified, sweBenchPro, lmarenaText, lmarenaWebdev, lmarenaSearch, artificialAnalysis] = await Promise.allSettled([
	    fetchJson(OPENROUTER_MODELS_URL),
	    fetchJson(PINCHBENCH_LEADERBOARD_URL),
	    fetchText(AIDER_EDIT_LEADERBOARD_URL),
	    fetchText(BFCL_LEADERBOARD_URL),
	    fetchJson(SWEBENCH_VERIFIED_LEADERBOARD_URL),
	    fetchJson(SWEBENCH_PRO_LEADERBOARD_URL),
	    fetchJson(lmArenaRowsUrl("text")),
	    fetchJson(lmArenaRowsUrl("webdev")),
	    fetchJson(lmArenaRowsUrl("search")),
	    fetchArtificialAnalysisModels(),
	  ]);
	  return {
	    openrouter: openrouter.status === "fulfilled" ? { ok: true, data: openrouter.value } : { ok: false, error: openrouter.reason },
	    pinchbench: pinchbench.status === "fulfilled" ? { ok: true, data: pinchbench.value } : { ok: false, error: pinchbench.reason },
	    aider: aider.status === "fulfilled" ? { ok: true, data: aider.value } : { ok: false, error: aider.reason },
	    bfcl: bfcl.status === "fulfilled" ? { ok: true, data: bfcl.value } : { ok: false, error: bfcl.reason },
	    sweBenchVerified: sweBenchVerified.status === "fulfilled" ? { ok: true, data: sweBenchVerified.value } : { ok: false, error: sweBenchVerified.reason },
	    sweBenchPro: sweBenchPro.status === "fulfilled" ? { ok: true, data: sweBenchPro.value } : { ok: false, error: sweBenchPro.reason },
	    lmarenaText: lmarenaText.status === "fulfilled" ? { ok: true, data: lmarenaText.value } : { ok: false, error: lmarenaText.reason },
	    lmarenaWebdev: lmarenaWebdev.status === "fulfilled" ? { ok: true, data: lmarenaWebdev.value } : { ok: false, error: lmarenaWebdev.reason },
	    lmarenaSearch: lmarenaSearch.status === "fulfilled" ? { ok: true, data: lmarenaSearch.value } : { ok: false, error: lmarenaSearch.reason },
	    artificialAnalysis: artificialAnalysis.status === "fulfilled" ? artificialAnalysis.value : { ok: false, error: artificialAnalysis.reason },
	  };
	}

function asNumber(value) {
  const normalized = typeof value === "string" ? value.trim().replace(/%$/u, "") : value;
  const parsed = Number(normalized);
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
  if (/(^|[/._\-\s])(mini|nano|flash|haiku|small|lite|air)([/._\-\s]|$)/.test(normalized)) return "mini";
  if (/(^|[/._\-\s])(opus|ultra|frontier)([/._\-\s]|$)/.test(normalized)) return "frontier";
  if (/(^|[/._\-\s])(pro|max|plus|sonnet)([/._\-\s]|$)/.test(normalized)) return "strong";
  const versions = Array.from(normalized.matchAll(/(?:^|[/._\-\s]|[a-z])(?:v)?(\d+)(?:[._-](\d+))?/g))
    .map((match) => ({
      major: Number(match[1]),
      minor: match[2] === undefined ? 0 : Number(`0.${match[2]}`),
    }))
    .filter((version) => Number.isFinite(version.major) && Number.isFinite(version.minor));
  if (versions.some((version) => version.major > 5 || (version.major === 5 && version.minor >= 0.5))) return "frontier";
  if (versions.some((version) => version.major >= 4)) return "strong";
  return "standard";
}

function canonicalModelKey(modelKey) {
  const normalized = String(modelKey ?? "").trim().toLowerCase()
    .replace(/^openrouter\//, "")
    .replace(/^anthropic\/claude-3-/, "anthropic/claude-")
    .replace(/^anthropic\/claude-(opus|sonnet)-(\d+)-(\d+)/, "anthropic/claude-$1-$2.$3")
    .replace(/^claude-(opus|sonnet)-(\d+)-(\d+)/, "anthropic/claude-$1-$2.$3")
    .replace(/^claude-(opus|sonnet)-(\d+)\.(\d+)/, "anthropic/claude-$1-$2.$3")
    .replace(/-(thinking|search)$/u, "")
    .replace(/^deepseek-ai\//, "deepseek/")
    .replace(/^zai-org\/glm-/, "zhipu/glm-")
    .replace(/^minimaxai\/minimax-/, "minimax/minimax-")
    .replace(/^qwen\/qwen3([.])/, "qwen/qwen-3.")
    .replace(/^moonshot\//, "moonshotai/")
    .replace(/^kimi\//, "moonshotai/")
    .replace(/^z-ai\/glm-/, "zhipu/glm-")
    .replace(/^zai\/glm-/, "zhipu/glm-")
    .replace(/^glm\//, "zhipu/glm-")
    .replace(/^qwen\/qwen3([-.])/, "qwen/qwen-3.")
    .replace(/^qwen\/qwen-3-/, "qwen/qwen-3.")
    .replace(/^deepseek\/deepseek-v4-pro$/, "deepseek/deepseek-v4-pro")
    .replace(/^deepseek\/deepseek-v4-flash$/, "deepseek/deepseek-v4-flash")
    .replace(/^minimax\/m2([-.])/, "minimax/minimax-m2.")
    .replace(/^minimax\/minimax-m2-/, "minimax/minimax-m2.")
    .replace(/[()\s]+/gu, "-")
    .replace(/-+$/u, "");
  return normalized;
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

const HfLeaderboardRowSchema = z.object({
  modelId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  value: z.coerce.number().optional(),
  score: z.coerce.number().optional(),
  sample_count: z.coerce.number().optional(),
  total_count: z.coerce.number().optional(),
  verified: z.boolean().optional(),
  last_updated: z.string().optional(),
  date: z.string().optional(),
});

const HfLeaderboardSchema = z.union([
  z.object({ leaderboard: z.array(HfLeaderboardRowSchema) }),
  z.object({ results: z.array(HfLeaderboardRowSchema) }),
  z.array(HfLeaderboardRowSchema),
]);

const LmArenaRowSchema = z.object({
  row: z.object({
    model_name: z.string().min(1),
    organization: z.string().optional(),
    category: z.string().optional(),
    rating: z.coerce.number().optional(),
    rank: z.coerce.number().optional(),
    vote_count: z.coerce.number().optional(),
    leaderboard_publish_date: z.string().optional(),
  }),
});

const LmArenaSchema = z.object({ rows: z.array(LmArenaRowSchema) });

const ArtificialAnalysisModelSchema = z.object({
  model_name: z.string().optional(),
  name: z.string().optional(),
  slug: z.string().optional(),
  artificial_analysis_intelligence_index: z.coerce.number().optional(),
  artificial_analysis_coding_index: z.coerce.number().optional(),
  evaluations: z.record(z.string(), z.unknown()).optional(),
});

const ArtificialAnalysisSchema = z.union([
  z.object({ data: z.array(ArtificialAnalysisModelSchema) }),
  z.object({ models: z.array(ArtificialAnalysisModelSchema) }),
  z.array(ArtificialAnalysisModelSchema),
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
    if (typeof raw === "string" && raw.includes("\n") && raw.toLowerCase().includes("overall acc")) {
      const [headerLine = "", ...lines] = raw.trim().split(/\r?\n/u);
      const headers = headerLine.split(",").map((header) => header.trim().toLowerCase());
      const modelIndex = headers.indexOf("model");
      const scoreIndex = headers.indexOf("overall acc");
      if (modelIndex < 0 || scoreIndex < 0) return [];
      return lines.flatMap((line) => {
        const columns = line.split(",").map((column) => column.trim());
        const model = columns[modelIndex];
        const rawScore = normalizeScore(columns[scoreIndex]);
        if (!model || rawScore === undefined) return [];
        return [{
          source: "bfcl",
          modelKey: canonicalModelKey(model),
          scenario: "agentic",
          rawScore,
          lastVerifiedAt: new Date().toISOString(),
        }];
      });
    }
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

function parseHfLeaderboard(raw, source, scenario, fetchedAt) {
  try {
    const parsed = HfLeaderboardSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (!parsed.success) return [];
    const rows = rowsFromParsed(parsed.data, "leaderboard");
    const values = rows
      .map((row) => asNumber(row.value ?? row.score))
      .filter((value) => value !== undefined)
      .sort((a, b) => a - b);
    return rows.flatMap((row) => {
      const modelKey = row.modelId ?? row.model;
      const rawScore = normalizeLeaderboardValue(row.value ?? row.score, values);
      if (!modelKey || rawScore === undefined) return [];
      return [{
        source,
        modelKey: canonicalModelKey(modelKey),
        scenario,
        rawScore,
        sampleCount: row.sample_count ?? row.total_count,
        lastVerifiedAt: row.last_updated ?? row.date ?? fetchedAt,
      }];
    });
  } catch {
    return [];
  }
}

function modelKeyFromNameAndOrganization(modelName, organization) {
  const normalizedName = String(modelName ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  const org = String(organization ?? "").trim().toLowerCase();
  if (!normalizedName) return "";
  if (org === "anthropic" || normalizedName.startsWith("claude-")) return canonicalModelKey(`anthropic/${normalizedName}`);
  if (org === "openai" || normalizedName.startsWith("gpt-")) return canonicalModelKey(`openai/${normalizedName}`);
  if (org === "moonshotai" || normalizedName.startsWith("kimi-")) return canonicalModelKey(`moonshotai/${normalizedName}`);
  if (org === "zai" || org === "zhipu" || normalizedName.startsWith("glm-")) return canonicalModelKey(`zhipu/${normalizedName}`);
  if (org === "deepseek" || normalizedName.startsWith("deepseek-")) return canonicalModelKey(`deepseek/${normalizedName}`);
  if (org === "minimax" || normalizedName.startsWith("minimax-")) return canonicalModelKey(`minimax/${normalizedName}`);
  if (org === "qwen" || org === "alibaba" || normalizedName.startsWith("qwen")) return canonicalModelKey(`qwen/${normalizedName}`);
  return canonicalModelKey(org ? `${org}/${normalizedName}` : normalizedName);
}

function lmArenaVariantKind(modelName) {
  const normalized = String(modelName ?? "").trim().toLowerCase();
  if (/(^|[-_.])(thinking|search|codex-harness|fc|function-calling)([-_.]|$)/u.test(normalized)) {
    return normalized.match(/(thinking|search|codex-harness|fc|function-calling)/u)?.[1] ?? "variant";
  }
  return "";
}

function normalizeRankValue(rank, totalRows) {
  const parsed = asNumber(rank);
  const total = Math.max(1, asNumber(totalRows) ?? 1);
  if (parsed === undefined) return undefined;
  const boundedRank = Math.max(1, Math.min(parsed, total));
  if (total <= 1) return 100;
  const percentile = Math.log1p(boundedRank - 1) / Math.log1p(total - 1);
  return Math.round((62 + (1 - Math.pow(percentile, 1.45)) * 38) * 100) / 100;
}

function parseLmArenaRows(raw, source, scenario, fetchedAt) {
  try {
    const parsed = LmArenaSchema.safeParse(raw);
    if (!parsed.success) return [];
    const rows = parsed.data.rows
      .map((entry) => entry.row)
      .filter((row) => {
        const category = String(row.category ?? "overall").trim().toLowerCase();
        return category === "overall" && String(row.model_name ?? "").trim() && Number.isFinite(row.rating);
      });
    const values = rows.map((row) => asNumber(row.rating)).filter((value) => value !== undefined).sort((a, b) => a - b);
    const byModel = new Map();
    for (const row of rows) {
      const modelKey = modelKeyFromNameAndOrganization(row.model_name, row.organization);
      const rawScore = normalizeRankValue(row.rank, rows.length) ?? normalizeLeaderboardValue(row.rating, values);
      if (!modelKey || rawScore === undefined) continue;
      const variantKind = lmArenaVariantKind(row.model_name);
      const record = {
        source,
        modelKey,
        scenario,
        rawScore: variantKind ? Math.max(0, rawScore - 1.5) : rawScore,
        sampleCount: row.vote_count,
        lastVerifiedAt: row.leaderboard_publish_date ?? fetchedAt,
        sourceRows: rows.length,
        ...(variantKind ? { variantKind, variantAuxiliary: true, reasonCodes: [`variant_auxiliary_evidence:${source}`] } : {}),
      };
      const existing = byModel.get(modelKey);
      if (!existing || record.rawScore > existing.rawScore) {
        byModel.set(modelKey, record);
      }
    }
    return [...byModel.values()];
  } catch {
    return [];
  }
}

function valueFromPath(record, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current && current[key], record);
    const parsed = asNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseArtificialAnalysis(raw, fetchedAt) {
  try {
    const parsed = ArtificialAnalysisSchema.safeParse(raw);
    if (!parsed.success) return [];
    const rows = rowsFromParsed(parsed.data, "data");
    return rows.flatMap((row) => {
      const modelKey = modelKeyFromNameAndOrganization(row.model_name ?? row.name ?? row.slug, "");
      if (!modelKey) return [];
      const intelligence = normalizeScore(valueFromPath(row, [
        "artificial_analysis_intelligence_index",
        "evaluations.artificial_analysis_intelligence_index",
        "evaluations.intelligence_index",
      ]));
      const coding = normalizeScore(valueFromPath(row, [
        "artificial_analysis_coding_index",
        "evaluations.artificial_analysis_coding_index",
        "evaluations.coding_index",
        "evaluations.livecodebench",
      ]));
      return [
        ...(intelligence === undefined ? [] : [{
          source: "artificial_analysis",
          modelKey,
          scenario: "global",
          rawScore: intelligence,
          lastVerifiedAt: fetchedAt,
          reasonCodes: ["global_anchor:artificial_analysis"],
        }]),
        ...(coding === undefined ? [] : [{
          source: "artificial_analysis",
          modelKey,
          scenario: "coding_worker",
          rawScore: coding,
          lastVerifiedAt: fetchedAt,
        }]),
      ];
    });
  } catch {
    return [];
  }
}

function sourceFamily(source) {
  if (source === "swe_bench_verified" || source === "swe_bench_pro") return "swe_bench";
  if (source.startsWith("lmarena_")) return "lmarena";
  return source;
}

function normalizeLeaderboardValue(value, sortedValues) {
  const parsed = asNumber(value);
  if (parsed === undefined) return undefined;
  if (!Array.isArray(sortedValues) || sortedValues.length < 3) return normalizeScore(parsed);
  const min = sortedValues[0];
  const max = sortedValues[sortedValues.length - 1];
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return normalizeScore(parsed);
  const percentile = (parsed - min) / (max - min);
  return Math.round((55 + percentile * 40) * 100) / 100;
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
  const presentHealthySources = new Set(
    contributions
      .map((entry) => entry.source)
      .filter((source) => (weights[source] ?? 0) > 0 && (health[source] ?? 0) > 0),
  );
  const normalizer = [...presentHealthySources].reduce((sum, source) => sum + (weights[source] ?? 0), 0) || 1;
  const rows = contributions
    .filter((entry) => Number.isFinite(entry.rawScore) && entry.rawScore >= 0 && entry.rawScore <= 100)
    .map((entry) => {
      const baseWeight = (weights[entry.source] ?? 0) / normalizer;
      const freshnessFactor = computeFreshnessFactor(entry.lastVerifiedAt, now);
      const sourceHealth = health[entry.source] ?? 0;
      return {
        source: entry.source,
        rawScore: entry.rawScore,
        baseWeight,
        freshnessFactor,
        sourceHealth,
        effectiveWeight: baseWeight * freshnessFactor * sourceHealth,
        ...(Array.isArray(entry.reasonCodes) ? { reasonCodes: entry.reasonCodes } : {}),
        ...(entry.sourceRows !== undefined ? { sourceRows: entry.sourceRows } : {}),
        ...(entry.variantKind ? { variantKind: entry.variantKind, variantAuxiliary: Boolean(entry.variantAuxiliary) } : {}),
      };
    });
  const totalEffectiveWeight = rows.reduce((sum, entry) => sum + entry.effectiveWeight, 0);
  if (totalEffectiveWeight <= 0) {
    return { score: 0, confidence: "unknown", contributions: rows, reasonCodes: ["no_usable_contributions"] };
  }
  const score = rows.reduce((sum, entry) => sum + entry.rawScore * (entry.effectiveWeight / totalEffectiveWeight), 0);
  const usableSources = rows.filter((entry) => entry.effectiveWeight > 0).map((entry) => entry.source);
  const evidenceCount = new Set(usableSources).size;
  const evidenceFamilyCount = new Set(usableSources.map(sourceFamily)).size;
  const confidence = evidenceFamilyCount >= 2 && totalEffectiveWeight >= 0.7 ? "high" : totalEffectiveWeight >= 0.4 ? "medium" : "low";
  const contributionReasons = rows.flatMap((entry) => Array.isArray(entry.reasonCodes) ? entry.reasonCodes : []);
  return {
    score: Math.round(score * 100) / 100,
    confidence,
    contributions: rows,
    evidenceCount,
    evidenceFamilyCount,
    reasonCodes: [...new Set([`fusion_sources:${evidenceCount}`, `fusion_source_families:${evidenceFamilyCount}`, ...contributionReasons])],
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

function efficiencyScoreFromValues(values, lowerIsBetter = true) {
  const parsed = values.map(asNumber).filter((value) => value !== undefined && Number.isFinite(value) && value > 0);
  if (parsed.length === 0) return undefined;
  const best = lowerIsBetter ? Math.min(...parsed) : Math.max(...parsed);
  return Math.max(0, Math.min(100, Math.round((100 / (1 + Math.log10(1 + best))) * 100) / 100));
}

function buildBenchmarkEfficiency(pinchEntry) {
  if (!pinchEntry) return undefined;
  const costScore = efficiencyScoreFromValues([pinchEntry.best_cost_usd, pinchEntry.average_cost_usd]);
  const speedScore = efficiencyScoreFromValues([pinchEntry.best_execution_time_seconds, pinchEntry.average_execution_time_seconds]);
  if (costScore === undefined && speedScore === undefined) return undefined;
  const valueScore = costScore !== undefined && speedScore !== undefined
    ? Math.round((costScore * 0.65 + speedScore * 0.35) * 100) / 100
    : costScore ?? speedScore;
  return {
    ...(costScore !== undefined ? { taskCostScore: costScore } : {}),
    ...(speedScore !== undefined ? { taskSpeedScore: speedScore } : {}),
    valueScore,
    sources: ["pinchbench"],
  };
}

function scenarioScoreExcludingFamilies(score, excludedFamilies) {
  const usable = (score?.contributions ?? [])
    .filter((contribution) => (contribution.effectiveWeight ?? 0) > 0 && !excludedFamilies.has(sourceFamily(contribution.source)));
  const totalWeight = usable.reduce((sum, contribution) => sum + contribution.effectiveWeight, 0);
  if (totalWeight <= 0) return undefined;
  return usable.reduce((sum, contribution) => sum + contribution.rawScore * (contribution.effectiveWeight / totalWeight), 0);
}

function heuristicScoreForTier(tier) {
  if (tier === "frontier") return 90;
  if (tier === "strong") return 76;
  if (tier === "standard") return 65;
  if (tier === "mini") return 45;
  return 40;
}

function buildCapabilityScore(scoreByScenario) {
  const globalScore = scoreByScenario.global;
  if (globalScore && globalScore.confidence !== "unknown") {
    const scenarioSupplements = [
      ["coding_worker", 0.12],
      ["agentic", 0.06],
      ["research", 0.06],
    ];
    let totalScore = globalScore.score * 0.76;
    const observedScenarioValues = [globalScore.score];
    const sources = new Set();
    const sourceFamilies = new Set();
    const reasonCodes = new Set(globalScore.reasonCodes ?? []);
    const globalSourceFamilies = new Set();
    const nonGlobalSourceFamilies = new Set();
    let nonGlobalWeightedScore = 0;
    let nonGlobalIndependentWeightedScore = 0;
    let nonGlobalWeight = 0;
    let nonGlobalScenarioCount = 0;
    for (const contribution of globalScore.contributions ?? []) {
      if ((contribution.effectiveWeight ?? 0) > 0) sources.add(contribution.source);
      if ((contribution.effectiveWeight ?? 0) > 0) {
        const family = sourceFamily(contribution.source);
        sourceFamilies.add(family);
        globalSourceFamilies.add(family);
      }
    }
    for (const [scenario, weight] of scenarioSupplements) {
      const score = scoreByScenario[scenario];
      if (score === undefined || score.confidence === "unknown") {
        totalScore += globalScore.score * weight;
        reasonCodes.add(`global_anchor_missing_scenario:${scenario}`);
        continue;
      }
      totalScore += score.score * weight;
      nonGlobalWeightedScore += score.score * weight;
      nonGlobalIndependentWeightedScore += (scenarioScoreExcludingFamilies(score, globalSourceFamilies) ?? score.score) * weight;
      nonGlobalWeight += weight;
      nonGlobalScenarioCount += 1;
      observedScenarioValues.push(score.score);
      for (const contribution of score.contributions ?? []) {
        if ((contribution.effectiveWeight ?? 0) > 0) sources.add(contribution.source);
        if ((contribution.effectiveWeight ?? 0) > 0) {
          const family = sourceFamily(contribution.source);
          sourceFamilies.add(family);
          nonGlobalSourceFamilies.add(family);
        }
      }
      for (const reason of score.reasonCodes ?? []) reasonCodes.add(reason);
    }
    const nonGlobalAverage = nonGlobalWeight > 0 ? nonGlobalWeightedScore / nonGlobalWeight : undefined;
    const nonGlobalIndependentAverage = nonGlobalWeight > 0 ? nonGlobalIndependentWeightedScore / nonGlobalWeight : undefined;
    const softenedSingleSourceGlobal = nonGlobalAverage !== undefined &&
      globalSourceFamilies.size <= 1 &&
      nonGlobalScenarioCount >= 2 &&
      nonGlobalSourceFamilies.size >= 2 &&
      nonGlobalSourceFamilies.size > globalSourceFamilies.size &&
      nonGlobalAverage - globalScore.score > 16;
    if (softenedSingleSourceGlobal) {
      totalScore = globalScore.score * 0.15 + (nonGlobalIndependentAverage ?? nonGlobalAverage) * 0.85;
      reasonCodes.add("single_source_global_anchor_softened");
    }
    const spread = Math.max(...observedScenarioValues) - Math.min(...observedScenarioValues);
    if (!softenedSingleSourceGlobal && spread > 18) {
      totalScore -= (spread - 18) * 0.25;
      reasonCodes.add("global_single_scenario_spike_penalty");
    }
    return {
      score: Math.round(totalScore * 100) / 100,
      confidence: globalScore.confidence,
      sources: [...sources].sort(),
      evidenceCount: sources.size,
      evidenceFamilyCount: sourceFamilies.size,
      reasonCodes: [...reasonCodes].sort(),
    };
  }

  const fusedScores = Object.values(scoreByScenario);
  const usableScores = fusedScores.filter((score) => score.confidence !== "unknown");
  if (usableScores.length === 0) return undefined;
  const weightedScenarios = [
    ["research", 0.55],
    ["coding_worker", 0.35],
    ["agentic", 0.1],
  ];
  const missingScenarioPrior = 72;
  let totalScore = 0;
  const observedScenarioValues = [];
  const sources = new Set();
  const sourceFamilies = new Set();
  const reasonCodes = new Set();
  for (const [scenario, scenarioWeight] of weightedScenarios) {
    const score = scoreByScenario[scenario];
    if (score === undefined || score.confidence === "unknown") {
      totalScore += missingScenarioPrior * scenarioWeight;
      reasonCodes.add(`global_missing_scenario_prior:${scenario}`);
      continue;
    }
    totalScore += score.score * scenarioWeight;
    observedScenarioValues.push(score.score);
    for (const contribution of score.contributions ?? []) {
      if ((contribution.effectiveWeight ?? 0) > 0) sources.add(contribution.source);
      if ((contribution.effectiveWeight ?? 0) > 0) sourceFamilies.add(sourceFamily(contribution.source));
    }
    for (const reason of score.reasonCodes ?? []) reasonCodes.add(reason);
  }
  const evidenceCount = sources.size;
  const evidenceFamilyCount = sourceFamilies.size;
  const scenarioConfidences = usableScores.map((score) => score.confidence);
  const confidence = evidenceFamilyCount >= 2 && scenarioConfidences.includes("high")
    ? "high"
    : scenarioConfidences.includes("medium") || scenarioConfidences.includes("high")
      ? "medium"
      : "low";
  const spread = observedScenarioValues.length >= 2
    ? Math.max(...observedScenarioValues) - Math.min(...observedScenarioValues)
    : 0;
  if (spread > 18) {
    totalScore -= (spread - 18) * 0.25;
    reasonCodes.add("global_single_scenario_spike_penalty");
  }
  return {
    score: Math.round(totalScore * 100) / 100,
    confidence,
    sources: [...sources].sort(),
    evidenceCount,
    evidenceFamilyCount,
    reasonCodes: [...reasonCodes].sort(),
  };
}

function buildModelRecord(modelKey, openrouterModel, pinchEntry, leaderboardRecords, sourceWeights, sourceHealth, generatedAt) {
  const input = pricePerMTok(openrouterModel?.pricing?.prompt);
  const output = pricePerMTok(openrouterModel?.pricing?.completion);
  const price = round(blendedPrice(input, output));
  const tier = inferTier(modelKey);
	  const score = scoreFromPercentage(pinchEntry?.best_score_percentage) ?? heuristicScoreForTier(tier);
	  const confidence = pinchEntry ? confidenceFromSampleCount(pinchEntry.submission_count) : "low";
	  const scenarioContributions = {
      global: leaderboardRecords.filter((entry) => entry.scenario === "global"),
	    coding_worker: [
	      ...(pinchEntry ? [{ source: "pinchbench", rawScore: score, lastVerifiedAt: generatedAt }] : []),
	      ...leaderboardRecords.filter((entry) => entry.scenario === "coding_worker"),
	    ],
	    agentic: leaderboardRecords.filter((entry) => entry.scenario === "agentic"),
	    research: leaderboardRecords.filter((entry) => entry.scenario === "research"),
	  };
	  const scoreByScenario = {};
	  for (const [scenario, contributions] of Object.entries(scenarioContributions)) {
	    const fused = fuseScenarioScore(contributions, sourceWeights[scenario] ?? {}, sourceHealth, Date.parse(generatedAt));
	    if (fused.confidence !== "unknown") {
	      scoreByScenario[scenario] = fused;
	    }
	  }
  const capabilityScore = buildCapabilityScore(scoreByScenario);
  const benchmarkEfficiency = buildBenchmarkEfficiency(pinchEntry);
	  return {
	    tier,
	    ...(price !== undefined ? { price } : {}),
    scores: {
      coding_worker: { score, confidence },
      research: { score: Math.max(0, Math.min(100, score - 3)), confidence },
      agentic: { score: Math.max(0, Math.min(100, score - 5)), confidence },
	    },
	    ...(capabilityScore ? { capabilityScore } : {}),
	    ...(Object.keys(scoreByScenario).length > 0 ? { scoreByScenario } : {}),
      ...(benchmarkEfficiency ? { benchmarkEfficiency } : {}),
	    lastVerifiedAt: generatedAt,
	  };
	}

function confidenceLevel(value) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

function splitProviderModel(modelKey) {
  const [provider = "", model = modelKey] = String(modelKey).toLowerCase().split("/");
  return { provider, model };
}

function compactBase(modelKey) {
  const { provider, model } = splitProviderModel(modelKey);
  const base = model.replace(/[-_.](mini|flash|lite|haiku|small|air)$/u, "");
  return base === model ? undefined : `${provider}/${base}`;
}

function roleRank(modelKey) {
  const { model } = splitProviderModel(modelKey);
  if (/(^|[-_.])(mini|flash|lite|haiku|small|air)([-_.]|$)/u.test(model)) return 0;
  if (/(^|[-_.])(plus)([-_.]|$)/u.test(model)) return 2;
  if (/(^|[-_.])(pro|max|sonnet)([-_.]|$)/u.test(model)) return 3;
  if (/(^|[-_.])(opus|ultra|frontier)([-_.]|$)/u.test(model)) return 4;
  return 1;
}

function versionSeries(modelKey) {
  const { provider, model } = splitProviderModel(modelKey);
  const withoutRole = model
    .replace(/[-_.](mini|flash|lite|haiku|small|air|plus|pro|max|sonnet|opus|ultra|frontier)$/u, "");
  const match = withoutRole.match(/^(.*?)(\d+)(?:[-_.](\d+))?/u);
  if (!match) return undefined;
  const prefix = match[1].replace(/[-_.]+$/u, "");
  const major = Number(match[2]);
  if (match[3] !== undefined && match[3].length > 2) return undefined;
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  if (!prefix || !Number.isFinite(major) || !Number.isFinite(minor)) return undefined;
  return { key: `${provider}/${prefix}`, version: [major, minor], role: roleRank(modelKey) };
}

function compareVersion(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

function fusedScoreValue(model) {
  const score = model?.capabilityScore?.score;
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

function fusedConfidence(model) {
  return model?.capabilityScore?.confidence ?? "unknown";
}

function scenarioScoreValue(model, scenario) {
  const score = model?.scoreByScenario?.[scenario]?.score;
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

function capFusedScore(fused, ceiling, reasonCode) {
  if (!fused || typeof fused.score !== "number" || !Number.isFinite(fused.score) || fused.score <= ceiling) return fused;
  return {
    ...fused,
    score: Math.max(0, Math.round(ceiling * 100) / 100),
    reasonCodes: [...new Set([...(fused.reasonCodes ?? []), reasonCode])].sort(),
  };
}

function capModelGlobalCapability(model, ceiling, reasonCode) {
  return {
    ...model,
    capabilityScore: capFusedScore(model.capabilityScore, ceiling, reasonCode),
  };
}

function capModelCapability(model, ceiling, reasonCode) {
  return {
    ...model,
    capabilityScore: capFusedScore(model.capabilityScore, ceiling, reasonCode),
    scoreByScenario: model.scoreByScenario
      ? Object.fromEntries(Object.entries(model.scoreByScenario).map(([scenario, fused]) => [
        scenario,
        capFusedScore(fused, ceiling, reasonCode),
      ]))
      : model.scoreByScenario,
  };
}

function applySiblingCalibrations(models) {
  const adjusted = { ...models };

  const fullByCompactBase = new Map();
  for (const [modelKey, model] of Object.entries(adjusted)) {
    const score = fusedScoreValue(model);
    if (score === undefined) continue;
    const base = compactBase(modelKey);
    if (base) continue;
    const existing = fullByCompactBase.get(modelKey);
    if (!existing || roleRank(modelKey) > existing.role || score > existing.score) {
      fullByCompactBase.set(modelKey, { modelKey, score, role: roleRank(modelKey) });
    }
  }
  for (const [modelKey, model] of Object.entries(adjusted)) {
    const base = compactBase(modelKey);
    const score = fusedScoreValue(model);
    const full = base ? fullByCompactBase.get(base) : undefined;
    if (!full || score === undefined || score <= full.score) continue;
    adjusted[modelKey] = capModelCapability(model, full.score - 0.5, `compact_sibling_ceiling:${full.modelKey}`);
  }

  const groups = new Map();
  const roleGroups = new Map();
  for (const [modelKey, model] of Object.entries(adjusted)) {
    const score = fusedScoreValue(model);
    const series = versionSeries(modelKey);
    if (score === undefined || !series) continue;
    const key = `${series.key}:role${series.role}`;
    const rows = groups.get(key) ?? [];
    rows.push({ modelKey, model, score, confidence: fusedConfidence(model), version: series.version });
    groups.set(key, rows);

    const roleKey = `${series.key}:${series.version.join(".")}`;
    const roleRows = roleGroups.get(roleKey) ?? [];
    roleRows.push({ modelKey, model, score, confidence: fusedConfidence(model), role: series.role });
    roleGroups.set(roleKey, roleRows);
  }
  for (const rows of roleGroups.values()) {
    rows.sort((a, b) => b.role - a.role);
    let bestHigherRole;
    for (const row of rows) {
      if (bestHigherRole && row.role === 0 && bestHigherRole.role > 0 && row.score > bestHigherRole.score && confidenceLevel(row.confidence) <= confidenceLevel(bestHigherRole.confidence)) {
        adjusted[row.modelKey] = capModelCapability(adjusted[row.modelKey], bestHigherRole.score - 0.5, `higher_role_ceiling:${bestHigherRole.modelKey}`);
        row.score = fusedScoreValue(adjusted[row.modelKey]) ?? row.score;
      }
      if (!bestHigherRole || row.score > bestHigherRole.score || row.role > bestHigherRole.role) {
        bestHigherRole = { modelKey: row.modelKey, score: row.score, confidence: row.confidence, role: row.role };
      }
    }
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => compareVersion(b.version, a.version));
    let bestNewer;
    for (const row of rows) {
      if (bestNewer && row.score > bestNewer.score && confidenceLevel(row.confidence) <= confidenceLevel(bestNewer.confidence)) {
        adjusted[row.modelKey] = capModelCapability(adjusted[row.modelKey], bestNewer.score - 0.25, `newer_version_ceiling:${bestNewer.modelKey}`);
        row.score = fusedScoreValue(adjusted[row.modelKey]) ?? row.score;
      }
      if (!bestNewer || row.score > bestNewer.score || confidenceLevel(row.confidence) > confidenceLevel(bestNewer.confidence)) {
        bestNewer = { modelKey: row.modelKey, score: row.score, confidence: row.confidence };
      }
    }
  }

  const broadNonCompactRows = Object.entries(adjusted)
    .flatMap(([modelKey, model]) => {
      const score = fusedScoreValue(model);
      const research = scenarioScoreValue(model, "research");
      if (score === undefined || research === undefined || roleRank(modelKey) === 0) return [];
      return [{ modelKey, score, research, confidence: fusedConfidence(model) }];
    })
    .sort((a, b) => b.research - a.research);

  for (const [modelKey, model] of Object.entries(adjusted)) {
    const score = fusedScoreValue(model);
    const research = scenarioScoreValue(model, "research");
    const coding = scenarioScoreValue(model, "coding_worker");
    if (score === undefined || research === undefined || coding === undefined || roleRank(modelKey) !== 0) continue;
    if (coding - research < 12) continue;
    const strongerBroad = broadNonCompactRows.find((row) =>
      row.research - research >= 6 &&
      row.score < score &&
      confidenceLevel(row.confidence) >= confidenceLevel(fusedConfidence(model)),
    );
    if (!strongerBroad) continue;
    adjusted[modelKey] = capModelGlobalCapability(
      model,
      strongerBroad.score - 0.25,
      `compact_global_broad_ceiling:${strongerBroad.modelKey}`,
    );
  }

  for (const [modelKey, model] of Object.entries(adjusted)) {
    const score = fusedScoreValue(model);
    const research = scenarioScoreValue(model, "research");
    const coding = scenarioScoreValue(model, "coding_worker");
    const agentic = scenarioScoreValue(model, "agentic");
    if (score === undefined || research === undefined || coding === undefined || agentic !== undefined || roleRank(modelKey) !== 0) continue;
    if (score <= 84 || research - coding < 10 || score <= coding + 1.5) continue;
    adjusted[modelKey] = capModelGlobalCapability(model, coding - 4, "compact_missing_agentic_cap");
  }

  return adjusted;
}

function buildSourceStatus(sources, parsedRows) {
  const statusFor = (name, source, rows, capability = true) => {
    const ok = Boolean(source.ok);
    const rowCount = rows === undefined ? undefined : rows.length;
    const schemaMismatch = ok && capability && rowCount === 0;
    return {
      ok: ok && !schemaMismatch,
      rows: rowCount ?? (ok ? undefined : 0),
      health: ok && !schemaMismatch ? 1 : 0,
      ...(capability ? { class: "capability_benchmark" } : { class: "catalog_metadata" }),
      ...(!ok ? { reason: String(source.error ?? "fetch_failed") } : {}),
      ...(schemaMismatch ? { reason: "schema_mismatch_or_empty" } : {}),
    };
  };
  return {
    openrouter: statusFor("openrouter", sources.openrouter, undefined, false),
    pinchbench: statusFor("pinchbench", sources.pinchbench, parsedRows.pinchRows),
    aider: statusFor("aider", sources.aider, parsedRows.aiderRecords),
    bfcl: statusFor("bfcl", sources.bfcl, parsedRows.bfclRecords),
    swe_bench_verified: statusFor("swe_bench_verified", sources.sweBenchVerified, parsedRows.sweBenchVerifiedRecords),
    swe_bench_pro: statusFor("swe_bench_pro", sources.sweBenchPro, parsedRows.sweBenchProRecords),
    lmarena_text: statusFor("lmarena_text", sources.lmarenaText, parsedRows.lmarenaTextRecords),
    lmarena_webdev: statusFor("lmarena_webdev", sources.lmarenaWebdev, parsedRows.lmarenaWebdevRecords),
    lmarena_search: statusFor("lmarena_search", sources.lmarenaSearch, parsedRows.lmarenaSearchRecords),
    artificial_analysis: sources.artificialAnalysis?.authMissing
      ? { ok: false, rows: 0, health: 0, class: "capability_benchmark", reason: "missing_auth" }
      : statusFor("artificial_analysis", sources.artificialAnalysis, parsedRows.artificialAnalysisRecords),
  };
}

function buildSnapshot(openrouterData, pinchbenchData, leaderboardRecords, sourceStatus, requestedModels, generatedAt) {
	  const sourceWeights = loadSourceWeights();
	  const sourceHealth = {
	    pinchbench: sourceStatus.pinchbench?.health ?? 0,
	    aider: sourceStatus.aider?.health ?? 0,
	    bfcl: sourceStatus.bfcl?.health ?? 0,
	    swe_bench_verified: sourceStatus.swe_bench_verified?.health ?? 0,
	    swe_bench_pro: sourceStatus.swe_bench_pro?.health ?? 0,
	    lmarena_text: sourceStatus.lmarena_text?.health ?? 0,
	    lmarena_webdev: sourceStatus.lmarena_webdev?.health ?? 0,
	    lmarena_search: sourceStatus.lmarena_search?.health ?? 0,
	    artificial_analysis: sourceStatus.artificial_analysis?.health ?? 0,
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
	    sources: ["openrouter", "pinchbench", "aider", "bfcl", "swe_bench_verified", "swe_bench_pro", "lmarena_text", "lmarena_webdev", "lmarena_search", "artificial_analysis"],
	    sourceStatus,
	    models: applySiblingCalibrations(models),
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
	  const sweBenchVerifiedRecords = sources.sweBenchVerified.ok ? parseHfLeaderboard(sources.sweBenchVerified.data, "swe_bench_verified", "coding_worker", generatedAt) : [];
	  const sweBenchProRecords = sources.sweBenchPro.ok ? parseHfLeaderboard(sources.sweBenchPro.data, "swe_bench_pro", "coding_worker", generatedAt) : [];
	  const lmarenaTextRecords = sources.lmarenaText.ok ? parseLmArenaRows(sources.lmarenaText.data, "lmarena_text", "research", generatedAt) : [];
	  const lmarenaWebdevRecords = sources.lmarenaWebdev.ok ? parseLmArenaRows(sources.lmarenaWebdev.data, "lmarena_webdev", "coding_worker", generatedAt) : [];
	  const lmarenaSearchRecords = sources.lmarenaSearch.ok ? parseLmArenaRows(sources.lmarenaSearch.data, "lmarena_search", "research", generatedAt) : [];
	  const artificialAnalysisRecords = sources.artificialAnalysis.ok ? parseArtificialAnalysis(sources.artificialAnalysis.data, generatedAt) : [];
  const pinchRows = Array.isArray(sources.pinchbench.data?.leaderboard) ? sources.pinchbench.data.leaderboard : [];
  const sourceStatus = buildSourceStatus(sources, { aiderRecords, bfclRecords, sweBenchVerifiedRecords, sweBenchProRecords, lmarenaTextRecords, lmarenaWebdevRecords, lmarenaSearchRecords, artificialAnalysisRecords, pinchRows });
	  const snapshot = buildSnapshot(
	    sources.openrouter.ok ? sources.openrouter.data : {},
	    sources.pinchbench.ok ? sources.pinchbench.data : {},
	    [...aiderRecords, ...bfclRecords, ...sweBenchVerifiedRecords, ...sweBenchProRecords, ...lmarenaTextRecords, ...lmarenaWebdevRecords, ...lmarenaSearchRecords, ...artificialAnalysisRecords],
	    sourceStatus,
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
