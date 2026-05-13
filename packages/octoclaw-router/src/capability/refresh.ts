import type { ModelIntelSnapshot } from "../decision/contracts.js";
import { createHeuristicModel, mergePriceData, modelFromSourceRecord } from "./merge.js";
import type { CapabilitySource } from "./types.js";

export interface RefreshCapabilityOptions {
  incremental?: boolean;
  sources: CapabilitySource[];
  writeSnapshot?: (snapshot: ModelIntelSnapshot) => Promise<void>;
  now?: () => number;
}

export async function refreshCapability(options: RefreshCapabilityOptions): Promise<ModelIntelSnapshot> {
  const byModel = new Map<string, Array<{ source: string; price?: number }>>();
  const sourceStatus: ModelIntelSnapshot["sourceStatus"] = [];

  for (const source of options.sources) {
    try {
      const records = await source.fetch();
      sourceStatus.push({ source: source.name, status: "ok" });
      for (const record of records) {
        const current = byModel.get(record.modelKey) ?? [];
        current.push({ source: source.name, price: record.price });
        byModel.set(record.modelKey, current);
      }
    } catch (error) {
      sourceStatus.push({ source: source.name, status: "error", detail: String(error) });
    }
  }

  const generatedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const models = Array.from(byModel.entries()).map(([modelKey, records]) => {
    const priceSources = records
      .filter((record): record is { source: string; price: number } => typeof record.price === "number");
    const mergedPrice = mergePriceData(modelKey, priceSources);
    const model = modelFromSourceRecord({
      modelKey,
      price: Number.isNaN(mergedPrice.price) ? undefined : mergedPrice.price,
      source: records[0]?.source,
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
