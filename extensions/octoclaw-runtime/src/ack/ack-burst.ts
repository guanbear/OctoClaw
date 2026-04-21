export type BurstState = "active" | "cooldown" | "idle";

export interface BurstWindow {
  threadKey: string;
  messageTimestamps: number[];
  lastAckSentAt: number;
  lastAckStage: string;
  lastRoutePhase: string;
  state: BurstState;
}

export interface BurstPolicy {
  burstWindowMs: number;
  cooldownMs: number;
  silenceWaitMs: number;
  maxTrackedThreads: number;
}

export interface SilenceCheckResult {
  isSilent: boolean;
  silenceDurationMs: number;
  burstState: BurstState;
  messageCount: number;
}

export interface SuppressContext {
  mainModelStartedOutput?: boolean;
  anchorExists?: boolean;
  channelSupportsUpdate?: boolean;
  userInputActive?: boolean;
  routePhase?: string;
}

export interface AckGateState {
  tool_active?: boolean;
  delegated_running?: boolean;
  blocked?: boolean;
  final_response_streaming?: boolean;
  delivery_pending?: boolean;
  delivered?: boolean;
  native_state?: string;
  formal_reply_visible?: boolean;
}

export interface SuppressDecision {
  suppressed: boolean;
  reason: string;
}

interface BurstMetadata {
  lastMessageAt: number;
  lastBurstAt: number;
}

const DEFAULT_BURST_POLICY: BurstPolicy = {
  burstWindowMs: 3_000,
  cooldownMs: 5_000,
  silenceWaitMs: 3_000,
  maxTrackedThreads: 200,
};

const burstWindows = new Map<string, BurstWindow>();
const burstMetadata = new Map<string, BurstMetadata>();

let activePolicy: BurstPolicy = { ...DEFAULT_BURST_POLICY };

function asThreadKey(value: string): string {
  return value.trim();
}

function nowMs(): number {
  return Date.now();
}

function retentionWindowMs(): number {
  return Math.max(
    activePolicy.burstWindowMs,
    activePolicy.cooldownMs,
    activePolicy.silenceWaitMs,
  );
}

function clampPositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizePolicy(policy: Partial<BurstPolicy>): BurstPolicy {
  return {
    burstWindowMs: clampPositiveInteger(policy.burstWindowMs ?? activePolicy.burstWindowMs, DEFAULT_BURST_POLICY.burstWindowMs),
    cooldownMs: clampPositiveInteger(policy.cooldownMs ?? activePolicy.cooldownMs, DEFAULT_BURST_POLICY.cooldownMs),
    silenceWaitMs: clampPositiveInteger(policy.silenceWaitMs ?? activePolicy.silenceWaitMs, DEFAULT_BURST_POLICY.silenceWaitMs),
    maxTrackedThreads: clampPositiveInteger(policy.maxTrackedThreads ?? activePolicy.maxTrackedThreads, DEFAULT_BURST_POLICY.maxTrackedThreads),
  };
}

function ensureWindow(threadKey: string): BurstWindow {
  const existing = burstWindows.get(threadKey);
  if (existing) {
    return existing;
  }

  const created: BurstWindow = {
    threadKey,
    messageTimestamps: [],
    lastAckSentAt: 0,
    lastAckStage: "",
    lastRoutePhase: "",
    state: "idle",
  };
  burstWindows.set(threadKey, created);
  burstMetadata.set(threadKey, { lastMessageAt: 0, lastBurstAt: 0 });
  pruneOverflow();
  return created;
}

function ensureMetadata(threadKey: string): BurstMetadata {
  const existing = burstMetadata.get(threadKey);
  if (existing) {
    return existing;
  }
  const created: BurstMetadata = { lastMessageAt: 0, lastBurstAt: 0 };
  burstMetadata.set(threadKey, created);
  return created;
}

function pruneOverflow(): void {
  while (burstWindows.size > activePolicy.maxTrackedThreads) {
    const oldestThreadKey = burstWindows.keys().next().value;
    if (typeof oldestThreadKey !== "string") {
      break;
    }
    burstWindows.delete(oldestThreadKey);
    burstMetadata.delete(oldestThreadKey);
  }
}

function pruneTimestamps(window: BurstWindow, now: number): void {
  const cutoff = now - retentionWindowMs();
  window.messageTimestamps = window.messageTimestamps.filter((timestamp) => timestamp >= cutoff);
}

function countBurstMessages(window: BurstWindow, now: number): number {
  const cutoff = now - activePolicy.burstWindowMs;
  let count = 0;
  for (const timestamp of window.messageTimestamps) {
    if (timestamp >= cutoff) {
      count += 1;
    }
  }
  return count;
}

function deriveBurstState(threadKey: string, now: number): BurstState {
  const window = burstWindows.get(threadKey);
  const metadata = burstMetadata.get(threadKey);

  if (!window || !metadata) {
    return "idle";
  }

  pruneTimestamps(window, now);
  const burstMessageCount = countBurstMessages(window, now);
  if (burstMessageCount >= 2) {
    metadata.lastBurstAt = Math.max(metadata.lastBurstAt, metadata.lastMessageAt);
    return "active";
  }

  const hasBurstHistory = metadata.lastBurstAt > 0 && metadata.lastMessageAt >= metadata.lastBurstAt;
  if (hasBurstHistory && now - metadata.lastMessageAt <= activePolicy.cooldownMs) {
    return "cooldown";
  }

  return "idle";
}

function syncWindowState(threadKey: string, now: number): BurstState {
  const window = burstWindows.get(threadKey);
  if (!window) {
    return "idle";
  }
  const state = deriveBurstState(threadKey, now);
  window.state = state;
  return state;
}

export function getBurstPolicy(): BurstPolicy {
  return { ...activePolicy };
}

export function setBurstPolicy(policy: Partial<BurstPolicy> = {}): BurstPolicy {
  activePolicy = normalizePolicy(policy);
  const now = nowMs();
  for (const threadKey of burstWindows.keys()) {
    syncWindowState(threadKey, now);
  }
  pruneOverflow();
  return getBurstPolicy();
}

export function recordMessage(threadKey: string, timestamp = nowMs()): void {
  const normalizedThreadKey = asThreadKey(threadKey);
  if (!normalizedThreadKey) {
    return;
  }

  const window = ensureWindow(normalizedThreadKey);
  const metadata = ensureMetadata(normalizedThreadKey);
  window.messageTimestamps.push(timestamp);
  metadata.lastMessageAt = timestamp;
  pruneTimestamps(window, timestamp);

  if (countBurstMessages(window, timestamp) >= 2) {
    metadata.lastBurstAt = timestamp;
  }

  window.state = deriveBurstState(normalizedThreadKey, timestamp);
}

export function checkSilence(threadKey: string, now = nowMs()): SilenceCheckResult {
  const normalizedThreadKey = asThreadKey(threadKey);
  const window = normalizedThreadKey ? burstWindows.get(normalizedThreadKey) : undefined;
  const metadata = normalizedThreadKey ? burstMetadata.get(normalizedThreadKey) : undefined;

  if (!window || !metadata || metadata.lastMessageAt <= 0) {
    return {
      isSilent: true,
      silenceDurationMs: Number.POSITIVE_INFINITY,
      burstState: "idle",
      messageCount: 0,
    };
  }

  const burstState = syncWindowState(normalizedThreadKey, now);
  const silenceDurationMs = Math.max(0, now - metadata.lastMessageAt);
  return {
    isSilent: silenceDurationMs >= activePolicy.silenceWaitMs,
    silenceDurationMs,
    burstState,
    messageCount: countBurstMessages(window, now),
  };
}

export function isInCooldown(threadKey: string, ackStage: string, now = nowMs()): boolean {
  const normalizedThreadKey = asThreadKey(threadKey);
  const normalizedAckStage = ackStage.trim();
  if (!normalizedThreadKey || !normalizedAckStage) {
    return false;
  }

  const window = burstWindows.get(normalizedThreadKey);
  if (!window || window.lastAckStage !== normalizedAckStage || window.lastAckSentAt <= 0) {
    return false;
  }

  return now - window.lastAckSentAt <= activePolicy.cooldownMs;
}

export function recordAckSent(
  threadKey: string,
  ackStage: string,
  routePhase: string,
  now = nowMs(),
): void {
  const normalizedThreadKey = asThreadKey(threadKey);
  if (!normalizedThreadKey) {
    return;
  }

  const window = ensureWindow(normalizedThreadKey);
  window.lastAckSentAt = now;
  window.lastAckStage = ackStage.trim();
  window.lastRoutePhase = routePhase.trim();
  window.state = syncWindowState(normalizedThreadKey, now);
}

export function shouldSuppressAck(
  threadKey: string,
  ackStage: string,
  routePhase: string,
  context: SuppressContext = {},
  gate: AckGateState = {},
): SuppressDecision {
  const normalizedThreadKey = asThreadKey(threadKey);
  const normalizedAckStage = ackStage.trim();
  const normalizedRoutePhase = routePhase.trim() || context.routePhase?.trim() || "";
  const silence = checkSilence(normalizedThreadKey);
  const window = normalizedThreadKey ? burstWindows.get(normalizedThreadKey) : undefined;

  if (gate.delivered) {
    return { suppressed: true, reason: "delivered" };
  }
  if (gate.final_response_streaming) {
    return { suppressed: true, reason: "final_response_streaming" };
  }
  if (gate.delivery_pending) {
    return { suppressed: true, reason: "delivery_pending" };
  }
  if (gate.formal_reply_visible) {
    return { suppressed: true, reason: "formal_reply_visible" };
  }

  if (
    normalizedThreadKey
    && normalizedAckStage
    && isInCooldown(normalizedThreadKey, normalizedAckStage)
    && window
    && window.lastRoutePhase === normalizedRoutePhase
  ) {
    return { suppressed: true, reason: "cooldown_same_state" };
  }

  if (context.mainModelStartedOutput === true) {
    return { suppressed: true, reason: "main_model_started_output" };
  }

  if (silence.burstState === "active") {
    return { suppressed: true, reason: "same_burst" };
  }

  if (context.anchorExists === true && context.channelSupportsUpdate === true) {
    return { suppressed: true, reason: "anchor_update_preferred" };
  }

  if (context.channelSupportsUpdate === false) {
    return { suppressed: true, reason: "channel_not_suitable_for_short_status" };
  }

  if (context.userInputActive === true || silence.isSilent === false) {
    return { suppressed: true, reason: "user_input_still_active" };
  }

  const eligible = gate.tool_active || gate.blocked
    || (gate.native_state === "blocked");
  if (!eligible && (gate.tool_active !== undefined || gate.blocked !== undefined)) {
    return { suppressed: true, reason: "not_ack_eligible_no_active_work" };
  }

  return { suppressed: false, reason: "allow" };
}

export function getBurstState(threadKey: string): BurstState {
  const normalizedThreadKey = asThreadKey(threadKey);
  if (!normalizedThreadKey) {
    return "idle";
  }
  return syncWindowState(normalizedThreadKey, nowMs());
}

export function resetBurstState(threadKey?: string): void {
  const normalizedThreadKey = threadKey?.trim() ?? "";
  if (!normalizedThreadKey) {
    burstWindows.clear();
    burstMetadata.clear();
    return;
  }

  burstWindows.delete(normalizedThreadKey);
  burstMetadata.delete(normalizedThreadKey);
}
