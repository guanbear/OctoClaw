import { SlackAdapter } from "./slack/index.js";
import type { SlackAdapterConfig } from "./slack/index.js";
import { FeishuAdapter } from "./feishu/index.js";
import type { FeishuAdapterConfig } from "./feishu/index.js";
import { WeChatAdapter } from "./wechat/index.js";
import type { IMAdapter, IMSendParams, IMSendResult } from "./adapter.js";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

export type { IMAdapter } from "./adapter.js";
export type { MessageDeliveryEnvelope, MessageDeliveryPort, MessageDeliveryResult } from "./delivery-port.js";

const adapterRegistry: IMAdapter[] = [];

function readOpenclawConfig(): Record<string, unknown> {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    return JSON.parse(fsSync.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readChannelConfig(channel: string): Record<string, unknown> {
  const raw = readOpenclawConfig();
  const channels = raw.channels as Record<string, unknown> | undefined;
  return (channels?.[channel] as Record<string, unknown> | undefined) ?? {};
}

function readReplyToMode(channel: string): "off" | "first" | "all" {
  const config = readChannelConfig(channel);
  const mode = String(config.replyToMode || "off").toLowerCase();
  if (mode === "first" || mode === "all") return mode;
  return "off";
}

function buildSlackAdapterConfig(): Partial<SlackAdapterConfig> {
  return { replyToMode: readReplyToMode("slack") };
}

function buildFeishuAdapterConfig(): Partial<FeishuAdapterConfig> {
  return { replyToMode: readReplyToMode("feishu") };
}

export function getAdapterForSession(sessionKey: string): IMAdapter | null {
  return adapterRegistry.find((adapter) => adapter.canHandle(sessionKey)) ?? null;
}

export function getAdapterForChannel(channel: string): IMAdapter | null {
  const normalized = String(channel || "").trim().toLowerCase();
  if (!normalized) return null;
  return adapterRegistry.find((adapter) => adapter.channel.toLowerCase() === normalized) ?? null;
}

export function registerIMAdapter(adapter: IMAdapter): void {
  adapterRegistry.unshift(adapter);
}

/**
 * Send with graceful L2→L1→L0 degradation.
 *
 * Tier behaviour:
 *   L2/L1: attempt with full params (including replyToMessageId for threading)
 *   If threading fails → retry without replyToMessageId (drop to L0 plain-text)
 *
 * Returns the result plus an optional `degraded: true` flag when a fallback
 * was used so callers can emit telemetry.
 */
export async function sendWithDegradation(
  adapter: IMAdapter,
  params: IMSendParams,
): Promise<IMSendResult & { degraded?: boolean }> {
  const result = await adapter.send(params);
  if (result.sent) return result;

  if (params.replyToMessageId && adapter.channel === "slack") {
    return result;
  }

  if (params.replyToMessageId) {
    const degraded = await adapter.send({ ...params, replyToMessageId: undefined });
    if (degraded.sent) {
      return { ...degraded, degraded: true };
    }
  }

  return result;
}

// Register built-in adapters.
// Order matters: first match wins. Slack and Feishu are registered last so
// any custom adapters prepended via registerIMAdapter() take priority.
adapterRegistry.push(new SlackAdapter(buildSlackAdapterConfig()));
adapterRegistry.push(new FeishuAdapter(buildFeishuAdapterConfig()));
adapterRegistry.push(new WeChatAdapter());

export { SlackAdapter } from "./slack/index.js";
export type { SlackAdapterConfig } from "./slack/index.js";
export { FeishuAdapter } from "./feishu/index.js";
export type { FeishuAdapterConfig } from "./feishu/index.js";
export { WeChatAdapter } from "./wechat/index.js";
export type { WeChatAdapterConfig } from "./wechat/index.js";
