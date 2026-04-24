import { describe, expect, it } from "vitest";
import {
  createAckTemplateRegistry,
  getAllAckTemplatesForStage,
  type AckTemplateRegistry,
  type AckTemplateStage,
} from "./ack-template-registry.js";

function baseInput(overrides: Partial<Parameters<AckTemplateRegistry["selectTemplate"]>[0]> = {}) {
  return {
    stage: "ack0" as AckTemplateStage,
    channel: "chat" as const,
    tone: "neutral" as const,
    taskClass: "unknown" as const,
    modality: "text" as const,
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
    const first = registry.selectTemplate(baseInput({ taskClass: "lookup", turnId: "turn-1" }));
    const second = Array.from({ length: 8 }, (_, index) => `turn-${index + 2}`)
      .map((turnId) => registry.selectTemplate(baseInput({ taskClass: "lookup", turnId })))
      .find((template) => template.key !== first.key) ?? first;

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
    const input = baseInput({ taskClass: "lookup" });
    const first = registry.selectTemplate(input);
    const second = registry.selectTemplate(baseInput({ taskClass: "lookup", recentKeys: [first.key] }));

    expect(second.key).not.toBe(first.key);
  });

  it("falls back to neutral unknown templates when specific channel and tone are absent", () => {
    const registry = createAckTemplateRegistry();
    const selected = registry.selectTemplate(baseInput({ channel: "work", tone: "warm" }));

    expect(selected.stage).toBe("ack0");
    expect(selected.channel).toBe("unknown");
    expect(selected.tone).toBe("neutral");
  });

  it("respects taskClass and modality during selection", () => {
    const registry = createAckTemplateRegistry();
    const codingText = registry.selectTemplate(baseInput({ taskClass: "coding", modality: "text" }));
    const reaction = registry.selectTemplate(baseInput({ taskClass: "unknown", modality: "reaction" }));

    expect(codingText.taskClass).toBe("coding");
    expect(codingText.modality).toBe("text");
    expect(reaction.taskClass).toBe("unknown");
    expect(reaction.modality).toBe("reaction");
  });

  it("keeps ACK0 text short and conservative", () => {
    const completionWords = ["完成", "已派发", "已查到", "已处理完"];
    const textTemplates = getAllAckTemplatesForStage("ack0").filter((template) => template.modality === "text");

    expect(textTemplates.length).toBeGreaterThanOrEqual(8);
    for (const template of textTemplates) {
      expect([...template.text].length).toBeLessThanOrEqual(15);
      for (const word of completionWords) {
        expect(template.text.includes(word)).toBe(false);
      }
    }
  });

  it("falls back through new dimensions when exact templates are absent", () => {
    const registry = createAckTemplateRegistry();
    const selected = registry.selectTemplate(baseInput({
      channel: "cli",
      tone: "warm",
      taskClass: "long_running",
      modality: "unknown",
    }));

    expect(selected.stage).toBe("ack0");
    expect(selected.channel).toBe("unknown");
    expect(selected.tone).toBe("neutral");
  });

  it("includes reaction modality templates", () => {
    const reactionTemplates = getAllAckTemplatesForStage("ack0").filter((template) => template.modality === "reaction");

    expect(reactionTemplates.length).toBeGreaterThan(0);
    expect(reactionTemplates.every((template) => template.text === "")).toBe(true);
  });

  it("never returns empty text for text modality requests even in fallback", () => {
    const registry = createAckTemplateRegistry();
    const channels: Array<"chat" | "work" | "cli" | "unknown"> = ["chat", "work", "cli", "unknown"];
    const taskClasses: Array<"lookup" | "coding" | "review" | "writing" | "status" | "long_running" | "unknown"> = [
      "lookup", "coding", "review", "writing", "status", "long_running", "unknown",
    ];

    for (const channel of channels) {
      for (const taskClass of taskClasses) {
        const selected = registry.selectTemplate(baseInput({ channel, taskClass, modality: "text" }));
        expect(selected.text.length).toBeGreaterThan(0);
      }
    }
  });

  it("never returns empty text for text modality requests across tiers", () => {
    const registry = createAckTemplateRegistry();
    const stages: Array<AckTemplateStage> = ["ack0", "tier1", "tier2", "tier3"];

    for (const stage of stages) {
      const selected = registry.selectTemplate(baseInput({ stage, modality: "text" }));
      expect(selected.text.length).toBeGreaterThan(0);
    }
  });
});
