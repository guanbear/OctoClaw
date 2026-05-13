import { describe, expect, it } from "vitest";
import edgeCaseModels from "./fixtures/edge-case-models.json" with { type: "json" };
import priceConflictSnapshot from "./fixtures/price-conflict-snapshot.json" with { type: "json" };
import scenarioAbilityBasic from "./fixtures/scenario-ability-basic.json" with { type: "json" };
import shadowEventFull from "./fixtures/shadow-event-full.json" with { type: "json" };
import snapshotWithScenarios from "./fixtures/snapshot-with-scenarios.json" with { type: "json" };
import type {
  ModelIntelLite,
  ScenarioAbilityLite,
  RouterLiteRecommendation,
  RouterLiteRequest,
  RouterLiteScoringMode,
  RouterLiteShadowEvent,
  ModelIntelSnapshot,
} from "../contracts.js";

describe("router-lite contracts: scenario ability types", () => {
  it("ScenarioAbilityLite fixture has all 6 scenario fields", () => {
    const ability = scenarioAbilityBasic as ScenarioAbilityLite;
    expect(ability).toHaveProperty("codingWorker");
    expect(ability).toHaveProperty("agenticToolTask");
    expect(ability).toHaveProperty("researchLookup");
    expect(ability).toHaveProperty("dataLogAnalysis");
    expect(ability).toHaveProperty("mainReasoning");
    expect(ability).toHaveProperty("defaultDelegate");
  });

  it("ScenarioAbilityScore has expected shape with sources", () => {
    const score = (scenarioAbilityBasic as ScenarioAbilityLite).codingWorker;
    expect(score).toHaveProperty("score");
    expect(score).toHaveProperty("tier");
    expect(score).toHaveProperty("confidence");
    expect(Array.isArray(score.sources)).toBe(true);
    expect(score.tier).toBe("A");
    expect(score.confidence).toBe("medium");
    expect(score.sources.length).toBeGreaterThan(0);
  });

  it("ScenarioAbilityScore sources have required fields", () => {
    const sources = (scenarioAbilityBasic as ScenarioAbilityLite).codingWorker.sources;
    for (const src of sources) {
      expect(src).toHaveProperty("source");
      expect(src).toHaveProperty("fetchedAt");
      expect(typeof src.source).toBe("string");
      expect(typeof src.fetchedAt).toBe("string");
    }
  });

  it("ScenarioAbilityScore with no sources has unknown tier and confidence", () => {
    const score = (scenarioAbilityBasic as ScenarioAbilityLite).agenticToolTask;
    expect(score.sources).toEqual([]);
    expect(score.tier).toBe("unknown");
    expect(score.confidence).toBe("unknown");
  });

  it("RouterLiteScoringMode accepts the 3 expected values", () => {
    const modes: RouterLiteScoringMode[] = ["cost_first", "balanced", "reliable_fast"];
    expect(modes).toHaveLength(3);
    expect(modes).toContain("cost_first");
    expect(modes).toContain("balanced");
    expect(modes).toContain("reliable_fast");
  });
});

describe("router-lite contracts: shadow event enhancement", () => {
  it("RouterLiteShadowEvent fixture has judge fields", () => {
    const event = shadowEventFull as RouterLiteShadowEvent;
    expect(event.judge).toBeDefined();
    expect(event.judge?.route).toBe("delegate");
    expect(event.judge?.confidence).toBe(0.86);
    expect(event.judge?.complexity).toBe("normal");
    expect(event.judge).not.toHaveProperty("complexityConfidence");
  });

  it("RouterLiteShadowEvent fixture has scenario", () => {
    const event = shadowEventFull as RouterLiteShadowEvent;
    expect(event.scenario).toBe("codingWorker");
  });

  it("RouterLiteShadowEvent recommendation has scoringMode", () => {
    const event = shadowEventFull as RouterLiteShadowEvent;
    expect(event.recommendation.scoringMode).toBe("cost_first");
    expect(event.recommendation.scenario).toBe("codingWorker");
  });
});

describe("router-lite contracts: snapshot with scenarios", () => {
  it("ModelIntelLite in snapshot has scenarioAbility", () => {
    const snapshot = snapshotWithScenarios as ModelIntelSnapshot;
    const model = snapshot.models[0];
    expect(model.scenarioAbility).toBeDefined();
    expect(model.scenarioAbility?.codingWorker.score).toBe(89);
    expect(model.scenarioAbility?.codingWorker.tier).toBe("A");
  });

  it("ModelIntelLite in snapshot has freshness", () => {
    const snapshot = snapshotWithScenarios as ModelIntelSnapshot;
    const model = snapshot.models[0];
    expect(model.freshness).toBe("2026-05-10T00:00:00.000Z");
  });
});

describe("router-lite contracts: source evidence requirements", () => {
  it("ModelIntelLite with no capability sources has unknown confidence", () => {
    const model = edgeCaseModels.noSources as ModelIntelLite;
    expect(model.capability.sources).toEqual([]);
    expect(model.capability.confidence).toBe("unknown");
    expect(model.capability.confidence).not.toBe("high");
  });

  it("Price conflict marker is preserved when sources disagree", () => {
    const snapshot = priceConflictSnapshot as ModelIntelSnapshot;
    const model = snapshot.models[0];
    expect(model.marketPrice.conflict).toBe(true);
    expect(model.marketPrice.sources).toEqual(["openclaw_config", "openrouter"]);
    expect(["low", "medium"]).toContain(model.marketPrice.confidence);
    expect(model.marketPrice.confidence).not.toBe("high");
  });

  it("Edge case: unknown quota model does not get free_or_sunk band", () => {
    const model = edgeCaseModels.unknownQuota as ModelIntelLite;
    expect(model.plan.quotaPressure).toBe("unknown");
    expect(model.plan.effectiveCostBand).toBe("unknown");
    expect(model.plan.effectiveCostBand).not.toBe("free_or_sunk");
  });

  it("Edge case: cooldown model still marked available", () => {
    const model = edgeCaseModels.cooldown as ModelIntelLite;
    expect(model.health.available).toBe("yes");
    expect(model.health.cooldown).toBe(true);
  });

  it("Edge case: stale evidence model has low confidence", () => {
    const model = edgeCaseModels.staleEvidence as ModelIntelLite;
    expect(model.freshness).toBe("2026-03-01T00:00:00.000Z");
    expect(model.capability.confidence).toBe("low");
  });

  it("Edge case: heuristic-only evidence is not declared/probed/observed", () => {
    const model = edgeCaseModels.staleEvidence as ModelIntelLite;
    expect(model.capability.evidence).toEqual(["heuristic"]);
    expect(model.capability.evidence).not.toContain("declared");
    expect(model.capability.evidence).not.toContain("probed");
    expect(model.capability.evidence).not.toContain("observed");
  });

  it("RouterLiteRecommendation ignoredReason accepts all new variants", () => {
    const recommendations: RouterLiteRecommendation[] = [
      {
        outputBudget: "short",
        qualityFloor: "unknown",
        eligibleModels: [],
        rejectedModels: [],
        reasonCodes: [],
        mode: "shadow",
        ignoredReason: "status_or_provenance_request",
      },
      {
        outputBudget: "short",
        qualityFloor: "unknown",
        eligibleModels: [],
        rejectedModels: [],
        reasonCodes: [],
        mode: "shadow",
        ignoredReason: "stale_evidence",
      },
      {
        outputBudget: "short",
        qualityFloor: "unknown",
        eligibleModels: [],
        rejectedModels: [],
        reasonCodes: [],
        mode: "shadow",
        ignoredReason: "explicit_override",
      },
    ];
    expect(recommendations.map((recommendation) => recommendation.ignoredReason)).toEqual([
      "status_or_provenance_request",
      "stale_evidence",
      "explicit_override",
    ]);
  });

  it("RouterLiteRequest runtime has needsStructuredOutput field", () => {
    const request: RouterLiteRequest = {
      sessionKey: "session_001",
      turnId: "turn_001",
      liveRoute: "delegate",
      judge: {
        route: "delegate",
        confidence: 0.8,
        complexity: "normal",
      },
      runtime: {
        needsStructuredOutput: true,
      },
      snapshotId: "model-intel:1746835200000",
    };
    expect(request.runtime.needsStructuredOutput).toBe(true);
  });
});
