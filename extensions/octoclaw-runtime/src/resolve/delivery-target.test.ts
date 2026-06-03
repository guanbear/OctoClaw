import { describe, expect, it } from "vitest";
import {
  normalizeDeliveryTarget,
  resolveDurableDeliveryTarget,
  slackThreadAnchorFromSessionKey,
} from "./delivery-target.js";

describe("delivery target resolver", () => {
  it("normalizes Slack delivery targets with both camelCase and snake_case fields", () => {
    expect(normalizeDeliveryTarget({
      surface: "slack",
      session_key: "agent:main:slack:default:direct:u1",
      reply_to_message_id: "1780494854.015599",
    })).toMatchObject({
      surface: "slack",
      sessionKey: "agent:main:slack:default:direct:u1",
      session_key: "agent:main:slack:default:direct:u1",
      replyToMessageId: "1780494854.015599",
      reply_to_message_id: "1780494854.015599",
      threadTs: "1780494854.015599",
      thread_ts: "1780494854.015599",
      immutable: true,
    });
  });

  it("extracts only explicit Slack thread anchors from session keys", () => {
    expect(slackThreadAnchorFromSessionKey("agent:main:slack:default:direct:u1:thread:1780494854.015599"))
      .toBe("1780494854.015599");
    expect(slackThreadAnchorFromSessionKey("agent:main:slack:default:direct:u1")).toBe("");
    expect(slackThreadAnchorFromSessionKey("agent:main:slack:default:direct:u1:thread:not-a-ts")).toBe("");
  });

  it("uses frozen WorkContract delivery target over stale state and ctx anchors", () => {
    const result = resolveDurableDeliveryTarget({
      contract: {
        workContractId: "wc-a",
        sessionKey: "active-run-uuid",
        deliveryTarget: {
          surface: "slack",
          sessionKey: "agent:main:slack:default:direct:u1",
          replyToMessageId: "1780494854.015599",
        },
      },
      state: {
        workContractId: "wc-a",
        deliveryTarget: {
          sessionKey: "agent:main:slack:default:direct:u1",
          replyToMessageId: "1780494887.586889",
        },
      },
      ctx: {
        sessionKey: "agent:main:slack:default:direct:u1",
        replyToMessageId: "1780494905.664319",
      },
    });

    expect(result.target).toMatchObject({
      sessionKey: "agent:main:slack:default:direct:u1",
      replyToMessageId: "1780494854.015599",
    });
    expect(result.source).toBe("work_contract");
  });

  it("does not classify a thread-bearing WorkContract session key as a frozen target", () => {
    const result = resolveDurableDeliveryTarget({
      contract: {
        workContractId: "wc-a",
        sessionKey: "agent:main:slack:default:direct:u1:thread:1780494854.015599",
      },
    });

    expect(result.target).toMatchObject({
      sessionKey: "agent:main:slack:default:direct:u1:thread:1780494854.015599",
      replyToMessageId: "1780494854.015599",
    });
    expect(result.source).toBe("session_thread");
  });

  it("uses explicitly bound state as a backfill when WorkContract has no frozen target", () => {
    const result = resolveDurableDeliveryTarget({
      contract: {
        workContractId: "wc-a",
        sessionKey: "agent:main:slack:default:direct:u1",
      },
      state: {
        workContractId: "wc-a",
        deliveryTarget: {
          sessionKey: "agent:main:slack:default:direct:u1",
          replyToMessageId: "1780494887.586889",
        },
      },
      ctx: {
        sessionKey: "agent:main:slack:default:direct:u1",
        replyToMessageId: "1780494905.664319",
      },
    });

    expect(result.target).toMatchObject({
      sessionKey: "agent:main:slack:default:direct:u1",
      replyToMessageId: "1780494887.586889",
    });
    expect(result.source).toBe("bound_state");
  });

  it("does not use unbound state or ctx anchors for durable Slack delivery", () => {
    const result = resolveDurableDeliveryTarget({
      contract: {
        workContractId: "wc-a",
        sessionKey: "agent:main:slack:default:direct:u1",
      },
      state: {
        workContractId: "wc-b",
        deliveryTarget: {
          sessionKey: "agent:main:slack:default:direct:u1",
          replyToMessageId: "1780494887.586889",
        },
      },
      ctx: {
        sessionKey: "agent:main:slack:default:direct:u1",
        replyToMessageId: "1780494905.664319",
      },
    });

    expect(result.target).toBeNull();
    expect(result.reason).toBe("missing_inbound_anchor");
  });
});
