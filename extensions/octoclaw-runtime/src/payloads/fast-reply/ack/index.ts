import { computeFastReplyMetrics, type FastReplyMetrics, type FastReplyTiming } from "../instrumentation/index.js";

export interface FastReplyAckDecision {
  required: boolean;
  text: string;
  channel_timeout_ms?: number;
  fallback_to_progress_update?: boolean;
}

export interface FastReplyAckPayload {
  mode: "pre_dispatch" | "latency";
  required: boolean;
  text: string;
  metrics: FastReplyMetrics;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export function buildFastReplyAck(
  mode: FastReplyAckPayload["mode"],
  decision: FastReplyAckDecision | undefined,
  timing: FastReplyTiming,
): FastReplyAckPayload {
  const text = normalizeText(decision?.text);
  return {
    mode,
    required: Boolean(decision?.required) && Boolean(text),
    text,
    metrics: computeFastReplyMetrics(timing),
  };
}
