export type AckRoutePhase = "delegate" | "observe" | "reply" | "pre_route" | "unknown";

export interface AckTimingConfig {
  tier0DelayMs: number;
  tier1DeadlineMs: number;
  tier2DeadlineMs: number;
  tier3DeadlineMs: number;
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

export interface CreateAckTimersParams {
  stateKey: string;
  sessionKey: string;
  routePhase: AckRoutePhase;
  inboundTs?: number;
  onTierFire: (result: AckTimerResult) => void;
  config?: Partial<AckTimingConfig>;
}

export const DEFAULT_ACK_TIMING_CONFIG: AckTimingConfig = {
  tier0DelayMs: 500,
  tier1DeadlineMs: 3000,
  tier2DeadlineMs: 7000,
  tier3DeadlineMs: 11000,
};

const ackTimersByStateKey = new Map<string, AckTimerState>();
const stateKeyBySessionKey = new Map<string, string>();

function normalizeKey(value: string): string {
  return value.trim();
}

function resolveConfig(config?: Partial<AckTimingConfig>): AckTimingConfig {
  return {
    tier0DelayMs: config?.tier0DelayMs ?? DEFAULT_ACK_TIMING_CONFIG.tier0DelayMs,
    tier1DeadlineMs: config?.tier1DeadlineMs ?? DEFAULT_ACK_TIMING_CONFIG.tier1DeadlineMs,
    tier2DeadlineMs: config?.tier2DeadlineMs ?? DEFAULT_ACK_TIMING_CONFIG.tier2DeadlineMs,
    tier3DeadlineMs: config?.tier3DeadlineMs ?? DEFAULT_ACK_TIMING_CONFIG.tier3DeadlineMs,
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

function stageForTier0(routePhase: AckRoutePhase): string {
  switch (routePhase) {
    case "delegate":
      return "delegate_started";
    case "observe":
      return "observe_started";
    case "pre_route":
      return "pre_route_soft_ack";
    default:
      return "soft_ack";
  }
}

function stageForTier(tier: number, routePhase: AckRoutePhase): string {
  if (tier === 0) {
    return stageForTier0(routePhase);
  }
  if (tier === 1) {
    return "reply_soft_ack";
  }
  if (tier === 2) {
    return "progress_nudge";
  }
  return "progress_nudge_explicit_stage";
}

function shouldScheduleTier(routePhase: AckRoutePhase, tier: number): boolean {
  if (routePhase === "delegate" || routePhase === "observe") {
    return tier === 0 || tier === 2 || tier === 3;
  }
  if (routePhase === "reply") {
    return tier === 1 || tier === 2 || tier === 3;
  }
  if (routePhase === "pre_route") {
    return tier === 0 || tier === 2;
  }
  return false;
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

  if (shouldScheduleTier(state.routePhase, 0)) {
    state.tier0Timer = setTimeout(() => {
      fireTier(state, 0, params.onTierFire);
    }, config.tier0DelayMs);
  }

  if (shouldScheduleTier(state.routePhase, 1)) {
    state.tier1Timer = setTimeout(() => {
      fireTier(state, 1, params.onTierFire);
    }, config.tier1DeadlineMs);
  }

  if (shouldScheduleTier(state.routePhase, 2)) {
    state.tier2Timer = setTimeout(() => {
      fireTier(state, 2, params.onTierFire);
    }, config.tier2DeadlineMs);
  }

  if (shouldScheduleTier(state.routePhase, 3)) {
    state.tier3Timer = setTimeout(() => {
      fireTier(state, 3, params.onTierFire);
    }, config.tier3DeadlineMs);
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
