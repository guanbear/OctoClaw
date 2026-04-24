import { describe, expect, it } from "vitest";
import {
  createAckTemplateRegistry,
  type AckTemplateRegistry,
  type AckTemplateStage,
} from "./ack-template-registry.js";

function baseInput(overrides: Partial<Parameters<AckTemplateRegistry["selectTemplate"]>[0]> = {}) {
  return {
    stage: "ack0" as AckTemplateStage,
    channel: "chat" as const,
    tone: "neutral" as const,
    threadBindingKey: "slack:channel:C123",
    turnId: "turn-1",
    recentKeys: [],
    ...overrides,
  };
}

describe("ack-template-registry", () => {
  it("returns the same template for identical input", () => {
    const registry = createAckTemplateRegistry();
    const input = baseInput();

    expect(registry.selectTemplate(input)).toEqual(registry.selectTemplate(input));
  });

  it("usually returns a different template for a different turnId", () => {
    const registry = createAckTemplateRegistry();
    const first = registry.selectTemplate(baseInput({ turnId: "turn-1" }));
    const second = registry.selectTemplate(baseInput({ turnId: "turn-3" }));

    expect(second.key).not.toBe(first.key);
  });

  it("keeps stage scoping separate", () => {
    const registry = createAckTemplateRegistry();
    const tier1 = registry.selectTemplate(baseInput({ stage: "tier1" }));

    expect(tier1.stage).toBe("tier1");
    expect(tier1.key.startsWith("ack0-")).toBe(false);
  });

  it("avoids recently used templates when another candidate is available", () => {
    const registry = createAckTemplateRegistry();
    const input = baseInput();
    const first = registry.selectTemplate(input);
    const second = registry.selectTemplate(baseInput({ recentKeys: [first.key] }));

    expect(second.key).not.toBe(first.key);
  });

  it("falls back to neutral unknown templates when specific channel and tone are absent", () => {
    const registry = createAckTemplateRegistry();
    const selected = registry.selectTemplate(baseInput({ channel: "work", tone: "warm" }));

    expect(selected.stage).toBe("ack0");
    expect(selected.channel).toBe("unknown");
    expect(selected.tone).toBe("neutral");
  });
});
