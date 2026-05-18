export type AckRoutePhase = "delegate" | "observe" | "reply" | "pre_route" | "unknown";

export interface AckTimingConfig {
  tierDelaysMs: [number, number, number, number];
}

export const ACK_TIMING = {
  reaction_ack_ms: 300,
  text_ack0_ms: 2500,
  ack0_hard_ceiling_ms: 5000,
  tier1_ms: 12_000,
  tier2_ms: 30_000,
  tier3_ms: 90_000,
} as const;

export const DEFAULT_TIER_DELAYS_MS: [number, number, number, number] = [ACK_TIMING.tier1_ms, ACK_TIMING.tier2_ms, ACK_TIMING.tier3_ms, 0];

export function getAckTierDelays(routePhase: AckRoutePhase): [number, number, number] {
  if (routePhase === "delegate" || routePhase === "observe") {
    return [0, 0, 0];
  }
  return [DEFAULT_TIER_DELAYS_MS[0], DEFAULT_TIER_DELAYS_MS[1], DEFAULT_TIER_DELAYS_MS[2]];
}

export interface AckTimerState {
  stateKey: string;
  sessionKey: string;
  routePhase: AckRoutePhase;
  inboundTs: number;
  tier0Timer: ReturnType<typeof setTimeout> | null;
  tier1Timer: ReturnType<typeof setTimeout> | null;
  tier2Timer: ReturnType<typeof setTimeout> | null;
  tier3Timer: ReturnType<typeof setTimeout> | null;
  tier0Fired: boolean;
  tier1Fired: boolean;
  tier2Fired: boolean;
  tier3Fired: boolean;
  cancelled: boolean;
}

export interface AckTimerResult {
  tier: number;
  stage: string;
  routePhase: AckRoutePhase;
}

export type ChannelStreamingMode = "native" | "partial" | "off";

export interface CreateAckTimersParams {
  stateKey: string;
  sessionKey: string;
  routePhase: AckRoutePhase;
  inboundTs?: number;
  onTierFire: (result: AckTimerResult) => void;
  config?: Partial<AckTimingConfig>;
  channelStreaming?: ChannelStreamingMode;
}

export const DEFAULT_ACK_TIMING_CONFIG: AckTimingConfig = {
  tierDelaysMs: DEFAULT_TIER_DELAYS_MS,
};

const ackTimersByStateKey = new Map<string, AckTimerState>();
const stateKeyBySessionKey = new Map<string, string>();

function normalizeKey(value: string): string {
  return value.trim();
}

function resolveConfig(config?: Partial<AckTimingConfig>): AckTimingConfig {
  return {
    tierDelaysMs: config?.tierDelaysMs ?? DEFAULT_ACK_TIMING_CONFIG.tierDelaysMs,
  };
}

function stateForKey(key: string): AckTimerState | null {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) {
    return null;
  }

  const direct = ackTimersByStateKey.get(normalizedKey);
  if (direct) {
    return direct;
  }

  const stateKey = stateKeyBySessionKey.get(normalizedKey);
  return stateKey ? (ackTimersByStateKey.get(stateKey) ?? null) : null;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) {
    clearTimeout(timer);
  }
  return null;
}

function clearAllStateTimers(state: AckTimerState): void {
  state.tier0Timer = clearTimer(state.tier0Timer);
  state.tier1Timer = clearTimer(state.tier1Timer);
  state.tier2Timer = clearTimer(state.tier2Timer);
  state.tier3Timer = clearTimer(state.tier3Timer);
}

function unregisterState(state: AckTimerState): void {
  ackTimersByStateKey.delete(state.stateKey);
  if (state.sessionKey) {
    const mappedStateKey = stateKeyBySessionKey.get(state.sessionKey);
    if (mappedStateKey === state.stateKey) {
      stateKeyBySessionKey.delete(state.sessionKey);
    }
  }
}

function cancelState(state: AckTimerState): void {
  state.cancelled = true;
  clearAllStateTimers(state);
  unregisterState(state);
}

function stageForTier(tier: number, _routePhase: AckRoutePhase): string {
  if (tier === 0) return "tool_still_working";
  if (tier === 1) return "tool_ask_continue";
  return "tool_suggest_stop";
}

export function shouldScheduleTier(routePhase: AckRoutePhase, tier: number): boolean {
  if (routePhase !== "reply") {
    return false;
  }
  return tier === 0 || tier === 1 || tier === 2;
}

function fireTier(
  state: AckTimerState,
  tier: 0 | 1 | 2 | 3,
  onTierFire: (result: AckTimerResult) => void,
): void {
  if (state.cancelled) {
    return;
  }

  if (tier === 0) {
    state.tier0Fired = true;
    state.tier0Timer = null;
  } else if (tier === 1) {
    state.tier1Fired = true;
    state.tier1Timer = null;
  } else if (tier === 2) {
    state.tier2Fired = true;
    state.tier2Timer = null;
  } else {
    state.tier3Fired = true;
    state.tier3Timer = null;
  }

  if (state.cancelled) {
    return;
  }

  onTierFire({
    tier,
    stage: stageForTier(tier, state.routePhase),
    routePhase: state.routePhase,
  });
}

export function createAckTimers(params: CreateAckTimersParams): AckTimerState {
  const stateKey = normalizeKey(params.stateKey);
  const sessionKey = normalizeKey(params.sessionKey);

  if (!stateKey) {
    throw new Error("createAckTimers requires a non-empty stateKey");
  }
  if (!sessionKey) {
    throw new Error("createAckTimers requires a non-empty sessionKey");
  }

  cancelAckTimers(stateKey);
  cancelAckTimers(sessionKey);

  const config = resolveConfig(params.config);
  const tierDelays = params.config?.tierDelaysMs ?? [...getAckTierDelays(params.routePhase), DEFAULT_TIER_DELAYS_MS[3]] as [number, number, number, number];
  const state: AckTimerState = {
    stateKey,
    sessionKey,
    routePhase: params.routePhase,
    inboundTs: params.inboundTs ?? Date.now(),
    tier0Timer: null,
    tier1Timer: null,
    tier2Timer: null,
    tier3Timer: null,
    tier0Fired: false,
    tier1Fired: false,
    tier2Fired: false,
    tier3Fired: false,
    cancelled: false,
  };

  const streamingSkipsTiers = params.channelStreaming === "native" || params.channelStreaming === "partial";

  if (!streamingSkipsTiers) {
    for (let tier = 0; tier <= 3; tier++) {
      const delayMs = tierDelays[tier] ?? config.tierDelaysMs[tier];
      if (!delayMs || !shouldScheduleTier(state.routePhase, tier)) continue;
      const timerRef = tier === 0 ? "tier0Timer" : tier === 1 ? "tier1Timer" : tier === 2 ? "tier2Timer" : "tier3Timer";
      state[timerRef] = setTimeout(() => {
        fireTier(state, tier as 0 | 1 | 2 | 3, params.onTierFire);
      }, delayMs);
    }
  }

  ackTimersByStateKey.set(stateKey, state);
  stateKeyBySessionKey.set(sessionKey, stateKey);
  return state;
}

export function cancelAckTimers(key: string): void {
  const state = stateForKey(key);
  if (!state) {
    return;
  }
  cancelState(state);
}

export function cancelAllAckTimers(): void {
  for (const state of ackTimersByStateKey.values()) {
    state.cancelled = true;
    clearAllStateTimers(state);
  }
  ackTimersByStateKey.clear();
  stateKeyBySessionKey.clear();
}

export function ackTimerStateForKey(key: string): AckTimerState | null {
  return stateForKey(key);
}

export function markMainModelFirstToken(stateKey: string): void {
  const state = ackTimersByStateKey.get(normalizeKey(stateKey));
  if (!state || state.cancelled || state.tier1Fired || !state.tier1Timer) {
    return;
  }
  state.tier1Timer = clearTimer(state.tier1Timer);
}

export function currentActiveTier(stateKey: string): number {
  const state = ackTimersByStateKey.get(normalizeKey(stateKey));
  if (!state) {
    return -1;
  }
  if (state.tier3Fired) {
    return 3;
  }
  if (state.tier2Fired) {
    return 2;
  }
  if (state.tier1Fired) {
    return 1;
  }
  if (state.tier0Fired) {
    return 0;
  }
  return -1;
}
