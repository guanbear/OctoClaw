import { describe, expect, it } from "vitest";
import { analyzeModelConfig } from "../config-analyze.js";
import { buildModelIntelSnapshot } from "../model-intel.js";

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
});
