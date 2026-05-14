// Internal state tracking (memory-only, no persistence)
interface JudgeCooldownState {
  modelId: string;
  callLog: Array<{ timestamp: number; success: boolean }>;
  cooldownUntil: number | null;
}

const WINDOW_SIZE = 10;
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30 * 60 * 1000;

const cooldownByModel = new Map<string, JudgeCooldownState>();
let mockNowForTests: (() => number) | null = null;

function now(): number {
  return mockNowForTests?.() ?? Date.now();
}

function stateFor(modelId: string): JudgeCooldownState {
  const existing = cooldownByModel.get(modelId);
  if (existing) return existing;

  const state: JudgeCooldownState = {
    modelId,
    callLog: [],
    cooldownUntil: null,
  };
  cooldownByModel.set(modelId, state);
  return state;
}

function trimToWindow(state: JudgeCooldownState): void {
  if (state.callLog.length > WINDOW_SIZE) {
    state.callLog = state.callLog.slice(-WINDOW_SIZE);
  }
}

function resetExpiredCooldown(state: JudgeCooldownState): void {
  if (state.cooldownUntil !== null && state.cooldownUntil <= now()) {
    state.cooldownUntil = null;
    state.callLog = [];
  }
}

function countRecentFailures(state: JudgeCooldownState): number {
  return state.callLog.slice(-WINDOW_SIZE).filter((call) => !call.success).length;
}

export function isHealthGatesDisabled(): boolean {
  return process.env.OCTOCLAW_DISABLE_HEALTH_GATES === "1";
}

export function isJudgeInCooldown(modelId: string): boolean {
  if (isHealthGatesDisabled()) return false;

  const state = cooldownByModel.get(modelId);
  if (!state) return false;

  resetExpiredCooldown(state);
  return state.cooldownUntil !== null && state.cooldownUntil > now();
}

export function recordJudgeSuccess(modelId: string): void {
  const state = stateFor(modelId);
  resetExpiredCooldown(state);
  state.callLog.push({ timestamp: now(), success: true });
  state.cooldownUntil = null;
  trimToWindow(state);
}

export function recordJudgeFailure(modelId: string): boolean {
  const state = stateFor(modelId);
  resetExpiredCooldown(state);

  const wasInCooldown = state.cooldownUntil !== null && state.cooldownUntil > now();
  state.callLog.push({ timestamp: now(), success: false });
  trimToWindow(state);

  if (countRecentFailures(state) >= FAILURE_THRESHOLD) {
    state.cooldownUntil = now() + COOLDOWN_MS;
    return !wasInCooldown;
  }

  return false;
}

export function resetCooldownForTests(): void {
  cooldownByModel.clear();
}

export function setMockNowForTests(fn: (() => number) | null): void {
  mockNowForTests = fn;
}
