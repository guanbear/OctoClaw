import { describe, expect, it, vi } from "vitest";

import {
  createLiteLLMCapabilitySource,
  createModelsDevCapabilitySource,
  createOpenRouterCapabilitySource,
  computeFreshness,
  ensureCapabilityForConfiguredModels,
  handleOpenClawConfigChange,
  loadPackagedLeaderboardSnapshot,
  loadPackagedModelIntelSnapshot,
  loadSnapshotFromText,
  mergeCapabilitySnapshot,
  mergePriceData,
  refreshCapability,
  type CapabilityOverrideConfig,
  type CapabilitySource,
} from "../../capability/index.js";

describe("capability snapshot RT-C-001..007", () => {
  it("RT-C-001 loads packaged snapshot on cold start", () => {
    const leaderboard = loadPackagedLeaderboardSnapshot();
    const snapshot = loadPackagedModelIntelSnapshot();

    expect(Object.keys(leaderboard.models).length).toBeGreaterThan(0);
    expect(snapshot.models.length).toBeGreaterThan(0);
    expect(snapshot.models.every((model) => model.configured === true)).toBe(true);
  });

  it("RT-C-002 fails open to empty capability data on corrupt snapshot", () => {
    const warn = vi.fn();
    const snapshot = loadSnapshotFromText("{not json", { warn });

    expect(snapshot.models).toEqual([]);
    expect(snapshot.snapshotId).toBe("empty");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[router-lite] snapshot load failed:"));
  });

  it("RT-C-003 refresh probes sources in order and flags price conflicts", async () => {
    const calls: string[] = [];
    const writes: unknown[] = [];
    const sources: CapabilitySource[] = [
      { name: "leaderboard", fetch: async () => (calls.push("leaderboard"), [{ modelKey: "openai/gpt-5.5", price: 10 }]) },
      { name: "openrouter", fetch: async () => (calls.push("openrouter"), [{ modelKey: "openai/gpt-5.5", price: 14 }]) },
      { name: "models.dev", fetch: async () => (calls.push("models.dev"), []) },
      { name: "openclaw", fetch: async () => (calls.push("openclaw"), []) },
    ];

    const snapshot = await refreshCapability({
      sources,
      writeSnapshot: async (value) => {
        writes.push(value);
      },
      now: () => new Date("2026-05-13T00:00:00.000Z").getTime(),
    });

    expect(calls).toEqual(["leaderboard", "openrouter", "models.dev", "openclaw"]);
    expect(snapshot.snapshotId).toBe("snapshot-2026-05-13T00:00:00.000Z");
    expect(snapshot.models[0]?.marketPrice.conflict).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("RT-C-004 handles OpenClaw config changes as incremental refresh", async () => {
    const refresh = vi.fn(async () => undefined);

    await handleOpenClawConfigChange({ refreshCapability: refresh });

    expect(refresh).toHaveBeenCalledWith({ incremental: true });
  });

  it("RT-C-005 looks up unknown configured models and falls back to low-confidence heuristic", async () => {
    const snapshot = loadSnapshotFromText(JSON.stringify({
      schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
      snapshotId: "test",
      generatedAt: "2026-05-13T00:00:00.000Z",
      sourceStatus: [],
      models: [],
    }));

    const updated = await ensureCapabilityForConfiguredModels(snapshot, ["deepseek/deepseek-v4"], {
      lookup: async () => null,
    });

    expect(updated.models).toHaveLength(1);
    expect(updated.models[0]).toMatchObject({
      modelKey: "deepseek/deepseek-v4",
      configured: true,
      capability: { confidence: "low", sources: ["heuristic"] },
    });
  });

  it("RT-C-006 tracks stale and very stale capability data", () => {
    const now = new Date("2026-05-13T00:00:00.000Z").getTime();

    expect(computeFreshness("2026-05-01T00:00:00.000Z", now)).toBe("fresh");
    expect(computeFreshness("2026-03-01T00:00:00.000Z", now)).toBe("stale");
    expect(computeFreshness("2026-01-01T00:00:00.000Z", now)).toBe("very_stale");
  });

  it("RT-C-007 keeps user score overrides separate across refresh", () => {
    const overrides: CapabilityOverrideConfig = {
      scoreOverrides: {
        "openai/gpt-5.5": { complex: 75 },
      },
    };
    const refreshed = loadPackagedModelIntelSnapshot();
    const merged = mergeCapabilitySnapshot(refreshed, overrides);

    expect(merged.overrides.scoreOverrides["openai/gpt-5.5"]?.complex).toBe(75);
    expect(merged.snapshot.models.find((model) => model.modelKey === "openai/gpt-5.5")?.capability.codingTier).toBeDefined();
  });

  it("flags price conflict when source prices differ by more than 20 percent", () => {
    expect(mergePriceData("openai/gpt-5.5", [
      { source: "openrouter", price: 10 },
      { source: "models.dev", price: 13 },
    ])).toMatchObject({ price: 13, conflict: true, sources: ["openrouter", "models.dev"] });
  });

  it("parses OpenRouter model metadata into capability records", async () => {
    const source = createOpenRouterCapabilitySource({
      fetchJson: async () => ({
        data: [
          {
            id: "openai/gpt-5-mini",
            name: "OpenAI: GPT-5 Mini",
            context_length: 128000,
            architecture: { input_modalities: ["text", "image"] },
            pricing: {
              prompt: "0.000001",
              completion: "0.000004",
              input_cache_read: "0.0000001",
              input_cache_write: "0.0000004",
            },
            supported_parameters: ["tools", "response_format", "reasoning"],
          },
        ],
      }),
    });

    await expect(source.fetch()).resolves.toEqual([
      expect.objectContaining({
        modelKey: "openai/gpt-5-mini",
        price: 1.75,
        inputUsdPerMTok: 1,
        outputUsdPerMTok: 4,
        contextWindow: 128000,
        input: ["text", "image"],
        toolUse: "yes",
        structuredOutput: "yes",
        reasoning: "yes",
        source: "openrouter",
      }),
    ]);
  });

  it("normalizes OpenRouter Z.ai GLM ids to Zhipu provider keys", async () => {
    const source = createOpenRouterCapabilitySource({
      fetchJson: async () => ({
        data: [
          {
            id: "z-ai/glm-4.7",
            pricing: { prompt: "0.000002", completion: "0.000006" },
          },
        ],
      }),
    });

    await expect(source.fetch()).resolves.toEqual([
      expect.objectContaining({
        modelKey: "zhipu/glm-4.7",
        tier: "strong",
        price: 3,
      }),
    ]);
  });

  it("parses models.dev provider metadata into capability records", async () => {
    const source = createModelsDevCapabilitySource({
      fetchJson: async () => ({
        openai: {
          models: {
            "gpt-5-mini": {
              id: "gpt-5-mini",
              name: "GPT-5 Mini",
              family: "gpt",
              reasoning: true,
              tool_call: true,
              modalities: { input: ["text"] },
              limit: { context: 200000 },
              cost: { input: 0.25, output: 2 },
              last_updated: "2026-05-01",
            },
          },
        },
      }),
    });

    await expect(source.fetch()).resolves.toEqual([
      expect.objectContaining({
        modelKey: "openai/gpt-5-mini",
        price: 0.6875,
        inputUsdPerMTok: 0.25,
        outputUsdPerMTok: 2,
        contextWindow: 200000,
        toolUse: "yes",
        reasoning: "yes",
        source: "models.dev",
        lastVerifiedAt: "2026-05-01",
      }),
    ]);
  });

  it("parses LiteLLM price registry metadata into capability records", async () => {
    const source = createLiteLLMCapabilitySource({
      fetchJson: async () => ({
        sample_spec: {},
        "gpt-5-mini": {
          litellm_provider: "openai",
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000004,
          cache_read_input_token_cost: 0.0000001,
          max_input_tokens: 128000,
          supports_function_calling: true,
          supports_response_schema: true,
        },
      }),
    });

    await expect(source.fetch()).resolves.toEqual([
      expect.objectContaining({
        modelKey: "openai/gpt-5-mini",
        price: 1.75,
        inputUsdPerMTok: 1,
        outputUsdPerMTok: 4,
        cacheReadUsdPerMTok: 0.1,
        contextWindow: 128000,
        toolUse: "yes",
        structuredOutput: "yes",
        source: "litellm",
      }),
    ]);
  });

  it("normalizes LiteLLM Z.ai GLM ids to Zhipu provider keys", async () => {
    const source = createLiteLLMCapabilitySource({
      fetchJson: async () => ({
        "glm-4.7": {
          litellm_provider: "z-ai",
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.000006,
        },
      }),
    });

    await expect(source.fetch()).resolves.toEqual([
      expect.objectContaining({
        modelKey: "zhipu/glm-4.7",
        tier: "strong",
        price: 3,
      }),
    ]);
  });
});
