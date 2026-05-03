/**
 * Fetches the latest user message ts from a Slack DM channel via the Web API.
 * Used as a fallback when OpenClaw doesn't pass inboundMessageTs in the hook ctx.
 *
 * Two entry points:
 *  - fetchLatestUserMessageTs(channelId)  — use when you have the DM channel ID (D...)
 *  - fetchLatestUserMessageTsForSessionKey(sessionKey) — use when you only have the
 *    OpenClaw session key; extracts a Slack channel ID directly, or extracts the
 *    Slack user ID and resolves the DM channel ID via conversations.open before querying history.
 *
 * Results are cached to avoid hammering the API on rapid messages.
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

interface SlackConversationsOpenResponse {
  ok: boolean;
  channel?: { id: string };
  error?: string;
}

// Cache: channelId/userId → { ts, fetchedAt }
const tsCache = new Map<string, { ts: string; fetchedAt: number }>();
const TS_CACHE_TTL_MS = 10_000;

// Cache: userId → { channelId, fetchedAt }  (DM channel ID is stable, long TTL)
const dmChannelCache = new Map<string, { channelId: string; fetchedAt: number }>();
const DM_CHANNEL_CACHE_TTL_MS = 3_600_000; // 1 hour

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
 * channelId must be a real Slack channel/DM ID (C..., D..., G...).
 * Returns "" if unavailable or on error.
 */
export async function fetchLatestUserMessageTs(
  channelId: string,
  timeoutMs = 1500,
): Promise<string> {
  if (!channelId) return "";
  // Guard: reject obvious non-channel-ID values like the string "slack"
  if (!/^[A-Z0-9]{8,}$/i.test(channelId)) return "";

  const cached = tsCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < TS_CACHE_TTL_MS) {
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

/**
 * Resolve the Slack DM channel ID for a given user ID via conversations.open.
 * The DM channel ID is stable so we cache it with a long TTL.
 */
async function resolveDmChannelId(
  userId: string,
  token: string,
  timeoutMs: number,
): Promise<string> {
  const cached = dmChannelCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < DM_CHANNEL_CACHE_TTL_MS) {
    return cached.channelId;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ users: userId }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const json = await resp.json() as SlackConversationsOpenResponse;
    if (!json.ok || !json.channel?.id) return "";

    const channelId = json.channel.id;
    dmChannelCache.set(userId, { channelId, fetchedAt: Date.now() });
    return channelId;
  } catch {
    return "";
  }
}

/**
 * Get the ts of the latest human message for a session key like
 * "agent:main:slack:default:direct:u0al9t5u89z".
 *
 * Extracts the Slack user ID from the session key, resolves the DM channel
 * via conversations.open (cached), then queries conversations.history.
 *
 * Falls back to empty string on any error.
 */
export async function fetchLatestUserMessageTsForSessionKey(
  sessionKey: string,
  timeoutMs = 2000,
): Promise<string> {
  const channelMatch = sessionKey.match(/:slack:(?:[^:]+:)?(?:channel|group|room):([a-z0-9]+)/i);
  if (channelMatch) {
    const channelId = channelMatch[1].toUpperCase();
    if (/^[CDG][A-Z0-9]{8,}$/.test(channelId)) {
      return fetchLatestUserMessageTs(channelId, timeoutMs);
    }
  }

  // Parse pattern: ...:slack:{account}:direct:{userId}
  const match = sessionKey.match(/:slack:[^:]+:direct:([a-z0-9]+)/i);
  if (!match) return "";

  const userId = match[1].toUpperCase(); // e.g. "U0AL9T5U89Z"
  if (!/^U[A-Z0-9]{8,}$/.test(userId)) return "";

  // Check ts cache by userId as well (avoid double API calls)
  const userTsCached = tsCache.get(userId);
  if (userTsCached && Date.now() - userTsCached.fetchedAt < TS_CACHE_TTL_MS) {
    return userTsCached.ts;
  }

  const token = readBotToken();
  if (!token) return "";

  // Split timeout between open (40%) and history (60%)
  const openTimeout = Math.floor(timeoutMs * 0.4);
  const historyTimeout = timeoutMs - openTimeout;

  const channelId = await resolveDmChannelId(userId, token, openTimeout);
  if (!channelId) return "";

  const ts = await fetchLatestUserMessageTs(channelId, historyTimeout);
  if (ts) {
    // Also cache by userId key so rapid repeated calls don't re-open
    tsCache.set(userId, { ts, fetchedAt: Date.now() });
  }
  return ts;
}

export function invalidateThreadAnchorCache(channelId: string): void {
  tsCache.delete(channelId);
}
