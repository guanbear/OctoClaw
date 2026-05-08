import { buildStatusQueryPacket } from "./core/delegate/index.js";
import type { DelegateAttempt, DelegateProgressEvent, DelegateTask, NativeTaskBinding, StatusQueryPacket } from "@octoclaw/contracts/delegate";
import { normalizeInboundPrompt } from "./resolve/session.js";
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
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return String((part as { text: string }).text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return String((content as { text: string }).text).trim();
  }
  return "";
}

export function extractPromptText(event: UnknownRecord): string {
  const prompt = stringValue(event.prompt);
  if (prompt) {
    return normalizeInboundPrompt(prompt) || prompt;
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
