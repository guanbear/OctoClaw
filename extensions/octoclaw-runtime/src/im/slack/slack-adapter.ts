import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runCommand, resolveWorkspaceRoot } from "../../resolve/env.js";
import { firstDisplayModel } from "../../model-display.js";
import { hasProjectionFooter, OCTOCLAW_PROJECTION_FOOTER_PREFIX } from "../../projection-footer-sanitizer.js";
import type { IMAdapter, IMMessageTurnAnchorParams, IMProjectionFooter, IMSendParams } from "../adapter.js";
import type { MessageDeliveryEnvelope, MessageDeliveryResult } from "../delivery-port.js";

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
  transport?: "slack_api" | "slack_api_stream" | "legacy_cli";
  targetSource?: string;
  footerSource?: string;
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
    const direct = stringValue(slack.botToken || slack.token);
    if (direct) return direct;
    const accounts = slack.accounts && typeof slack.accounts === "object" && !Array.isArray(slack.accounts)
      ? slack.accounts as Record<string, unknown>
      : {};
    const defaultAccount = accounts.default && typeof accounts.default === "object" && !Array.isArray(accounts.default)
      ? accounts.default as Record<string, unknown>
      : {};
    const defaultToken = stringValue(defaultAccount.botToken || defaultAccount.token);
    if (defaultToken) return defaultToken;
    for (const entry of Object.values(accounts)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const token = stringValue((entry as Record<string, unknown>).botToken || (entry as Record<string, unknown>).token);
      if (token) return token;
    }
    return "";
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

function shouldUseIsolatedSlackApi(): boolean {
  if (process.env.OCTOCLAW_SLACK_DIRECT_API_ISOLATED === "0") return false;
  if (process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test") return false;
  return true;
}

const SLACK_API_CHILD_SOURCE = `
const fs = require("node:fs");
(async () => {
  let timer;
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (typeof fetch !== "function") {
      console.log(JSON.stringify({ ok: false, error: "fetch_unavailable" }));
      return;
    }
    const method = String(input.method || "");
    const token = String(input.token || "");
    const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
    const timeoutMs = Math.max(500, Number(input.timeoutMs || 2500));
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch("https://slack.com/api/" + method, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    try {
      JSON.parse(text);
      console.log(text);
    } catch {
      console.log(JSON.stringify({ ok: false, error: "non_json_slack_response" }));
    }
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    console.log(JSON.stringify({ ok: false, error: message || "slack_api_child_failed" }));
  } finally {
    if (timer) clearTimeout(timer);
  }
})();
`;

function postSlackApiIsolated<T extends Record<string, unknown>>(
  method: string,
  token: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): T & { ok?: boolean; error?: string } {
  const apiTimeoutMs = Math.max(500, timeoutMs);
  const child = spawnSync(process.execPath, ["-e", SLACK_API_CHILD_SOURCE], {
    input: JSON.stringify({ method, token, payload, timeoutMs: apiTimeoutMs }),
    encoding: "utf8",
    timeout: Math.min(Math.max(apiTimeoutMs + 500, 1000), 5000),
    maxBuffer: 1024 * 1024,
  });
  if (child.error) {
    return { ok: false, error: child.error.message || "slack_api_child_error" } as T & { ok?: boolean; error?: string };
  }
  const stdout = stringValue(child.stdout);
  if (!stdout) {
    return { ok: false, error: stringValue(child.stderr) || "slack_api_child_empty_response" } as T & { ok?: boolean; error?: string };
  }
  try {
    return JSON.parse(stdout) as T & { ok?: boolean; error?: string };
  } catch {
    return { ok: false, error: "slack_api_child_invalid_json" } as T & { ok?: boolean; error?: string };
  }
}

function legacyCliDeliveryEnabled(): boolean {
  const raw = stringValue(process.env.OCTOCLAW_LEGACY_CLI_DELIVERY).toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}

const SLACK_API_TEXT_CHUNK_LIMIT = 39000;
const SLACK_STREAM_TEXT_LIMIT = 12000;

function splitSlackText(message: string): string[] {
  const text = String(message ?? "");
  if (!text) return [];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += SLACK_API_TEXT_CHUNK_LIMIT) {
    chunks.push(text.slice(index, index + SLACK_API_TEXT_CHUNK_LIMIT));
  }
  return chunks;
}

function splitSlackStreamText(message: string): string[] {
  const text = String(message ?? "");
  if (!text) return [];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += SLACK_STREAM_TEXT_LIMIT) {
    chunks.push(text.slice(index, index + SLACK_STREAM_TEXT_LIMIT));
  }
  return chunks;
}

function slackTargetSource(params: { replyToMessageId?: string; threadTs?: string }): "inbound_anchor" | "event_metadata" | "session_fallback" {
  if (normalizeSlackMessageTs(params.replyToMessageId)) return "inbound_anchor";
  if (normalizeSlackMessageTs(params.threadTs)) return "event_metadata";
  return "session_fallback";
}

function envelopeProjectionFooter(envelope: MessageDeliveryEnvelope): IMProjectionFooter | null {
  if (envelope.footerMode !== "debug" || !envelope.provenance) return null;
  return {
    route: envelope.provenance.route === "delegate" ? "delegate" : "reply",
    model: firstDisplayModel(envelope.provenance.model, envelope.provenance.modelId, "direct_main"),
    via: envelope.provenance.via,
    workContractId: envelope.provenance.workContractId,
    thread: Boolean(normalizeSlackMessageTs(envelope.target.replyToMessageId || envelope.target.threadTs)),
  };
}

function applyEnvelopeFooter(envelope: MessageDeliveryEnvelope): { content: string; footerSource: "envelope" | "adapter" | "none" } {
  const projection = envelopeProjectionFooter(envelope);
  if (!projection) {
    return {
      content: envelope.content,
      footerSource: envelope.footerMode === "debug" && hasProjectionFooter(envelope.content) ? "adapter" : "none",
    };
  }
  const rendered = renderSlackProjectionFooter(envelope.content, projection);
  return {
    content: rendered,
    footerSource: rendered !== envelope.content ? "envelope" : "adapter",
  };
}

export function renderSlackProjectionFooter(message: string, projection: IMProjectionFooter): string {
  const content = stringValue(message);
  if (!content || hasProjectionFooter(content)) return message;
  const route = projection.route === "delegate" ? "delegate" : "reply";
  const model = firstDisplayModel(projection.model, "direct_main");
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
  return `${content}\n\n• ${OCTOCLAW_PROJECTION_FOOTER_PREFIX} ${footer}`;
}

async function postSlackApi<T extends Record<string, unknown>>(
  method: string,
  token: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<T & { ok?: boolean; error?: string }> {
  if (shouldUseIsolatedSlackApi()) {
    return postSlackApiIsolated<T>(method, token, payload, timeoutMs);
  }
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

  async send(params: IMSendParams): Promise<SlackSendResult> {
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
    const replyToMessageId = normalizeSlackMessageTs(params.replyToMessageId);
    const source = params.deliveryTargetSource ?? slackTargetSource({ replyToMessageId, threadTs: target.threadTs });
    const footerMode = params.footerMode ?? (params.projectionFooter && !params.suppressProjectionFooter ? "debug" : "off");
    const result = await this.sendText({
      kind: params.deliveryKind ?? (params.suppressProjectionFooter ? "neutral_ack" : "legacy_fallback"),
      channel: "slack",
      target: {
        to: target.target,
        threadTs: normalizeSlackMessageTs(target.threadTs) || undefined,
        replyToMessageId: replyToMessageId || undefined,
        source,
      },
      content: message,
      interactiveBlocks: params.interactiveBlocks,
      provenance: params.deliveryProvenance,
      footerMode,
      dedupeKey: params.dedupeKey,
    }, { timeoutMs, cwd: params.cwd, suppressProjectionFooter: params.suppressProjectionFooter });

    if (result.ok) {
      this.ackDebug(replyToMessageId ? "send succeeded (threaded)" : "send succeeded (slack delivery port)");
    }
    return {
      sent: result.ok,
      delivered: result.ok,
      messageId: result.messageId,
      threadTs: result.threadTs,
      error: result.error,
      transport: result.transport as SlackSendResult["transport"],
      targetSource: result.targetSource,
      footerSource: result.footerSource,
    };
  }

  async sendText(
    envelope: MessageDeliveryEnvelope,
    options: { timeoutMs?: number; cwd?: string; suppressProjectionFooter?: boolean } = {},
  ): Promise<MessageDeliveryResult> {
    const target = this.resolveEnvelopeTarget(envelope);
    if (!target.target) {
      return {
        ok: false,
        error: "unresolvable_session_target",
        transport: legacyCliDeliveryEnabled() ? "legacy_cli" : "slack_api",
        targetSource: envelope.target.source,
        footerSource: envelope.footerMode === "debug" ? "envelope" : "none",
      };
    }

    const timeoutMs = Math.max(500, Number(options.timeoutMs || 5000));
    const replyToMessageId = normalizeSlackMessageTs(envelope.target.replyToMessageId);
    const projected = applyEnvelopeFooter(envelope);
    const result = legacyCliDeliveryEnabled()
      ? await this.executeLegacyCliSend(target, projected.content, timeoutMs, options.cwd, replyToMessageId || undefined, options.suppressProjectionFooter)
      : await this.executeSlackApiSend(target, projected.content, timeoutMs, envelope.kind, envelope.interactiveBlocks);

    return {
      ok: result.sent || result.delivered,
      messageId: result.messageId,
      threadTs: result.threadTs,
      error: result.error,
      transport: result.transport,
      targetSource: envelope.target.source,
      footerSource: projected.footerSource,
    };
  }

  private resolveEnvelopeTarget(envelope: MessageDeliveryEnvelope): SlackDeliveryTarget {
    const to = stringValue(envelope.target.channelId || envelope.target.to).toUpperCase();
    return {
      channel: "slack",
      target: to,
      threadTs: normalizeSlackMessageTs(envelope.target.replyToMessageId || envelope.target.threadTs) || undefined,
      replyToMessageId: normalizeSlackMessageTs(envelope.target.replyToMessageId) || undefined,
    };
  }

  private async executeLegacyCliSend(
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
          transport: "legacy_cli",
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
          transport: "legacy_cli",
        };
      }

      if (result.code === 0) {
        return { sent: true, delivered: true, transport: "legacy_cli" };
      }

      return {
        sent: false,
        delivered: false,
        error: result.stderr || "send_failed",
        transport: "legacy_cli",
      };
    } catch (error) {
      return {
        sent: false,
        delivered: false,
        error: String(error),
        transport: "legacy_cli",
      };
    }
  }

  private async executeSlackApiSend(
    target: SlackDeliveryTarget,
    message: string,
    timeoutMs: number,
    deliveryKind?: string,
    interactiveBlocks?: Array<Record<string, unknown>>,
  ): Promise<SlackSendResult> {
    const token = readSlackBotToken();
    if (!token) {
      return { sent: false, delivered: false, error: "missing_slack_bot_token", transport: "slack_api" };
    }

    const channelResult = await this.resolveReactionChannelId(target.target, token, Math.max(500, Math.floor(timeoutMs * 0.35)));
    if (!channelResult.channelId) {
      return { sent: false, delivered: false, error: channelResult.error || "send_channel_unresolved", transport: "slack_api" };
    }

    const blocks = Array.isArray(interactiveBlocks) && interactiveBlocks.length > 0 ? interactiveBlocks : undefined;
    const chunks = splitSlackText(message);
    if (!chunks.length) {
      return { sent: false, delivered: false, error: "empty_message", transport: "slack_api" };
    }

    const threadTs = normalizeSlackMessageTs(target.replyToMessageId || target.threadTs);
    if (!blocks && deliveryKind === "native_child_final" && this.isStreamingAvailable() && threadTs) {
      const streamed = await this.executeSlackApiStream(channelResult.channelId, message, threadTs, token, timeoutMs);
      if (streamed.sent || streamed.delivered) return streamed;
    }

    let lastMessageId = "";
    for (const chunk of chunks) {
      try {
        const response = await postSlackApi<{ ts?: unknown; message?: { ts?: unknown; thread_ts?: unknown } }>("chat.postMessage", token, {
          channel: channelResult.channelId,
          text: chunk,
          ...(blocks && chunk === chunks[0] ? { blocks } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }, Math.max(500, timeoutMs));
        if (response.ok !== true) {
          return { sent: false, delivered: false, error: stringValue(response.error) || "send_failed", transport: "slack_api" };
        }
        lastMessageId = stringValue(response.ts || response.message?.ts || lastMessageId);
      } catch (error) {
        return { sent: false, delivered: false, error: String(error), transport: "slack_api" };
      }
    }

    return {
      sent: true,
      delivered: true,
      ...(lastMessageId ? { messageId: lastMessageId } : {}),
      ...(threadTs ? { threadTs } : {}),
      transport: "slack_api",
    };
  }

  private async executeSlackApiStream(
    channelId: string,
    message: string,
    threadTs: string,
    token: string,
    timeoutMs: number,
  ): Promise<SlackSendResult> {
    const chunks = splitSlackStreamText(message);
    if (!chunks.length) {
      return { sent: false, delivered: false, error: "empty_message", transport: "slack_api_stream" };
    }
    try {
      const started = await postSlackApi<{
        channel?: unknown;
        ts?: unknown;
        message?: { ts?: unknown; thread_ts?: unknown };
      }>("chat.startStream", token, {
        channel: channelId,
        thread_ts: threadTs,
        markdown_text: chunks[0],
      }, Math.max(500, timeoutMs));
      if (started.ok !== true) {
        return { sent: false, delivered: false, error: stringValue(started.error) || "stream_start_failed", transport: "slack_api_stream" };
      }
      const streamTs = normalizeSlackMessageTs(started.ts || started.message?.ts);
      if (!streamTs) {
        return { sent: false, delivered: false, error: "stream_missing_ts", transport: "slack_api_stream" };
      }
      for (const chunk of chunks.slice(1)) {
        const appended = await postSlackApi("chat.appendStream", token, {
          channel: channelId,
          ts: streamTs,
          markdown_text: chunk,
        }, Math.max(500, timeoutMs));
        if (appended.ok !== true) {
          await postSlackApi("chat.stopStream", token, { channel: channelId, ts: streamTs }, Math.max(500, Math.floor(timeoutMs * 0.5))).catch(() => {});
          return { sent: false, delivered: false, error: stringValue(appended.error) || "stream_append_failed", transport: "slack_api_stream" };
        }
      }
      const stopped = await postSlackApi("chat.stopStream", token, {
        channel: channelId,
        ts: streamTs,
      }, Math.max(500, timeoutMs));
      if (stopped.ok !== true) {
        return { sent: false, delivered: false, error: stringValue(stopped.error) || "stream_stop_failed", transport: "slack_api_stream" };
      }
      return {
        sent: true,
        delivered: true,
        messageId: streamTs,
        threadTs,
        transport: "slack_api_stream",
      };
    } catch (error) {
      return {
        sent: false,
        delivered: false,
        error: String(error),
        transport: "slack_api_stream",
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
