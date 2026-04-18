import {
  runCommand,
  resolveTaskStatePath,
  resolveWorkspaceRoot,
} from "../resolve/env.js";

export const ACK_GUARD_2S_TEXT = "收到，我看一下";
export const ACK_GUARD_15S_TEXT = "还在处理，稍后给你结果";
export const WATCHDOG_INTERVAL_MS = 30_000;
export const WATCHDOG_DEBOUNCE_MS = 25_000;
export const STALE_QUEUED_THRESHOLD_MIN = 90;
export const STUCK_THRESHOLD_MIN = 15;

const DELEGATED_ROUTE_NAMES = new Set(["runner", "spawn_single", "spawn_multi"]);
const IM_SESSION_ORIGINS = new Set([
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "msteams",
  "googlechat",
  "wechat",
  "webchat",
  "feishu",
]);
const SESSION_NAMESPACE_KINDS = new Set(["default"]);
const USER_SESSION_KINDS = new Set(["dm", "direct", "user"]);
const CHANNEL_SESSION_KINDS = new Set(["channel", "group", "room", "conversation", "space", "chat"]);
const THREAD_SESSION_KINDS = new Set(["thread", "topic"]);

type UnknownRecord = Record<string, unknown>;
type AckOwner = "" | "pre_dispatch" | "latency_ack" | "timer_ack";

export interface AckContext extends UnknownRecord {
  trigger?: unknown;
  cwd?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
}

export interface AckLogger {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface AckTrackingState extends UnknownRecord {
  ackOwner?: unknown;
  ack_owner?: unknown;
  ackGuardKey?: unknown;
  preDispatchAckSent?: unknown;
  preDispatchAckPending?: unknown;
  latencyAckSent?: unknown;
}

export interface AckTarget {
  target: string;
  threadId: string;
}

interface ParsedSessionRoute {
  origin: string;
  target: string;
  threadId: string;
  looksLikeImSession: boolean;
}

interface AckSendResult {
  attempted: boolean;
  delivered: boolean;
  sent: boolean;
  error: string;
  reason: string;
  ack_target_resolution_state: string;
  ack_delivery_state: string;
  target: string;
  threadId: string;
}

interface AckClaimResult {
  claimed: boolean;
  currentOwner: string;
}

interface AckGuardEntry {
  inboundTs: number;
  ackSent2s: boolean;
  ackSent15s: boolean;
  timer2s: ReturnType<typeof setTimeout> | null;
  timer15s: ReturnType<typeof setTimeout> | null;
  stateKey: string;
}

interface TaskStateTask extends UnknownRecord {
  id?: unknown;
  status?: unknown;
  updated_at?: unknown;
  spawned_at?: unknown;
}

interface TaskStateFile extends UnknownRecord {
  tasks?: unknown;
}

const ackGuardTimers = new Map<string, AckGuardEntry>();
const ackStateByStateKey = new Map<string, AckTrackingState>();
let watchdogLastTick = 0;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function stripAgentSessionPrefix(raw: string): string {
  const value = asString(raw);
  const parts = value.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts.slice(2).join(":");
  }
  return value;
}

function parseSessionRoute(raw: string): ParsedSessionRoute {
  const stripped = stripAgentSessionPrefix(raw);
  const parts = stripped.split(":").filter(Boolean);
  const normalizedParts = parts.length >= 2 && SESSION_NAMESPACE_KINDS.has(asString(parts[1]).toLowerCase())
    ? [parts[0], ...parts.slice(2)]
    : parts;
  const origin = asString(normalizedParts[0]).toLowerCase();

  // Slack user/channel IDs are case-sensitive (uppercase). Preserve original case
  // for Slack targets since OpenClaw normalizes session keys to lowercase.
  const slackOrigin = origin === "slack";

  let target = "";
  let threadId = "";

  if (normalizedParts.length >= 3 && USER_SESSION_KINDS.has(asString(normalizedParts[1]).toLowerCase())) {
    target = slackOrigin ? asString(normalizedParts[2]).toUpperCase() : asString(normalizedParts[2]);
    if (normalizedParts.length >= 5 && THREAD_SESSION_KINDS.has(asString(normalizedParts[3]).toLowerCase())) {
      threadId = asString(normalizedParts[4]);
    }
  } else if (normalizedParts.length >= 3 && CHANNEL_SESSION_KINDS.has(asString(normalizedParts[1]).toLowerCase())) {
    target = `${asString(normalizedParts[1]).toLowerCase()}:${asString(normalizedParts[2])}`;
    if (normalizedParts.length >= 5 && THREAD_SESSION_KINDS.has(asString(normalizedParts[3]).toLowerCase())) {
      threadId = asString(normalizedParts[4]);
    }
  } else if (normalizedParts.length >= 2 && IM_SESSION_ORIGINS.has(origin)) {
    const targetKind = asString(normalizedParts[1]).toLowerCase();
    const targetId = asString(normalizedParts[2]);
    if (targetKind && targetId) {
      target = `${USER_SESSION_KINDS.has(targetKind) ? "user" : targetKind}:${targetId}`;
    }
    if (normalizedParts.length >= 4 && THREAD_SESSION_KINDS.has(asString(normalizedParts[2]).toLowerCase())) {
      threadId = asString(normalizedParts[3]);
    }
  }

  return {
    origin,
    target,
    threadId,
    looksLikeImSession: Boolean(origin && IM_SESSION_ORIGINS.has(origin) && target),
  };
}

function isDelegatedRoute(decision: UnknownRecord): boolean {
  const routeDecision = isRecord(decision.route_decision) ? decision.route_decision : {};
  const route = asString(routeDecision.route).toLowerCase();
  return DELEGATED_ROUTE_NAMES.has(route);
}

function ackState(stateKey: string): AckTrackingState {
  const key = asString(stateKey);
  return key ? (ackStateByStateKey.get(key) ?? {}) : {};
}

function resolveAckDeliverySessionKey(
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
): string {
  const candidates = [
    metadata.session_key,
    state.canonicalSessionKey,
    stateKey,
    ctx.sessionKey,
    ctx.sessionId,
  ]
    .map(asString)
    .filter(Boolean);

  for (const candidate of candidates) {
    if (parseSessionRoute(candidate).looksLikeImSession) {
      return candidate;
    }
  }
  return "";
}

function ackTargetResolutionState(result: AckSendResult): string {
  return asString(result.ack_target_resolution_state) || "unresolved";
}

function ackDeliveryState(result: AckSendResult): string {
  return asString(result.ack_delivery_state) || (result.delivered || result.sent ? "sent" : "failed");
}

function updateTrackingState(stateKey: string, patch: UnknownRecord): void {
  const key = asString(stateKey);
  if (!key) {
    return;
  }
  const current = ackStateByStateKey.get(key) ?? {};
  ackStateByStateKey.set(key, { ...current, ...patch });
}

function tryClaimAckOwner(stateKey: string, owner: AckOwner): AckClaimResult {
  const key = asString(stateKey);
  const normalizedOwner = asString(owner) as AckOwner;
  if (!key || !normalizedOwner) {
    return { claimed: false, currentOwner: currentAckOwner(key) };
  }
  const currentOwner = currentAckOwner(key);
  if (!currentOwner || currentOwner === normalizedOwner) {
    updateTrackingState(key, {
      ackOwner: normalizedOwner,
      ack_owner: normalizedOwner,
    });
    return { claimed: true, currentOwner: normalizedOwner };
  }
  return { claimed: false, currentOwner };
}

async function sendAckDirectDetailed(
  sessionKey: string,
  message: string,
  cwd?: string,
  options: UnknownRecord = {},
): Promise<AckSendResult> {
  const parsed = parseSessionRoute(sessionKey);
  const resolved = resolveAckTargetFromSessionKey(sessionKey);
  if (!parsed.origin || !resolved.target) {
    return {
      attempted: false,
      delivered: false,
      sent: false,
      error: "unresolvable_session_target",
      reason: "channel_message_unresolvable",
      ack_target_resolution_state: "target_resolution_failed",
      ack_delivery_state: "not_attempted",
      target: "",
      threadId: "",
    };
  }

  const timeoutMs = Math.max(500, Number(options.timeoutMs || 5000));
  const args = ["message", "send", "--channel", parsed.origin, "--target", resolved.target, "--json"];
  if (message) {
    args.push("--message", message);
  }
  if (resolved.threadId) {
    args.push("--thread-id", resolved.threadId);
  }

  try {
    const result = await runCommand("openclaw", args, {
      cwd: asString(cwd) || resolveWorkspaceRoot(),
      timeoutMs,
    });
    if (result.code === 0 && result.stdout) {
      try {
        const parsedResult = JSON.parse(result.stdout) as UnknownRecord;
        if (parsedResult.ok === true) {
          return {
            attempted: true,
            delivered: true,
            sent: true,
            error: "",
            reason: "channel_message_sent",
            ack_target_resolution_state: "resolved",
            ack_delivery_state: "sent",
            target: resolved.target,
            threadId: resolved.threadId,
          };
        }
      } catch {
        // ignore malformed json and fall through to command failure shape
      }
    }
    return {
      attempted: true,
      delivered: false,
      sent: false,
      error: result.stderr || "send_failed",
      reason: "channel_message_failed",
      ack_target_resolution_state: "resolved",
      ack_delivery_state: "failed",
      target: resolved.target,
      threadId: resolved.threadId,
    };
  } catch (error) {
    return {
      attempted: true,
      delivered: false,
      sent: false,
      error: String(error),
      reason: "channel_message_error",
      ack_target_resolution_state: "resolved",
      ack_delivery_state: "failed",
      target: resolved.target,
      threadId: resolved.threadId,
    };
  }
}

async function readTaskStateFile(): Promise<TaskStateFile> {
  try {
    const fs = await import("node:fs");
    const content = fs.default.readFileSync(resolveTaskStatePath(), "utf-8");
    return JSON.parse(content) as TaskStateFile;
  } catch {
    return {};
  }
}

function parseUpdatedSortValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = asString(value);
  if (!text) {
    return 0;
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

export function preDispatchAckText(decision: UnknownRecord): string {
  const ack = isRecord(decision.pre_dispatch_ack) ? decision.pre_dispatch_ack : {};
  return asString(ack.text);
}

export function latencyAckText(decision: UnknownRecord): string {
  const ack = isRecord(decision.latency_ack) ? decision.latency_ack : {};
  return asString(ack.text);
}

export function shouldSendPreDispatchAck(
  decision: UnknownRecord,
  state: UnknownRecord = {},
  ctx: AckContext = {},
): boolean {
  if (!isDelegatedRoute(decision)) {
    return false;
  }
  const preDispatchAck = isRecord(decision.pre_dispatch_ack) ? decision.pre_dispatch_ack : {};
  if (!asBoolean(preDispatchAck.required)) {
    return false;
  }
  if (asBoolean(state.preDispatchAckSent) || asBoolean(state.preDispatchAckPending)) {
    return false;
  }
  const trigger = asString(ctx.trigger).toLowerCase();
  if (trigger && ["heartbeat", "cron", "memory"].includes(trigger)) {
    return false;
  }
  return Boolean(preDispatchAckText(decision));
}

export function shouldSendLatencyAck(
  decision: UnknownRecord,
  state: UnknownRecord = {},
  ctx: AckContext = {},
  toolName = "",
): boolean {
  if (isDelegatedRoute(decision)) {
    return false;
  }
  const latencyAck = isRecord(decision.latency_ack) ? decision.latency_ack : {};
  if (!asBoolean(latencyAck.required)) {
    return false;
  }
  if (asBoolean(state.latencyAckSent)) {
    return false;
  }
  const trigger = asString(ctx.trigger).toLowerCase();
  if (trigger && ["heartbeat", "cron", "memory"].includes(trigger)) {
    return false;
  }
  const normalizedToolName = asString(toolName);
  if (!normalizedToolName || normalizedToolName.startsWith("octoclaw_")) {
    return false;
  }
  return Boolean(latencyAckText(decision));
}

export function resolveAckTargetFromSessionKey(sessionKey: string): AckTarget {
  const parsed = parseSessionRoute(sessionKey);
  return {
    target: parsed.target,
    threadId: parsed.threadId,
  };
}

export async function sendAckDirect(
  sessionKey: string,
  message: string,
  cwd?: string,
  options: UnknownRecord = {},
): Promise<boolean> {
  const result = await sendAckDirectDetailed(sessionKey, message, cwd, options);
  return Boolean(result.delivered || result.sent);
}

export function startAckGuard(sessionKey: string, cwd: string, options: UnknownRecord = {}): void {
  const normalizedSessionKey = asString(sessionKey);
  if (!normalizedSessionKey || ackGuardTimers.has(normalizedSessionKey)) {
    return;
  }
  const stateKey = asString(options.stateKey);
  const entry: AckGuardEntry = {
    inboundTs: Date.now(),
    ackSent2s: false,
    ackSent15s: false,
    timer2s: null,
    timer15s: null,
    stateKey,
  };

  if (stateKey) {
    updateTrackingState(stateKey, { ackGuardKey: normalizedSessionKey });
  }

  entry.timer2s = setTimeout(() => {
    if (stateKey) {
      const claim = tryClaimAckOwner(stateKey, "timer_ack");
      if (!claim.claimed) {
        updateTrackingState(stateKey, {
          ack_target_resolution_state: "skipped_owner_conflict",
          ack_delivery_state: "skipped",
        });
        return;
      }
    }
    entry.ackSent2s = true;
    void sendAckDirectDetailed(normalizedSessionKey, ACK_GUARD_2S_TEXT, cwd, { timeoutMs: 2000 }).then((result) => {
      if (stateKey) {
        updateTrackingState(stateKey, {
          ackOwner: currentAckOwner(stateKey) || "timer_ack",
          ack_owner: currentAckOwner(stateKey) || "timer_ack",
          ack_target_resolution_state: ackTargetResolutionState(result),
          ack_delivery_state: ackDeliveryState(result),
        });
      }
      if (result.delivered || result.sent) {
        cancelAckGuard(normalizedSessionKey);
      }
    }).catch(() => undefined);
  }, 2000);

  entry.timer15s = setTimeout(() => {
    if (stateKey && currentAckOwner(stateKey) && currentAckOwner(stateKey) !== "timer_ack") {
      updateTrackingState(stateKey, {
        ack_target_resolution_state: "skipped_owner_conflict",
        ack_delivery_state: "skipped",
      });
      return;
    }
    if (stateKey) {
      tryClaimAckOwner(stateKey, "timer_ack");
    }
    entry.ackSent15s = true;
    void sendAckDirectDetailed(normalizedSessionKey, ACK_GUARD_15S_TEXT, cwd, { timeoutMs: 2000 }).then((result) => {
      if (stateKey) {
        updateTrackingState(stateKey, {
          ackOwner: currentAckOwner(stateKey) || "timer_ack",
          ack_owner: currentAckOwner(stateKey) || "timer_ack",
          ack_target_resolution_state: ackTargetResolutionState(result),
          ack_delivery_state: ackDeliveryState(result),
        });
      }
      if (result.delivered || result.sent) {
        cancelAckGuard(normalizedSessionKey);
      }
    }).catch(() => undefined);
  }, 15000);

  ackGuardTimers.set(normalizedSessionKey, entry);
}

export function cancelAckGuard(sessionKey: string): void {
  const normalizedSessionKey = asString(sessionKey);
  const entry = ackGuardTimers.get(normalizedSessionKey);
  if (!entry) {
    return;
  }
  if (entry.timer2s) {
    clearTimeout(entry.timer2s);
  }
  if (entry.timer15s) {
    clearTimeout(entry.timer15s);
  }
  ackGuardTimers.delete(normalizedSessionKey);
}

export function cancelAckGuardForState(stateKey: string): void {
  const normalizedStateKey = asString(stateKey);
  if (!normalizedStateKey) {
    return;
  }
  const state = ackState(normalizedStateKey);
  const storedAckKey = asString(state.ackGuardKey);
  if (storedAckKey) {
    cancelAckGuard(storedAckKey);
  }
  cancelAckGuard(normalizedStateKey);
}

export function currentAckOwner(stateKey: string): string {
  const state = ackState(stateKey);
  return asString(state.ackOwner || state.ack_owner);
}

export function claimAckOwner(stateKey: string, owner: string): string {
  return tryClaimAckOwner(stateKey, asString(owner) as AckOwner).currentOwner;
}

export function updateAckTrackingState(stateKey: string, patch: UnknownRecord): void {
  updateTrackingState(stateKey, patch);
}

export async function maybeSendPreDispatchAck(
  decision: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
  logger: AckLogger,
): Promise<void> {
  const message = preDispatchAckText(decision);
  if (!shouldSendPreDispatchAck(decision, state, ctx)) {
    return;
  }
  const ownerClaim = tryClaimAckOwner(stateKey, "pre_dispatch");
  if (!ownerClaim.claimed) {
    updateTrackingState(stateKey, {
      ack_owner: ownerClaim.currentOwner,
      ack_target_resolution_state: "skipped_owner_conflict",
      ack_delivery_state: "skipped",
    });
    return;
  }
  const sessionKey = resolveAckDeliverySessionKey(metadata, stateKey, state, ctx);
  if (!sessionKey) {
    updateTrackingState(stateKey, {
      ackOwner: "pre_dispatch",
      ack_owner: "pre_dispatch",
      ack_target_resolution_state: "missing_session_key",
      ack_delivery_state: "not_attempted",
    });
    return;
  }
  try {
    const preDispatchAck = isRecord(decision.pre_dispatch_ack) ? decision.pre_dispatch_ack : {};
    const result = await sendAckDirectDetailed(sessionKey, message, asString(ctx.cwd) || process.cwd(), {
      timeoutMs: Math.max(500, Number(preDispatchAck.channel_timeout_ms || 5000)),
    });
    if (result.delivered) {
      updateTrackingState(stateKey, {
        ackOwner: "pre_dispatch",
        ack_owner: "pre_dispatch",
        ack_target_resolution_state: ackTargetResolutionState(result),
        ack_delivery_state: ackDeliveryState(result),
        preDispatchAckSent: true,
        preDispatchAckText: message,
        preDispatchAckMode: "channel_message",
        preDispatchAckPending: false,
      });
      cancelAckGuardForState(stateKey);
      return;
    }
    updateTrackingState(stateKey, {
      ackOwner: "pre_dispatch",
      ack_owner: "pre_dispatch",
      ack_target_resolution_state: ackTargetResolutionState(result),
      ack_delivery_state: ackDeliveryState(result),
      preDispatchAckPending: false,
    });
  } catch (error) {
    logger.warn?.(`octoclaw pre-dispatch ack failed: ${String(error)}`);
    updateTrackingState(stateKey, {
      ackOwner: "pre_dispatch",
      ack_owner: "pre_dispatch",
      ack_target_resolution_state: "unresolved",
      ack_delivery_state: "failed",
      preDispatchAckPending: false,
    });
  }
}

export function scheduleEagerPreDispatchAck(
  decision: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
  logger: AckLogger,
): void {
  if (!shouldSendPreDispatchAck(decision, state, ctx)) {
    return;
  }
  const ownerClaim = tryClaimAckOwner(stateKey, "pre_dispatch");
  if (!ownerClaim.claimed) {
    return;
  }
  updateTrackingState(stateKey, {
    ackOwner: "pre_dispatch",
    ack_owner: "pre_dispatch",
    preDispatchAckPending: true,
  });
  setTimeout(() => {
    void maybeSendPreDispatchAck(decision, metadata, stateKey, state, ctx, logger);
  }, 0);
}

export async function maybeEmitPreDispatchAckProgress(
  onUpdate: unknown,
  decision: UnknownRecord,
  stateKey: string,
  logger: AckLogger,
): Promise<void> {
  const message = preDispatchAckText(decision);
  if (typeof onUpdate !== "function" || !message) {
    return;
  }
  const sender = onUpdate as (payload: unknown) => Promise<unknown> | unknown;
  const candidates: unknown[] = [
    { content: [{ type: "text", text: message }] },
    message,
  ];
  for (const payload of candidates) {
    try {
      await sender(payload);
      updateTrackingState(stateKey, {
        preDispatchAckSent: true,
        preDispatchAckText: message,
        preDispatchAckMode: "progress_update",
      });
      return;
    } catch (error) {
      logger.warn?.(`octoclaw pre-dispatch progress ack failed: ${String(error)}`);
    }
  }
}

export async function maybeSendLatencyAck(
  decision: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
  logger: AckLogger,
  toolName: string,
): Promise<{ sent: boolean; reason: string } | null> {
  const message = latencyAckText(decision);
  if (!shouldSendLatencyAck(decision, state, ctx, toolName)) {
    return null;
  }
  const ownerClaim = tryClaimAckOwner(stateKey, "latency_ack");
  if (!ownerClaim.claimed) {
    updateTrackingState(stateKey, {
      ack_owner: ownerClaim.currentOwner,
      ack_target_resolution_state: "skipped_owner_conflict",
      ack_delivery_state: "skipped",
    });
    return { sent: false, reason: "owner_conflict" };
  }
  const sessionKey = resolveAckDeliverySessionKey(metadata, stateKey, state, ctx);
  if (!sessionKey) {
    updateTrackingState(stateKey, {
      ackOwner: "latency_ack",
      ack_owner: "latency_ack",
      ack_target_resolution_state: "missing_session_key",
      ack_delivery_state: "not_attempted",
    });
    return { sent: false, reason: "missing_session_key" };
  }
  try {
    const latencyAck = isRecord(decision.latency_ack) ? decision.latency_ack : {};
    const result = await sendAckDirectDetailed(sessionKey, message, asString(ctx.cwd) || process.cwd(), {
      timeoutMs: Math.max(500, Number(latencyAck.channel_timeout_ms || 5000)),
    });
    if (result.delivered) {
      updateTrackingState(stateKey, {
        ackOwner: "latency_ack",
        ack_owner: "latency_ack",
        ack_target_resolution_state: ackTargetResolutionState(result),
        ack_delivery_state: ackDeliveryState(result),
        latencyAckSent: true,
        latencyAckText: message,
        latencyAckMode: "channel_message",
      });
      cancelAckGuardForState(stateKey);
      return { sent: true, reason: result.reason };
    }
    updateTrackingState(stateKey, {
      ackOwner: "latency_ack",
      ack_owner: "latency_ack",
      ack_target_resolution_state: ackTargetResolutionState(result),
      ack_delivery_state: ackDeliveryState(result),
    });
    return { sent: false, reason: result.reason };
  } catch (error) {
    logger.warn?.(`octoclaw latency ack failed: ${String(error)}`);
    updateTrackingState(stateKey, {
      ackOwner: "latency_ack",
      ack_owner: "latency_ack",
      ack_target_resolution_state: "unresolved",
      ack_delivery_state: "failed",
    });
    return { sent: false, reason: String(error) };
  }
}

export async function ensurePreDispatchAck(
  decision: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord,
  ctx: AckContext,
  onUpdate: unknown,
  logger: AckLogger,
): Promise<void> {
  const liveState = ackState(stateKey);
  if (asBoolean(liveState.preDispatchAckPending) && !asBoolean(liveState.preDispatchAckSent)) {
    return;
  }

  await maybeSendPreDispatchAck(decision, metadata, stateKey, state, ctx, logger);

  const preDispatchAck = isRecord(decision.pre_dispatch_ack) ? decision.pre_dispatch_ack : {};
  if (!asBoolean(preDispatchAck.fallback_to_progress_update)) {
    return;
  }
  if (asBoolean(ackState(stateKey).preDispatchAckSent)) {
    return;
  }

  await maybeEmitPreDispatchAckProgress(onUpdate, decision, stateKey, logger);
  if (asBoolean(ackState(stateKey).preDispatchAckSent)) {
    updateTrackingState(stateKey, {
      ackOwner: "pre_dispatch",
      ack_owner: "pre_dispatch",
      ack_delivery_state: "sent",
    });
    cancelAckGuardForState(stateKey);
  }
}

export async function watchdogTick(logger: unknown): Promise<void> {
  const sink = isRecord(logger) ? logger as AckLogger : {};
  const now = Date.now();
  if (now - watchdogLastTick < WATCHDOG_DEBOUNCE_MS) {
    return;
  }
  watchdogLastTick = now;

  try {
    const taskState = await readTaskStateFile();
    const tasks = Array.isArray(taskState.tasks) ? taskState.tasks as TaskStateTask[] : [];
    if (tasks.length === 0) {
      return;
    }

    let staleCount = 0;
    let stuckCount = 0;
    for (const task of tasks) {
      const taskId = asString(task.id);
      const status = asString(task.status).toLowerCase();
      const updatedAt = parseUpdatedSortValue(task.updated_at ?? task.spawned_at ?? 0);
      if (!taskId || !updatedAt) {
        continue;
      }
      const ageMin = (now - updatedAt) / 60_000;
      if (status === "queued" && ageMin > STALE_QUEUED_THRESHOLD_MIN) {
        staleCount += 1;
        sink.debug?.(`octoclaw watchdog: task_timeout task=${taskId} status=${status} age_min=${ageMin.toFixed(1)}`);
        continue;
      }
      if ((status === "running" || status === "dispatched") && ageMin > STUCK_THRESHOLD_MIN) {
        stuckCount += 1;
        sink.debug?.(`octoclaw watchdog: runner_stuck task=${taskId} status=${status} age_min=${ageMin.toFixed(1)}`);
      }
    }

    if (staleCount > 0 || stuckCount > 0) {
      sink.debug?.(`octoclaw watchdog: stale_queued=${staleCount} stuck=${stuckCount}`);
    }
  } catch (error) {
    sink.warn?.(`octoclaw watchdog tick failed: ${String(error)}`);
  }
}
