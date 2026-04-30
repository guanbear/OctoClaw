import { describe, expect, it } from "vitest";
import { selectAckTemplate } from "./ack-templates.js";
import { decideAckAction, type AckDecisionPacket } from "./ack-decision.js";

function packet(overrides: Partial<AckDecisionPacket> = {}): AckDecisionPacket {
  return {
    route: "reply",
    nowMs: 0,
    inboundAtMs: 0,
    firstTokenSeen: false,
    formalReplyVisible: false,
    finalResponseStreaming: false,
    deliveryPending: false,
    delivered: false,
    userInputActive: false,
    mainModelActive: true,
    toolActive: false,
    delegatedRunning: false,
    blocked: false,
    hasValidThreadTarget: true,
    reactionAckSupported: true,
    reactionAckEnabled: true,
    reactionAckAttempted: false,
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
  it("sends reaction ACK at 800ms when no first token and reaction is supported", () => {
    const decision = decideAckAction(packet({ nowMs: 800 }));
    expect(decision.action).toBe("send_reaction_ack");
    expect(decision.ackStage).toBe("ack0");
    expect(decision.modality).toBe("reaction");
  });

  it("does not send additional text ACK0 at 2.5s after reaction ACK0", () => {
    const decision = decideAckAction(packet({ nowMs: 2_500, reactionAckSent: true }));
    expect(decision.action).toBe("no_action");
  });

  it("does not fall back to text ACK0 after a configured reaction ACK attempt fails", () => {
    const decision = decideAckAction(packet({ nowMs: 2_500, reactionAckAttempted: true, reactionAckSent: false }));
    expect(decision.action).toBe("no_action");
  });

  it("does not send text ACK0 when reaction is not supported and main model is active", () => {
    const decision = decideAckAction(
      packet({ nowMs: 2_500, reactionAckSupported: false, reactionAckEnabled: false }),
    );
    expect(decision.action).toBe("no_action");
    expect(decision.ackStage).toBe("ack0");
    expect(decision.modality).toBe("text");
  });

  it("suppresses or cancels once the first token appears", () => {
    expect(decideAckAction(packet({ nowMs: 2_500, firstTokenSeen: true })).action).toBe("suppress");
    expect(
      decideAckAction(packet({ nowMs: 2_500, firstTokenSeen: true, ackWriterQueued: true })).action,
    ).toBe("cancel_ack_writer");
  });

  it("suppresses or cancels for delivered, delivery pending, and formal reply states", () => {
    expect(decideAckAction(packet({ nowMs: 2_500, delivered: true })).action).toBe("suppress");
    expect(decideAckAction(packet({ nowMs: 2_500, deliveryPending: true })).action).toBe("suppress");
    expect(decideAckAction(packet({ nowMs: 2_500, formalReplyVisible: true })).action).toBe("suppress");
    expect(decideAckAction(packet({ nowMs: 2_500, delivered: true, ackWriterQueued: true })).action).toBe(
      "cancel_ack_writer",
    );
  });

  it("does nothing while user is actively typing", () => {
    const decision = decideAckAction(packet({ nowMs: 2_500, userInputActive: true }));
    expect(decision.action).toBe("no_action");
  });

  it("suppresses reply-style ACK0 for delegate route", () => {
    const decision = decideAckAction(packet({ route: "delegate", nowMs: 2_500 }));
    expect(decision.action).toBe("suppress");
  });

  it("suppresses ACK when no valid thread target exists", () => {
    const decision = decideAckAction(packet({ nowMs: 800, hasValidThreadTarget: false }));

    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe("no valid thread target for ACK delivery");
  });

  it("session target alone does not count as valid thread target", () => {
    const decision = decideAckAction(packet({
      nowMs: 800,
      hasValidThreadTarget: false,
      reactionAckSupported: true,
      reactionAckEnabled: true,
    }));

    expect(decision.action).toBe("suppress");
  });

  it("suppresses ACK when neither a session target nor message_id makes hasValidThreadTarget true", () => {
    // buildDecisionPacket should leave hasValidThreadTarget=false when both message and session targets are missing.
    const decision = decideAckAction(packet({
      nowMs: 2_500,
      hasValidThreadTarget: false,
      reactionAckSupported: false,
      reactionAckEnabled: false,
    }));

    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe("no valid thread target for ACK delivery");
  });

  it("sends reaction ACK with valid thread target at 1s", () => {
    const decision = decideAckAction(packet({
      nowMs: 800,
      hasValidThreadTarget: true,
      reactionAckSupported: true,
      reactionAckEnabled: true,
    }));

    expect(decision.action).toBe("send_reaction_ack");
    expect(decision.ackStage).toBe("ack0");
    expect(decision.modality).toBe("reaction");
  });

  it("considers delegatedRunning as active work eligible for ACK0", () => {
    const decision = decideAckAction(packet({
      nowMs: 2_500,
      mainModelActive: false,
      toolActive: false,
      delegatedRunning: true,
      reactionAckSupported: false,
      reactionAckEnabled: false,
    }));

    expect(decision.action).toBe("no_action");
  });

  it("still suppresses ACK on delegate route even when delegated is running", () => {
    const decision = decideAckAction(packet({
      route: "delegate",
      nowMs: 2_500,
      delegatedRunning: true,
      mainModelActive: true,
    }));

    expect(decision.action).toBe("suppress");
  });

  it("suppresses delegate route even with delegatedRunning and a valid thread target", () => {
    const decision = decideAckAction(packet({
      route: "delegate",
      nowMs: 2_500,
      delegatedRunning: true,
      mainModelActive: false,
      toolActive: false,
      hasValidThreadTarget: true,
      reactionAckSupported: false,
      reactionAckEnabled: false,
    }));

    expect(decision.action).toBe("suppress");
  });

  it("keeps template selection stable for same thread binding, turn, and stage", () => {
    const input = {
      stage: "ack0" as const,
      channel: "chat" as const,
      tone: "neutral" as const,
      taskClass: "unknown" as const,
      modality: "text" as const,
      threadBindingKey: "slack:channel:C123",
      turnId: "turn-1",
      recentKeys: [],
    };

    expect(selectAckTemplate(input)).toEqual(selectAckTemplate(input));
  });

  it("suppresses at highest priority when final response is streaming", () => {
    const decision = decideAckAction(packet({
      nowMs: 2_500,
      finalResponseStreaming: true,
      mainModelActive: true,
      reactionAckSupported: true,
      reactionAckEnabled: true,
    }));

    expect(decision.action).toBe("suppress");
    expect(decision.reason).toContain("final response streaming");
  });

  it("cancels queued ack writer when final response starts streaming", () => {
    const decision = decideAckAction(packet({
      nowMs: 2_500,
      finalResponseStreaming: true,
      ackWriterQueued: true,
    }));

    expect(decision.action).toBe("cancel_ack_writer");
  });

  it("never returns enqueue_ack_writer action", () => {
    const decision = decideAckAction(packet({
      nowMs: 200_000,
      reactionAckSent: true,
      tier1Sent: true,
      tier2Sent: true,
      mainModelActive: true,
    }));

    expect(decision.action).not.toBe("enqueue_ack_writer");
  });
});
