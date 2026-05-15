import { describe, expect, it } from "vitest";

import { parseAiderLeaderboard } from "../leaderboard/aider.js";

const fixture = `
results:
  - model: openai/gpt-5.5
    pass_rate_2: 92.4
    exercises: 133
    date: "2026-05-14T00:00:00.000Z"
  - model: z-ai/glm-4.7
    pass_rate_2: 71.5
    exercises: 91
    date: "2026-05-13T00:00:00.000Z"
`;

describe("parseAiderLeaderboard", () => {
  it("parses Aider YAML into coding_worker records", () => {
    const records = parseAiderLeaderboard(fixture);

    expect(records).toEqual([
      {
        source: "aider",
        modelKey: "openai/gpt-5.5",
        scenario: "coding_worker",
        rawScore: 92.4,
        sampleCount: 133,
        lastVerifiedAt: "2026-05-14T00:00:00.000Z",
      },
      {
        source: "aider",
        modelKey: "zhipu/glm-4.7",
        scenario: "coding_worker",
        rawScore: 71.5,
        sampleCount: 91,
        lastVerifiedAt: "2026-05-13T00:00:00.000Z",
      },
    ]);
  });

  it("returns an empty array for schema mismatch", () => {
    expect(parseAiderLeaderboard("not: [the expected schema")).toEqual([]);
    expect(parseAiderLeaderboard("items:\n  - nope: true")).toEqual([]);
  });
});
