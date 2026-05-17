import { describe, expect, it } from "vitest";

import {
  applyWizardAction,
  createRouterWizardState,
  handleWizardIdle,
  resetWizardStep,
} from "../flow.js";
import { decodeWizardButtonId, encodeWizardButtonId } from "../buttons.js";
import { renderWizardMessage } from "../messages.js";

const SECRET = "test-secret";
const START = "2026-05-15T00:00:00.000Z";

describe("Slack router wizard flow", () => {
  it("walks the 7-step happy path and records answers without secrets", () => {
    let state = createRouterWizardState({
      models: ["openai/gpt-5.5", "openai/gpt-5-mini"],
      sameProviderCandidates: ["openai/gpt-5-nano"],
      now: START,
      thread: { channel: "C123", ts: "1700000000.000100" },
    });

    expect(renderWizardMessage(state, { lang: "zh" }).text).toContain("OctoClaw 配置向导");

    for (const [step, value, now] of [
      [1, "start", "2026-05-15T00:00:01.000Z"],
      [2, "subscription", "2026-05-15T00:00:02.000Z"],
      [2, "pay_as_you_go", "2026-05-15T00:00:03.000Z"],
      [3, "100-500", "2026-05-15T00:00:04.000Z"],
      [4, "cloud_ok", "2026-05-15T00:00:05.000Z"],
      [6, "all", "2026-05-15T00:00:06.000Z"],
    ] as const) {
      const decoded = decodeWizardButtonId(encodeWizardButtonId(step, value, SECRET), { secret: SECRET });
      expect(decoded.ok).toBe(true);
      const result = applyWizardAction(state, decoded.ok ? decoded.action : { step, value }, { now });
      expect(result.kind).not.toBe("invalid");
      state = result.state;
    }

    expect(state.step).toBe("step-7-done");
    expect(state.completedAt).toBe("2026-05-15T00:00:06.000Z");
    expect(state.answers.models).toMatchObject({
      "openai/gpt-5.5": { planType: "subscription" },
      "openai/gpt-5-mini": { planType: "pay_as_you_go" },
    });
    expect(state.answers.budget).toEqual({ range: "100-500", monthlyUsd: 100 });
    expect(state.answers.privacy).toBe("standard");
    expect(state.answers.sameProviderCandidates).toEqual(["openai/gpt-5-nano"]);

    const rendered = renderWizardMessage(state, { lang: "zh" });
    expect(rendered.text).toContain("配置完成");
    expect(JSON.stringify(rendered)).not.toContain("xoxb-");
    expect(JSON.stringify(rendered)).not.toContain("Authorization");
  });

  it("can resume from step 4 and route privacy pick into restricted-model selection", () => {
    let state = createRouterWizardState({
      models: ["openai/gpt-5.5", "zhipu/glm-5.1"],
      now: START,
    });
    for (const [step, value, now] of [
      [1, "start", "2026-05-15T00:00:01.000Z"],
      [2, "subscription", "2026-05-15T00:00:02.000Z"],
      [2, "subscription", "2026-05-15T00:00:03.000Z"],
      [3, "skip", "2026-05-15T00:00:04.000Z"],
    ] as const) {
      state = applyWizardAction(state, { step, value }, { now }).state;
    }

    expect(state.step).toBe("step-4-privacy");
    const picked = applyWizardAction(state, { step: 4, value: "pick" }, { now: "2026-05-15T00:00:05.000Z" });
    expect(picked.state.step).toBe("step-5-restricted-models");
    expect(renderWizardMessage(picked.state, { lang: "en" }).text).toContain("Which models must be disabled");
  });

  it("lets users add a single same-provider candidate from Slack buttons", () => {
    let state = createRouterWizardState({
      models: ["cliproxyapi/gpt-5.5"],
      sameProviderCandidates: ["cliproxyapi/gpt-5-mini", "cliproxyapi/gpt-5.4-mini"],
      now: START,
    });
    for (const [step, value, now] of [
      [1, "start", "2026-05-15T00:00:01.000Z"],
      [2, "pay_as_you_go", "2026-05-15T00:00:02.000Z"],
      [3, "skip", "2026-05-15T00:00:03.000Z"],
      [4, "cloud_ok", "2026-05-15T00:00:04.000Z"],
    ] as const) {
      state = applyWizardAction(state, { step, value }, { now }).state;
    }

    const message = renderWizardMessage(state, { lang: "zh" });
    expect(JSON.stringify(message.blocks)).toContain("only%3Acliproxyapi%2Fgpt-5-mini");

    const result = applyWizardAction(state, { step: 6, value: "only:cliproxyapi/gpt-5-mini" }, { now: "2026-05-15T00:00:05.000Z" });

    expect(result.state.step).toBe("step-7-done");
    expect(result.state.answers.sameProviderCandidates).toEqual(["cliproxyapi/gpt-5-mini"]);
  });

  it("shows per-model plan progress and can apply one plan to remaining models", () => {
    let state = createRouterWizardState({
      models: ["cliproxyapi/gpt-5.5", "cliproxyapi/gpt-5.4-mini"],
      now: START,
    });
    state = applyWizardAction(state, { step: 1, value: "start" }, { now: "2026-05-15T00:00:01.000Z" }).state;

    const message = renderWizardMessage(state, { lang: "zh" });
    expect(message.text).toContain("1/2");
    expect(JSON.stringify(message.blocks)).toContain("all_remaining%3Apay_as_you_go");

    const result = applyWizardAction(state, { step: 2, value: "all_remaining:pay_as_you_go" }, { now: "2026-05-15T00:00:02.000Z" });

    expect(result.state.step).toBe("step-3-budget");
    expect(result.state.remainingModels).toEqual([]);
    expect(result.state.answers.models).toEqual({
      "cliproxyapi/gpt-5.5": { planType: "pay_as_you_go" },
      "cliproxyapi/gpt-5.4-mini": { planType: "pay_as_you_go" },
    });
  });

  it("lets users select restricted models with Slack buttons before continuing", () => {
    let state = createRouterWizardState({
      models: ["cliproxyapi/gpt-5.5", "zhipu/GLM-5.1", "zai/glm-4.7"],
      now: START,
    });
    for (const [step, value, now] of [
      [1, "start", "2026-05-15T00:00:01.000Z"],
      [2, "pay_as_you_go", "2026-05-15T00:00:02.000Z"],
      [2, "subscription", "2026-05-15T00:00:03.000Z"],
      [2, "subscription", "2026-05-15T00:00:04.000Z"],
      [3, "skip", "2026-05-15T00:00:05.000Z"],
      [4, "pick", "2026-05-15T00:00:06.000Z"],
    ] as const) {
      state = applyWizardAction(state, { step, value }, { now }).state;
    }

    const initialMessage = renderWizardMessage(state, { lang: "zh" });
    expect(JSON.stringify(initialMessage.blocks)).toContain("toggle%3Azhipu%2FGLM-5.1");

    state = applyWizardAction(state, { step: 5, value: "toggle:zhipu/GLM-5.1" }, { now: "2026-05-15T00:00:07.000Z" }).state;
    expect(state.step).toBe("step-5-restricted-models");
    expect(state.answers.restrictedModels).toEqual(["zhipu/GLM-5.1"]);

    const selectedMessage = renderWizardMessage(state, { lang: "zh" });
    expect(selectedMessage.text).toContain("zhipu/GLM-5.1");
    expect(JSON.stringify(selectedMessage.blocks)).toContain("done");

    const done = applyWizardAction(state, { step: 5, value: "done" }, { now: "2026-05-15T00:00:08.000Z" });
    expect(done.state.step).toBe("step-6-same-provider");
    expect(done.state.answers.restrictedModels).toEqual(["zhipu/GLM-5.1"]);
  });

  it("drops duplicate clicks within 30 seconds and reports out-of-order clicks", () => {
    const initial = createRouterWizardState({ models: ["openai/gpt-5.5"], now: START });
    const started = applyWizardAction(initial, { step: 1, value: "start" }, { now: "2026-05-15T00:00:01.000Z" }).state;

    const duplicate = applyWizardAction(started, { step: 1, value: "start" }, { now: "2026-05-15T00:00:20.000Z" });
    expect(duplicate.kind).toBe("duplicate");
    expect(duplicate.messages).toEqual([]);
    expect(duplicate.state).toEqual(started);

    const outOfOrder = applyWizardAction(started, { step: 1, value: "start" }, { now: "2026-05-15T00:01:00.000Z" });
    expect(outOfOrder.kind).toBe("out_of_order");
    expect(outOfOrder.messages[0]?.text).toContain("这一步已经回答过");
  });

  it("nudges once after 24 hours and finalizes defaults after 7 days", () => {
    const state = createRouterWizardState({ models: ["openai/gpt-5.5"], now: START });

    const nudged = handleWizardIdle(state, { now: "2026-05-16T00:01:00.000Z" });
    expect(nudged.kind).toBe("nudge");
    expect(nudged.messages[0]?.text).toContain("向导还没完成");

    const secondNudge = handleWizardIdle(nudged.state, { now: "2026-05-16T00:02:00.000Z" });
    expect(secondNudge.kind).toBe("noop");
    expect(secondNudge.messages).toEqual([]);

    const finalized = handleWizardIdle(nudged.state, { now: "2026-05-22T00:00:01.000Z" });
    expect(finalized.kind).toBe("finalized");
    expect(finalized.state.step).toBe("step-7-done");
    expect(finalized.state.completedAt).toBe("2026-05-22T00:00:01.000Z");
    expect(finalized.state.answers.models["openai/gpt-5.5"]?.planType).toBe("unknown");
  });

  it("resets an answered step and resumes from that step", () => {
    let state = createRouterWizardState({ models: ["openai/gpt-5.5"], now: START });
    for (const [step, value, now] of [
      [1, "start", "2026-05-15T00:00:01.000Z"],
      [2, "subscription", "2026-05-15T00:00:02.000Z"],
      [3, "20-100", "2026-05-15T00:00:03.000Z"],
    ] as const) {
      state = applyWizardAction(state, { step, value }, { now }).state;
    }

    const reset = resetWizardStep(state, "step-2-models", { now: "2026-05-15T00:00:04.000Z" });
    expect(reset.state.step).toBe("step-2-models");
    expect(reset.state.remainingModels).toEqual(["openai/gpt-5.5"]);
    expect(reset.state.answers.models).toEqual({});
  });
});
