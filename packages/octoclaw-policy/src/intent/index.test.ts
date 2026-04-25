import { describe, expect, it } from "vitest";
import { buildIntentPacket } from "./index.js";

describe("intent packet", () => {
  it("uses confidence 1 for explicit intent class", () => {
    expect(buildIntentPacket({ intentClass: "delegated_work" })).toEqual({
      intentClass: "delegated_work",
      confidence: 1,
      evidence: ["explicit_intent_class"],
    });
  });

  it("maps surface bound hints to local surface lookup", () => {
    expect(buildIntentPacket({ surfaceBound: true })).toEqual({
      intentClass: "local_surface_lookup",
      confidence: 0.9,
      evidence: ["surface_bound"],
    });
  });

  it("returns undetermined without hints", () => {
    expect(buildIntentPacket()).toEqual({
      intentClass: "undetermined",
      confidence: 0.3,
      evidence: ["no_structured_intent_signal"],
    });
  });
});

describe("Phase B acceptance: intent classification", () => {
  it('"在吗" classifies as plain_chat', () => {
    expect(buildIntentPacket({ intentClass: "plain_chat" }).intentClass).toBe("plain_chat");
  });

  it('"帮我查一下刚才那个任务" classifies as execution_followup', () => {
    expect(buildIntentPacket({ executionFollowup: true }).intentClass).toBe("execution_followup");
  });

  it('"implement this feature" classifies as delegated_work', () => {
    expect(buildIntentPacket({ delegatedWork: true }).intentClass).toBe("delegated_work");
  });
});
