import { describe, expect, it } from "vitest";
import {
  createReplyFinalDeliveryIntentForState,
  recordReplyFinalTextForState,
  replyFinalDeliveryIntentFromState,
  shouldBackstopReplyFinalDelivery,
} from "./reply-final-delivery-intent.js";

describe("reply final delivery intent", () => {
  it("creates an intent from a frozen Slack inbound anchor", () => {
    const state = createReplyFinalDeliveryIntentForState({
      stateKey: "agent:main:slack:default:direct:u123",
      state: {
        prompt: "review this",
        deliveryTarget: {
          sessionKey: "agent:main:slack:default:direct:u123",
          replyToMessageId: "1781000000.000001",
          immutable: true,
        },
      },
      now: 1781000000000,
    });

    const intent = replyFinalDeliveryIntentFromState(state);

    expect(intent).toMatchObject({
      stateKey: "agent:main:slack:default:direct:u123",
      sessionKey: "agent:main:slack:default:direct:u123",
      replyToMessageId: "1781000000.000001",
      deliveryStatus: "pending",
      deliveryTargetSource: "bound_state",
      createdAt: 1781000000000,
    });
    expect(intent?.intentId).toMatch(/^rfd_/);
    expect(state.replyFinalDeliveryIntent).toEqual(state.reply_final_delivery_intent);
  });

  it("records final text and stable hash without marking it delivered", () => {
    const state = recordReplyFinalTextForState({
      state: createReplyFinalDeliveryIntentForState({
        stateKey: "agent:main:slack:default:direct:u123",
        state: {
          deliveryTarget: {
            sessionKey: "agent:main:slack:default:direct:u123",
            replyToMessageId: "1781000000.000002",
          },
        },
        now: 1781000000000,
      }),
      finalText: "The review is done.\n\n• octoclaw: route=reply",
      now: 1781000000100,
    });

    const intent = replyFinalDeliveryIntentFromState(state);

    expect(intent).toMatchObject({
      finalText: "The review is done.\n\n• octoclaw: route=reply",
      finalSeenAt: 1781000000100,
      deliveryStatus: "pending",
    });
    expect(intent?.finalHash).toHaveLength(64);
    expect(intent?.dedupeKey).toBe(`reply-final:${intent?.stateKey}:1781000000.000002:${intent?.finalHash}`);
  });

  it("fails closed when no replyToMessageId exists", () => {
    const state = createReplyFinalDeliveryIntentForState({
      stateKey: "agent:main:slack:default:direct:u123",
      state: { deliveryTarget: { sessionKey: "agent:main:slack:default:direct:u123" } },
      now: 1781000000000,
    });

    expect(replyFinalDeliveryIntentFromState(state)).toBeNull();
    expect(shouldBackstopReplyFinalDelivery({ state, event: { didSendViaMessagingTool: false } })).toMatchObject({
      shouldSend: false,
      reason: "missing_intent",
    });
  });

  it("keeps the dedupe key stable for same session thread and final text", () => {
    const baseState = {
      deliveryTarget: {
        sessionKey: "agent:main:slack:default:direct:u123",
        replyToMessageId: "1781000000.000003",
      },
    };
    const left = recordReplyFinalTextForState({
      state: createReplyFinalDeliveryIntentForState({
        stateKey: "agent:main:slack:default:direct:u123",
        state: baseState,
        now: 1781000000000,
      }),
      finalText: "Same final",
      now: 1781000000100,
    });
    const right = recordReplyFinalTextForState({
      state: createReplyFinalDeliveryIntentForState({
        stateKey: "agent:main:slack:default:direct:u123",
        state: baseState,
        now: 1781000000900,
      }),
      finalText: "Same final",
      now: 1781000000999,
    });

    expect(replyFinalDeliveryIntentFromState(left)?.dedupeKey).toBe(replyFinalDeliveryIntentFromState(right)?.dedupeKey);
  });
});
