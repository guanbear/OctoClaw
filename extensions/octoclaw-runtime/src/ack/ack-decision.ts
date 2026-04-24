export interface AckDecisionPacket {
  route: "reply" | "delegate" | "pre_route" | "unknown";
  nowMs: number;
  inboundAtMs: number;
  firstTokenSeen: boolean;
  formalReplyVisible: boolean;
  finalResponseStreaming: boolean;
  deliveryPending: boolean;
  delivered: boolean;
  userInputActive: boolean;
  mainModelActive: boolean;
  toolActive: boolean;
  delegatedRunning: boolean;
  blocked: boolean;
  reactionAckSupported: boolean;
  reactionAckEnabled: boolean;
  reactionAckSent: boolean;
  textAck0Sent: boolean;
  tier1Sent: boolean;
  tier2Sent: boolean;
  ackWriterQueued: boolean;
  channelTone: "chat" | "work" | "cli" | "unknown";
}

export type AckDecisionAction =
  | "send_reaction_ack"
  | "send_text_ack0"
  | "send_tier_nudge"
  | "cancel_ack_writer"
  | "suppress"
  | "no_action";

export interface AckDecision {
  action: AckDecisionAction;
  reason: string;
  ackStage?: "ack0" | "tier1" | "tier2" | "tier3";
  modality?: "reaction" | "text";
  templateKey?: string;
}

export const ACK_TIMING = {
  reaction_ack_ms: 1000,
  text_ack0_ms: 3000,
  ack0_hard_ceiling_ms: 5000,
  tier1_ms: 18000,
  tier2_ms: 45000,
  tier3_ms: 120000,
} as const;

function elapsedMs(packet: AckDecisionPacket): number {
  return Math.max(0, packet.nowMs - packet.inboundAtMs);
}

function ack0Sent(packet: AckDecisionPacket): boolean {
  return packet.reactionAckSent || packet.textAck0Sent;
}

function workIsActive(packet: AckDecisionPacket): boolean {
  return packet.mainModelActive || packet.toolActive || packet.blocked;
}

export function decideAckAction(packet: AckDecisionPacket): AckDecision {
  // HIGHEST PRIORITY: suppress when final response is actively streaming
  if (packet.finalResponseStreaming) {
    return packet.ackWriterQueued
      ? { action: "cancel_ack_writer", reason: "final response streaming supersedes all ACK" }
      : { action: "suppress", reason: "final response streaming supersedes all ACK" };
  }

  if (packet.delivered || packet.formalReplyVisible || packet.deliveryPending || packet.firstTokenSeen) {
    return packet.ackWriterQueued
      ? {
          action: "cancel_ack_writer",
          reason: "reply delivery or visible output supersedes pending ACK writer",
        }
      : {
          action: "suppress",
          reason: "reply delivery or visible output supersedes reply-style ACK",
        };
  }

  if (packet.userInputActive) {
    return {
      action: "no_action",
      reason: "user is actively typing",
    };
  }

  if (packet.route !== "reply") {
    return {
      action: "suppress",
      reason: "reply-style ACKs are only emitted on reply route",
    };
  }

  const elapsed = elapsedMs(packet);
  const hasAck0 = ack0Sent(packet);

  if (hasAck0 && packet.tier1Sent && !packet.tier2Sent && elapsed >= ACK_TIMING.tier2_ms) {
    return {
      action: "send_tier_nudge",
      reason: "tier2 checkpoint reached after tier1",
      ackStage: "tier2",
      modality: "text",
      templateKey: "tier2",
    };
  }

  if (hasAck0 && !packet.tier1Sent && elapsed >= ACK_TIMING.tier1_ms) {
    return {
      action: "send_tier_nudge",
      reason: "tier1 checkpoint reached after ACK0",
      ackStage: "tier1",
      modality: "text",
      templateKey: "tier1",
    };
  }

  if (hasAck0 && elapsed >= ACK_TIMING.tier3_ms) {
    return {
      action: "no_action",
      reason: "extended silence after tier ACKs, no ack_writer available",
      ackStage: "tier3",
      modality: "text",
      templateKey: "tier3",
    };
  }

  if (hasAck0) {
    return {
      action: "no_action",
      reason: "ACK0 already sent and no tier checkpoint reached",
    };
  }

  if (!workIsActive(packet)) {
    return {
      action: "no_action",
      reason: "no active reply work eligible for ACK0",
    };
  }

  if (
    packet.reactionAckSupported &&
    packet.reactionAckEnabled &&
    elapsed >= ACK_TIMING.reaction_ack_ms
  ) {
    return {
      action: "send_reaction_ack",
      reason: "reaction ACK0 checkpoint reached before first token",
      ackStage: "ack0",
      modality: "reaction",
      templateKey: "ack0-reaction",
    };
  }

  if (!packet.reactionAckSent && elapsed >= ACK_TIMING.text_ack0_ms) {
    return {
      action: "send_text_ack0",
      reason: "text ACK0 checkpoint reached before first token",
      ackStage: "ack0",
      modality: "text",
      templateKey: "ack0",
    };
  }

  return {
    action: "no_action",
    reason: "no ACK checkpoint reached",
  };
}
