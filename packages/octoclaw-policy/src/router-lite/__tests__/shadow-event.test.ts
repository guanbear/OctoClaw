import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeShadowEvent, generateShadowReport, emptyShadowReport } from "../shadow-event.js";
import type { RouterLiteShadowEvent } from "../contracts.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "router-lite-shadow-test-"));
}

function makeEvent(overrides?: Partial<RouterLiteShadowEvent>): RouterLiteShadowEvent {
  return {
    event: "router_lite_recommendation",
    turnId: "turn-001",
    snapshotId: "snap-001",
    liveRoute: "delegate",
    actualModel: "cliproxyapi/gpt-5.5",
    recommendation: {
      outputBudget: "medium",
      qualityFloor: "standard",
      eligibleModels: ["cliproxyapi/gpt-5.5-mini"],
      rejectedModels: [],
      reasonCodes: ["hard_gate_pass"],
      mode: "shadow",
      scoringMode: "balanced",
    },
    qualityGate: "pass",
    scenario: "codingWorker",
    ...overrides,
  };
}

describe("writeShadowEvent", () => {
  it("appends JSONL line", () => {
    const tempDir = makeTempDir();
    const jsonlPath = join(tempDir, "shadow.jsonl");

    try {
      const event = makeEvent();
      writeShadowEvent(event, jsonlPath);

      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((line: string) => line.trim() !== "");

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed).toEqual(event);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates parent directories", () => {
    const tempDir = makeTempDir();
    const jsonlPath = join(tempDir, "tmp/test-nested/shadow.jsonl");

    try {
      const event = makeEvent();
      writeShadowEvent(event, jsonlPath);

      expect(existsSync(jsonlPath)).toBe(true);
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((line: string) => line.trim() !== "");

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed).toEqual(event);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fail-open on invalid path", () => {
    const event = makeEvent();
    const invalidPath = "/dev/null/impossible/path.jsonl";
    const errors: unknown[] = [];

    expect(() => {
      writeShadowEvent(event, invalidPath, { onError: (error) => errors.push(error) });
    }).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("writes multiple events", () => {
    const tempDir = makeTempDir();
    const jsonlPath = join(tempDir, "shadow.jsonl");

    try {
      writeShadowEvent(makeEvent({ turnId: "turn-001" }), jsonlPath);
      writeShadowEvent(makeEvent({ turnId: "turn-002" }), jsonlPath);
      writeShadowEvent(makeEvent({ turnId: "turn-003" }), jsonlPath);

      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((line: string) => line.trim() !== "");

      expect(lines).toHaveLength(3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("generateShadowReport", () => {
  it("returns summary", () => {
    const tempDir = makeTempDir();
    const jsonlPath = join(tempDir, "shadow.jsonl");

    try {
      writeShadowEvent(
        makeEvent({
          turnId: "turn-001",
          actualModel: "cliproxyapi/gpt-5.5",
          recommendation: {
            outputBudget: "medium",
            qualityFloor: "standard",
            eligibleModels: ["cliproxyapi/gpt-5.5-mini"],
            rejectedModels: [],
            reasonCodes: ["hard_gate_pass"],
            mode: "shadow",
            scoringMode: "balanced",
            recommendedModel: "cliproxyapi/gpt-5.5-mini",
            ignoredReason: "low_confidence",
          },
          estimatedCostDeltaUsd: -0.01,
          qualityGate: "pass",
          scenario: "codingWorker",
        }),
        jsonlPath
      );

      writeShadowEvent(
        makeEvent({
          turnId: "turn-002",
          actualModel: "cliproxyapi/gpt-5.5",
          recommendation: {
            outputBudget: "medium",
            qualityFloor: "standard",
            eligibleModels: ["cliproxyapi/gpt-5.5-mini"],
            rejectedModels: [],
            reasonCodes: ["hard_gate_pass"],
            mode: "shadow",
            scoringMode: "cost_first",
            recommendedModel: "cliproxyapi/gpt-5.5-mini",
          },
          estimatedCostDeltaUsd: -0.02,
          qualityGate: "fail",
          scenario: "researchLookup",
        }),
        jsonlPath
      );

      const report = generateShadowReport(jsonlPath);

      expect(report.totalEvents).toBe(2);
      expect(report.uniqueModelsRecommended).toEqual(["cliproxyapi/gpt-5.5-mini"]);
      expect(report.uniqueModelsActual).toEqual(["cliproxyapi/gpt-5.5"]);
      expect(report.ignoredReasonCounts).toEqual({ low_confidence: 1 });
      expect(report.estimatedCostDeltaTotalUsd).toBe(-0.03);
      expect(report.modeCounts).toEqual({ balanced: 1, cost_first: 1 });
      expect(report.scenarioCounts).toEqual({ codingWorker: 1, researchLookup: 1 });
      expect(report.qualityGatePass).toBe(1);
      expect(report.qualityGateFail).toBe(1);
      expect(report.qualityGateUnknown).toBe(0);
      expect(report.timeRange).toEqual({ first: "turn-001", last: "turn-002" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("empty for missing file", () => {
    const nonExistentPath = "/tmp/does-not-exist-shadow-test-12345.jsonl";
    const report = generateShadowReport(nonExistentPath);

    expect(report).toEqual(emptyShadowReport());
  });

  it("skips corrupt lines", () => {
    const tempDir = makeTempDir();
    const jsonlPath = join(tempDir, "shadow.jsonl");

    try {
      writeShadowEvent(makeEvent({ turnId: "turn-001" }), jsonlPath);
      appendFileSync(jsonlPath, "{not valid json}\n");
      writeShadowEvent(makeEvent({ turnId: "turn-003" }), jsonlPath);

      const report = generateShadowReport(jsonlPath);

      expect(report.totalEvents).toBe(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("emptyShadowReport", () => {
  it("returns zero summary", () => {
    const report = emptyShadowReport();

    expect(report.totalEvents).toBe(0);
    expect(report.uniqueModelsRecommended).toEqual([]);
    expect(report.uniqueModelsActual).toEqual([]);
    expect(report.ignoredReasonCounts).toEqual({});
    expect(report.estimatedCostDeltaTotalUsd).toBe(0);
    expect(report.modeCounts).toEqual({});
    expect(report.scenarioCounts).toEqual({});
    expect(report.qualityGatePass).toBe(0);
    expect(report.qualityGateFail).toBe(0);
    expect(report.qualityGateUnknown).toBe(0);
    expect(report.timeRange).toBeUndefined();
  });
});
