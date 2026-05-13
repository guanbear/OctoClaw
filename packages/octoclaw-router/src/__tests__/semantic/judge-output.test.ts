import { describe, expect, it, vi } from "vitest";
import {
  JudgeCache,
  JudgeHealthTracker,
  applyJudgeConfidenceFallback,
  computeJudgeCacheKey,
  createSemanticJudge,
  fallbackRoute,
  isValidJudgeOutput,
} from "../../semantic/index.js";
import type { JudgeInput } from "../../semantic/index.js";

function baseInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    prompt: "帮我写个 Python 脚本读 CSV",
    sessionKey: "s-1",
    recentExecution: null,
    snapshotId: "snap-1",
    runtimeSignals: {},
    ...overrides,
  };
}

describe("Auto Router v3 judge BDD", () => {
  it("RT-J-001 accepts successful judge output with exactly 3 fields", () => {
    const output = { route: "delegate", confidence: 0.72, complexity: "normal" };

    expect(isValidJudgeOutput(output)).toBe(true);
    expect(Object.keys(output).sort()).toEqual(["complexity", "confidence", "route"]);
  });

  it("RT-J-002 parse failure triggers fallback and telemetry", async () => {
    const emit = vi.fn();
    const judge = createSemanticJudge({
      judgeModelId: "qwen3:0.6b",
      callJudgeModel: vi.fn().mockResolvedValue("I think you should delegate this."),
      telemetryEmitter: { emit },
    });

    const result = await judge.judge(baseInput());

    expect(result).toEqual({ route: "reply", confidence: 0.5, complexity: "normal" });
    expect(result.confidence).toBeLessThanOrEqual(0.5);
    expect(emit).toHaveBeenCalledWith("router_judge_fallback", { reason: "parse_failed" });
  });

  it("RT-J-003 timeout triggers fallback within hard ceiling", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const judge = createSemanticJudge({
      judgeModelId: "qwen3:0.6b",
      timeoutMs: 2000,
      callJudgeModel: vi.fn(() => new Promise(() => undefined)),
      telemetryEmitter: { emit },
    });

    const promise = judge.judge(baseInput());
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ route: "reply", confidence: 0.5, complexity: "normal" });
    expect(emit).toHaveBeenCalledWith("router_judge_fallback", { reason: "timeout" });
    vi.useRealTimers();
  });

  it("RT-J-004 enters cooldown after 5 failures in the last 10 calls", () => {
    let now = 0;
    const health = new JudgeHealthTracker(() => now);
    for (let i = 0; i < 5; i += 1) health.recordSuccess();
    for (let i = 0; i < 5; i += 1) health.recordFailure("parse_failed");

    expect(health.isInCooldown()).toBe(true);
    now += 30 * 60 * 1000 + 1;
    expect(health.isInCooldown()).toBe(false);
  });

  it("RT-J-005 returns byte-identical cached result for identical prompt in same session", async () => {
    const callJudgeModel = vi.fn().mockResolvedValue({ route: "reply", confidence: 0.7, complexity: "simple" });
    const judge = createSemanticJudge({ judgeModelId: "qwen3:0.6b", callJudgeModel });

    const first = await judge.judge(baseInput({ prompt: "how are you" }));
    const second = await judge.judge(baseInput({ prompt: "how are you" }));

    expect(callJudgeModel).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("RT-J-006 misses cache when session key differs", async () => {
    const callJudgeModel = vi.fn().mockResolvedValue({ route: "reply", confidence: 0.7, complexity: "simple" });
    const judge = createSemanticJudge({ judgeModelId: "qwen3:0.6b", callJudgeModel });

    await judge.judge(baseInput({ prompt: "how are you", sessionKey: "s-1" }));
    await judge.judge(baseInput({ prompt: "how are you", sessionKey: "s-2" }));

    expect(callJudgeModel).toHaveBeenCalledTimes(2);
  });

  it("RT-J-007 misses cache when recent execution fingerprint changes", async () => {
    const callJudgeModel = vi.fn().mockResolvedValue({ route: "reply", confidence: 0.7, complexity: "simple" });
    const judge = createSemanticJudge({ judgeModelId: "qwen3:0.6b", callJudgeModel });

    await judge.judge(baseInput({ recentExecution: { taskId: "task-1", status: "completed" } }));
    await judge.judge(baseInput({ recentExecution: { taskId: "task-2", status: "completed" } }));

    expect(callJudgeModel).toHaveBeenCalledTimes(2);
  });

  it("RT-J-008 caches low-confidence judge output", async () => {
    const callJudgeModel = vi.fn().mockResolvedValue({ route: "reply", confidence: 0.3, complexity: "normal" });
    const judge = createSemanticJudge({ judgeModelId: "qwen3:0.6b", callJudgeModel });

    const first = await judge.judge(baseInput());
    const second = await judge.judge(baseInput());

    expect(first.confidence).toBe(0.3);
    expect(second).toEqual(first);
    expect(callJudgeModel).toHaveBeenCalledTimes(1);
  });

  it("RT-J-009 applies fallback when judge confidence is below threshold", () => {
    const raw = { route: "delegate", confidence: 0.5, complexity: "normal" } as const;

    expect(applyJudgeConfidenceFallback(baseInput(), raw, 0.65)).toEqual({
      route: "reply",
      confidence: 0.5,
      complexity: "normal",
    });
  });

  it("RT-J-010 skips judge for status/provenance requests", async () => {
    const callJudgeModel = vi.fn();
    const emit = vi.fn();
    const judge = createSemanticJudge({ judgeModelId: "qwen3:0.6b", callJudgeModel, telemetryEmitter: { emit } });

    const result = await judge.judge(baseInput({ runtimeSignals: { statusOrProvenanceRequest: true } }));

    expect(callJudgeModel).not.toHaveBeenCalled();
    expect(result).toEqual({ route: "reply", confidence: 0.9, complexity: "simple" });
    expect(emit).toHaveBeenCalledWith("router_judge_skipped", { reason: "status_or_provenance_request" });
  });

  it("RT-J-011 skips judge for session control requests", async () => {
    const callJudgeModel = vi.fn();
    const judge = createSemanticJudge({ judgeModelId: "qwen3:0.6b", callJudgeModel });

    const result = await judge.judge(baseInput({ runtimeSignals: { sessionControlRequest: true } }));

    expect(callJudgeModel).not.toHaveBeenCalled();
    expect(result).toEqual({ route: "reply", confidence: 0.9, complexity: "simple" });
  });

  it("RT-J-012 rejects out-of-range confidence", () => {
    expect(isValidJudgeOutput({ route: "delegate", confidence: 1.5, complexity: "normal" })).toBe(false);
  });

  it("RT-J-013 rejects extra fields", () => {
    expect(isValidJudgeOutput({ route: "delegate", confidence: 0.8, complexity: "normal", scenario: "coding" })).toBe(false);
  });

  it("RT-J-014 accepts mixed-language prompts when output is valid", async () => {
    const callJudgeModel = vi.fn().mockResolvedValue({ route: "delegate", confidence: 0.72, complexity: "normal" });
    const judge = createSemanticJudge({ judgeModelId: "qwen3:0.6b", callJudgeModel });

    await expect(judge.judge(baseInput({ prompt: "帮我写 a Python script" }))).resolves.toEqual({
      route: "delegate",
      confidence: 0.72,
      complexity: "normal",
    });
  });

  it("RT-J-015 bounds cache entries and evicts oldest", () => {
    const cache = new JudgeCache({ maxEntries: 1000, ttlMs: 120_000, now: () => 0 });
    for (let i = 0; i < 1001; i += 1) {
      cache.set(`key-${i}`, { route: "reply", confidence: 0.7, complexity: "simple" });
    }

    expect(cache.size).toBe(1000);
    expect(cache.get("key-0")).toBeNull();
  });

  it("computes cache key from prompt, session, recent execution, model, and snapshot", () => {
    const one = computeJudgeCacheKey({
      prompt: "Hello!!!",
      sessionKey: "s-1",
      recentExecution: null,
      judgeModelId: "m-1",
      snapshotId: "snap-1",
    });
    const two = computeJudgeCacheKey({
      prompt: "hello",
      sessionKey: "s-1",
      recentExecution: null,
      judgeModelId: "m-1",
      snapshotId: "snap-1",
    });

    expect(one).toBe(two);
    expect(fallbackRoute(baseInput({ runtimeSignals: { explicitDelegate: true } }))).toEqual({
      route: "delegate",
      confidence: 0.9,
      complexity: "normal",
    });
  });
});
