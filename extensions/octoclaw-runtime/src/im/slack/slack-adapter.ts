import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, resolveWorkspaceRoot } from "../../resolve/env.js";
import type { IMAdapter, IMMessageTurnAnchorParams, IMProjectionFooter } from "../adapter.js";

type SlackCommandResult = {
  ok?: unknown;
  message?: {
    ts?: unknown;
    thread_ts?: unknown;
  };
  ts?: unknown;
  thread_ts?: unknown;
  error?: unknown;
};

export interface SlackDeliveryTarget {
  channel: "slack";
  target: string;
  threadTs?: string;
  replyToMessageId?: string;
}

export interface SlackSendResult {
  sent: boolean;
  delivered: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
}

export interface SlackAdapterConfig {
  replyToMode: "off" | "first" | "all";
  streamingMode: "off" | "partial" | "block" | "progress";
  nativeTransport: boolean;
}

export interface SlackGroupPolicy {
  allowDms?: boolean;
  allowlist?: string[];
}

export interface SlackToolExposureAudit {
  allowed: boolean;
  exposedTools: string[];
  blockedTools: string[];
}

const DEFAULT_SLACK_CONFIG: SlackAdapterConfig = {
  replyToMode: "off",
  streamingMode: "partial",
  nativeTransport: true,
};

export const SLACK_CAPABILITIES = {
  canUpdateMessage: true,
  canStreamNative: true,
  canReplyInThread: true,
  canTypingIndicator: true,
  messageIdFormat: "ts",
  userIdCaseSensitive: true,
  maxMessageLength: 40000,
};

const SLACK_SAFE_TOOL_ALLOWLIST = new Set([
  "message.send",
  "message.update",
  "message.react",
  "message.typing",
]);

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function readSlackBotToken(): string {
  const envToken = stringValue(process.env.SLACK_BOT_TOKEN || process.env.OPENCLAW_SLACK_BOT_TOKEN);
  if (envToken) return envToken;
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const channels = raw.channels && typeof raw.channels === "object" && !Array.isArray(raw.channels)
      ? raw.channels as Record<string, unknown>
      : {};
    const slack = channels.slack && typeof channels.slack === "object" && !Array.isArray(channels.slack)
      ? channels.slack as Record<string, unknown>
      : {};
    return stringValue(slack.botToken);
  } catch {
    return "";
  }
}

function normalizeEmojiName(emoji: string): string {
  return stringValue(emoji).replace(/^:+|:+$/gu, "") || "eyes";
}

function normalizeSlackMessageTs(value: unknown): string {
  const text = stringValue(value);
  if (!text || text === "0" || text === "0.0" || text.toLowerCase() === "root") return "";
  return /^\d{3,}(?:\.\d+)?$/u.test(text) ? text : "";
}

export function renderSlackProjectionFooter(message: string, projection: IMProjectionFooter): string {
  const content = stringValue(message);
  if (!content || /route=\w+\s*\|/u.test(content)) return message;
  const route = projection.route === "delegate" ? "delegate" : "reply";
  const model = stringValue(projection.model) || "direct_main";
  const primaryFooter = [`route=${route}`, `model=${model}`].join(" | ") + (projection.thread ? " · thread" : "");
  const debugParts = [
    stringValue(projection.workerPool) && `worker=${stringValue(projection.workerPool)}`,
    stringValue(projection.workContractId) && `wc=${stringValue(projection.workContractId).slice(0, 8)}`,
  ].filter(Boolean).join(" | ");
  const detailFooter = [
    stringValue(projection.via) && `via=${stringValue(projection.via)}`,
    debugParts,
  ].filter(Boolean).join(" | ");
  const footer = [primaryFooter, detailFooter].filter(Boolean).join(" | ");
  return `${content}\n\n• ${footer}`;
}

async function postSlackApi<T extends Record<string, unknown>>(
  method: string,
  token: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<T & { ok?: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await response.json() as T & { ok?: boolean; error?: string };
  } finally {
    clearTimeout(timer);
  }
}


function normalizePayload(value: unknown): SlackCommandResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ("ok" in record) {
    const message = record.message && typeof record.message === "object" && !Array.isArray(record.message)
      ? record.message as { ts?: unknown; thread_ts?: unknown }
      : undefined;
    return {
      ok: record.ok,
      message,
      ts: record.ts,
      thread_ts: record.thread_ts,
      error: record.error,
    };
  }
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const payloadRecord = payload as Record<string, unknown>;
  if (!("ok" in payloadRecord)) return null;
  const result = payloadRecord.result && typeof payloadRecord.result === "object" && !Array.isArray(payloadRecord.result)
    ? payloadRecord.result as Record<string, unknown>
    : {};
  return {
    ok: payloadRecord.ok,
    message: {
      ts: result.ts ?? result.messageId,
      thread_ts: result.thread_ts ?? result.threadTs,
    },
    ts: result.ts ?? result.messageId,
    thread_ts: result.thread_ts ?? result.threadTs,
    error: payloadRecord.error ?? result.error,
  };
}

function extractPayload(text: string): SlackCommandResult | null {
  if (!text) return null;

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const openBrace = text.indexOf("{", searchFrom);
    if (openBrace < 0) break;

    let braceDepth = 0;
    let closeBrace = openBrace;
    let insideString = false;
    let escaping = false;
    for (let position = openBrace; position < text.length; position++) {
      const character = text[position];
      if (escaping) { escaping = false; continue; }
      if (character === "\\") { escaping = true; continue; }
      if (character === '"') { insideString = !insideString; continue; }
      if (insideString) continue;
      if (character === "{") braceDepth++;
      if (character === "}") braceDepth--;
      if (braceDepth === 0) { closeBrace = position; break; }
    }
    if (braceDepth !== 0) { searchFrom = openBrace + 1; continue; }

    const candidate = text.slice(openBrace, closeBrace + 1);
    try {
      const payload = normalizePayload(JSON.parse(candidate));
      if (payload) return payload;
    } catch {}
    searchFrom = closeBrace + 1;
  }
  return null;
}

function parseSlackSessionKey(sessionKey: string): { kind: string; target: string; threadTs: string } {
  const parts = sessionKey.split(":").map((part) => part.trim());
  const slackIndex = parts.findIndex((part) => part.toLowerCase() === "slack");
  if (slackIndex < 0) return { kind: "", target: "", threadTs: "" };
  const kindIndex = ["dm", "direct", "user", "channel", "group", "room", "conversation", "space", "chat"].includes(stringValue(parts[slackIndex + 1]).toLowerCase())
    ? slackIndex + 1
    : slackIndex + 2;
  const kind = stringValue(parts[kindIndex]).toLowerCase();
  const target = stringValue(parts[kindIndex + 1]);
  const threadTs = stringValue(parts[kindIndex + 2]).toLowerCase() === "thread"
    ? normalizeSlackMessageTs(parts[kindIndex + 3])
    : "";
  return { kind, target, threadTs };
}

export function isSlackTargetAllowed(sessionKey: string, policy: SlackGroupPolicy = {}): boolean {
  const parsed = parseSlackSessionKey(sessionKey);
  if (!parsed.kind || !parsed.target) return false;
  if (parsed.kind === "dm" || parsed.kind === "direct") return policy.allowDms !== false;
  const allowlist = new Set((policy.allowlist ?? []).map((item) => item.trim().toUpperCase()).filter(Boolean));
  return allowlist.has(parsed.target.toUpperCase());
}

export function auditSlackFacingToolExposure(tools: string[]): SlackToolExposureAudit {
  const exposedTools = tools.map((tool) => tool.trim()).filter(Boolean);
  const blockedTools = exposedTools.filter((tool) => !SLACK_SAFE_TOOL_ALLOWLIST.has(tool));
  return { allowed: blockedTools.length === 0, exposedTools, blockedTools };
}

export class SlackAdapter implements IMAdapter {
  readonly channel = "slack" as const;
  readonly capabilityLevel = "L2" as const;
  readonly config: SlackAdapterConfig;

  constructor(config?: Partial<SlackAdapterConfig>) {
    this.config = { ...DEFAULT_SLACK_CONFIG, ...config };
  }

  canHandle(sessionKey: string): boolean {
    const lower = sessionKey.toLowerCase();
    return lower.startsWith("slack:") || lower.includes(":slack:");
  }

  resolveTarget(sessionKey: string): SlackDeliveryTarget {
    const parsed = parseSlackSessionKey(sessionKey);
    const userId = this.normalizeUserId(parsed.target);
    const threadTs = normalizeSlackMessageTs(parsed.threadTs);
    return {
      channel: "slack",
      target: userId,
      ...(threadTs ? { threadTs } : {}),
    };
  }

  private ackDebug(msg: string): void {
    if (process.env.OCTOCLAW_ACK_DEBUG === "1") {
      console.error(`[ack-thread] ${msg}`);
    }
  }

  renderProjectionFooter(message: string, projection: IMProjectionFooter): string {
    return renderSlackProjectionFooter(message, projection);
  }

  resolveMessageTurnAnchor(params: IMMessageTurnAnchorParams): string {
    const metadata = params.metadata ?? {};
    const state = params.state ?? {};
    const ctx = params.ctx ?? {};
    return normalizeSlackMessageTs(
      params.replyToMessageId
      || metadata.message_id
      || metadata.messageId
      || metadata.ts
      || metadata.messageTs
      || metadata.message_ts
      || metadata.reply_to_id
      || metadata.replyToMessageId
      || metadata.thread_ts
      || metadata.threadTs
      || state.message_id
      || state.messageId
      || state.inboundMessageTs
      || state.replyToMessageId
      || ctx.inboundMessageTs
      || ctx.message_id
      || ctx.messageId
      || ctx.replyToMessageId
      || ctx.threadTs
      || ctx.thread_ts,
    );
  }

  async react(params: {
    sessionKey: string;
    messageId: string;
    emoji: string;
    timeoutMs?: number;
    cwd?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    void params.cwd;
    const { sessionKey, messageId, emoji, timeoutMs = 2500 } = params;
    const target = this.resolveTarget(sessionKey);
    if (!target.target || !messageId) {
      return { ok: false, error: "missing_target_or_message_id" };
    }

    const token = readSlackBotToken();
    if (!token) {
      return { ok: false, error: "missing_slack_bot_token" };
    }

    try {
      const channelResult = await this.resolveReactionChannelId(target.target, token, Math.max(500, Math.floor(timeoutMs * 0.45)));
      if (!channelResult.channelId) {
        return { ok: false, error: channelResult.error || "reaction_channel_unresolved" };
      }
      const reaction = await postSlackApi<Record<string, unknown>>("reactions.add", token, {
        channel: channelResult.channelId,
        timestamp: messageId,
        name: normalizeEmojiName(emoji),
      }, Math.max(500, Math.floor(timeoutMs * 0.55)));
      if (reaction.ok === true || reaction.error === "already_reacted") {
        this.ackDebug(`react ok: emoji=${emoji} messageId=${messageId}`);
        return { ok: true };
      }
      this.ackDebug(`react failed: slack_error=${stringValue(reaction.error).slice(0, 80)}`);
      return { ok: false, error: stringValue(reaction.error) || "reaction_ack_failed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ackDebug(`react failed: ${message.slice(0, 80)}`);
      return { ok: false, error: message };
    }
  }

  private async resolveReactionChannelId(target: string, token: string, timeoutMs: number): Promise<{ channelId: string; error?: string }> {
    const normalized = stringValue(target).toUpperCase();
    if (/^[CDG][A-Z0-9]{8,}$/u.test(normalized)) {
      return { channelId: normalized };
    }
    if (!/^U[A-Z0-9]{8,}$/u.test(normalized)) {
      return { channelId: "", error: "unsupported_reaction_target" };
    }

    const opened = await postSlackApi<{ channel?: { id?: unknown } }>("conversations.open", token, {
      users: normalized,
    }, timeoutMs);
    const channelId = stringValue(opened.channel?.id).toUpperCase();
    if (opened.ok === true && channelId) {
      return { channelId };
    }
    return { channelId: "", error: stringValue(opened.error) || "dm_channel_unresolved" };
  }

  async send(params: {
    sessionKey: string;
    message: string;
    replyToMessageId?: string;
    timeoutMs?: number;
    cwd?: string;
    suppressProjectionFooter?: boolean;
    projectionFooter?: IMProjectionFooter;
  }): Promise<SlackSendResult> {
    const target = this.resolveTarget(params.sessionKey);
    if (!target.target) {
      return {
        sent: false,
        delivered: false,
        error: "unresolvable_session_target",
      };
    }

    const timeoutMs = Math.max(500, Number(params.timeoutMs || 5000));
    const message = params.suppressProjectionFooter || !params.projectionFooter
      ? params.message
      : this.renderProjectionFooter(params.message, params.projectionFooter);

    // When replyToMessageId is provided, always try --reply-to first so the ACK
    // lands in the user's thread.  This is independent of the replyToMode config
    // (which controls the general request flow).  For ACKs specifically, we want
    // every reply to thread under the user's inbound message.
    const replyToMessageId = normalizeSlackMessageTs(params.replyToMessageId);
    if (replyToMessageId) {
      this.ackDebug(`replyToMessageId=${replyToMessageId} — attempting threaded send`);
      const threadedResult = await this.executeSend(target, message, timeoutMs, params.cwd, replyToMessageId, params.suppressProjectionFooter);
      if (threadedResult.sent) {
        this.ackDebug("send succeeded (threaded)");
        return threadedResult;
      }
      this.ackDebug(`threaded attempt failed: ${threadedResult.error} — NOT retrying without --reply-to to avoid double delivery`);
      return threadedResult;
    }

    // No replyToMessageId — also try session-key-derived threadTs if present
    if (target.threadTs) {
      this.ackDebug(`no replyToMessageId but threadTs=${target.threadTs} — sending with --thread-id`);
    }

    const result = await this.executeSend(target, message, timeoutMs, params.cwd, undefined, params.suppressProjectionFooter);
    if (result.sent) {
      this.ackDebug("send succeeded (no reply-to, top-level or thread-id)");
    }
    return result;
  }

  private async executeSend(
    target: SlackDeliveryTarget,
    message: string,
    timeoutMs: number,
    cwd?: string,
    replyToMessageId?: string,
    suppressProjectionFooter?: boolean,
  ): Promise<SlackSendResult> {
    const args = ["message", "send", "--channel", "slack", "--target", target.target, "--json"];

    if (message) {
      args.push("--message", message);
    }

    const threadTs = normalizeSlackMessageTs(target.threadTs);
    if (threadTs) {
      args.push("--thread-id", threadTs);
    }

    const replyToTs = normalizeSlackMessageTs(replyToMessageId);
    if (replyToTs) {
      args.push("--reply-to", replyToTs);
    }

    try {
      const result = await runCommand("openclaw", args, {
        cwd: stringValue(cwd) || resolveWorkspaceRoot(),
        timeoutMs,
        env: suppressProjectionFooter ? { OCTOCLAW_INTERNAL_ACK_SEND: "1" } : undefined,
      });

      const stdoutPayload = extractPayload(result.stdout || "");
      const stderrPayload = extractPayload(result.stderr || "");
      const successPayload = (stdoutPayload?.ok === true) ? stdoutPayload
        : (stderrPayload?.ok === true) ? stderrPayload
        : null;

      if (successPayload) {
        const messageId = stringValue(successPayload.message?.ts || successPayload.ts);
        const threadTs = stringValue(successPayload.message?.thread_ts || successPayload.thread_ts || target.threadTs);
        return {
          sent: true,
          delivered: true,
          ...(messageId ? { messageId } : {}),
          ...(threadTs ? { threadTs } : {}),
        };
      }

      const explicitFailure = (stdoutPayload?.ok === false) ? stdoutPayload
        : (stderrPayload?.ok === false) ? stderrPayload
        : null;

      if (explicitFailure) {
        return {
          sent: false,
          delivered: false,
          error: stringValue(explicitFailure.error) || "send_failed",
        };
      }

      if (result.code === 0) {
        return { sent: true, delivered: true };
      }

      return {
        sent: false,
        delivered: false,
        error: result.stderr || "send_failed",
      };
    } catch (error) {
      return {
        sent: false,
        delivered: false,
        error: String(error),
      };
    }
  }

  shouldUseThread(): boolean {
    return this.config.replyToMode !== "off";
  }

  normalizeUserId(rawId: string): string {
    let id = rawId.trim();
    if (id.startsWith("user:")) {
      id = id.slice(5);
    }
    return id.toUpperCase();
  }

  extractMessageTs(inboundEvent: Record<string, unknown>): string {
    return stringValue(inboundEvent.ts || inboundEvent.messageTs || inboundEvent.messageId || "");
  }

  isStreamingAvailable(): boolean {
    return this.config.streamingMode !== "off" && this.config.nativeTransport;
  }
}

export { DEFAULT_SLACK_CONFIG };
