import { describe, expect, it } from "vitest";

import type { ModelIntelLite } from "../../decision/contracts.js";
import {
  applyWizardModelFilters,
  createWizardConfig,
  detectPlanType,
  mergeIncrementalWizardConfig,
  parseBudgetInput,
} from "../../wizard/index.js";

function model(modelKey: string, provider: string): Pick<ModelIntelLite, "modelKey" | "provider"> {
  return { modelKey, provider };
}

describe("wizard RT-W-001..007", () => {
  it("RT-W-001 creates a first-run wizard config for configured models", () => {
    const config = createWizardConfig(["openai/gpt-5.5", "zhipu/glm-5.1", "ollama/qwen"], {
      now: "2026-05-13T00:00:00.000Z",
    });

    expect(config.schemaVersion).toBe("octoclaw.router_wizard/v1");
    expect(Object.keys(config.models)).toHaveLength(3);
    expect(config.completedAt).toBe("2026-05-13T00:00:00.000Z");
  });

  it("RT-W-002 detects likely plan models while allowing override storage", () => {
    expect(detectPlanType("openai/codex-chat-2024-12")).toBe("subscription");
    expect(detectPlanType("openrouter/deepseek-v4")).toBe("pay_as_you_go");
  });

  it("RT-W-003 can discover same-provider models into wizard state", () => {
    const config = createWizardConfig(["openai/gpt-5.5"], { now: "2026-05-13T00:00:00.000Z" });
    const merged = mergeIncrementalWizardConfig(config, ["openai/gpt-5.5", "openai/gpt-5-mini", "openai/gpt-5-nano"], "2026-05-14T00:00:00.000Z");

    expect(merged.newModels).toEqual(["openai/gpt-5-mini", "openai/gpt-5-nano"]);
    expect(Object.keys(merged.config.models)).toContain("openai/gpt-5-mini");
  });

  it("RT-W-004 validates and normalizes budget input", () => {
    expect(parseBudgetInput("100")).toEqual({ monthly: 100, currency: "USD" });
    expect(parseBudgetInput("100.50")).toEqual({ monthly: 100.50, currency: "USD" });
    expect(parseBudgetInput("$100")).toEqual({ monthly: 100, currency: "USD" });
    expect(parseBudgetInput("100 USD")).toEqual({ monthly: 100, currency: "USD" });
    expect(() => parseBudgetInput("abc")).toThrow("Invalid budget");
  });

  it("RT-W-005 incremental mode only asks for new models and preserves prior answers", () => {
    const existing = createWizardConfig(["openai/gpt-5.5", "zhipu/glm-5.1", "ollama/qwen"], {
      budgetInput: "100",
      restrictedModels: ["anthropic/claude-opus-4"],
    });

    const result = mergeIncrementalWizardConfig(existing, ["openai/gpt-5.5", "zhipu/glm-5.1", "ollama/qwen", "mistral/medium-3"]);

    expect(result.newModels).toEqual(["mistral/medium-3"]);
    expect(result.config.budget).toEqual({ monthly: 100, currency: "USD" });
    expect(result.config.restrictedModels).toEqual(["anthropic/claude-opus-4"]);
  });

  it("RT-W-006 filters restricted models before recommendation", () => {
    const result = applyWizardModelFilters([
      model("anthropic/claude-opus-4", "anthropic"),
      model("openai/gpt-5.5", "openai"),
    ], { restrictedModels: ["anthropic/claude-opus-4"], privacy: "standard" });

    expect(result.models.map((entry) => entry.modelKey)).toEqual(["openai/gpt-5.5"]);
    expect(result.rejectedModels).toContainEqual({ model: "anthropic/claude-opus-4", reason: "user_restricted" });
  });

  it("RT-W-007 local-only privacy filters cloud models", () => {
    const result = applyWizardModelFilters([
      model("openai/gpt-5.5", "openai"),
      model("ollama/qwen3", "ollama"),
    ], { restrictedModels: [], privacy: "local_only" });

    expect(result.models.map((entry) => entry.modelKey)).toEqual(["ollama/qwen3"]);
    expect(result.rejectedModels).toContainEqual({ model: "openai/gpt-5.5", reason: "privacy_local_only" });
  });
});
