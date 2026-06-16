import { afterEach, describe, expect, it } from "vitest";
import { policyState } from "../state/policy-state.js";
import { replyFinalDeliveryIntentFromState } from "../resolve/reply-final-delivery-intent.js";
import { makeBeforeMessageWriteHook, makeMessageReceivedHook } from "./message-lifecycle.js";

describe("message lifecycle reply final delivery intent", () => {
  afterEach(() => {
    for (const { key } of policyState.entries()) {
      policyState.clear(key);
    }
  });

  it("anchors a Slack inbound turn and records the final assistant text", async () => {
    const sessionKey = "agent:main:slack:default:direct:u0finalintent";
    const replyToMessageId = "1781000100.000001";
    const messageReceived = makeMessageReceivedHook({
      pi: { logger: {} },
      maybeSendNeutralInboundAckForContext: async () => undefined,
    });
    const beforeMessageWrite = makeBeforeMessageWriteHook({
      pi: { logger: {} },
      recordNeutralAckCancellations: () => undefined,
    });

    messageReceived(
      {
        content: "帮我 review 当前工作区",
        metadata: {
          messageId: replyToMessageId,
          originatingChannel: "slack",
          originatingTo: "user:U0FINALINTENT",
        },
      },
      {
        sessionKey,
        channelId: "slack",
        conversationId: "user:U0FINALINTENT",
      },
    );

    const writeResult = beforeMessageWrite(
      { message: { role: "assistant", content: "Review result is ready." } },
      {
        sessionKey,
        sessionId: "session-final-intent",
        agentId: "main",
        channelId: "slack",
      },
    );

    await Promise.resolve();

    const state = policyState.get(sessionKey);
    const intent = replyFinalDeliveryIntentFromState(state);
    const writtenContent = String((writeResult?.message as { content?: unknown } | undefined)?.content ?? "Review result is ready.");

    expect(intent).toMatchObject({
      sessionKey,
      replyToMessageId,
      deliveryStatus: "pending",
    });
    expect(intent?.finalText).toBe(writtenContent);
    expect(intent?.finalHash).toHaveLength(64);
    expect(intent?.dedupeKey).toContain(replyToMessageId);
  });
});
