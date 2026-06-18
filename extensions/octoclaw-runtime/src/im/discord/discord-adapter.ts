import { ERROR_CODES } from "@octoclaw/errors";
import { runCommand, resolveWorkspaceRoot } from "../../resolve/env.js";
import type { IMAdapter, IMDeliveryTarget, IMProjectionFooter, IMReactParams, IMReactResult, IMSendParams, IMSendResult } from "../adapter.js";
import { formatFooterModelToken, formatFooterTimeToken } from "../footer-tokens.js";
import { splitIMText } from "../text-split.js";

export const DISCORD_CAPABILITIES = {
  canUpdateMessage: false,
  canStreamNative: false,
  canReplyInThread: true,
  canTypingIndicator: false,
  messageIdFormat: "snowflake",
  userIdCaseSensitive: true,
  maxMessageLength: 2000,
} as const;

export interface DiscordAdapterConfig {
  footerMode?: "plain";
}

type DiscordPayload = {
  ok?: unknown;
  message_id?: unknown;
  messageId?: unknown;
  id?: unknown;
  message?: {
    id?: unknown;
  };
  error?: unknown;
};

function findPart(parts: string[], key: string): string {
  const index = parts.findIndex((part) => part.toLowerCase() === key);
  return index >= 0 ? (parts[index + 1] ?? "").trim() : "";
}

function parseDiscordSessionKey(sessionKey: string): { channelId: string; threadId: string } {
  const parts = sessionKey.split(":").map((part) => part.trim());
  const discordIndex = parts.findIndex((part) => part.toLowerCase() === "discord");
  if (discordIndex < 0) return { channelId: "", threadId: "" };

  const discordParts = parts.slice(discordIndex + 1);
  return {
    channelId: findPart(discordParts, "channel"),
    threadId: findPart(discordParts, "thread"),
  };
}

function extractDiscordPayload(text: string): DiscordPayload | null {
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
      const parsed = JSON.parse(text.slice(openBrace, close + 1)) as DiscordPayload;
      if ("ok" in parsed || "message_id" in parsed || "messageId" in parsed || "id" in parsed) return parsed;
    } catch { /* skip non-JSON fragments */ }
    searchFrom = close + 1;
  }
  return null;
}

function discordMessageId(payload: DiscordPayload | null): string | undefined {
  const value = payload?.message_id ?? payload?.messageId ?? payload?.id ?? payload?.message?.id;
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function firstDiscordEmbed(blocks?: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  for (const block of blocks ?? []) {
    if (String(block.type ?? "").toLowerCase() !== "discord_embed") continue;
    const embed = block.embed;
    if (embed && typeof embed === "object" && !Array.isArray(embed)) {
      return embed as Record<string, unknown>;
    }
  }
  return undefined;
}

function parseSendResult(code: number, stdout: string, stderr: string): IMSendResult {
  const stdoutPayload = extractDiscordPayload(stdout);
  const stderrPayload = extractDiscordPayload(stderr);
  const successPayload = stdoutPayload?.ok === true ? stdoutPayload
    : stderrPayload?.ok === true ? stderrPayload
    : null;

  if (successPayload) {
    const messageId = discordMessageId(successPayload);
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
    error: String(errorPayload?.error ?? stderr ?? ERROR_CODES.IM_SEND_FAILED).slice(0, 200),
  };
}

function renderDiscordProjectionFooter(message: string, projection: IMProjectionFooter): string {
  const route = projection.route === "delegate" ? "delegate" : "reply";
  const parts = [`route=${route}`, `model=${formatFooterModelToken(projection)}`];
  const timeToken = formatFooterTimeToken(projection);
  if (timeToken) parts.push(timeToken);
  if (projection.thread) parts.push("thread");
  if (projection.workContractId) parts.push(`wc=${projection.workContractId.slice(0, 8)}`);
  return `${message}\n\n🤖 ${parts.join(" | ")}`;
}

export class DiscordAdapter implements IMAdapter {
  readonly channel = "discord" as const;
  readonly capabilityLevel = "L2" as const;
  readonly config: DiscordAdapterConfig;

  constructor(config?: Partial<DiscordAdapterConfig>) {
    this.config = { ...config };
  }

  canHandle(sessionKey: string): boolean {
    const lower = sessionKey.toLowerCase();
    return lower.startsWith("discord:") || lower.includes(":discord:");
  }

  resolveTarget(sessionKey: string): IMDeliveryTarget {
    const parsed = parseDiscordSessionKey(sessionKey);
    return {
      channel: "discord",
      target: parsed.channelId,
      ...(parsed.threadId ? { threadTs: parsed.threadId } : {}),
    };
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
    const embed = firstDiscordEmbed(interactiveBlocks);
    const segments = splitIMText(message, DISCORD_CAPABILITIES.maxMessageLength);
    const sends = segments.length > 0 ? segments : [""];
    let lastResult: IMSendResult = { sent: true, delivered: true };

    for (const [index, segment] of sends.entries()) {
      const args = ["message", "send", "--channel", "discord", "--target", target.target, "--json"];
      if (target.threadTs) {
        args.push("--thread", target.threadTs);
      }
      if (replyToMessageId && index === 0) {
        args.push("--reply-to", replyToMessageId);
      }
      if (embed && index === 0) {
        args.push("--embed", JSON.stringify(embed));
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

  async react(params: IMReactParams): Promise<IMReactResult> {
    const { messageId, emoji, timeoutMs = 5000, cwd } = params;
    try {
      const result = await runCommand("openclaw", [
        "message", "react",
        "--channel", "discord",
        "--message-id", messageId,
        "--emoji", emoji,
        "--json",
      ], {
        cwd: cwd ?? resolveWorkspaceRoot(),
        timeoutMs: Math.max(500, timeoutMs),
      });
      const payload = extractDiscordPayload(result.stdout ?? "") ?? extractDiscordPayload(result.stderr ?? "");
      if (payload?.ok === false) {
        return { ok: false, error: String(payload.error ?? "react_failed") };
      }
      return { ok: result.code === 0, ...(result.code === 0 ? {} : { error: String(result.stderr || "react_failed") }) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  renderProjectionFooter(message: string, projection: IMProjectionFooter): string {
    return renderDiscordProjectionFooter(message, projection);
  }
}
