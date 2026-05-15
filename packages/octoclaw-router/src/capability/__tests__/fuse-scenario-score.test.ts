import { describe, expect, it } from "vitest";

import {
  computeFreshnessFactor,
  computeSourceHealth,
  fuseScenarioScore,
} from "../merge.js";

const NOW = Date.parse("2026-05-15T00:00:00.000Z");

describe("fuseScenarioScore", () => {
  it("fuses fresh healthy sources with weighted average and high confidence", () => {
    const fused = fuseScenarioScore(
      [
        { source: "aider", rawScore: 90, lastVerifiedAt: "2026-05-14T00:00:00.000Z" },
        { source: "pinchbench", rawScore: 80, lastVerifiedAt: "2026-05-14T00:00:00.000Z" },
        { source: "bfcl", rawScore: 70, lastVerifiedAt: "2026-05-14T00:00:00.000Z" },
        { source: "artificial_analysis", rawScore: 60, lastVerifiedAt: "2026-05-14T00:00:00.000Z" },
      ],
      { aider: 0.4, pinchbench: 0.3, bfcl: 0.1, artificial_analysis: 0.2 },
      { aider: 1, pinchbench: 1, bfcl: 1, artificial_analysis: 1 },
      NOW,
    );

    expect(fused.score).toBe(79);
    expect(fused.confidence).toBe("high");
    expect(fused.contributions).toHaveLength(4);
    expect(fused.reasonCodes).toContain("fusion_sources:4");
  });

  it("renormalizes when a stale source is the only available contribution", () => {
    const fused = fuseScenarioScore(
      [{ source: "aider", rawScore: 88, lastVerifiedAt: "2026-02-01T00:00:00.000Z" }],
      { aider: 0.4, pinchbench: 0.3, bfcl: 0.1, artificial_analysis: 0.2 },
      { aider: 1 },
      NOW,
    );

    expect(fused.score).toBe(88);
    expect(fused.confidence).toBe("low");
    expect(fused.contributions[0]).toMatchObject({
      source: "aider",
      freshnessFactor: 0.4,
      effectiveWeight: 0.16000000000000003,
    });
    expect(fused.reasonCodes).toContain("aider_stale_90d");
  });

  it("drops dead sources and reports zero health", () => {
    const fused = fuseScenarioScore(
      [
        { source: "aider", rawScore: 90, lastVerifiedAt: "2026-05-14T00:00:00.000Z" },
        { source: "bfcl", rawScore: 10, lastVerifiedAt: "2026-05-14T00:00:00.000Z" },
      ],
      { aider: 0.4, bfcl: 0.6 },
      { aider: 1, bfcl: 0 },
      NOW,
    );

    expect(fused.score).toBe(90);
    expect(fused.confidence).toBe("medium");
    expect(fused.contributions.find((entry) => entry.source === "bfcl")?.effectiveWeight).toBe(0);
    expect(fused.reasonCodes).toContain("bfcl_health_zero");
  });

  it("returns unknown confidence when no usable contributions exist", () => {
    const fused = fuseScenarioScore([], { aider: 1 }, {}, NOW);

    expect(fused).toMatchObject({
      score: 0,
      confidence: "unknown",
      contributions: [],
      reasonCodes: ["no_contributions"],
    });
  });
});

describe("freshness and source health helpers", () => {
  it("computes supplement freshness factors", () => {
    expect(computeFreshnessFactor("2026-05-14T00:00:00.000Z", NOW)).toBe(1);
    expect(computeFreshnessFactor("2026-04-01T00:00:00.000Z", NOW)).toBe(0.7);
    expect(computeFreshnessFactor("2026-02-01T00:00:00.000Z", NOW)).toBe(0.4);
    expect(computeFreshnessFactor("2025-01-01T00:00:00.000Z", NOW)).toBe(0.15);
  });

  it("computes source health from the last four outcomes", () => {
    expect(computeSourceHealth([true, true, true, true])).toBe(1);
    expect(computeSourceHealth([true, false, true, true])).toBe(0.75);
    expect(computeSourceHealth([false, false, false, true])).toBe(0.25);
    expect(computeSourceHealth([true, true, true, true, false])).toBe(0.75);
    expect(computeSourceHealth([])).toBe(0);
  });
});
