/**
 * Fetches the latest user message ts from a Slack DM channel via the Web API.
 * Used as a fallback when OpenClaw doesn't pass inboundMessageTs in the hook ctx.
 *
 * Result is cached per channel for 10 seconds to avoid hammering the API
 * on rapid messages.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface SlackHistoryMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
}

interface SlackHistoryResponse {
  ok: boolean;
  messages?: SlackHistoryMessage[];
  error?: string;
}

// Cache: channelId → { ts, fetchedAt }
const tsCache = new Map<string, { ts: string; fetchedAt: number }>();
const CACHE_TTL_MS = 10_000;

function readBotToken(): string {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const channels = raw.channels as Record<string, unknown> | undefined;
    const slack = channels?.slack as Record<string, unknown> | undefined;
    const token = String(slack?.botToken ?? "").trim();
    return token;
  } catch {
    return "";
  }
}

/**
 * Get the ts of the latest human message in a Slack DM channel.
 * Returns "" if unavailable or on error.
 */
export async function fetchLatestUserMessageTs(
  channelId: string,
  timeoutMs = 1500,
): Promise<string> {
  if (!channelId) return "";

  const cached = tsCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.ts;
  }

  const token = readBotToken();
  if (!token) return "";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=5`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const json = await resp.json() as SlackHistoryResponse;
    if (!json.ok || !Array.isArray(json.messages)) return "";

    // Find the most recent non-bot, non-subtype message (regular user message)
    const userMsg = json.messages.find(
      (m) => !m.bot_id && !m.subtype && m.ts && /^\d{10}\.\d{6}$/.test(m.ts),
    );

    const ts = userMsg?.ts ?? "";
    if (ts) {
      tsCache.set(channelId, { ts, fetchedAt: Date.now() });
    }
    return ts;
  } catch {
    return "";
  }
}

export function invalidateThreadAnchorCache(channelId: string): void {
  tsCache.delete(channelId);
}
