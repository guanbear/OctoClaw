import { describe, expect, it } from "vitest";
import { buildDirectReply, buildDirectReplyContext } from "./index.js";

describe("fast reply direct", () => {
  it("produces minimal context output for direct reply flow", () => {
    const context = buildDirectReplyContext({
      userText: "  summarize this  ",
      sessionSummary: "  prior context  ",
      route: " reply ",
      requestKind: " qa ",
      directToolsSeen: [" read ", "", " grep "],
    });

    expect(context).toEqual({
      userText: "summarize this",
      sessionSummary: "prior context",
      route: "reply",
      requestKind: "qa",
      directToolsSeen: ["read", "grep"],
    });
  });

  it("keeps reply lane isolated from delegation runtime fields", () => {
    const context = buildDirectReplyContext({ userText: "answer now", route: "reply" });
    const reply = buildDirectReply(context, "Done", { routeDecisionStartedAt: 10, replyCompletedAt: 25 });

    expect(reply).toEqual({
      replyText: "Done",
      handoff: {
        kind: "reply",
        user_safe: true,
        reply_text: "Done",
        summary: "Done",
      },
      metrics: {
        total_latency_ms: 15,
      },
    });
    expect(Object.keys(reply.handoff)).not.toContain("taskId");
    expect(Object.keys(reply.handoff)).not.toContain("flowId");
    expect(Object.keys(reply.handoff)).not.toContain("runtime");
  });
});
