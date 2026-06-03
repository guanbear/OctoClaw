import { describe, expect, it } from "vitest";

import {
  normalizeInboundPrompt,
  promptLookupCandidates,
  promptsEquivalent,
  unwrapQueuedBusyPrompt,
} from "./session.js";

const OPENCLAW_QUEUED_USER_MESSAGE_MARKER =
  "[Queued user message that arrived while the previous turn was still active]";

describe("queued prompt normalization", () => {
  it("treats OpenClaw transcript-repair queued marker as prior context and keeps newest prompt current", () => {
    const prompt = [
      OPENCLAW_QUEUED_USER_MESSAGE_MARKER,
      "帮我 review 当前 OctoClaw 工作区改动，重点看运行时路由和子任务委派有没有回归风险",
      "",
      "今天北京的天气怎样",
    ].join("\n");

    expect(unwrapQueuedBusyPrompt(prompt)).toBe("今天北京的天气怎样");
    expect(normalizeInboundPrompt(prompt)).toBe("今天北京的天气怎样");
    expect(promptLookupCandidates(prompt).slice(0, 2)).toEqual([
      "今天北京的天气怎样",
      "帮我 review 当前 octoclaw 工作区改动，重点看运行时路由和子任务委派有没有回归风险",
    ]);
    expect(promptsEquivalent("今天北京的天气怎样", prompt)).toBe(true);
    expect(promptsEquivalent(
      "帮我 review 当前 OctoClaw 工作区改动，重点看运行时路由和子任务委派有没有回归风险",
      prompt,
    )).toBe(true);
  });
});
