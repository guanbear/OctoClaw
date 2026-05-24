import { describe, expect, it } from "vitest";

import { buildModelIntelFactsPlane } from "../../decision/model-intel-facts.js";
import { selectShadowRecommendation } from "../../decision/shadow-selector.js";

describe("ModelIntelFactsPlane", () => {
  it("CSC-001 calibrates mini-named models to strong when benchmark score is strong", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              baseUrl: "http://localhost:8317/v1",
              models: [{ id: "gpt-5.4-mini" }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          {
            provider: "openai",
            model: "gpt-5.4-mini",
            modelKey: "openai/gpt-5.4-mini",
            configured: false,
            available: "yes",
            marketPrice: {
              blendedUsdPerMTok: 1.6875,
              confidence: "high",
              sources: ["packaged_leaderboard"],
            },
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "mini",
              confidence: "high",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
              scoreByScenario: {
                coding_worker: {
                  score: 86,
                  confidence: "high",
                  contributions: [],
                  reasonCodes: ["test_score"],
                },
              },
            },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
    });

    expect(facts.models.find((model) => model.modelKey === "cliproxyapi/gpt-5.4-mini")).toMatchObject({
      configured: true,
      proposalOnly: false,
      capability: {
        codingTier: "strong",
        capabilityScore: {
          score: 86,
          confidence: "high",
          reasonCodes: expect.arrayContaining(["score_source:coding_worker"]),
        },
        sources: expect.arrayContaining(["openclaw_config", "packaged_leaderboard"]),
      },
    });
  });

  it("CSC-002 keeps conservative prior tiers when benchmark score is missing", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            zai: {
              models: [{ id: "glm-4.7" }],
            },
          },
        },
      },
    });

    expect(facts.models.find((model) => model.modelKey === "zai/glm-4.7")).toMatchObject({
      capability: {
        codingTier: "standard",
        capabilityScore: {
          score: 64,
          confidence: "low",
          reasonCodes: expect.arrayContaining(["score_source:tier_prior"]),
        },
      },
    });
  });

  it("preserves packaged benchmark efficiency for published capability pages", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          {
            provider: "zhipu",
            model: "glm-5.1",
            modelKey: "zhipu/glm-5.1",
            configured: false,
            available: "yes",
            marketPrice: {
              blendedUsdPerMTok: 1,
              confidence: "high",
              sources: ["packaged_leaderboard"],
            },
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "strong",
              confidence: "high",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
              capabilityScore: {
                score: 82,
                confidence: "high",
                contributions: [],
                reasonCodes: ["global_anchor:artificial_analysis"],
              },
            },
            benchmarkEfficiency: {
              taskCostScore: 88,
              taskSpeedScore: 61,
              valueScore: 78.55,
              sources: ["pinchbench"],
            },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
    });

    expect(facts.models.find((model) => model.modelKey === "zhipu/glm-5.1")).toMatchObject({
      benchmarkEfficiency: {
        valueScore: 78.55,
        sources: ["pinchbench"],
      },
    });
  });

  it("ignores all-zero local config prices so external API prices do not conflict with plan placeholders", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            zhipu: {
              models: [{
                id: "GLM-5.1",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          packagedModel("zhipu", "GLM-5.1", "strong", 77, {
            marketPrice: {
              inputUsdPerMTok: 0.98,
              outputUsdPerMTok: 3.08,
              blendedUsdPerMTok: 1.505,
              confidence: "medium",
              sources: ["openrouter"],
            },
          }),
        ],
      },
    });

    const glm = facts.models.find((model) => model.modelKey === "zhipu/GLM-5.1");
    expect(glm?.marketPrice).toMatchObject({
      inputUsdPerMTok: 0.98,
      outputUsdPerMTok: 3.08,
      blendedUsdPerMTok: 1.505,
      confidence: "medium",
      sources: ["openrouter"],
    });
    expect(glm?.marketPrice.conflict).toBeUndefined();
    expect(glm?.marketPrice.sources).not.toContain("openclaw_config");
  });

  it("merges zhipu and zai GLM aliases while preserving the configured model key", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawModelsList: {
        models: [
          { key: "zai/glm-4.7", available: true, tags: ["configured"] },
        ],
      },
      openClawConfig: {
        models: {
          providers: {
            zai: {
              models: [{ id: "glm-4.7" }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          packagedModel("zhipu", "glm-4.7", "strong", 76, {
            marketPrice: {
              inputUsdPerMTok: 0.4,
              outputUsdPerMTok: 1.75,
              blendedUsdPerMTok: 0.7375,
              confidence: "medium",
              sources: ["openrouter"],
            },
            capability: {
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              confidence: "medium",
              evidence: ["declared"],
              sources: ["openrouter"],
            },
          }),
        ],
      },
    });

    expect(facts.models.find((model) => model.modelKey === "zhipu/glm-4.7")).toBeUndefined();
    expect(facts.models.find((model) => model.modelKey === "zai/glm-4.7")).toMatchObject({
      configured: true,
      proposalOnly: false,
      marketPrice: {
        blendedUsdPerMTok: 0.7375,
        confidence: "medium",
        sources: expect.arrayContaining(["openrouter"]),
      },
      capability: {
        toolUse: "yes",
        structuredOutput: "yes",
        reasoning: "yes",
        sources: expect.arrayContaining(["openrouter"]),
      },
    });
  });

  it("keeps low-confidence benchmark scores from promoting the declared coding tier", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            deepseek: {
              models: [{ id: "deepseek-v4-flash" }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            modelKey: "deepseek/deepseek-v4-flash",
            configured: false,
            available: "yes",
            marketPrice: {
              blendedUsdPerMTok: 1,
              confidence: "medium",
              sources: ["packaged_leaderboard"],
            },
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "mini",
              confidence: "low",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
              scoreByScenario: {
                coding_worker: {
                  score: 90,
                  confidence: "low",
                  contributions: [],
                  reasonCodes: ["catalog_low_confidence"],
                },
              },
            },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
    });

    expect(facts.models.find((model) => model.modelKey === "deepseek/deepseek-v4-flash")).toMatchObject({
      capability: {
        codingTier: "mini",
        capabilityScore: {
          score: 90,
          confidence: "low",
        },
      },
    });
  });

  it("CEC-003: single low-confidence source cannot cross a major tier", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            zai: {
              models: [{ id: "some-standard-model" }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          {
            provider: "zai",
            model: "some-standard-model",
            modelKey: "zai/some-standard-model",
            configured: false,
            available: "yes",
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "standard",
              confidence: "low",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
              scoreByScenario: {
                coding_worker: {
                  score: 93,
                  confidence: "low",
                  contributions: [{ source: "aider", rawScore: 93, baseWeight: 1, freshnessFactor: 1, sourceHealth: 1, effectiveWeight: 1 }],
                  reasonCodes: ["single_stale_source"],
                },
              },
            },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
    });

    const model = facts.models.find((m) => m.modelKey === "zai/some-standard-model");
    expect(model?.capability.codingTier).toBe("standard");
    expect(model?.capability.capabilityScore?.confidence).toBe("low");
  });

  it("CEC-004: strong benchmark evidence corrects a mini name to strong tier", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              models: [{ id: "gpt-5.4-mini" }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          {
            provider: "openai",
            model: "gpt-5.4-mini",
            modelKey: "openai/gpt-5.4-mini",
            configured: false,
            available: "yes",
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "mini",
              confidence: "high",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
              scoreByScenario: {
                coding_worker: {
                  score: 86,
                  confidence: "high",
                  contributions: [
                    { source: "aider", rawScore: 86, baseWeight: 0.35, freshnessFactor: 1, sourceHealth: 1, effectiveWeight: 0.35 },
                    { source: "swe_bench", rawScore: 85, baseWeight: 0.15, freshnessFactor: 1, sourceHealth: 1, effectiveWeight: 0.15 },
                  ],
                  reasonCodes: ["score_source:coding_worker"],
                },
              },
            },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
    });

    const model = facts.models.find((m) => m.modelKey === "cliproxyapi/gpt-5.4-mini");
    expect(model?.capability.codingTier).toBe("strong");
    expect(model?.capability.capabilityScore?.score).toBe(86);
    expect(model?.capability.capabilityScore?.confidence).toBe("high");
    expect(model?.capability.sources).toEqual(expect.arrayContaining(["openclaw_config", "packaged_leaderboard"]));
  });

  it("CEC-005: missing benchmark score uses conservative prior and keeps tier", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            zhipu: {
              models: [{ id: "glm-5" }],
            },
          },
        },
      },
    });

    const model = facts.models.find((m) => m.modelKey === "zhipu/glm-5");
    expect(model?.capability.codingTier).toBe("strong");
    expect(model?.capability.capabilityScore?.confidence).toBe("low");
    expect(model?.capability.capabilityScore?.reasonCodes).toEqual(expect.arrayContaining(["score_source:tier_prior"]));
  });

  it("CEC-006: medium single-source can lift at most one tier boundary", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            testprov: {
              models: [{ id: "standard-model" }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          {
            provider: "testprov",
            model: "standard-model",
            modelKey: "testprov/standard-model",
            configured: false,
            available: "yes",
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "standard",
              confidence: "medium",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
              scoreByScenario: {
                coding_worker: {
                  score: 78,
                  confidence: "medium",
                  contributions: [
                    { source: "aider", rawScore: 78, baseWeight: 1, freshnessFactor: 1, sourceHealth: 1, effectiveWeight: 1 },
                  ],
                  reasonCodes: ["single_source:medium"],
                },
              },
            },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
    });

    const model = facts.models.find((m) => m.modelKey === "testprov/standard-model");
    expect(model?.capability.codingTier).toBe("strong");
    expect(model?.capability.capabilityScore?.confidence).toBe("medium");
  });

  it("CEC-007: low-confidence evidence cannot demote below baseline tier", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            testprov: {
              models: [{ id: "strong-model" }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          {
            provider: "testprov",
            model: "strong-model",
            modelKey: "testprov/strong-model",
            configured: false,
            available: "yes",
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "strong",
              confidence: "low",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
              scoreByScenario: {
                coding_worker: {
                  score: 30,
                  confidence: "low",
                  contributions: [],
                  reasonCodes: ["stale_low_sample"],
                },
              },
            },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
    });

    const model = facts.models.find((m) => m.modelKey === "testprov/strong-model");
    expect(model?.capability.codingTier).toBe("strong");
  });

  it("keeps facts-layer family inference conservative without benchmark evidence", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-22T00:00:00.000Z",
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-22T00:00:00.000Z",
        models: [
          packagedModel("zhipu", "glm-5", "standard"),
          packagedModel("zhipu", "glm-4.7", "strong"),
          packagedModel("deepseek", "deepseek-v4-pro", "standard", 61),
          packagedModel("deepseek", "deepseek-v4-flash", "mini", 90),
          packagedModel("moonshotai", "kimi-k2.6", "standard"),
          packagedModel("minimax", "minimax-m2.7", "mini", 72),
        ],
      },
    });

    expect(facts.models.find((model) => model.modelKey === "zhipu/glm-5")?.capability.codingTier).toBe("strong");
    expect(facts.models.find((model) => model.modelKey === "deepseek/deepseek-v4-pro")?.capability.codingTier).toBe("strong");
    expect(facts.models.find((model) => model.modelKey === "deepseek/deepseek-v4-flash")?.capability.codingTier).toBe("mini");
    expect(facts.models.find((model) => model.modelKey === "moonshotai/kimi-k2.6")?.capability.codingTier).toBe("standard");
    expect(facts.models.find((model) => model.modelKey === "minimax/minimax-m2.7")?.capability.codingTier).toBe("mini");
  });

  it("centralizes configured, proposal, mirrored, and health facts for snapshot assembly", () => {
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-16T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              baseUrl: "https://clip.example.test/v1",
              models: [{ id: "gpt-5.5", cost: { input: 30, output: 90 } }],
            },
            zhipu: {
              models: [{ id: "glm-4.7" }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-15T00:00:00.000Z",
        models: [
          {
            provider: "openai",
            model: "gpt-5-mini",
            modelKey: "openai/gpt-5-mini",
            configured: false,
            available: "yes",
            marketPrice: {
              blendedUsdPerMTok: 1,
              confidence: "medium",
              sources: ["packaged_leaderboard"],
            },
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "mini",
              confidence: "medium",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
            },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
      healthSnapshot: {
        schemaVersion: "octoclaw.router.health_snapshot/v1",
        generatedAt: 1_778_900_000_000,
        models: {
          "zai/glm-4.7": {
            cooldown: true,
            cooldownUntil: 1_778_900_600_000,
            cooldownReason: "rate_limit_429",
            recentFailureRate: 0.25,
          },
        },
      },
    });

    expect(facts.generatedAt).toBe("2026-05-16T00:00:00.000Z");
    expect(facts.sourceStatus).toContainEqual({ source: "packaged_model_intel", status: "ok" });
    expect(facts.models.find((model) => model.modelKey === "cliproxyapi/gpt-5.5")).toMatchObject({
      configured: true,
      proposalOnly: false,
    });
    expect(facts.models.find((model) => model.modelKey === "cliproxyapi/gpt-5-mini")).toMatchObject({
      configured: false,
      proposalOnly: true,
      sources: expect.arrayContaining(["provider_alias:openai"]),
    });
    expect(facts.models.find((model) => model.modelKey === "zhipu/glm-4.7")).toMatchObject({
      health: {
        cooldown: true,
        cooldownUntil: 1_778_900_600_000,
        cooldownReason: "rate_limit_429",
        recentFailureRate: 0.25,
        sources: expect.arrayContaining(["router_health_snapshot"]),
      },
    });
  });

  it("keeps native default aliases proposal-only and enriches configured proxy models from OpenAI-family facts", () => {
    const freshTimestamp = new Date().toISOString();
    const facts = buildModelIntelFactsPlane({
      generatedAt: freshTimestamp,
      openClawModelsList: {
        models: [
          {
            key: "openai/gpt-5.5",
            name: "gpt-5.5",
            input: "text",
            contextWindow: 200000,
            available: false,
            tags: ["default"],
            missing: false,
          },
        ],
      },
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              baseUrl: "http://localhost:8317/v1",
              models: [{ id: "gpt-5.5", name: "GPT-5.5 via CLI Proxy" }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: freshTimestamp,
        models: [
          {
            provider: "openai",
            model: "gpt-5.5",
            modelKey: "openai/gpt-5.5",
            configured: false,
            available: "yes",
            marketPrice: {
              inputUsdPerMTok: 8,
              outputUsdPerMTok: 24,
              blendedUsdPerMTok: 12,
              confidence: "medium",
              sources: ["packaged_leaderboard"],
            },
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "frontier",
              confidence: "medium",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
            },
            sources: ["packaged_leaderboard"],
          },
          {
            provider: "openai",
            model: "gpt-5-mini",
            modelKey: "openai/gpt-5-mini",
            configured: false,
            available: "yes",
            marketPrice: {
              inputUsdPerMTok: 0.2,
              outputUsdPerMTok: 0.6,
              blendedUsdPerMTok: 0.3,
              confidence: "medium",
              sources: ["packaged_leaderboard"],
            },
            capability: {
              input: ["text"],
              toolUse: "yes",
              structuredOutput: "yes",
              reasoning: "yes",
              promptCache: "unknown",
              codingTier: "mini",
              confidence: "medium",
              evidence: ["declared"],
              sources: ["packaged_leaderboard"],
            },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
    });

    expect(facts.models.find((model) => model.modelKey === "openai/gpt-5.5")).toMatchObject({
      configured: false,
      proposalOnly: true,
      available: "no",
      tags: ["default"],
    });
    const configuredProxy = facts.models.find((model) => model.modelKey === "cliproxyapi/gpt-5.5");
    expect(configuredProxy).toMatchObject({
      configured: true,
      proposalOnly: false,
      available: "yes",
      marketPrice: {
        inputUsdPerMTok: 8,
        outputUsdPerMTok: 24,
        sources: expect.arrayContaining(["packaged_leaderboard"]),
      },
      capability: {
        toolUse: "yes",
        structuredOutput: "yes",
        reasoning: "yes",
        codingTier: "frontier",
        sources: expect.arrayContaining(["openclaw_config", "packaged_leaderboard"]),
      },
      scenarioAbility: {
        codingWorker: {
          tier: "S",
          confidence: "high",
          sources: expect.arrayContaining([
            expect.objectContaining({ source: "operator_override" }),
            expect.objectContaining({ source: "artificial_analysis" }),
          ]),
        },
      },
      sources: expect.arrayContaining(["openclaw_config", "packaged_model_intel", "provider_alias:openai"]),
    });
    expect(configuredProxy?.sources).not.toContain("openclaw_models_list");
    expect(configuredProxy?.capability.sources).not.toContain("openclaw_models_list");
    expect(facts.models.find((model) => model.modelKey === "cliproxyapi/gpt-5-mini")).toMatchObject({
      configured: false,
      proposalOnly: true,
      available: "yes",
      marketPrice: { blendedUsdPerMTok: 0.3 },
      capability: { codingTier: "mini" },
      sources: expect.arrayContaining(["provider_alias:openai"]),
    });

    const recommendation = selectShadowRecommendation(
      {
        sessionKey: "s1",
        turnId: "t1",
        liveRoute: "delegate",
        liveModel: "cliproxyapi/gpt-5.5",
        judge: { route: "delegate", confidence: 0.9, complexity: "deep" },
        runtime: { needsTools: true, needsReasoning: true, needsStructuredOutput: true },
        snapshotId: "facts-test",
      },
      {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "facts-test",
        generatedAt: facts.generatedAt,
        sourceStatus: facts.sourceStatus,
        models: facts.models,
      },
      "balanced",
    );

    expect(recommendation.recommendedModel).toBe("cliproxyapi/gpt-5.5");
    expect(recommendation.rejectedModels).toEqual(expect.arrayContaining([
      { model: "openai/gpt-5.5", reason: "not_configured" },
      { model: "cliproxyapi/gpt-5-mini", reason: "not_configured" },
    ]));
  });
});

function packagedModel(
  provider: string,
  model: string,
  tier: "mini" | "standard" | "strong" | "frontier",
  score?: number,
  overrides: {
    marketPrice?: Record<string, unknown>;
    capability?: Record<string, unknown>;
    [key: string]: unknown;
  } = {},
) {
  const base = {
    provider,
    model,
    modelKey: `${provider}/${model}`,
    configured: false,
    available: "yes",
    marketPrice: {
      blendedUsdPerMTok: 1,
      confidence: "medium",
      sources: ["packaged_leaderboard"],
    },
    capability: {
      input: ["text"],
      toolUse: "yes",
      structuredOutput: "yes",
      reasoning: "yes",
      promptCache: "unknown",
      codingTier: tier,
      confidence: "low",
      evidence: ["declared"],
      sources: ["packaged_leaderboard"],
      ...(score === undefined ? {} : {
        scoreByScenario: {
          coding_worker: {
            score,
            confidence: "low",
            contributions: [],
            reasonCodes: ["catalog_low_confidence"],
          },
        },
      }),
    },
    sources: ["packaged_leaderboard"],
  };
  return {
    ...base,
    ...overrides,
    marketPrice: { ...base.marketPrice, ...overrides.marketPrice },
    capability: { ...base.capability, ...overrides.capability },
  };
}
