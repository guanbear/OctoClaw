import { computeFastReplyMetrics, type FastReplyMetrics, type FastReplyTiming } from "../instrumentation/index.js";

export interface DirectReplyContextInput {
  userText: string;
  sessionSummary?: string;
  route?: string;
  requestKind?: string;
  directToolsSeen?: string[];
}

export interface DirectReplyContextPacket {
  userText: string;
  sessionSummary?: string;
  route?: string;
  requestKind?: string;
  directToolsSeen: string[];
}

export interface DirectReplyPayload {
  replyText: string;
  handoff: {
    kind: "reply";
    user_safe: true;
    reply_text: string;
    summary: string;
  };
  metrics: FastReplyMetrics;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export function buildDirectReplyContext(input: DirectReplyContextInput): DirectReplyContextPacket {
  return {
    userText: normalizeText(input.userText),
    sessionSummary: normalizeText(input.sessionSummary) || undefined,
    route: normalizeText(input.route) || undefined,
    requestKind: normalizeText(input.requestKind) || undefined,
    directToolsSeen: Array.isArray(input.directToolsSeen)
      ? input.directToolsSeen.map((item) => normalizeText(item)).filter(Boolean)
      : [],
  };
}

export function buildDirectReply(
  context: DirectReplyContextPacket,
  replyText: string,
  timing: FastReplyTiming,
): DirectReplyPayload {
  const normalizedReply = normalizeText(replyText);
  if (!normalizedReply) {
    throw new Error("direct_reply_text_missing");
  }

  const summaryPrefix = context.requestKind ? `[${context.requestKind}] ` : "";
  return {
    replyText: normalizedReply,
    handoff: {
      kind: "reply",
      user_safe: true,
      reply_text: normalizedReply,
      summary: `${summaryPrefix}${normalizedReply}`.trim(),
    },
    metrics: computeFastReplyMetrics(timing),
  };
}
