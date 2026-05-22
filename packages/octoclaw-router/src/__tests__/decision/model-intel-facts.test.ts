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
    const facts = buildModelIntelFactsPlane({
      generatedAt: "2026-05-16T00:00:00.000Z",
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
        generatedAt: "2026-05-15T00:00:00.000Z",
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
