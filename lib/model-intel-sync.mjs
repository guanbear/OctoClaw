#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_WORKSPACE = "/workspace";
const MODELS_DEV_URL = process.env.MODEL_INTEL_MODELS_DEV_URL || "https://models.dev/api.json";
const OPENROUTER_MODELS_URL = process.env.MODEL_INTEL_OPENROUTER_MODELS_URL || "https://openrouter.ai/api/v1/models";
const OPENROUTER_RANKINGS_URL = process.env.MODEL_INTEL_OPENROUTER_RANKINGS_URL || "https://openrouter.ai/rankings";
const DEFAULT_HEADERS = {
  "user-agent": "Mozilla/5.0 (OctoClaw Model Intel Sync)",
  accept: "application/json,text/html;q=0.9,*/*;q=0.8",
};

function normalizePath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

function resolveWorkspace() {
  for (const envName of ["WORKSPACE", "OCTOCLAW_WORKSPACE"]) {
    const configured = String(process.env[envName] || "").trim();
    if (configured) return normalizePath(configured);
  }
  const managed = path.join(os.homedir(), ".openclaw", "workspace");
  if (fs.existsSync(path.join(managed, "tmp"))) return managed;
  return DEFAULT_WORKSPACE;
}

const WORKSPACE = resolveWorkspace();
const TMP_DIR = path.join(WORKSPACE, "tmp", "octopus");
const MODELS_DEV_FILE = path.join(TMP_DIR, "model-intel-models-dev.json");
const MODELS_DEV_LAST_GOOD_FILE = path.join(TMP_DIR, "model-intel-models-dev.last-good.json");
const OPENROUTER_CATALOG_FILE = path.join(TMP_DIR, "model-intel-openrouter-catalog.json");
const OPENROUTER_CATALOG_LAST_GOOD_FILE = path.join(TMP_DIR, "model-intel-openrouter-catalog.last-good.json");
const OPENROUTER_RANKINGS_FILE = path.join(TMP_DIR, "model-intel-openrouter-rankings.json");
const OPENROUTER_RANKINGS_LAST_GOOD_FILE = path.join(TMP_DIR, "model-intel-openrouter-rankings.last-good.json");

function nowIso() {
  return new Date().toISOString();
}

function saveJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\(free\)/g, "")
    .replace(/^[^:]+:\s*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseOpenRouterPrice(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric * 1_000_000;
}

function extractProviderFromId(modelId) {
  const text = String(modelId || "");
  return text.includes("/") ? text.split("/")[0] : "";
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function normalizeModelsDevPayload(raw) {
  const records = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return records;
  }
  for (const [providerId, provider] of Object.entries(raw)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const models = provider.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [modelId, model] of Object.entries(models)) {
      if (!model || typeof model !== "object" || Array.isArray(model)) continue;
      const fullId = `${providerId}/${modelId}`;
      records.push({
        provider_id: providerId,
        provider_name: String(provider.name || providerId),
        model_id: String(modelId),
        full_id: fullId,
        name: String(model.name || modelId),
        family: String(model.family || ""),
        tool_call: Boolean(model.tool_call),
        reasoning: Boolean(model.reasoning),
        open_weights: Boolean(model.open_weights),
        release_date: String(model.release_date || ""),
        last_updated: String(model.last_updated || ""),
        knowledge: String(model.knowledge || ""),
        input_modalities: Array.isArray(model.modalities?.input) ? [...model.modalities.input] : [],
        output_modalities: Array.isArray(model.modalities?.output) ? [...model.modalities.output] : [],
        input_cost_per_1m_usd: Number(model.cost?.input || 0),
        output_cost_per_1m_usd: Number(model.cost?.output || 0),
        context_length: Number(model.limit?.context || 0),
        output_limit: Number(model.limit?.output || 0),
        source: "models.dev",
      });
    }
  }
  return records;
}

function normalizeOpenRouterCatalog(raw) {
  const data = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  return data
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const modelId = String(entry.id || "");
      const promptPerToken = Number(entry.pricing?.prompt || 0);
      const completionPerToken = Number(entry.pricing?.completion || 0);
      const name = String(entry.name || modelId);
      return {
        id: modelId,
        canonical_slug: String(entry.canonical_slug || ""),
        name,
        normalized_name: normalizeKey(name),
        provider: extractProviderFromId(modelId),
        context_length: Number(entry.context_length || entry.top_provider?.context_length || 0),
        max_completion_tokens: Number(entry.top_provider?.max_completion_tokens || 0),
        input_modalities: Array.isArray(entry.architecture?.input_modalities) ? [...entry.architecture.input_modalities] : [],
        output_modalities: Array.isArray(entry.architecture?.output_modalities) ? [...entry.architecture.output_modalities] : [],
        modality: String(entry.architecture?.modality || ""),
        supported_parameters: Array.isArray(entry.supported_parameters) ? [...entry.supported_parameters] : [],
        prompt_cost_per_1m_usd: parseOpenRouterPrice(promptPerToken),
        completion_cost_per_1m_usd: parseOpenRouterPrice(completionPerToken),
        cache_read_cost_per_1m_usd: parseOpenRouterPrice(entry.pricing?.input_cache_read || 0),
        cache_write_cost_per_1m_usd: parseOpenRouterPrice(entry.pricing?.input_cache_write || 0),
        is_free:
          modelId.includes(":free") ||
          (promptPerToken === 0 && completionPerToken === 0),
      };
    });
}

function parseTokenMagnitude(text) {
  const match = String(text || "").match(/([\d.]+)\s*([KMBT])\s*tokens/i);
  if (!match) return 0;
  const value = Number(match[1] || 0);
  const suffix = String(match[2] || "").toUpperCase();
  const multiplier = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[suffix] || 1;
  return value * multiplier;
}

function parseOpenRouterRankings(html, catalogRecords) {
  const text = decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
  );
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const byName = new Map();
  for (const record of catalogRecords) {
    byName.set(normalizeKey(record.name), record);
    byName.set(normalizeKey(record.id), record);
  }
  const rankings = [];
  const start = Math.max(lines.indexOf("LLM Leaderboard"), 0);
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "Top Apps" || line === "Show more") break;
    const splitRank = /^\d+$/.test(line) && lines[index + 1] === ".";
    const inlineRank = /^\d+\.$/.test(line);
    if (!splitRank && !inlineRank) continue;
    const rank = splitRank ? Number(line) : Number(line.replace(".", ""));
    let name = "";
    let tokensText = "";
    const scanStart = splitRank ? index + 2 : index + 1;
    for (let cursor = scanStart; cursor < Math.min(index + 12, lines.length); cursor += 1) {
      const candidate = lines[cursor];
      if (!name && candidate !== "." && candidate.toLowerCase() !== "by" && !candidate.startsWith("by ") && !candidate.toLowerCase().startsWith("image:")) {
        name = candidate;
        continue;
      }
      if (candidate.toLowerCase() === "tokens" && cursor > 0) {
        tokensText = `${lines[cursor - 1]} tokens`;
        break;
      }
      if (candidate.toLowerCase().includes("tokens")) {
        tokensText = candidate;
        break;
      }
    }
    if (!name) continue;
    const matched = byName.get(normalizeKey(name));
    const isFree = /\(free\)/i.test(name) || Boolean(matched?.is_free);
    if (isFree) continue;
    rankings.push({
      rank,
      name,
      model_id: matched?.id || "",
      provider: matched?.provider || "",
      tokens_text: tokensText,
      token_count: parseTokenMagnitude(tokensText),
    });
  }
  const maxTokens = Math.max(0, ...rankings.map((entry) => entry.token_count || 0));
  return rankings.map((entry) => ({
    ...entry,
    score:
      maxTokens > 0 && entry.token_count > 0
        ? Number((entry.token_count / maxTokens).toFixed(6))
        : Number((1 / Math.max(entry.rank, 1)).toFixed(6)),
  }));
}

function writeSnapshot({ filePath, lastGoodPath, payload }) {
  saveJson(filePath, payload);
  saveJson(lastGoodPath, payload);
}

async function refreshModelsDev() {
  const raw = await fetchJson(MODELS_DEV_URL);
  const records = normalizeModelsDevPayload(raw);
  const payload = {
    generated_at: nowIso(),
    schema_version: "octoclaw.model_intel.models_dev/v1",
    source_url: MODELS_DEV_URL,
    records,
  };
  writeSnapshot({ filePath: MODELS_DEV_FILE, lastGoodPath: MODELS_DEV_LAST_GOOD_FILE, payload });
  return { source: "models_dev_registry", records: records.length, file: MODELS_DEV_FILE };
}

async function refreshOpenRouterCatalog() {
  const raw = await fetchJson(OPENROUTER_MODELS_URL);
  const records = normalizeOpenRouterCatalog(raw);
  const payload = {
    generated_at: nowIso(),
    schema_version: "octoclaw.model_intel.openrouter_catalog/v1",
    source_url: OPENROUTER_MODELS_URL,
    records,
  };
  writeSnapshot({ filePath: OPENROUTER_CATALOG_FILE, lastGoodPath: OPENROUTER_CATALOG_LAST_GOOD_FILE, payload });
  return { source: "openrouter_catalog", records: records.length, file: OPENROUTER_CATALOG_FILE, catalogRecords: records };
}

async function refreshOpenRouterRankings(catalogRecords) {
  const html = await fetchText(OPENROUTER_RANKINGS_URL);
  const records = parseOpenRouterRankings(html, catalogRecords);
  const payload = {
    generated_at: nowIso(),
    schema_version: "octoclaw.model_intel.openrouter_rankings/v1",
    source_url: OPENROUTER_RANKINGS_URL,
    records,
    filters: {
      exclude_free_models: true,
    },
  };
  writeSnapshot({ filePath: OPENROUTER_RANKINGS_FILE, lastGoodPath: OPENROUTER_RANKINGS_LAST_GOOD_FILE, payload });
  return { source: "openrouter_rankings", records: records.length, file: OPENROUTER_RANKINGS_FILE };
}

async function main() {
  const command = process.argv[2] || "";
  if (command !== "refresh") {
    process.stderr.write("Usage: model-intel-sync.mjs refresh\n");
    process.exitCode = 2;
    return;
  }

  const results = [];
  try {
    const catalog = await refreshOpenRouterCatalog();
    results.push({ source: catalog.source, ok: true, records: catalog.records, file: catalog.file });
    const rankings = await refreshOpenRouterRankings(catalog.catalogRecords);
    results.push({ source: rankings.source, ok: true, records: rankings.records, file: rankings.file });
  } catch (error) {
    results.push({
      source: "openrouter",
      ok: false,
      error: error instanceof Error ? error.message : String(error || "unknown error"),
      last_good_available:
        Boolean(loadJson(OPENROUTER_CATALOG_LAST_GOOD_FILE)) || Boolean(loadJson(OPENROUTER_RANKINGS_LAST_GOOD_FILE)),
    });
  }

  try {
    const modelsDev = await refreshModelsDev();
    results.push({ source: modelsDev.source, ok: true, records: modelsDev.records, file: modelsDev.file });
  } catch (error) {
    results.push({
      source: "models_dev_registry",
      ok: false,
      error: error instanceof Error ? error.message : String(error || "unknown error"),
      last_good_available: Boolean(loadJson(MODELS_DEV_LAST_GOOD_FILE)),
    });
  }

  process.stdout.write(`${JSON.stringify({ workspace: WORKSPACE, results }, null, 2)}\n`);
}

await main();
