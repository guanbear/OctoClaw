import { describe, expect, it } from "vitest";
import {
  createAckTemplateRegistry,
  getAllAckTemplatesForStage,
  type AckTemplateRegistry,
  type AckTemplateStage,
  type AckTemplateEntry,
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

  it("handles semanticKey filtering when no semantic-keyed templates exist", () => {
    const registry = createAckTemplateRegistry();
    const selected = registry.selectTemplate(baseInput({ semanticKey: "intent.lookup.docs" }));

    expect(selected.stage).toBe("ack0");
    expect(selected.modality).toBe("text");
    expect(selected.text.length).toBeGreaterThan(0);
  });

  it("has at least two ACK0 text templates for every taskClass", () => {
    const taskClasses: Array<"lookup" | "coding" | "review" | "writing" | "status" | "long_running" | "unknown"> = [
      "lookup", "coding", "review", "writing", "status", "long_running", "unknown",
    ];
    const textTemplates = getAllAckTemplatesForStage("ack0").filter((template) => template.channel === "chat" && template.modality === "text");

    for (const taskClass of taskClasses) {
      expect(textTemplates.filter((template) => template.taskClass === taskClass).length).toBeGreaterThanOrEqual(2);
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

  it("falls back to unkeyed templates when semanticKey has no exact match", () => {
    const custom: AckTemplateEntry[] = [
      { key: "custom-a", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "lookup", modality: "text", semanticKey: "intent.lookup.docs", text: "收到，查资料。" },
      { key: "custom-b", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "lookup", modality: "text", semanticKey: "intent.lookup.code", text: "收到，查代码。" },
      { key: "custom-fallback", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "lookup", modality: "text", text: "收到，在看。" },
      { key: "custom-reaction", stage: "ack0", channel: "chat", tone: "neutral", taskClass: "unknown", modality: "reaction", text: "" },
    ];
    const registry = createAckTemplateRegistry(custom);

    const withUnknownKey = registry.selectTemplate(baseInput({ taskClass: "lookup", semanticKey: "intent.lookup.missing" }));
    expect(withUnknownKey.key).toBe("custom-fallback");
    expect(withUnknownKey.semanticKey).toBeUndefined();

    const withExactKey = registry.selectTemplate(baseInput({ taskClass: "lookup", semanticKey: "intent.lookup.docs" }));
    expect(withExactKey.key).toBe("custom-a");
  });
});
