import type { SlackAcceptanceClient, SlackMessageRecord, SlackPostMessageResult } from "./types.js";

declare const fetch: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

type SlackApiMessage = {
  ts?: unknown;
  text?: unknown;
  user?: unknown;
  bot_id?: unknown;
  thread_ts?: unknown;
};

type SlackPostResponse = {
  ok?: unknown;
  channel?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  message?: SlackApiMessage;
  error?: unknown;
};

type SlackRepliesResponse = {
  ok?: unknown;
  messages?: SlackApiMessage[];
  error?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function encodeQuery(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? "")}`)
    .join("&");
}

function normalizeMessage(message: SlackApiMessage): SlackMessageRecord {
  return {
    ts: asString(message.ts),
    text: asString(message.text),
    user: asString(message.user) || undefined,
    botId: asString(message.bot_id) || undefined,
    threadTs: asString(message.thread_ts) || undefined,
  };
}

export class SlackWebApiAcceptanceClient implements SlackAcceptanceClient {
  constructor(private readonly token: string) {}

  async postMessage(params: { channel: string; text: string; threadTs?: string }): Promise<SlackPostMessageResult> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: params.channel, text: params.text, thread_ts: params.threadTs }),
    });
    const body = await this.parseJson<SlackPostResponse>(response);
    if (!response.ok || body.ok !== true) {
      return {
        ok: false,
        channel: params.channel,
        ts: "",
        error: asString(body.error) || `slack_http_${response.status}`,
      };
    }
    const ts = asString(body.ts || body.message?.ts);
    const threadTs = asString(body.thread_ts || body.message?.thread_ts || params.threadTs || ts);
    return { ok: true, channel: asString(body.channel) || params.channel, ts, threadTs };
  }

  async fetchReplies(params: { channel: string; threadTs: string; oldestTs?: string; limit?: number }): Promise<SlackMessageRecord[]> {
    const query = encodeQuery({
      channel: params.channel,
      ts: params.threadTs,
      oldest: params.oldestTs,
      limit: String(params.limit ?? 50),
      inclusive: "true",
    });
    const response = await fetch(`https://slack.com/api/conversations.replies?${query}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });
    const body = await this.parseJson<SlackRepliesResponse>(response);
    if (!response.ok || body.ok !== true) {
      throw new Error(asString(body.error) || `slack_http_${response.status}`);
    }
    return (body.messages ?? []).map(normalizeMessage).filter((message) => message.ts && message.text);
  }

  private async parseJson<T>(response: { json(): Promise<unknown>; text(): Promise<string> }): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      const text = await response.text();
      throw new Error(`slack_invalid_json:${text.slice(0, 80)}`);
    }
  }
}
