import type { ModelIntelSnapshot } from "../decision/contracts.js";
import { createHeuristicModel, mergePriceData, modelFromSourceRecord } from "./merge.js";
import type { CapabilitySource, CapabilitySourceRecord } from "./types.js";

export interface RefreshCapabilityOptions {
  incremental?: boolean;
  sources: CapabilitySource[];
  writeSnapshot?: (snapshot: ModelIntelSnapshot) => Promise<void>;
  now?: () => number;
}

export async function refreshCapability(options: RefreshCapabilityOptions): Promise<ModelIntelSnapshot> {
  const byModel = new Map<string, CapabilitySourceRecord[]>();
  const sourceStatus: ModelIntelSnapshot["sourceStatus"] = [];

  for (const source of options.sources) {
    try {
      const records = await source.fetch();
      sourceStatus.push({ source: source.name, status: "ok" });
      for (const record of records) {
        const current = byModel.get(record.modelKey) ?? [];
        current.push({ ...record, source: record.source ?? source.name });
        byModel.set(record.modelKey, current);
      }
    } catch (error) {
      sourceStatus.push({ source: source.name, status: "error", detail: String(error) });
    }
  }

  const generatedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const models = Array.from(byModel.entries()).map(([modelKey, records]) => {
    const priceSources = records
      .filter((record): record is CapabilitySourceRecord & { source: string; price: number } => typeof record.price === "number" && typeof record.source === "string");
    const mergedPrice = mergePriceData(modelKey, priceSources);
    const preferred = records.find((record) => record.tier && record.tier !== "unknown") ?? records[0]!;
    const first = <T>(selector: (record: CapabilitySourceRecord) => T | undefined): T | undefined => {
      for (const record of records) {
        const value = selector(record);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    const model = modelFromSourceRecord({
      ...preferred,
      modelKey,
      price: Number.isNaN(mergedPrice.price) ? undefined : mergedPrice.price,
      inputUsdPerMTok: first((record) => record.inputUsdPerMTok),
      outputUsdPerMTok: first((record) => record.outputUsdPerMTok),
      cacheReadUsdPerMTok: first((record) => record.cacheReadUsdPerMTok),
      cacheWriteUsdPerMTok: first((record) => record.cacheWriteUsdPerMTok),
      contextWindow: first((record) => record.contextWindow),
      input: first((record) => record.input),
      toolUse: first((record) => record.toolUse),
      structuredOutput: first((record) => record.structuredOutput),
      reasoning: first((record) => record.reasoning),
      promptCache: first((record) => record.promptCache),
      source: preferred.source,
      capabilityScore: first((record) => record.capabilityScore),
      scoreByScenario: first((record) => record.scoreByScenario),
      benchmarkEfficiency: first((record) => record.benchmarkEfficiency),
    });
    model.marketPrice.conflict = mergedPrice.conflict;
    model.marketPrice.sources = mergedPrice.sources;
    return model;
  });

  const snapshot: ModelIntelSnapshot = {
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: `snapshot-${generatedAt}`,
    generatedAt,
    sourceStatus,
    models,
  };

  await options.writeSnapshot?.(snapshot);
  return snapshot;
}

export async function handleOpenClawConfigChange(input: {
  refreshCapability: (options: { incremental: true }) => Promise<unknown>;
}): Promise<void> {
  await input.refreshCapability({ incremental: true });
}

export async function ensureCapabilityForConfiguredModels(
  snapshot: ModelIntelSnapshot,
  configuredModels: string[],
  options: { lookup: (modelKey: string) => Promise<ReturnType<typeof createHeuristicModel> | null> },
): Promise<ModelIntelSnapshot> {
  const existing = new Set(snapshot.models.map((model) => model.modelKey));
  const additions = [];

  for (const modelKey of configuredModels) {
    if (existing.has(modelKey)) continue;
    additions.push((await options.lookup(modelKey)) ?? createHeuristicModel(modelKey));
  }

  return { ...snapshot, models: [...snapshot.models, ...additions] };
}
