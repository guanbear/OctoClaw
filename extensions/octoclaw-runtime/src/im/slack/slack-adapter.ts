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

function asSlackCommandResult(value: unknown): SlackCommandResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as SlackCommandResult;
}

function parseSlackSessionKey(sessionKey: string): { kind: string; target: string; threadTs: string } {
  const parts = sessionKey.split(":").map((part) => part.trim());
  const slackIndex = parts.findIndex((part) => part.toLowerCase() === "slack");
  if (slackIndex < 0) return { kind: "", target: "", threadTs: "" };
  const kindIndex = slackIndex + 2;
  const kind = stringValue(parts[kindIndex]).toLowerCase();
  const target = stringValue(parts[kindIndex + 1]);
  const threadTs = stringValue(parts[kindIndex + 2]).toLowerCase() === "thread"
    ? stringValue(parts[kindIndex + 3])
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

export class SlackAdapter {
  readonly channel = "slack" as const;
  readonly config: SlackAdapterConfig;

  constructor(config?: Partial<SlackAdapterConfig>) {
    this.config = { ...DEFAULT_SLACK_CONFIG, ...config };
  }

  resolveTarget(sessionKey: string): SlackDeliveryTarget {
    const parsed = parseSlackSessionKey(sessionKey);
    const userId = this.normalizeUserId(parsed.target);
    const threadTs = parsed.threadTs;
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

  async react(params: {
    sessionKey: string;
    messageId: string;
    emoji: string;
    timeoutMs?: number;
    cwd?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const { sessionKey, messageId, emoji, timeoutMs = 5000, cwd } = params;
    const target = this.resolveTarget(sessionKey);
    if (!target.target || !messageId) {
      return { ok: false, error: "missing_target_or_message_id" };
    }

    const args = [
      "message", "react",
      "--channel", "slack",
      "--target", target.target,
      "--message-id", messageId,
      "--emoji", emoji,
      "--json",
    ];

    try {
      const result = await runCommand("openclaw", args, {
        cwd: cwd || resolveWorkspaceRoot(),
        timeoutMs: Math.max(500, timeoutMs),
      });
      if (result.code === 0) {
        this.ackDebug(`react ok: emoji=${emoji} messageId=${messageId}`);
        return { ok: true };
      }
      this.ackDebug(`react failed: code=${result.code} stderr=${String(result.stderr).slice(0, 100)}`);
      return { ok: false, error: String(result.stderr || "react_failed").slice(0, 200) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
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

    // When replyToMessageId is provided, always try --reply-to first so the ACK
    // lands in the user's thread.  This is independent of the replyToMode config
    // (which controls the general request flow).  For ACKs specifically, we want
    // every reply to thread under the user's inbound message.
    if (params.replyToMessageId) {
      this.ackDebug(`replyToMessageId=${params.replyToMessageId} — attempting threaded send`);
      const threadedResult = await this.executeSend(target, params.message, timeoutMs, params.cwd, params.replyToMessageId);
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

    const result = await this.executeSend(target, params.message, timeoutMs, params.cwd);
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
  ): Promise<SlackSendResult> {
    const args = ["message", "send", "--channel", "slack", "--target", target.target, "--json"];

    if (message) {
      args.push("--message", message);
    }

    if (target.threadTs) {
      args.push("--thread-id", target.threadTs);
    }

    if (replyToMessageId) {
      args.push("--reply-to", replyToMessageId);
    }

    try {
      const result = await runCommand("openclaw", args, {
        cwd: stringValue(cwd) || resolveWorkspaceRoot(),
        timeoutMs,
      });

      if (result.code === 0) {
        if (result.stdout) {
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
              error: stringValue(parsedResult.error) || "send_failed",
            };
          } catch {
            // stdout is not valid JSON but exit code 0 — treat as success
            // to avoid double delivery on retry (stderr may contain debug logs)
            return {
              sent: true,
              delivered: true,
            };
          }
        }
        // exit code 0 but no stdout — treat as likely success to avoid double delivery
        return {
          sent: true,
          delivered: true,
        };
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
