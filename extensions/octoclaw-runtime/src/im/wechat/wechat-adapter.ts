import { ERROR_CODES } from "@octoclaw/errors";
import { runCommand, resolveWorkspaceRoot } from "../../resolve/env.js";
import type { IMAdapter, IMDeliveryTarget, IMReactParams, IMReactResult, IMSendParams, IMSendResult } from "../adapter.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WeChatAdapterConfig {
  // L0 only — no threading, streaming, or special modes.
}

/**
 * WeChat L0 capability profile: plain text delivery only.
 * No threading, no streaming, no message editing, no typing indicators.
 * Max message length: 2048 characters (WeChat platform limit).
 */
export const WECHAT_CAPABILITIES = {
  canUpdateMessage: false,
  canStreamNative: false,
  canReplyInThread: false,
  canTypingIndicator: false,
  messageIdFormat: "message_id",
  userIdCaseSensitive: false,
  maxMessageLength: 2048,
} as const;

function normalizeWeChatUserId(rawId: string): string {
  let id = rawId.trim();
  if (id.startsWith("user:")) {
    id = id.slice(5);
  }
  return id;
}

function parseWeChatSessionKey(sessionKey: string): { target: string } {
  const parts = sessionKey.split(":").map((p) => p.trim());
  const wechatIndex = parts.findIndex((p) => p.toLowerCase() === "wechat");
  if (wechatIndex < 0) return { target: "" };

  const CONV_KINDS = new Set(["dm", "direct", "user", "channel", "group", "room", "conversation"]);
  const kindIndex = CONV_KINDS.has((parts[wechatIndex + 1] ?? "").toLowerCase())
    ? wechatIndex + 1
    : wechatIndex + 2;

  const target = normalizeWeChatUserId(parts[kindIndex + 1] ?? "");
  return { target };
}

function extractWeChatPayload(text: string): Record<string, unknown> | null {
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
      if ("ok" in parsed || "message_id" in parsed || "msgid" in parsed) {
        return parsed;
      }
    } catch { /* skip non-JSON fragments */ }
    searchFrom = close + 1;
  }
  return null;
}

/**
 * IM adapter for WeChat (L0 tier).
 * Delivers plain text only. No threading, streaming, reactions, or rich media.
 * Messages over 2048 characters are truncated to the platform limit.
 */
export class WeChatAdapter implements IMAdapter {
  readonly channel = "wechat" as const;
  readonly capabilityLevel = "L0" as const;
  readonly config: WeChatAdapterConfig;

  constructor(config?: Partial<WeChatAdapterConfig>) {
    this.config = { ...config };
  }

  canHandle(sessionKey: string): boolean {
    const lower = sessionKey.toLowerCase();
    return lower.startsWith("wechat:") || lower.includes(":wechat:");
  }

  resolveTarget(sessionKey: string): IMDeliveryTarget {
    const parsed = parseWeChatSessionKey(sessionKey);
    return { channel: "wechat", target: parsed.target };
  }

  /** WeChat L0 does not support emoji reactions. */
  async react(_params: IMReactParams): Promise<IMReactResult> {
    return { ok: false, error: "not_supported" };
  }

  async send(params: IMSendParams): Promise<IMSendResult> {
    const { sessionKey, message, timeoutMs = 5000, cwd } = params;
    const target = this.resolveTarget(sessionKey);

    if (!target.target) {
      return { sent: false, delivered: false, error: ERROR_CODES.IM_UNRESOLVABLE_TARGET };
    }

    // L0: truncate to 2048 chars; never pass replyToMessageId (no threading)
    const text = message.slice(0, WECHAT_CAPABILITIES.maxMessageLength);
    const args = ["message", "send", "--channel", "wechat", "--target", target.target, "--json"];

    if (text) {
      args.push("--message", text);
    }

    try {
      const result = await runCommand("openclaw", args, {
        cwd: cwd ?? resolveWorkspaceRoot(),
        timeoutMs: Math.max(500, timeoutMs),
      });

      const stdoutPayload = extractWeChatPayload(result.stdout ?? "");
      const stderrPayload = extractWeChatPayload(result.stderr ?? "");
      const successPayload = stdoutPayload?.ok === true ? stdoutPayload
        : stderrPayload?.ok === true ? stderrPayload
        : null;

      if (successPayload) {
        const messageId = (successPayload.message_id ?? successPayload.msgid);
        return {
          sent: true,
          delivered: true,
          ...(messageId ? { messageId: String(messageId) } : {}),
        };
      }

      if (result.code === 0) {
        return { sent: true, delivered: true };
      }

      const errorPayload = stdoutPayload?.ok === false ? stdoutPayload : stderrPayload;
      return {
        sent: false,
        delivered: false,
        error: String(errorPayload?.error ?? result.stderr ?? ERROR_CODES.IM_SEND_FAILED).slice(0, 200),
      };
    } catch (err) {
      return { sent: false, delivered: false, error: String(err) };
    }
  }
}
