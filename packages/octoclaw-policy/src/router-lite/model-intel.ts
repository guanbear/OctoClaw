import type {
  ModelIntelLite,
  ModelIntelSnapshot,
  RouterLiteCapability,
  RouterLiteCapabilityEvidence,
  RouterLiteCodingTier,
  RouterLiteConfidence,
  RouterLiteEffectiveCostBand,
  RouterLiteHealth,
  RouterLitePlan,
  RouterLitePrice,
  RouterLiteTriState,
} from "./contracts.js";

type JsonRecord = Record<string, unknown>;

export interface BuildModelIntelSnapshotInput {
  generatedAt?: string;
  openClawModelsList?: unknown;
  openClawConfig?: unknown;
  legacyCatalog?: unknown;
  usageStatus?: unknown;
  usageCost?: unknown;
}

interface PartialModelIntel {
  provider: string;
  model: string;
  modelKey: string;
  name?: string;
  configured?: boolean;
  available?: RouterLiteTriState;
  tags?: string[];
  marketPrice?: Partial<RouterLitePrice>;
  capability?: Partial<RouterLiteCapability>;
  health?: Partial<RouterLiteHealth>;
  plan?: Partial<RouterLitePlan>;
  sources: string[];
}

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
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean);
  const text = asString(value);
  return text ? [text] : [];
}

function sourceStatus(source: string, value: unknown): { source: string; status: "ok" | "missing" } {
  return { source, status: value === undefined || value === null ? "missing" : "ok" };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function splitModelKey(key: string, providerFallback = ""): { provider: string; model: string; modelKey: string } {
  const normalized = key.trim();
  const slash = normalized.indexOf("/");
  if (slash > 0) {
    return {
      provider: normalized.slice(0, slash),
      model: normalized.slice(slash + 1),
      modelKey: normalized,
    };
  }
  const provider = providerFallback.trim();
  return {
    provider,
    model: normalized,
    modelKey: provider ? `${provider}/${normalized}` : normalized,
  };
}

function normalizeInputModalities(value: unknown): RouterLiteCapability["input"] {
  const values = asStringArray(value).map((item) => item.toLowerCase());
  const allowed = new Set(["text", "image", "audio", "video"]);
  const result = values.filter((item): item is "text" | "image" | "audio" | "video" => allowed.has(item));
  return result.length > 0 ? unique(result) as RouterLiteCapability["input"] : ["text"];
}

function triState(value: unknown): RouterLiteTriState {
  const bool = asBoolean(value);
  if (bool === true) return "yes";
  if (bool === false) return "no";
  const text = asString(value).toLowerCase();
  if (text === "yes" || text === "supported") return "yes";
  if (text === "no" || text === "unsupported") return "no";
  return "unknown";
}

function confidenceRank(value: RouterLiteConfidence): number {
  switch (value) {
    case "high": return 4;
    case "medium": return 3;
    case "low": return 2;
    default: return 1;
  }
}

function maxConfidence(values: Array<RouterLiteConfidence | undefined>, fallback: RouterLiteConfidence): RouterLiteConfidence {
  return values.filter(Boolean).reduce<RouterLiteConfidence>(
    (best, value) => confidenceRank(value!) > confidenceRank(best) ? value! : best,
    fallback,
  );
}

function inferCodingTier(modelKey: string, rawHint?: unknown): RouterLiteCodingTier {
  const hint = asString(rawHint).toLowerCase();
  const text = `${modelKey} ${hint}`.toLowerCase();
  if (text.includes("mini") || text.includes("flash") || text.includes("haiku") || hint === "mini") return "mini";
  if (text.includes("5.5") || text.includes("gpt-5.4") || text.includes("frontier") || text.includes("deep")) return "frontier";
  if (text.includes("glm-5") || text.includes("sonnet") || hint === "strong") return "strong";
  if (text.includes("4.7") || text.includes("standard") || hint === "base") return "standard";
  return "unknown";
}

function mergePrice(base: RouterLitePrice, incoming?: Partial<RouterLitePrice>): RouterLitePrice {
  if (!incoming) return base;
  return {
    inputUsdPerMTok: incoming.inputUsdPerMTok ?? base.inputUsdPerMTok,
    outputUsdPerMTok: incoming.outputUsdPerMTok ?? base.outputUsdPerMTok,
    cacheReadUsdPerMTok: incoming.cacheReadUsdPerMTok ?? base.cacheReadUsdPerMTok,
    cacheWriteUsdPerMTok: incoming.cacheWriteUsdPerMTok ?? base.cacheWriteUsdPerMTok,
    confidence: maxConfidence([base.confidence, incoming.confidence], "unknown"),
    sources: unique([...base.sources, ...(incoming.sources ?? [])]),
    missingCostReason: incoming.missingCostReason ?? base.missingCostReason,
  };
}

function mergeCapability(base: RouterLiteCapability, incoming?: Partial<RouterLiteCapability>): RouterLiteCapability {
  if (!incoming) return base;
  return {
    contextWindow: incoming.contextWindow ?? base.contextWindow,
    input: unique([...(incoming.input ?? []), ...base.input]) as RouterLiteCapability["input"],
    toolUse: incoming.toolUse && incoming.toolUse !== "unknown" ? incoming.toolUse : base.toolUse,
    structuredOutput: incoming.structuredOutput && incoming.structuredOutput !== "unknown" ? incoming.structuredOutput : base.structuredOutput,
    reasoning: incoming.reasoning && incoming.reasoning !== "unknown" ? incoming.reasoning : base.reasoning,
    promptCache: incoming.promptCache && incoming.promptCache !== "unknown" ? incoming.promptCache : base.promptCache,
    codingTier: incoming.codingTier && incoming.codingTier !== "unknown" ? incoming.codingTier : base.codingTier,
    confidence: maxConfidence([base.confidence, incoming.confidence], "unknown"),
    evidence: unique([...(base.evidence ?? []), ...(incoming.evidence ?? [])]) as RouterLiteCapabilityEvidence[],
    sources: unique([...base.sources, ...(incoming.sources ?? [])]),
  };
}

function mergeHealth(base: RouterLiteHealth, incoming?: Partial<RouterLiteHealth>): RouterLiteHealth {
  if (!incoming) return base;
  return {
    available: incoming.available && incoming.available !== "unknown" ? incoming.available : base.available,
    cooldown: incoming.cooldown ?? base.cooldown,
    quotaPressure: incoming.quotaPressure && incoming.quotaPressure !== "unknown" ? incoming.quotaPressure : base.quotaPressure,
    p50LatencyMs: incoming.p50LatencyMs ?? base.p50LatencyMs,
    p95LatencyMs: incoming.p95LatencyMs ?? base.p95LatencyMs,
    recentFailureRate: incoming.recentFailureRate ?? base.recentFailureRate,
    toolCallFailureRate: incoming.toolCallFailureRate ?? base.toolCallFailureRate,
    timeoutRate: incoming.timeoutRate ?? base.timeoutRate,
    sources: unique([...base.sources, ...(incoming.sources ?? [])]),
  };
}

function mergePlan(base: RouterLitePlan, incoming?: Partial<RouterLitePlan>): RouterLitePlan {
  if (!incoming) return base;
  return {
    type: incoming.type && incoming.type !== "unknown" ? incoming.type : base.type,
    quotaPressure: incoming.quotaPressure && incoming.quotaPressure !== "unknown" ? incoming.quotaPressure : base.quotaPressure,
    effectiveCostBand: incoming.effectiveCostBand && incoming.effectiveCostBand !== "unknown" ? incoming.effectiveCostBand : base.effectiveCostBand,
    resetAt: incoming.resetAt ?? base.resetAt,
    sources: unique([...base.sources, ...(incoming.sources ?? [])]),
  };
}

function emptyModel(partial: PartialModelIntel): ModelIntelLite {
  return {
    provider: partial.provider,
    model: partial.model,
    modelKey: partial.modelKey,
    name: partial.name,
    configured: partial.configured === true,
    available: partial.available ?? "unknown",
    proposalOnly: partial.configured !== true,
    tags: unique(partial.tags ?? []),
    marketPrice: {
      confidence: "unknown",
      sources: [],
      missingCostReason: "cost_not_observed",
    },
    capability: {
      input: ["text"],
      toolUse: "unknown",
      structuredOutput: "unknown",
      reasoning: "unknown",
      promptCache: "unknown",
      codingTier: inferCodingTier(partial.modelKey),
      confidence: "low",
      evidence: ["heuristic"],
      sources: [],
    },
    health: {
      available: partial.available ?? "unknown",
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
    sources: unique(partial.sources),
  };
}

function mergeModel(base: ModelIntelLite | undefined, incoming: PartialModelIntel): ModelIntelLite {
  const next = base ?? emptyModel(incoming);
  return {
    ...next,
    provider: next.provider || incoming.provider,
    model: next.model || incoming.model,
    modelKey: next.modelKey || incoming.modelKey,
    name: incoming.name || next.name,
    configured: next.configured || incoming.configured === true,
    available: incoming.available && incoming.available !== "unknown" ? incoming.available : next.available,
    proposalOnly: !(next.configured || incoming.configured === true),
    tags: unique([...next.tags, ...(incoming.tags ?? [])]),
    marketPrice: mergePrice(next.marketPrice, incoming.marketPrice),
    capability: mergeCapability(next.capability, incoming.capability),
    health: mergeHealth(next.health, incoming.health),
    plan: mergePlan(next.plan, incoming.plan),
    sources: unique([...next.sources, ...incoming.sources]),
  };
}

function priceFromCost(cost: unknown, source: string): Partial<RouterLitePrice> | undefined {
  const record = asRecord(cost);
  const input = asNumber(record.input);
  const output = asNumber(record.output);
  const cacheRead = asNumber(record.cacheRead ?? record.cache_read);
  const cacheWrite = asNumber(record.cacheWrite ?? record.cache_write);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    inputUsdPerMTok: input,
    outputUsdPerMTok: output,
    cacheReadUsdPerMTok: cacheRead,
    cacheWriteUsdPerMTok: cacheWrite,
    confidence: "high",
    sources: [source],
    missingCostReason: undefined,
  };
}

function modelFromOpenClawList(item: unknown): PartialModelIntel | undefined {
  const record = asRecord(item);
  const key = asString(record.key);
  if (!key) return undefined;
  const identity = splitModelKey(key);
  const available = asBoolean(record.available);
  const tags = asStringArray(record.tags);
  const contextWindow = asNumber(record.contextWindow);
  return {
    ...identity,
    name: asString(record.name) || undefined,
    configured: tags.includes("configured") || record.missing === false,
    available: available === undefined ? "unknown" : available ? "yes" : "no",
    tags,
    capability: {
      contextWindow,
      input: normalizeInputModalities(record.input),
      confidence: "high",
      evidence: ["declared"],
      sources: ["openclaw_models_list"],
    },
    health: {
      available: available === undefined ? "unknown" : available ? "yes" : "no",
      sources: ["openclaw_models_list"],
    },
    sources: ["openclaw_models_list"],
  };
}

function modelsFromOpenClawConfig(config: unknown): PartialModelIntel[] {
  const providers = asRecord(asRecord(config).models).providers;
  if (!isRecord(providers)) return [];
  const models: PartialModelIntel[] = [];
  for (const [provider, providerValue] of Object.entries(providers)) {
    const providerRecord = asRecord(providerValue);
    const providerModels = Array.isArray(providerRecord.models) ? providerRecord.models : [];
    for (const rawModel of providerModels) {
      const modelRecord = asRecord(rawModel);
      const id = asString(modelRecord.id);
      if (!id) continue;
      const identity = splitModelKey(id, provider);
      const contextWindow = asNumber(modelRecord.contextWindow);
      const reasoning = triState(modelRecord.reasoning);
      const marketPrice = priceFromCost(modelRecord.cost, "openclaw_config");
      models.push({
        ...identity,
        name: asString(modelRecord.name) || undefined,
        configured: true,
        available: "unknown",
        capability: {
          contextWindow,
          input: normalizeInputModalities(modelRecord.input),
          reasoning,
          confidence: "high",
          evidence: ["declared"],
          sources: ["openclaw_config"],
        },
        marketPrice,
        sources: ["openclaw_config"],
      });
    }
  }
  return models;
}

function effectiveCostBandFromPrice(input?: number, output?: number): RouterLiteEffectiveCostBand {
  if (input === 0 && output === 0) return "free_or_sunk";
  const blended = Math.max(input ?? 0, output ?? 0);
  if (!Number.isFinite(blended) || blended <= 0) return "unknown";
  if (blended <= 0.5) return "cheap";
  if (blended <= 5) return "normal";
  return "expensive";
}

function modelsFromLegacyCatalog(catalog: unknown): PartialModelIntel[] {
  const rawModels = asRecord(catalog).models;
  if (!Array.isArray(rawModels)) return [];
  const models: PartialModelIntel[] = [];
  for (const rawModel of rawModels) {
    const record = asRecord(rawModel);
    const id = asString(record.id);
    const provider = asString(record.provider);
    if (!id && !provider) continue;
    const identity = splitModelKey(id || asString(record.model), provider);
    if (!identity.modelKey) continue;
    const pricing = asRecord(record.pricing);
    const inputPrice = asNumber(pricing.input);
    const outputPrice = asNumber(pricing.output);
    const limits = asRecord(record.limits);
    const capabilityHints = asRecord(record.capability_hints);
    const planState = asRecord(record.plan_state);
    const configured = asBoolean(record.configured) === true || asBoolean(asRecord(record.local_truth_signals).configured) === true;
    const available = asBoolean(record.available);
    const tier = inferCodingTier(identity.modelKey, record.size_class);
    models.push({
      ...identity,
      name: asString(record.short_name) || undefined,
      configured,
      available: available === undefined ? "unknown" : available ? "yes" : "no",
      tags: configured ? ["configured"] : [],
      marketPrice: {
        inputUsdPerMTok: inputPrice,
        outputUsdPerMTok: outputPrice,
        confidence: inputPrice !== undefined || outputPrice !== undefined ? "medium" : "unknown",
        sources: inputPrice !== undefined || outputPrice !== undefined ? ["legacy_model_catalog"] : [],
        missingCostReason: inputPrice === undefined && outputPrice === undefined ? "legacy_catalog_missing_price" : undefined,
      },
      capability: {
        contextWindow: asNumber(limits.context_length),
        input: normalizeInputModalities(asRecord(record.modalities).input),
        toolUse: triState(capabilityHints.tool_call),
        reasoning: triState(capabilityHints.reasoning),
        codingTier: tier,
        confidence: "low",
        evidence: ["heuristic"],
        sources: ["legacy_model_catalog"],
      },
      plan: {
        type: asString(planState.type) === "subscription" ? "subscription" : "unknown",
        quotaPressure: asString(planState.quota_pressure) as RouterLitePlan["quotaPressure"] || "unknown",
        effectiveCostBand: effectiveCostBandFromPrice(inputPrice, outputPrice),
        sources: Object.keys(planState).length > 0 ? ["legacy_model_catalog"] : [],
      },
      sources: ["legacy_model_catalog"],
    });
  }
  return models;
}

function addUsageSignals(models: ModelIntelLite[], usageStatus: unknown, usageCost: unknown): ModelIntelLite[] {
  const usageStatusPresent = isRecord(usageStatus);
  const usageCostPresent = isRecord(usageCost);
  return models.map((model) => ({
    ...model,
    health: {
      ...model.health,
      quotaPressure: model.health.quotaPressure,
      sources: unique([
        ...model.health.sources,
        ...(usageStatusPresent ? ["openclaw_usage_status"] : []),
        ...(usageCostPresent ? ["openclaw_usage_cost"] : []),
      ]),
    },
    plan: {
      ...model.plan,
      quotaPressure: model.plan.quotaPressure,
      sources: unique([
        ...model.plan.sources,
        ...(usageStatusPresent ? ["openclaw_usage_status"] : []),
      ]),
    },
  }));
}

export function buildModelIntelSnapshot(input: BuildModelIntelSnapshotInput): ModelIntelSnapshot {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const partials: PartialModelIntel[] = [
    ...(Array.isArray(asRecord(input.openClawModelsList).models)
      ? (asRecord(input.openClawModelsList).models as unknown[]).flatMap((item) => {
          const model = modelFromOpenClawList(item);
          return model ? [model] : [];
        })
      : []),
    ...modelsFromOpenClawConfig(input.openClawConfig),
    ...modelsFromLegacyCatalog(input.legacyCatalog),
  ];

  const merged = new Map<string, ModelIntelLite>();
  for (const partial of partials) {
    merged.set(partial.modelKey, mergeModel(merged.get(partial.modelKey), partial));
  }
  const models = addUsageSignals(
    Array.from(merged.values()).map((model) => ({
      ...model,
      proposalOnly: !model.configured,
      marketPrice: model.marketPrice.sources.length > 0
        ? model.marketPrice
        : { ...model.marketPrice, missingCostReason: model.marketPrice.missingCostReason ?? "cost_not_observed" },
      capability: {
        ...model.capability,
        confidence: model.capability.evidence.includes("declared") ? maxConfidence([model.capability.confidence, "medium"], "low") : model.capability.confidence,
      },
    })),
    input.usageStatus,
    input.usageCost,
  ).sort((a, b) => a.modelKey.localeCompare(b.modelKey));

  return {
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: `model-intel:${Date.parse(generatedAt) || Date.now()}`,
    generatedAt,
    sourceStatus: [
      sourceStatus("openclaw_models_list", input.openClawModelsList),
      sourceStatus("openclaw_config", input.openClawConfig),
      sourceStatus("legacy_model_catalog", input.legacyCatalog),
      sourceStatus("openclaw_usage_status", input.usageStatus),
      sourceStatus("openclaw_usage_cost", input.usageCost),
    ],
    models,
  };
}
