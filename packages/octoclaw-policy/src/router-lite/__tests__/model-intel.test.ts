import { describe, expect, it } from "vitest";
import { buildModelIntelSnapshot } from "../model-intel.js";

function sampleSnapshot() {
  return buildModelIntelSnapshot({
    generatedAt: "2026-05-10T00:00:00.000Z",
    openClawModelsList: {
      models: [
        {
          key: "cliproxyapi/gpt-5.5",
          name: "GPT 5.5",
          input: ["text", "image"],
          contextWindow: 1000000,
          available: true,
          tags: ["configured"],
          missing: false,
        },
      ],
    },
    openClawConfig: {
      models: {
        providers: {
          cliproxyapi: {
            models: [
              {
                id: "gpt-5.5",
                name: "GPT 5.5",
                input: ["text"],
                contextWindow: 900000,
                reasoning: true,
                cost: {
                  input: 2,
                  output: 10,
                  cacheRead: 0.2,
                  cacheWrite: 1,
                },
              },
            ],
          },
        },
      },
    },
    legacyCatalog: {
      models: [
        {
          id: "gpt-5.5-mini",
          provider: "cliproxyapi",
          short_name: "GPT 5.5 Mini",
          available: true,
          configured: false,
          size_class: "mini",
          pricing: { input: 0.1, output: 0.4 },
          limits: { context_length: 128000 },
          modalities: { input: ["text"] },
          capability_hints: { tool_call: "yes", reasoning: "no" },
        },
        {
          id: "daily-new-mini",
          provider: "newprovider",
          short_name: "Daily New Mini",
          available: true,
          configured: false,
          size_class: "mini",
          pricing: {},
          limits: {},
          modalities: { input: ["text"] },
          capability_hints: {},
        },
      ],
    },
  });
}

describe("router-lite model intel", () => {
  it("merges configured OpenClaw model list and config signals", () => {
    const snapshot = sampleSnapshot();
    const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

    expect(model).toBeDefined();
    expect(model?.configured).toBe(true);
    expect(model?.proposalOnly).toBe(false);
    expect(model?.available).toBe("yes");
    expect(model?.marketPrice).toMatchObject({
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheReadUsdPerMTok: 0.2,
      cacheWriteUsdPerMTok: 1,
      confidence: "high",
    });
    expect(model?.marketPrice.sources).toContain("openclaw_config");
    expect(model?.capability.evidence).toContain("declared");
    expect(model?.capability.sources).toEqual(expect.arrayContaining(["openclaw_models_list", "openclaw_config"]));
  });

  it("keeps unconfigured catalog models proposal-only", () => {
    const snapshot = sampleSnapshot();
    const candidate = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5-mini");

    expect(candidate).toBeDefined();
    expect(candidate?.configured).toBe(false);
    expect(candidate?.proposalOnly).toBe(true);
    expect(candidate?.marketPrice.confidence).toBe("medium");
    expect(candidate?.capability.codingTier).toBe("mini");
  });

  it("does not treat unknown quota as free", () => {
    const snapshot = sampleSnapshot();
    const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

    expect(model?.plan.quotaPressure).toBe("unknown");
    expect(model?.plan.effectiveCostBand).toBe("unknown");
  });

  it("marks heuristic-only models with low-confidence evidence", () => {
    const snapshot = sampleSnapshot();
    const model = snapshot.models.find((entry) => entry.modelKey === "newprovider/daily-new-mini");

    expect(model).toBeDefined();
    expect(model?.capability.confidence).toBe("low");
    expect(model?.capability.evidence).toEqual(["heuristic"]);
    expect(model?.marketPrice.missingCostReason).toBe("legacy_catalog_missing_price");
  });
});
