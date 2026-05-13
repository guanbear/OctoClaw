import { createHash } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import {
  cancelAckGuardForState,
  getAckTrackingState,
  sendNeutralInboundAck,
  type NeutralInboundAckResult,
  updateAckTrackingState,
  watchdogTick,
  WATCHDOG_INTERVAL_MS,
} from "./ack/ack-guard.js";
import { sendDelegateWithoutDispatchNotice } from "./ack/ack-delegate-without-dispatch.js";
import {
  pendingLatencyAckTimers,
  pendingNeutralInboundAckTimers,
  pendingNeutralInboundAckTextFallbackTimers,
  pendingBudgetedMainTimers,
  lastGroundedPromptByStateKey,
  configuredNeutralAckDelayMs,
  configuredNeutralAckTextFallbackDelayMs,
  neutralAckTimerKey,
  neutralAckTextFallbackTimerKey,
  cancelNeutralAckTimersByCandidates,
  type CanceledNeutralAckTimer,
} from "./ack/ack-scheduler.js";
import { sendIMMessage, type SendIMResult } from "./im/send.js";
import { fetchLatestUserMessageTsForSessionKey } from "./im/slack-thread-anchor.js";
import { renderIMProjectionFooter } from "./im/projection-footer.js";
import type { IMProjectionFooter } from "./im/adapter.js";
import { hasProjectionFooter } from "./projection-footer-sanitizer.js";
import {
  buildPolicyMetadata,
  isManagedAgentContext,
  resolveAckDeliverySessionKey,
  resolvePolicyStateKey,
  resolvePolicyStateKeys,
} from "./resolve/session.js";
import { resolvePolicyDecisionForContext } from "./resolve/policy-resolver.js";
import { envOverrides, resolveMainAgentSessionsPath, resolveWorkspaceRoot, stableId } from "./resolve/env.js";
import {
  DEFAULT_TASK_STATE_RETENTION_MIN_RUN_INTERVAL_MS,
  pruneTaskStateCache,
} from "./state/task-state-retention.js";
import { initNativeHelperBridge } from "./adapter/native-helper.js";
import { buildTurnExecutionReceipt, type TurnExecutionReceipt } from "./receipt.js";
import { firstDisplayModel } from "./model-display.js";
import {
  assistantMessageText,
  guardAssistantMessageForPolicyState,
  replaceAssistantMessageText,
} from "./replay/message-guard.js";
import {
  isDelegatedRoute,
  shouldRetainPolicyStateOnAgentEnd,
} from "./replay/policy-utils.js";
import { recordPolicyReplay } from "./replay/replay.js";
import { policyState, type PolicyStateEntry } from "./state/policy-state.js";
import { getCommandRegistrations, getToolRegistrations } from "./tools/registration.js";
import { buildNativeStatusOutput, buildNativeTaskActionPayload } from "./tools/runtime-status.js";
import { nativeSpawnIntentStore } from "./delegate/native-spawn-intent-store.js";
import { resolveSpawnBackend, resolveSpeculativePreloadEnabled } from "./config/index.js";
import { findWorkContractByNativeChildSessionKey, loadWorkContract, saveWorkContract, updateWorkContract } from "./work-contract/store.js";
import { compactWorkContractView, type ContextCoverageSnapshot, type DelegateContract, type IntentClass, type WorkContract, type WorkDecisionSource } from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "./work-contract/builders.js";
import { buildExecutionCoverageLayer } from "./resolve/execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "./resolve/memory-coverage-precheck.js";
import {
  buildBudgetedMainMetrics,
  buildBudgetedMainState,
  escalateBudgetedMainDecision,
  hasBudgetedMainEscalationEvidence,
  isBudgetedMainDecision,
  readBudgetedMainState,
  serializeBudgetedMainState,
  type BudgetedMainState,
} from "./budgeted-main.js";
import {
  buildSpeculativePreloadHint,
  buildSpeculativePreloadLabel,
  buildSpeculativePreloadSpawnArgs,
  isMatchingSpeculativePreloadSpawn,
  readSpeculativePreloadState,
  serializeSpeculativePreloadState,
  speculativePreloadStateForHint,
} from "./delegate/speculative-preload.js";
import { resolvePlannerNativeCwd } from "./delegate/planner-cwd.js";
import { type UnknownRecord, asRecord } from "./util/type-coercion.js";
import type { HookHandler, LoggerLike, PluginInterface } from "./extension-entry-shared.js";
import { firstNonEmptyString, firstStringValue, stringArray, stringValue, toolResultRecord } from "./extension-entry-shared.js";
export type { HookHandler, LoggerLike, PluginInterface } from "./extension-entry-shared.js";
export { buildPromptContextProjection, extractMessageText, extractPromptText, queryDelegateStatus, resolveDelegationCapability, resolveReactionAckConfig } from "./extension-entry-helpers.js";
import { buildPromptContextProjection, extractMessageText, extractPromptText, resolveDelegationCapability, resolveReactionAckConfig } from "./extension-entry-helpers.js";
export { extractInboundMessageTimestamp, extractInboundMessageTimestampWithSource, resolveSlackMessageReceivedSessionKey } from "./inbound-timestamps.js";
export type { InboundMessageTimestampSource } from "./inbound-timestamps.js";
import { extractInboundMessageTimestamp, extractInboundMessageTimestampWithSource, findInboundMessageTimestamp, resolveSlackMessageReceivedSessionKey, SLACK_MESSAGE_TS_PATTERN, type InboundMessageTimestampSource } from "./inbound-timestamps.js";
import { detectIMType } from "./im-status-renderer.js";
import { makeBeforePromptBuildHook } from "./hooks/before-prompt-build.js";
import { makeBeforeToolCallHook } from "./hooks/before-tool-call.js";
import {
  handleRouterWizardAction,
  maybeSendRouterWizardOnboarding,
} from "./router-onboarding.js";

export type NativeAnnounceSendMessage = (params: {
  sessionKey: string;
  message: string;
  replyToMessageId?: string;
  cwd?: string;
}) => Promise<SendIMResult>;


export const OCTOCLAW_DELEGATION_SYSTEM_CONTEXT = [
  "OctoClaw runtime policy is authoritative for this run.",
  "When route is delegated, the main agent is a coordinator and must use OctoClaw control tools instead of doing the work directly.",
  "Do not hand-write session or subagent spawning commands.",
  "Do not explain delegation strategy, routing rationale, or task boundary analysis to the user. Use octoclaw_dispatch directly.",
  "When delegated work depends on local code, docs, or repo state, pass the smallest known anchors to octoclaw_dispatch as metadataJson.context_refs.",
  "Use this shape when anchors are known: {\"context_refs\":{\"primaryFiles\":[\"path\"],\"readScope\":[\"dir\"],\"sourcePolicy\":\"local refs first\",\"maxToolCalls\":4,\"workspaceMode\":\"read_only\"}}.",
  "When the user explicitly requests a persistent side effect and no narrower write target is known, pass {\"context_refs\":{\"requestedSideEffects\":true,\"workspaceMode\":\"write_allowed\"}}; do not rely on the child to infer write permission from wording.",
  "If anchors are not already known, use at most two lightweight read-only lookups to find exact refs, or dispatch without refs and let the child report missing context; never fabricate refs just to fill the packet.",
  "Do not emit user-visible coordinator chatter or ACK text such as '我来写'、'收到，我看一下'、'我先确认一下派发边界'. Runtime ACK handles acknowledgments as tracked deliverables.",
  "Before tool calls or route_hint, emit no user-visible text. User-visible output should only contain authoritative status receipt, final result, or clear failure.",
].join("\n");

export const OCTOCLAW_DELEGATION_SLIM_SYSTEM_CONTEXT = [
  "OctoClaw delegated-route context: before native spawn, answer directly only if this turn can be fully resolved now without background work.",
  "If delegation is still needed, use octoclaw_dispatch; do not hand-write sessions_spawn args or bypass the returned planner intent.",
  "Pass only already-known local anchors as metadataJson.context_refs; if anchors are unknown, dispatch without fabricated refs and let the child return a blocked worker result packet.",
  "For explicit persistent side effects, pass metadataJson.context_refs.requestedSideEffects=true and workspaceMode=write_allowed.",
  "Emit no user-visible ACK/coordinator text before accepted native run evidence and OctoClaw confirm exist.",
].join("\n");

export function resolveSlimMainContextEnabled(pluginConfig?: UnknownRecord): boolean {
  const env = stringValue(process.env.OCTOCLAW_SLIM_MAIN_CONTEXT).toLowerCase();
  if (env === "0" || env === "false" || env === "off") return false;
  const configured = pluginConfig?.slimMainContext ?? pluginConfig?.slim_main_context;
  if (configured === false) return false;
  if (stringValue(configured).toLowerCase() === "false") return false;
  return true;
}



export const OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT = [
  "Use octoclaw_route_hint only as an internal control-plane action when runtime policy requires it; never introduce it with user-visible text.",
  "Use octoclaw_route_hint to state only the two-class route intent: reply or delegate. Runtime derives must_reply, must_delegate, or budgeted_main_then_delegate from route plus cost signals.",
  "After route_hint merge: reply may answer directly; delegated routes must go through octoclaw_dispatch.",
  "",
  "Handle directly for greetings, simple Q&A, clarifications, status/provenance follow-up, and up to two lightweight read-only lookups when they fit the budget.",
  "Delegate only for explicit background/subagent/parallel work, code/file mutation, tests/builds, long commands, multi-step tools, review/validation, or work that cannot fit the budget.",
  "Bare model/tool names, fresh lookup, route_hint=delegate, and fast_first_response are advisory only and do not force delegate by themselves.",
].join("\n");

export const OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT = [
  "When the user asks for task progress or acts on an OctoClaw task anchor, prefer the octoclaw_task_action tool.",
  "Use it for commands like: details <task_id>, queue, artifacts <task_id>, stop <task_id>, retry <task_id>, approve <task_id>, reject <task_id>.",
].join("\n");

export const OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT = [
  "This task requires review before dispatch. Proceed directly with octoclaw_dispatch — do not echo reasoning about task boundaries or delegation strategy to the user.",
].join("\n");

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

async function handleOctoClawControlPlaneFastPath(input: {
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

async function sendCompactionNotice(event: UnknownRecord, ctx: UnknownRecord, logger?: LoggerLike): Promise<void> {
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


function isAcceptedSpeculativeSpawnResult(result: unknown): boolean {
  const record = toolResultRecord(result);
  return stringValue(record.status) === "accepted"
    && Boolean(firstNonEmptyString(record.runId, record.run_id, record.childRunId, record.child_run_id, record.childSessionKey, record.child_session_key));
}

function speculativeSpawnResultError(result: unknown, fallback?: unknown): string {
  const record = toolResultRecord(result);
  return firstNonEmptyString(record.error, fallback, "speculative_preload_spawn_not_accepted");
}

function speculativePreloadThreadBindingUnavailable(error: unknown): boolean {
  const text = stringValue(error).toLowerCase();
  if (!text) return false;
  return (
    text.includes("sessions_spawn(mode=\"session\")")
    && (text.includes("thread binding") || text.includes("thread bindings"))
    && (text.includes("not running on a channel") || text.includes("unavailable") || text.includes("disabled"))
  ) || (
    text.includes("thread=true")
    && (text.includes("thread binding") || text.includes("thread bindings"))
    && text.includes("not running on a channel")
  );
}

function normalizeOutboundTargetKey(value: unknown): string {
  return stringValue(value)
    .toLowerCase()
    .replace(/^channel:/u, "")
    .replace(/^user:/u, "")
    .replace(/[^a-z0-9_.:-]+/gu, "");
}

function outboundTargetLooksLikeSlack(value: unknown): boolean {
  const raw = stringValue(value);
  const lower = raw.toLowerCase();
  if (!raw) return false;
  if (lower.includes("slack")) return true;
  if (/^(?:channel|chat|user|direct|dm):[cdgu][a-z0-9]{8,}$/iu.test(raw)) return true;
  return /^[cdgu][a-z0-9]{8,}$/iu.test(normalizeOutboundTargetKey(raw));
}

function outboundTargetCandidates(event: UnknownRecord, ctx: UnknownRecord): unknown[] {
  const metadata = asRecord(event.metadata);
  const message = asRecord(event.message);
  return [
    event.to,
    event.channel,
    event.channelId,
    event.channel_id,
    event.conversationId,
    event.conversation_id,
    message.to,
    message.channel,
    message.channelId,
    message.channel_id,
    metadata.channelId,
    metadata.channel_id,
    metadata.channel,
    metadata.to,
    metadata.conversationId,
    metadata.conversation_id,
    metadata.sessionKey,
    metadata.session_key,
    ctx.conversationId,
    ctx.conversation_id,
    ctx.sessionKey,
    ctx.session_key,
    ctx.canonicalSessionKey,
    ctx.canonical_session_key,
    ctx.to,
    ctx.channel,
    ctx.channelId,
    ctx.channel_id,
    ctx.from,
    ctx.senderId,
    ctx.sender_id,
  ];
}

function resolveOutboundPolicyTarget(event: UnknownRecord, ctx: UnknownRecord): unknown {
  const candidates = outboundTargetCandidates(event, ctx);
  return candidates.find((candidate) => outboundTargetLooksLikeSlack(candidate))
    || candidates.find((candidate) => stringValue(candidate))
    || "";
}

function outboundDeliveryContent(event: UnknownRecord): string {
  const message = asRecord(event.message);
  return stringValue(event.content)
    || assistantMessageText(message)
    || stringValue(message.content)
    || stringValue(message.text);
}

function outboundGuardReplacement(event: UnknownRecord, content: string): { content: string; message?: UnknownRecord } {
  const message = asRecord(event.message);
  if (Object.keys(message).length === 0) return { content };
  return {
    content,
    message: replaceAssistantMessageText(message, content),
  };
}

function outboundMessageAnchors(event: UnknownRecord, ctx: UnknownRecord): string[] {
  const prompt = [
    outboundDeliveryContent(event),
    extractPromptText(event),
    extractPromptText(ctx),
  ].filter(Boolean).join("\n");
  const anchors = [
    extractInboundMessageTimestamp(ctx, event, prompt),
    findInboundMessageTimestamp(event),
    findInboundMessageTimestamp(ctx),
    stringValue(event.replyToMessageId),
    stringValue(event.reply_to_id),
    stringValue(event.replyToId),
    stringValue(event.threadTs),
    stringValue(event.thread_ts),
    stringValue(event.threadId),
    stringValue(event.thread_id),
    stringValue(event.message_id),
    stringValue(event.messageId),
    stringValue(ctx.replyToMessageId),
    stringValue(ctx.reply_to_id),
    stringValue(ctx.replyToId),
    stringValue(ctx.threadTs),
    stringValue(ctx.thread_ts),
    stringValue(ctx.threadId),
    stringValue(ctx.thread_id),
    stringValue(ctx.inboundMessageTs),
    stringValue(ctx.message_id),
    stringValue(ctx.messageId),
  ];
  return Array.from(new Set(anchors.filter((value) => SLACK_MESSAGE_TS_PATTERN.test(value))));
}

function stateMatchesOutboundAnchor(key: string, state: PolicyStateEntry, anchors: string[]): boolean {
  if (anchors.length === 0) return false;
  const decision = asRecord(state.decision);
  const requestMetadata = asRecord(asRecord(decision.request).metadata);
  const candidates = [
    stringValue(state.inboundMessageTs),
    stringValue(state.message_id),
    stringValue(state.messageId),
    stringValue(state.replyToMessageId),
    stringValue(state.reply_to_id),
    deliveryTargetReplyTo(asRecord(state)),
    stringValue(requestMetadata.message_id),
    stringValue(requestMetadata.messageId),
    stringValue(requestMetadata.inboundMessageTs),
    stringValue(requestMetadata.reply_to_id),
    stringValue(requestMetadata.thread_ts),
  ];
  return anchors.some((anchor) => candidates.includes(anchor) || key.includes(`:thread:${anchor}`));
}

function policyStateLooksRelevantForOutbound(key: string, state: PolicyStateEntry, targetKey: string, anchors: string[], now: number): boolean {
  if (!targetKey) return false;
  const stateRecord = asRecord(state);
  const keyLower = key.toLowerCase();
  const anchorMatches = stateMatchesOutboundAnchor(key, state, anchors);
  const targetMatches = keyLower.includes(targetKey);
  if (!targetMatches && !(anchors.length > 0 && anchorMatches && keyLower.includes(":slack:"))) return false;
  const updatedAt = Number(state.updatedAt || state.createdAt || 0);
  if (!Number.isFinite(updatedAt) || now - updatedAt > 3 * 60 * 1000) return false;
  if (anchors.length > 0 && !anchorMatches) return false;
  return Object.keys(asRecord(stateRecord.decision)).length > 0
    || Object.keys(asRecord(stateRecord.outboundProjection || stateRecord.outbound_projection)).length > 0;
}

function outboundHasDeliveryMetadata(event: UnknownRecord): boolean {
  const metadata = asRecord(event.metadata);
  return Boolean(
    metadata.channel
    || metadata.channelId
    || metadata.threadTs
    || metadata.thread_ts
    || metadata.accountId
    || Array.isArray(metadata.mediaUrls)
  );
}

function outboundLooksLikeVisibleDeliveryHook(event: UnknownRecord, ctx: UnknownRecord): boolean {
  if (outboundHasDeliveryMetadata(event)) return true;
  // Also treat Slack delivery targets as visible:
  // event.to can be a Slack user/channel ID (U*/C*) or contain "slack" when
  // OpenClaw sends via native Slack transport without standard metadata fields.
  if (outboundTargetCandidates(event, ctx).some((candidate) => outboundTargetLooksLikeSlack(candidate))) return true;
  return stringValue(ctx.channelId || ctx.channel).toLowerCase() === "slack";
}

type ReplyDispatchKind = "tool" | "block" | "final";
type ReplyPayloadLike = UnknownRecord & { text?: unknown };

const replyDispatchProjectionWrapped = new WeakSet<object>();

function replyDispatchSourceContext(event: UnknownRecord): UnknownRecord {
  return asRecord(event.ctx);
}

function buildReplyDispatchDeliveryContext(event: UnknownRecord): UnknownRecord {
  const source = replyDispatchSourceContext(event);
  const channelId = firstStringValue(
    source.OriginatingChannel,
    source.Surface,
    source.Provider,
    event.originatingChannel,
    event.channelId,
  );
  const conversationId = firstStringValue(
    source.OriginatingTo,
    source.To,
    source.NativeChannelId,
    event.originatingTo,
  );
  const inboundTs = firstStringValue(
    source.MessageSid,
    source.MessageSidFull,
    source.MessageSidFirst,
    source.MessageSidLast,
    source.ReplyToId,
    source.MessageThreadId,
  );
  return {
    channelId,
    channel: channelId,
    conversationId,
    conversation_id: conversationId,
    sessionKey: firstStringValue(event.sessionKey, source.SessionKey),
    session_key: firstStringValue(event.sessionKey, source.SessionKey),
    accountId: firstStringValue(source.AccountId, event.accountId),
    senderId: firstStringValue(source.SenderId, source.From),
    model: firstStringValue(event.model, source.Model, source.model),
    inboundMessageTs: inboundTs,
    messageId: inboundTs,
    message_id: inboundTs,
    replyToMessageId: firstStringValue(source.ReplyToId, source.MessageThreadId, inboundTs),
    reply_to_id: firstStringValue(source.ReplyToId, source.MessageThreadId, inboundTs),
    threadTs: firstStringValue(source.MessageThreadId, source.ReplyToId, inboundTs),
    thread_ts: firstStringValue(source.MessageThreadId, source.ReplyToId, inboundTs),
  };
}

function buildReplyDispatchDeliveryEvent(
  payload: ReplyPayloadLike,
  event: UnknownRecord,
  kind: ReplyDispatchKind,
): UnknownRecord {
  const source = replyDispatchSourceContext(event);
  const to = firstStringValue(
    source.OriginatingTo,
    source.To,
    source.NativeChannelId,
    event.originatingTo,
  );
  const channel = firstStringValue(source.OriginatingChannel, source.Surface, source.Provider, event.originatingChannel);
  const channelId = firstStringValue(source.NativeChannelId, source.OriginatingTo, source.To, event.originatingTo);
  const replyToMessageId = firstStringValue(source.ReplyToId, source.MessageThreadId, source.MessageSid);
  return {
    content: stringValue(payload.text),
    to,
    channel,
    channelId,
    channel_id: channelId,
    conversationId: to,
    conversation_id: to,
    replyToMessageId,
    reply_to_id: replyToMessageId,
    threadTs: firstStringValue(source.MessageThreadId, source.ReplyToId, source.MessageSid),
    thread_ts: firstStringValue(source.MessageThreadId, source.ReplyToId, source.MessageSid),
    sessionKey: firstStringValue(event.sessionKey, source.SessionKey),
    session_key: firstStringValue(event.sessionKey, source.SessionKey),
    metadata: {
      channel,
      channelId,
      channel_id: channelId,
      accountId: firstStringValue(source.AccountId, event.accountId),
      threadTs: firstStringValue(source.MessageThreadId, source.ReplyToId, source.MessageSid),
      thread_ts: firstStringValue(source.MessageThreadId, source.ReplyToId, source.MessageSid),
      replyKind: kind,
    },
  };
}

function projectReplyDispatchPayloadForPolicyState(
  payload: unknown,
  kind: ReplyDispatchKind,
  event: UnknownRecord,
  now = Date.now(),
): ReplyPayloadLike | null {
  const payloadRecord = asRecord(payload) as ReplyPayloadLike;
  if (kind !== "final") return payloadRecord;
  const text = stringValue(payloadRecord.text);
  if (!text) return payloadRecord;
  const deliveryEvent = buildReplyDispatchDeliveryEvent(payloadRecord, event, kind);
  const deliveryCtx = buildReplyDispatchDeliveryContext(event);
  const guarded = guardOutboundMessageForPolicyState(deliveryEvent, deliveryCtx, now);
  if (guarded?.cancel) return null;
  if (guarded?.content && guarded.content !== text) {
    return { ...payloadRecord, text: guarded.content };
  }
  return payloadRecord;
}

export function wrapReplyDispatchFooterProjection(event: UnknownRecord, hookCtx: UnknownRecord, now?: number): boolean {
  const dispatcher = asRecord(hookCtx.dispatcher);
  if (Object.keys(dispatcher).length === 0 || replyDispatchProjectionWrapped.has(dispatcher)) return false;
  const sendFinalReply = dispatcher.sendFinalReply;
  if (typeof sendFinalReply !== "function") return false;
  replyDispatchProjectionWrapped.add(dispatcher);
  dispatcher.sendFinalReply = function wrappedSendFinalReply(payload: unknown): boolean {
    const projected = projectReplyDispatchPayloadForPolicyState(payload, "final", event, now ?? Date.now());
    if (!projected) return false;
    return sendFinalReply.call(this, projected);
  };
  return true;
}

function findRecentOutboundPolicyState(
  target: unknown,
  event: UnknownRecord,
  ctx: UnknownRecord,
  now: number,
  options: { allowUnanchoredDelivery?: boolean } = {},
): { key: string; state: PolicyStateEntry; anchored: boolean } | null {
  const targetKey = normalizeOutboundTargetKey(target);
  if (!targetKey) return null;
  const anchors = outboundMessageAnchors(event, ctx);
  const anchored = anchors.length > 0;
  if (!anchored && !options.allowUnanchoredDelivery) return null;
  let best: { key: string; state: PolicyStateEntry; updatedAt: number } | null = null;
  for (const entry of policyState.entries()) {
    if (!policyStateLooksRelevantForOutbound(entry.key, entry.state, targetKey, anchored ? anchors : [], now)) continue;
    if (!anchored) {
      const candidateState = asRecord(entry.state);
      if (isDelegatedRoute(asRecord(candidateState.decision))
        && candidateState.dispatchExecuted !== true
        && candidateState.dispatch_executed !== true
        && candidateState.spawnExecuted !== true
        && candidateState.spawn_executed !== true
        && candidateState.resultMaterialized !== true
        && candidateState.result_materialized !== true
      ) continue;
    }
    const updatedAt = Number(entry.state.updatedAt || entry.state.createdAt || 0);
    if (!anchored && now - updatedAt > 90 * 1000) continue;
    if (!best || updatedAt > best.updatedAt) {
      best = { key: entry.key, state: entry.state, updatedAt };
    }
  }
  return best ? { key: best.key, state: best.state, anchored } : null;
}

function stateHasExecutionEvidence(state: UnknownRecord): boolean {
  return state.dispatchExecuted === true
    || state.dispatch_executed === true
    || state.spawnExecuted === true
    || state.spawn_executed === true
    || state.resultMaterialized === true
    || state.result_materialized === true;
}

function outboundStateWorkContractId(state: UnknownRecord): string {
  const decision = asRecord(state.decision);
  const workContract = asRecord(decision.work_contract);
  return stringValue(state.workContractId || state.work_contract_id)
    || stringValue(workContract.workContractId || workContract.work_contract_id)
    || stringValue(decision.workContractId || decision.work_contract_id);
}

function hydrateOutboundStateWithNativeRefs(state: UnknownRecord): UnknownRecord {
  const workContractId = outboundStateWorkContractId(state);
  if (stateHasExecutionEvidence(state) && (!workContractId || isNativeAnnounceAlreadyDelivered(state))) return state;
  if (!workContractId) return state;
  const contract = loadWorkContract(workContractId);
  if (!contract) return state;
  const nativeRefs = asRecord(contract.nativeSpawnRefs);
  const delegate = asRecord(contract.delegate);
  const nativeBinding = asRecord(delegate.nativeBinding);
  const telemetry = asRecord(contract.telemetry);
  const runId = stringValue(nativeRefs.openclawRunId || nativeBinding.runId);
  const childRunId = stringValue(nativeBinding.childRunId || telemetry.childRunId || runId);
  const childSessionKey = stringValue(nativeRefs.childSessionKey || nativeBinding.childSessionKey || telemetry.childSessionKey);
  const spawnIntentId = stringValue(nativeRefs.spawnIntentId || state.spawnIntentId || state.spawn_intent_id);
  const hasAcceptedNativeRefs = Boolean(runId || childRunId || childSessionKey || telemetry.spawnExecuted === true);
  if (!hasAcceptedNativeRefs) return state;
  const deliveryStatus = stringValue(telemetry.deliveryStatus).toLowerCase();
  const resultMaterialized = telemetry.resultMaterialized === true;
  const delivered = ["delivered", "sent"].includes(deliveryStatus);
  const decision = asRecord(state.decision);
  const routeDecision = asRecord(decision.route_decision);
  const workContract = asRecord(decision.work_contract);
  return {
    ...state,
    decision: {
      ...decision,
      route_decision: {
        ...routeDecision,
        route: "delegate",
        ...(delivered ? { route_source: "native_announce" } : {}),
      },
      work_contract: {
        ...workContract,
        workContractId,
        work_contract_id: workContractId,
        route: "delegate",
        ...(childSessionKey ? { childSessionKey } : {}),
        ...(runId ? { openclawRunId: runId } : {}),
        ...(spawnIntentId ? { spawnIntentId } : {}),
      },
    },
    delegated: true,
    dispatchRoute: "delegate",
    dispatchStatus: delivered ? "result_delivered" : "spawn_confirmed",
    dispatchExecuted: true,
    dispatch_executed: true,
    spawnExecuted: true,
    spawn_executed: true,
    workContractId,
    work_contract_id: workContractId,
    ...(resultMaterialized ? { resultMaterialized: true, result_materialized: true } : {}),
    ...(deliveryStatus ? { deliveryStatus, delivery_status: deliveryStatus } : {}),
    ...(delivered ? {
      nativeAnnounceCompletionPending: false,
      native_announce_completion_pending: false,
      nativeAnnounceDelivered: true,
      native_announce_delivered: true,
    } : {}),
    ...(spawnIntentId ? { spawnIntentId, spawn_intent_id: spawnIntentId } : {}),
    ...(runId ? { runId, run_id: runId } : {}),
    ...(childRunId ? { childRunId, child_run_id: childRunId } : {}),
    ...(childSessionKey ? { childSessionKey, child_session_key: childSessionKey } : {}),
  };
}

interface NativeAnnounceCompletion {
  sourceSessionKey: string;
  sourceSessionId: string;
  sourceTool: string;
  status: string;
  resultText: string;
  resultHash: string;
}

interface NativeAnnounceBlocker {
  blocked: true;
  reason: string;
}

export const NATIVE_ANNOUNCE_BLOCKED_TOOLS = new Set([
  "octoclaw_dispatch",
  "octoclaw_dispatch_confirm",
  "sessions_spawn",
]);

function regexGroup(text: string, pattern: RegExp): string {
  return stringValue(pattern.exec(text)?.[1]);
}

function extractOctoClawWorkerResultPacket(text: string): UnknownRecord {
  const raw = regexGroup(
    text,
    /<<<BEGIN_OCTOCLAW_WORKER_RESULT>>>\s*([\s\S]*?)\s*<<<END_OCTOCLAW_WORKER_RESULT>>>/u,
  );
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

function extractNativeAnnounceBlocker(completion: NativeAnnounceCompletion): NativeAnnounceBlocker | null {
  const resultText = stringValue(completion.resultText);
  const status = stringValue(completion.status).toLowerCase();
  const workerResult = extractOctoClawWorkerResultPacket(resultText);
  if (
    stringValue(workerResult.schemaVersion || workerResult.schema_version) === "octoclaw.worker_result.v1"
    && stringValue(workerResult.status).toLowerCase() === "blocked"
  ) {
    const blockers = Array.isArray(workerResult.blockers)
      ? workerResult.blockers.map((item) => stringValue(item)).filter(Boolean)
      : [];
    const rawReason = blockers[0] || stringValue(workerResult.summary) || "child reported missing context";
    const reason = rawReason.replace(/\s+/gu, " ").trim().slice(0, 220) || "child reported missing context";
    return { blocked: true, reason };
  }
  const structuredBlocked = status === "blocked" || status.startsWith("blocked ");
  if (!structuredBlocked) return null;
  const rawReason = "child reported missing context";
  const reason = rawReason.replace(/\s+/gu, " ").trim().slice(0, 220) || "child reported missing context";
  return { blocked: true, reason };
}

function nativeAnnounceProvenance(event: UnknownRecord): UnknownRecord {
  const direct = asRecord(event.provenance);
  if (stringValue(direct.sourceTool || direct.source_tool || direct.kind)) return direct;
  const message = asRecord(event.message);
  const messageProvenance = asRecord(message.provenance);
  if (stringValue(messageProvenance.sourceTool || messageProvenance.source_tool || messageProvenance.kind)) {
    return messageProvenance;
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = asRecord(messages[index]);
    const provenance = asRecord(candidate.provenance);
    if (stringValue(provenance.sourceTool || provenance.source_tool || provenance.kind)) {
      return provenance;
    }
  }
  return {};
}

function extractNativeAnnounceCompletion(event: UnknownRecord, prompt: string): NativeAnnounceCompletion | null {
  const text = stringValue(prompt);
  if (!text) return null;
  const provenance = nativeAnnounceProvenance(event);
  const sourceTool = stringValue(provenance.sourceTool || provenance.source_tool)
    || regexGroup(text, /\bsourceTool=([^\s]+)/u);
  const internalSubagentCompletion = /\[Internal task completion event\][\s\S]*\bsource:\s*subagent\b/iu.test(text);
  if (sourceTool !== "subagent_announce" && !text.includes("sourceTool=subagent_announce") && !internalSubagentCompletion) {
    return null;
  }
  const sourceSessionFromPrompt = regexGroup(text, /\bsourceSession=([^\s]+)/u)
    || regexGroup(text, /\bsession_key:\s*([^\s]+)/u);
  const sourceSessionKey = sourceSessionFromPrompt
    || stringValue(provenance.sourceSessionKey || provenance.source_session_key);
  if (!sourceSessionKey) return null;
  const status = regexGroup(text, /\bstatus:\s*([^\n]+)/iu);
  const looksCompleted = /completed|success|succeed/i.test(status)
    || /completed subagent task is ready/i.test(text)
    || /\[Internal task completion event\]/u.test(text);
  if (!looksCompleted) return null;
  const resultText = regexGroup(
    text,
    /<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>\s*([\s\S]*?)\s*<<<END_UNTRUSTED_CHILD_RESULT>>>/u,
  );
  if (!resultText) return null;
  return {
    sourceSessionKey,
    sourceSessionId: stringValue(provenance.sourceSessionId || provenance.source_session_id)
      || regexGroup(text, /\bsession_id:\s*([^\s]+)/u),
    sourceTool: "subagent_announce",
    status,
    resultText,
    resultHash: createHash("sha256").update(resultText).digest("hex").slice(0, 16),
  };
}

function addNativeChildSessionFileCandidate(candidates: Set<string>, candidate: unknown, baseDir: string): void {
  const text = stringValue(candidate);
  if (!text) return;
  candidates.add(path.isAbsolute(text) ? text : path.join(baseDir, text));
}

function nativeChildSessionFileCandidates(childSessionKey: string, runId?: string): string[] {
  const sessionsPath = resolveMainAgentSessionsPath();
  const sessionsDir = path.dirname(sessionsPath);
  const refs = new Set([childSessionKey, runId].map(stringValue).filter(Boolean));
  const candidates = new Set<string>();
  for (const ref of refs) {
    addNativeChildSessionFileCandidate(candidates, `${ref}.jsonl`, sessionsDir);
  }
  try {
    const registry = JSON.parse(fsSync.readFileSync(sessionsPath, "utf8")) as unknown;
    if (registry && typeof registry === "object" && !Array.isArray(registry)) {
      for (const [key, value] of Object.entries(registry as UnknownRecord)) {
        const record = asRecord(value);
        const values = [
          key,
          record.sessionKey,
          record.sessionId,
          record.runId,
          record.childRunId,
          record.controlKey,
          record.channelSessionKey,
          record.bindingKey,
          record.threadKey,
        ].map(stringValue);
        if (!values.some((candidate) => refs.has(candidate))) continue;
        addNativeChildSessionFileCandidate(candidates, record.sessionFile, sessionsDir);
        const sessionId = stringValue(record.sessionId);
        if (sessionId) addNativeChildSessionFileCandidate(candidates, `${sessionId}.jsonl`, sessionsDir);
      }
    }
  } catch {}
  return [...candidates];
}

function readNativeChildSessionCompletion(childSessionKey: string, runId?: string): NativeAnnounceCompletion | null {
  const sourceSessionKey = stringValue(childSessionKey);
  if (!sourceSessionKey) return null;
  let resultText = "";
  let sourceSessionId = "";
  for (const filePath of nativeChildSessionFileCandidates(sourceSessionKey, runId)) {
    let lines: string[];
    try {
      lines = fsSync.readFileSync(filePath, "utf8").split(/\n/u).filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      let record: UnknownRecord;
      try {
        record = JSON.parse(line) as UnknownRecord;
      } catch {
        continue;
      }
      if (record.type === "session") {
        sourceSessionId ||= stringValue(record.id);
      }
      if (record.type !== "message") continue;
      const message = asRecord(record.message);
      if (stringValue(message.role).toLowerCase() !== "assistant") continue;
      const text = extractMessageText(message.content);
      if (!text || text.trim().toUpperCase() === "NO_REPLY") continue;
      resultText = text;
    }
    if (resultText) break;
  }
  if (!resultText) return null;
  return {
    sourceSessionKey,
    sourceSessionId,
    sourceTool: "subagent_announce",
    status: "completed",
    resultText,
    resultHash: createHash("sha256").update(resultText).digest("hex").slice(0, 16),
  };
}

function contractNativeIds(contract: WorkContract): {
  runId: string;
  childRunId: string;
  childSessionKey: string;
  spawnIntentId: string;
} {
  const nativeRefs = asRecord(contract.nativeSpawnRefs);
  const delegate = asRecord(contract.delegate);
  const nativeBinding = asRecord(delegate.nativeBinding);
  const telemetry = asRecord(contract.telemetry);
  const visibleIds = asRecord(contract.mainContext?.visibleIds);
  const runId = stringValue(nativeRefs.openclawRunId || nativeBinding.runId || telemetry.childRunId || visibleIds.openclawRunId);
  return {
    runId,
    childRunId: stringValue(nativeBinding.childRunId || telemetry.childRunId || runId),
    childSessionKey: stringValue(
      nativeRefs.childSessionKey
      || nativeBinding.childSessionKey
      || telemetry.childSessionKey
      || contract.continuity?.preferredChildSessionKey
      || visibleIds.childSessionKey,
    ),
    spawnIntentId: stringValue(nativeRefs.spawnIntentId || visibleIds.spawnIntentId),
  };
}

function nativeAnnounceDeliveryAlreadySent(contract: WorkContract): boolean {
  const deliveryStatus = stringValue(contract.telemetry?.deliveryStatus).toLowerCase();
  return ["delivered", "sent"].includes(deliveryStatus);
}

function nativeAnnounceDirectDeliveryEnabled(pluginConfig: UnknownRecord | undefined): boolean {
  const raw = stringValue(process.env.OCTOCLAW_NATIVE_ANNOUNCE_DIRECT_DELIVERY || pluginConfig?.nativeAnnounceDirectDelivery).toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

export function nativeAnnounceSendOverride(pluginConfig: UnknownRecord | undefined): NativeAnnounceSendMessage | undefined {
  const candidate = pluginConfig?.nativeAnnounceSendMessageForTests;
  return typeof candidate === "function" ? candidate as NativeAnnounceSendMessage : undefined;
}

function slackThreadFromSessionKey(sessionKey: string): string {
  return regexGroup(sessionKey, /:thread:(\d{10}\.\d{6})(?::|$)/u);
}

function resolveNativeAnnounceDeliverySessionKey(contract: WorkContract, ctx: UnknownRecord): string {
  const nativeRefs = asRecord(contract.nativeSpawnRefs);
  return stringValue(contract.sessionKey)
    || stringValue(nativeRefs.requesterSessionKey)
    || stringValue(ctx.sessionKey)
    || stringValue(ctx.canonicalSessionKey);
}

function resolveNativeAnnounceReplyToMessageId(contract: WorkContract, ctx: UnknownRecord, state: UnknownRecord): string {
  const contractRecord = contract as unknown as UnknownRecord;
  const deliveryTarget = asRecord(contractRecord.deliveryTarget || contractRecord.delivery_target || state.deliveryTarget || state.delivery_target);
  const sessionKey = resolveNativeAnnounceDeliverySessionKey(contract, ctx);
  return stringValue(
    deliveryTarget.replyToMessageId
    || deliveryTarget.reply_to_message_id
    || deliveryTarget.threadTs
    || deliveryTarget.thread_ts,
  )
    || slackThreadFromSessionKey(sessionKey)
    || stringValue(state.replyToMessageId || state.reply_to_id || state.inboundMessageTs || state.message_id)
    || stringValue(ctx.replyToMessageId || ctx.reply_to_id || ctx.inboundMessageTs || ctx.message_id || ctx.threadTs || ctx.thread_ts);
}

function buildNativeAnnounceFinalMessage(input: {
  contract: WorkContract;
  completion: NativeAnnounceCompletion;
  state: UnknownRecord;
  event: UnknownRecord;
  ctx: UnknownRecord;
  sessionKey: string;
  replyToMessageId: string;
}): string {
  const decision = asRecord(input.state.decision);
  const routeDecision = asRecord(decision.route_decision);
  const content = input.completion.resultText.trim();
  if (!content) return "";
  return renderIMProjectionFooter({
    content,
    projection: {
      route: "delegate",
      model: resolveNativeAnnounceDisplayModel(input.contract, input.state, input.event, input.ctx),
      via: "native_announce",
      thread: Boolean(input.replyToMessageId || slackThreadFromSessionKey(input.sessionKey)),
      ...(footerDebugEnabled() ? {
        workerPool: stringValue(routeDecision.worker_pool) || "octoclaw-research",
        workContractId: input.contract.workContractId,
      } : {}),
    },
    sessionKey: input.sessionKey,
    channel: resolveProjectionChannel(input.event, input.ctx),
  });
}

function nativeAnnounceDeliveryProvenance(contract: WorkContract, completion: NativeAnnounceCompletion, model?: string): {
  route: "delegate";
  model?: string;
  via: "native_announce";
  workContractId: string;
  runId?: string;
  childSessionKey?: string;
} {
  const ids = contractNativeIds(contract);
  const childSessionKey = ids.childSessionKey || completion.sourceSessionKey;
  return {
    route: "delegate",
    ...(model ? { model } : {}),
    via: "native_announce",
    workContractId: contract.workContractId,
    ...(ids.runId ? { runId: ids.runId } : {}),
    ...(childSessionKey ? { childSessionKey } : {}),
  };
}

export async function deliverNativeAnnounceCompletion(input: {
  contract: WorkContract;
  completion: NativeAnnounceCompletion;
  state?: UnknownRecord;
  event?: UnknownRecord;
  ctx?: UnknownRecord;
  cwd?: string;
  sendMessage?: NativeAnnounceSendMessage;
}): Promise<SendIMResult & { sessionKey: string; replyToMessageId: string }> {
  const ctx = asRecord(input.ctx);
  const event = asRecord(input.event);
  const state = asRecord(input.state);
  const sessionKey = resolveNativeAnnounceDeliverySessionKey(input.contract, ctx);
  const replyToMessageId = resolveNativeAnnounceReplyToMessageId(input.contract, ctx, state);
  if (!sessionKey) {
    return { sent: false, error: "native_announce_missing_delivery_session", sessionKey, replyToMessageId };
  }
  const message = buildNativeAnnounceFinalMessage({
    contract: input.contract,
    completion: input.completion,
    state,
    event,
    ctx,
    sessionKey,
    replyToMessageId,
  });
  if (!message) {
    return { sent: false, error: "native_announce_empty_result", sessionKey, replyToMessageId };
  }
  const content = input.completion.resultText.trim();
  const sendMessage = input.sendMessage ?? ((params) => sendIMMessage({
    ...params,
    timeoutMs: 8000,
    suppressProjectionFooter: false,
    deliveryKind: "native_child_final",
    deliveryTargetSource: params.replyToMessageId ? "inbound_anchor" : "session_fallback",
    deliveryProvenance: nativeAnnounceDeliveryProvenance(
      input.contract,
      input.completion,
      resolveNativeAnnounceDisplayModel(input.contract, state, event, ctx),
    ),
    footerMode: footerDebugEnabled() ? "debug" : "off",
  }));
  const result = await sendMessage({
    sessionKey,
    message: input.sendMessage ? message : content,
    replyToMessageId: replyToMessageId || undefined,
    cwd: input.cwd || resolveWorkspaceRoot(),
  });
  return {
    ...result,
    sessionKey,
    replyToMessageId,
  };
}

function markNativeAnnounceCompletionOnContract(
  workContractId: string,
  completion: NativeAnnounceCompletion,
  delivered: boolean,
  nowIso: string,
  blocker?: NativeAnnounceBlocker | null,
  delivery?: Partial<SendIMResult> & { sessionKey?: string; replyToMessageId?: string },
): WorkContract | null {
  return updateWorkContract(workContractId, (contract) => {
    const ids = contractNativeIds(contract);
    const childSessionKey = ids.childSessionKey || completion.sourceSessionKey;
    const isBlocked = blocker?.blocked === true;
    const previousDelegate = contract.delegate;
    const nextDelegate = previousDelegate
      ? {
          ...previousDelegate,
          nativeBinding: previousDelegate.nativeBinding
            ? {
                ...previousDelegate.nativeBinding,
                childSessionKey,
                status: isBlocked ? "blocked" as const : "succeeded" as const,
                currentStep: isBlocked ? "blocked" : "completed",
              }
            : previousDelegate.nativeBinding,
          nextAction: isBlocked ? "ask_user" as const : "deliver" as const,
          ...(isBlocked ? { blocker: blocker.reason } : {}),
        }
      : previousDelegate;
    const deliveryStatus = isBlocked ? "blocked" : delivered ? "delivered" : (
      nativeAnnounceDeliveryAlreadySent(contract) ? "delivered" : "pending"
    );
    const telemetryRecord = asRecord(contract.telemetry);
    const telemetry = {
      ...contract.telemetry,
      dispatchExecuted: true,
      spawnExecuted: true,
      resultMaterialized: true,
      deliveryStatus,
      nativeAnnounceResultHash: completion.resultHash,
      nativeAnnounceDeliveredAt: delivered ? nowIso : telemetryRecord.nativeAnnounceDeliveredAt,
      nativeAnnounceBlockedHash: isBlocked ? completion.resultHash : telemetryRecord.nativeAnnounceBlockedHash,
      deliveryMessageId: stringValue(delivery?.messageId) || stringValue(telemetryRecord.deliveryMessageId),
      deliverySessionKey: stringValue(delivery?.sessionKey) || stringValue(telemetryRecord.deliverySessionKey),
      deliveryReplyToMessageId: stringValue(delivery?.replyToMessageId) || stringValue(telemetryRecord.deliveryReplyToMessageId),
      deliveryTransport: stringValue(delivery?.transport) || stringValue(telemetryRecord.deliveryTransport),
      deliveryTargetSource: stringValue(delivery?.targetSource) || stringValue(telemetryRecord.deliveryTargetSource),
      deliveryFooterSource: stringValue(delivery?.footerSource) || stringValue(telemetryRecord.deliveryFooterSource),
      childSessionKey: childSessionKey || contract.telemetry.childSessionKey,
      childRunId: ids.childRunId || contract.telemetry.childRunId,
    } as WorkContract["telemetry"];
    return {
      ...contract,
      status: isBlocked ? "blocked" as const : "completed" as const,
      ...(nextDelegate ? { delegate: nextDelegate } : {}),
      continuity: {
        ...contract.continuity,
        preferredChildSessionKey: childSessionKey || contract.continuity.preferredChildSessionKey,
        preferredRunId: ids.runId || contract.continuity.preferredRunId,
      },
      telemetry,
      mainContext: {
        ...contract.mainContext,
        statusLine: isBlocked
          ? `Child result blocked: ${blocker.reason}`
          : delivered ? "Child result delivered." : "Child result ready for delivery.",
        nextAction: isBlocked ? "ask_user" : "deliver",
        visibleIds: {
          ...contract.mainContext.visibleIds,
          childSessionKey: childSessionKey || contract.mainContext.visibleIds.childSessionKey,
          openclawRunId: ids.runId || contract.mainContext.visibleIds.openclawRunId,
          spawnIntentId: ids.spawnIntentId || contract.mainContext.visibleIds.spawnIntentId,
        },
      },
      updatedAt: nowIso,
    };
  });
}

function buildNativeAnnouncePolicyState(input: {
  current: PolicyStateEntry;
  stateKey: string;
  contract: WorkContract;
  completion: NativeAnnounceCompletion;
  delivered: boolean;
  now: number;
  blocker?: NativeAnnounceBlocker | null;
}): PolicyStateEntry {
  const ids = contractNativeIds(input.contract);
  const decision = asRecord(input.current.decision);
  const hookInterface = asRecord(decision.hook_interface);
  const beforeToolCall = asRecord(hookInterface.before_tool_call);
  const routeDecision = asRecord(decision.route_decision);
  const modelPolicy = asRecord(decision.model_policy);
  const runtimeTruth = asRecord(decision.runtime_truth);
  const runtimeBinding = asRecord(runtimeTruth.binding);
  const runtimeEvidence = asRecord(runtimeTruth.evidence);
  const workContractProjection = asRecord(decision.work_contract);
  const childSessionKey = ids.childSessionKey || input.completion.sourceSessionKey;
  const runId = ids.runId || ids.childRunId;
  const isBlocked = input.blocker?.blocked === true;
  const nativeModel = nativeSpawnIntentDisplayModel(input.contract);
  return {
    ...input.current,
    canonicalSessionKey: input.stateKey,
    prompt: input.current.prompt || input.contract.userAsk,
    decision: {
      ...decision,
      route_decision: {
        ...routeDecision,
        route: "delegate",
        route_source: isBlocked ? "native_announce_blocker" : "native_announce",
        task_class: isBlocked
          ? "delegated_completion_blocked"
          : stringValue(routeDecision.task_class) || "delegated_completion_delivery",
      },
      model_policy: nativeModel
        ? {
            ...modelPolicy,
            selected_model: nativeModel,
            model: nativeModel,
          }
        : modelPolicy,
      work_contract: {
        ...workContractProjection,
        workContractId: input.contract.workContractId,
        work_contract_id: input.contract.workContractId,
        route: "delegate",
        status: isBlocked ? "blocked" : stringValue(workContractProjection.status || "completed"),
        childSessionKey,
        openclawRunId: runId,
        spawnIntentId: ids.spawnIntentId,
        ...(isBlocked ? { blocker: input.blocker?.reason } : {}),
      },
      runtime_truth: {
        ...runtimeTruth,
        binding: {
          ...runtimeBinding,
          runId,
          childRunId: ids.childRunId || runId,
          childSessionKey,
        },
        evidence: {
          ...runtimeEvidence,
          resultMaterialized: true,
          result_materialized: true,
          childSessionKey,
          runId,
        },
      },
      delivery: {
        ...asRecord(decision.delivery),
        status: isBlocked ? "blocked" : input.delivered ? "delivered" : "pending",
        resultMaterialized: true,
        result_materialized: true,
        ...(isBlocked ? { blocker: input.blocker?.reason } : {}),
      },
      hook_interface: {
        ...hookInterface,
        before_tool_call: {
          ...beforeToolCall,
          enabled: true,
        },
      },
    },
    delegated: true,
    dispatchRoute: "delegate",
    dispatchStatus: isBlocked ? "blocked" : input.delivered ? "result_delivered" : "result_ready",
    dispatchExecuted: true,
    dispatch_executed: true,
    spawnExecuted: true,
    spawn_executed: true,
    resultMaterialized: true,
    result_materialized: true,
    workContractId: input.contract.workContractId,
    work_contract_id: input.contract.workContractId,
    spawnIntentId: ids.spawnIntentId,
    spawn_intent_id: ids.spawnIntentId,
    runId,
    run_id: runId,
    childRunId: ids.childRunId || runId,
    child_run_id: ids.childRunId || runId,
    childSessionKey,
    child_session_key: childSessionKey,
    ...(isBlocked ? {
      nativeAnnounceBlocked: true,
      native_announce_blocked: true,
      nativeAnnounceBlocker: input.blocker?.reason,
      native_announce_blocker: input.blocker?.reason,
      nativeAnnounceBlockedHash: input.completion.resultHash,
      native_announce_blocked_hash: input.completion.resultHash,
      nativeAnnounceCompletionPending: false,
      native_announce_completion_pending: false,
      nativeAnnounceDelivered: false,
      native_announce_delivered: false,
    } : {
      nativeAnnounceCompletionPending: !input.delivered,
      native_announce_completion_pending: !input.delivered,
      nativeAnnounceDelivered: input.delivered,
      native_announce_delivered: input.delivered,
      nativeAnnounceResultHash: input.completion.resultHash,
      native_announce_result_hash: input.completion.resultHash,
    }),
    ...(input.delivered ? {
      nativeAnnounceDeliveredAt: input.now,
      native_announce_delivered_at: new Date(input.now).toISOString(),
    } : {}),
    deliveryStatus: isBlocked ? "blocked" : input.delivered ? "delivered" : "pending",
    delivery_status: isBlocked ? "blocked" : input.delivered ? "delivered" : "pending",
    formal_reply_visible: input.delivered || input.current.formal_reply_visible,
    updatedAt: input.now,
  } as PolicyStateEntry;
}

export function isNativeAnnounceDeliveryState(state: unknown): boolean {
  const record = asRecord(state);
  const dispatchStatus = stringValue(record.dispatchStatus || record.dispatch_status);
  return record.nativeAnnounceCompletionPending === true
    || record.native_announce_completion_pending === true
    || record.nativeAnnounceDelivered === true
    || record.native_announce_delivered === true
    || dispatchStatus === "result_ready"
    || dispatchStatus === "result_delivered"
    || Boolean(stringValue(record.nativeAnnounceResultHash || record.native_announce_result_hash));
}

export function isNativeAnnounceBlockedState(state: unknown): boolean {
  const record = asRecord(state);
  return record.nativeAnnounceBlocked === true || record.native_announce_blocked === true;
}

function isNativeAnnounceAlreadyDelivered(state: unknown): boolean {
  const record = asRecord(state);
  if (!isNativeAnnounceDeliveryState(record)) return false;
  return record.nativeAnnounceDelivered === true
    || record.native_announce_delivered === true
    || stringValue(record.deliveryStatus || record.delivery_status).toLowerCase() === "delivered";
}

function nativeAnnounceDeliveredAtMs(state: UnknownRecord): number {
  const raw = state.nativeAnnounceDeliveredAt
    ?? state.native_announce_delivered_at
    ?? state.updatedAt
    ?? state.updated_at;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const parsed = Date.parse(stringValue(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldCancelNativeAnnounceDeliveredOutbound(match: { anchored: boolean; state: PolicyStateEntry }, state: UnknownRecord, now: number): boolean {
  if (!isNativeAnnounceAlreadyDelivered(state)) return false;
  if (match.anchored) return true;
  const deliveredAt = nativeAnnounceDeliveredAtMs(state);
  return deliveredAt > 0 && now - deliveredAt <= 60 * 1000;
}

function applyNativeAnnounceCompletionState(input: {
  ctx: UnknownRecord;
  stateKey: string;
  contract: WorkContract;
  completion: NativeAnnounceCompletion;
  delivered: boolean;
  now: number;
  blocker?: NativeAnnounceBlocker | null;
}): void {
  const aliasKeys = Array.from(new Set([
    input.stateKey,
    input.contract.sessionKey,
    stringValue(ctxValue(input.ctx, "sessionKey")),
    stringValue(ctxValue(input.ctx, "canonicalSessionKey")),
    stringValue(ctxValue(input.ctx, "sessionId")),
  ].filter(Boolean)));
  for (const aliasKey of aliasKeys) {
    updatePolicyState(aliasKey, (current) => buildNativeAnnouncePolicyState({
      current,
      stateKey: input.contract.sessionKey || input.stateKey || aliasKey,
      contract: input.contract,
      completion: input.completion,
      delivered: input.delivered,
      now: input.now,
      blocker: input.blocker,
    }));
  }
}

function ctxValue(ctx: UnknownRecord, key: string): unknown {
  return ctx[key];
}

function nativeAnnouncePromptProjection(input: {
  contract: WorkContract;
  completion: NativeAnnounceCompletion;
  delivered: boolean;
  blocker?: NativeAnnounceBlocker | null;
}): { prependSystemContext?: string; prependContext?: string } {
  const ids = contractNativeIds(input.contract);
  if (input.delivered) {
    return buildPromptContextProjection({
      prependSystem: [[
        "[OctoClaw native child completion]",
        `workContractId=${input.contract.workContractId}`,
        `childSessionKey=${ids.childSessionKey || input.completion.sourceSessionKey}`,
        "This native subagent_announce result was already delivered to the user.",
        "Reply exactly NO_REPLY. Do not send another final message and do not call tools.",
      ].join("\n")],
      contextPayload: "",
      shouldInjectPolicyProjection: false,
    }) ?? {};
  }
  if (input.blocker?.blocked === true) {
    return buildPromptContextProjection({
      prependSystem: [[
        "[OctoClaw native child completion]",
        `workContractId=${input.contract.workContractId}`,
        `childSessionKey=${ids.childSessionKey || input.completion.sourceSessionKey}`,
        ids.runId ? `runId=${ids.runId}` : "",
        `blocker=${input.blocker.reason}`,
        "OpenClaw native subagent_announce matched an existing accepted sessions_spawn WorkContract, but the child returned a blocker instead of a final result.",
        "Treat this as a recoverable missing-context handoff, not as a failed dispatch and not as a new user request.",
        "If the missing information is already available in the current conversation or runtime metadata, call octoclaw_dispatch once with a clarified task and explicit context_refs/writeScope when needed.",
        "If the missing information is not available, ask the user one concise question.",
        "Do not call sessions_spawn directly. Do not say the task was not dispatched or still pending.",
      ].filter(Boolean).join("\n")],
      contextPayload: "",
      shouldInjectPolicyProjection: false,
    }) ?? {};
  }
  return buildPromptContextProjection({
    prependSystem: [[
      "[OctoClaw native child completion]",
      `workContractId=${input.contract.workContractId}`,
      `childSessionKey=${ids.childSessionKey || input.completion.sourceSessionKey}`,
      ids.runId ? `runId=${ids.runId}` : "",
      "OpenClaw native subagent_announce matched an existing accepted sessions_spawn WorkContract.",
      "Treat this as completion for the existing delegated task, not as a new user request.",
      "Do not call octoclaw_dispatch, octoclaw_spawn, sessions_spawn, or octoclaw_dispatch_confirm.",
      "Deliver exactly one user-facing final answer from the child result already present in the prompt.",
      "Keep internal OpenClaw/session/provenance details private. Do not say the task was not dispatched or still pending.",
    ].filter(Boolean).join("\n")],
    contextPayload: "",
    shouldInjectPolicyProjection: false,
  }) ?? {};
}

function unmatchedNativeAnnounceProjection(): { prependSystemContext?: string; prependContext?: string } {
  return buildPromptContextProjection({
    prependSystem: [[
      "[OctoClaw native child completion]",
      "This subagent_announce did not match any accepted WorkContract for this runtime.",
      "Reply exactly NO_REPLY. Do not dispatch, spawn, or deliver unmatched inter-session data.",
    ].join("\n")],
    contextPayload: "",
    shouldInjectPolicyProjection: false,
  }) ?? {};
}

export async function handleNativeAnnounceCompletion(input: {
  event: UnknownRecord;
  ctx: UnknownRecord;
  prompt: string;
  pluginConfig?: UnknownRecord;
  logger?: unknown;
  cwd?: string;
  sendMessage?: NativeAnnounceSendMessage;
}): Promise<{
  completion: NativeAnnounceCompletion;
  matched: boolean;
  delivered: boolean;
  workContractId?: string;
  projection: { prependSystemContext?: string; prependContext?: string };
} | null> {
  const nativeAnnounceCompletion = extractNativeAnnounceCompletion(input.event, input.prompt);
  if (!nativeAnnounceCompletion) return null;

  const preStateKey = resolvePolicyStateKey(input.ctx);
  const matchedContract = findWorkContractByNativeChildSessionKey(nativeAnnounceCompletion.sourceSessionKey);
  if (!matchedContract) {
    void recordPolicyReplay(
      "native_announce_completion_unmatched",
      {
        sessionKey: preStateKey,
        sessionId: stringValue(input.ctx.sessionId),
        sourceSessionKey: nativeAnnounceCompletion.sourceSessionKey,
        sourceTool: nativeAnnounceCompletion.sourceTool,
      },
      input.logger,
      null,
    ).catch(() => {});
    return {
      completion: nativeAnnounceCompletion,
      matched: false,
      delivered: false,
      projection: unmatchedNativeAnnounceProjection(),
    };
  }

  const directDeliveryEnabled = nativeAnnounceDirectDeliveryEnabled(input.pluginConfig);
  const alreadyDelivered = nativeAnnounceDeliveryAlreadySent(matchedContract);
  const blocker = extractNativeAnnounceBlocker(nativeAnnounceCompletion);
  const currentState = asRecord(getPolicyStateForContext(input.ctx).state);
  const directDelivery: SendIMResult & { sessionKey: string; replyToMessageId: string } = !blocker && !alreadyDelivered && directDeliveryEnabled
    ? await deliverNativeAnnounceCompletion({
        contract: matchedContract,
        completion: nativeAnnounceCompletion,
        state: currentState,
        event: input.event,
        ctx: input.ctx,
        cwd: input.cwd || stringValue(input.ctx.cwd) || process.cwd(),
        sendMessage: input.sendMessage,
      })
    : {
        sent: false,
        error: blocker ? "child_blocked" : alreadyDelivered ? "already_delivered" : "direct_delivery_disabled",
        sessionKey: "",
        replyToMessageId: "",
      };
  const delivered = alreadyDelivered || directDelivery.sent;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const updatedContract = markNativeAnnounceCompletionOnContract(
    matchedContract.workContractId,
    nativeAnnounceCompletion,
    delivered,
    nowIso,
    blocker,
    directDelivery,
  ) ?? matchedContract;
  applyNativeAnnounceCompletionState({
    ctx: input.ctx,
    stateKey: preStateKey,
    contract: updatedContract,
    completion: nativeAnnounceCompletion,
    delivered,
    now,
    blocker,
  });
  void recordPolicyReplay(
    alreadyDelivered ? "native_announce_completion_duplicate" : "native_announce_completion_matched",
    {
      sessionKey: updatedContract.sessionKey || preStateKey,
      sessionId: stringValue(input.ctx.sessionId),
      workContractId: updatedContract.workContractId,
      sourceSessionKey: nativeAnnounceCompletion.sourceSessionKey,
      resultHash: nativeAnnounceCompletion.resultHash,
      blocked: Boolean(blocker),
      blocker: blocker?.reason || "",
      delivered,
      directDeliveryAttempted: !blocker && !alreadyDelivered && directDeliveryEnabled,
      directDeliverySent: directDelivery.sent,
      directDeliveryError: directDelivery.error || "",
      delivery_transport: directDelivery.transport || "",
      deliveryTransport: directDelivery.transport || "",
      target_source: directDelivery.targetSource || "",
      targetSource: directDelivery.targetSource || "",
      footer_source: directDelivery.footerSource || "",
      footerSource: directDelivery.footerSource || "",
      deliverySessionKey: directDelivery.sessionKey || updatedContract.sessionKey || preStateKey,
      replyToMessageId: directDelivery.replyToMessageId || "",
    },
    input.logger,
    null,
  ).catch(() => {});
  if (!alreadyDelivered && directDelivery.sent) {
    void recordPolicyReplay(
      "native_announce_final_delivered",
      {
        sessionKey: updatedContract.sessionKey || preStateKey,
        sessionId: stringValue(input.ctx.sessionId),
        workContractId: updatedContract.workContractId,
        resultHash: nativeAnnounceCompletion.resultHash,
        deliverySessionKey: directDelivery.sessionKey,
        replyToMessageId: directDelivery.replyToMessageId,
        messageId: directDelivery.messageId || "",
        delivery_transport: directDelivery.transport || "",
        deliveryTransport: directDelivery.transport || "",
        target_source: directDelivery.targetSource || "",
        targetSource: directDelivery.targetSource || "",
        footer_source: directDelivery.footerSource || "",
        footerSource: directDelivery.footerSource || "",
      },
      input.logger,
      null,
    ).catch(() => {});
  }

  return {
    completion: nativeAnnounceCompletion,
    matched: true,
    delivered,
    workContractId: updatedContract.workContractId,
    projection: nativeAnnouncePromptProjection({
      contract: updatedContract,
      completion: nativeAnnounceCompletion,
      delivered,
      blocker,
    }),
  };
}

async function handleNativeSubagentEndedCompletion(input: {
  event: UnknownRecord;
  ctx: UnknownRecord;
  pluginConfig?: UnknownRecord;
  logger?: unknown;
  cwd?: string;
  sendMessage?: NativeAnnounceSendMessage;
}): Promise<void> {
  const childSessionKey = stringValue(input.event.targetSessionKey || input.ctx.childSessionKey);
  const runId = stringValue(input.event.runId || input.ctx.runId);
  if (!childSessionKey) return;
  const matchedContract = findWorkContractByNativeChildSessionKey(childSessionKey);
  if (!matchedContract) return;
  if (nativeAnnounceDeliveryAlreadySent(matchedContract)) {
    void recordPolicyReplay(
      "native_announce_subagent_ended_duplicate",
      {
        sessionKey: matchedContract.sessionKey || stringValue(input.ctx.requesterSessionKey),
        workContractId: matchedContract.workContractId,
        sourceSessionKey: childSessionKey,
        runId,
      },
      input.logger,
      null,
    ).catch(() => {});
    return;
  }
  const completion = readNativeChildSessionCompletion(childSessionKey, runId);
  if (!completion) {
    void recordPolicyReplay(
      "native_announce_subagent_ended_no_result",
      {
        sessionKey: matchedContract.sessionKey || stringValue(input.ctx.requesterSessionKey),
        workContractId: matchedContract.workContractId,
        sourceSessionKey: childSessionKey,
        runId,
        reason: "child_session_result_unavailable",
      },
      input.logger,
      null,
    ).catch(() => {});
    return;
  }
  const stateCtx: UnknownRecord = {
    ...input.ctx,
    sessionKey: matchedContract.sessionKey || stringValue(input.ctx.requesterSessionKey || input.ctx.sessionKey),
  };
  const stateKey = resolvePolicyStateKey(stateCtx);
  const currentState = asRecord(getPolicyStateForContext(stateCtx).state);
  const directDeliveryEnabled = nativeAnnounceDirectDeliveryEnabled(input.pluginConfig);
  const directDelivery: SendIMResult & { sessionKey: string; replyToMessageId: string } = directDeliveryEnabled
    ? await deliverNativeAnnounceCompletion({
        contract: matchedContract,
        completion,
        state: currentState,
        event: input.event,
        ctx: stateCtx,
        cwd: input.cwd || stringValue(stateCtx.cwd) || process.cwd(),
        sendMessage: input.sendMessage,
      })
    : { sent: false, error: "direct_delivery_disabled", sessionKey: "", replyToMessageId: "" };
  const delivered = directDelivery.sent;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const updatedContract = markNativeAnnounceCompletionOnContract(
    matchedContract.workContractId,
    completion,
    delivered,
    nowIso,
    null,
    directDelivery,
  ) ?? matchedContract;
  applyNativeAnnounceCompletionState({
    ctx: stateCtx,
    stateKey,
    contract: updatedContract,
    completion,
    delivered,
    now,
  });
  void recordPolicyReplay(
    "native_announce_completion_matched",
    {
      sessionKey: updatedContract.sessionKey || stateKey,
      sessionId: stringValue(stateCtx.sessionId),
      workContractId: updatedContract.workContractId,
      sourceSessionKey: completion.sourceSessionKey,
      sourceTool: completion.sourceTool,
      resultHash: completion.resultHash,
      delivered,
      directDeliveryAttempted: directDeliveryEnabled,
      directDeliverySent: directDelivery.sent,
      directDeliveryError: directDelivery.error || "",
      delivery_transport: directDelivery.transport || "",
      deliveryTransport: directDelivery.transport || "",
      target_source: directDelivery.targetSource || "",
      targetSource: directDelivery.targetSource || "",
      footer_source: directDelivery.footerSource || "",
      footerSource: directDelivery.footerSource || "",
      deliverySessionKey: directDelivery.sessionKey || updatedContract.sessionKey || stateKey,
      replyToMessageId: directDelivery.replyToMessageId || "",
      hookName: "subagent_ended",
      runId,
    },
    input.logger,
    null,
  ).catch(() => {});
  if (directDelivery.sent) {
    void recordPolicyReplay(
      "native_announce_final_delivered",
      {
        sessionKey: updatedContract.sessionKey || stateKey,
        sessionId: stringValue(stateCtx.sessionId),
        workContractId: updatedContract.workContractId,
        resultHash: completion.resultHash,
        deliverySessionKey: directDelivery.sessionKey,
        replyToMessageId: directDelivery.replyToMessageId,
        messageId: directDelivery.messageId || "",
        delivery_transport: directDelivery.transport || "",
        deliveryTransport: directDelivery.transport || "",
        target_source: directDelivery.targetSource || "",
        targetSource: directDelivery.targetSource || "",
        footer_source: directDelivery.footerSource || "",
        footerSource: directDelivery.footerSource || "",
        hookName: "subagent_ended",
        runId,
      },
      input.logger,
      null,
    ).catch(() => {});
  }
}


function projectionFooterMode(): "off" | "compact" | "debug" {
  const mode = stringValue(process.env.OCTOCLAW_PROJECTION_FOOTER_MODE).toLowerCase();
  if (mode === "debug") return "debug";
  if (mode === "compact" || mode === "on" || mode === "1" || mode === "true" || mode === "yes") return "compact";
  const legacyDebug = stringValue(process.env.OCTOCLAW_FOOTER_DEBUG).toLowerCase();
  if (legacyDebug && !["0", "false", "off", "no"].includes(legacyDebug)) return "debug";
  const legacy = stringValue(process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER).toLowerCase();
  if (["1", "true", "on", "yes", "compact"].includes(legacy)) return "compact";
  if (legacy === "debug") return "debug";
  return "off";
}

function replyProjectionFooterEnabled(): boolean {
  return projectionFooterMode() !== "off";
}

function footerDebugEnabled(): boolean {
  return projectionFooterMode() === "debug" || Boolean(process.env.OCTOCLAW_FOOTER_DEBUG && !["0", "false", "off"].includes(
    stringValue(process.env.OCTOCLAW_FOOTER_DEBUG).toLowerCase()
  ));
}


function outboundProjectionSnapshot(state: UnknownRecord): UnknownRecord {
  return asRecord(state.outboundProjection || state.outbound_projection);
}

/** Resolve a model profile (e.g. "direct_main") or raw model string to a short display name. */
function resolveDisplayModel(state: UnknownRecord, event: UnknownRecord, ctx: UnknownRecord): string {
  const snapshot = outboundProjectionSnapshot(state);
  const decision = asRecord(state.decision);
  const modelPolicy = asRecord(decision.model_policy);
  const runtimeTruth = asRecord(decision.runtime_truth);
  const workContract = asRecord(decision.work_contract);
  const delegate = asRecord(workContract.delegate);

  // Priority: spawn intent model > WorkContract delegate model > policy model > fallback
  const spawnModel = displayModelOrEmpty(
    delegate.modelProfile,
    delegate.model,
    delegate.model_profile,
  );

  return firstDisplayModel(
    spawnModel || undefined,
    snapshot.model,
    snapshot.modelId,
    snapshot.model_id,
    modelPolicy.selected_model,
    modelPolicy.model,
    runtimeTruth.model,
    decision.model,
    event.model,
    event.modelId,
    event.model_id,
    ctx.model,
    ctx.modelId,
    ctx.model_id,
    state.modelProfile,
    state.model_profile,
    "direct_main",
  );
}

function displayModelOrEmpty(...values: unknown[]): string {
  const model = firstDisplayModel(...values);
  return model === "unknown" ? "" : model;
}

function nativeSpawnIntentDisplayModel(contract: WorkContract): string {
  const spawnIntentId = contractNativeIds(contract).spawnIntentId;
  if (!spawnIntentId) return "";
  try {
    const intent = nativeSpawnIntentStore.get(spawnIntentId);
    const args = asRecord(intent?.sessionsSpawnArgs);
    return displayModelOrEmpty(args.model, args.modelId, args.model_id);
  } catch {
    return "";
  }
}

function resolveNativeAnnounceDisplayModel(
  contract: WorkContract,
  state: UnknownRecord,
  event: UnknownRecord,
  ctx: UnknownRecord,
): string {
  return displayModelOrEmpty(
    nativeSpawnIntentDisplayModel(contract),
    asRecord(contract.delegate).model,
    asRecord(contract.delegate).modelProfile,
    asRecord(contract.delegate).model_profile,
  ) || resolveDisplayModel(state, event, ctx);
}

/** Extract route source label for footer: "judge(0.87)" / "rule" / "fallback" / "agent↑judge=delegate" */
function resolveRouteSource(state: UnknownRecord): string {
  const snapshot = outboundProjectionSnapshot(state);
  const decision = asRecord(state.decision);
  const routeDecision = asRecord(decision.route_decision);
  const routeHintPolicy = asRecord(decision.route_hint_policy);
  const routeSeal = asRecord(decision.routeSeal || state.routeSeal);
  const routeSealSource = stringValue(routeSeal.source);
  if (routeSealSource === "accepted_objection" || Boolean(routeHintPolicy.objection_accepted)) {
    return "accepted_objection";
  }
  const source = stringValue(routeDecision.route_source || routeDecision.final_judge_source || snapshot.via || snapshot.source);
  const confidence = asRecord(decision).judge_confidence ?? routeDecision.route_confidence;
  const finalRoute = stringValue(routeDecision.route);
  const judgeRoute = stringValue(routeHintPolicy.judge_route || decision._judge_route);

  // Judge said one thing, final route is different → agent override
  if (judgeRoute && finalRoute && judgeRoute !== finalRoute) {
    const objectionAccepted = Boolean(routeHintPolicy.objection_accepted);
    const objectionEscalated = Boolean(routeHintPolicy.objection_escalated);
    if (objectionAccepted) {
      return `agent↑(judge=${judgeRoute})`;
    }
    if (objectionEscalated) {
      // Remote judge adjudicated — kept original
      return `judge(escalated)`;
    }
    return `agent↑(judge=${judgeRoute})`;
  }

  if (source === "judge" || source === "local") {
    const conf = typeof confidence === "number" ? `(${confidence.toFixed(2)})` : "";
    return `judge${conf}`;
  }
  if (source === "fallback" || source === "timeout_fallback") return "fallback";
  if (source === "rule" || source === "policy_rule") return "rule";
  if (source === "main_agent_route_hint") return "hint";
  if (source === "execution_coverage") return "coverage";
  if (source === "continuation") return "continue";
  if (source === "native_announce") return "native_announce";
  if (source === "subagent" || source === "subagent_announce") return "subagent";
  return source || "policy";
}

function internalAckProjectionSuppressed(): boolean {
  const raw = stringValue(process.env.OCTOCLAW_INTERNAL_ACK_SEND).toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}

export function buildImmutableDeliveryTarget(sessionKey: string, replyToMessageId: string): UnknownRecord {
  const normalizedSessionKey = stringValue(sessionKey);
  const normalizedReplyTo = stringValue(replyToMessageId);
  const isSlack = normalizedSessionKey.toLowerCase().includes(":slack:") || normalizedSessionKey.toLowerCase().startsWith("slack:");
  return {
    surface: isSlack ? "slack" : "unknown",
    sessionKey: normalizedSessionKey,
    session_key: normalizedSessionKey,
    replyToMessageId: normalizedReplyTo || undefined,
    reply_to_message_id: normalizedReplyTo || undefined,
    threadTs: normalizedReplyTo || undefined,
    thread_ts: normalizedReplyTo || undefined,
    mode: normalizedReplyTo ? "thread" : "root",
    immutable: true,
  };
}

export function deliveryTargetReplyTo(state: UnknownRecord | null | undefined): string {
  const target = asRecord(state?.deliveryTarget || state?.delivery_target);
  return stringValue(target.replyToMessageId || target.reply_to_message_id || target.threadTs || target.thread_ts);
}

function cancelNeutralAckTimersForContext(event: UnknownRecord, ctx: UnknownRecord, state: UnknownRecord | null | undefined): CanceledNeutralAckTimer[] {
  const stateRecord = asRecord(state);
  const sessionKeys = [
    stringValue(stateRecord.ackGuardKey || stateRecord.ack_guard_key),
    stringValue(stateRecord.canonicalSessionKey || stateRecord.canonical_session_key),
    stringValue(stateRecord.sessionKey || stateRecord.session_key),
    stringValue(ctx.sessionKey || ctx.session_key),
    stringValue(ctx.canonicalSessionKey || ctx.canonical_session_key),
    stringValue(event.sessionKey || event.session_key),
  ];
  const replyToMessageIds = [
    deliveryTargetReplyTo(stateRecord),
    stringValue(stateRecord.inboundMessageTs || stateRecord.message_id || stateRecord.messageId || stateRecord.replyToMessageId || stateRecord.reply_to_id),
    stringValue(ctx.inboundMessageTs || ctx.message_id || ctx.messageId || ctx.replyToMessageId || ctx.reply_to_id || ctx.threadTs || ctx.thread_ts),
    stringValue(event.inboundMessageTs || event.message_id || event.messageId || event.replyToMessageId || event.reply_to_id || event.threadTs || event.thread_ts),
  ];
  return cancelNeutralAckTimersByCandidates(sessionKeys, replyToMessageIds);
}

function hasThreadProjection(event: UnknownRecord, ctx: UnknownRecord): boolean {
  const metadata = asRecord(event.metadata);
  const channelId = stringValue(ctx.channelId || ctx.channel || event.channel || metadata.channel).toLowerCase();
  return Boolean(
    stringValue(event.replyToMessageId)
    || stringValue(event.reply_to_id)
    || stringValue(metadata.threadTs)
    || stringValue(metadata.thread_ts)
    || stringValue(ctx.inboundMessageTs)
    || stringValue(ctx.threadTs)
    || stringValue(ctx.thread_ts)
    || stringValue(metadata.channel)
    || stringValue(metadata.channelId)
    || channelId === "slack"
    || channelId.startsWith("slack:")
  );
}

function appendReplyProjectionFooter(content: string, state: UnknownRecord, event: UnknownRecord, ctx: UnknownRecord): string {
  if (!replyProjectionFooterEnabled() || internalAckProjectionSuppressed()) return content;
  // Don't double-stamp
  if (hasProjectionFooter(content)) return content;
  if (/\[ack\s*·/iu.test(content)) return content;

  const decision = asRecord(state.decision);
  const snapshot = outboundProjectionSnapshot(state);
  const workContract = asRecord(decision.work_contract);
  const routeDecision = asRecord(decision.route_decision);
  const route = stringValue(workContract.route || routeDecision.route || state.route || snapshot.route || "reply") === "delegate"
    ? "delegate" : "reply";

  const debug = footerDebugEnabled();

  // Runtime owns the channel-neutral projection facts; IM adapters own
  // surface-specific rendering and legacy transport compatibility.
  const projection: IMProjectionFooter = {
    route,
    model: resolveDisplayModel(state, event, ctx),
    via: resolveRouteSource(state),
    thread: hasThreadProjection(event, ctx),
    ...(debug ? {
      workerPool: stringValue(routeDecision.worker_pool || snapshot.workerPool || snapshot.worker_pool),
      workContractId: stringValue(workContract.workContractId || decision.workContractId || snapshot.workContractId || snapshot.work_contract_id),
    } : {}),
  };
  return renderIMProjectionFooter({
    content: content.trim(),
    projection,
    sessionKey: stringValue(ctx.sessionKey || event.sessionKey || event.session_key),
    channel: resolveProjectionChannel(event, ctx),
  });
}

function resolveProjectionChannel(event: UnknownRecord, ctx: UnknownRecord): string {
  const metadata = asRecord(event.metadata);
  const direct = stringValue(ctx.channel || ctx.channelId || event.channel || metadata.channel);
  if (direct.toLowerCase() === "slack" || direct.toLowerCase().startsWith("slack:")) return "slack";
  const target = stringValue(event.to || metadata.channelId || metadata.channel_id || ctx.conversationId || ctx.conversation_id);
  if (outboundTargetLooksLikeSlack(target)) return "slack";
  return direct;
}

export function guardOutboundMessageForPolicyState(event: UnknownRecord, ctx: UnknownRecord, now = Date.now()): { content?: string; message?: UnknownRecord; cancel?: boolean } | undefined {
  const content = outboundDeliveryContent(event);
  if (!content) return undefined;
  if (content.toUpperCase() === "NO_REPLY") return { cancel: true };
  const visibleDelivery = outboundLooksLikeVisibleDeliveryHook(event, ctx);
  const match = findRecentOutboundPolicyState(resolveOutboundPolicyTarget(event, ctx), event, ctx, now, {
    allowUnanchoredDelivery: visibleDelivery,
  });
  if (!match) {
    if (!visibleDelivery) return undefined;
    const fallbackReplacement = appendReplyProjectionFooter(content, {}, event, ctx);
    return fallbackReplacement && fallbackReplacement !== content ? outboundGuardReplacement(event, fallbackReplacement) : undefined;
  }
  const stateRecord = hydrateOutboundStateWithNativeRefs(asRecord(match.state));
  if (shouldCancelNativeAnnounceDeliveredOutbound(match, stateRecord, now)) {
    updatePolicyState(match.key, (current) => ({
      ...(current ?? {}),
      ...stateRecord,
      outbound_guard_cancelled: true,
      outbound_guard_cancelled_at: new Date(now).toISOString(),
      outbound_guard_cancel_reason: "native_announce_already_delivered",
    }));
    return { cancel: true };
  }
  const guarded = match.anchored
    ? guardAssistantMessageForPolicyState(
        { role: "assistant", content: [{ type: "text", text: content }] },
        stateRecord,
      )
    : { mode: "pass" as const };
  const guardedReplacement = guarded.mode === "replace" && guarded.message
    ? assistantMessageText(asRecord(guarded.message))
    : "";
  if (guardedReplacement.trim().toUpperCase() === "NO_REPLY") {
    updatePolicyState(match.key, (current) => ({
      ...(current ?? {}),
      ...stateRecord,
      outbound_guard_replaced: true,
      outbound_guard_replaced_at: new Date(now).toISOString(),
      outbound_guard_cancelled: true,
      outbound_guard_cancelled_at: new Date(now).toISOString(),
    }));
    return { cancel: true };
  }
  const baseContent = guardedReplacement || content;
  const replacement = appendReplyProjectionFooter(baseContent, stateRecord, event, ctx);
  if (!replacement || replacement === content) return undefined;
  updatePolicyState(match.key, (current) => ({
    ...(current ?? {}),
    ...stateRecord,
    outbound_guard_replaced: guardedReplacement ? true : current?.outbound_guard_replaced,
    outbound_guard_replaced_at: guardedReplacement ? new Date(now).toISOString() : current?.outbound_guard_replaced_at,
    outbound_projection_footer_appended: replacement !== baseContent || current?.outbound_projection_footer_appended === true,
    outbound_projection_footer_appended_at: replacement !== baseContent ? new Date(now).toISOString() : current?.outbound_projection_footer_appended_at,
  }));
  return outboundGuardReplacement(event, replacement);
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
  let best: { key: string; state: PolicyStateEntry; updatedAt: number } | null = null;
  for (const key of keys) {
    const state = policyState.get(key);
    if (!state) continue;
    const updatedAt = Number(state.updatedAt || state.createdAt || 0);
    if (!best || updatedAt >= best.updatedAt) {
      best = { key, state, updatedAt };
    }
  }
  if (best) {
    const canonicalKey = stringValue(best.state.canonicalSessionKey || best.state.canonical_session_key);
    if (canonicalKey && canonicalKey !== best.key) {
      const canonicalState = policyState.get(canonicalKey);
      if (canonicalState) {
        return { key: canonicalKey, state: canonicalState };
      }
    }
    return { key: best.key, state: best.state };
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

function budgetedMainStateKeys(stateKey: string, ctx: UnknownRecord, state: UnknownRecord): string[] {
  return policyStateAliasKeys(stateKey, ctx, state);
}

export function budgetedMainWorkContractId(state: UnknownRecord, decision: UnknownRecord): string {
  const workContract = asRecord(decision.work_contract);
  return stringValue(state.workContractId || state.work_contract_id)
    || stringValue(workContract.workContractId || workContract.work_contract_id)
    || stringValue(decision.workContractId || decision.work_contract_id);
}

export function budgetedMainSpawnIntentId(state: UnknownRecord): string {
  return stringValue(state.spawnIntentId || state.spawn_intent_id);
}

export function budgetedMainVisibleStartAt(state: UnknownRecord, now: number): number {
  const candidate = Number(state.inboundObservedAt || state.inbound_observed_at || state.createdAt || 0);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : now;
}

function budgetedMainContractSessionKey(stateKey: string, ctx: UnknownRecord, state: UnknownRecord): string {
  return stringValue(state.canonicalSessionKey || state.canonical_session_key)
    || stringValue(state.ackGuardKey || state.ack_guard_key)
    || stringValue(ctx.sessionKey || ctx.session_key)
    || stringValue(ctx.canonicalSessionKey || ctx.canonical_session_key)
    || stringValue(stateKey);
}

function budgetedMainIntentClass(decision: UnknownRecord): IntentClass {
  const routeDecision = asRecord(decision.route_decision);
  const request = asRecord(decision.request);
  const metadata = asRecord(request.metadata);
  const conversationControl = asRecord(metadata.conversation_control);
  const raw = stringValue(
    decision.intent_class
      || routeDecision.intent_class
      || conversationControl.intent_class
      || "delegated_work",
  );
  return raw === "plain_chat"
    || raw === "runtime_read_model"
    || raw === "execution_followup"
    || raw === "local_surface_lookup"
    || raw === "fresh_live_lookup"
    || raw === "delegated_work"
    || raw === "undetermined"
    ? raw
    : "delegated_work";
}

function budgetedMainDecisionSource(decision: UnknownRecord): WorkDecisionSource {
  const routeDecision = asRecord(decision.route_decision);
  const raw = stringValue(decision._judge_source || routeDecision.final_judge_source || routeDecision.route_source || "local_judge");
  if (raw === "continuation"
    || raw === "execution_coverage"
    || raw === "memory_coverage"
    || raw === "local_judge"
    || raw === "remote_judge"
    || raw === "validator"
    || raw === "main_agent_route_hint"
    || raw === "policy_rule"
  ) {
    return raw;
  }
  return "local_judge";
}

function budgetedMainCoverageSnapshot(stateKey: string): ContextCoverageSnapshot {
  const execution = buildExecutionCoverageLayer([stateKey]);
  const memory = buildMemoryCoverageLayer();
  const conflict = Boolean((execution.coverage && execution.coverage !== "none") && (memory.coverage && memory.coverage !== "none"));
  return {
    precheckOrder: [
      "conversation_grounding",
      "continuation_route_reuse",
      "execution_coverage",
      "memory_coverage",
      "build_judge_context_packet",
      "local_judge",
      "validator_or_remote",
      "route_seal_commit",
    ],
    execution,
    memory,
    conflict,
    authority: conflict
      ? "execution_wins"
      : execution.coverage && execution.coverage !== "none"
        ? "execution_wins"
        : memory.coverage && memory.coverage !== "none"
          ? "memory_only"
          : "none",
  };
}

function attachBudgetedMainDelegateWorkContract(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  reason: string;
  now: number;
}): { decision: UnknownRecord; workContractId: string; contractSessionKey: string } {
  const existingContract = asRecord(input.decision.work_contract);
  if (stringValue(existingContract.route) === "delegate") {
    const existingId = stringValue(existingContract.workContractId || existingContract.work_contract_id || input.decision.workContractId || input.decision.work_contract_id);
    const existing = existingId ? loadWorkContract(existingId) : null;
    if (existing?.route === "delegate") {
      return { decision: input.decision, workContractId: existingId, contractSessionKey: existing.sessionKey };
    }
  }

  const contractSessionKey = budgetedMainContractSessionKey(input.stateKey, input.ctx, input.state);
  const routeDecision = asRecord(input.decision.route_decision);
  const expectedDeliverable = stringValue(
    input.decision.expected_deliverable
      || input.decision.expectedDeliverable
      || routeDecision.expected_deliverable
      || routeDecision.expectedDeliverable
      || input.state.prompt,
  );
  const userAsk = stringValue(input.state.prompt)
    || stringValue(asRecord(input.decision.request).prompt)
    || expectedDeliverable
    || "Budgeted main escalation";
  const reasonCodes = Array.from(new Set([
    ...stringArray(routeDecision.reason_codes),
    "budgeted_main_escalated",
    `budgeted_main_escalation:${input.reason}`,
  ]));
  const coverage = budgetedMainCoverageSnapshot(contractSessionKey);
  const decisionSeal = buildWorkDecisionSeal(
    budgetedMainDecisionSource(input.decision),
    "delegate",
    reasonCodes,
    {
      delegateRole: "default",
      confidence: typeof input.decision.judge_confidence === "number" ? input.decision.judge_confidence : undefined,
    },
  );
  const delegateTaskId = stableId("delegate-task", [
    contractSessionKey,
    userAsk,
    input.reason,
    String(input.now),
  ]);
  const delegate: DelegateContract = {
    delegateTaskId,
    currentAttemptId: `${delegateTaskId}:attempt:1`,
    role: "default",
    coordinationMode: "solo_worker",
    acceptanceCriteria: [expectedDeliverable || "Return a compact result that satisfies the original request."],
    scope: {
      read: ["workspace"],
      write: ["workspace"],
      workspaceMode: "write_allowed",
      scopeFingerprint: stableId("scope", [contractSessionKey, userAsk, input.reason]),
    },
    modelProfile: stringValue(routeDecision.worker_pool || routeDecision.model || asRecord(input.decision.request).model) || "default",
    nativeBinding: null,
    childSessions: [],
    artifactRefs: [],
    nextAction: "dispatch",
  };
  const contract = buildWorkContractFromPolicy(
    contractSessionKey,
    userAsk,
    budgetedMainIntentClass(input.decision),
    coverage,
    decisionSeal,
    { delegate },
  );
  if (!saveWorkContract(contract)) {
    return { decision: input.decision, workContractId: "", contractSessionKey };
  }

  return {
    decision: {
      ...input.decision,
      workContractId: contract.workContractId,
      work_contract_id: contract.workContractId,
      work_contract: compactWorkContractView(contract),
    },
    workContractId: contract.workContractId,
    contractSessionKey,
  };
}

export function updateBudgetedMainForContext(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  budgetState: BudgetedMainState;
  decision?: UnknownRecord;
  extra?: UnknownRecord;
}): PolicyStateEntry | null {
  let selected: PolicyStateEntry | null = null;
  const serialized = serializeBudgetedMainState(input.budgetState);
  const canonicalSessionKey = stringValue(input.state.canonicalSessionKey || input.state.canonical_session_key || input.stateKey);
  for (const key of budgetedMainStateKeys(input.stateKey, input.ctx, input.state)) {
    updatePolicyState(key, (current) => {
      const next = {
        ...(current ?? {}),
        ...(input.extra ?? {}),
        ...(input.decision ? { decision: input.decision } : {}),
        canonicalSessionKey,
        canonical_session_key: canonicalSessionKey,
        budgetedMain: serialized,
        budgeted_main: serialized,
      } as PolicyStateEntry;
      if (!selected || key === input.stateKey) selected = next;
      return next;
    });
  }
  return selected;
}

export async function recordBudgetedMainEvent(input: {
  event: string;
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  budgetState: BudgetedMainState;
  reason: string;
  logger?: LoggerLike;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const metrics = buildBudgetedMainMetrics({
    state: input.budgetState,
    now,
    reason: input.reason,
    sessionKey: input.stateKey,
    workContractId: input.budgetState.workContractId || budgetedMainWorkContractId(input.state, input.decision),
    spawnIntentId: input.budgetState.spawnIntentId || budgetedMainSpawnIntentId(input.state),
  });
  await recordPolicyReplay(
    input.event,
    {
      ...metrics,
      stateKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
    },
    input.logger,
    null,
  );
}

function clearBudgetedMainTimer(stateKey: string): void {
  const timer = pendingBudgetedMainTimers.get(stateKey);
  if (!timer) return;
  clearTimeout(timer);
  pendingBudgetedMainTimers.delete(stateKey);
}

export function scheduleBudgetedMainTimeout(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  budgetState: BudgetedMainState;
  logger?: LoggerLike;
}): void {
  if (!input.stateKey || pendingBudgetedMainTimers.has(input.stateKey)) return;
  const remainingMs = Math.max(0, input.budgetState.maxWallMs - (Date.now() - input.budgetState.startedAt));
  const timer = setTimeout(() => {
    pendingBudgetedMainTimers.delete(input.stateKey);
    const liveState = asRecord(policyState.get(input.stateKey));
    const liveBudget = readBudgetedMainState(liveState);
    if (!liveBudget || !liveBudget.active || liveBudget.completedAt || liveBudget.escalatedAt || liveBudget.escalatedPending) return;
    if (liveState.formal_reply_visible === true
      || liveState.formalReplyVisible === true
      || liveState.dispatchExecuted === true
      || liveState.dispatch_executed === true
      || liveState.spawnExecuted === true
      || liveState.spawn_executed === true
    ) return;
    const now = Date.now();
    const pendingBudget: BudgetedMainState = {
      ...liveBudget,
      escalatedPending: true,
      reason: "wall_time_over_budget",
    };
    updateBudgetedMainForContext({
      stateKey: input.stateKey,
      ctx: input.ctx,
      state: liveState,
      budgetState: pendingBudget,
      extra: {
        budgeted_main_escalated_pending: true,
        budgeted_main_escalated_pending_at: new Date(now).toISOString(),
      },
    });
    void recordBudgetedMainEvent({
      event: "budgeted_main_escalated_pending",
      stateKey: input.stateKey,
      ctx: input.ctx,
      state: liveState,
      decision: asRecord(liveState.decision || input.decision),
      budgetState: pendingBudget,
      reason: "wall_time_over_budget",
      logger: input.logger,
      now,
    }).catch(() => {});
  }, remainingMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  pendingBudgetedMainTimers.set(input.stateKey, timer);
}

export function maybeStartBudgetedMain(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  logger?: LoggerLike;
}): void {
  if (!input.stateKey || !isBudgetedMainDecision(input.decision)) return;
  const liveState = asRecord(policyState.get(input.stateKey) || input.state);
  const existingBudget = readBudgetedMainState(liveState);
  if (existingBudget?.completedAt || existingBudget?.escalatedAt) return;
  if (existingBudget?.active) {
    scheduleBudgetedMainTimeout({
      ...input,
      state: liveState,
      budgetState: existingBudget,
    });
    return;
  }
  const now = Date.now();
  const budgetState = buildBudgetedMainState({
    now,
    decision: input.decision,
    visibleStartAt: budgetedMainVisibleStartAt(liveState, now),
    budgetStartSource: "before_prompt_build_complete",
    workContractId: budgetedMainWorkContractId(liveState, input.decision),
    spawnIntentId: budgetedMainSpawnIntentId(liveState),
  });
  updateBudgetedMainForContext({
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: liveState,
    budgetState,
  });
  void recordBudgetedMainEvent({
    event: "budgeted_main_started",
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: liveState,
    decision: input.decision,
    budgetState,
    reason: "budgeted_main_started",
    logger: input.logger,
    now,
  }).catch(() => {});
  scheduleBudgetedMainTimeout({
    ...input,
    state: liveState,
    budgetState,
  });
}

export function maybeInjectSpeculativePreload(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  route: string;
  prompt: string;
  prependSystem: string[];
  pluginConfig?: UnknownRecord;
  logger?: LoggerLike;
}): UnknownRecord {
  if (!resolveSpeculativePreloadEnabled(input.pluginConfig)) return input.state;
  const spawnBackend = resolveSpawnBackend();
  if (spawnBackend !== "planner") {
    void recordPolicyReplay("speculative_preload_skipped", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      route: input.route,
      reason: "spawn_backend_not_planner",
      spawn_backend: spawnBackend,
    }, input.logger, input.decision).catch(() => {});
    return input.state;
  }
  const routeDecisionRoute = stringValue(asRecord(input.decision.route_decision).route);
  const delegateRoute = input.route === "delegate" || routeDecisionRoute === "delegate" || isDelegatedRoute(input.decision);
  if (!input.stateKey || !delegateRoute) {
    void recordPolicyReplay("speculative_preload_skipped", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      route: input.route,
      route_decision_route: routeDecisionRoute,
      reason: !input.stateKey ? "missing_state_key" : "route_not_delegate",
    }, input.logger, input.decision).catch(() => {});
    return input.state;
  }
  const existing = readSpeculativePreloadState(input.state);
  if (existing?.status === "stale" && speculativePreloadThreadBindingUnavailable(existing.error)) {
    void recordPolicyReplay("speculative_preload_skipped", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      route: input.route,
      route_decision_route: routeDecisionRoute,
      reason: "thread_binding_unavailable",
      status: existing.status,
      label: existing.label,
      error: existing.error || "",
    }, input.logger, input.decision).catch(() => {});
    return input.state;
  }
  if (existing?.label && existing.status !== "stale") {
    void recordPolicyReplay("speculative_preload_skipped", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      route: input.route,
      route_decision_route: routeDecisionRoute,
      reason: "existing_speculative_state",
      status: existing.status,
      label: existing.label,
    }, input.logger, input.decision).catch(() => {});
    return input.state;
  }
  const label = buildSpeculativePreloadLabel({
    stateKey: input.stateKey,
    sessionId: stringValue(input.ctx.sessionId),
    inboundMessageTs: stringValue(input.state.inboundMessageTs || input.state.inbound_message_ts || input.ctx.messageTs || input.ctx.message_ts),
    prompt: input.prompt,
    nonce: stringValue(existing?.updatedAt || input.state.updatedAt || input.state.updated_at || input.state.createdAt || input.state.created_at || Date.now()),
  });
  const spawnArgs = buildSpeculativePreloadSpawnArgs({
    label,
    model: stringValue(asRecord(input.decision.route_decision).model || asRecord(input.decision.route_decision).worker_model),
    cwd: resolvePlannerNativeCwd(stringValue(input.ctx.cwd)),
  });
  const speculative = speculativePreloadStateForHint({ label, spawnArgs });
  const serialized = serializeSpeculativePreloadState(speculative);
  const nextState = {
    ...input.state,
    speculativePreload: serialized,
    speculative_preload: serialized,
  };
  const aliasKeys = Array.from(new Set([
    input.stateKey,
    ...resolvePolicyStateKeys(input.ctx),
  ].map((value) => stringValue(value)).filter(Boolean)));
  for (const key of aliasKeys) {
    policyState.set(key, nextState as PolicyStateEntry);
  }
  input.prependSystem.push(buildSpeculativePreloadHint(spawnArgs));
  void recordPolicyReplay("speculative_preload_hint_injected", {
    sessionKey: input.stateKey,
    sessionId: stringValue(input.ctx.sessionId),
    label,
    route: stringValue(asRecord(input.decision.route_decision).route),
    decision_bucket: stringValue(asRecord(input.decision.route_decision).decision_bucket),
    alias_count: aliasKeys.length,
  }, input.logger, input.decision).catch(() => {});
  return nextState;
}

function completeBudgetedMainIfActive(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  logger?: LoggerLike;
}): void {
  const budgetState = readBudgetedMainState(input.state);
  if (!input.stateKey || !budgetState?.active || budgetState.completedAt || budgetState.escalatedAt) return;
  const now = Date.now();
  const late = budgetState.escalatedPending === true || now - budgetState.startedAt > budgetState.maxWallMs;
  const reason = late ? "completed_late" : "completed";
  const completedBudget: BudgetedMainState = {
    ...budgetState,
    active: false,
    completedAt: now,
    reason,
  };
  clearBudgetedMainTimer(input.stateKey);
  updateBudgetedMainForContext({
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: input.state,
    budgetState: completedBudget,
    extra: {
      budgeted_main_completed: true,
      budgeted_main_completed_at: new Date(now).toISOString(),
      ...(late ? { budgeted_main_completed_late: true } : {}),
    },
  });
  void recordBudgetedMainEvent({
    event: late ? "budgeted_main_completed_late" : "budgeted_main_completed",
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: input.state,
    decision: input.decision,
    budgetState: completedBudget,
    reason,
    logger: input.logger,
    now,
  }).catch(() => {});
}

export async function escalateBudgetedMainForTool(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  budgetState: BudgetedMainState;
  reason: string;
  logger?: LoggerLike;
}): Promise<{ state: PolicyStateEntry | null; decision: UnknownRecord }> {
  const now = Date.now();
  const escalatedBaseDecision = escalateBudgetedMainDecision(input.decision, input.reason);
  const attached = attachBudgetedMainDelegateWorkContract({
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: input.state,
    decision: escalatedBaseDecision,
    reason: input.reason,
    now,
  });
  const escalatedDecision = attached.decision;
  const escalatedBudget: BudgetedMainState = {
    ...input.budgetState,
    active: false,
    escalatedAt: now,
    escalatedPending: false,
    reason: input.reason,
    workContractId: attached.workContractId || input.budgetState.workContractId,
  };
  clearBudgetedMainTimer(input.stateKey);
  const nextState = updateBudgetedMainForContext({
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: input.state,
    budgetState: escalatedBudget,
    decision: escalatedDecision,
    extra: {
      routeHintSubmitted: true,
      delegated: false,
      dispatchRoute: "delegate",
      dispatchStatus: "budgeted_main_escalated",
      dispatchExecuted: false,
      spawnExecuted: false,
      budgeted_main_escalated: true,
      budgeted_main_escalated_at: new Date(now).toISOString(),
      ...(attached.contractSessionKey ? { canonicalSessionKey: attached.contractSessionKey, canonical_session_key: attached.contractSessionKey } : {}),
      ...(attached.workContractId ? { workContractId: attached.workContractId, work_contract_id: attached.workContractId } : {}),
    },
  });
  await recordBudgetedMainEvent({
    event: "budgeted_main_escalated",
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: input.state,
    decision: escalatedDecision,
    budgetState: escalatedBudget,
    reason: input.reason,
    logger: input.logger,
    now,
  });
  return { state: nextState, decision: escalatedDecision };
}

export async function promoteBudgetedMainDispatch(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  task: string;
  logger?: LoggerLike;
}): Promise<{ state: PolicyStateEntry | null; decision: UnknownRecord; promoted: boolean }> {
  const alreadyEscalated = hasBudgetedMainEscalationEvidence(input.state, input.decision);
  if (!input.stateKey || (!isBudgetedMainDecision(input.decision) && !alreadyEscalated)) {
    return { state: input.state as PolicyStateEntry | null, decision: input.decision, promoted: false };
  }
  if (stringValue(asRecord(input.decision.route_decision).route) === "delegate") {
    return { state: input.state as PolicyStateEntry | null, decision: input.decision, promoted: false };
  }
  const stateForEscalation = {
    ...input.state,
    ...(input.task ? { prompt: input.task } : {}),
  };
  const now = Date.now();
  const existingBudget = readBudgetedMainState(input.state);
  const budgetState = existingBudget && !existingBudget.completedAt
    ? existingBudget
    : {
        ...buildBudgetedMainState({
          now,
          decision: input.decision,
          visibleStartAt: budgetedMainVisibleStartAt(input.state, now),
          budgetStartSource: "main_agent_called_dispatch",
          workContractId: budgetedMainWorkContractId(input.state, input.decision),
          spawnIntentId: budgetedMainSpawnIntentId(input.state),
        }),
        reason: "main_agent_called_dispatch",
      };
  const escalated = await escalateBudgetedMainForTool({
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: stateForEscalation,
    decision: input.decision,
    budgetState,
    reason: "main_agent_called_dispatch",
    logger: input.logger,
  });
  return { ...escalated, promoted: true };
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

    registerLifecycleHook("message_sending", (event, ctx) => {
      const eventRecord = asRecord(event);
      const ctxRecord = asRecord(ctx);
      const visibleDelivery = outboundLooksLikeVisibleDeliveryHook(eventRecord, ctxRecord);
      const content = outboundDeliveryContent(eventRecord);
      const stateInfo = visibleDelivery ? getPolicyStateForContext(ctxRecord) : { key: "", state: null };
      const stateRecord = asRecord(stateInfo.state);
      if (visibleDelivery && outboundDeliveryContent(eventRecord).trim().toUpperCase() !== "NO_REPLY") {
        const cancellations = cancelNeutralAckTimersForContext(eventRecord, ctxRecord, stateRecord);
        if (cancellations.length > 0) {
          recordNeutralAckCancellations("message_sending", cancellations, "formal_reply_visible", stateInfo.key);
        }
      }
      const guarded = guardOutboundMessageForPolicyState(eventRecord, ctxRecord);
      if (visibleDelivery) {
        void recordPolicyReplay(
          "outbound_message_sending_guard",
          {
            sessionKey: stringValue(ctxRecord.sessionKey || eventRecord.sessionKey || eventRecord.session_key),
            channelId: stringValue(ctxRecord.channelId || ctxRecord.channel || eventRecord.channel || asRecord(eventRecord.metadata).channel),
            conversationId: stringValue(ctxRecord.conversationId || ctxRecord.conversation_id || eventRecord.to),
            target: stringValue(resolveOutboundPolicyTarget(eventRecord, ctxRecord)),
            stateKey: stateInfo.key,
            workContractId: stringValue(stateRecord.workContractId || stateRecord.work_contract_id),
            nativeAnnounceDelivered: stateRecord.nativeAnnounceDelivered === true || stateRecord.native_announce_delivered === true,
            content_len: content.length,
            returned: guarded ? true : false,
            cancel: guarded?.cancel === true,
            footer_appended: Boolean(guarded?.content && guarded.content !== content),
            replacement_len: stringValue(guarded?.content).length,
          },
          pi.logger,
          null,
        ).catch(() => {});
      }
      return guarded;
    }, 220);

    registerLifecycleHook("reply_dispatch", (event, ctx) => {
      const eventRecord = asRecord(event);
      const ctxRecord = asRecord(ctx);
      const wrapped = wrapReplyDispatchFooterProjection(eventRecord, ctxRecord);
      if (wrapped) {
        const sourceCtx = replyDispatchSourceContext(eventRecord);
        void recordPolicyReplay(
          "reply_dispatch_footer_projection_wrapped",
          {
            sessionKey: firstStringValue(eventRecord.sessionKey, sourceCtx.SessionKey),
            channelId: firstStringValue(sourceCtx.OriginatingChannel, sourceCtx.Surface, sourceCtx.Provider),
            conversationId: firstStringValue(sourceCtx.OriginatingTo, sourceCtx.To, sourceCtx.NativeChannelId),
          },
          pi.logger,
          null,
        ).catch(() => {});
      }
    }, 220);

    registerLifecycleHook("message_received", (event, ctx) => {
      const eventRecord = asRecord(event);
      const ctxRecord = asRecord(ctx);
      const prompt = extractPromptText(eventRecord) || stringValue(eventRecord.content);
      const sessionKey = resolveSlackMessageReceivedSessionKey(eventRecord, ctxRecord);
      if (!sessionKey) return;
      const stateKey = stringValue(ctxRecord.sessionKey || eventRecord.sessionKey) || sessionKey;
      const anchor = extractInboundMessageTimestampWithSource(ctxRecord, eventRecord, prompt);
      void handleRouterWizardAction({
        event: eventRecord,
        sessionKey,
        replyToMessageId: anchor.ts || undefined,
        cwd: stringValue(ctxRecord.cwd) || process.cwd(),
      }).then((result) => {
        if (result.handled) return;
        return maybeSendRouterWizardOnboarding({
          sessionKey,
          replyToMessageId: anchor.ts || undefined,
          cwd: stringValue(ctxRecord.cwd) || process.cwd(),
          logger: pi.logger,
        });
      }).catch((error) => {
        pi.logger?.warn?.(`octoclaw router wizard onboarding failed: ${String(error)}`);
      });
      if (anchor.ts) {
        const now = Date.now();
        updatePolicyState(stateKey, (current) => ({
          ...(current ?? {}),
          canonicalSessionKey: stateKey,
          ackGuardKey: sessionKey,
          inboundMessageTs: anchor.ts,
          inboundObservedAt: Number(current?.inboundObservedAt || current?.inbound_observed_at || 0) || now,
          inbound_observed_at: Number(current?.inboundObservedAt || current?.inbound_observed_at || 0) || now,
          replyToMessageId: anchor.ts,
          message_id: anchor.ts,
          deliveryTarget: buildImmutableDeliveryTarget(sessionKey, anchor.ts),
          delivery_target: buildImmutableDeliveryTarget(sessionKey, anchor.ts),
          channelTone: stringValue(asRecord(current).channelTone || asRecord(current).channel_tone) || "chat",
          createdAt: Number(current?.createdAt || 0) || now,
          updatedAt: now,
        }));
      }
      void recordPolicyReplay(
        "message_received_observed",
        {
          sessionKey,
          channelId: stringValue(ctxRecord.channelId || eventRecord.channelId),
          conversationId: stringValue(ctxRecord.conversationId || eventRecord.conversationId),
          stateKey,
          inboundMessageTs: anchor.ts,
          anchor_source: anchor.source,
        },
        pi.logger,
        null,
      ).catch(() => {});
      void maybeSendNeutralInboundAckForContext("message_received", event, { ...ctxRecord, sessionKey }, prompt, {
        stateKey,
        sessionKey,
        inboundMessageTs: anchor.ts,
        inboundMessageTsSource: anchor.source,
      }).catch((error) => {
        pi.logger?.warn?.(`octoclaw neutral inbound ACK failed: ${String(error)}`);
      });
    }, 280);

    registerLifecycleHook("before_compaction", (event, ctx) => {
      void sendCompactionNotice(event, ctx, pi.logger).catch((error) => {
        pi.logger?.warn?.(`octoclaw compaction notice failed: ${String(error)}`);
      });
    }, 180);

    registerLifecycleHook("before_dispatch", async (event, ctx) => {
      const prompt = extractPromptText(event);
      const eventRecord = asRecord(event);
      const ctxRecord = asRecord(ctx);
      const mergedCtx = { ...eventRecord, ...ctxRecord };
      const stateKey = resolvePolicyStateKey(mergedCtx);
      const extractedAnchor = extractInboundMessageTimestampWithSource(ctxRecord, eventRecord, prompt);
      const existingState = asRecord(getPolicyStateForContext(mergedCtx).state);
      const stateAnchor = deliveryTargetReplyTo(existingState)
        || stringValue(existingState.inboundMessageTs || existingState.replyToMessageId || existingState.message_id || existingState.messageId);
      const anchor = extractedAnchor.ts
        ? extractedAnchor
        : stateAnchor
          ? { ts: stateAnchor, source: "ctx" as const }
          : extractedAnchor;
      void recordPolicyReplay(
        "before_dispatch_observed",
        {
          sessionKey: stringValue(mergedCtx.sessionKey || event.sessionKey),
          sessionId: stringValue(mergedCtx.sessionId || event.sessionId),
          stateKey,
          inboundMessageTs: anchor.ts,
          anchor_source: anchor.source,
        },
        pi.logger,
        null,
      ).catch(() => {});
      const controlPlaneResult = await handleOctoClawControlPlaneFastPath({
        prompt,
        mergedCtx,
        eventRecord,
        ctxRecord,
        stateKey,
        logger: pi.logger,
      });
      if (controlPlaneResult) return controlPlaneResult;
      void maybeSendNeutralInboundAckForContext("before_dispatch", event, ctx, prompt, {
        stateKey,
        inboundMessageTs: anchor.ts,
        inboundMessageTsSource: anchor.source,
      }).catch((error) => {
        pi.logger?.warn?.(`octoclaw neutral inbound ACK failed: ${String(error)}`);
      });
    }, 260);

    registerLifecycleHook("subagent_ended", async (event, ctx) => {
      await handleNativeSubagentEndedCompletion({
        event,
        ctx,
        pluginConfig: pi.pluginConfig,
        logger: pi.logger,
        cwd: stringValue(ctx.cwd) || process.cwd(),
        sendMessage: nativeAnnounceSendOverride(pi.pluginConfig),
      });
    }, 210);

    registerLifecycleHook("before_model_resolve", async (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const hookStartedAt = Date.now();
      const prompt = extractPromptText(event);
      const stateKey = resolvePolicyStateKey(ctx);
      const nativeAnnounceHandled = await handleNativeAnnounceCompletion({
        event,
        ctx,
        prompt,
        pluginConfig: pi.pluginConfig,
        logger: pi.logger,
        cwd: stringValue(ctx.cwd) || process.cwd(),
        sendMessage: nativeAnnounceSendOverride(pi.pluginConfig),
      });
      if (nativeAnnounceHandled) {
        void recordPolicyReplay(
          "native_announce_model_resolve_skipped",
          {
            sessionKey: resolvePolicyStateKey(ctx),
            sessionId: stringValue(ctx.sessionId),
            sourceSessionKey: nativeAnnounceHandled.completion.sourceSessionKey,
            sourceTool: nativeAnnounceHandled.completion.sourceTool,
            resultHash: nativeAnnounceHandled.completion.resultHash,
            workContractId: nativeAnnounceHandled.workContractId || "",
            matched: nativeAnnounceHandled.matched,
            delivered: nativeAnnounceHandled.delivered,
          },
          pi.logger,
          null,
        ).catch(() => {});
        return;
      }
      void recordPolicyReplay(
        "before_model_resolve_observed",
        {
          sessionKey: stateKey || stringValue(ctx.sessionKey),
          sessionId: stringValue(ctx.sessionId),
          stateKey,
          elapsedMs: Date.now() - hookStartedAt,
        },
        pi.logger,
        null,
      ).catch(() => {});
      const policyResolveStartedAt = Date.now();
      void recordPolicyReplay(
        "before_model_policy_resolve_started",
        {
          sessionKey: stateKey || stringValue(ctx.sessionKey),
          sessionId: stringValue(ctx.sessionId),
          stateKey,
          elapsedMs: policyResolveStartedAt - hookStartedAt,
        },
        pi.logger,
        null,
      ).catch(() => {});
      const resolved = await resolvePolicyDecisionForContext(
        prompt,
        ctx,
        process.cwd(),
        pi.logger,
      );
      const modelPolicyDecision = asRecord(resolved?.decision);
      void recordPolicyReplay(
        "before_model_policy_resolve_completed",
        {
          sessionKey: stateKey || stringValue(ctx.sessionKey),
          sessionId: stringValue(ctx.sessionId),
          stateKey: stringValue(resolved?.stateKey || stateKey),
          elapsedMs: Date.now() - policyResolveStartedAt,
          hookElapsedMs: Date.now() - hookStartedAt,
          resolved: Boolean(resolved),
          usedCachedPolicy: resolved?.usedCachedPolicy === true,
          route: stringValue(asRecord(modelPolicyDecision.route_decision).route),
          decision_bucket: stringValue(asRecord(modelPolicyDecision.route_decision).decision_bucket),
          workContractId: stringValue(modelPolicyDecision.workContractId || asRecord(modelPolicyDecision.work_contract).workContractId || asRecord(modelPolicyDecision.work_contract).work_contract_id),
        },
        pi.logger,
        null,
      ).catch(() => {});
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

    registerLifecycleHook("after_tool_call", async (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      if (!resolveSpeculativePreloadEnabled(currentPluginConfig())) return;
      const toolName = stringValue(event.toolName || ctx.toolName);
      if (toolName !== "sessions_spawn") return;
      const toolParams = asRecord(event.params || event.arguments || event.input);
      const { key: resolvedStateKey, state: resolvedState } = getPolicyStateForContext(ctx);
      const candidateKeys = Array.from(new Set([
        resolvedStateKey,
        ...resolvePolicyStateKeys(ctx),
      ].map((value) => stringValue(value)).filter(Boolean)));
      const matches: Array<{ key: string; state: UnknownRecord; speculative: NonNullable<ReturnType<typeof readSpeculativePreloadState>> }> = [];
      for (const key of candidateKeys) {
        const candidateState = asRecord(policyState.get(key));
        const speculative = readSpeculativePreloadState(candidateState);
        if (!speculative || (speculative.status !== "spawn_call_started" && speculative.status !== "hinted")) continue;
        if (!isMatchingSpeculativePreloadSpawn(candidateState, toolParams)) continue;
        matches.push({ key, state: candidateState, speculative });
      }
      if (resolvedStateKey && matches.length === 0) {
        const speculative = readSpeculativePreloadState(resolvedState);
        if (
          (speculative?.status === "spawn_call_started" || speculative?.status === "hinted")
          && isMatchingSpeculativePreloadSpawn(resolvedState, toolParams)
        ) {
          matches.push({ key: resolvedStateKey, state: asRecord(resolvedState), speculative });
        }
      }
      if (matches.length === 0) {
        for (const entry of policyState.entries()) {
          const candidateState = asRecord(entry.state);
          const speculative = readSpeculativePreloadState(candidateState);
          if (speculative?.status !== "spawn_call_started" && speculative?.status !== "hinted") continue;
          if (!isMatchingSpeculativePreloadSpawn(candidateState, toolParams)) continue;
          matches.push({ key: entry.key, state: candidateState, speculative });
        }
      }
      if (matches.length === 0) return;

      const result = event.result;
      const resultRecord = toolResultRecord(result);
      const accepted = !stringValue(event.error) && isAcceptedSpeculativeSpawnResult(result);
      const now = Date.now();
      const runId = firstNonEmptyString(resultRecord.runId, resultRecord.run_id, resultRecord.childRunId, resultRecord.child_run_id) || undefined;
      const childSessionKey = firstNonEmptyString(resultRecord.childSessionKey, resultRecord.child_session_key, resultRecord.sessionKey, resultRecord.session_key) || undefined;
      const error = accepted ? undefined : speculativeSpawnResultError(result, event.error);
      for (const match of matches) {
        const nextSpeculative = serializeSpeculativePreloadState({
          ...match.speculative,
          status: accepted ? "ready" : "stale",
          updatedAt: now,
          runId,
          childSessionKey,
          error,
        });
        updatePolicyState(match.key, (current) => ({
          ...current,
          speculativePreload: nextSpeculative,
          speculative_preload: nextSpeculative,
        }));
      }
      const preferredReplayKeys = new Set([
        stringValue(ctx.sessionKey),
        stringValue(ctx.canonicalSessionKey),
        stringValue(resolvedStateKey),
      ].filter(Boolean));
      const replayMatch = matches.find((match) => preferredReplayKeys.has(match.key)) || matches[0];
      const replaySessionKey = stringValue(ctx.sessionKey) || stringValue(ctx.canonicalSessionKey) || replayMatch.key;
      await recordPolicyReplay(accepted ? "speculative_preload_spawn_ready" : "speculative_preload_spawn_failed", {
        sessionKey: replaySessionKey,
        sessionId: stringValue(ctx.sessionId),
        toolName,
        label: replayMatch.speculative.label,
        status: stringValue(resultRecord.status),
        run_id: runId || "",
        child_session_key: childSessionKey || "",
        error: error || "",
        alias_count: matches.length,
        durationMs: Number(event.durationMs) || 0,
      }, pi.logger, asRecord(replayMatch.state?.decision)).catch(() => {});
    });

    registerLifecycleHook("agent_end", async (_event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const { key: stateKey, state } = getPolicyStateForContext(ctx);
      if (!stateKey) return;
      lastGroundedPromptByStateKey.delete(stateKey);
      clearBudgetedMainTimer(stateKey);
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
      const finalNow = Date.now();
      const directToolsSeen = Array.isArray(state?.directToolsSeen) ? state.directToolsSeen : [];
      const toolsUsed = Array.from(new Set([
        ...(Array.isArray(state?.toolsUsed) ? state.toolsUsed : []),
        ...directToolsSeen,
      ].map((value) => stringValue(value)).filter(Boolean)));
      const finalReceipt = buildTurnExecutionReceipt(
        {
          ...(state ?? {}),
          canonicalSessionKey: stateKey,
          toolsUsed,
        } as Parameters<typeof buildTurnExecutionReceipt>[0],
        Math.max(0, finalNow - Number(state?.createdAt || state?.updatedAt || finalNow)),
        finalNow,
      );
      void recordPolicyReplay(
        "agent_end",
        {
          sessionKey: stateKey,
          sessionId: stringValue(ctx.sessionId),
          route: finalReceipt.route,
          finalRoute: finalReceipt.route,
          systemPreferredRoute: stringValue(asRecord(asRecord(state?.decision).route_decision).system_preferred_route),
          workerPool: stringValue(asRecord(asRecord(state?.decision).route_decision).worker_pool),
          taskClass: stringValue(asRecord(asRecord(state?.decision).route_decision).task_class),
          protectedLane: stringValue(asRecord(asRecord(state?.decision).route_decision).protected_lane),
          routeHintRequired: Boolean(asRecord(asRecord(state?.decision).route_hint_policy).required),
          routeHintSubmitted: Boolean(state?.routeHintSubmitted),
          delegated: finalReceipt.delegated,
          dispatchExecuted: finalReceipt.dispatchExecuted,
          spawnExecuted: finalReceipt.spawnExecuted,
          resultMaterialized: finalReceipt.resultMaterialized,
          deliveryStatus: finalReceipt.deliveryStatus ?? "",
          terminalState: finalReceipt.outcome,
          totalLatencyMs: finalReceipt.durationMs,
          parentContextTokensAdded: finalReceipt.parentContextTokensAdded,
          resultPacketTokens: finalReceipt.resultPacketTokens,
          artifactReopenCount: finalReceipt.artifactReopenCount,
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
      ).catch(() => {});
      const shouldRetainCompactReceipt = Boolean(
        finalReceipt.route === "reply"
        || finalReceipt.toolsUsed.length > 0
        || finalReceipt.dispatchExecuted
        || finalReceipt.spawnExecuted
        || finalReceipt.resultMaterialized
        || asRecord(state?.latestAnomalyNotice).kind,
      );

      if (finalReceipt.route === "delegate" && shouldRetainPolicyStateOnAgentEnd(asRecord(state))) {
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
              replyToMessageId: deliveryTargetReplyTo(asRecord(state)) || stringValue(ctx.inboundMessageTs || state?.inboundMessageTs),
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
        void recordPolicyReplay(
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
        ).catch(() => {});
        return;
      }
      if (shouldRetainCompactReceipt) {
        const decision = asRecord(state?.decision);
        const routeDecision = asRecord(decision.route_decision);
        const workContract = asRecord(decision.work_contract);
        const replyToMessageId = deliveryTargetReplyTo(asRecord(state))
          || stringValue(state?.inboundMessageTs || state?.replyToMessageId || state?.message_id || ctx.inboundMessageTs);
        const outboundProjection = {
          route: finalReceipt.route,
          model: resolveDisplayModel(asRecord(state), {}, asRecord(ctx)),
          via: resolveRouteSource(asRecord(state)),
          thread: Boolean(replyToMessageId || slackThreadFromSessionKey(stringValue(ctx.sessionKey || stateKey))),
          workerPool: stringValue(routeDecision.worker_pool),
          workContractId: stringValue(workContract.workContractId || decision.workContractId || finalReceipt.workContractId),
        };
        policyState.update(stateKey, () => ({
          canonicalSessionKey: stateKey,
          latestExecutionReceipt: finalReceipt,
          workContractId: finalReceipt.workContractId ?? undefined,
          outboundProjection,
          outbound_projection: outboundProjection,
          ackGuardKey: stringValue(state?.ackGuardKey || state?.ack_guard_key || ctx.sessionKey),
          inboundMessageTs: replyToMessageId || undefined,
          replyToMessageId: replyToMessageId || undefined,
          message_id: replyToMessageId || undefined,
          deliveryTarget: buildImmutableDeliveryTarget(stringValue(state?.ackGuardKey || state?.ack_guard_key || ctx.sessionKey || stateKey), replyToMessageId),
          delivery_target: buildImmutableDeliveryTarget(stringValue(state?.ackGuardKey || state?.ack_guard_key || ctx.sessionKey || stateKey), replyToMessageId),
          directToolsSeen: finalReceipt.toolsUsed,
          toolsUsed: finalReceipt.toolsUsed,
          dispatchExecuted: finalReceipt.dispatchExecuted,
          spawnExecuted: finalReceipt.spawnExecuted,
          resultMaterialized: finalReceipt.resultMaterialized,
          latestAnomalyNotice: state?.latestAnomalyNotice,
          createdAt: finalNow,
          updatedAt: finalNow,
        }));
        return;
      }
      clearPolicyStateForContext(ctx);
    }, 50);

    registerLifecycleHook("before_message_write", (event, ctx) => {
      if (!isManagedAgentContext(ctx)) return;
      const message = asRecord(event.message);
      const role = String(message.role ?? "").trim();
      if (role !== "assistant") return;
      const originalText = assistantMessageText(message);
      if (!originalText) return;
      const noReplySentinel = originalText.trim().toUpperCase() === "NO_REPLY";
      const stopReason = stringValue(message.stopReason || event.stopReason);
      if (stopReason && stopReason !== "stop") {
        if (!noReplySentinel) return { message: replaceAssistantMessageText(message, "NO_REPLY") };
        return;
      }
      const { key: stateKey, state } = getPolicyStateForContext({
        ...ctx,
        sessionKey: stringValue(ctx.sessionKey),
        agentId: stringValue(ctx.agentId),
      });
      if (!noReplySentinel) {
        updateAckTrackingState(stateKey, { final_response_streaming: true, tool_active: false });
        const cancellations = cancelNeutralAckTimersForContext(event, ctx, asRecord(state));
        if (cancellations.length > 0) {
          recordNeutralAckCancellations("before_message_write", cancellations, "reply_streaming", stateKey);
        }
      }
      if (!state) {
        if (noReplySentinel) return;
        const projectedText = appendReplyProjectionFooter(originalText, {}, event, ctx);
        if (projectedText && projectedText !== originalText) {
          return { message: replaceAssistantMessageText(message, projectedText) };
        }
        return;
      }
      const stateRecord = hydrateOutboundStateWithNativeRefs(asRecord(state));
      if (stateRecord !== asRecord(state)) {
        updatePolicyState(stateKey, (current) => ({
          ...(current ?? {}),
          ...stateRecord,
        }));
      }
      if (isNativeAnnounceAlreadyDelivered(stateRecord) && !noReplySentinel) {
        return { message: replaceAssistantMessageText(message, "NO_REPLY") };
      }
      const guarded = guardAssistantMessageForPolicyState(message, stateRecord);
      const visibleMessage = guarded.mode === "replace" && guarded.message ? guarded.message : message;
      const contentText = assistantMessageText(asRecord(visibleMessage));
      let outputMessage = visibleMessage;
      const outputNoReply = contentText.trim().toUpperCase() === "NO_REPLY";
      if (role === "assistant" && contentText && !noReplySentinel && !outputNoReply) {
        completeBudgetedMainIfActive({
          stateKey,
          ctx,
          state: stateRecord,
          decision: asRecord(stateRecord.decision),
          logger: pi.logger,
        });
        const projectedText = appendReplyProjectionFooter(contentText, stateRecord, event, ctx);
        if (projectedText && projectedText !== contentText) {
          outputMessage = replaceAssistantMessageText(asRecord(visibleMessage), projectedText);
        }
        if (isNativeAnnounceDeliveryState(stateRecord)) {
          const deliveredAt = new Date().toISOString();
          const workContractId = stringValue(stateRecord.workContractId || stateRecord.work_contract_id);
          const completion: NativeAnnounceCompletion = {
            sourceSessionKey: stringValue(stateRecord.childSessionKey || stateRecord.child_session_key),
            sourceSessionId: "",
            sourceTool: "subagent_announce",
            status: "completed",
            resultText: "",
            resultHash: stringValue(stateRecord.nativeAnnounceResultHash || stateRecord.native_announce_result_hash),
          };
          if (workContractId) {
            markNativeAnnounceCompletionOnContract(workContractId, completion, true, deliveredAt);
          }
          void recordPolicyReplay(
            "native_announce_final_delivered",
            {
              sessionKey: stateKey,
              sessionId: stringValue(ctx.sessionId),
              workContractId,
              resultHash: completion.resultHash,
            },
            pi.logger,
            asRecord(stateRecord.decision),
          ).catch(() => {});
        }
        updateAckTrackingState(stateKey, { formal_reply_visible: true });
        const stateUpdateKeys = Array.from(new Set([
          stateKey,
          stringValue(stateRecord.canonicalSessionKey),
          stringValue(ctx.sessionKey),
          stringValue(ctx.canonicalSessionKey),
          stringValue(ctx.sessionId),
        ].filter(Boolean)));
        for (const updateKey of stateUpdateKeys) {
          updatePolicyState(updateKey, (current) => ({
            ...(current ?? {}),
            formal_reply_visible: true,
            ...(isNativeAnnounceDeliveryState(stateRecord)
              ? {
                  nativeAnnounceCompletionPending: false,
                  native_announce_completion_pending: false,
                  nativeAnnounceDelivered: true,
                  native_announce_delivered: true,
                  deliveryStatus: "delivered",
                  delivery_status: "delivered",
                  resultMaterialized: true,
                  result_materialized: true,
                }
              : {}),
            outbound_projection_footer_appended: projectedText !== contentText || current?.outbound_projection_footer_appended === true,
            outbound_projection_footer_appended_at: projectedText !== contentText ? new Date().toISOString() : current?.outbound_projection_footer_appended_at,
          }));
        }
      }
      if (outputMessage !== asRecord(event.message)) {
        return { message: outputMessage };
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
