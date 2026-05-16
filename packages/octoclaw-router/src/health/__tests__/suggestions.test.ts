import { describe, expect, it } from "vitest";
import { evaluateNativeFallbackSuggestions } from "../suggestions.js";

describe("evaluateNativeFallbackSuggestions", () => {
  it("returns concrete native fallback commands for cooled fallback models", () => {
    expect(evaluateNativeFallbackSuggestions([
      {
        modelKey: "cliproxyapi/gpt-5.5",
        tags: ["fallback#2"],
        health: { cooldown: true, cooldownReason: "rate_limit_429", recentFailureRate: 0.5, sampleCount: 12 },
      },
      {
        modelKey: "zai/glm-4.7",
        tags: [],
        health: { cooldown: true, cooldownReason: "probe_failure" },
      },
    ])).toEqual([
      {
        modelKey: "cliproxyapi/gpt-5.5",
        currentNativePosition: "fallback#2",
        cooldownReason: "rate_limit_429",
        evidence: { recentFailureRate: 0.5, sampleCount: 12 },
        suggestedAction: {
          command: "openclaw models fallbacks remove cliproxyapi/gpt-5.5",
          explanation: "Cooldown observed; consider demoting this fallback while it stabilizes",
        },
      },
    ]);
  });
});
