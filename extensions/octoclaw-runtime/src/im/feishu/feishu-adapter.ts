import { ERROR_CODES } from "@octoclaw/errors";
import { runCommand, resolveWorkspaceRoot } from "../../resolve/env.js";
import type { IMAdapter, IMDeliveryTarget, IMReactParams, IMReactResult, IMSendParams, IMSendResult } from "../adapter.js";
import { splitIMText } from "../text-split.js";

export interface FeishuAdapterConfig {
  /**
   * Controls whether ACK/reply messages are sent as Feishu thread replies.
   * - "off": top-level message only (default)
   * - "first": thread under the first inbound message
   * - "all": thread under every inbound message
   */
  replyToMode: "off" | "first" | "all";
  segmentMarkers: boolean;
}

const DEFAULT_FEISHU_CONFIG: FeishuAdapterConfig = {
  replyToMode: "off",
  segmentMarkers: true,
};

/**
 * Feishu L2 capability profile: text, thread replies, and media/file attachments.
 * No streaming, no message editing, no typing indicators.
 */
export const FEISHU_CAPABILITIES = {
  capabilityLevel: "L2",
  canUpdateMessage: false,
  canStreamNative: false,
  canReplyInThread: true,
  canTypingIndicator: false,
  messageIdFormat: "message_id",
  userIdCaseSensitive: false,
  maxMessageLength: 4000,
} as const;

type FeishuCommandResult = {
  ok?: unknown;
  message_id?: unknown;
  root_id?: unknown;
  error?: unknown;
};

type FeishuAttachment = {
  type: "image" | "file";
  url: string;
  name?: string;
};

type FeishuCardBlock = {
  card: Record<string, unknown>;
};

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeFeishuUserId(rawId: string): string {
  let id = rawId.trim();
  if (id.startsWith("user:")) {
    id = id.slice(5);
  }
  // Feishu IDs (ou_xxx, oc_xxx) are NOT uppercased
  return id;
}

function parseFeishuSessionKey(sessionKey: string): { target: string; threadTs: string } {
  const parts = sessionKey.split(":").map((p) => p.trim());
  const feishuIndex = parts.findIndex((p) => p.toLowerCase() === "feishu");
  if (feishuIndex < 0) return { target: "", threadTs: "" };

  const CONV_KINDS = new Set(["dm", "direct", "user", "channel", "group", "room", "conversation", "chat"]);
  const kindIndex = CONV_KINDS.has((parts[feishuIndex + 1] ?? "").toLowerCase())
    ? feishuIndex + 1
    : feishuIndex + 2;

  const target = normalizeFeishuUserId(parts[kindIndex + 1] ?? "");
  const threadTs = (parts[kindIndex + 2] ?? "").toLowerCase() === "thread"
    ? (parts[kindIndex + 3] ?? "")
    : "";

  return { target, threadTs };
}

function extractFeishuPayload(text: string): FeishuCommandResult | null {
  if (!text) return null;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const openBrace = text.indexOf("{", searchFrom);
    if (openBrace < 0) break;

    let depth = 0;
    let close = openBrace;
    let insideString = false;
    let escaping = false;

    for (let i = openBrace; i < text.length; i++) {
      const ch = text[i];
      if (escaping) { escaping = false; continue; }
      if (ch === "\\") { escaping = true; continue; }
      if (ch === '"') { insideString = !insideString; continue; }
      if (insideString) continue;
      if (ch === "{") depth++;
      if (ch === "}") { depth--; if (depth === 0) { close = i; break; } }
    }
    if (depth !== 0) { searchFrom = openBrace + 1; continue; }

    const candidate = text.slice(openBrace, close + 1);
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if ("ok" in parsed || "message_id" in parsed) {
        return {
          ok: parsed.ok,
          message_id: parsed.message_id,
          root_id: parsed.root_id,
          error: parsed.error,
        };
      }
    } catch { /* skip non-JSON fragments */ }
    searchFrom = close + 1;
  }
  return null;
}

function feishuMessageId(payload: FeishuCommandResult | null): string | undefined {
  return payload?.message_id ? String(payload.message_id) : undefined;
}

function parseFeishuSendResult(code: number, stdout: string, stderr: string): IMSendResult {
  const stdoutPayload = extractFeishuPayload(stdout);
  const stderrPayload = extractFeishuPayload(stderr);
  const successPayload = stdoutPayload?.ok === true ? stdoutPayload
    : stderrPayload?.ok === true ? stderrPayload
    : null;

  if (successPayload) {
    const messageId = feishuMessageId(successPayload);
    const threadTs = successPayload.root_id ? String(successPayload.root_id) : undefined;
    return {
      sent: true,
      delivered: true,
      ...(messageId ? { messageId } : {}),
      ...(threadTs ? { threadTs } : {}),
    };
  }

  if (code === 0) {
    return { sent: true, delivered: true };
  }

  const errorPayload = stdoutPayload?.ok === false ? stdoutPayload : stderrPayload;
  return {
    sent: false,
    delivered: false,
    error: String(errorPayload?.error ?? stderr ?? ERROR_CODES.IM_SEND_FAILED).slice(0, 200),
  };
}

function extractFeishuAttachments(blocks?: Array<Record<string, unknown>>): FeishuAttachment[] {
  if (!blocks?.length) return [];

  const attachments: FeishuAttachment[] = [];
  for (const block of blocks) {
    const type = stringValue(block.type).toLowerCase();
    if (type !== "image" && type !== "file") continue;

    const url = stringValue(block.url || block.href || block.imageUrl || block.fileUrl);
    if (!url) continue;

    const name = stringValue(block.name || block.filename || block.fileName);
    attachments.push({
      type,
      url,
      ...(name ? { name } : {}),
    });
  }
  return attachments;
}

function extractFeishuCards(blocks?: Array<Record<string, unknown>>): FeishuCardBlock[] {
  if (!blocks?.length) return [];

  const cards: FeishuCardBlock[] = [];
  for (const block of blocks) {
    const type = stringValue(block.type).toLowerCase();
    if (type !== "feishu_card") continue;
    const card = block.card;
    if (!card || typeof card !== "object" || Array.isArray(card)) continue;
    cards.push({ card: card as Record<string, unknown> });
  }
  return cards;
}

/**
 * IM adapter for Feishu (L2 tier).
 * Supports text delivery, thread replies, image attachments, and file attachments.
 */
export class FeishuAdapter implements IMAdapter {
  readonly channel = "feishu" as const;
  readonly capabilityLevel = "L2" as const;
  readonly config: FeishuAdapterConfig;

  constructor(config?: Partial<FeishuAdapterConfig>) {
    this.config = { ...DEFAULT_FEISHU_CONFIG, ...config };
  }

  canHandle(sessionKey: string): boolean {
    const lower = sessionKey.toLowerCase();
    return lower.startsWith("feishu:") || lower.includes(":feishu:");
  }

  resolveTarget(sessionKey: string): IMDeliveryTarget {
    const parsed = parseFeishuSessionKey(sessionKey);
    return {
      channel: "feishu",
      target: parsed.target,
      ...(parsed.threadTs ? { threadTs: parsed.threadTs } : {}),
    };
  }

  /** Feishu L1 does not support emoji reactions. */
  async react(_params: IMReactParams): Promise<IMReactResult> {
    return { ok: false, error: "not_supported" };
  }

  async send(params: IMSendParams): Promise<IMSendResult> {
    const { sessionKey, message, interactiveBlocks, replyToMessageId, timeoutMs = 5000, cwd } = params;
    const target = this.resolveTarget(sessionKey);

    if (!target.target) {
      return { sent: false, delivered: false, error: ERROR_CODES.IM_UNRESOLVABLE_TARGET };
    }

    const textSegments = splitIMText(message, FEISHU_CAPABILITIES.maxMessageLength, {
      markers: this.config.segmentMarkers,
    });
    const cards = extractFeishuCards(interactiveBlocks);
    const attachments = extractFeishuAttachments(interactiveBlocks);
    const cwdValue = cwd ?? resolveWorkspaceRoot();
    const timeoutValue = Math.max(500, timeoutMs);
    let lastResult: IMSendResult = { sent: true, delivered: true };

    if (textSegments.length === 0 && attachments.length === 0 && cards.length === 0) {
      const emptyResult = await this.deliver(["message", "send", "--channel", "feishu", "--target", target.target, "--json"], cwdValue, timeoutValue);
      return emptyResult;
    }

    for (const card of cards) {
      const args = [
        "message", "send",
        "--channel", "feishu",
        "--target", target.target,
        "--type", "card",
        "--card", JSON.stringify(card.card),
        "--json",
      ];
      if (replyToMessageId && this.config.replyToMode !== "off") {
        args.push("--reply-to", replyToMessageId);
      }

      lastResult = await this.deliver(args, cwdValue, timeoutValue);
      if (!lastResult.sent) {
        return { ...lastResult, error: ERROR_CODES.IM_SEND_FAILED };
      }
    }

    for (const segment of cards.length > 0 ? [] : textSegments) {
      const args = ["message", "send", "--channel", "feishu", "--target", target.target, "--json", "--message", segment];
      if (replyToMessageId && this.config.replyToMode !== "off") {
        args.push("--reply-to", replyToMessageId);
      }

      lastResult = await this.deliver(args, cwdValue, timeoutValue);
      if (!lastResult.sent) {
        return {
          ...lastResult,
          error: textSegments.length > 1 ? ERROR_CODES.IM_SEND_FAILED : lastResult.error || ERROR_CODES.IM_SEND_FAILED,
        };
      }
    }

    for (const attachment of attachments) {
      const args = [
        "message", "send",
        "--channel", "feishu",
        "--target", target.target,
        "--type", attachment.type,
        "--url", attachment.url,
        "--json",
      ];
      if (attachment.type === "file" && attachment.name) {
        args.push("--name", attachment.name);
      }
      if (replyToMessageId && this.config.replyToMode !== "off") {
        args.push("--reply-to", replyToMessageId);
      }

      lastResult = await this.deliver(args, cwdValue, timeoutValue);
      if (!lastResult.sent) {
        return { ...lastResult, error: ERROR_CODES.IM_SEND_FAILED };
      }
    }

    return lastResult;
  }

  shouldUseThread(): boolean {
    return this.config.replyToMode !== "off";
  }

  normalizeUserId(rawId: string): string {
    return normalizeFeishuUserId(rawId);
  }

  private async deliver(args: string[], cwd: string, timeoutMs: number): Promise<IMSendResult> {
    try {
      const result = await runCommand("openclaw", args, { cwd, timeoutMs });
      return parseFeishuSendResult(result.code, result.stdout ?? "", result.stderr ?? "");
    } catch (err) {
      return { sent: false, delivered: false, error: String(err) };
    }
  }
}
