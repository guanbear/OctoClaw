import { describe, expect, it } from "vitest";
import scenarioAbilityBasic from "./fixtures/scenario-ability-basic.json" with { type: "json" };
import shadowEventFull from "./fixtures/shadow-event-full.json" with { type: "json" };
import snapshotWithScenarios from "./fixtures/snapshot-with-scenarios.json" with { type: "json" };
import type {
  ScenarioAbilityLite,
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
    expect(event.judge?.complexityConfidence).toBe(0.81);
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
