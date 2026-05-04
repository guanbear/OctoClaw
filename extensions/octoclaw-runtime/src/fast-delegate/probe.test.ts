import { describe, expect, it } from "vitest";

import {
  buildBeforeDispatchManagedContext,
  extractBeforeDispatchPrompt,
  runFastDelegateFeasibilityProbe,
} from "./probe.js";

describe("before-dispatch fast delegate feasibility probe", () => {
  it("builds a managed Slack channel context with matching policy state key and prompt", () => {
    const sessionKey = "agent:main:slack:channel:c0as4dappu3";
    const prompt = "请让子 agent 查 OpenClaw 2026.4.29 release notes，并给我 5 句话总结。";

    const result = runFastDelegateFeasibilityProbe({
      event: {
        body: `<@U999999> ${prompt}`,
        channel: "C0AS4DAPPU3",
        sessionKey,
        timestamp: "1777734850.946689",
        user: "U0AL9T5U89Z",
      },
      ctx: {
        sessionKey,
        sessionId: sessionKey,
        channelId: "C0AS4DAPPU3",
        messageProvider: "slack",
      },
      lifecycleEvent: { prompt },
      lifecycleCtx: {
        sessionKey,
        sessionId: sessionKey,
        channelId: "C0AS4DAPPU3",
        messageTs: "1777734850.946689",
        messageProvider: "slack",
      },
    });

    expect(result.isManagedAgentContext).toBe(true);
    expect(result.beforeDispatchStateKey).toBe(sessionKey);
    expect(result.lifecycleStateKey).toBe(sessionKey);
    expect(result.stateKeyMatch).toBe(true);
    expect(result.stateKeyCompatible).toBe(true);
    expect(result.prompt).toBe(prompt);
    expect(result.promptEquivalent).toBe(true);
    expect(result.hasSlackAnchor).toBe(true);
    expect(result.metadata).toMatchObject({
      session_key: sessionKey,
      session_origin: "slack",
      session_target: "channel:c0as4dappu3",
      message_id: "1777734850.946689",
    });
  });

  it("builds a managed Slack direct context with matching policy state key", () => {
    const sessionKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const prompt = "请后台查一下当前 OpenClaw 版本变化。";

    const result = runFastDelegateFeasibilityProbe({
      event: {
        text: prompt,
        channel: "D09DIRECT",
        session_key: sessionKey,
        ts: "1777734999.123456",
      },
      ctx: {
        sessionKey,
        channelId: "D09DIRECT",
        messageProvider: "slack",
      },
      lifecycleEvent: { raw: prompt },
      lifecycleCtx: {
        sessionKey,
        sessionId: sessionKey,
        channelId: "D09DIRECT",
        messageTs: "1777734999.123456",
        messageProvider: "slack",
      },
    });

    expect(result.isManagedAgentContext).toBe(true);
    expect(result.stateKeyMatch).toBe(true);
    expect(result.promptEquivalent).toBe(true);
    expect(result.hasSlackAnchor).toBe(true);
    expect(result.metadata).toMatchObject({
      session_key: sessionKey,
      session_origin: "slack",
      session_target: "user:u0al9t5u89z",
    });
  });

  it("documents Slack thread key compatibility through binding aliases", () => {
    const rootSessionKey = "agent:main:slack:channel:c0as4dappu3";
    const threadSessionKey = "agent:main:slack:channel:c0as4dappu3:thread:1777734850.946689";

    const result = runFastDelegateFeasibilityProbe({
      event: {
        body: "请让子 agent 继续处理这个线程里的长任务。",
        channel: "C0AS4DAPPU3",
        sessionKey: rootSessionKey,
        thread_ts: "1777734850.946689",
        ts: "1777734999.123456",
      },
      ctx: {
        sessionKey: rootSessionKey,
        channelId: "C0AS4DAPPU3",
      },
      lifecycleEvent: { prompt: "请让子 agent 继续处理这个线程里的长任务。" },
      lifecycleCtx: {
        sessionKey: threadSessionKey,
        sessionId: threadSessionKey,
        channelId: "C0AS4DAPPU3",
        messageTs: "1777734999.123456",
      },
    });

    expect(result.stateKeyMatch).toBe(false);
    expect(result.stateKeyCompatible).toBe(true);
    expect(result.aliases).toContain("binding:slack:channel:c0as4dappu3");
  });

  it("keeps explicit non-Slack sessions compatible without Slack anchor claims", () => {
    const sessionKey = "agent:main:explicit:22deaf5d-4e7e-4acc-a436-98f34aa68300";
    const prompt = "请后台跑一下这个 review。";

    const result = runFastDelegateFeasibilityProbe({
      event: {
        prompt,
        sessionId: sessionKey,
      },
      ctx: {
        sessionKey,
        sessionId: sessionKey,
        trigger: "message",
      },
      lifecycleEvent: { prompt },
      lifecycleCtx: {
        sessionKey,
        sessionId: sessionKey,
        trigger: "message",
      },
    });

    expect(result.isManagedAgentContext).toBe(false);
    expect(result.beforeDispatchStateKey).toBe(sessionKey);
    expect(result.lifecycleStateKey).toBe(sessionKey);
    expect(result.stateKeyMatch).toBe(true);
    expect(result.promptEquivalent).toBe(true);
    expect(result.hasSlackAnchor).toBe(false);
  });

  it("uses the current prompt extraction rules for harness and busy wrappers", () => {
    const prompt = "请让子 agent 查 release notes。";
    const harness = `[codex-slack-e2e scenario]\n当前用户问题：${prompt}`;
    const queued = `[Queued messages while agent was busy]\nSystem: 2026-05-02 10:00 user: ${prompt}`;

    expect(extractBeforeDispatchPrompt({ body: harness })).toBe(prompt);

    const result = runFastDelegateFeasibilityProbe({
      event: {
        body: queued,
        channel: "C0AS4DAPPU3",
        sessionKey: "agent:main:slack:channel:c0as4dappu3",
        ts: "1777734999.123456",
      },
      ctx: { sessionKey: "agent:main:slack:channel:c0as4dappu3", channelId: "C0AS4DAPPU3" },
      lifecycleEvent: { prompt },
    });

    expect(result.prompt).toBe(prompt);
    expect(result.promptEquivalent).toBe(true);
  });

  it("prefers normalized transport body over noisy content metadata", () => {
    const prompt = "请让子 agent 查 release notes。";
    const result = runFastDelegateFeasibilityProbe({
      event: {
        body: prompt,
        content: "Conversation info (untrusted metadata):\n```noise```\nSender (untrusted metadata):\n```U1```\nwrong metadata copy",
        channel: "C0AS4DAPPU3",
        sessionKey: "agent:main:slack:channel:c0as4dappu3",
        ts: "1777734999.123456",
      },
      ctx: { sessionKey: "agent:main:slack:channel:c0as4dappu3", channelId: "C0AS4DAPPU3" },
      lifecycleEvent: { prompt },
    });

    expect(result.prompt).toBe(prompt);
    expect(result.promptEquivalent).toBe(true);
  });

  it("does not mark subagent sessions as managed for fast admission", () => {
    const candidate = buildBeforeDispatchManagedContext(
      {
        body: "继续处理",
        sessionKey: "agent:main:subagent:16c4d44d-58cb-49fd-a5b7-807345c740c1",
      },
      {},
    );

    const result = runFastDelegateFeasibilityProbe({
      event: { prompt: "继续处理", sessionKey: candidate.sessionKey },
      ctx: candidate,
    });

    expect(result.isManagedAgentContext).toBe(false);
    expect(result.replay).toMatchObject({
      event: "fast_delegate_probe",
      managed_agent_context: false,
    });
  });

  it("keeps replay evidence compact and excludes raw user text", () => {
    const prompt = "这是一段不应该原样出现在 replay 里的用户问题";
    const result = runFastDelegateFeasibilityProbe({
      event: {
        body: prompt,
        channel: "C0AS4DAPPU3",
        sessionKey: "agent:main:slack:channel:c0as4dappu3",
        ts: "1777734999.123456",
      },
      ctx: { sessionKey: "agent:main:slack:channel:c0as4dappu3", channelId: "C0AS4DAPPU3" },
      lifecycleEvent: { prompt },
    });

    const replayJson = JSON.stringify(result.replay);
    expect(result.replay).toMatchObject({
      event: "fast_delegate_probe",
      prompt_length: prompt.length,
      prompt_equivalent: true,
    });
    expect(String(result.replay.prompt_hash)).toHaveLength(16);
    expect(replayJson).not.toContain(prompt);
  });
});
