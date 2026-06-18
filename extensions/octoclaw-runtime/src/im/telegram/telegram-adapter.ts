import { ERROR_CODES } from "@octoclaw/errors";
import { runCommand, resolveWorkspaceRoot } from "../../resolve/env.js";
import type { IMAdapter, IMDeliveryTarget, IMProjectionFooter, IMReactParams, IMReactResult, IMSendParams, IMSendResult } from "../adapter.js";
import { formatFooterModelToken, formatFooterTimeToken } from "../footer-tokens.js";
import { splitIMText } from "../text-split.js";

export const TELEGRAM_CAPABILITIES = {
  canUpdateMessage: false,
  canStreamNative: false,
  canReplyInThread: true,
  canTypingIndicator: false,
  messageIdFormat: "message_id",
  userIdCaseSensitive: false,
  maxMessageLength: 4096,
} as const;

export interface TelegramAdapterConfig {
  footerMode?: "plain";
}

type TelegramPayload = {
  ok?: unknown;
  message_id?: unknown;
  messageId?: unknown;
  result?: {
    message_id?: unknown;
  };
  error?: unknown;
  description?: unknown;
};

function findPart(parts: string[], key: string): string {
  const index = parts.findIndex((part) => part.toLowerCase() === key);
  return index >= 0 ? (parts[index + 1] ?? "").trim() : "";
}

function parseTelegramSessionKey(sessionKey: string): { chatId: string } {
  const parts = sessionKey.split(":").map((part) => part.trim());
  const telegramIndex = parts.findIndex((part) => part.toLowerCase() === "telegram");
  if (telegramIndex < 0) return { chatId: "" };
  return { chatId: findPart(parts.slice(telegramIndex + 1), "chat") };
}

function extractTelegramPayload(text: string): TelegramPayload | null {
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

    try {
      const parsed = JSON.parse(text.slice(openBrace, close + 1)) as TelegramPayload;
      if ("ok" in parsed || "message_id" in parsed || "messageId" in parsed || "result" in parsed) return parsed;
    } catch { /* skip non-JSON fragments */ }
    searchFrom = close + 1;
  }
  return null;
}

function telegramMessageId(payload: TelegramPayload | null): string | undefined {
  const value = payload?.message_id ?? payload?.messageId ?? payload?.result?.message_id;
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function firstTelegramMarkup(blocks?: Array<Record<string, unknown>>): { replyMarkup: Record<string, unknown>; parseMode?: string } | undefined {
  for (const block of blocks ?? []) {
    if (String(block.type ?? "").toLowerCase() !== "telegram_reply_markup") continue;
    const replyMarkup = block.reply_markup;
    if (!replyMarkup || typeof replyMarkup !== "object" || Array.isArray(replyMarkup)) continue;
    const parseMode = String(block.parse_mode ?? "").trim();
    return {
      replyMarkup: replyMarkup as Record<string, unknown>,
      ...(parseMode ? { parseMode } : {}),
    };
  }
  return undefined;
}

function parseSendResult(code: number, stdout: string, stderr: string): IMSendResult {
  const stdoutPayload = extractTelegramPayload(stdout);
  const stderrPayload = extractTelegramPayload(stderr);
  const successPayload = stdoutPayload?.ok === true ? stdoutPayload
    : stderrPayload?.ok === true ? stderrPayload
    : null;

  if (successPayload) {
    const messageId = telegramMessageId(successPayload);
    return {
      sent: true,
      delivered: true,
      ...(messageId ? { messageId } : {}),
    };
  }

  if (code === 0) return { sent: true, delivered: true };

  const errorPayload = stdoutPayload?.ok === false ? stdoutPayload : stderrPayload;
  return {
    sent: false,
    delivered: false,
    error: String(errorPayload?.error ?? errorPayload?.description ?? stderr ?? ERROR_CODES.IM_SEND_FAILED).slice(0, 200),
  };
}

function renderTelegramProjectionFooter(message: string, projection: IMProjectionFooter): string {
  const route = projection.route === "delegate" ? "delegate" : "reply";
  const parts = [`route=${route}`, `model=${formatFooterModelToken(projection)}`];
  const timeToken = formatFooterTimeToken(projection);
  if (timeToken) parts.push(timeToken);
  if (projection.thread) parts.push("thread");
  if (projection.workContractId) parts.push(`wc=${projection.workContractId.slice(0, 8)}`);
  return `${message}\n\n🤖 ${parts.join(" | ")}`;
}

export class TelegramAdapter implements IMAdapter {
  readonly channel = "telegram" as const;
  readonly capabilityLevel = "L1" as const;
  readonly config: TelegramAdapterConfig;

  constructor(config?: Partial<TelegramAdapterConfig>) {
    this.config = { ...config };
  }

  canHandle(sessionKey: string): boolean {
    const lower = sessionKey.toLowerCase();
    return lower.startsWith("telegram:") || lower.includes(":telegram:");
  }

  resolveTarget(sessionKey: string): IMDeliveryTarget {
    const parsed = parseTelegramSessionKey(sessionKey);
    return { channel: "telegram", target: parsed.chatId };
  }

  async send(params: IMSendParams): Promise<IMSendResult> {
    const { sessionKey, interactiveBlocks, replyToMessageId, timeoutMs = 5000, cwd } = params;
    const target = this.resolveTarget(sessionKey);
    if (!target.target) {
      return { sent: false, delivered: false, error: ERROR_CODES.IM_UNRESOLVABLE_TARGET };
    }

    const message = params.projectionFooter && !params.suppressProjectionFooter
      ? this.renderProjectionFooter(params.message, params.projectionFooter)
      : params.message;
    const markup = firstTelegramMarkup(interactiveBlocks);
    const segments = splitIMText(message, TELEGRAM_CAPABILITIES.maxMessageLength);
    const sends = segments.length > 0 ? segments : [""];
    let lastResult: IMSendResult = { sent: true, delivered: true };

    for (const [index, segment] of sends.entries()) {
      const args = ["message", "send", "--channel", "telegram", "--target", target.target, "--json"];
      if (replyToMessageId && index === 0) {
        args.push("--reply-to", replyToMessageId);
      }
      if (markup && index === 0) {
        if (markup.parseMode) {
          args.push("--parse-mode", markup.parseMode);
        }
        args.push("--reply-markup", JSON.stringify(markup.replyMarkup));
      }
      if (segment) {
        args.push("--message", segment);
      }

      try {
        const result = await runCommand("openclaw", args, {
          cwd: cwd ?? resolveWorkspaceRoot(),
          timeoutMs: Math.max(500, timeoutMs),
        });
        lastResult = parseSendResult(result.code, result.stdout ?? "", result.stderr ?? "");
        if (!lastResult.sent) return lastResult;
      } catch (err) {
        return { sent: false, delivered: false, error: String(err) };
      }
    }

    return lastResult;
  }

  async react(_params: IMReactParams): Promise<IMReactResult> {
    return { ok: false, error: "not_supported" };
  }

  renderProjectionFooter(message: string, projection: IMProjectionFooter): string {
    return renderTelegramProjectionFooter(message, projection);
  }
}
