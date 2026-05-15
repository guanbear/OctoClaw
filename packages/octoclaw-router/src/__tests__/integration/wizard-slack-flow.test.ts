import { describe, expect, it } from "vitest";

import { createWizardConfig } from "../../wizard/index.js";

describe("wizard Slack flow router isolation", () => {
  it("keeps Slack wizard answers in router preferences without marking proposals live", () => {
    const config = createWizardConfig(["openai/gpt-5.5"], {
      now: "2026-05-15T00:00:00.000Z",
      sameProviderModels: ["openai/gpt-5-mini"],
      modelPlanTypes: {
        "openai/gpt-5.5": "subscription",
        "openai/gpt-5-mini": "pay_as_you_go",
      },
    });

    expect(config.models["openai/gpt-5.5"]).toMatchObject({
      source: "configured",
      planType: "subscription",
    });
    expect(config.models["openai/gpt-5-mini"]).toMatchObject({
      source: "same_provider_discovery",
      planType: "pay_as_you_go",
    });
    expect(config.models["openai/gpt-5-mini"]?.state).not.toBe("live_candidate");
  });
});
