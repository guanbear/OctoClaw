import { describe, expect, it } from "vitest";
import { selectAckTemplate } from "./ack-template-registry.js";
import { decideAckAction, type AckDecisionPacket } from "./ack-decision.js";

function packet(overrides: Partial<AckDecisionPacket> = {}): AckDecisionPacket {
  return {
    route: "reply",
    nowMs: 0,
    inboundAtMs: 0,
    firstTokenSeen: false,
    formalReplyVisible: false,
    deliveryPending: false,
    delivered: false,
    userInputActive: false,
    mainModelActive: true,
    toolActive: false,
    delegatedRunning: false,
    blocked: false,
    reactionAckSupported: true,
    reactionAckEnabled: true,
    reactionAckSent: false,
    textAck0Sent: false,
    tier1Sent: false,
    tier2Sent: false,
    ackWriterQueued: false,
    channelTone: "chat",
    ...overrides,
  };
}

describe("ack-decision: decideAckAction", () => {
  it("sends reaction ACK at 1s when no first token and reaction is supported", () => {
    const decision = decideAckAction(packet({ nowMs: 1_000 }));
    expect(decision.action).toBe("send_reaction_ack");
    expect(decision.ackStage).toBe("ack0");
    expect(decision.modality).toBe("reaction");
  });

  it("does not send additional text ACK0 at 3s after reaction ACK0", () => {
    const decision = decideAckAction(packet({ nowMs: 3_000, reactionAckSent: true }));
    expect(decision.action).toBe("no_action");
  });

  it("sends text ACK0 at 3s when reaction is not supported and main model is active", () => {
    const decision = decideAckAction(
      packet({ nowMs: 3_000, reactionAckSupported: false, reactionAckEnabled: false }),
    );
    expect(decision.action).toBe("send_text_ack0");
    expect(decision.ackStage).toBe("ack0");
    expect(decision.modality).toBe("text");
  });

  it("suppresses or cancels once the first token appears", () => {
    expect(decideAckAction(packet({ nowMs: 3_000, firstTokenSeen: true })).action).toBe("suppress");
    expect(
      decideAckAction(packet({ nowMs: 3_000, firstTokenSeen: true, ackWriterQueued: true })).action,
    ).toBe("cancel_ack_writer");
  });

  it("suppresses or cancels for delivered, delivery pending, and formal reply states", () => {
    expect(decideAckAction(packet({ nowMs: 3_000, delivered: true })).action).toBe("suppress");
    expect(decideAckAction(packet({ nowMs: 3_000, deliveryPending: true })).action).toBe("suppress");
    expect(decideAckAction(packet({ nowMs: 3_000, formalReplyVisible: true })).action).toBe("suppress");
    expect(decideAckAction(packet({ nowMs: 3_000, delivered: true, ackWriterQueued: true })).action).toBe(
      "cancel_ack_writer",
    );
  });

  it("does nothing while user is actively typing", () => {
    const decision = decideAckAction(packet({ nowMs: 3_000, userInputActive: true }));
    expect(decision.action).toBe("no_action");
  });

  it("suppresses reply-style ACK0 for delegate route", () => {
    const decision = decideAckAction(packet({ route: "delegate", nowMs: 3_000 }));
    expect(decision.action).toBe("suppress");
  });

  it("keeps template selection stable for same thread binding, turn, and stage", () => {
    const input = {
      stage: "ack0" as const,
      channel: "chat" as const,
      tone: "neutral" as const,
      threadBindingKey: "slack:channel:C123",
      turnId: "turn-1",
      recentKeys: [],
    };

    expect(selectAckTemplate(input)).toEqual(selectAckTemplate(input));
  });
});
