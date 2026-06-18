import { afterEach, describe, expect, it } from "vitest";
import { policyState } from "../state/policy-state.js";
import { makeReplyPayloadSendingHook } from "./reply-usage-hook.js";

describe("reply_payload_sending hook", () => {
  afterEach(() => {
    for (const { key } of policyState.entries()) {
      policyState.clear(key);
    }
    delete process.env.OCTOCLAW_PROJECTION_FOOTER_MODE;
  });

  const sessionKey = "agent:main:slack:default:direct:u0replyusage";

  function seedReplyRouteState(): void {
    policyState.setState(sessionKey, {
      decision: {
        route_decision: { route: "reply", route_source: "rule" },
        model_policy: { selected_model: "zhipu/GLM-5.2" },
        work_contract: { route: "reply", workContractId: "wc-replyusage" },
      },
      inboundMessageTs: "1782000100.000001",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  it("re-renders the footer with the live model, ⚡ marker, and time when a fallback fired", () => {
    seedReplyRouteState();
    const hook = makeReplyPayloadSendingHook({ pi: { logger: {} } });

    const result = hook(
      {
        payload: {
          text: "完成了。\n\n• octoclaw: route=reply | model=zhipu/GLM-5.2 · thread",
        },
        kind: "reply",
        channel: "slack",
        sessionKey,
        runId: "run-replyusage-1",
        usageState: {
          model: "cliproxyapi/gpt-5.5",
          resolvedRef: "cliproxyapi/gpt-5.5",
          fallbackUsed: true,
          requested: "zhipu/GLM-5.2",
          durationMs: 3200,
        },
      },
      { sessionKey, channelId: "slack" },
    );

    const text = String((result as { payload?: { text?: string } })?.payload?.text ?? "");
    expect(text).toContain("model=cliproxyapi/gpt-5.5⚡");
    expect(text).toContain("time=3.2s");
    // The stale footer (static primary) must be gone.
    expect(text).not.toContain("model=zhipu/GLM-5.2 · thread");
    // No duplicate footer lines.
    expect(text.match(/octoclaw:/gu)?.length ?? 0).toBe(1);
  });

  it("returns void (no payload rewrite) when usageState is absent", () => {
    seedReplyRouteState();
    const hook = makeReplyPayloadSendingHook({ pi: { logger: {} } });

    const result = hook(
      {
        payload: { text: "完成了。\n\n• octoclaw: route=reply | model=zhipu/GLM-5.2 · thread" },
        kind: "reply",
        channel: "slack",
        sessionKey,
        runId: "run-replyusage-2",
      },
      { sessionKey, channelId: "slack" },
    );

    expect(result).toBeUndefined();
  });

  it("returns void when usageState is an empty object (durable/replay path)", () => {
    seedReplyRouteState();
    const hook = makeReplyPayloadSendingHook({ pi: { logger: {} } });

    const result = hook(
      {
        payload: { text: "完成了。" },
        kind: "reply",
        channel: "slack",
        sessionKey,
        runId: "run-replyusage-3",
        usageState: {},
      },
      { sessionKey, channelId: "slack" },
    );

    expect(result).toBeUndefined();
  });

  it("strips a previously-stamped footer and does not double-stamp", () => {
    seedReplyRouteState();
    const hook = makeReplyPayloadSendingHook({ pi: { logger: {} } });

    const result = hook(
      {
        payload: {
          text: "结果。\n\n• octoclaw: route=reply | model=zhipu/GLM-5.2 | time=1.0s · thread",
        },
        kind: "reply",
        channel: "slack",
        sessionKey,
        runId: "run-replyusage-4",
        usageState: {
          model: "cliproxyapi/gpt-5.4-mini",
          fallbackUsed: false,
          durationMs: 540,
        },
      },
      { sessionKey, channelId: "slack" },
    );

    const text = String((result as { payload?: { text?: string } })?.payload?.text ?? "");
    expect(text).toContain("model=cliproxyapi/gpt-5.4-mini");
    expect(text).toContain("time=0.5s");
    expect(text.match(/octoclaw:/gu)?.length ?? 0).toBe(1);
  });

  it("persists usageState onto policy state for downstream readers", () => {
    seedReplyRouteState();
    const hook = makeReplyPayloadSendingHook({ pi: { logger: {} } });

    hook(
      {
        payload: { text: "ok" },
        kind: "reply",
        channel: "slack",
        sessionKey,
        runId: "run-replyusage-5",
        usageState: { model: "cliproxyapi/gpt-5.5", fallbackUsed: false, durationMs: 1000 },
      },
      { sessionKey, channelId: "slack" },
    );

    const state = policyState.get(sessionKey);
    expect(state?.replyUsageState).toMatchObject({ model: "cliproxyapi/gpt-5.5" });
    expect(state?.reply_usage_state).toMatchObject({ model: "cliproxyapi/gpt-5.5" });
  });
});
