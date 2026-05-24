import type {
  ModelIntelLite,
  ModelIntelSnapshot,
  RouterLiteBenchmarkEfficiency,
  RouterLiteCapability,
  RouterLiteCapabilityEvidence,
  RouterLiteCodingTier,
  RouterLiteConfidence,
  RouterLiteFusedScore,
  RouterLiteEffectiveCostBand,
  RouterLiteHealth,
  RouterLitePlan,
  RouterLitePrice,
  RouterLiteQuotaPressure,
  RouterLiteTriState,
  ScenarioAbilityLite,
  ScenarioAbilityScore,
  ScenarioAbilitySource,
} from "./contracts.js";

type JsonRecord = Record<string, unknown>;

export interface BuildModelIntelFactsPlaneInput {
  generatedAt?: string;
  openClawModelsList?: unknown;
  openClawConfig?: unknown;
  legacyCatalog?: unknown;
  packagedSnapshot?: unknown;
  usageStatus?: unknown;
  usageCost?: unknown;
  healthSnapshot?: unknown;
  nativeFallbackOrder?: unknown;
  scenarioData?: unknown;
}

export interface ModelIntelFactsPlane {
  generatedAt: string;
  nativeFallbackOrder?: string[];
  sourceStatus: ModelIntelSnapshot["sourceStatus"];
  models: ModelIntelLite[];
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
  benchmarkEfficiency?: RouterLiteBenchmarkEfficiency;
  scenarioAbility?: ScenarioAbilityLite;
  freshness?: string;
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

function canonicalFactsKey(modelKey: string): string {
  const slash = modelKey.indexOf("/");
  if (slash <= 0) return modelKey.toLowerCase();
  const provider = modelKey.slice(0, slash).toLowerCase();
  const model = modelKey.slice(slash + 1);
  if ((provider === "zhipu" || provider === "zai") && /^glm-/iu.test(model)) {
    return `zhipu/${model.toLowerCase()}`;
  }
  return modelKey.toLowerCase();
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

function emptyScenarioAbility(): ScenarioAbilityLite {
  const empty: ScenarioAbilityScore = { tier: "unknown", confidence: "unknown", sources: [] };
  return {
    codingWorker: { ...empty },
    agenticToolTask: { ...empty },
    researchLookup: { ...empty },
    dataLogAnalysis: { ...empty },
    mainReasoning: { ...empty },
    defaultDelegate: { ...empty },
  };
}

function scenarioAbilityKeys(): Array<keyof ScenarioAbilityLite> {
  return [
    "codingWorker",
    "agenticToolTask",
    "researchLookup",
    "dataLogAnalysis",
    "mainReasoning",
    "defaultDelegate",
  ];
}

function isScenarioAbilityTier(value: unknown): value is ScenarioAbilityScore["tier"] {
  return value === "S" || value === "A" || value === "B" || value === "C" || value === "unknown";
}

function isScenarioAbilityConfidence(value: unknown): value is ScenarioAbilityScore["confidence"] {
  return value === "high" || value === "medium" || value === "low" || value === "unknown";
}

function tierFromCodingTier(tier: RouterLiteCodingTier | undefined): ScenarioAbilityScore["tier"] {
  switch (tier) {
    case "frontier": return "S";
    case "strong": return "A";
    case "standard": return "B";
    case "mini": return "C";
    default: return "unknown";
  }
}

function scenarioAbilitySourceFromCapabilitySource(source: string): ScenarioAbilitySource | undefined {
  switch (source) {
    case "operator_override": return "operator_override";
    case "openclaw_config": return "operator_override";
    case "openclaw_models_list": return "operator_override";
    case "local_replay": return "local_replay";
    case "artificial_analysis": return "artificial_analysis";
    case "packaged_leaderboard": return "artificial_analysis";
    case "packaged_model_intel": return "artificial_analysis";
    case "pinchbench": return "pinchbench";
    case "aider": return "aider";
    case "swe_bench": return "swe_bench";
    case "swe_bench_verified": return "swe_bench";
    case "swe_bench_pro": return "swe_bench";
    case "bfcl": return "bfcl";
    default: return undefined;
  }
}

function inferScenarioAbility(model: PartialModelIntel, fetchedAt = model.freshness ?? new Date().toISOString()): ScenarioAbilityLite {
  const tier = tierFromCodingTier(model.capability?.codingTier ?? inferCodingTier(model.modelKey));
  const sources = unique(model.capability?.sources ?? [])
    .map((source) => scenarioAbilitySourceFromCapabilitySource(source))
    .filter((source): source is ScenarioAbilitySource => Boolean(source))
    .map((source) => ({ source, fetchedAt }));
  const confidence = sources.length > 0 ? model.capability?.confidence ?? "unknown" : "low";
  const score: ScenarioAbilityScore = { tier, confidence, sources };
  return {
    codingWorker: { ...score, sources: [...sources] },
    agenticToolTask: { ...score, sources: [...sources] },
    researchLookup: { ...score, sources: [...sources] },
    dataLogAnalysis: { ...score, sources: [...sources] },
    mainReasoning: { ...score, sources: [...sources] },
    defaultDelegate: { ...score, sources: [...sources] },
  };
}

function parseScenarioData(scenarioData: unknown): Map<string, ScenarioAbilityLite> {
  const result = new Map<string, ScenarioAbilityLite>();
  if (!isRecord(scenarioData)) return result;
  for (const [key, value] of Object.entries(scenarioData)) {
    if (isRecord(value)) {
      const hasScenarioField = scenarioAbilityKeys().some((field) => isRecord(asRecord(value)[field]));
      if (hasScenarioField) {
        result.set(canonicalFactsKey(key), value as unknown as ScenarioAbilityLite);
      }
    }
  }
  return result;
}

function mergeScenarioAbility(base: ScenarioAbilityLite, incoming?: Partial<ScenarioAbilityLite>): ScenarioAbilityLite {
  if (!incoming) return base;
  const result: ScenarioAbilityLite = { ...base };
  for (const field of scenarioAbilityKeys()) {
    const inc = incoming[field];
    if (inc && isRecord(inc)) {
      const incScore = inc as unknown as ScenarioAbilityScore;
      result[field] = {
        score: incScore.score ?? base[field].score,
        tier: isScenarioAbilityTier(incScore.tier) && incScore.tier !== "unknown" ? incScore.tier : base[field].tier,
        confidence: isScenarioAbilityConfidence(incScore.confidence)
          ? maxConfidence([base[field].confidence, incScore.confidence], base[field].confidence)
          : base[field].confidence,
        sources: unique([
          ...base[field].sources.map((source) => JSON.stringify(source)),
          ...(Array.isArray(incScore.sources) ? incScore.sources.map((source) => JSON.stringify(source)) : []),
        ]).map((source) => JSON.parse(source) as ScenarioAbilityScore["sources"][number]),
      };
    }
  }
  return result;
}

function inferCodingTier(modelKey: string, rawHint?: unknown): RouterLiteCodingTier {
  const hint = asString(rawHint).toLowerCase();
  const text = `${modelKey} ${hint}`.toLowerCase();
  if (hasCompactModelModifier(text) || hint === "mini") return "mini";
  if (hasFrontierModelModifier(text) || hasFrontierVersionModifier(text) || hint === "frontier") return "frontier";
  if (hasStrongModelModifier(text) || hint === "strong") return "strong";
  if (hasStandardModelModifier(text) || text.includes("standard") || hint === "base") return "standard";
  return "unknown";
}

function hasCompactModelModifier(text: string): boolean {
  return /(^|[/._\-\s])(mini|flash|haiku|small|lite|air)([/._\-\s]|$)/.test(text);
}

function hasFrontierModelModifier(text: string): boolean {
  return /(^|[/._\-\s])(opus|ultra|frontier)([/._\-\s]|$)/.test(text);
}

function hasStrongModelModifier(text: string): boolean {
  if (/(^|[/._\-\s])(pro|max|plus|sonnet)([/._\-\s]|$)/.test(text)) return true;
  const versions = Array.from(text.matchAll(/(?:^|[/._\-\s]|[a-z])(?:v)?(\d+)(?:[._-](\d+))?/g))
    .map((match) => Number(match[1]))
    .filter((major) => Number.isFinite(major));
  return versions.some((major) => major >= 5);
}

function hasStandardModelModifier(text: string): boolean {
  const versions = Array.from(text.matchAll(/(?:^|[/._\-\s]|[a-z])(?:v)?(\d+)(?:[._-](\d+))?/g))
    .map((match) => Number(match[1]))
    .filter((major) => Number.isFinite(major));
  return versions.some((major) => major >= 4);
}

function hasFrontierVersionModifier(text: string): boolean {
  const versions = Array.from(text.matchAll(/(?:^|[/._\-\s]|[a-z])(?:v)?(\d+)(?:[._-](\d+))?/g))
    .map((match) => ({
      major: Number(match[1]),
      minor: match[2] === undefined ? 0 : Number(`0.${match[2]}`),
    }))
    .filter((version) => Number.isFinite(version.major) && Number.isFinite(version.minor));
  return versions.some((version) => version.major > 5 || (version.major === 5 && version.minor >= 0.5));
}

function pricesConflict(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined || (a === 0 && b === 0)) return false;
  const max = Math.max(Math.abs(a), Math.abs(b));
  return max > 0 && Math.abs(a - b) / max > 0.2;
}

function mergePrice(base: RouterLitePrice, incoming?: Partial<RouterLitePrice>): RouterLitePrice {
  if (!incoming) return base;
  const inputConflict = pricesConflict(base.inputUsdPerMTok, incoming.inputUsdPerMTok);
  const outputConflict = pricesConflict(base.outputUsdPerMTok, incoming.outputUsdPerMTok);
  const conflict = incoming.conflict === true || base.conflict === true || inputConflict || outputConflict;
  return {
    inputUsdPerMTok: incoming.inputUsdPerMTok ?? base.inputUsdPerMTok,
    outputUsdPerMTok: incoming.outputUsdPerMTok ?? base.outputUsdPerMTok,
    cacheReadUsdPerMTok: incoming.cacheReadUsdPerMTok ?? base.cacheReadUsdPerMTok,
    cacheWriteUsdPerMTok: incoming.cacheWriteUsdPerMTok ?? base.cacheWriteUsdPerMTok,
    blendedUsdPerMTok: incoming.blendedUsdPerMTok ?? base.blendedUsdPerMTok,
    ratioBaselineModel: incoming.ratioBaselineModel ?? base.ratioBaselineModel,
    ratioToBaseline: incoming.ratioToBaseline ?? base.ratioToBaseline,
    conflict: conflict || undefined,
    confidence: conflict ? "low" : maxConfidence([base.confidence, incoming.confidence], "unknown"),
    sources: unique([...base.sources, ...(incoming.sources ?? [])]),
    missingCostReason: incoming.missingCostReason ?? (incoming.sources && incoming.sources.length > 0 ? undefined : base.missingCostReason),
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
    scoreByScenario: incoming.scoreByScenario ?? base.scoreByScenario,
    capabilityScore: incoming.capabilityScore ?? base.capabilityScore,
  };
}

function mergeHealth(base: RouterLiteHealth, incoming?: Partial<RouterLiteHealth>): RouterLiteHealth {
  if (!incoming) return base;
  return {
    available: incoming.available && incoming.available !== "unknown" ? incoming.available : base.available,
    cooldown: incoming.cooldown ?? base.cooldown,
    cooldownUntil: incoming.cooldownUntil ?? base.cooldownUntil,
    cooldownReason: incoming.cooldownReason ?? base.cooldownReason,
    quotaPressure: incoming.quotaPressure && incoming.quotaPressure !== "unknown" ? incoming.quotaPressure : base.quotaPressure,
    p50FirstTokenMs: incoming.p50FirstTokenMs ?? base.p50FirstTokenMs,
    p95FirstTokenMs: incoming.p95FirstTokenMs ?? base.p95FirstTokenMs,
    p50OutputTokensPerSecond: incoming.p50OutputTokensPerSecond ?? base.p50OutputTokensPerSecond,
    p50LatencyMs: incoming.p50LatencyMs ?? base.p50LatencyMs,
    p95LatencyMs: incoming.p95LatencyMs ?? base.p95LatencyMs,
    baselineP95LatencyMs: incoming.baselineP95LatencyMs ?? base.baselineP95LatencyMs,
    baselineP95WindowCount: incoming.baselineP95WindowCount ?? base.baselineP95WindowCount,
    recentFailureRate: incoming.recentFailureRate ?? base.recentFailureRate,
    toolCallFailureRate: incoming.toolCallFailureRate ?? base.toolCallFailureRate,
    timeoutRate: incoming.timeoutRate ?? base.timeoutRate,
    lastSuccessfulCallAt: mostRecentTimestamp(base.lastSuccessfulCallAt, incoming.lastSuccessfulCallAt),
    lastFailedCallAt: mostRecentTimestamp(base.lastFailedCallAt, incoming.lastFailedCallAt),
    lastErrorCodes: incoming.lastErrorCodes ?? base.lastErrorCodes,
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

function mostRecentTimestamp(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (!Number.isFinite(aTime)) return b;
  if (!Number.isFinite(bTime)) return a;
  return bTime > aTime ? b : a;
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
    scenarioAbility: emptyScenarioAbility(),
    freshness: partial.freshness,
    sources: unique(partial.sources),
  };
}

function mergeAvailable(base: RouterLiteTriState, incoming?: RouterLiteTriState): RouterLiteTriState {
  if (!incoming || incoming === "unknown") return base;
  if (base === "no" || incoming === "no") return "no";
  if (incoming === "yes") return "yes";
  return base;
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
    available: mergeAvailable(next.available, incoming.available),
    proposalOnly: !(next.configured || incoming.configured === true),
    tags: unique([...next.tags, ...(incoming.tags ?? [])]),
    marketPrice: mergePrice(next.marketPrice, incoming.marketPrice),
    capability: mergeCapability(next.capability, incoming.capability),
    health: mergeHealth(next.health, incoming.health),
    plan: mergePlan(next.plan, incoming.plan),
    benchmarkEfficiency: incoming.benchmarkEfficiency ?? next.benchmarkEfficiency,
    scenarioAbility: mergeScenarioAbility(next.scenarioAbility ?? emptyScenarioAbility(), incoming.scenarioAbility),
    freshness: mostRecentTimestamp(next.freshness, incoming.freshness),
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
  if ((input ?? 0) === 0 && (output ?? 0) === 0 && (cacheRead ?? 0) === 0 && (cacheWrite ?? 0) === 0) return undefined;
  return {
    inputUsdPerMTok: input,
    outputUsdPerMTok: output,
    cacheReadUsdPerMTok: cacheRead,
    cacheWriteUsdPerMTok: cacheWrite,
    blendedUsdPerMTok: blendedPrice(input, output),
    confidence: "high",
    sources: [source],
    missingCostReason: undefined,
  };
}

function blendedPrice(input?: number, output?: number): number | undefined {
  if (input === undefined && output === undefined) return undefined;
  const safeInput = input ?? 0;
  const safeOutput = output ?? 0;
  return (safeInput * 3 + safeOutput) / 4;
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
    configured: tags.includes("configured"),
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
        available: "yes",
        capability: {
          contextWindow,
          input: normalizeInputModalities(modelRecord.input),
          reasoning,
          confidence: "high",
          evidence: ["declared"],
          sources: ["openclaw_config"],
        },
        health: {
          available: "yes",
          sources: ["openclaw_config"],
        },
        marketPrice,
        sources: ["openclaw_config"],
      });
    }
  }
  return models;
}

function isOpenAiFamilyModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return /^gpt-\d/u.test(normalized) || normalized.startsWith("chatgpt-") || /^o\d/u.test(normalized);
}

function gptMajor(modelId: string): string | undefined {
  return /^gpt-(\d+)/u.exec(modelId.toLowerCase())?.[1];
}

function isMiniCandidate(modelId: string): boolean {
  return modelId.toLowerCase().includes("mini");
}

function hasPortableOpenAiFacts(model: PartialModelIntel): boolean {
  const sources = unique([
    ...model.sources,
    ...(model.marketPrice?.sources ?? []),
    ...(model.capability?.sources ?? []),
  ]);
  return sources.some((source) => source !== "openclaw_models_list" && source !== "openclaw_config");
}

function mirrorOpenAiCandidatesForCompatibleProviders(partials: PartialModelIntel[]): PartialModelIntel[] {
  const existing = new Set(partials.map((model) => model.modelKey));
  const proxyProviders = new Map<string, Set<string>>();
  for (const model of partials) {
    const major = gptMajor(model.model);
    if (model.configured === true && model.provider !== "openai" && major) {
      const majors = proxyProviders.get(model.provider) ?? new Set<string>();
      majors.add(major);
      proxyProviders.set(model.provider, majors);
    }
  }
  if (proxyProviders.size === 0) return [];

  const openAiCandidates = partials.filter((model) => model.provider === "openai" && isOpenAiFamilyModel(model.model) && hasPortableOpenAiFacts(model));
  const mirrored: PartialModelIntel[] = [];
  for (const [provider, majors] of proxyProviders) {
    for (const candidate of openAiCandidates) {
      const major = gptMajor(candidate.model);
      if (!major || !majors.has(major)) continue;
      const modelKey = `${provider}/${candidate.model}`;
      const alreadyExists = existing.has(modelKey);
      if (!alreadyExists) existing.add(modelKey);
      if (!alreadyExists && !isMiniCandidate(candidate.model)) continue;
      mirrored.push({
        ...candidate,
        provider,
        modelKey,
        configured: false,
        available: candidate.available === "no" ? "yes" : candidate.available,
        tags: (candidate.tags ?? []).filter((tag) => tag !== "configured"),
        sources: unique([...candidate.sources, "provider_alias:openai"]),
      });
    }
  }
  return mirrored;
}

function effectiveCostBandFromPrice(input?: number, output?: number): RouterLiteEffectiveCostBand {
  if (input === 0 && output === 0) return "free_or_sunk";
  const blended = Math.max(input ?? 0, output ?? 0);
  if (!Number.isFinite(blended) || blended <= 0) return "unknown";
  if (blended <= 0.5) return "cheap";
  if (blended <= 5) return "normal";
  return "expensive";
}

function quotaPressure(value: unknown): RouterLiteQuotaPressure | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "unknown") return value;
  return undefined;
}

function planType(value: unknown): RouterLitePlan["type"] | undefined {
  if (value === "pay_as_you_go" || value === "subscription" || value === "free_quota" || value === "unknown") return value;
  return undefined;
}

function effectiveCostBand(value: unknown): RouterLiteEffectiveCostBand | undefined {
  if (value === "free_or_sunk" || value === "cheap" || value === "normal" || value === "expensive" || value === "unknown") return value;
  return undefined;
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
        blendedUsdPerMTok: blendedPrice(inputPrice, outputPrice),
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

function partialObject<T>(value: unknown): Partial<T> | undefined {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record as Partial<T> : undefined;
}

function benchmarkEfficiencyFromRecord(value: unknown): RouterLiteBenchmarkEfficiency | undefined {
  const record = asRecord(value);
  const valueScore = asNumber(record.valueScore ?? record.value_score);
  if (valueScore === undefined) return undefined;
  return {
    taskCostScore: asNumber(record.taskCostScore ?? record.task_cost_score),
    taskSpeedScore: asNumber(record.taskSpeedScore ?? record.task_speed_score),
    valueScore,
    sources: asStringArray(record.sources),
  };
}

function modelsFromModelIntelSnapshot(snapshot: unknown): PartialModelIntel[] {
  const rawModels = asRecord(snapshot).models;
  if (!Array.isArray(rawModels)) return [];
  const models: PartialModelIntel[] = [];
  for (const rawModel of rawModels) {
    const record = asRecord(rawModel);
    const modelKey = asString(record.modelKey);
    if (!modelKey) continue;
    const identity = splitModelKey(modelKey, asString(record.provider));
    models.push({
      ...identity,
      provider: asString(record.provider) || identity.provider,
      model: asString(record.model) || identity.model,
      name: asString(record.name) || undefined,
      configured: false,
      available: triState(record.available),
      tags: asStringArray(record.tags),
      marketPrice: partialObject<RouterLitePrice>(record.marketPrice),
      capability: partialObject<RouterLiteCapability>(record.capability),
      health: partialObject<RouterLiteHealth>(record.health),
      plan: partialObject<RouterLitePlan>(record.plan),
      benchmarkEfficiency: benchmarkEfficiencyFromRecord(record.benchmarkEfficiency),
      scenarioAbility: partialObject<ScenarioAbilityLite>(record.scenarioAbility) as ScenarioAbilityLite | undefined,
      freshness: asString(record.freshness) || asString(asRecord(snapshot).generatedAt) || undefined,
      sources: unique([...asStringArray(record.sources), "packaged_model_intel"]),
    });
  }
  return models;
}

function modelSignalEntries(input: unknown): Map<string, JsonRecord> {
  const result = new Map<string, JsonRecord>();
  const root = asRecord(input);
  const rawModels = root.models ?? root.modelStatus ?? root.modelCosts ?? root.providers;

  if (Array.isArray(rawModels)) {
    for (const item of rawModels) {
      const record = asRecord(item);
      const key = asString(record.modelKey ?? record.key ?? record.id ?? record.model);
      if (key) result.set(key, record);
    }
    return result;
  }

  if (isRecord(rawModels)) {
    for (const [key, value] of Object.entries(rawModels)) {
      if (isRecord(value)) result.set(key, value);
    }
    return result;
  }

  for (const [key, value] of Object.entries(root)) {
    if (isRecord(value)) result.set(key, value);
  }

  return result;
}

function findModelSignal(map: Map<string, JsonRecord>, model: ModelIntelLite): JsonRecord {
  return asRecord(map.get(model.modelKey) ?? map.get(canonicalFactsKey(model.modelKey)) ?? map.get(model.model));
}

function healthFromUsageStatus(status: JsonRecord): Partial<RouterLiteHealth> | undefined {
  if (Object.keys(status).length === 0) return undefined;
  return {
    available: triState(status.available),
    cooldown: asBoolean(status.cooldown),
    quotaPressure: quotaPressure(status.quotaPressure ?? status.quota_pressure),
    p50FirstTokenMs: asNumber(status.p50FirstTokenMs ?? status.p50_first_token_ms ?? status.firstTokenP50Ms),
    p95FirstTokenMs: asNumber(status.p95FirstTokenMs ?? status.p95_first_token_ms ?? status.firstTokenP95Ms),
    p50OutputTokensPerSecond: asNumber(status.p50OutputTokensPerSecond ?? status.p50_output_tokens_per_second ?? status.outputTpsP50),
    p50LatencyMs: asNumber(status.p50LatencyMs ?? status.p50_latency_ms),
    p95LatencyMs: asNumber(status.p95LatencyMs ?? status.p95_latency_ms),
    recentFailureRate: asNumber(status.recentFailureRate ?? status.recent_failure_rate),
    toolCallFailureRate: asNumber(status.toolCallFailureRate ?? status.tool_call_failure_rate),
    timeoutRate: asNumber(status.timeoutRate ?? status.timeout_rate),
    sources: ["openclaw_usage_status"],
  };
}

function planFromUsage(status: JsonRecord, cost: JsonRecord): Partial<RouterLitePlan> | undefined {
  if (Object.keys(status).length === 0 && Object.keys(cost).length === 0) return undefined;
  const plan = asRecord(cost.plan ?? status.plan);
  return {
    type: planType(plan.type ?? cost.planType ?? cost.plan_type ?? status.planType ?? status.plan_type),
    quotaPressure: quotaPressure(
      plan.quotaPressure ?? plan.quota_pressure
        ?? cost.quotaPressure ?? cost.quota_pressure
        ?? status.quotaPressure ?? status.quota_pressure,
    ),
    effectiveCostBand: effectiveCostBand(
      plan.effectiveCostBand ?? plan.effective_cost_band
        ?? cost.effectiveCostBand ?? cost.effective_cost_band,
    ),
    resetAt: asString(plan.resetAt ?? plan.reset_at ?? cost.resetAt ?? cost.reset_at) || undefined,
    sources: [
      ...(Object.keys(status).length > 0 ? ["openclaw_usage_status"] : []),
      ...(Object.keys(cost).length > 0 ? ["openclaw_usage_cost"] : []),
    ],
  };
}

function addUsageSignals(models: ModelIntelLite[], usageStatus: unknown, usageCost: unknown): ModelIntelLite[] {
  const statusByModel = modelSignalEntries(usageStatus);
  const costByModel = modelSignalEntries(usageCost);
  return models.map((model) => {
    const status = findModelSignal(statusByModel, model);
    const cost = findModelSignal(costByModel, model);
    const usagePrice = priceFromCost(asRecord(cost.marketPrice ?? cost.apiPrice ?? cost.price), "openclaw_usage_cost");

    return {
      ...model,
      marketPrice: mergePrice(model.marketPrice, usagePrice),
      health: mergeHealth(model.health, healthFromUsageStatus(status)),
      plan: mergePlan(model.plan, planFromUsage(status, cost)),
    };
  });
}

function addHealthSnapshotSignals(models: ModelIntelLite[], healthSnapshot: unknown): ModelIntelLite[] {
  const healthByModel = modelSignalEntries(healthSnapshot);
  if (healthByModel.size === 0) return models;
  const normalized = new Map<string, JsonRecord>();
  for (const [key, value] of healthByModel) normalized.set(canonicalFactsKey(key), value);

  return models.map((model) => {
    const health = findRouterHealthSignal(normalized, model);
    return {
      ...model,
      health: mergeHealth(model.health, healthFromRouterHealthSnapshot(health)),
    };
  });
}

function findRouterHealthSignal(map: Map<string, JsonRecord>, model: ModelIntelLite): JsonRecord {
  for (const key of healthLookupKeys(model)) {
    const found = map.get(key.toLowerCase());
    if (found) return found;
  }
  return {};
}

function healthLookupKeys(model: ModelIntelLite): string[] {
  const keys = [model.modelKey, model.model];
  const slash = model.modelKey.indexOf("/");
  if (slash > 0) {
    const provider = model.modelKey.slice(0, slash).toLowerCase();
    const id = model.modelKey.slice(slash + 1);
    if (provider === "zhipu") keys.push(`zai/${id}`);
    if (provider === "zai") keys.push(`zhipu/${id}`);
  }
  return unique(keys);
}

function healthFromRouterHealthSnapshot(status: JsonRecord): Partial<RouterLiteHealth> | undefined {
  if (Object.keys(status).length === 0) return undefined;
  return {
    cooldown: asBoolean(status.cooldown),
    cooldownUntil: asNumber(status.cooldownUntil ?? status.cooldown_until),
    cooldownReason: asString(status.cooldownReason ?? status.cooldown_reason) || undefined,
    p50LatencyMs: asNumber(status.p50LatencyMs ?? status.p50_latency_ms),
    p95LatencyMs: asNumber(status.p95LatencyMs ?? status.p95_latency_ms),
    baselineP95LatencyMs: asNumber(status.baselineP95LatencyMs ?? status.baseline_p95_latency_ms),
    baselineP95WindowCount: asNumber(status.baselineP95WindowCount ?? status.baseline_p95_window_count),
    recentFailureRate: asNumber(status.recentFailureRate ?? status.recent_failure_rate),
    toolCallFailureRate: asNumber(status.toolCallFailureRate ?? status.tool_call_failure_rate),
    timeoutRate: asNumber(status.timeoutRate ?? status.timeout_rate),
    lastSuccessfulCallAt: timestampToIso(status.lastSuccessfulCallAt ?? status.last_successful_call_at),
    lastFailedCallAt: timestampToIso(status.lastFailedCallAt ?? status.last_failed_call_at),
    lastErrorCodes: parseLastErrorCodes(status.lastErrorCodes ?? status.last_error_codes),
    sources: ["router_health_snapshot"],
  };
}

function timestampToIso(value: unknown): string | undefined {
  const millis = asNumber(value);
  if (millis !== undefined) return new Date(millis).toISOString();
  const text = asString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function parseLastErrorCodes(value: unknown): Array<{ code: string; count: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.flatMap((item) => {
    const record = asRecord(item);
    const code = asString(record.code);
    const count = asNumber(record.count);
    return code && count !== undefined ? [{ code, count }] : [];
  });
  return parsed.length > 0 ? parsed : undefined;
}

function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findPriceBaseline(models: ModelIntelLite[], baselineModel = "glm-5.1"): ModelIntelLite | undefined {
  const normalizedBaseline = normalizeModelName(baselineModel);
  return models.find((model) => normalizeModelName(model.model) === normalizedBaseline)
    ?? models.find((model) => normalizeModelName(model.modelKey).endsWith(normalizedBaseline));
}

function addPriceRatios(models: ModelIntelLite[], baselineModel = "glm-5.1"): ModelIntelLite[] {
  const baseline = findPriceBaseline(models, baselineModel);
  const baselinePrice = baseline?.marketPrice.blendedUsdPerMTok;
  if (!baseline || baselinePrice === undefined || baselinePrice <= 0) return models;
  return models.map((model) => {
    const blended = model.marketPrice.blendedUsdPerMTok ?? blendedPrice(
      model.marketPrice.inputUsdPerMTok,
      model.marketPrice.outputUsdPerMTok,
    );
    if (blended === undefined) return model;
    return {
      ...model,
      marketPrice: {
        ...model.marketPrice,
        blendedUsdPerMTok: blended,
        ratioBaselineModel: baseline.modelKey,
        ratioToBaseline: blended / baselinePrice,
      },
    };
  });
}

const TIER_PRIOR_SCORE: Record<RouterLiteCodingTier, number> = {
  frontier: 92,
  strong: 78,
  standard: 64,
  mini: 50,
  unknown: 35,
};

const TIER_LEVEL: Record<RouterLiteCodingTier, number> = {
  frontier: 4,
  strong: 3,
  standard: 2,
  mini: 1,
  unknown: 0,
};

function tierFromCapabilityScore(score: number): RouterLiteCodingTier {
  if (score >= 90) return "frontier";
  if (score >= 75) return "strong";
  if (score >= 60) return "standard";
  if (score >= 45) return "mini";
  return "unknown";
}

function maxTier(left: RouterLiteCodingTier, right: RouterLiteCodingTier): RouterLiteCodingTier {
  return TIER_LEVEL[right] > TIER_LEVEL[left] ? right : left;
}

function deriveCapabilityScore(capability: RouterLiteCapability): RouterLiteFusedScore {
  const scenarioScores = [
    { scenario: "coding_worker", weight: 0.55, score: capability.scoreByScenario?.coding_worker },
    { scenario: "agentic", weight: 0.25, score: capability.scoreByScenario?.agentic },
    { scenario: "research", weight: 0.10, score: capability.scoreByScenario?.research },
  ].filter((entry) => entry.score && entry.score.confidence !== "unknown" && Number.isFinite(entry.score.score));

  if (scenarioScores.length > 0) {
    const totalWeight = scenarioScores.reduce((sum, entry) => sum + entry.weight, 0);
    const score = scenarioScores.reduce((sum, entry) => sum + entry.score!.score * (entry.weight / totalWeight), 0);
    const confidences = scenarioScores.map((entry) => entry.score!.confidence);
    return {
      score: Math.round(score * 100) / 100,
      confidence: maxConfidence(confidences, "low"),
      contributions: scenarioScores.flatMap((entry) => entry.score!.contributions),
      reasonCodes: [
        ...scenarioScores.map((entry) => `score_source:${entry.scenario}`),
        ...unique(scenarioScores.flatMap((entry) => entry.score!.reasonCodes)),
      ],
    };
  }

  const tier = capability.codingTier ?? "unknown";
  return {
    score: TIER_PRIOR_SCORE[tier] ?? TIER_PRIOR_SCORE.unknown,
    confidence: "low",
    contributions: [],
    reasonCodes: [`score_source:tier_prior`, `tier_prior:${tier}`],
  };
}

function calibrateCapability(capability: RouterLiteCapability, modelKey = ""): RouterLiteCapability {
  const capabilityScore = capability.capabilityScore ?? deriveCapabilityScore(capability);
  const baselineTier = maxTier(capability.codingTier, inferCodingTier(modelKey));
  const scoreTier = tierFromCapabilityScore(capabilityScore.score);
  const isPromotion = TIER_LEVEL[scoreTier] > TIER_LEVEL[baselineTier];
  const effectiveTier = isPromotion && scoreAllowsTierPromotion(capabilityScore, capability, baselineTier, scoreTier)
    ? scoreTier
    : baselineTier;
  return {
    ...capability,
    codingTier: effectiveTier,
    capabilityScore,
  };
}

function tierDistance(from: RouterLiteCodingTier, to: RouterLiteCodingTier): number {
  return Math.abs((TIER_LEVEL[to] ?? 0) - (TIER_LEVEL[from] ?? 0));
}

function scoreAllowsTierPromotion(
  score: RouterLiteFusedScore,
  capability: RouterLiteCapability,
  fromTier: RouterLiteCodingTier,
  toTier: RouterLiteCodingTier,
): boolean {
  if (toTier === fromTier) return true;
  const distance = tierDistance(fromTier, toTier);
  if (TIER_LEVEL[toTier] <= TIER_LEVEL[fromTier]) return false;

  if (score.confidence === "high") return true;

  if (capability.evidence.some((item) => item === "probed" || item === "observed" || item === "operator_override")) {
    return true;
  }

  if (score.confidence === "low" || score.confidence === "unknown") {
    return false;
  }

  const contributionSources = new Set(score.contributions.map((c) => c.source));
  const isMultiSource = contributionSources.size >= 2;

  return isMultiSource || distance <= 1;
}

export function buildModelIntelFactsPlane(input: BuildModelIntelFactsPlaneInput): ModelIntelFactsPlane {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const scenarioData = parseScenarioData(input.scenarioData);
  const partials: PartialModelIntel[] = [
    ...(Array.isArray(asRecord(input.openClawModelsList).models)
      ? (asRecord(input.openClawModelsList).models as unknown[]).flatMap((item) => {
          const model = modelFromOpenClawList(item);
          return model ? [model] : [];
        })
      : []),
    ...modelsFromOpenClawConfig(input.openClawConfig),
    ...modelsFromLegacyCatalog(input.legacyCatalog),
    ...modelsFromModelIntelSnapshot(input.packagedSnapshot),
  ];
  partials.push(...mirrorOpenAiCandidatesForCompatibleProviders(partials));

  const merged = new Map<string, ModelIntelLite>();
  for (const partial of partials) {
    const enrichedPartial = { ...partial, freshness: partial.freshness ?? generatedAt };
    const lowerKey = canonicalFactsKey(partial.modelKey);
    const existing = merged.get(lowerKey);
    const existingIsConfigured = existing && (existing.configured || existing.tags.includes("configured"));
    const incomingIsConfigured = partial.configured === true || (partial.tags ?? []).includes("configured");
    const modelKeyToUse = existingIsConfigured ? existing.modelKey : incomingIsConfigured ? partial.modelKey : (existing?.modelKey ?? partial.modelKey);
    merged.set(lowerKey, mergeModel(existing, {
      ...enrichedPartial,
      modelKey: modelKeyToUse,
      scenarioAbility: partial.scenarioAbility ?? (scenarioData.size > 0 ? scenarioData.get(lowerKey) : undefined) ?? inferScenarioAbility(enrichedPartial, generatedAt),
    }));
  }
  const normalizedModels = Array.from(merged.values()).map((model) => ({
    ...model,
    proposalOnly: !model.configured,
    marketPrice: model.marketPrice.sources.length > 0
      ? model.marketPrice
      : { ...model.marketPrice, missingCostReason: model.marketPrice.missingCostReason ?? "cost_not_observed" },
    capability: {
      ...model.capability,
      confidence: model.capability.evidence.includes("declared") ? maxConfidence([model.capability.confidence, "medium"], "low") : model.capability.confidence,
    },
    scenarioAbility: model.scenarioAbility ?? (scenarioData.size > 0 ? scenarioData.get(canonicalFactsKey(model.modelKey)) : undefined) ?? inferScenarioAbility(model, model.freshness ?? generatedAt),
    freshness: mostRecentTimestamp(model.freshness, generatedAt) ?? generatedAt,
  })).map((model) => ({
    ...model,
    capability: calibrateCapability(model.capability, model.modelKey),
  }));
  const models = addPriceRatios(addHealthSnapshotSignals(
    addUsageSignals(normalizedModels, input.usageStatus, input.usageCost),
    input.healthSnapshot,
  )).sort((a, b) => a.modelKey.localeCompare(b.modelKey));

  return {
    generatedAt,
    nativeFallbackOrder: parseNativeFallbackOrder(input.nativeFallbackOrder),
    sourceStatus: [
      sourceStatus("openclaw_models_list", input.openClawModelsList),
      sourceStatus("openclaw_config", input.openClawConfig),
      sourceStatus("legacy_model_catalog", input.legacyCatalog),
      sourceStatus("packaged_model_intel", input.packagedSnapshot),
      sourceStatus("openclaw_usage_status", input.usageStatus),
      sourceStatus("openclaw_usage_cost", input.usageCost),
      sourceStatus("router_health_snapshot", input.healthSnapshot),
      sourceStatus("openclaw_native_fallbacks", input.nativeFallbackOrder),
      sourceStatus("scenario_data", input.scenarioData),
    ],
    models,
  };
}

function parseNativeFallbackOrder(value: unknown): string[] | undefined {
  const rawFallbacks = isRecord(value) ? asRecord(value).fallbacks : value;
  const fallbacks = asStringArray(rawFallbacks);
  return fallbacks.length > 0 ? fallbacks : undefined;
}
