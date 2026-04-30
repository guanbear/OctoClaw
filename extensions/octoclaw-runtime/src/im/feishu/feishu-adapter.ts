import { runCommand, resolveWorkspaceRoot } from "../../resolve/env.js";
import type { IMAdapter, IMDeliveryTarget, IMReactParams, IMReactResult, IMSendParams, IMSendResult } from "../adapter.js";

export interface FeishuAdapterConfig {
  /**
   * Controls whether ACK/reply messages are sent as Feishu thread replies.
   * - "off": top-level message only (default)
   * - "first": thread under the first inbound message
   * - "all": thread under every inbound message
   */
  replyToMode: "off" | "first" | "all";
}

const DEFAULT_FEISHU_CONFIG: FeishuAdapterConfig = {
  replyToMode: "off",
};

/**
 * Feishu L1 capability profile: text messaging + thread replies.
 * No streaming, no message editing, no typing indicators.
 */
export const FEISHU_CAPABILITIES = {
  canUpdateMessage: false,
  canStreamNative: false,
  canReplyInThread: true,
  canTypingIndicator: false,
  messageIdFormat: "message_id",
  userIdCaseSensitive: false,
  maxMessageLength: 40000,
} as const;

type FeishuCommandResult = {
  ok?: unknown;
  message_id?: unknown;
  root_id?: unknown;
  error?: unknown;
};

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

/**
 * IM adapter for Feishu (L1 tier).
 * Supports text delivery and thread replies; does not support streaming,
 * message editing, or typing indicators.
 */
export class FeishuAdapter implements IMAdapter {
  readonly channel = "feishu" as const;
  readonly capabilityLevel = "L1" as const;
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
    const { sessionKey, message, replyToMessageId, timeoutMs = 5000, cwd } = params;
    const target = this.resolveTarget(sessionKey);

    if (!target.target) {
      return { sent: false, delivered: false, error: "unresolvable_session_target" };
    }

    // Truncate to platform limit
    const text = message.slice(0, FEISHU_CAPABILITIES.maxMessageLength);
    const args = ["message", "send", "--channel", "feishu", "--target", target.target, "--json"];

    if (text) {
      args.push("--message", text);
    }

    // Thread reply: only when replyToMessageId is provided AND config allows it
    if (replyToMessageId && this.config.replyToMode !== "off") {
      args.push("--reply-to", replyToMessageId);
    }

    try {
      const result = await runCommand("openclaw", args, {
        cwd: cwd ?? resolveWorkspaceRoot(),
        timeoutMs: Math.max(500, timeoutMs),
      });

      const stdoutPayload = extractFeishuPayload(result.stdout ?? "");
      const stderrPayload = extractFeishuPayload(result.stderr ?? "");
      const successPayload = stdoutPayload?.ok === true ? stdoutPayload
        : stderrPayload?.ok === true ? stderrPayload
        : null;

      if (successPayload) {
        const messageId = successPayload.message_id ? String(successPayload.message_id) : undefined;
        const threadTs = successPayload.root_id ? String(successPayload.root_id) : undefined;
        return {
          sent: true,
          delivered: true,
          ...(messageId ? { messageId } : {}),
          ...(threadTs ? { threadTs } : {}),
        };
      }

      if (result.code === 0) {
        return { sent: true, delivered: true };
      }

      const errorPayload = stdoutPayload?.ok === false ? stdoutPayload : stderrPayload;
      return {
        sent: false,
        delivered: false,
        error: String(errorPayload?.error ?? result.stderr ?? "send_failed").slice(0, 200),
      };
    } catch (err) {
      return { sent: false, delivered: false, error: String(err) };
    }
  }

  shouldUseThread(): boolean {
    return this.config.replyToMode !== "off";
  }

  normalizeUserId(rawId: string): string {
    return normalizeFeishuUserId(rawId);
  }
}
