import { describe, expect, it } from "vitest";

import { hasProjectionFooter, stripProjectionFooterFromText } from "./projection-footer-sanitizer.js";
import { normalizeInboundPrompt } from "./resolve/session.js";
import { extractPromptText } from "./extension-entry-helpers.js";

describe("projection footer sanitizer", () => {
  it("strips visible OctoClaw projection footer lines from inbound text", () => {
    expect(stripProjectionFooterFromText([
      "那你到底派发成功了吗",
      "",
      "• octoclaw: route=reply | model=zhipu/GLM-5.1 · thread | via=judge | wc=wc-12345",
    ].join("\n"))).toBe("那你到底派发成功了吗");
  });

  it("keeps compatibility with old unmarked compact footer lines", () => {
    expect(stripProjectionFooterFromText("继续\nroute=delegate | model=direct_main · thread | wc=wc-abc")).toBe("继续");
    expect(hasProjectionFooter("继续\n• route=reply | model=direct_main")).toBe(true);
  });

  it("does not strip route text inside normal user prose", () => {
    const text = "帮我解释 route=reply | model=direct_main 这一行是什么意思";
    expect(stripProjectionFooterFromText(text)).toBe(text);
  });

  it("normalizes current prompts without carrying footer back into routing", () => {
    const prompt = normalizeInboundPrompt("再试下\n\n• octoclaw: route=reply | model=GLM-5.1 · thread");
    expect(prompt).toBe("再试下");
  });

  it("sanitizes latest user message extraction for OctoClaw policy paths", () => {
    const prompt = extractPromptText({
      messages: [
        { role: "assistant", content: "上一轮回复\n\n• octoclaw: route=reply | model=GLM-5.1" },
        { role: "user", content: "现在呢\n\n• octoclaw: route=reply | model=GLM-5.1 · thread" },
      ],
    });
    expect(prompt).toBe("现在呢");
  });
});
