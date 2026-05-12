import { describe, expect, it } from "vitest";
import { analyzeModelConfig } from "../config-analyze.js";
import type { ModelIntelLite, ModelIntelSnapshot, ScenarioAbilityLite, ScenarioAbilityScore } from "../contracts.js";
import { buildModelIntelSnapshot } from "../model-intel.js";

function scenarioScore(tier: ScenarioAbilityScore["tier"], confidence: ScenarioAbilityScore["confidence"]): ScenarioAbilityScore {
  return { tier, confidence, sources: [] };
}

function makeScenarioAbility(overrides: Partial<ScenarioAbilityLite>): ScenarioAbilityLite {
  const fallback = scenarioScore("B", "medium");
  return {
    codingWorker: fallback,
    agenticToolTask: fallback,
    researchLookup: fallback,
    dataLogAnalysis: fallback,
    mainReasoning: fallback,
    defaultDelegate: fallback,
    ...overrides,
  };
}

function makeModelWithScenario(overrides: Partial<ModelIntelLite> & { scenarioAbility?: ScenarioAbilityLite }): ModelIntelLite {
  return {
    provider: "cliproxyapi",
    model: "gpt-5.5",
    modelKey: "cliproxyapi/gpt-5.5",
    configured: true,
    available: "yes",
    proposalOnly: false,
    tags: ["configured"],
    marketPrice: { confidence: "high", sources: ["openclaw_config"], inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    capability: {
      input: ["text"],
      toolUse: "yes",
      structuredOutput: "yes",
      reasoning: "yes",
      promptCache: "unknown",
      codingTier: "strong",
      confidence: "high",
      evidence: ["declared"],
      sources: ["openclaw_config"],
    },
    health: {
      available: "yes",
      cooldown: false,
      quotaPressure: "unknown",
      sources: ["openclaw_models_list"],
    },
    plan: {
      type: "unknown",
      quotaPressure: "low",
      effectiveCostBand: "unknown",
      sources: [],
    },
    sources: ["openclaw_config"],
    ...overrides,
  };
}

function makeSnapshot(models: ModelIntelLite[]): ModelIntelSnapshot {
  return {
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: "scenario-test-snapshot",
    generatedAt: "2026-05-10T00:00:00.000Z",
    sourceStatus: [],
    models,
  };
}

describe("router-lite model config analysis", () => {
  it("proposes same-provider cheaper configured lanes without changing live routing", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              models: [
                {
                  id: "gpt-5.5",
                  contextWindow: 1000000,
                  reasoning: true,
                  cost: { input: 2, output: 10 },
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
            configured: false,
            size_class: "mini",
            pricing: { input: 0.1, output: 0.4 },
            capability_hints: { tool_call: "yes" },
            modalities: { input: ["text"] },
          },
        ],
      },
    });

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");

    expect(proposal.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "cliproxyapi",
        candidateModel: "cliproxyapi/gpt-5.5-mini",
        action: "add_configured_model",
        whyNotLive: expect.stringContaining("configured=false"),
      }),
      expect.objectContaining({
        provider: "cliproxyapi",
        candidateModel: "cliproxyapi/gpt-5.5",
        action: "add_plan_override",
        reason: "quota_pressure_unknown",
      }),
      expect.objectContaining({
        provider: "cliproxyapi",
        candidateModel: "cliproxyapi/gpt-5.5",
        action: "add_compatibility_probe",
        reason: "tool_or_structured_capability_unknown",
      }),
    ]));
    expect(proposal.summary).toMatchObject({
      configuredModels: 1,
      proposalOnlyModels: 1,
      providers: 1,
    });
  });

  it("asks for catalog refresh when a strong provider has no cheap candidate", () => {
    const snapshot = buildModelIntelSnapshot({
      generatedAt: "2026-05-10T00:00:00.000Z",
      openClawConfig: {
        models: {
          providers: {
            cliproxyapi: {
              models: [
                {
                  id: "gpt-5.5",
                  contextWindow: 1000000,
                  reasoning: true,
                  cost: { input: 2, output: 10 },
                },
              ],
            },
          },
        },
      },
    });

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");

    expect(proposal.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "cliproxyapi",
        action: "refresh_catalog",
        reason: "configured_strong_model_without_same_provider_cheap_candidate",
      }),
    ]));
  });

  it("proposes compatibility probe when scenario ability evidence is missing", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("unknown", "medium"),
        }),
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");

    expect(proposal.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "cliproxyapi",
        candidateModel: "cliproxyapi/gpt-5.5",
        action: "add_compatibility_probe",
        priority: "low",
        reason: expect.stringContaining("scenario_evidence_missing"),
      }),
    ]));
  });

  it("improved whyNotLive includes scenario context", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("S", "high"),
        }),
      }),
      makeModelWithScenario({
        model: "gpt-5.5-mini",
        modelKey: "cliproxyapi/gpt-5.5-mini",
        configured: false,
        proposalOnly: true,
        tags: ["catalog"],
        marketPrice: { confidence: "high", sources: ["legacy_catalog"], inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 },
        capability: {
          input: ["text"],
          toolUse: "yes",
          structuredOutput: "yes",
          reasoning: "unknown",
          promptCache: "unknown",
          codingTier: "mini",
          confidence: "high",
          evidence: ["declared"],
          sources: ["legacy_catalog"],
        },
        sources: ["legacy_catalog"],
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("A", "medium"),
        }),
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");

    expect(proposal.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateModel: "cliproxyapi/gpt-5.5-mini",
        action: "add_configured_model",
        whyNotLive: "configured=false — candidate not in local OpenClaw config; live routing would require explicit operator enable; codingWorker tier is A with medium confidence",
      }),
    ]));
  });

  it("scenario-aware priority boost for strong candidates", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("S", "high"),
        }),
      }),
      makeModelWithScenario({
        model: "gpt-5.5-mini",
        modelKey: "cliproxyapi/gpt-5.5-mini",
        configured: false,
        proposalOnly: true,
        tags: ["catalog"],
        marketPrice: { confidence: "high", sources: ["legacy_catalog"], inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 },
        capability: {
          input: ["text"],
          toolUse: "yes",
          structuredOutput: "yes",
          reasoning: "unknown",
          promptCache: "unknown",
          codingTier: "mini",
          confidence: "high",
          evidence: ["declared"],
          sources: ["legacy_catalog"],
        },
        sources: ["legacy_catalog"],
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("A", "medium"),
        }),
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");

    expect(proposal.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateModel: "cliproxyapi/gpt-5.5-mini",
        action: "add_configured_model",
        priority: "high",
      }),
    ]));
  });

  it("scenario score comparison flags below-floor candidates", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("S", "high"),
        }),
      }),
      makeModelWithScenario({
        model: "gpt-5.5-mini",
        modelKey: "cliproxyapi/gpt-5.5-mini",
        configured: false,
        proposalOnly: true,
        tags: ["catalog"],
        marketPrice: { confidence: "high", sources: ["legacy_catalog"], inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 },
        capability: {
          input: ["text"],
          toolUse: "yes",
          structuredOutput: "yes",
          reasoning: "unknown",
          promptCache: "unknown",
          codingTier: "mini",
          confidence: "high",
          evidence: ["declared"],
          sources: ["legacy_catalog"],
        },
        sources: ["legacy_catalog"],
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("C", "high"),
        }),
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");

    expect(proposal.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateModel: "cliproxyapi/gpt-5.5-mini",
        action: "add_configured_model",
        reason: expect.stringContaining("candidate_scenario_below_floor"),
      }),
    ]));
  });
});

describe("scenario-aware proposals", () => {
  it("proposes scenario coverage gap when no configured model covers codingWorker", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("C", "medium"),
        }),
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");

    expect(proposal.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "cliproxyapi",
        action: "add_compatibility_probe",
        priority: "medium",
        reason: expect.stringContaining("No configured model covers codingWorker with sufficient ability"),
        expectedUse: "codingWorker tasks",
        risk: expect.stringContaining("medium"),
      }),
    ]));
  });

  it("does not propose gap when configured model has good scenario ability", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("A", "high"),
        }),
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");

    expect(proposal.proposals).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: expect.stringContaining("No configured model covers codingWorker with sufficient ability"),
      }),
    ]));
  });
});

describe("why_not_live explanations", () => {
  it("explains configured=false with detailed message", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("S", "high"),
        }),
      }),
      makeModelWithScenario({
        model: "gpt-5.5-mini",
        modelKey: "cliproxyapi/gpt-5.5-mini",
        configured: false,
        proposalOnly: true,
        tags: ["catalog"],
        marketPrice: { confidence: "high", sources: ["legacy_catalog"], inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 },
        capability: {
          input: ["text"],
          toolUse: "yes",
          structuredOutput: "yes",
          reasoning: "unknown",
          promptCache: "unknown",
          codingTier: "mini",
          confidence: "high",
          evidence: ["declared"],
          sources: ["legacy_catalog"],
        },
        sources: ["legacy_catalog"],
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");
    const item = proposal.proposals.find((entry) => entry.candidateModel === "cliproxyapi/gpt-5.5-mini");

    expect(item?.whyNotLive).toContain("configured=false");
    expect(item?.whyNotLive).toContain("operator enable");
  });

  it("explains quota_pressure_unknown with detailed message", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        plan: {
          type: "unknown",
          quotaPressure: "unknown",
          effectiveCostBand: "unknown",
          sources: [],
        },
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");
    const item = proposal.proposals.find((entry) => entry.reason === "quota_pressure_unknown");

    expect(item?.whyNotLive).toContain("quota_pressure");
    expect(item?.whyNotLive).toContain("evidence missing");
  });

  it("explains capability_unknown with detailed message", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        capability: {
          input: ["text"],
          toolUse: "unknown",
          structuredOutput: "yes",
          reasoning: "yes",
          promptCache: "unknown",
          codingTier: "strong",
          confidence: "high",
          evidence: ["declared"],
          sources: ["openclaw_config"],
        },
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");
    const item = proposal.proposals.find((entry) => entry.reason === "tool_or_structured_capability_unknown");

    expect(item?.whyNotLive).toContain("capability");
    expect(item?.whyNotLive).toContain("not confirmed");
  });
});

describe("same-provider scenario-aware discovery", () => {
  it("prefers candidate with better scenario ability", () => {
    const snapshot = makeSnapshot([
      makeModelWithScenario({
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("S", "high"),
        }),
      }),
      makeModelWithScenario({
        model: "gpt-5.5-mini-unknown",
        modelKey: "cliproxyapi/gpt-5.5-mini-unknown",
        configured: false,
        proposalOnly: true,
        tags: ["catalog"],
        marketPrice: { confidence: "high", sources: ["legacy_catalog"], inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 },
        capability: {
          input: ["text"],
          toolUse: "yes",
          structuredOutput: "yes",
          reasoning: "unknown",
          promptCache: "unknown",
          codingTier: "mini",
          confidence: "high",
          evidence: ["declared"],
          sources: ["legacy_catalog"],
        },
        sources: ["legacy_catalog"],
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("unknown", "unknown"),
        }),
      }),
      makeModelWithScenario({
        model: "gpt-5.5-mini-capable",
        modelKey: "cliproxyapi/gpt-5.5-mini-capable",
        configured: false,
        proposalOnly: true,
        tags: ["catalog"],
        marketPrice: { confidence: "high", sources: ["legacy_catalog"], inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.5 },
        capability: {
          input: ["text"],
          toolUse: "yes",
          structuredOutput: "yes",
          reasoning: "unknown",
          promptCache: "unknown",
          codingTier: "mini",
          confidence: "high",
          evidence: ["declared"],
          sources: ["legacy_catalog"],
        },
        sources: ["legacy_catalog"],
        scenarioAbility: makeScenarioAbility({
          codingWorker: scenarioScore("A", "high"),
        }),
      }),
    ]);

    const proposal = analyzeModelConfig(snapshot, "2026-05-10T00:01:00.000Z");
    const item = proposal.proposals.find((entry) => entry.action === "add_configured_model");

    expect(item).toEqual(expect.objectContaining({
      candidateModel: "cliproxyapi/gpt-5.5-mini-capable",
      priority: "high",
      reason: "Same-provider cheaper candidate with codingWorker tier A",
    }));
  });
});
