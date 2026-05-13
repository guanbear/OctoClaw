import { stringValue } from "../extension-entry-shared.js";

export const LATENCY_ACK_DELAY_MS = 3500;
export const pendingLatencyAckTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const pendingNeutralInboundAckTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const pendingNeutralInboundAckTextFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const pendingBudgetedMainTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const lastGroundedPromptByStateKey = new Map<string, string>();

export function configuredNeutralAckDelayMs(hookName: string, preferReaction: boolean): number {
  const raw = Number(process.env.OCTOCLAW_NEUTRAL_ACK_DELAY_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  if (preferReaction) return 0;
  const slowTextRaw = Number(process.env.OCTOCLAW_TEXT_ACK_DELAY_MS);
  if (Number.isFinite(slowTextRaw) && slowTextRaw >= 0) return slowTextRaw;
  return hookName === "before_prompt_build" ? 800 : 2_500;
}

export function configuredNeutralAckTextFallbackDelayMs(): number {
  const raw = Number(process.env.OCTOCLAW_NEUTRAL_ACK_TEXT_FALLBACK_DELAY_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 6_500;
}

export function neutralAckTimerKey(sessionKey: string, replyToMessageId: string): string {
  return `${sessionKey}::${replyToMessageId}`;
}

export function neutralAckTextFallbackTimerKey(sessionKey: string, replyToMessageId: string): string {
  return `${sessionKey}::${replyToMessageId}::text-fallback`;
}

export interface CanceledNeutralAckTimer {
  sessionKey: string;
  replyToMessageId: string;
  fallbackStage?: string;
}

export function parseNeutralAckTimerKey(key: string): CanceledNeutralAckTimer | null {
  const suffix = "::text-fallback";
  const normalizedKey = key.endsWith(suffix) ? key.slice(0, -suffix.length) : key;
  const separatorIndex = normalizedKey.lastIndexOf("::");
  if (separatorIndex <= 0) return null;
  const sessionKey = normalizedKey.slice(0, separatorIndex);
  const replyToMessageId = normalizedKey.slice(separatorIndex + 2);
  if (!sessionKey || !replyToMessageId) return null;
  return {
    sessionKey,
    replyToMessageId,
    ...(key.endsWith(suffix) ? { fallbackStage: "text_after_reaction_failed" } : {}),
  };
}

export function cancelNeutralAckTimersByCandidates(sessionKeys: string[], replyToMessageIds: string[]): CanceledNeutralAckTimer[] {
  const normalizedSessionKeys = Array.from(new Set(sessionKeys.map((value) => stringValue(value)).filter(Boolean)));
  if (normalizedSessionKeys.length === 0) return [];
  const normalizedReplyIds = new Set(replyToMessageIds.map((value) => stringValue(value)).filter(Boolean));
  const canceled: CanceledNeutralAckTimer[] = [];
  const cancelFromMap = (timers: Map<string, ReturnType<typeof setTimeout>>): void => {
    for (const [key, timer] of Array.from(timers.entries())) {
      const parsed = parseNeutralAckTimerKey(key);
      if (!parsed) continue;
      if (!normalizedSessionKeys.includes(parsed.sessionKey)) continue;
      if (normalizedReplyIds.size > 0 && !normalizedReplyIds.has(parsed.replyToMessageId)) continue;
      clearTimeout(timer);
      timers.delete(key);
      canceled.push(parsed);
    }
  };
  cancelFromMap(pendingNeutralInboundAckTimers);
  cancelFromMap(pendingNeutralInboundAckTextFallbackTimers);
  return canceled;
}

export function resetAllTimersForTests(): void {
  pendingLatencyAckTimers.clear();
  pendingNeutralInboundAckTimers.clear();
  pendingNeutralInboundAckTextFallbackTimers.clear();
  pendingBudgetedMainTimers.clear();
  lastGroundedPromptByStateKey.clear();
}
