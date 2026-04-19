import { runCommand, resolveWorkspaceRoot } from "../../resolve/env.js";

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

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function asSlackCommandResult(value: unknown): SlackCommandResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as SlackCommandResult;
}

export class SlackAdapter {
  readonly channel = "slack" as const;
  readonly config: SlackAdapterConfig;

  constructor(config?: Partial<SlackAdapterConfig>) {
    this.config = { ...DEFAULT_SLACK_CONFIG, ...config };
  }

  resolveTarget(sessionKey: string): SlackDeliveryTarget {
    const parts = sessionKey.split(":");
    const userId = this.normalizeUserId(parts[5] || "");
    const threadTs = stringValue(parts[7]);
    return {
      channel: "slack",
      target: userId,
      ...(threadTs ? { threadTs } : {}),
    };
  }

  async send(params: {
    sessionKey: string;
    message: string;
    replyToMessageId?: string;
    timeoutMs?: number;
    cwd?: string;
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
    const args = ["message", "send", "--channel", "slack", "--target", target.target, "--json"];

    if (params.message) {
      args.push("--message", params.message);
    }

    if (target.threadTs) {
      args.push("--thread-id", target.threadTs);
    }

    if (params.replyToMessageId && this.shouldUseThread()) {
      args.push("--reply-to", params.replyToMessageId);
    }

    try {
      const result = await runCommand("openclaw", args, {
        cwd: stringValue(params.cwd) || resolveWorkspaceRoot(),
        timeoutMs,
      });

      if (result.code === 0 && result.stdout) {
        try {
          const parsedResult = asSlackCommandResult(JSON.parse(result.stdout));
          if (parsedResult.ok === true) {
            const messageId = stringValue(parsedResult.message?.ts || parsedResult.ts);
            const threadTs = stringValue(parsedResult.message?.thread_ts || parsedResult.thread_ts || target.threadTs);
            return {
              sent: true,
              delivered: true,
              ...(messageId ? { messageId } : {}),
              ...(threadTs ? { threadTs } : {}),
            };
          }

          return {
            sent: false,
            delivered: false,
            error: stringValue(parsedResult.error) || result.stderr || "send_failed",
          };
        } catch {
          // ignore malformed json and fall through to command failure shape
        }
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
