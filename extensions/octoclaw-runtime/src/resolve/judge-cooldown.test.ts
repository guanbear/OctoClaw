import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callLlmJudge, lastJudgeFailureClass } from "./llm-judge.js";
import {
  isJudgeInCooldown,
  recordJudgeFailure,
  resetCooldownForTests,
  setMockNowForTests,
} from "./judge-cooldown.js";
import type { JudgeFastConfig, JudgeInput } from "./llm-judge.js";

const judgeConfig: JudgeFastConfig = {
  enabled: true,
  shadowMode: false,
  modelId: "cooldown-test-judge",
  baseUrl: "http://localhost:19999/v1",
  apiKey: "test-key",
  timeoutMs: 1500,
  timeoutLocalMs: 800,
  minConfidence: 0.6,
  local: true,
  judgeAckEnabled: true,
};

const judgeInput: JudgeInput = {
  userMessage: "Should this be delegated?",
  sessionBinding: "session-1",
  recentLedgerSummary: "No recent work",
  availableTargets: ["current_session", "local_probe", "spawn_work"],
  availableActions: ["answer_direct", "local_probe", "spawn_work"],
};

function validJudgeResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            route: "reply",
            confidence: 0.9,
            complexity: "simple",
          }),
        },
      }],
    }),
  } as Response;
}

describe("judge cooldown", () => {
  const originalDisableHealthGates = process.env.OCTOCLAW_DISABLE_HEALTH_GATES;

  beforeEach(() => {
    resetCooldownForTests();
    setMockNowForTests(null);
    delete process.env.OCTOCLAW_DISABLE_HEALTH_GATES;
  });

  afterEach(() => {
    if (originalDisableHealthGates === undefined) {
      delete process.env.OCTOCLAW_DISABLE_HEALTH_GATES;
    } else {
      process.env.OCTOCLAW_DISABLE_HEALTH_GATES = originalDisableHealthGates;
    }
    setMockNowForTests(null);
    resetCooldownForTests();
    vi.restoreAllMocks();
  });

  it("STB-J-001 enters cooldown after recording 5 failures", () => {
    for (let i = 0; i < 5; i += 1) {
      recordJudgeFailure(judgeConfig.modelId);
    }

    expect(isJudgeInCooldown(judgeConfig.modelId)).toBe(true);
  });

  it("STB-J-002 returns null without HTTP call when callLlmJudge is in cooldown", async () => {
    for (let i = 0; i < 5; i += 1) {
      recordJudgeFailure(judgeConfig.modelId);
    }
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await callLlmJudge(judgeInput, judgeConfig);

    expect(result).toBeNull();
    expect(lastJudgeFailureClass).toBe("cooldown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("STB-J-003 expires cooldown after 31 minutes and resets counter on next call", async () => {
    let now = 1_000;
    setMockNowForTests(() => now);
    for (let i = 0; i < 5; i += 1) {
      recordJudgeFailure(judgeConfig.modelId);
    }
    now += 31 * 60 * 1000;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(validJudgeResponse());

    const result = await callLlmJudge(judgeInput, judgeConfig);

    expect(result?.route).toBe("reply");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isJudgeInCooldown(judgeConfig.modelId)).toBe(false);

    for (let i = 0; i < 4; i += 1) {
      recordJudgeFailure(judgeConfig.modelId);
    }
    expect(isJudgeInCooldown(judgeConfig.modelId)).toBe(false);
  });

  it("STB-J-004 bypasses cooldown when health gates are disabled", async () => {
    for (let i = 0; i < 5; i += 1) {
      recordJudgeFailure(judgeConfig.modelId);
    }
    process.env.OCTOCLAW_DISABLE_HEALTH_GATES = "1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(validJudgeResponse());

    const result = await callLlmJudge(judgeInput, judgeConfig);

    expect(result?.route).toBe("reply");
    expect(isJudgeInCooldown(judgeConfig.modelId)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("STB-J-005 returns true when the fifth failure enters cooldown", () => {
    for (let i = 0; i < 4; i += 1) {
      expect(recordJudgeFailure(judgeConfig.modelId)).toBe(false);
    }

    expect(recordJudgeFailure(judgeConfig.modelId)).toBe(true);
  });
});
