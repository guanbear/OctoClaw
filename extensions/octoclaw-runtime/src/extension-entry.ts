import {
  buildConversationGrounding,
  buildDirectLookupGuard,
} from "./conversation-grounding.js";
import {
  buildStatusQueryPacket,
} from "@octoclaw/runtime-core/delegate";
import type {
  DelegateAttempt,
  DelegateProgressEvent,
  DelegateTask,
  NativeTaskBinding,
  StatusQueryPacket,
} from "@octoclaw/contracts/delegate";
import {
  cancelAckGuard,
  cancelAckGuardForState,
  maybeSendLatencyAck,
  notifyUserMessage,
  startAckGuard,
  updateAckTrackingState,
  watchdogTick,
  WATCHDOG_INTERVAL_MS,
} from "./ack/ack-guard.js";
import { sendDelegateWithoutDispatchNotice } from "./ack/ack-delegate-without-dispatch.js";
import { sendRouteCommitAck } from "./ack/ack-route-commit.js";
import {
  buildPolicyMetadata,
  detectSessionBoundary,
  isManagedAgentContext,
  normalizeInboundPrompt,
  resolveAckDeliverySessionKey,
  resolvePolicyStateKey,
  resolvePolicyStateKeys,
} from "./resolve/session.js";
import { checkActiveTaskRecovery, resolvePolicyDecisionForContext } from "./resolve/policy-resolver.js";
import { envOverrides, resolveReplayLogPath, resolveTaskStatePath, resolveWorkspaceRoot } from "./resolve/env.js";
import {
  DEFAULT_TASK_STATE_RETENTION_MIN_RUN_INTERVAL_MS,
  pruneTaskStateCache,
} from "./state/task-state-retention.js";
import { buildLiveJudgeContextPacket } from "./resolve/llm-judge.js";
import { initNativeHelperBridge } from "./adapter/native-helper.js";
import type { DetachedTaskLifecycleRuntime } from "./adapter/detached-task-runtime.js";
import { createHostDetachedTaskLifecycleRuntime } from "./adapter/detached-task-runtime-host.js";
import {
  compactPolicyPrompt,
  guardAssistantMessageForPolicyState,
  isControlObserverDecision,
  isDelegatedRoute,
  isSessionControlDecision,
  matchesBlockedPattern,
  observerControlTools,
  preHintAllowedTools,
  recordAckReplay,
  recordDeliveryRelayEvent,
  recordObservedDeliveryFromMessage,
  recordPolicyReplay,
  routeHintRequired,
  sessionControlTools,
  shouldRetainPolicyStateOnAgentEnd,
  stringifyParamsForPolicy,
  buildTurnExecutionReceipt,
  type TurnExecutionReceipt,
  workflowEnforcementRule,
} from "./replay/replay-logger.js";
import { policyState, type PolicyStateEntry } from "./state/policy-state.js";
import { getCommandRegistrations, getToolRegistrations } from "./tools/registration.js";

type UnknownRecord = Record<string, unknown>;
type HookHandler = (event: UnknownRecord, ctx: UnknownRecord) => unknown;

interface LoggerLike {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

export interface PluginInterface {
  pluginConfig?: Record<string, unknown>;
  logger?: LoggerLike;
  on?(event: string, handler: HookHandler, options?: Record<string, unknown>): void;
  registerHook?(event: string, handler: HookHandler, options?: Record<string, unknown>): void;
  registerTool?(definition: Record<string, unknown>): void;
  registerCommand?(definition: Record<string, unknown>): void;
  registerDetachedTaskRuntime?(runtime: DetachedTaskLifecycleRuntime): void;
}

const OCTOCLAW_DELEGATION_SYSTEM_CONTEXT = [
  "OctoClaw runtime policy is authoritative for this run.",
  "When route is delegated, the main agent is a coordinator and must use OctoClaw control tools instead of doing the work directly.",
  "Do not hand-write session or subagent spawning commands.",
  "Do not explain delegation strategy, routing rationale, or task boundary analysis to the user. Use octoclaw_dispatch directly.",
  "Do not emit user-visible coordinator chatter such as '我来写'、'收到，我看一下'、'我先确认一下派发边界'. Runtime ACK handles that.",
  "User-visible output should only contain: brief acknowledgment, authoritative status receipt, or final result/clear failure.",
].join("\n");

const LATENCY_ACK_DELAY_MS = 3500;
const pendingLatencyAckTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastGroundedPromptByStateKey = new Map<string, string>();
let warnedMissingDetachedRuntime = false;

const OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT = [
  "For non-hard-observe requests, submit a structured route hint before answering or dispatching.",
  "Use octoclaw_route_hint to state whether this should be reply or delegate. Read-only observation is delegate with observer role.",
  "After route_hint merge: reply may answer directly; delegated routes must go through octoclaw_dispatch.",
  "",
  "Prefer delegation for multi-step tasks (writing code, research, analysis, file changes).",
  "Handle directly only for simple Q&A, greetings, or quick clarifications.",
].join("\n");

const OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT = [
  "When the user asks for task progress or acts on an OctoClaw task anchor, prefer the octoclaw_task_action tool.",
  "Use it for commands like: details <task_id>, queue, artifacts <task_id>, stop <task_id>, retry <task_id>, approve <task_id>, reject <task_id>.",
].join("\n");

const OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT = [
  "This task requires review before dispatch. Proceed directly with octoclaw_dispatch — do not echo reasoning about task boundaries or delegation strategy to the user.",
].join("\n");

let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let taskStateRetentionInterval: ReturnType<typeof setInterval> | null = null;


function runTaskStateRetention(logger?: LoggerLike): void {
  try {
    const result = pruneTaskStateCache();
    if (result.archived > 0 || (result.deletedArchiveEntries ?? 0) > 0) {
      logger?.debug?.(`octoclaw task-state retention archived=${result.archived} archive_deleted=${result.deletedArchiveEntries ?? 0}`);
    }
  } catch (error) {
    logger?.warn?.(`octoclaw task-state retention failed: ${String(error)}`);
  }
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

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter(Boolean)
    : [];
}

function buildRecentExecutionFacts(receipts: TurnExecutionReceipt[]): string {
  if (receipts.length === 0) return "";
  const lines = receipts.map((r, i) => {
    const parts = [`Turn ${i + 1}: route=${r.route}`];
    if (r.delegated) {
      parts.push(`delegated=true, dispatch_executed=${r.dispatchExecuted}, spawn_executed=${r.spawnExecuted}`);
      if (r.nativeTaskId) parts.push(`native_task_id=${r.nativeTaskId}`);
      if (r.nativeFlowId) parts.push(`native_flow_id=${r.nativeFlowId}`);
      parts.push(`worker=${r.workerPool ?? "unknown"}, task_id=${r.delegateTaskId ?? "unknown"}`);
    }
    if (r.resultMaterialized) parts.push(`result_materialized=true`);
    if (r.deliveryStatus) parts.push(`delivery_status=${r.deliveryStatus}`);
    if (r.toolsUsed.length > 0) {
      parts.push(`tools=[${r.toolsUsed.join(", ")}]`);
    }
    parts.push(`outcome=${r.outcome}, duration=${r.durationMs}ms`);
    return parts.join(", ");
  });
  return `[RecentExecutionFacts]\n${lines.join("\n")}\n[/RecentExecutionFacts]`;
}

function collectRecentExecutionReceipts(currentSessionKey: string | null = null, limit = 3): TurnExecutionReceipt[] {
  return policyState.entries()
    .map(({ state, key }) => ({ state, key }))
    .filter(({ state }) => {
      if (!state?.decision) return false;
      if (!currentSessionKey) return false;
      const stateSession = stringValue(state.canonicalSessionKey);
      return stateSession === currentSessionKey;
    })
    .sort((left, right) => Number(right.state.updatedAt || right.state.createdAt || 0) - Number(left.state.updatedAt || left.state.createdAt || 0))
    .slice(0, limit)
    .reverse()
    .map(({ state }) => buildTurnExecutionReceipt(
      state as Parameters<typeof buildTurnExecutionReceipt>[0],
      Math.max(0, Number(state.updatedAt || 0) - Number(state.createdAt || state.updatedAt || 0)),
      Number(state.updatedAt || state.createdAt || Date.now()) || undefined,
    ));
}

export function resolveDelegationCapability(options: {
  pluginConfig?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  registerDetachedTaskRuntime?: PluginInterface["registerDetachedTaskRuntime"];
}): {
  requested: boolean;
  hostSupported: boolean;
  enabled: boolean;
  reason: "" | "host_missing_detached_runtime" | "disabled_by_config";
} {
  const pluginConfig = options.pluginConfig ?? {};
  const env = options.env ?? {};
  const requested = pluginConfig.delegationEnabled !== false && env.OCTOCLAW_DELEGATION_ENABLED !== "false";
  const hostSupported = typeof options.registerDetachedTaskRuntime === "function";
  if (!requested) {
    return {
      requested: false,
      hostSupported,
      enabled: false,
      reason: "disabled_by_config",
    };
  }
  if (!hostSupported) {
    return {
      requested: true,
      hostSupported: false,
      enabled: false,
      reason: "host_missing_detached_runtime",
    };
  }
  return {
    requested: true,
    hostSupported: true,
    enabled: true,
    reason: "",
  };
}

function extractMessageText(content: unknown): string {
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

function extractPromptText(event: UnknownRecord): string {
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

function getPolicyStateForContext(ctx: UnknownRecord): { key: string; state: PolicyStateEntry | null } {
  const resolved = policyState.resolveForContext(ctx);
  return {
    key: stringValue(resolved.key),
    state: resolved.state ?? null,
  };
}

function updatePolicyState(stateKey: string, mutator: (current: PolicyStateEntry) => PolicyStateEntry): void {
  const key = stringValue(stateKey);
  if (!key) {
    return;
  }
  policyState.update(key, (current) => mutator(current));
}

function clearPolicyStateForContext(ctx: UnknownRecord): void {
  const { key } = getPolicyStateForContext(ctx);
  if (key) {
    policyState.clear(key);
  }
}

function toOpenClawToolDefinition(definition: Record<string, unknown>): Record<string, unknown> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.params,
    execute: async (
      _toolCallId: unknown,
      params: Record<string, unknown>,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: Record<string, unknown>,
    ) => {
      const execute = definition.execute as ((params: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown>>);
      const result = await execute(params, ctx);
      if (definition.name === "octoclaw_dispatch") {
        logDispatchOutcome(result, asRecord(ctx).logger as LoggerLike | undefined);
      }
      return result;
    },
  };
}

function logDispatchOutcome(dispatchResult: unknown, logger?: LoggerLike): void {
  if (!dispatchResult) return;
  try {
    const resultRecord = asRecord(dispatchResult);
    const candidate = typeof dispatchResult === "string"
      ? dispatchResult
      : typeof resultRecord.text === "string"
        ? resultRecord.text
        : dispatchResult;
    const parsed = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
    const parsedRecord = asRecord(parsed);
    if (parsedRecord.ok) {
      logger?.info?.(`[octoclaw] dispatch succeeded: route=${stringValue(parsedRecord.route)} worker=${stringValue(parsedRecord.worker_pool)} task_id=${stringValue(parsedRecord.task_id)}`);
    } else if (Object.prototype.hasOwnProperty.call(parsedRecord, "ok")) {
      logger?.warn?.(`[octoclaw] dispatch failed: error=${stringValue(parsedRecord.error)} seal_mismatch=${Boolean(parsedRecord.seal_mismatch)} retryable=${Boolean(parsedRecord.retryable)}`);
    }
  } catch { /* not JSON, legacy format */ }
}

function toOpenClawCommandDefinition(definition: Record<string, unknown>): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    acceptsArgs: definition.acceptsArgs,
    execute: async (ctx: Record<string, unknown>) => {
      const handler = definition.handler as (ctx: Record<string, unknown>) => Promise<void>;
      await handler(ctx);
    },
    handler: definition.handler,
  };
}

export const plugin = {
  id: "octoclaw-runtime",
  name: "OctoClaw Runtime",
  description: "Runtime policy hooks, dispatch tools, and replay logging for OctoClaw",
  register(pi: PluginInterface): void {
    envOverrides.octoclawRoot = stringValue(pi.pluginConfig?.octoclawRoot);
    envOverrides.workspaceRoot = stringValue(pi.pluginConfig?.workspaceRoot);

    const judgeFastFromPlugin = (pi.pluginConfig?.judgeFast && typeof pi.pluginConfig.judgeFast === "object" && !Array.isArray(pi.pluginConfig.judgeFast)) ? pi.pluginConfig.judgeFast as Record<string, unknown> : {};
    const judgeFastFromEnv = (() => {
      const json = process.env.OCTOCLAW_JUDGE_FAST?.trim();
      if (!json) return {};
      try { const p = JSON.parse(json); return (typeof p === "object" && p && !Array.isArray(p)) ? p as Record<string, unknown> : {}; } catch { return {}; }
    })();
    const judgeFastRaw = (Object.keys(judgeFastFromPlugin).length > 0) ? judgeFastFromPlugin : judgeFastFromEnv;
    const remoteJudgeFromEnv = (() => {
      const json = process.env.OCTOCLAW_JUDGE_REMOTE?.trim();
      if (!json) return {};
      try { const p = JSON.parse(json); return (typeof p === "object" && p && !Array.isArray(p)) ? p as Record<string, unknown> : {}; } catch { return {}; }
    })();
    const remoteJudgeFromPlugin = (pi.pluginConfig?.remoteJudge && typeof pi.pluginConfig.remoteJudge === "object" && !Array.isArray(pi.pluginConfig.remoteJudge))
      ? pi.pluginConfig.remoteJudge as Record<string, unknown>
      : {};
    const remoteJudgeRaw = Object.keys(remoteJudgeFromPlugin).length > 0 ? remoteJudgeFromPlugin : remoteJudgeFromEnv;

    if (process.env.OCTOCLAW_JUDGE_DEBUG) {
      console.log(`[octoclaw-judge] pluginKeys=${Object.keys(judgeFastFromPlugin).length} envKeys=${Object.keys(judgeFastFromEnv).length} rawKeys=${Object.keys(judgeFastRaw).length} envVar="${process.env.OCTOCLAW_JUDGE_FAST?.slice(0, 50) ?? "(none)"}" modelId="${(judgeFastRaw as Record<string, unknown>).modelId ?? "(none)"}"`);
    }

    const delegationCapability = resolveDelegationCapability({
      pluginConfig: asRecord(pi.pluginConfig),
      env: process.env as Record<string, string | undefined>,
      registerDetachedTaskRuntime: pi.registerDetachedTaskRuntime,
    });
    const delegationEnabled = delegationCapability.enabled;
    if (delegationCapability.reason === "host_missing_detached_runtime" && !warnedMissingDetachedRuntime) {
      warnedMissingDetachedRuntime = true;
      pi.logger?.warn?.(
        "octoclaw delegation disabled: host is missing registerDetachedTaskRuntime; delegate routes will fail closed to reply until detached runtime support is available",
      );
    }

    // Fire-and-forget bridge init — lazy-loads openclaw runtime binding
    // If runtime unavailable, getCachedBridge() returns unavailable bridge (fail-closed)
    initNativeHelperBridge().catch(() => { /* bridge will use unavailable fallback */ });
    if (delegationCapability.hostSupported) {
      void createHostDetachedTaskLifecycleRuntime()
        .then((runtime) => {
          pi.registerDetachedTaskRuntime?.(runtime);
          pi.logger?.debug?.("octoclaw detached task runtime registered");
        })
        .catch((error) => {
          pi.logger?.warn?.(`octoclaw detached task runtime unavailable: ${String(error)}`);
        });
    }

    const registerLifecycleHook = (hookName: string, handler: HookHandler, priority = 180): boolean => {
      if (typeof pi.on === "function") {
        pi.on(hookName, handler, { priority });
        pi.logger?.debug?.(`octoclaw hook registered via pi.on: ${hookName} (priority=${priority})`);
        return true;
      }
      if (typeof pi.registerHook === "function") {
        pi.registerHook(hookName, handler, { priority });
        return true;
      }
      return false;
    };

    registerLifecycleHook("before_model_resolve", async (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const prompt = extractPromptText(event);
      const resolved = await resolvePolicyDecisionForContext(
        prompt,
        ctx,
        process.cwd(),
        pi.logger,
      );
      const decision = asRecord(resolved?.decision);
      const hookConfig = asRecord(decision.hook_interface).before_model_resolve;
      const resolvedHookConfig = asRecord(hookConfig);
      if (!resolvedHookConfig.enabled) return;
      if (stringValue(asRecord(decision.route_decision).route || "reply") !== "reply") return;
      const modelOverride = stringValue(resolvedHookConfig.selected_model);
      if (!modelOverride) return;
      pi.logger?.debug?.(`octoclaw before_model_resolve modelOverride=${modelOverride}`);
      return { modelOverride };
    });

    registerLifecycleHook("before_prompt_build", async (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const prompt = extractPromptText(event);

      const preStateKey = resolvePolicyStateKey(ctx);
      const preMetadata = buildPolicyMetadata(ctx, { stateKey: preStateKey });
      const sessionKeys = resolvePolicyStateKeys(ctx);
      preMetadata.judge_replay_log_path = resolveReplayLogPath();
      preMetadata.judge_task_state_path = resolveTaskStatePath();
      preMetadata.judge_session_keys = sessionKeys;
      preMetadata.recent_execution_facts = buildRecentExecutionFacts(collectRecentExecutionReceipts(preStateKey));
      preMetadata.judge_context_packet = buildLiveJudgeContextPacket({
        prompt,
        metadata: preMetadata,
      });
      preMetadata._judgeFastConfig = judgeFastRaw;
      preMetadata._remoteJudgeConfig = Object.keys(remoteJudgeRaw).length > 0 ? remoteJudgeRaw : null;
      preMetadata._delegationEnabled = delegationEnabled;
      const preSessionKey = resolveAckDeliverySessionKey(preMetadata, preStateKey, getPolicyStateForContext(ctx).state, ctx);

      if (preSessionKey) {
        notifyUserMessage(preSessionKey, preStateKey);
      }

      let inboundMessageTs = "";
      {
        const inbound = asRecord(ctx.inboundMessage);
        const ev = asRecord(ctx.event);
        const hookEvent = asRecord(event);
        if (inbound && Object.keys(inbound).length > 0) inboundMessageTs = stringValue(inbound.ts || inbound.messageTs || inbound.messageId);
        else if (ev && Object.keys(ev).length > 0) inboundMessageTs = stringValue(ev.ts || ev.messageTs || ev.messageId);
        if (!inboundMessageTs) {
          const promptText = [prompt, extractPromptText(hookEvent)].filter(Boolean).join("\n");
          const msgIdMatch = promptText.match(/"(?:reply_to_id|message_id|ts)"\s*:\s*"([^"\n]+)"/u);
          if (msgIdMatch) inboundMessageTs = stringValue(msgIdMatch[1]);
        }
      }

      // When judgeAckEnabled=false: start latency timer BEFORE judge (fast ACK).
      // When judgeAckEnabled=true: ALSO start latency timer BEFORE judge so ACK0 fires at 5s from message arrival.
      // Judge ack_text can override the message if it returns before deadline.
      const pendingDecision: { value: UnknownRecord | null } = { value: null };

      const startLatencyAckTimer = (timerStateKey: string) => {
        const existingTimer = pendingLatencyAckTimers.get(timerStateKey);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(async () => {
          pendingLatencyAckTimers.delete(timerStateKey);
          const currentDecision = pendingDecision.value ?? {};
          const latencyMetadata = buildPolicyMetadata(ctx, { stateKey: timerStateKey });
          if (inboundMessageTs && !stringValue(latencyMetadata.message_id)) {
            latencyMetadata.message_id = inboundMessageTs;
          }
          const latencyResult = await maybeSendLatencyAck(currentDecision, latencyMetadata, timerStateKey, getPolicyStateForContext(ctx).state ?? {}, ctx, pi.logger ?? {}, "direct_lookup");
          if (latencyResult?.sent) {
            cancelAckGuard(preSessionKey);
          }
        }, LATENCY_ACK_DELAY_MS);
        pendingLatencyAckTimers.set(timerStateKey, timer);
      };

      startLatencyAckTimer(preStateKey);

      const resolved = await resolvePolicyDecisionForContext(
        prompt,
        ctx,
        process.cwd(),
        pi.logger,
      );
      pendingDecision.value = asRecord(resolved?.decision);

      const decision = asRecord(resolved?.decision);
      const hookConfig = asRecord(asRecord(decision.hook_interface).before_prompt_build);
      if (!hookConfig.enabled) return;
      const stateKey = stringValue(resolved?.stateKey || resolvePolicyStateKey(ctx) || "");
      const state = (resolved?.state as PolicyStateEntry | null | undefined) ?? getPolicyStateForContext(ctx).state;
      const recoveryCheck = isDelegatedRoute(decision)
        ? checkActiveTaskRecovery({
            taskId: stringValue(asRecord(asRecord(decision.runtime_truth).binding).taskId),
          })
        : { checkedAt: "", updatedCount: 0, timedOutCount: 0, recoveries: [] as UnknownRecord[] };
      const activeRecoveryState = recoveryCheck.updatedCount > 0 && stateKey
        ? getPolicyStateForContext({ ...ctx, canonicalSessionKey: stateKey }).state
        : state;
      const effectiveState = activeRecoveryState ?? state;
      const effectiveDecision = recoveryCheck.updatedCount > 0
        ? asRecord(effectiveState?.decision)
        : decision;

      // D1: Route Commit ACK — send truthful ACK projection after route seal, before dispatch.
      try {
        const routeCommitResult = await sendRouteCommitAck({
          sessionKey: preSessionKey || stringValue(ctx.sessionKey) || "",
          stateKey: stringValue(resolved?.stateKey || resolvePolicyStateKey(ctx) || ""),
          decision: effectiveDecision ?? {},
          state: effectiveState ?? {},
          replyToMessageId: inboundMessageTs,
          cwd: stringValue(ctx.cwd) || process.cwd(),
          logger: pi.logger,
        });
        if (routeCommitResult.sent && effectiveState) {
          effectiveState.routeCommitAckSent = true;
          effectiveState.route_commit_ack_sent = true;
          effectiveState.routeCommitAckId = routeCommitResult.routeCommitId;
        }
      } catch (routeCommitErr) {
        if (pi.logger?.warn) {
          pi.logger.warn(`octoclaw route-commit-ack error: ${String(routeCommitErr)}`);
        }
      }

      if (preSessionKey) {
        if (process.env.OCTOCLAW_ACK_DEBUG) {
          console.error(`[ack-dbg] preSessionKey=${preSessionKey.substring(0,40)} inboundMessageTs=${inboundMessageTs || "(empty)"}`);
        }
        startAckGuard(preSessionKey, stringValue(ctx.cwd) || process.cwd(), { stateKey, decision: effectiveDecision, replyToMessageId: inboundMessageTs });
      }
      if (effectiveState) {
        effectiveState.ackGuardKey = preSessionKey || "";
        if (inboundMessageTs) {
          effectiveState.inboundMessageTs = inboundMessageTs;
        }
      }

      const metadata = buildPolicyMetadata(ctx, { stateKey });
      if (inboundMessageTs && !stringValue(metadata.message_id)) {
        metadata.message_id = inboundMessageTs;
      }

      const prependSystem: string[] = [];
      const judgeSucceeded = Boolean(effectiveDecision._judge_succeeded);
      const decisionDelegationEnabled = Boolean(effectiveDecision._delegation_enabled ?? true);

      if (routeHintRequired(effectiveDecision)) {
        prependSystem.push(OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT);
      }

      if (decisionDelegationEnabled && !judgeSucceeded) {
        prependSystem.push([
          "OctoClaw delegation is available for this run.",
          "You can decide whether to handle this request directly or delegate to a sub-agent via octoclaw_dispatch.",
          "Use octoclaw_route_hint to indicate your routing preference (reply or delegate). Read-only observation is delegate with observer role.",
        ].join("\n"));
      }

      if (isDelegatedRoute(effectiveDecision)) {
        prependSystem.push(OCTOCLAW_DELEGATION_SYSTEM_CONTEXT);
      }
      const route = stringValue(asRecord(effectiveDecision.route_decision).route);
      const isSpawnRoute = route === "delegate";
      const reviewRequired = Boolean(asRecord(effectiveDecision.review_policy).required);
      if (isSpawnRoute && reviewRequired) {
        prependSystem.push(OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT);
      }
      const lookupGuard = buildDirectLookupGuard(effectiveDecision);
      if (lookupGuard) {
        prependSystem.push(lookupGuard);
      }
      if (asRecord(effectiveDecision.state_grounding).required) {
        const executionFacts = buildRecentExecutionFacts(collectRecentExecutionReceipts(stateKey));
        const grounding = buildConversationGrounding({
          prompt,
          replayLogPath: resolveReplayLogPath(),
          taskStatePath: resolveTaskStatePath(),
          sessionKeys: [
            stateKey,
            stringValue((metadata as { session_key?: unknown }).session_key),
            stringValue(effectiveState?.canonicalSessionKey),
            stringValue(ctx.sessionKey),
          ].filter(Boolean),
          recentExecutionFacts: executionFacts,
        });
        if (grounding?.context) {
          prependSystem.push(grounding.context);
        }
      }
      const resolvedStateBoundaryStatus = stringValue(
        asRecord((resolved?.state as UnknownRecord | undefined)?.sessionBoundary).status,
      );
      if (stringValue(effectiveState?.sessionBoundary?.status || resolvedStateBoundaryStatus || detectSessionBoundary(ctx).status) === "contaminated_subagent_identity") {
        prependSystem.push([
          "[OctoClaw session boundary guard]",
          "Prior subagent context in this session is stale. Only use authoritative execution facts from the current turn or fresh workflow outputs.",
          "Do not claim a task was dispatched unless octoclaw_dispatch actually ran and returned a materialized result.",
        ].join("\n"));
      }
      const anomalyNotice = asRecord(effectiveState?.latestAnomalyNotice);
      if (stringValue(anomalyNotice.kind)) {
        prependSystem.push([
          "[OctoClaw execution anomaly notice]",
          `kind=${stringValue(anomalyNotice.kind)}, severity=${stringValue(anomalyNotice.severity || "warning")}`,
          stringValue(anomalyNotice.message),
          `task=${stringValue(anomalyNotice.taskId || anomalyNotice.nativeTaskId || "unknown")}, flow=${stringValue(anomalyNotice.nativeFlowId || "unknown")}`,
          "Do not claim the delegated sub-agent is running unless spawnExecuted=true or child session/run evidence exists.",
        ].filter(Boolean).join("\n"));
      }
      if (recoveryCheck.timedOutCount > 0) {
        const timedOutLines = recoveryCheck.recoveries
          .filter((entry) => asRecord(entry).timedOut === true)
          .map((entry) => {
            const item = asRecord(entry);
            return `- ${stringValue(item.delegateTaskId || item.taskId || item.flowId)}: ${stringValue(item.reason || item.trigger || "timed_out")}`;
          });
        prependSystem.push([
          "[OctoClaw recovery notice]",
          "One or more delegated tasks timed out during this event check.",
          "Treat those delegated runs as timed out/requiring recovery and avoid claiming they are still healthy.",
          timedOutLines.length > 0 ? `Timed out tasks:\n${timedOutLines.join("\n")}` : "",
        ].filter(Boolean).join("\n"));
      }
      prependSystem.push(OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT);
      const contextPayload = compactPolicyPrompt(effectiveDecision);
      const promptKey = prompt || "";
      const hasDedupKey = Boolean(stateKey);
      const shouldInjectPrependContext = !hasDedupKey || lastGroundedPromptByStateKey.get(stateKey) !== promptKey;
      if (hasDedupKey && shouldInjectPrependContext) {
        lastGroundedPromptByStateKey.set(stateKey, promptKey);
      }
      return buildPromptContextProjection({
        prependSystem,
        contextPayload,
        shouldInjectPolicyProjection: shouldInjectPrependContext,
      });
    });

    registerLifecycleHook("before_tool_call", async (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const { key: stateKey, state } = getPolicyStateForContext(ctx);
      const decision = asRecord(state?.decision);
      const hookConfig = asRecord(asRecord(decision.hook_interface).before_tool_call);
      if (!hookConfig.enabled) return;

      const toolName = stringValue(event.toolName || ctx.toolName);
      const routeHintTool = stringValue(hookConfig.route_hint_tool || "octoclaw_route_hint");
      const routeHintIsRequired = routeHintRequired(decision) || Boolean(hookConfig.route_hint_required);
      const delegationEnforcementEnabled = Boolean(hookConfig.delegate_required || hookConfig.delegation_enforcement);
      const routeHintAlreadySubmitted = Boolean(state?.routeHintSubmitted);
      const allowedPreHintTools = preHintAllowedTools(decision, routeHintTool);
      const allowedObserverTools = observerControlTools(decision, routeHintTool);
      const allowedSessionTools = sessionControlTools(decision, routeHintTool);
      const metadata = buildPolicyMetadata(ctx, { stateKey });
      const storedInboundTs = stringValue(state?.inboundMessageTs);
      if (storedInboundTs && !stringValue(metadata.message_id)) {
        metadata.message_id = storedInboundTs;
      }

      if (
        stringValue(asRecord(decision.route_decision).route) === "reply"
        && !isControlObserverDecision(decision)
        && !isSessionControlDecision(decision)
        && toolName
        && !toolName.startsWith("octoclaw_")
      ) {
        updateAckTrackingState(stateKey, { tool_active: true });
        const latencyAck = await maybeSendLatencyAck(decision, metadata, stateKey, state ?? {}, ctx, pi.logger ?? {}, toolName);
        updatePolicyState(stateKey, (current) => ({
          ...current,
          directToolsSeen: Array.from(new Set([...(Array.isArray(current?.directToolsSeen) ? current.directToolsSeen : []), toolName])),
        }));
        await recordAckReplay({
          decision,
          stateKey,
          ctx,
          logger: pi.logger,
          kind: "latency",
          phase: "direct_tool",
          result: latencyAck,
          toolName,
        });
        await recordPolicyReplay(
          "direct_tool_called",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            taskClass: stringValue(asRecord(decision.route_decision).task_class),
            protectedLane: stringValue(asRecord(decision.route_decision).protected_lane),
            toolName,
            latencyAckRequired: Boolean(asRecord(decision.latency_ack).required),
            latencyAckSent: Boolean(latencyAck?.sent),
            latencyAckReason: stringValue(latencyAck?.reason),
          },
          pi.logger,
          decision,
        );
        await recordPolicyReplay(
          "tool_used",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            taskClass: stringValue(asRecord(decision.route_decision).task_class),
            protectedLane: stringValue(asRecord(decision.route_decision).protected_lane),
            toolName,
            latencyAckRequired: Boolean(asRecord(decision.latency_ack).required),
            latencyAckSent: Boolean(latencyAck?.sent),
            latencyAckReason: stringValue(latencyAck?.reason),
          },
          pi.logger,
          decision,
        );
      }

      if (isControlObserverDecision(decision)) {
        if (allowedObserverTools.has(toolName)) {
          return;
        }
        updatePolicyState(stateKey, (current) => ({
          ...current,
          blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
        }));
        await recordPolicyReplay(
          "tool_blocked_control_observer",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            allowedTools: [...allowedObserverTools],
          },
          pi.logger,
          decision,
        );
        return {
          block: true,
          blockReason: `OctoClaw control/observer request must use control tools only: ${[...allowedObserverTools].join(", ")}.`,
        };
      }

      if (isSessionControlDecision(decision)) {
        if (allowedSessionTools.has(toolName)) {
          return;
        }
        updatePolicyState(stateKey, (current) => ({
          ...current,
          blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
        }));
        await recordPolicyReplay(
          "tool_blocked_session_control",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            allowedTools: [...allowedSessionTools],
          },
          pi.logger,
          decision,
        );
        return {
          block: true,
          blockReason: `OctoClaw current-session control request must use session control tools only: ${[...allowedSessionTools].join(", ")}.`,
        };
      }

      if (routeHintIsRequired && !routeHintAlreadySubmitted && !allowedPreHintTools.has(toolName)) {
        updatePolicyState(stateKey, (current) => ({
          ...current,
          blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
        }));
        await recordPolicyReplay(
          "tool_blocked_before_route_hint",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
            requiredTool: routeHintTool,
          },
          pi.logger,
          decision,
        );
        return {
          block: true,
          blockReason: `OctoClaw runtime policy requires ${routeHintTool} before using other tools.`,
        };
      }

      const toolPolicy = asRecord(decision.tool_policy);
      const workContractProjection = asRecord(decision.work_contract);
      const forbiddenContractTools = new Set(stringArray(workContractProjection.forbiddenTools || workContractProjection.forbidden_tools));
      const routeDecision = asRecord(decision.route_decision);
      const isDeterministicFallbackToDelegate = stringValue(routeDecision.route) === "delegate"
        && (stringValue(routeDecision.route_source) === "fallback" || stringValue(routeDecision.fallback_reason).includes("explicit_delegate"));
      if (forbiddenContractTools.has(toolName) && !isDeterministicFallbackToDelegate) {
        await recordPolicyReplay(
          "tool_blocked_work_contract_forbidden",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(workContractProjection.route || asRecord(decision.route_decision).route),
            toolName,
            workContractId: stringValue(workContractProjection.workContractId || workContractProjection.work_contract_id),
          },
          pi.logger,
          decision,
        );
        return {
          block: true,
          blockReason: `OctoClaw WorkContract forbids ${toolName} for this turn.`,
        };
      }
      const blockedPatterns = Array.isArray(toolPolicy.block_tool_patterns)
        ? toolPolicy.block_tool_patterns.map((item) => stringValue(item)).filter(Boolean)
        : [];
      if (matchesBlockedPattern(stringifyParamsForPolicy(event.params), blockedPatterns)) {
        await recordPolicyReplay(
          "tool_blocked_manual_delegation",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
          },
          pi.logger,
          decision,
        );
        return {
          block: true,
          blockReason: `OctoClaw runtime policy blocked a manual delegation pattern. Use ${stringValue(toolPolicy.must_delegate_via || "octoclaw_dispatch")} instead.`,
        };
      }

      if (!delegationEnforcementEnabled) {
        return;
      }

      const workflowRule = workflowEnforcementRule(decision, toolName, routeHintTool);
      if (!workflowRule.block && workflowRule.delegateTool && toolName === workflowRule.delegateTool) {
        updatePolicyState(stateKey, (current) => ({
          ...current,
          delegated: true,
          delegationTool: toolName,
        }));
        updateAckTrackingState(stateKey, { delegated_running: true, tool_active: false });
        return;
      }
      if (!workflowRule.block) {
        return;
      }

      updatePolicyState(stateKey, (current) => ({
        ...current,
        blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
      }));
      const workflowRoute = stringValue(workflowRule.route || asRecord(decision.route_decision).route);
      const observerOnly = Boolean(asRecord(asRecord(decision.hook_interface).before_tool_call).observe_only);
      await recordPolicyReplay(
        observerOnly ? "tool_blocked_runner_policy" : "tool_blocked_delegation_policy",
        {
          sessionKey: stateKey || "",
          sessionId: stringValue(ctx.sessionId),
          route: workflowRoute,
          toolName,
          allowedTools: workflowRule.allowedTools,
        },
        pi.logger,
        state?.decision as Record<string, unknown> | null,
      );
      return {
        block: true,
          blockReason: observerOnly
            ? `OctoClaw runtime policy route=delegate with role=observer_probe requires the observe workflow. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed workflow tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`
            : `OctoClaw runtime policy route=${stringValue(asRecord(decision.route_decision).route || "reply")} requires delegation. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed control tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`,
      };
    });

    registerLifecycleHook("agent_end", async (_event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const { key: stateKey, state } = getPolicyStateForContext(ctx);
      if (!stateKey) return;
      lastGroundedPromptByStateKey.delete(stateKey);
      const pendingTimer = pendingLatencyAckTimers.get(stateKey);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingLatencyAckTimers.delete(stateKey);
      }
      cancelAckGuardForState(stateKey);
      updateAckTrackingState(stateKey, {
        tool_active: false,
        final_response_streaming: false,
      });
      await recordPolicyReplay(
        "agent_end",
        {
          sessionKey: stateKey,
          sessionId: stringValue(ctx.sessionId),
          route: stringValue(asRecord(state?.decision).route_decision && asRecord(asRecord(state?.decision).route_decision).route),
          systemPreferredRoute: stringValue(asRecord(asRecord(state?.decision).route_decision).system_preferred_route),
          workerPool: stringValue(asRecord(asRecord(state?.decision).route_decision).worker_pool),
          taskClass: stringValue(asRecord(asRecord(state?.decision).route_decision).task_class),
          protectedLane: stringValue(asRecord(asRecord(state?.decision).route_decision).protected_lane),
          routeHintRequired: Boolean(asRecord(asRecord(state?.decision).route_hint_policy).required),
          routeHintSubmitted: Boolean(state?.routeHintSubmitted),
          delegated: Boolean(state?.delegated),
          delegationTool: stringValue(state?.delegationTool),
          directToolsSeen: Array.isArray(state?.directToolsSeen) ? state.directToolsSeen : [],
          blockedTools: Array.isArray(state?.blockedTools) ? state.blockedTools : [],
          ackFollowupCandidate: Boolean(asRecord(asRecord(state?.decision).route_hint_policy).ack_followup_candidate),
          ackFollowupApplied: Boolean(asRecord(asRecord(state?.decision).route_hint_policy).ack_followup_applied),
          latencyAckRequired: Boolean(asRecord(asRecord(state?.decision).latency_ack).required),
          latencyAckSent: Boolean(state?.latencyAckSent),
          routeLanguagePacks: Array.isArray(asRecord(state?.decision).route_language_packs)
            ? asRecord(state?.decision).route_language_packs
            : [],
        },
        pi.logger,
        state?.decision as Record<string, unknown> | null,
      );
      if (stringValue(state?.pendingDeliveryId) && !state?.deliveryObserved) {
        await recordDeliveryRelayEvent(
          "delivery_agent_end_pending",
          {
            deliveryId: stringValue(state?.pendingDeliveryId),
            sessionKey: stateKey,
            route: stringValue(asRecord(asRecord(state?.decision).route_decision).route),
            taskId: stringValue(state?.pendingDeliveryTaskId),
            runnerJobId: stringValue(state?.pendingDeliveryRunnerJobId),
            state: "pending_at_agent_end",
          },
          pi.logger,
        );
      }
      if (shouldRetainPolicyStateOnAgentEnd(asRecord(state))) {
        const formalReplyVisible = Boolean(state?.formal_reply_visible);
        let noticeDeliveryState = "not_attempted";
        const deliverySessionKey = stringValue(state?.ackGuardKey || state?.ack_guard_key || ctx.sessionKey || stateKey);
        updateAckTrackingState(stateKey, { delegate_without_dispatch: true });
        updatePolicyState(stateKey, (current) => ({
          ...(current ?? {}),
          delegate_without_dispatch: true,
          dispatchExecuted: false,
          spawnExecuted: false,
        }));
        if (!formalReplyVisible) {
          try {
            const noticeResult = await sendDelegateWithoutDispatchNotice({
              sessionKey: deliverySessionKey,
              stateKey,
              decision: asRecord(state?.decision),
              state: asRecord(state),
              replyToMessageId: stringValue(ctx.inboundMessageTs || state?.inboundMessageTs),
              cwd: resolveWorkspaceRoot(),
              logger: pi.logger,
            });
            noticeDeliveryState = noticeResult.sent ? "sent" : (noticeResult.skipped ? "skipped" : "failed");
          } catch (err) {
            pi.logger?.warn?.(`delegate_without_dispatch notice failed: ${String(err)}`);
            noticeDeliveryState = "error";
          }
        } else {
          noticeDeliveryState = "suppressed_reply_visible";
        }

        const workContract = asRecord(asRecord(state?.decision).work_contract);
        const routeSeal = asRecord(asRecord(state?.decision).routeSeal);
        await recordPolicyReplay(
          "delegate_without_dispatch",
          {
            sessionKey: stateKey,
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(state?.decision).route_decision && asRecord(asRecord(state?.decision).route_decision).route),
            systemPreferredRoute: stringValue(asRecord(asRecord(state?.decision).route_decision).system_preferred_route),
            workerPool: stringValue(asRecord(asRecord(state?.decision).route_decision).worker_pool),
            taskClass: stringValue(asRecord(asRecord(state?.decision).route_decision).task_class),
            delegated: false,
            delegationTool: "",
            dispatchExecuted: false,
            spawnExecuted: false,
            delegate_without_dispatch: true,
            notificationDeliveryState: noticeDeliveryState,
            routeCommitId: stringValue(workContract.workContractId),
            routeSealId: stringValue(routeSeal.routeSealId || routeSeal.requestId),
          },
          pi.logger,
          state?.decision as Record<string, unknown> | null,
        );
        return;
      }
      clearPolicyStateForContext(ctx);
    }, 50);

    registerLifecycleHook("before_message_write", (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const { key: stateKey, state } = getPolicyStateForContext({
        sessionKey: stringValue(ctx.sessionKey),
        agentId: stringValue(ctx.agentId),
      });
      if (!state) return;
      updateAckTrackingState(stateKey, { final_response_streaming: true, tool_active: false });
      const guarded = guardAssistantMessageForPolicyState(asRecord(event.message), asRecord(state));
      const visibleMessage = guarded.mode === "replace" && guarded.message ? guarded.message : asRecord(event.message);
      const role = String(asRecord(event.message).role ?? "").trim();
      const contentText: string = typeof asRecord(visibleMessage).content === "string"
        ? String(asRecord(visibleMessage).content)
        : Array.isArray(asRecord(visibleMessage).content)
          ? (asRecord(visibleMessage).content as unknown[]).map((c) => String(asRecord(c).text ?? "")).join("")
          : String(asRecord(visibleMessage).content ?? "");
      const isLikelyAck = contentText.length < 30 && (
        contentText.includes("收到") || contentText.includes("正在") || contentText.includes("处理中")
        || contentText.includes("working") || contentText.includes("checking") || contentText.includes("looking")
      );
      if (role === "assistant" && contentText && !isLikelyAck) {
        updateAckTrackingState(stateKey, { formal_reply_visible: true });
        updatePolicyState(stateKey, (current) => ({ ...(current ?? {}), formal_reply_visible: true }));
      }
      void recordObservedDeliveryFromMessage(visibleMessage, asRecord(state), stateKey, pi.logger).catch((err) => {
        pi.logger?.warn?.(`octoclaw delivery observe failed: ${String(err)}`);
      });
      if (guarded.mode === "replace" && guarded.message) {
        return { message: guarded.message };
      }
    }, 120);

    if (watchdogInterval) {
      clearInterval(watchdogInterval);
    }
    watchdogInterval = setInterval(() => {
      void watchdogTick(pi.logger).catch(() => undefined);
    }, WATCHDOG_INTERVAL_MS);

    if (taskStateRetentionInterval) {
      clearInterval(taskStateRetentionInterval);
    }
    runTaskStateRetention(pi.logger);
    taskStateRetentionInterval = setInterval(() => {
      runTaskStateRetention(pi.logger);
    }, DEFAULT_TASK_STATE_RETENTION_MIN_RUN_INTERVAL_MS);

    if (typeof pi.registerTool === "function") {
      for (const tool of getToolRegistrations()) {
        pi.registerTool(toOpenClawToolDefinition(tool as unknown as Record<string, unknown>));
      }
    }

    if (typeof pi.registerCommand === "function") {
      for (const command of getCommandRegistrations()) {
        pi.registerCommand(toOpenClawCommandDefinition(command as unknown as Record<string, unknown>));
      }
    }
  },
};

export default plugin;
