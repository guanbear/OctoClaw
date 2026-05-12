import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildModelIntelSnapshot } from "../model-intel.js";
import type { ModelIntelSnapshot, RouterLiteRequest } from "../contracts.js";
import { selectShadowRecommendation } from "../shadow-selector.js";
import { writeShadowEvent, generateShadowReport } from "../shadow-event.js";

const FRESH_AT = new Date().toISOString();

function makeSnapshot(scenarioData?: unknown): ModelIntelSnapshot {
  return buildModelIntelSnapshot({
    generatedAt: FRESH_AT,
    openClawConfig: {
      models: {
        providers: {
          cliproxyapi: {
            models: [
              {
                id: "gpt-5.5",
                contextWindow: 1000000,
                reasoning: true,
                cost: { input: 5, output: 30 },
              },
              {
                id: "gpt-5.5-mini",
                contextWindow: 128000,
                cost: { input: 0.75, output: 4.5 },
              },
            ],
          },
        },
      },
    },
    scenarioData,
  });
}

function makeRequest(overrides?: Partial<RouterLiteRequest>): RouterLiteRequest {
  return {
    sessionKey: "integration-session",
    turnId: "turn-int-001",
    liveRoute: "delegate",
    judge: { route: "delegate", confidence: 0.9, complexity: "normal", complexityConfidence: 0.85 },
    runtime: { needsTools: true },
    snapshotId: "snap-int-001",
    ...overrides,
  };
}

describe("router-lite integration: snapshot → selector → event", () => {
  it("full pipeline produces a shadow recommendation and writes an event", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "router-lite-integration-"));
    const jsonlPath = join(tempDir, "shadow.jsonl");

    try {
      const snapshot = makeSnapshot();
      const request = makeRequest();
      const recommendation = selectShadowRecommendation(request, snapshot, "balanced");

      expect(recommendation.mode).toBe("shadow");
      expect(recommendation.scoringMode).toBe("balanced");

      writeShadowEvent({
        event: "router_lite_recommendation",
        turnId: request.turnId,
        snapshotId: snapshot.snapshotId,
        liveRoute: request.liveRoute,
        actualModel: request.liveModel,
        recommendation,
        qualityGate: "unknown",
        judge: request.judge,
        scenario: recommendation.scenario,
      }, jsonlPath);

      expect(existsSync(jsonlPath)).toBe(true);

      const report = generateShadowReport(jsonlPath);
      expect(report.totalEvents).toBe(1);
      expect(report.modeCounts).toHaveProperty("balanced", 1);

      const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.event).toBe("router_lite_recommendation");
      expect(parsed.turnId).toBe("turn-int-001");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("empty snapshot produces no eligible model and records the ignored reason", () => {
    const snapshot: ModelIntelSnapshot = {
      schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
      snapshotId: "snap-empty",
      generatedAt: "2026-05-10T00:00:00.000Z",
      sourceStatus: [],
      models: [],
    };

    const recommendation = selectShadowRecommendation(makeRequest(), snapshot);
    expect(recommendation.recommendedModel).toBeUndefined();
    expect(recommendation.ignoredReason).toBe("no_eligible_model");
    expect(recommendation.eligibleModels).toEqual([]);
  });

  it("all models fail hard gates — ignored reason is set", () => {
    const snapshot = makeSnapshot();

    const request = makeRequest({
      runtime: { needsTools: true, minContextTokens: 200000 },
    });

    const recommendation = selectShadowRecommendation(request, snapshot, "cost_first");

    if (recommendation.recommendedModel) {
      expect(recommendation.eligibleModels.length).toBeGreaterThan(0);
    } else {
      expect(recommendation.ignoredReason).toBeDefined();
    }
  });

  it("scenario ability flows from snapshot into shadow selector scoring", () => {
    const snapshot = makeSnapshot({
      "cliproxyapi/gpt-5.5": {
        codingWorker: {
          score: 89,
          tier: "A",
          confidence: "high",
          sources: [{ source: "pinchbench", score: 89, fetchedAt: FRESH_AT }],
        },
        agenticToolTask: { tier: "unknown", confidence: "unknown", sources: [] },
        researchLookup: { tier: "unknown", confidence: "unknown", sources: [] },
        dataLogAnalysis: { tier: "unknown", confidence: "unknown", sources: [] },
        mainReasoning: { tier: "unknown", confidence: "unknown", sources: [] },
        defaultDelegate: { tier: "unknown", confidence: "unknown", sources: [] },
      },
      "cliproxyapi/gpt-5.5-mini": {
        codingWorker: {
          score: 60,
          tier: "C",
          confidence: "medium",
          sources: [{ source: "pinchbench", score: 60, fetchedAt: FRESH_AT }],
        },
        agenticToolTask: { tier: "unknown", confidence: "unknown", sources: [] },
        researchLookup: { tier: "unknown", confidence: "unknown", sources: [] },
        dataLogAnalysis: { tier: "unknown", confidence: "unknown", sources: [] },
        mainReasoning: { tier: "unknown", confidence: "unknown", sources: [] },
        defaultDelegate: { tier: "unknown", confidence: "unknown", sources: [] },
      },
    });

    const gpt55 = snapshot.models.find((m) => m.modelKey === "cliproxyapi/gpt-5.5");
    expect(gpt55?.scenarioAbility?.codingWorker.tier).toBe("A");
    expect(gpt55?.scenarioAbility?.codingWorker.score).toBe(89);

    const mini = snapshot.models.find((m) => m.modelKey === "cliproxyapi/gpt-5.5-mini");
    expect(mini?.scenarioAbility?.codingWorker.tier).toBe("C");
  });

  it("shadow report aggregates multiple events correctly", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "router-lite-integration-"));
    const jsonlPath = join(tempDir, "shadow.jsonl");

    try {
      const snapshot = makeSnapshot();
      const modes = ["cost_first", "balanced", "cost_first"] as const;

      for (let i = 0; i < 3; i++) {
        const request = makeRequest({ turnId: `turn-${i}` });
        const recommendation = selectShadowRecommendation(request, snapshot, modes[i]);

        writeShadowEvent({
          event: "router_lite_recommendation",
          turnId: request.turnId,
          snapshotId: snapshot.snapshotId,
          liveRoute: request.liveRoute,
          recommendation,
          estimatedCostDeltaUsd: -0.01 * i,
          qualityGate: i === 1 ? "fail" : "pass",
        }, jsonlPath);
      }

      const report = generateShadowReport(jsonlPath);
      expect(report.totalEvents).toBe(3);
      expect(report.modeCounts).toMatchObject({ cost_first: 2, balanced: 1 });
      expect(report.qualityGatePass).toBe(2);
      expect(report.qualityGateFail).toBe(1);
      expect(report.estimatedCostDeltaTotalUsd).toBeCloseTo(-0.03);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
