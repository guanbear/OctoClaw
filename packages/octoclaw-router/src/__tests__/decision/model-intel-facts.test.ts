import { describe, expect, it } from "vitest";

import { buildModelIntelFactsPlane } from "../../decision/model-intel-facts.js";

describe("ModelIntelFactsPlane", () => {
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
});
