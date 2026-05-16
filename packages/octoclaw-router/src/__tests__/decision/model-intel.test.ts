import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  analyzeModelConfig,
  buildModelIntelSnapshot,
  generateShadowReport,
  writeShadowEvent,
} from "../../decision/index.js";

describe("model intelligence and shadow reporting", () => {
  it("RT-C-008 merges OpenClaw, catalog, usage, price, and scenario evidence into one snapshot", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-14T00:00:00.000Z",
      openClawModelsList: {
        models: [
          {
            key: "openai/gpt-5.5",
            name: "GPT 5.5",
            available: true,
            tags: ["configured"],
            input: ["text", "image"],
            contextWindow: "200000",
          },
          { key: "openai/gpt-5-mini", available: true, tags: [] },
          { key: "", available: true },
        ],
      },
      openClawConfig: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-5.5",
                  name: "Configured GPT",
                  input: ["text"],
                  reasoning: true,
                  contextWindow: 240000,
                  cost: { input: 8, output: 24, cacheRead: 0.8, cacheWrite: 2 },
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
            provider: "zhipu",
            short_name: "GLM",
            configured: true,
            available: true,
            pricing: { input: 1, output: 3 },
            size_class: "strong",
            modalities: { input: ["text"] },
            capability_hints: { tool_call: true, reasoning: true },
            limits: { context_length: 128000 },
            plan_state: { type: "subscription", quota_pressure: "low" },
          },
          {
            id: "gpt-5-mini",
            provider: "openai",
            configured: false,
            pricing: { input: 0.2, output: 0.6 },
            size_class: "mini",
          },
        ],
      },
      usageStatus: {
        models: {
          "openai/gpt-5.5": {
            available: true,
            cooldown: false,
            quotaPressure: "medium",
            p50_first_token_ms: 300,
            p95_latency_ms: 1800,
            recent_failure_rate: 0.02,
          },
        },
      },
      usageCost: {
        models: {
          "openai/gpt-5.5": {
            marketPrice: { input: 7, output: 22 },
            plan: {
              type: "pay_as_you_go",
              quotaPressure: "medium",
              effectiveCostBand: "expensive",
              resetAt: "2026-06-01T00:00:00.000Z",
            },
          },
        },
      },
      nativeFallbackOrder: { fallbacks: ["openai/gpt-5.5", "zhipu/glm-5.1"] },
      scenarioData: {
        "openai/gpt-5.5": {
          codingWorker: {
            tier: "S",
            confidence: "high",
            sources: [{ source: "local_replay", sampleCount: 42, fetchedAt: "2026-05-14T00:00:00.000Z" }],
          },
        },
      },
    });

    expect(snapshot.sourceStatus).toContainEqual({ source: "scenario_data", status: "ok" });
    expect(snapshot.sourceStatus).toContainEqual({ source: "openclaw_native_fallbacks", status: "ok" });
    expect(snapshot.nativeFallbackOrder).toEqual(["openai/gpt-5.5", "zhipu/glm-5.1"]);
    expect(snapshot.models.map((model) => model.modelKey)).toEqual([
      "openai/gpt-5-mini",
      "openai/gpt-5.5",
      "zhipu/glm-5.1",
    ]);
    expect(snapshot.models.find((model) => model.modelKey === "openai/gpt-5.5")).toMatchObject({
      configured: true,
      proposalOnly: false,
      marketPrice: {
        inputUsdPerMTok: 7,
        outputUsdPerMTok: 22,
        cacheReadUsdPerMTok: 0.8,
        cacheWriteUsdPerMTok: 2,
        confidence: "high",
        ratioBaselineModel: "zhipu/glm-5.1",
        ratioToBaseline: 7.166666666666667,
      },
      capability: {
        contextWindow: 240000,
        input: ["text", "image"],
        reasoning: "yes",
        evidence: ["heuristic", "declared"],
      },
      health: {
        quotaPressure: "medium",
        p50FirstTokenMs: 300,
        p95LatencyMs: 1800,
        recentFailureRate: 0.02,
      },
      plan: {
        type: "pay_as_you_go",
        quotaPressure: "medium",
        effectiveCostBand: "expensive",
      },
      scenarioAbility: {
        codingWorker: { tier: "S", confidence: "high" },
      },
    });
    expect(snapshot.models.find((model) => model.modelKey === "openai/gpt-5-mini")).toMatchObject({
      configured: false,
      proposalOnly: true,
      capability: { codingTier: "mini" },
      marketPrice: { ratioBaselineModel: "zhipu/glm-5.1", ratioToBaseline: 0.20000000000000004 },
    });
  });

  it("RT-C-009 proposes safe config changes without making proposal-only models live", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-14T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-5.5",
                  cost: { input: 10, output: 30 },
                  reasoning: true,
                },
              ],
            },
          },
        },
      },
      legacyCatalog: {
        models: [
          {
            id: "gpt-5-mini",
            provider: "openai",
            configured: false,
            pricing: { input: 0.2, output: 0.6 },
            size_class: "mini",
            capability_hints: { tool_call: false },
          },
        ],
      },
      scenarioData: {
        "openai/gpt-5.5": {
          codingWorker: { tier: "S", confidence: "high", sources: [{ source: "local_replay", fetchedAt: "2026-05-14T00:00:00.000Z" }] },
          agenticToolTask: { tier: "A", confidence: "medium", sources: [{ source: "local_replay", fetchedAt: "2026-05-14T00:00:00.000Z" }] },
          researchLookup: { tier: "unknown", confidence: "unknown", sources: [] },
          dataLogAnalysis: { tier: "unknown", confidence: "unknown", sources: [] },
          mainReasoning: { tier: "unknown", confidence: "unknown", sources: [] },
          defaultDelegate: { tier: "unknown", confidence: "unknown", sources: [] },
        },
        "openai/gpt-5-mini": {
          codingWorker: { tier: "B", confidence: "medium", sources: [{ source: "pinchbench", fetchedAt: "2026-05-14T00:00:00.000Z" }] },
          agenticToolTask: { tier: "B", confidence: "medium", sources: [{ source: "bfcl", fetchedAt: "2026-05-14T00:00:00.000Z" }] },
          researchLookup: { tier: "C", confidence: "low", sources: [] },
          dataLogAnalysis: { tier: "C", confidence: "low", sources: [] },
          mainReasoning: { tier: "C", confidence: "low", sources: [] },
          defaultDelegate: { tier: "C", confidence: "low", sources: [] },
        },
      },
    });

    const proposal = analyzeModelConfig(snapshot, "2026-05-14T00:00:00.000Z");

    expect(proposal.summary).toEqual({ configuredModels: 1, proposalOnlyModels: 1, providers: 1 });
    expect(proposal.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "add_configured_model",
        candidateModel: "openai/gpt-5-mini",
        priority: "high",
        whyNotLive: expect.stringContaining("configured=false"),
      }),
      expect.objectContaining({
        action: "add_plan_override",
        candidateModel: "openai/gpt-5.5",
        reason: "quota_pressure_unknown",
      }),
      expect.objectContaining({
        action: "add_compatibility_probe",
        candidateModel: "openai/gpt-5.5",
        reason: "tool_or_structured_capability_unknown",
      }),
    ]));
    expect(proposal.proposals.some((item) => item.whyNotLive.includes("live routing would require explicit operator enable"))).toBe(true);
  });

  it("keeps packaged leaderboard models as proposal-only candidates in refreshed snapshots", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-14T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              models: [
                { id: "gpt-5.5", cost: { input: 30, output: 90 } },
              ],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-13T00:00:00.000Z",
        sourceStatus: [{ source: "packaged_leaderboard", status: "ok" }],
        models: [
          {
            provider: "openai",
            model: "gpt-5-mini",
            modelKey: "openai/gpt-5-mini",
            configured: true,
            available: "yes",
            proposalOnly: false,
            tags: [],
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
            health: { available: "yes", cooldown: false, quotaPressure: "unknown", sources: [] },
            plan: { type: "unknown", quotaPressure: "unknown", effectiveCostBand: "unknown", sources: [] },
            sources: ["packaged_leaderboard"],
          },
        ],
      },
    });

    expect(snapshot.sourceStatus).toContainEqual({ source: "packaged_model_intel", status: "ok" });
    expect(snapshot.models.find((model) => model.modelKey === "openai/gpt-5-mini")).toMatchObject({
      configured: false,
      proposalOnly: true,
      marketPrice: { blendedUsdPerMTok: 1, sources: ["packaged_leaderboard"] },
      capability: { codingTier: "mini", sources: ["packaged_leaderboard"] },
    });
    expect(snapshot.models.find((model) => model.modelKey === "cliproxyapi/gpt-5.5")).toMatchObject({
      configured: true,
      proposalOnly: false,
    });
  });

  it("mirrors OpenAI packaged candidates under configured OpenAI-compatible proxy providers", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-14T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              baseUrl: "https://clip.example.test/v1",
              models: [{ id: "gpt-5.5", cost: { input: 30, output: 90 } }],
            },
          },
        },
      },
      packagedSnapshot: {
        schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
        snapshotId: "packaged",
        generatedAt: "2026-05-13T00:00:00.000Z",
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
    });

    expect(snapshot.models.find((model) => model.modelKey === "cliproxyapi/gpt-5-mini")).toMatchObject({
      provider: "cliproxyapi",
      model: "gpt-5-mini",
      configured: false,
      proposalOnly: true,
      marketPrice: { blendedUsdPerMTok: 1 },
      capability: { codingTier: "mini" },
      sources: expect.arrayContaining(["packaged_model_intel", "provider_alias:openai"]),
    });
    const proposal = analyzeModelConfig(snapshot, "2026-05-14T00:00:00.000Z");
    expect(proposal.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "add_configured_model",
        candidateModel: "cliproxyapi/gpt-5-mini",
      }),
    ]));
  });

  it("merges router health snapshots into model intel with provider aliases", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-16T00:00:00.000Z",
      openClawModelsList: {
        models: [
          { key: "zhipu/glm-4.7", available: true, tags: ["configured"] },
        ],
      },
      healthSnapshot: {
        schemaVersion: "octoclaw.router.health_snapshot/v1",
        generatedAt: 1_778_900_000_000,
        models: {
          "zai/glm-4.7": {
            sampleCount: 12,
            recentFailureRate: 0.25,
            toolCallFailureRate: 0.08,
            timeoutRate: 0.17,
            p50LatencyMs: 900,
            p95LatencyMs: 3000,
            lastErrorCodes: [{ code: "429", count: 1 }],
            lastSuccessfulCallAt: 1_778_899_900_000,
            lastFailedCallAt: 1_778_900_000_000,
            cooldown: true,
            cooldownUntil: 1_778_900_600_000,
            cooldownReason: "rate_limit_429",
          },
        },
      },
    });

    expect(snapshot.sourceStatus).toContainEqual({ source: "router_health_snapshot", status: "ok" });
    expect(snapshot.models.find((model) => model.modelKey === "zhipu/glm-4.7")).toMatchObject({
      health: {
        cooldown: true,
        cooldownUntil: 1_778_900_600_000,
        cooldownReason: "rate_limit_429",
        recentFailureRate: 0.25,
        toolCallFailureRate: 0.08,
        timeoutRate: 0.17,
        p50LatencyMs: 900,
        p95LatencyMs: 3000,
        lastSuccessfulCallAt: "2026-05-16T02:51:40.000Z",
        lastFailedCallAt: "2026-05-16T02:53:20.000Z",
        lastErrorCodes: [{ code: "429", count: 1 }],
        sources: expect.arrayContaining(["router_health_snapshot"]),
      },
    });
  });

  it("RT-C-010 writes shadow events fail-open and reports local JSONL aggregates", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "octoclaw-shadow-report-"));
    const jsonlPath = path.join(tempDir, "shadow.jsonl");
    try {
      writeShadowEvent({
        event: "router_lite_recommendation",
        turnId: "turn-1",
        snapshotId: "snapshot-1",
        liveRoute: "delegate",
        actualModel: "openai/gpt-5.5",
        recommendation: {
          recommendedModel: "zhipu/glm-5.1",
          outputBudget: "medium",
          qualityFloor: "strong",
          eligibleModels: ["zhipu/glm-5.1"],
          rejectedModels: [],
          reasonCodes: ["quality_floor_pass:strong"],
          mode: "shadow",
          scoringMode: "balanced",
          ignoredReason: "low_confidence",
        },
        estimatedCostDeltaUsd: -0.12,
        qualityGate: "pass",
        scenario: "codingWorker",
      }, jsonlPath);
      fs.appendFileSync(jsonlPath, "{not-json}\n", "utf8");
      writeShadowEvent({
        event: "router_lite_recommendation",
        turnId: "turn-2",
        snapshotId: "snapshot-1",
        liveRoute: "reply",
        actualModel: "openai/gpt-5-mini",
        recommendation: {
          recommendedModel: "openai/gpt-5-mini",
          outputBudget: "short",
          qualityFloor: "mini",
          eligibleModels: ["openai/gpt-5-mini"],
          rejectedModels: [],
          reasonCodes: [],
          mode: "live",
          scoringMode: "balanced",
        },
        estimatedCostDeltaUsd: 0.05,
        qualityGate: "fail",
        scenario: "defaultDelegate",
      }, jsonlPath);

      const summary = generateShadowReport(jsonlPath);

      expect(summary).toMatchObject({
        totalEvents: 2,
        uniqueModelsRecommended: ["openai/gpt-5-mini", "zhipu/glm-5.1"],
        uniqueModelsActual: ["openai/gpt-5-mini", "openai/gpt-5.5"],
        ignoredReasonCounts: { low_confidence: 1 },
        estimatedCostDeltaTotalUsd: -0.06999999999999999,
        modeCounts: { balanced: 2 },
        scenarioCounts: { codingWorker: 1, defaultDelegate: 1 },
        qualityGatePass: 1,
        qualityGateFail: 1,
        timeRange: { first: "turn-1", last: "turn-2" },
      });

      const onError = vi.fn();
      writeShadowEvent({
        event: "router_lite_recommendation",
        turnId: "turn-3",
        snapshotId: "snapshot-1",
        liveRoute: "reply",
        recommendation: {
          outputBudget: "short",
          qualityFloor: "mini",
          eligibleModels: [],
          rejectedModels: [],
          reasonCodes: [],
          mode: "shadow",
        },
        qualityGate: "unknown",
      }, tempDir, { onError });

      expect(onError).toHaveBeenCalled();
      expect(generateShadowReport(path.join(tempDir, "missing.jsonl")).totalEvents).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
