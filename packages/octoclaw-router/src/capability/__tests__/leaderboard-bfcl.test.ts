import { describe, expect, it } from "vitest";

import { parseBfclLeaderboard } from "../leaderboard/bfcl.js";

const fixture = JSON.stringify({
  leaderboard: [
    {
      model: "openai/gpt-5.5",
      overall_accuracy: 0.91,
      sample_count: 800,
      last_updated: "2026-05-14T00:00:00.000Z",
    },
    {
      model: "z-ai/glm-5.1",
      overall_accuracy: 0.79,
      sample_count: 600,
      last_updated: "2026-05-13T00:00:00.000Z",
    },
  ],
});

describe("parseBfclLeaderboard", () => {
  it("parses BFCL JSON into agentic records", () => {
    const records = parseBfclLeaderboard(fixture);

    expect(records).toEqual([
      {
        source: "bfcl",
        modelKey: "openai/gpt-5.5",
        scenario: "agentic",
        rawScore: 91,
        sampleCount: 800,
        lastVerifiedAt: "2026-05-14T00:00:00.000Z",
      },
      {
        source: "bfcl",
        modelKey: "zhipu/glm-5.1",
        scenario: "agentic",
        rawScore: 79,
        sampleCount: 600,
        lastVerifiedAt: "2026-05-13T00:00:00.000Z",
      },
    ]);
  });

  it("returns an empty array for schema mismatch", () => {
    expect(parseBfclLeaderboard("{")).toEqual([]);
    expect(parseBfclLeaderboard(JSON.stringify({ rows: [{ nope: true }] }))).toEqual([]);
  });
});
