import {
  getAckTrackingState,
  sendNeutralInboundAck,
  type NeutralInboundAckResult,
  watchdogStartupReconcile,
  watchdogTick,
  WATCHDOG_INTERVAL_MS,
} from "./ack/ack-guard.js";
import { prepareAckTrackingForMessageTurn } from "./ack/ack-state.js";
import {
  pendingNeutralInboundAckTimers,
  pendingNeutralInboundAckTextFallbackTimers,
  configuredNeutralAckDelayMs,
  configuredNeutralAckTextFallbackDelayMs,
  neutralAckTimerKey,
  neutralAckTextFallbackTimerKey,
  type CanceledNeutralAckTimer,
} from "./ack/ack-scheduler.js";
import { sendIMMessage } from "./im/send.js";
import { fetchLatestUserMessageTsForSessionKey } from "./im/slack-thread-anchor.js";
import {
  buildPolicyMetadata,
  resolveAckDeliverySessionKey,
  resolvePolicyStateKey,
  resolvePolicyStateKeys,
} from "./resolve/session.js";
import { envOverrides, resolveWorkspaceRoot } from "./resolve/env.js";
import {
  DEFAULT_TASK_STATE_RETENTION_MIN_RUN_INTERVAL_MS,
  pruneTaskStateCache,
} from "./state/task-state-retention.js";
import { initNativeHelperBridge } from "./adapter/native-helper.js";
import { buildTurnExecutionReceipt, type TurnExecutionReceipt } from "./receipt.js";
import { recordPolicyReplay } from "./replay/replay.js";
import { policyState, type PolicyStateEntry } from "./state/policy-state.js";
import { getCommandRegistrations, getToolRegistrations } from "./tools/registration.js";
import { buildNativeStatusOutput, buildNativeTaskActionPayload } from "./tools/runtime-status.js";
import { type UnknownRecord, asRecord } from "./util/type-coercion.js";
import type { HookHandler, LoggerLike, PluginInterface } from "./extension-entry-shared.js";
import { stringValue } from "./extension-entry-shared.js";
export type { HookHandler, LoggerLike, PluginInterface } from "./extension-entry-shared.js";
export { buildPromptContextProjection, extractMessageText, extractPromptText, queryDelegateStatus, resolveDelegationCapability, resolveReactionAckConfig } from "./extension-entry-helpers.js";
export { NATIVE_ANNOUNCE_BLOCKED_TOOLS, contractNativeIds, deliverNativeAnnounceCompletion, handleNativeAnnounceCompletion, handleNativeSubagentEndedCompletion, isNativeAnnounceAlreadyDelivered, isNativeAnnounceBlockedState, isNativeAnnounceDeliveryState, markNativeAnnounceCompletionOnContract, nativeAnnounceSendOverride, shouldCancelNativeAnnounceDeliveredOutbound, slackThreadFromSessionKey } from "./resolve/native-announce.js";
export type { NativeAnnounceBlocker, NativeAnnounceCompletion, NativeAnnounceSendMessage } from "./resolve/native-announce.js";
export { findRecentOutboundPolicyState, hydrateOutboundStateWithNativeRefs, outboundDeliveryContent, outboundGuardReplacement, outboundLooksLikeVisibleDeliveryHook, outboundTargetLooksLikeSlack, resolveOutboundPolicyTarget } from "./resolve/outbound-guards.js";
export { replyDispatchSourceContext, wrapReplyDispatchFooterProjection } from "./resolve/outbound-reply-dispatch.js";
export { budgetedMainSpawnIntentId, budgetedMainVisibleStartAt, budgetedMainWorkContractId, clearBudgetedMainTimer, completeBudgetedMainIfActive, escalateBudgetedMainForTool, maybeStartBudgetedMain, promoteBudgetedMainDispatch, recordBudgetedMainEvent, scheduleBudgetedMainTimeout, updateBudgetedMainForContext } from "./budgeted-main.js";
import { extractPromptText, resolveDelegationCapability, resolveReactionAckConfig } from "./extension-entry-helpers.js";
export { extractInboundMessageTimestamp, extractInboundMessageTimestampWithSource, resolveSlackMessageReceivedSessionKey } from "./inbound-timestamps.js";
export type { InboundMessageTimestampSource } from "./inbound-timestamps.js";
import { extractInboundMessageTimestamp, extractInboundMessageTimestampWithSource, type InboundMessageTimestampSource } from "./inbound-timestamps.js";
import { detectIMType } from "./im-status-renderer.js";
import { makeBeforePromptBuildHook } from "./hooks/before-prompt-build.js";
import { makeBeforeToolCallHook } from "./hooks/before-tool-call.js";
import { makeBeforeModelResolveHook } from "./hooks/before-model-resolve.js";
import { makeAfterToolCallHook } from "./hooks/after-tool-call.js";
import { makeAgentEndHook, makeSubagentEndedHook } from "./hooks/agent-end.js";
import {
  makeMessageSendingHook,
  makeReplyDispatchHook,
  makeMessageReceivedHook,
  makeBeforeCompactionHook,
  makeBeforeMessageWriteHook,
} from "./hooks/message-lifecycle.js";
import { makeBeforeDispatchHook } from "./hooks/before-dispatch.js";
import { deliveryTargetReplyTo } from "./hooks/footer-mode.js";
import { handleRouterWizardAction } from "./router-onboarding.js";
import { recoverNativeRunsOnGatewayStart } from "./resolve/native-run-startup-recovery.js";
export {
  isAcceptedSpeculativeSpawnResult,
  maybeInjectSpeculativePreload,
  speculativeSpawnResultError,
} from "./hooks/speculative-preload-handler.js";


const ROUTER_WIZARD_SLACK_INTERACTIVE_ACTION_IDS = [
  "octoclaw_router_wizard_start_questions",
  "octoclaw_router_wizard_use_defaults",
  "octoclaw_router_wizard_remind_later",
  "octoclaw_router_wizard_skip",
  "octoclaw_router_wizard_model_scan_continue",
  "octoclaw_router_wizard_plan_confirm",
  "octoclaw_router_wizard_plan_all_subscription",
  "octoclaw_router_wizard_plan_all_pay_as_you_go",
  "octoclaw_router_wizard_plan_subscription",
  "octoclaw_router_wizard_plan_pay_as_you_go",
  "octoclaw_router_wizard_plan_unknown",
  "octoclaw_router_wizard_privacy_standard",
  "octoclaw_router_wizard_privacy_local_only",
  "octoclaw_router_wizard_privacy_custom",
  "octoclaw_router_wizard_budget_none",
  "octoclaw_router_wizard_budget_50",
  "octoclaw_router_wizard_budget_100",
  "octoclaw_router_wizard_budget_200",
  "octoclaw_router_wizard_budget_custom",
  "octoclaw_router_wizard_restricted_none",
  "octoclaw_router_wizard_restricted_text",
  "octoclaw_router_wizard_restricted_ban",
  "octoclaw_router_wizard_restricted_allow",
  "octoclaw_router_wizard_language_auto",
  "octoclaw_router_wizard_language_zh",
  "octoclaw_router_wizard_language_en",
  "octoclaw_router_wizard_same_provider_import",
  "octoclaw_router_wizard_same_provider_skip",
  "octoclaw_router_wizard_same_provider_add",
  "octoclaw_router_wizard_same_provider_skip_one",
  "octoclaw_router_wizard_same_provider_import_all",
  "octoclaw_router_wizard_confirm",
  "step:1:answer:start",
  "step:1:answer:cli",
  "step:1:answer:cancel",
  "step:2:answer:subscription",
  "step:2:answer:pay_as_you_go",
  "step:2:answer:unknown",
  "step:2:answer:skip",
  "step:3:answer:%3C20",
  "step:3:answer:20-100",
  "step:3:answer:100-500",
  "step:3:answer:500%2B",
  "step:3:answer:unlimited",
  "step:3:answer:skip",
  "step:4:answer:cloud_ok",
  "step:4:answer:local_only",
  "step:4:answer:pick",
  "step:4:answer:skip",
  "step:5:answer:confirm",
  "step:5:answer:skip",
  "step:6:answer:all",
  "step:6:answer:select",
  "step:6:answer:skip",
];

function routerWizardSlackInteractiveNamespace(actionId: string): string {
  const separatorIndex = actionId.indexOf(":");
  return separatorIndex >= 0 ? actionId.slice(0, separatorIndex) : actionId;
}

function resolveRouterWizardSlackActionId(interaction: UnknownRecord, namespace: string): string {
  const explicit = stringValue(interaction.actionId || interaction.action_id);
  if (explicit) return explicit;
  const data = stringValue(interaction.data);
  if (namespace === "step") {
    const stepMatch = data.match(/^step:\d+:answer:[^:]+/u);
    if (stepMatch) return stepMatch[0];
  }
  return namespace;
}

let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let taskStateRetentionInterval: ReturnType<typeof setInterval> | null = null;
const recentCompactionNotices = new Map<string, number>();

export type OctoClawStatusFastPathCommand = {
  format: "anchors" | "compact" | "table" | "lanes" | "raw";
  trigger: string;
};

export type OctoClawTaskActionFastPathCommand = {
  action: "details";
  taskId: string;
  trigger: string;
};

function normalizeStatusFastPathPrompt(prompt: string): string {
  return stringValue(prompt)
    .replace(/^\s*(?:<@[^>]+>\s*)+/u, "")
    .replace(/[？?。！!；;：:，,、\s]+$/u, "")
    .trim();
}

export function parseOctoClawStatusFastPathCommand(prompt: string): OctoClawStatusFastPathCommand | null {
  const normalized = normalizeStatusFastPathPrompt(prompt);
  if (!normalized) return null;
  const match = normalized.match(/^(八爪鱼状态|octoclaw\s+status|状态面板|任务面板|派发状态|\/octostatus)(?:\s+(anchors|compact|table|lanes|raw))?$/iu);
  if (!match) return null;
  return {
    trigger: stringValue(match[1]).toLowerCase().replace(/\s+/gu, " "),
    format: (stringValue(match[2]) || "anchors").toLowerCase() as OctoClawStatusFastPathCommand["format"],
  };
}

export function parseOctoClawTaskActionFastPathCommand(prompt: string): OctoClawTaskActionFastPathCommand | null {
  const normalized = normalizeStatusFastPathPrompt(prompt);
  if (!normalized) return null;
  for (const pattern of [
    /^(查看任务)\s+(?:wc\s*=\s*)?(wc-[a-z0-9][a-z0-9-]*)\s+详情$/iu,
    /^(任务详情)\s+(?:wc\s*=\s*)?(wc-[a-z0-9][a-z0-9-]*)$/iu,
    /^(octoclaw\s+(?:task\s+)?details|\/octotask\s+(?:details|detail|view)|details)\s+(?:wc\s*=\s*)?(wc-[a-z0-9][a-z0-9-]*)$/iu,
  ]) {
    const match = normalized.match(pattern);
    if (!match) continue;
    return {
      action: "details",
      taskId: stringValue(match[2]),
      trigger: stringValue(match[1]).toLowerCase().replace(/\s+/gu, " "),
    };
  }
  return null;
}

export async function handleOctoClawControlPlaneFastPath(input: {
  prompt: string;
  mergedCtx: UnknownRecord;
  eventRecord: UnknownRecord;
  ctxRecord: UnknownRecord;
  stateKey: string;
  logger?: LoggerLike;
}): Promise<{ handled: true; text: string } | null> {
  const statusCommand = parseOctoClawStatusFastPathCommand(input.prompt);
  if (statusCommand) {
    const sessionKey = stringValue(input.mergedCtx.sessionKey || input.eventRecord.sessionKey || input.stateKey);
    const imType = sessionKey ? detectIMType(sessionKey) : "plain";
    const startedAt = Date.now();
    const text = await buildNativeStatusOutput(statusCommand.format, imType, input.mergedCtx);
    void recordPolicyReplay(
      "status_fast_path_handled",
      {
        sessionKey: sessionKey || stringValue(input.ctxRecord.sessionKey),
        sessionId: stringValue(input.mergedCtx.sessionId || input.eventRecord.sessionId),
        stateKey: input.stateKey,
        trigger: statusCommand.trigger,
        format: statusCommand.format,
        imType,
        elapsedMs: Date.now() - startedAt,
        handled: true,
      },
      input.logger,
      null,
    ).catch(() => {});
    return { handled: true, text };
  }

  const taskCommand = parseOctoClawTaskActionFastPathCommand(input.prompt);
  if (!taskCommand) return null;
  const startedAt = Date.now();
  const { summary, payload } = await buildNativeTaskActionPayload(`${taskCommand.action} ${taskCommand.taskId}`, "text");
  void recordPolicyReplay(
    "task_action_fast_path_handled",
    {
      sessionKey: stringValue(input.mergedCtx.sessionKey || input.eventRecord.sessionKey || input.stateKey),
      sessionId: stringValue(input.mergedCtx.sessionId || input.eventRecord.sessionId),
      stateKey: input.stateKey,
      trigger: taskCommand.trigger,
      action: taskCommand.action,
      taskId: taskCommand.taskId,
      resolvedTaskId: stringValue(payload.taskId),
      found: payload.found === true,
      elapsedMs: Date.now() - startedAt,
      handled: true,
    },
    input.logger,
    null,
  ).catch(() => {});
  return { handled: true, text: summary };
}

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

function shouldSendCompactionNotice(sessionKey: string, now = Date.now()): boolean {
  const key = stringValue(sessionKey);
  if (!key || !key.includes(":slack:")) return false;
  const last = recentCompactionNotices.get(key) || 0;
  if (now - last < 5 * 60_000) return false;
  recentCompactionNotices.set(key, now);
  return true;
}

export async function sendCompactionNotice(event: UnknownRecord, ctx: UnknownRecord, logger?: LoggerLike): Promise<void> {
  const sessionKey = stringValue(ctx.sessionKey || event.sessionKey);
  if (!shouldSendCompactionNotice(sessionKey)) return;
  const state = getPolicyStateForContext(ctx).state;
  let replyToMessageId = stringValue(state?.inboundMessageTs || state?.message_id || state?.replyToMessageId || state?.reply_to_id)
    || extractInboundMessageTimestamp(ctx, event, "");
  if (!replyToMessageId && sessionKey.includes(":slack:") && sessionKey.includes(":direct:")) {
    replyToMessageId = await fetchLatestUserMessageTsForSessionKey(sessionKey);
  }
  const result = await sendIMMessage({
    sessionKey,
    message: "上下文压缩中，我会继续处理；不用重复发送。",
    replyToMessageId: replyToMessageId || undefined,
    timeoutMs: 5000,
    cwd: resolveWorkspaceRoot(),
    suppressProjectionFooter: true,
    deliveryKind: "status_reply",
    deliveryTargetSource: replyToMessageId ? "inbound_anchor" : "session_fallback",
    footerMode: "off",
  });
  void recordPolicyReplay(
    "compaction_notice",
    { sessionKey, replyToMessageId, sent: result.sent, error: result.error || "" },
    logger,
    null,
  ).catch(() => {});
}



function resolvePluginConfigObject(config: unknown, pluginId: string): UnknownRecord | undefined {
  const entry = asRecord(asRecord(asRecord(config).plugins).entries)[pluginId];
  const pluginConfig = asRecord(asRecord(entry).config);
  return Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined;
}

function resolveCurrentPluginConfig(pi: PluginInterface, pluginId = "octoclaw-runtime"): UnknownRecord {
  const startupPluginConfig = asRecord(pi.pluginConfig);
  const apiPluginConfig = resolvePluginConfigObject(pi.config, pluginId) ?? {};
  try {
    const runtimeConfig = pi.runtime?.config?.current?.();
    const livePluginConfig = resolvePluginConfigObject(runtimeConfig, pluginId);
    if (livePluginConfig) return { ...startupPluginConfig, ...apiPluginConfig, ...livePluginConfig };
  } catch (error) {
    pi.logger?.debug?.(`octoclaw live plugin config read failed: ${String(error)}`);
  }
  return { ...startupPluginConfig, ...apiPluginConfig };
}
export function buildRecentExecutionFacts(receipts: TurnExecutionReceipt[]): string {
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

export function collectRecentExecutionReceipts(currentSessionKey: string | null = null, limit = 3): TurnExecutionReceipt[] {
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


export function getPolicyStateForContext(ctx: UnknownRecord): { key: string; state: PolicyStateEntry | null } {
  const keys = resolvePolicyStateKeys(ctx);
  for (const key of keys) {
    const state = policyState.get(key);
    if (!state) continue;
    const canonicalKey = stringValue(state.canonicalSessionKey || state.canonical_session_key);
    if (canonicalKey && canonicalKey !== key) {
      const canonicalState = policyState.get(canonicalKey);
      if (canonicalState) {
        return { key: canonicalKey, state: canonicalState };
      }
    }
    return { key, state };
  }
  const resolved = policyState.resolveForContext(ctx);
  return {
    key: stringValue(resolved.key),
    state: resolved.state ?? null,
  };
}

export function updatePolicyState(stateKey: string, mutator: (current: PolicyStateEntry) => PolicyStateEntry): void {
  const key = stringValue(stateKey);
  if (!key) {
    return;
  }
  policyState.update(key, (current) => mutator(current));
}

function policyStateAliasKeys(stateKey: string, ctx: UnknownRecord, state: UnknownRecord): string[] {
  return Array.from(new Set([
    stringValue(stateKey),
    stringValue(state.canonicalSessionKey || state.canonical_session_key),
    stringValue(state.ackGuardKey || state.ack_guard_key),
    stringValue(ctx.sessionKey || ctx.session_key),
    stringValue(ctx.canonicalSessionKey || ctx.canonical_session_key),
    stringValue(ctx.sessionId || ctx.session_id),
  ].filter(Boolean)));
}

export function syncPolicyStateAliases(stateKey: string, ctx: UnknownRecord, state: UnknownRecord): PolicyStateEntry | null {
  const key = stringValue(stateKey);
  if (!key) return null;
  const canonicalSessionKey = stringValue(state.canonicalSessionKey || state.canonical_session_key || key);
  const next = {
    ...state,
    canonicalSessionKey,
    canonical_session_key: canonicalSessionKey,
  } as PolicyStateEntry;
  let selected: PolicyStateEntry | null = null;
  for (const aliasKey of policyStateAliasKeys(key, ctx, next as UnknownRecord)) {
    policyState.set(aliasKey, next);
    if (!selected || aliasKey === key) {
      selected = policyState.get(aliasKey) ?? next;
    }
  }
  return selected;
}

export function stateWorkContractId(state: unknown): string {
  const record = asRecord(state);
  const decision = asRecord(record.decision);
  const workContract = asRecord(decision.work_contract);
  return stringValue(record.workContractId || record.work_contract_id)
    || stringValue(workContract.workContractId || workContract.work_contract_id)
    || stringValue(decision.workContractId || decision.work_contract_id);
}

export function bindRouteHintPromptToCurrentContext(ctx: UnknownRecord, toolParams: UnknownRecord): void {
  const task = stringValue(toolParams.task);
  if (!task) return;
  const keys = resolvePolicyStateKeys(ctx).filter(Boolean);
  if (keys.length === 0) return;
  const now = Date.now();
  for (const key of keys) {
    const existing = policyState.get(key);
    policyState.set(key, {
      ...(existing ?? {}),
      prompt: task,
      canonicalSessionKey: stringValue(existing?.canonicalSessionKey) || key,
      routeHintPending: true,
      route_hint_pending: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as PolicyStateEntry);
  }
}

export function clearPolicyStateForContext(ctx: UnknownRecord): void {
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

function slackWizardSessionKeyFromInteraction(ctx: UnknownRecord): string {
  const interaction = asRecord(ctx.interaction);
  const accountId = stringValue(ctx.accountId) || "default";
  const senderId = stringValue(ctx.senderId).toLowerCase();
  const conversationId = stringValue(ctx.conversationId).toLowerCase();
  const threadId = stringValue(ctx.threadId || interaction.threadTs || interaction.messageTs);
  const scope = conversationId.startsWith("d")
    ? `direct:${senderId}`
    : `channel:${conversationId}`;
  return [
    "agent",
    "main",
    "slack",
    accountId,
    scope,
    threadId ? `thread:${threadId}` : "",
  ].filter(Boolean).join(":");
}

function registerRouterWizardSlackInteractiveHandlers(pi: PluginInterface): void {
  if (typeof pi.registerInteractiveHandler !== "function") return;
  const registeredNamespaces = new Set<string>();
  for (const actionId of ROUTER_WIZARD_SLACK_INTERACTIVE_ACTION_IDS) {
    const namespace = routerWizardSlackInteractiveNamespace(actionId);
    if (!namespace || registeredNamespaces.has(namespace)) continue;
    registeredNamespaces.add(namespace);
    pi.registerInteractiveHandler({
      channel: "slack",
      namespace,
      handler: async (ctx: UnknownRecord) => {
        const interaction = asRecord(ctx.interaction);
        const sessionKey = slackWizardSessionKeyFromInteraction(ctx);
        const replyToMessageId = stringValue(ctx.threadId || interaction.threadTs || interaction.messageTs);
        const value = stringValue(interaction.value || asRecord(interaction).payload);
        const resolvedActionId = resolveRouterWizardSlackActionId(interaction, namespace);
        const result = await handleRouterWizardAction({
          event: {
            actions: [{ action_id: resolvedActionId, value }],
            interaction,
          },
          sessionKey,
          replyToMessageId: replyToMessageId || undefined,
          cwd: resolveWorkspaceRoot(),
        });
        if (!result.handled) return { handled: false };
        return { handled: true };
      },
    });
  }
}

export const plugin = {
  id: "octoclaw-runtime",
  name: "OctoClaw Runtime",
  description: "Runtime policy hooks, dispatch tools, and replay logging for OctoClaw",
  register(pi: PluginInterface): void {
    if (pi.pluginConfig?.enabled === false) return void pi.logger?.info?.("octoclaw-runtime: disabled via config (enabled=false), skipping hook registration");
    const currentPluginConfig = (): UnknownRecord => resolveCurrentPluginConfig(pi);

    envOverrides.octoclawRoot = stringValue(pi.pluginConfig?.octoclawRoot);
    envOverrides.workspaceRoot = stringValue(pi.pluginConfig?.workspaceRoot);

    const judgeFastFromPlugin = (pi.pluginConfig?.judgeFast && typeof pi.pluginConfig.judgeFast === "object" && !Array.isArray(pi.pluginConfig.judgeFast)) ? pi.pluginConfig.judgeFast as Record<string, unknown> : {};
    const judgeFastFromEnv = (() => {
      const json = process.env.OCTOCLAW_JUDGE_FAST?.trim();
      if (!json) return {};
      try { const p = JSON.parse(json); return (typeof p === "object" && p && !Array.isArray(p)) ? p as Record<string, unknown> : {}; } catch { return {}; }
    })();
    const judgeFastRaw = (Object.keys(judgeFastFromPlugin).length > 0) ? judgeFastFromPlugin : judgeFastFromEnv;
    const { reactionEmoji, reactionAckEnabled } = resolveReactionAckConfig(asRecord(pi.pluginConfig), judgeFastRaw);
    const buildReactionAckState = (sessionKey = ""): Partial<PolicyStateEntry> => ({
      reactionAckEnabled,
      reactionAckSupported: reactionAckEnabled && stringValue(sessionKey).toLowerCase().includes(":slack:"),
      reactionAckEmoji: reactionEmoji,
      reaction_ack_emoji: reactionEmoji,
      neutralAckPreferText: false,
      neutral_ack_prefer_text: false,
    });
    const applyReactionAckState = (state: PolicyStateEntry | null | undefined, sessionKey = ""): void => {
      if (!state) return;
      Object.assign(state, buildReactionAckState(sessionKey));
    };
    const shouldScheduleNeutralTextFallback = (result: NeutralInboundAckResult, state: UnknownRecord): boolean => {
      if (result.sent) return false;
      if (!Boolean(state.reactionAckEnabled) || !Boolean(state.reactionAckSupported)) return false;
      const reason = stringValue(result.reason);
      return reason.startsWith("reaction_ack_") || reason.startsWith("reaction_");
    };
    const neutralAckSuppressedReason = (stateKey: string, state: UnknownRecord): string => {
      const tracking = getAckTrackingState(stateKey);
      const live = asRecord(policyState.get(stateKey) ?? {});
      const merged = { ...state, ...live, ...tracking };
      if (Boolean(merged.reactionAckSent) || Boolean(merged.reaction_ack_sent)) return "reaction_ack_already_sent";
      if (Boolean(merged.textAck0Sent) || Boolean(merged.latencyAckSent)) return "text_ack_already_sent";
      if (Boolean(merged.formalReplyVisible) || Boolean(merged.formal_reply_visible)) return "formal_reply_visible";
      if (Boolean(merged.finalResponseStreaming) || Boolean(merged.final_response_streaming)) return "reply_streaming";
      if (Boolean(merged.delivered) || stringValue(merged.deliveryStatus || merged.delivery_status) === "delivered") return "reply_delivered";
      if (Boolean(merged.firstTokenSeen) || Boolean(merged.first_token_seen) || Boolean(merged.mainModelFirstTokenSeen) || Boolean(merged.mainModelStartedOutput)) {
        return "main_model_output_started";
      }
      return "";
    };
    const scheduleNeutralTextFallback = (
      hookName: string,
      sessionKey: string,
      effectiveStateKey: string,
      replyToMessageId: string,
      effectiveState: UnknownRecord,
      mergedCtx: UnknownRecord,
      anchorSource: InboundMessageTimestampSource,
      fallbackUsed: boolean,
      initialReason: string,
      initialError = "",
    ): void => {
      const textFallbackKey = neutralAckTextFallbackTimerKey(sessionKey, replyToMessageId);
      if (pendingNeutralInboundAckTextFallbackTimers.has(textFallbackKey)) return;
      const fallbackTimer = setTimeout(async () => {
        pendingNeutralInboundAckTextFallbackTimers.delete(textFallbackKey);
        const suppressedReason = neutralAckSuppressedReason(effectiveStateKey, effectiveState);
        if (suppressedReason) {
          void recordPolicyReplay(
            "neutral_inbound_ack",
            {
              hookName,
              sessionKey,
              stateKey: effectiveStateKey,
              replyToMessageId,
              anchor_source: anchorSource,
              fallback_used: fallbackUsed,
              sent: false,
              mode: "not_sent",
              reason: suppressedReason,
              initial_reason: initialReason,
              initial_error: initialError,
              fallback_stage: "text_after_reaction_failed",
            },
            pi.logger,
            null,
          ).catch(() => {});
          return;
        }
        const result = await sendNeutralInboundAck({
          sessionKey,
          stateKey: effectiveStateKey,
          replyToMessageId,
          cwd: stringValue(mergedCtx.cwd) || process.cwd(),
          state: {
            ...effectiveState,
            neutralAckPreferText: true,
            neutral_ack_prefer_text: true,
          },
          ctx: mergedCtx,
          logger: pi.logger,
          timeoutMs: 5000,
        });
        void recordPolicyReplay(
          "neutral_inbound_ack",
          {
            hookName,
            sessionKey,
            stateKey: effectiveStateKey,
            replyToMessageId,
            anchor_source: anchorSource,
            fallback_used: fallbackUsed,
            sent: result.sent,
            mode: result.mode,
            reason: result.reason,
            error: result.error || "",
            initial_reason: initialReason,
            initial_error: initialError,
            fallback_stage: "text_after_reaction_failed",
          },
          pi.logger,
          null,
        ).catch(() => {});
      }, configuredNeutralAckTextFallbackDelayMs());
      (fallbackTimer as unknown as { unref?: () => void }).unref?.();
      pendingNeutralInboundAckTextFallbackTimers.set(textFallbackKey, fallbackTimer);
    };
    const recordNeutralAckCancellations = (
      hookName: string,
      cancellations: CanceledNeutralAckTimer[],
      reason: string,
      stateKey: string,
    ): void => {
      for (const cancellation of cancellations) {
        void recordPolicyReplay(
          "neutral_inbound_ack",
          {
            hookName,
            sessionKey: cancellation.sessionKey,
            stateKey,
            replyToMessageId: cancellation.replyToMessageId,
            sent: false,
            mode: "not_sent",
            reason,
            ...(cancellation.fallbackStage ? { fallback_stage: cancellation.fallbackStage } : {}),
          },
          pi.logger,
          null,
        ).catch(() => {});
      }
    };
    const maybeSendNeutralInboundAckForContext = async (
      hookName: string,
      event: UnknownRecord,
      ctx: UnknownRecord,
      prompt = "",
      overrides: { stateKey?: string; sessionKey?: string; inboundMessageTs?: string; inboundMessageTsSource?: InboundMessageTimestampSource } = {},
    ): Promise<void> => {
      const eventRecord = asRecord(event);
      const ctxRecord = asRecord(ctx);
      const mergedCtx = { ...eventRecord, ...ctxRecord };
      const stateKey = stringValue(overrides.stateKey || resolvePolicyStateKey(mergedCtx));
      const existingState = asRecord(getPolicyStateForContext(mergedCtx).state);
      const metadata = buildPolicyMetadata(mergedCtx, { stateKey });
      let sessionKey = stringValue(overrides.sessionKey)
        || resolveAckDeliverySessionKey(metadata, stateKey, existingState, mergedCtx)
        || stringValue(mergedCtx.sessionKey || event.sessionKey);
      if (!/(?:^|:)slack:/u.test(sessionKey.toLowerCase())) {
        return;
      }
      const extractedAnchor = stringValue(overrides.inboundMessageTs)
        ? { ts: stringValue(overrides.inboundMessageTs), source: overrides.inboundMessageTsSource || ("ctx" as const) }
        : extractInboundMessageTimestampWithSource(ctxRecord, eventRecord, [prompt, extractPromptText(eventRecord)].filter(Boolean).join("\n"));
      let inboundMessageTs = extractedAnchor.ts;
      let anchorSource: InboundMessageTimestampSource = extractedAnchor.source;
      let fallbackUsed = false;
      if (hookName === "message_received" && !inboundMessageTs) {
        return;
      }
      if (!inboundMessageTs) {
        const stateAnchor = deliveryTargetReplyTo(existingState)
          || stringValue(existingState.inboundMessageTs || existingState.replyToMessageId || existingState.message_id || existingState.messageId);
        if (stateAnchor) {
          inboundMessageTs = stateAnchor;
          anchorSource = "ctx";
        }
      }
      if (!inboundMessageTs) {
        inboundMessageTs = await fetchLatestUserMessageTsForSessionKey(sessionKey, 1200);
        anchorSource = inboundMessageTs ? "fallback_history" : "none";
        fallbackUsed = Boolean(inboundMessageTs);
      }
      const effectiveStateKey = stateKey || sessionKey;
      prepareAckTrackingForMessageTurn(effectiveStateKey, `${effectiveStateKey}:${inboundMessageTs}`);
      const effectiveState = {
        ...buildReactionAckState(sessionKey),
        ...existingState,
        inboundMessageTs,
        replyToMessageId: inboundMessageTs,
        message_id: inboundMessageTs,
        channelTone: stringValue(existingState.channelTone || existingState.channel_tone) || "chat",
      };
      const timerKey = neutralAckTimerKey(sessionKey, inboundMessageTs);
      if (pendingNeutralInboundAckTimers.has(timerKey)) {
        return;
      }
      const timer = setTimeout(async () => {
        pendingNeutralInboundAckTimers.delete(timerKey);
        const suppressedReason = neutralAckSuppressedReason(effectiveStateKey, effectiveState);
        if (suppressedReason) {
          void recordPolicyReplay(
            "neutral_inbound_ack",
            {
              hookName,
              sessionKey,
              stateKey: effectiveStateKey,
              replyToMessageId: inboundMessageTs,
              anchor_source: anchorSource,
              fallback_used: fallbackUsed,
              sent: false,
              mode: "not_sent",
              reason: suppressedReason,
            },
            pi.logger,
            null,
          ).catch(() => {});
          return;
        }
        const result = await sendNeutralInboundAck({
          sessionKey,
          stateKey: effectiveStateKey,
          replyToMessageId: inboundMessageTs,
          cwd: stringValue(mergedCtx.cwd) || process.cwd(),
          state: effectiveState,
          ctx: mergedCtx,
          logger: pi.logger,
          timeoutMs: 5000,
        });
        void recordPolicyReplay(
          "neutral_inbound_ack",
          {
            hookName,
            sessionKey,
            stateKey: effectiveStateKey,
            replyToMessageId: inboundMessageTs,
            anchor_source: anchorSource,
            fallback_used: fallbackUsed,
            sent: result.sent,
            mode: result.mode,
            reason: result.reason,
            error: result.error || "",
          },
          pi.logger,
          null,
        ).catch(() => {});
        if (shouldScheduleNeutralTextFallback(result, effectiveState)) {
          scheduleNeutralTextFallback(
            hookName,
            sessionKey,
            effectiveStateKey,
            inboundMessageTs,
            effectiveState,
            mergedCtx,
            anchorSource,
            fallbackUsed,
            result.reason,
            result.error || "",
          );
        }
      }, configuredNeutralAckDelayMs(hookName, Boolean(effectiveState.reactionAckEnabled && effectiveState.reactionAckSupported)));
      (timer as unknown as { unref?: () => void }).unref?.();
      pendingNeutralInboundAckTimers.set(timerKey, timer);
    };

    if (process.env.OCTOCLAW_JUDGE_DEBUG) {
      console.log(`[octoclaw-judge] pluginKeys=${Object.keys(judgeFastFromPlugin).length} envKeys=${Object.keys(judgeFastFromEnv).length} rawKeys=${Object.keys(judgeFastRaw).length} envVar="${process.env.OCTOCLAW_JUDGE_FAST?.slice(0, 50) ?? "(none)"}" modelId="${(judgeFastRaw as Record<string, unknown>).modelId ?? "(none)"}"`);
    }

    const delegationCapability = resolveDelegationCapability({
      pluginConfig: asRecord(pi.pluginConfig),
      env: process.env as Record<string, string | undefined>,
    });
    const delegationEnabled = delegationCapability.enabled;

    // Fire-and-forget bridge init — lazy-loads openclaw runtime binding
    // If runtime unavailable, getCachedBridge() returns unavailable bridge (fail-closed)
    initNativeHelperBridge().catch(() => { /* bridge will use unavailable fallback */ });
    registerRouterWizardSlackInteractiveHandlers(pi);

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

    registerLifecycleHook("message_sending", makeMessageSendingHook({ pi, recordNeutralAckCancellations }), 220);
    registerLifecycleHook("reply_dispatch", makeReplyDispatchHook({ pi }), 220);
    registerLifecycleHook("message_received", makeMessageReceivedHook({ pi, maybeSendNeutralInboundAckForContext }), 280);
    registerLifecycleHook("before_compaction", makeBeforeCompactionHook({ pi }), 180);
    registerLifecycleHook("before_dispatch", makeBeforeDispatchHook({ pi, maybeSendNeutralInboundAckForContext }), 260);
    registerLifecycleHook("subagent_ended", makeSubagentEndedHook({ pi }), 210);
    registerLifecycleHook("before_model_resolve", makeBeforeModelResolveHook({ pi }));

    registerLifecycleHook("before_prompt_build", makeBeforePromptBuildHook({
      pi,
      judgeFastRaw,
      delegationEnabled,
      buildReactionAckState,
      applyReactionAckState,
      maybeSendNeutralInboundAckForContext,
      currentPluginConfig,
    }));


    registerLifecycleHook("before_tool_call", makeBeforeToolCallHook({
      pi,
      currentPluginConfig,
    }));

    registerLifecycleHook("after_tool_call", makeAfterToolCallHook({ pi, currentPluginConfig }));
    registerLifecycleHook("agent_end", makeAgentEndHook({ pi }), 50);
    registerLifecycleHook("before_message_write", makeBeforeMessageWriteHook({ pi, recordNeutralAckCancellations }), 120);
    registerLifecycleHook("gateway_start", async () => {
      await recoverNativeRunsOnGatewayStart({ logger: pi.logger });
    }, 120);

    if (watchdogInterval) {
      clearInterval(watchdogInterval);
    }
    watchdogInterval = setInterval(() => {
      void watchdogTick(pi.logger).catch(() => undefined);
    }, WATCHDOG_INTERVAL_MS);
    void watchdogStartupReconcile(pi.logger);

    if (taskStateRetentionInterval) {
      clearInterval(taskStateRetentionInterval);
    }
    runTaskStateRetention(pi.logger);
    taskStateRetentionInterval = setInterval(() => {
      runTaskStateRetention(pi.logger);
    }, DEFAULT_TASK_STATE_RETENTION_MIN_RUN_INTERVAL_MS);

    if (typeof pi.registerTool === "function") {
      for (const tool of getToolRegistrations({ judgeFastRaw, delegationEnabled, pluginConfigProvider: currentPluginConfig })) {
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
