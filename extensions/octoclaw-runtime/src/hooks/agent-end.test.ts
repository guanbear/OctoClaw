import { afterEach, describe, expect, it } from "vitest";
import { createReplyFinalDeliveryIntentForState, recordReplyFinalTextForState, recordReplyFinalDeliveryResultForState } from "../resolve/reply-final-delivery-intent.js";
import type { SendIMParams, SendIMResult } from "../im/send.js";
import { policyState } from "../state/policy-state.js";
import { makeAgentEndHook } from "./agent-end.js";

function seededReplyFinalState(sessionKey: string, replyToMessageId: string, finalText = "Final answer"): Record<string, unknown> {
  return recordReplyFinalTextForState({
    state: createReplyFinalDeliveryIntentForState({
      stateKey: sessionKey,
      state: {
        prompt: "user prompt",
        decision: {
          route_decision: {
            route: "reply",
            system_preferred_route: "reply",
            worker_pool: "octoclaw-main",
            task_class: "main_direct",
          },
        },
        deliveryTarget: {
          surface: "slack",
          sessionKey,
          replyToMessageId,
          immutable: true,
        },
        inboundMessageTs: replyToMessageId,
        replyToMessageId,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 500,
      },
      now: 1781000200000,
    }),
    finalText,
    now: 1781000200100,
  }) as Record<string, unknown>;
}

describe("agent_end delivery target retention", () => {
  afterEach(() => {
    for (const { key } of policyState.entries()) {
      policyState.clear(key);
    }
  });

  it("prefers the current inbound thread when shared DM state has an older delivery target", async () => {
    const sessionKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const anchorA = "1780448835.444189";
    const anchorB = "1780448868.603299";
    policyState.setState(sessionKey, {
      decision: {
        request: { session_key: sessionKey },
        route_decision: {
          route: "reply",
          system_preferred_route: "reply",
          worker_pool: "octoclaw-main",
          task_class: "main_direct",
        },
      },
      deliveryTarget: {
        sessionKey,
        replyToMessageId: anchorA,
        threadTs: anchorA,
        immutable: true,
      },
      inboundMessageTs: anchorA,
      replyToMessageId: anchorA,
      dispatchExecuted: false,
      spawnExecuted: false,
      resultMaterialized: false,
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 500,
    });

    const hook = makeAgentEndHook({ pi: { logger: {} } });

    await hook(
      { outcome: "completed" },
      {
        sessionKey,
        sessionId: "session-weather-reply",
        agentId: "main",
        inboundMessageTs: anchorB,
        messageId: anchorB,
      },
    );

    expect(policyState.get(sessionKey)).toMatchObject({
      inboundMessageTs: anchorB,
      replyToMessageId: anchorB,
      deliveryTarget: expect.objectContaining({
        replyToMessageId: anchorB,
        immutable: true,
      }),
    });
  });

  it("sends a final reply once when OpenClaw reports no message-tool delivery", async () => {
    const sessionKey = "agent:main:slack:default:direct:u0finalbackstop";
    const replyToMessageId = "1781000200.000001";
    const sent: SendIMParams[] = [];
    policyState.setState(sessionKey, seededReplyFinalState(sessionKey, replyToMessageId, "Backstop final"));
    const hook = makeAgentEndHook({
      pi: { logger: {} },
      sendFinalReply: async (params: SendIMParams): Promise<SendIMResult> => {
        sent.push(params);
        return { sent: true, messageId: "1781000201.000001", threadTs: params.replyToMessageId, transport: "slack_api" };
      },
    });

    await hook(
      { outcome: "completed", didSendViaMessagingTool: false, sourceReplyDeliveryMode: "message_tool_only" },
      { sessionKey, sessionId: "session-final-backstop", agentId: "main" },
    );
    await hook(
      { outcome: "completed", didSendViaMessagingTool: false, sourceReplyDeliveryMode: "message_tool_only" },
      { sessionKey, sessionId: "session-final-backstop", agentId: "main" },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessionKey,
      replyToMessageId,
      message: "Backstop final",
      suppressProjectionFooter: true,
      deliveryKind: "reply_final_backstop",
      deliveryTargetSource: "inbound_anchor",
    });
    expect(sent[0]?.dedupeKey).toContain(replyToMessageId);
  });

  it("skips final backstop when OpenClaw reports message-tool delivery", async () => {
    const sessionKey = "agent:main:slack:default:direct:u0finalskip";
    const replyToMessageId = "1781000200.000002";
    const sent: SendIMParams[] = [];
    policyState.setState(sessionKey, seededReplyFinalState(sessionKey, replyToMessageId, "Already sent"));
    const hook = makeAgentEndHook({
      pi: { logger: {} },
      sendFinalReply: async (params: SendIMParams): Promise<SendIMResult> => {
        sent.push(params);
        return { sent: true };
      },
    });

    await hook(
      { outcome: "completed", didSendViaMessagingTool: true, sourceReplyDeliveryMode: "message_tool_only" },
      { sessionKey, sessionId: "session-final-skip", agentId: "main" },
    );

    expect(sent).toHaveLength(0);
  });

  it("skips final backstop when message-tool target matches the frozen Slack thread", async () => {
    const sessionKey = "agent:main:slack:default:direct:u0finaltarget";
    const replyToMessageId = "1781000200.000003";
    const sent: SendIMParams[] = [];
    policyState.setState(sessionKey, seededReplyFinalState(sessionKey, replyToMessageId, "Target sent"));
    const hook = makeAgentEndHook({
      pi: { logger: {} },
      sendFinalReply: async (params: SendIMParams): Promise<SendIMResult> => {
        sent.push(params);
        return { sent: true };
      },
    });

    await hook(
      {
        outcome: "completed",
        sourceReplyDeliveryMode: "message_tool_only",
        messagingToolSentTargets: [{ provider: "slack", threadId: replyToMessageId }],
      },
      { sessionKey, sessionId: "session-final-target", agentId: "main" },
    );

    expect(sent).toHaveLength(0);
  });

  it("does not send final backstop without a frozen replyToMessageId", async () => {
    const sessionKey = "agent:main:slack:default:direct:u0finalnoanchor";
    const sent: SendIMParams[] = [];
    policyState.setState(sessionKey, {
      decision: { route_decision: { route: "reply" } },
      deliveryTarget: { surface: "slack", sessionKey },
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 500,
    });
    const hook = makeAgentEndHook({
      pi: { logger: {} },
      sendFinalReply: async (params: SendIMParams): Promise<SendIMResult> => {
        sent.push(params);
        return { sent: true };
      },
    });

    await hook(
      { outcome: "completed", didSendViaMessagingTool: false, sourceReplyDeliveryMode: "message_tool_only" },
      { sessionKey, sessionId: "session-final-noanchor", agentId: "main" },
    );

    expect(sent).toHaveLength(0);
  });

  it("does not send final backstop for an already delivered intent", async () => {
    const sessionKey = "agent:main:slack:default:direct:u0finaldelivered";
    const replyToMessageId = "1781000200.000004";
    const sent: SendIMParams[] = [];
    policyState.setState(sessionKey, recordReplyFinalDeliveryResultForState({
      state: seededReplyFinalState(sessionKey, replyToMessageId, "Delivered final"),
      result: { sent: true, messageId: "1781000201.000004", threadTs: replyToMessageId },
      now: 1781000200200,
    }));
    const hook = makeAgentEndHook({
      pi: { logger: {} },
      sendFinalReply: async (params: SendIMParams): Promise<SendIMResult> => {
        sent.push(params);
        return { sent: true };
      },
    });

    await hook(
      { outcome: "completed", didSendViaMessagingTool: false, sourceReplyDeliveryMode: "message_tool_only" },
      { sessionKey, sessionId: "session-final-delivered", agentId: "main" },
    );

    expect(sent).toHaveLength(0);
  });
});
