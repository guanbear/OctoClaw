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
            id: "glm-5.1",
            provider: "z-ai",
            configured: false,
            size_class: "strong",
            pricing: { input: 1, output: 3 },
            modalities: { input: ["text"] },
            capability_hints: { tool_call: "yes", reasoning: "yes" },
          },
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
      blendedUsdPerMTok: 4,
      ratioBaselineModel: "z-ai/glm-5.1",
      ratioToBaseline: 2.6666666666666665,
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

  it("merges structured usage status into health and quota signals", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      },
      usageStatus: {
        models: {
          "cliproxyapi/gpt-5.5": {
            available: true,
            cooldown: true,
            quotaPressure: "high",
            p50FirstTokenMs: 321,
            recentFailureRate: 0.18,
            toolCallFailureRate: 0.07,
            timeoutRate: 0.03,
          },
        },
      },
    });
    const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

    expect(model?.health).toMatchObject({
      available: "yes",
      cooldown: true,
      quotaPressure: "high",
      p50FirstTokenMs: 321,
      recentFailureRate: 0.18,
      toolCallFailureRate: 0.07,
      timeoutRate: 0.03,
    });
    expect(model?.health.sources).toContain("openclaw_usage_status");
    expect(model?.plan.quotaPressure).toBe("high");
    expect(model?.plan.sources).toContain("openclaw_usage_status");
  });

  it("merges structured usage cost into plan without treating all-zero cost as API price", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawModelsList: {
        models: [{ key: "cliproxyapi/gpt-5.5", tags: ["configured"] }],
      },
      usageCost: {
        models: {
          "cliproxyapi/gpt-5.5": {
            plan: {
              type: "subscription",
              quotaPressure: "low",
              effectiveCostBand: "free_or_sunk",
              resetAt: "2026-05-15T00:00:00.000Z",
            },
            marketPrice: { input: 0, output: 0 },
          },
        },
      },
    });
    const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

    expect(model?.plan).toMatchObject({
      type: "subscription",
      quotaPressure: "low",
      effectiveCostBand: "free_or_sunk",
      resetAt: "2026-05-15T00:00:00.000Z",
    });
    expect(model?.plan.sources).toContain("openclaw_usage_cost");
    expect(model?.marketPrice).toMatchObject({
      confidence: "unknown",
    });
    expect(model?.marketPrice.sources).not.toContain("openclaw_usage_cost");
    expect(model?.marketPrice.missingCostReason).toBe("cost_not_observed");
  });

  it("marks heuristic-only models with low-confidence evidence", () => {
    const snapshot = sampleSnapshot();
    const model = snapshot.models.find((entry) => entry.modelKey === "newprovider/daily-new-mini");

    expect(model).toBeDefined();
    expect(model?.capability.confidence).toBe("low");
    expect(model?.capability.evidence).toEqual(["heuristic"]);
    expect(model?.marketPrice.missingCostReason).toBe("legacy_catalog_missing_price");
  });

  it("populates scenarioAbility when scenario data provided", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawModelsList: {
        models: [{ key: "cliproxyapi/gpt-5.5", tags: ["configured"] }],
      },
      scenarioData: {
        "cliproxyapi/gpt-5.5": {
          codingWorker: {
            score: 0.92,
            tier: "S",
            confidence: "high",
            sources: [{ source: "aider", score: 0.92, fetchedAt: "2026-05-09T00:00:00.000Z" }],
          },
        },
      },
    });
    const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

    expect(model?.scenarioAbility?.codingWorker.score).toBe(0.92);
  });

  it("populates freshness on all models", () => {
    const generatedAt = "2026-05-10T12:34:56.000Z";
    const snapshot = buildModelIntelSnapshot({
      generatedAt,
      openClawModelsList: {
        models: [
          { key: "cliproxyapi/gpt-5.5", tags: ["configured"] },
          { key: "z-ai/glm-5.1", tags: [] },
        ],
      },
    });

    expect(snapshot.models.length).toBeGreaterThan(0);
    expect(snapshot.models.every((model) => model.freshness === generatedAt)).toBe(true);
  });

  it("detects price conflicts between sources", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              models: [{ id: "gpt-5.5", cost: { input: 2, output: 10 } }],
            },
          },
        },
      },
      legacyCatalog: {
        models: [
          {
            id: "gpt-5.5",
            provider: "cliproxyapi",
            pricing: { input: 5, output: 10 },
            modalities: { input: ["text"] },
            capability_hints: {},
          },
        ],
      },
    });
    const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

    expect(model?.marketPrice.conflict).toBe(true);
    expect(model?.marketPrice.sources).toEqual(expect.arrayContaining(["openclaw_config", "legacy_model_catalog"]));
  });

  it("scenarioAbility treats OpenClaw declared models as operator-backed evidence when no scenario data exists", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawModelsList: {
        models: [{ key: "cliproxyapi/gpt-5.5", tags: ["configured"] }],
      },
    });
    const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

    for (const score of Object.values(model?.scenarioAbility ?? {})) {
      expect(score).toMatchObject({
        tier: "S",
        confidence: "high",
        sources: [expect.objectContaining({ source: "operator_override" })],
      });
    }
  });

  it("merges scenario ability from multiple sources", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawModelsList: {
        models: [{ key: "cliproxyapi/gpt-5.5", tags: ["configured"] }],
      },
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      },
      scenarioData: {
        "cliproxyapi/gpt-5.5": {
          codingWorker: {
            score: 0.88,
            tier: "A",
            confidence: "high",
            sources: [
              { source: "local_replay", score: 0.72, fetchedAt: "2026-05-08T00:00:00.000Z" },
              { source: "operator_override", score: 0.88, fetchedAt: "2026-05-09T00:00:00.000Z" },
            ],
          },
        },
      },
    });
    const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

    expect(model?.scenarioAbility?.codingWorker).toMatchObject({ score: 0.88, tier: "A", confidence: "high" });
    expect(model?.scenarioAbility?.codingWorker.sources.map((source) => source.source)).toEqual(["local_replay", "operator_override"]);
  });

  it("populates freshness on all models", () => {
    const snapshot = sampleSnapshot();
    for (const model of snapshot.models) {
      expect(model.freshness).toBe("2026-05-10T00:00:00.000Z");
    }
  });

  it("populates scenarioAbility from scenarioData input", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              models: [
                { id: "gpt-5.5", cost: { input: 2, output: 10 } },
              ],
            },
          },
        },
      },
      scenarioData: {
        "cliproxyapi/gpt-5.5": {
          codingWorker: {
            score: 89,
            tier: "A",
            confidence: "medium",
            sources: [{ source: "pinchbench", score: 89, fetchedAt: "2026-05-10T00:00:00.000Z" }],
          },
          agenticToolTask: { tier: "unknown", confidence: "unknown", sources: [] },
          researchLookup: { tier: "unknown", confidence: "unknown", sources: [] },
          dataLogAnalysis: { tier: "unknown", confidence: "unknown", sources: [] },
          mainReasoning: { tier: "unknown", confidence: "unknown", sources: [] },
          defaultDelegate: { tier: "unknown", confidence: "unknown", sources: [] },
        },
      },
    });
    const model = snapshot.models.find((m) => m.modelKey === "cliproxyapi/gpt-5.5");
    expect(model?.scenarioAbility).toBeDefined();
    expect(model?.scenarioAbility?.codingWorker.score).toBe(89);
    expect(model?.scenarioAbility?.codingWorker.tier).toBe("A");
  });

  it("infers scenarioAbility when no scenarioData", () => {
    const snapshot = sampleSnapshot();
    const model = snapshot.models.find((m) => m.modelKey === "cliproxyapi/gpt-5.5");
    expect(model?.scenarioAbility).toBeDefined();
    expect(model?.scenarioAbility?.codingWorker.tier).toBe("S");
    expect(model?.scenarioAbility?.codingWorker.confidence).toBe("high");
    expect(model?.scenarioAbility?.codingWorker.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "operator_override" }),
    ]));
  });

  it("detects price conflicts between sources", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              models: [
                { id: "gpt-5.5", cost: { input: 2, output: 10 } },
              ],
            },
          },
        },
      },
      legacyCatalog: {
        models: [
          {
            id: "gpt-5.5",
            provider: "cliproxyapi",
            pricing: { input: 10, output: 50 },
            modalities: { input: ["text"] },
            capability_hints: {},
          },
        ],
      },
    });
    const model = snapshot.models.find((m) => m.modelKey === "cliproxyapi/gpt-5.5");
    expect(model?.marketPrice.conflict).toBe(true);
    expect(model?.marketPrice.sources).toContain("openclaw_config");
    expect(model?.marketPrice.sources).toContain("legacy_model_catalog");
  });

  describe("conflict recording", () => {
    it("records price conflict when sources disagree by >20%", () => {
      const snapshot = buildModelIntelSnapshot({
        generatedAt: "2026-05-10T00:00:00.000Z",
        openClawConfig: {
          models: {
            providers: {
              cliproxyapi: {
                models: [{ id: "gpt-5.5", cost: { input: 2, output: 10 } }],
              },
            },
          },
        },
        legacyCatalog: {
          models: [
            {
              id: "gpt-5.5",
              provider: "cliproxyapi",
              pricing: { input: 5, output: 10 },
              modalities: { input: ["text"] },
              capability_hints: {},
            },
          ],
        },
      });
      const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

      expect(model?.marketPrice.conflict).toBe(true);
      expect(model?.marketPrice.confidence).toBe("low");
    });

    it("does not set conflict when prices are close", () => {
      const snapshot = buildModelIntelSnapshot({
        generatedAt: "2026-05-10T00:00:00.000Z",
        openClawConfig: {
          models: {
            providers: {
              cliproxyapi: {
                models: [{ id: "gpt-5.5", cost: { input: 2, output: 10 } }],
              },
            },
          },
        },
        legacyCatalog: {
          models: [
            {
              id: "gpt-5.5",
              provider: "cliproxyapi",
              pricing: { input: 2.4, output: 11 },
              modalities: { input: ["text"] },
              capability_hints: {},
            },
          ],
        },
      });
      const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

      expect(model?.marketPrice.conflict).toBeUndefined();
    });

    it("preserves both sources on conflict", () => {
      const snapshot = buildModelIntelSnapshot({
        generatedAt: "2026-05-10T00:00:00.000Z",
        openClawConfig: {
          models: {
            providers: {
              cliproxyapi: {
                models: [{ id: "gpt-5.5", cost: { input: 2, output: 10 } }],
              },
            },
          },
        },
        legacyCatalog: {
          models: [
            {
              id: "gpt-5.5",
              provider: "cliproxyapi",
              pricing: { input: 5, output: 30 },
              modalities: { input: ["text"] },
              capability_hints: {},
            },
          ],
        },
      });
      const model = snapshot.models.find((entry) => entry.modelKey === "cliproxyapi/gpt-5.5");

      expect(model?.marketPrice.sources).toEqual(expect.arrayContaining(["openclaw_config", "legacy_model_catalog"]));
    });
  });

  describe("scenario ability", () => {
    it("populates scenarioAbility based on codingTier", () => {
      const snapshot = buildModelIntelSnapshot({
        generatedAt: "2026-05-10T00:00:00.000Z",
        legacyCatalog: {
          models: [
            { id: "frontier-model", provider: "test", size_class: "frontier", modalities: { input: ["text"] }, capability_hints: {} },
            { id: "standard-model", provider: "test", size_class: "standard", modalities: { input: ["text"] }, capability_hints: {} },
          ],
        },
      });
      const frontier = snapshot.models.find((entry) => entry.modelKey === "test/frontier-model");
      const standard = snapshot.models.find((entry) => entry.modelKey === "test/standard-model");

      expect(frontier?.scenarioAbility?.codingWorker.tier).toBe("S");
      expect(frontier?.scenarioAbility?.defaultDelegate.tier).toBe("S");
      expect(standard?.scenarioAbility?.codingWorker.tier).toBe("B");
      expect(standard?.scenarioAbility?.defaultDelegate.tier).toBe("B");
    });

    it("sets unknown tier for unknown codingTier", () => {
      const snapshot = buildModelIntelSnapshot({
        generatedAt: "2026-05-10T00:00:00.000Z",
        legacyCatalog: {
          models: [
            { id: "opaque-model", provider: "test", size_class: "opaque", modalities: { input: ["text"] }, capability_hints: {} },
          ],
        },
      });
      const model = snapshot.models.find((entry) => entry.modelKey === "test/opaque-model");

      expect(model?.scenarioAbility?.codingWorker.tier).toBe("unknown");
    });

    it("scenarioAbility confidence stays low without scenario-specific sources", () => {
      const snapshot = buildModelIntelSnapshot({
        generatedAt: "2026-05-10T00:00:00.000Z",
        legacyCatalog: {
          models: [
            { id: "standard-model", provider: "test", size_class: "standard", modalities: { input: ["text"] }, capability_hints: {} },
          ],
        },
      });
      const model = snapshot.models.find((entry) => entry.modelKey === "test/standard-model");

      expect(model?.capability.confidence).toBe("low");
      expect(model?.scenarioAbility?.codingWorker.confidence).toBe("low");
      expect(model?.scenarioAbility?.codingWorker.sources).toEqual([]);
    });
  });

  describe("freshness tracking", () => {
    it("sets freshness timestamp on each model", () => {
      const snapshot = buildModelIntelSnapshot({
        openClawModelsList: {
          models: [{ key: "cliproxyapi/gpt-5.5", tags: ["configured"] }],
        },
      });

      expect(snapshot.models.length).toBeGreaterThan(0);
      for (const model of snapshot.models) {
        expect(model.freshness).toBeDefined();
        expect(new Date(model.freshness ?? "").toISOString()).toBe(model.freshness);
      }
    });

    it("freshness matches generatedAt when provided", () => {
      const generatedAt = "2026-05-10T00:00:00.000Z";
      const snapshot = buildModelIntelSnapshot({
        generatedAt,
        openClawModelsList: {
          models: [{ key: "cliproxyapi/gpt-5.5", tags: ["configured"] }],
        },
      });

      expect(snapshot.models.every((model) => model.freshness === generatedAt)).toBe(true);
    });
  });
});
