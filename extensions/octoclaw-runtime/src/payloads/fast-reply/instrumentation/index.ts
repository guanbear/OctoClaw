export interface FastReplyTiming {
  routeDecisionStartedAt: number;
  ackSentAt?: number;
  replyCompletedAt?: number;
}

export interface FastReplyMetrics {
  ack_ms?: number;
  total_latency_ms?: number;
}

export function computeFastReplyMetrics(timing: FastReplyTiming): FastReplyMetrics {
  const result: FastReplyMetrics = {};
  if (typeof timing.ackSentAt === "number") {
    result.ack_ms = Math.max(0, timing.ackSentAt - timing.routeDecisionStartedAt);
  }
  if (typeof timing.replyCompletedAt === "number") {
    result.total_latency_ms = Math.max(0, timing.replyCompletedAt - timing.routeDecisionStartedAt);
  }
  return result;
}
