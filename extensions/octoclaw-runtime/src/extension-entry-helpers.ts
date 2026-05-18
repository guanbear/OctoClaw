import type { DelegateAttempt, DelegateProgressEvent, DelegateTask, NativeTaskBinding, RecoveryInfo, StatusQueryPacket, TimelineEntry } from "@octoclaw/contracts/delegate";
import { buildContractEnvelope } from "@octoclaw/contracts/schemas";
import { normalizeInboundPrompt } from "./resolve/session.js";
import { stripProjectionFooterFromText } from "./projection-footer-sanitizer.js";
import { policyState, type PolicyStateEntry } from "./state/policy-state.js";
import { type UnknownRecord, asRecord } from "./util/type-coercion.js";
import { stringValue } from "./extension-entry-shared.js";

export function resolveReactionAckConfig(pluginConfig: UnknownRecord | undefined, judgeFastRaw: UnknownRecord): {
  reactionEmoji: string;
  reactionAckEnabled: boolean;
} {
  const reactionEmoji = stringValue(pluginConfig?.ackReactionEmoji)
    || stringValue(judgeFastRaw.ackReactionEmoji);
  return {
    reactionEmoji,
    reactionAckEnabled: reactionEmoji.length > 0,
  };
}

export function buildPromptContextProjection(input: {
  prependSystem: string[];
  contextPayload: string;
  shouldInjectPolicyProjection: boolean;
}): { prependSystemContext?: string; prependContext?: string } | undefined {
  const systemContext = [...input.prependSystem];
  if (input.shouldInjectPolicyProjection && input.contextPayload) {
    systemContext.push([
      "[OctoClaw policy projection]",
      input.contextPayload,
      "[/OctoClaw policy projection]",
    ].join("\n"));
  }
  if (systemContext.length === 0) return undefined;
  return {
    prependSystemContext: systemContext.join("\n\n"),
  };
}

export function resolveDelegationCapability(options: {
  pluginConfig?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}): {
  requested: boolean;
  hostSupported: boolean;
  enabled: boolean;
  reason: "" | "disabled_by_config";
} {
  const pluginConfig = options.pluginConfig ?? {};
  const env = options.env ?? {};
  const requested = pluginConfig.delegationEnabled !== false && env.OCTOCLAW_DELEGATION_ENABLED !== "false";
  if (!requested) {
    return {
      requested: false,
      hostSupported: true,
      enabled: false,
      reason: "disabled_by_config",
    };
  }
  return {
    requested: true,
    hostSupported: true,
    enabled: true,
    reason: "",
  };
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return stripProjectionFooterFromText(content);
  }
  if (Array.isArray(content)) {
    return stripProjectionFooterFromText(content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return String((part as { text: string }).text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n"));
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return stripProjectionFooterFromText(String((content as { text: string }).text));
  }
  return "";
}

export function extractPromptText(event: UnknownRecord): string {
  const prompt = stringValue(event.prompt);
  if (prompt) {
    return normalizeInboundPrompt(prompt) || prompt;
  }
  for (const key of ["content", "body", "text"] as const) {
    const text = extractMessageText(event[key]);
    if (text) {
      return normalizeInboundPrompt(text) || text;
    }
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    if (stringValue((message as UnknownRecord).role).toLowerCase() !== "user") {
      continue;
    }
    const text = extractMessageText((message as UnknownRecord).content);
    if (text) {
      return normalizeInboundPrompt(text) || text;
    }
  }
  return "";
}

function isDelegateTask(value: unknown): value is DelegateTask {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { delegateTaskId?: unknown }).delegateTaskId === "string"
    && typeof (value as { status?: unknown }).status === "string";
}

function isDelegateAttempt(value: unknown): value is DelegateAttempt {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { attemptId?: unknown }).attemptId === "string"
    && typeof (value as { delegateTaskId?: unknown }).delegateTaskId === "string";
}

function isNativeTaskBinding(value: unknown): value is NativeTaskBinding {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { delegateTaskId?: unknown }).delegateTaskId === "string"
    && typeof (value as { attemptId?: unknown }).attemptId === "string"
    && typeof (value as { nativeTaskId?: unknown }).nativeTaskId === "string";
}

function isDelegateProgressEvent(value: unknown): value is DelegateProgressEvent {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { delegateTaskId?: unknown }).delegateTaskId === "string"
    && typeof (value as { attemptId?: unknown }).attemptId === "string"
    && typeof (value as { eventAt?: unknown }).eventAt === "string"
    && typeof (value as { summary?: unknown }).summary === "string";
}

function collectDelegateProgressEvents(state: PolicyStateEntry): DelegateProgressEvent[] {
  const events = Array.isArray(state.delegateProgressEvents) ? state.delegateProgressEvents : [];
  return events.filter(isDelegateProgressEvent);
}

function buildTimelineEntries(progressEvents: DelegateProgressEvent[]): TimelineEntry[] {
  return [...progressEvents]
    .sort((left, right) => Date.parse(left.eventAt) - Date.parse(right.eventAt))
    .slice(-50)
    .map((event) => ({
      eventAt: event.eventAt,
      eventType: event.eventType,
      summary: event.summary,
    }));
}

function buildStatusQueryPacket(input: {
  delegateTask: DelegateTask;
  currentAttempt: DelegateAttempt | null;
  nativeBinding: NativeTaskBinding | null;
  progressEvents: DelegateProgressEvent[];
  recoveryInfo?: RecoveryInfo | null;
}): StatusQueryPacket {
  const queriedAt = new Date().toISOString();
  const timelineEntries = buildTimelineEntries(input.progressEvents);
  return {
    ...buildContractEnvelope("projection", queriedAt),
    kind: "projection",
    delegateTaskId: input.delegateTask.delegateTaskId,
    currentAttemptId: input.delegateTask.currentAttemptId,
    currentAttemptStatus: input.currentAttempt?.status ?? null,
    nativeBinding: input.nativeBinding,
    taskStatus: input.delegateTask.status,
    role: input.delegateTask.role,
    coordinationMode: input.delegateTask.coordinationMode,
    modelProfile: input.currentAttempt?.modelProfile ?? null,
    backend: input.currentAttempt?.backend ?? null,
    totalAttempts: input.delegateTask.totalAttempts,
    timeline: {
      entries: timelineEntries,
      lastEventAt: timelineEntries.at(-1)?.eventAt ?? null,
      totalEvents: input.progressEvents.length,
    },
    recoveryInfo: input.recoveryInfo ?? null,
    queriedAt,
  };
}

export function queryDelegateStatus(delegateTaskId: string): StatusQueryPacket | null {
  const targetId = stringValue(delegateTaskId);
  if (!targetId) {
    return null;
  }

  for (const { state } of policyState.entries()) {
    const decision = asRecord(state.decision);
    const runtimeTruth = asRecord(decision.runtime_truth);
    const delegateTaskCandidate = runtimeTruth.delegateTask;
    if (!isDelegateTask(delegateTaskCandidate) || delegateTaskCandidate.delegateTaskId !== targetId) {
      continue;
    }

    const currentAttemptCandidate = runtimeTruth.delegateAttempt;
    const nativeBindingCandidate = runtimeTruth.nativeTaskBinding;
    return buildStatusQueryPacket({
      delegateTask: delegateTaskCandidate,
      currentAttempt: isDelegateAttempt(currentAttemptCandidate) ? currentAttemptCandidate : null,
      nativeBinding: isNativeTaskBinding(nativeBindingCandidate) ? nativeBindingCandidate : null,
      progressEvents: collectDelegateProgressEvents(state).filter((event) => event.delegateTaskId === targetId),
      recoveryInfo: isDelegateAttempt(currentAttemptCandidate) ? currentAttemptCandidate.recoveryInfo ?? null : null,
    });
  }

  return null;
}
