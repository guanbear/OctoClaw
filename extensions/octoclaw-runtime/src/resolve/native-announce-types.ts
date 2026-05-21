import { type SendIMResult } from "../im/send.js";

export type NativeAnnounceSendMessage = (params: {
  sessionKey: string;
  message: string;
  replyToMessageId?: string;
  cwd?: string;
}) => Promise<SendIMResult>;

export interface NativeAnnounceCompletion {
  sourceSessionKey: string;
  sourceSessionId: string;
  sourceTool: string;
  status: string;
  resultText: string;
  resultHash: string;
  workerResult?: Record<string, unknown>;
}

export interface NativeAnnounceBlocker {
  blocked: true;
  reason: string;
}

export const NATIVE_ANNOUNCE_BLOCKED_TOOLS = new Set([
  "octoclaw_dispatch",
  "octoclaw_dispatch_confirm",
  "sessions_spawn",
]);
