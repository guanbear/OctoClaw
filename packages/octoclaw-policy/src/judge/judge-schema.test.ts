import { describe, expect, it } from "vitest";

import {
  ESCALATION_DEFAULTS,
  REMOTE_JUDGE_DEFAULTS,
  isRemoteJudgeOutput,
} from "./judge-schema.js";

describe("judge schema", () => {
  it("accepts valid remote judge output", () => {
    expect(isRemoteJudgeOutput({
      route: "delegate",
      confidence: 0.82,
      abstainReason: null,
      ackText: "这就处理",
      override_recommendation: "accept_local",
      adjudication_reason: "local result is consistent",
      confidence_delta: 0.05,
    })).toBe(true);
  });

  it("rejects invalid remote judge output when base judge fields are invalid", () => {
    expect(isRemoteJudgeOutput({
      route: "bad-route",
      confidence: 2,
    })).toBe(false);
  });

  it("rejects invalid override recommendation", () => {
    expect(isRemoteJudgeOutput({
      route: "delegate",
      confidence: 0.82,
      abstainReason: null,
      ackText: "这就处理",
      override_recommendation: "maybe_override",
    })).toBe(false);
  });

  it("rejects non-number confidence delta", () => {
    expect(isRemoteJudgeOutput({
      route: "delegate",
      confidence: 0.82,
      abstainReason: null,
      ackText: "这就处理",
      confidence_delta: "0.1",
    })).toBe(false);
  });

  it("accepts base judge output without remote specific fields", () => {
    expect(isRemoteJudgeOutput({
      route: "reply",
      confidence: 0.74,
      abstainReason: null,
      ackText: "我来回答",
    })).toBe(true);
  });

  it("exposes dual judge defaults", () => {
    expect(REMOTE_JUDGE_DEFAULTS).toMatchObject({
      enabled: false,
      timeoutMs: 8000,
      shadowMode: true,
    });
    expect(ESCALATION_DEFAULTS).toMatchObject({
      minConfidence: 0.6,
      maxLatencyMs: 4000,
    });
  });
});
