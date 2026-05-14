import type { RouterLiteCodingTier, RouterLiteTriState } from "../decision/contracts.js";
import { loadPackagedModelIntelSnapshot } from "./loader.js";
import type { CapabilitySource, CapabilitySourceRecord } from "./types.js";

type JsonRecord = Record<string, unknown>;

export interface CapabilitySourceOptions {
  fetchJson?: (url: string) => Promise<unknown>;
  timeoutMs?: number;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODELS_DEV_URL = "https://models.dev/api.json";
const LITELLM_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function triState(value: unknown): RouterLiteTriState {
  if (value === true || value === "true" || value === "yes" || value === "supported") return "yes";
  if (value === false || value === "false" || value === "no" || value === "unsupported") return "no";
  return "unknown";
}

function inputModalities(value: unknown): Array<"text" | "image" | "audio" | "video"> | undefined {
  const raw = Array.isArray(value) ? value : [];
  const allowed = new Set(["text", "image", "audio", "video"]);
  const parsed = raw.map((item) => asString(item).toLowerCase()).filter((item): item is "text" | "image" | "audio" | "video" => allowed.has(item));
  return parsed.length > 0 ? [...new Set(parsed)] : undefined;
}

function blended(input?: number, output?: number): number | undefined {
  if (input === undefined && output === undefined) return undefined;
  return ((input ?? 0) * 3 + (output ?? 0)) / 4;
}

function perTokenToPerMTok(value: unknown): number | undefined {
  const number = asNumber(value);
  return number === undefined ? undefined : Math.round(number * 1_000_000 * 1_000_000) / 1_000_000;
}

function inferTier(modelKey: string): RouterLiteCodingTier {
  const normalized = modelKey.toLowerCase();
  if (normalized.includes("mini") || normalized.includes("nano") || normalized.includes("haiku")) return "mini";
  if (normalized.includes("5.5") || normalized.includes("opus") || normalized.includes("sonnet")) return "frontier";
  if (normalized.includes("5.1") || normalized.includes("5.4") || normalized.includes("glm-4.7")) return "strong";
  return "unknown";
}

function canonicalModelKey(modelKey: string): string {
  if (modelKey.startsWith("z-ai/glm-")) return `zhipu/${modelKey.slice("z-ai/".length)}`;
  return modelKey;
}

async function defaultFetchJson(url: string, timeoutMs = 5000): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "octoclaw-router/0.6" },
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function fetcher(options: CapabilitySourceOptions): (url: string) => Promise<unknown> {
  return options.fetchJson ?? ((url) => defaultFetchJson(url, options.timeoutMs));
}

export function createPackagedLeaderboardCapabilitySource(): CapabilitySource {
  return {
    name: "packaged_leaderboard",
    fetch: async () => loadPackagedModelIntelSnapshot().models.map((model) => ({
      modelKey: model.modelKey,
      name: model.name,
      price: model.marketPrice.blendedUsdPerMTok,
      inputUsdPerMTok: model.marketPrice.inputUsdPerMTok,
      outputUsdPerMTok: model.marketPrice.outputUsdPerMTok,
      cacheReadUsdPerMTok: model.marketPrice.cacheReadUsdPerMTok,
      cacheWriteUsdPerMTok: model.marketPrice.cacheWriteUsdPerMTok,
      contextWindow: model.capability.contextWindow,
      input: model.capability.input,
      toolUse: model.capability.toolUse,
      structuredOutput: model.capability.structuredOutput,
      reasoning: model.capability.reasoning,
      promptCache: model.capability.promptCache,
      tier: model.capability.codingTier,
      confidence: model.capability.confidence,
      available: model.available,
      lastVerifiedAt: model.freshness,
      source: "packaged_leaderboard",
    })),
  };
}

export function createOpenRouterCapabilitySource(options: CapabilitySourceOptions = {}): CapabilitySource {
  return {
    name: "openrouter",
    fetch: async () => {
      const data = await fetcher(options)(OPENROUTER_MODELS_URL);
      const records = Array.isArray(asRecord(data).data) ? asRecord(data).data as unknown[] : [];
      return records.flatMap((item): CapabilitySourceRecord[] => {
        const record = asRecord(item);
        const rawModelKey = asString(record.id);
        if (!rawModelKey) return [];
        const modelKey = canonicalModelKey(rawModelKey);
        const pricing = asRecord(record.pricing);
        const architecture = asRecord(record.architecture);
        const params = new Set((Array.isArray(record.supported_parameters) ? record.supported_parameters : []).map((value) => asString(value)));
        const input = perTokenToPerMTok(pricing.prompt);
        const output = perTokenToPerMTok(pricing.completion);
        return [{
          modelKey,
          name: asString(record.name) || undefined,
          price: blended(input, output),
          inputUsdPerMTok: input,
          outputUsdPerMTok: output,
          cacheReadUsdPerMTok: perTokenToPerMTok(pricing.input_cache_read),
          cacheWriteUsdPerMTok: perTokenToPerMTok(pricing.input_cache_write),
          contextWindow: asNumber(record.context_length),
          input: inputModalities(architecture.input_modalities),
          toolUse: params.has("tools") || params.has("tool_choice") ? "yes" : "unknown",
          structuredOutput: params.has("response_format") || params.has("structured_output") ? "yes" : "unknown",
          reasoning: params.has("reasoning") || params.has("include_reasoning") ? "yes" : "unknown",
          promptCache: pricing.input_cache_read !== undefined ? "yes" : "unknown",
          tier: inferTier(modelKey),
          confidence: "medium",
          available: "yes",
          source: "openrouter",
        }];
      });
    },
  };
}

export function createModelsDevCapabilitySource(options: CapabilitySourceOptions = {}): CapabilitySource {
  return {
    name: "models.dev",
    fetch: async () => {
      const data = await fetcher(options)(MODELS_DEV_URL);
      const records: CapabilitySourceRecord[] = [];
      for (const [provider, providerValue] of Object.entries(asRecord(data))) {
        const providerModels = asRecord(providerValue).models;
        if (!isRecord(providerModels)) continue;
        for (const [fallbackId, modelValue] of Object.entries(providerModels)) {
          const model = asRecord(modelValue);
          const id = asString(model.id) || fallbackId;
          const modelKey = canonicalModelKey(`${provider}/${id}`);
          const cost = asRecord(model.cost);
          const input = asNumber(cost.input);
          const output = asNumber(cost.output);
          records.push({
            modelKey,
            name: asString(model.name) || undefined,
            price: blended(input, output),
            inputUsdPerMTok: input,
            outputUsdPerMTok: output,
            contextWindow: asNumber(asRecord(model.limit).context),
            input: inputModalities(asRecord(model.modalities).input),
            toolUse: triState(model.tool_call),
            structuredOutput: triState(model.structured_output),
            reasoning: triState(model.reasoning),
            promptCache: triState(model.cache),
            tier: inferTier(modelKey),
            confidence: "medium",
            available: "yes",
            lastVerifiedAt: asString(model.last_updated) || asString(model.release_date) || undefined,
            source: "models.dev",
          });
        }
      }
      return records;
    },
  };
}

export function createLiteLLMCapabilitySource(options: CapabilitySourceOptions = {}): CapabilitySource {
  return {
    name: "litellm",
    fetch: async () => {
      const data = await fetcher(options)(LITELLM_PRICES_URL);
      const records: CapabilitySourceRecord[] = [];
      for (const [key, value] of Object.entries(asRecord(data))) {
        if (key === "sample_spec") continue;
        const record = asRecord(value);
        const provider = asString(record.litellm_provider);
        const modelKey = canonicalModelKey(key.includes("/") || !provider ? key : `${provider}/${key}`);
        const input = perTokenToPerMTok(record.input_cost_per_token);
        const output = perTokenToPerMTok(record.output_cost_per_token);
        records.push({
          modelKey,
          price: blended(input, output),
          inputUsdPerMTok: input,
          outputUsdPerMTok: output,
          cacheReadUsdPerMTok: perTokenToPerMTok(record.cache_read_input_token_cost),
          cacheWriteUsdPerMTok: perTokenToPerMTok(record.cache_creation_input_token_cost),
          contextWindow: asNumber(record.max_input_tokens ?? record.max_tokens),
          toolUse: triState(record.supports_function_calling),
          structuredOutput: triState(record.supports_response_schema ?? record.supports_json_schema),
          reasoning: triState(record.supports_reasoning),
          tier: inferTier(modelKey),
          confidence: "medium",
          available: "yes",
          source: "litellm",
        });
      }
      return records;
    },
  };
}
