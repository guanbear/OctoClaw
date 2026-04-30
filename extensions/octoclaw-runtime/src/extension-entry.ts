import {
  buildConversationGrounding,
  buildDirectLookupGuard,
} from "./conversation-grounding.js";
import {
  buildStatusQueryPacket,
} from "./core/delegate/index.js";
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
  getAckTrackingState,
  maybeSendLatencyAck,
  notifyUserMessage,
  startAckGuard,
  updateAckGuardDecision,
  updateAckTrackingState,
  watchdogTick,
  WATCHDOG_INTERVAL_MS,
} from "./ack/ack-guard.js";
import { sendDelegateWithoutDispatchNotice } from "./ack/ack-delegate-without-dispatch.js";
import { flushDeliveryOutbox } from "./delivery/delivery-outbox.js";
import { sendRouteCommitAck } from "./ack/ack-route-commit.js";
import { fetchLatestUserMessageTsForSessionKey } from "./im/slack-thread-anchor.js";
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
import { buildTurnExecutionReceipt, type TurnExecutionReceipt } from "./receipt.js";
import { resolveModelId } from "@octoclaw/policy/model";
import {
  assistantMessageText,
  guardAssistantMessageForPolicyState,
} from "./replay/message-guard.js";
import {
  compactPolicyPrompt,
  isControlObserverDecision,
  isDelegatedRoute,
  isSessionControlDecision,
  matchesBlockedPattern,
  observerControlTools,
  preHintAllowedTools,
  routeHintRequired,
  sessionControlTools,
  shouldRetainPolicyStateOnAgentEnd,
  stringifyParamsForPolicy,
  workflowEnforcementRule,
} from "./replay/policy-utils.js";
import { recordAckReplay, recordPolicyReplay } from "./replay/replay.js";
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
  runtime?: { subagent?: import("./tools/registration.js").OpenClawSubagentRuntime };
}

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
let deliveryOutboxInterval: ReturnType<typeof setInterval> | null = null;

function runDeliveryOutboxFlush(logger?: LoggerLike): void {
  void flushDeliveryOutbox({ logger }).then((result) => {
    if (result.attempted > 0 || result.delivered > 0 || result.failed > 0) {
      logger?.debug?.(`octoclaw delivery outbox flush attempted=${result.attempted} delivered=${result.delivered} failed=${result.failed} remaining=${result.remaining}`);
    }
  }).catch((error) => {
    logger?.warn?.(`octoclaw delivery outbox flush failed: ${String(error)}`);
  });
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

function normalizeOutboundTargetKey(value: unknown): string {
  return stringValue(value)
    .toLowerCase()
    .replace(/^channel:/u, "")
    .replace(/^user:/u, "")
    .replace(/[^a-z0-9_.:-]+/gu, "");
}

function outboundMessageAnchors(event: UnknownRecord, ctx: UnknownRecord): string[] {
  const prompt = [
    stringValue(event.content),
    extractPromptText(event),
    extractPromptText(ctx),
  ].filter(Boolean).join("\n");
  const anchors = [
    extractInboundMessageTimestamp(ctx, event, prompt),
    findInboundMessageTimestamp(event),
    findInboundMessageTimestamp(ctx),
    stringValue(event.replyToMessageId),
    stringValue(event.reply_to_id),
    stringValue(event.threadTs),
    stringValue(event.thread_ts),
    stringValue(event.message_id),
    stringValue(event.messageId),
    stringValue(ctx.replyToMessageId),
    stringValue(ctx.reply_to_id),
    stringValue(ctx.threadTs),
    stringValue(ctx.thread_ts),
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
    stringValue(requestMetadata.message_id),
    stringValue(requestMetadata.messageId),
    stringValue(requestMetadata.inboundMessageTs),
    stringValue(requestMetadata.reply_to_id),
    stringValue(requestMetadata.thread_ts),
  ];
  return anchors.some((anchor) => candidates.includes(anchor) || key.includes(`:thread:${anchor}`));
}

function policyStateLooksRelevantForOutbound(key: string, state: PolicyStateEntry, targetKey: string, anchors: string[], now: number): boolean {
  if (!targetKey || !key.toLowerCase().includes(targetKey)) return false;
  const updatedAt = Number(state.updatedAt || state.createdAt || 0);
  if (!Number.isFinite(updatedAt) || now - updatedAt > 3 * 60 * 1000) return false;
  if (anchors.length > 0 && !stateMatchesOutboundAnchor(key, state, anchors)) return false;
  return Object.keys(asRecord(state.decision)).length > 0;
}

function outboundLooksLikeVisibleDeliveryHook(event: UnknownRecord): boolean {
  const metadata = asRecord(event.metadata);
  if (Boolean(
    metadata.channel
    || metadata.channelId
    || metadata.threadTs
    || metadata.thread_ts
    || metadata.accountId
    || Array.isArray(metadata.mediaUrls),
  )) return true;
  // Also treat Slack delivery targets as visible:
  // event.to can be a Slack user/channel ID (U*/C*) or contain "slack" when
  // OpenClaw sends via native Slack transport without standard metadata fields.
  const to = stringValue(event.to).toLowerCase();
  if (to.includes("slack")) return true;
  // Slack channel IDs: C + 8-11 alphanumeric chars; user IDs: U + 8-11 chars; DM channel IDs: D + 8-11 chars
  if (/^[cud][a-z0-9]{8,11}$/i.test(stringValue(event.to))) return true;
  return false;
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
    const updatedAt = Number(entry.state.updatedAt || entry.state.createdAt || 0);
    if (!anchored && now - updatedAt > 90 * 1000) continue;
    if (!best || updatedAt > best.updatedAt) {
      best = { key: entry.key, state: entry.state, updatedAt };
    }
  }
  return best ? { key: best.key, state: best.state, anchored } : null;
}


function replyProjectionFooterEnabled(): boolean {
  const raw = stringValue(process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER).toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function footerDebugEnabled(): boolean {
  return Boolean(process.env.OCTOCLAW_FOOTER_DEBUG && !["0", "false", "off"].includes(
    stringValue(process.env.OCTOCLAW_FOOTER_DEBUG).toLowerCase()
  ));
}

function firstStringValue(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

/** Resolve a model profile (e.g. "direct_main") or raw model string to a short display name. */
function resolveDisplayModel(state: UnknownRecord, event: UnknownRecord, ctx: UnknownRecord): string {
  const decision = asRecord(state.decision);
  const modelPolicy = asRecord(decision.model_policy);
  const runtimeTruth = asRecord(decision.runtime_truth);

  // Try raw model ID first (from event/ctx injected by OpenClaw runtime)
  const rawModel = firstStringValue(
    event.model,
    event.modelId,
    event.model_id,
    ctx.model,
    ctx.modelId,
    ctx.model_id,
  );

  // Try profile-based resolution: selected_model may be a profile name OR an actual model ID
  const profileOrId = firstStringValue(
    modelPolicy.selected_model,
    modelPolicy.model,
    state.modelProfile,
    state.model_profile,
    runtimeTruth.model,
    decision.model,
  );

  const candidate = rawModel || profileOrId;
  if (!candidate) return "unknown";

  // If it looks like a profile name, resolve to actual model ID
  const resolved = (() => {
    try { return resolveModelId(candidate as Parameters<typeof resolveModelId>[0]); } catch { return null; }
  })();
  const fullModelId = resolved || candidate;

  // Shorten: "zhipu/GLM-5.1" → "GLM-5.1", "omniroute/cx/gpt-5.4" → "gpt-5.4"
  const parts = fullModelId.split("/");
  return parts[parts.length - 1] || fullModelId;
}

/** Extract route source label for footer: "judge(0.87)" / "rule" / "fallback" / "agent↑judge=delegate" */
function resolveRouteSource(state: UnknownRecord): string {
  const decision = asRecord(state.decision);
  const routeDecision = asRecord(decision.route_decision);
  const routeHintPolicy = asRecord(decision.route_hint_policy);
  const source = stringValue(routeDecision.route_source || routeDecision.final_judge_source);
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
  return source || "policy";
}

/**
 * Heuristic: is this message a short ACK/notification rather than a real response?
 * ACK texts are always single-line and ≤50 chars.
 * Real agent replies are almost always longer or multi-line.
 * Threshold is intentionally tight: we prefer to misclassify a rare short real reply
 * (shows "route=reply | ..." instead of "[ack]") rather than incorrectly labelling
 * a real response as an ACK.
 */
function isAckLikeContent(content: string): boolean {
  const trimmed = content.trim();
  return !trimmed.includes("\n") && trimmed.length <= 50;
}

function appendReplyProjectionFooter(content: string, state: UnknownRecord, event: UnknownRecord, ctx: UnknownRecord): string {
  if (!replyProjectionFooterEnabled()) return content;
  // Don't double-stamp
  if (/route=\w+\s*\|/u.test(content)) return content;
  if (/\[ack\s*·/iu.test(content)) return content;

  const decision = asRecord(state.decision);
  const workContract = asRecord(decision.work_contract);
  const routeDecision = asRecord(decision.route_decision);
  const route = stringValue(workContract.route || routeDecision.route || state.route || "reply") === "delegate"
    ? "delegate" : "reply";

  const debug = footerDebugEnabled();

  // Short single-line messages → ACK footer
  if (isAckLikeContent(content)) {
    const ackRoute = route === "delegate" ? " · route=delegate" : "";
    const debugSuffix = debug
      ? ` · via=${resolveRouteSource(state)}` : "";
    return `${content.trim()}\n[ack${ackRoute}${debugSuffix}]`;
  }

  // Full response footer
  const model = resolveDisplayModel(state, event, ctx);
  const via = resolveRouteSource(state);
  const workerPool = debug ? stringValue(routeDecision.worker_pool) : "";
  const wc = debug ? stringValue(workContract.workContractId || decision.workContractId) : "";
  const debugParts = debug
    ? [workerPool && `worker=${workerPool}`, wc && `wc=${wc.slice(0, 8)}`].filter(Boolean).join(" | ")
    : "";

  const footer = [`route=${route}`, `model=${model}`, `via=${via}`, debugParts].filter(Boolean).join(" | ");
  return `${content.trim()}\n\n${footer}`;
}

export function guardOutboundMessageForPolicyState(event: UnknownRecord, ctx: UnknownRecord, now = Date.now()): { content?: string; cancel?: boolean } | undefined {
  const content = stringValue(event.content);
  if (!content) return undefined;
  const visibleDelivery = outboundLooksLikeVisibleDeliveryHook(event);
  const match = findRecentOutboundPolicyState(event.to, event, ctx, now, {
    allowUnanchoredDelivery: visibleDelivery,
  });
  if (!match) {
    if (!visibleDelivery) return undefined;
    const fallbackReplacement = appendReplyProjectionFooter(content, {}, event, ctx);
    return fallbackReplacement && fallbackReplacement !== content ? { content: fallbackReplacement } : undefined;
  }
  const stateRecord = asRecord(match.state);
  const guarded = match.anchored
    ? guardAssistantMessageForPolicyState(
        { role: "assistant", content: [{ type: "text", text: content }] },
        stateRecord,
      )
    : { mode: "pass" as const };
  const guardedReplacement = guarded.mode === "replace" && guarded.message
    ? assistantMessageText(asRecord(guarded.message))
    : "";
  const baseContent = guardedReplacement || content;
  const replacement = appendReplyProjectionFooter(baseContent, stateRecord, event, ctx);
  if (!replacement || replacement === content) return undefined;
  updatePolicyState(match.key, (current) => ({
    ...(current ?? {}),
    outbound_guard_replaced: guardedReplacement ? true : current?.outbound_guard_replaced,
    outbound_guard_replaced_at: guardedReplacement ? new Date(now).toISOString() : current?.outbound_guard_replaced_at,
    outbound_projection_footer_appended: replacement !== baseContent || current?.outbound_projection_footer_appended === true,
    outbound_projection_footer_appended_at: replacement !== baseContent ? new Date(now).toISOString() : current?.outbound_projection_footer_appended_at,
  }));
  return { content: replacement };
}

const SLACK_MESSAGE_TS_PATTERN = /^\d{10}\.\d{6}$/u;
const INBOUND_MESSAGE_TS_KEYS = new Set([
  "ts",
  "messageTs",
  "message_ts",
  "messageId",
  "message_id",
  "eventTs",
  "event_ts",
  "replyToId",
  "reply_to_id",
  "threadTs",
  "thread_ts",
]);

function findInboundMessageTimestamp(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    const text = value.trim();
    return SLACK_MESSAGE_TS_PATTERN.test(text) ? text : "";
  }
  if (typeof value !== "object" || Array.isArray(value)) return "";
  if (seen.has(value)) return "";
  seen.add(value);
  const record = value as UnknownRecord;
  for (const key of INBOUND_MESSAGE_TS_KEYS) {
    const direct = findInboundMessageTimestamp(record[key], depth + 1, seen);
    if (direct) return direct;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (INBOUND_MESSAGE_TS_KEYS.has(key)) continue;
    const nested = findInboundMessageTimestamp(entry, depth + 1, seen);
    if (nested) return nested;
  }
  return "";
}

export function extractInboundMessageTimestamp(ctx: UnknownRecord, event: UnknownRecord, prompt = ""): string {
  // 1. Known key names in ctx/event (fast path)
  const fromContext = findInboundMessageTimestamp(ctx);
  if (fromContext) return fromContext;
  const fromEvent = findInboundMessageTimestamp(event);
  if (fromEvent) return fromEvent;
  // 2. JSON key-value in prompt: "ts": "1234567890.123456"
  const msgIdMatch = prompt.match(/"(?:reply_to_id|message_id|message_ts|event_ts|thread_ts|ts)"\s*:\s*"(\d{10}\.\d{6})"/u);
  if (msgIdMatch) return stringValue(msgIdMatch[1]);
  // 3. Broad scan: any Slack ts-shaped string in ALL ctx/event field values
  // Covers cases where OpenClaw uses non-standard key names (slackTs, inboundTs, etc.)
  const fromCtxBroad = findAnySlackTs(ctx);
  if (fromCtxBroad) return fromCtxBroad;
  const fromEventBroad = findAnySlackTs(event);
  if (fromEventBroad) return fromEventBroad;
  // 4. Raw text in prompt — Slack ts can appear as bare number, e.g. ts=1777500517.132259
  const rawMatch = prompt.match(/(?:^|[\s"'=,:{[])(\d{10}\.\d{6})(?:$|[\s"',}\]:])/mu);
  if (rawMatch) return stringValue(rawMatch[1]);
  return "";
}

/** Scan ALL string values in an object tree for a Slack ts pattern.
 * Used as a fallback when the key name is non-standard. */
function findAnySlackTs(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    // Only match strings that look like a standalone Slack ts (not embedded in a larger number)
    if (SLACK_MESSAGE_TS_PATTERN.test(value.trim())) return value.trim();
    // Also match if the whole string IS the ts pattern
    const m = value.match(/^(\d{10}\.\d{6})$/u);
    if (m) return m[1];
    return "";
  }
  if (typeof value !== "object" || Array.isArray(value)) return "";
  if (seen.has(value as object)) return "";
  seen.add(value as object);
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = findAnySlackTs(v, depth + 1, seen);
    if (found) return found;
  }
  return "";
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
  if (best) return { key: best.key, state: best.state };
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
    if (pi.pluginConfig?.enabled === false) return void pi.logger?.info?.("octoclaw-runtime: disabled via config (enabled=false), skipping hook registration");

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
    });
    const applyReactionAckState = (state: PolicyStateEntry | null | undefined, sessionKey = ""): void => {
      if (!state) return;
      Object.assign(state, buildReactionAckState(sessionKey));
    };

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

    registerLifecycleHook("message_sending", (event, ctx) => {
      return guardOutboundMessageForPolicyState(event, ctx);
    }, 220);

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
      preMetadata._delegationEnabled = delegationEnabled;
      const preSessionKey = resolveAckDeliverySessionKey(preMetadata, preStateKey, asRecord(getPolicyStateForContext(ctx).state), ctx);

      if (preSessionKey) {
        notifyUserMessage(preSessionKey, preStateKey);
      }

      let inboundMessageTs = extractInboundMessageTimestamp(
        ctx,
        event,
        [prompt, extractPromptText(asRecord(event))].filter(Boolean).join("\n"),
      );

      // Route C: ctx.channelId is the channel TYPE ("slack"), not the channel ID.
      // For Slack DMs, derive the real DM channel ID from the session key user ID
      // via conversations.open, then query conversations.history for the latest ts.
      if (!inboundMessageTs) {
        const sessionKey = stringValue(ctx.sessionKey);
        if (sessionKey.includes(":slack:") && sessionKey.includes(":direct:")) {
          inboundMessageTs = await fetchLatestUserMessageTsForSessionKey(sessionKey);
          if (inboundMessageTs && process.env.OCTOCLAW_ACK_DEBUG) {
            console.error(`[ack-dbg] thread anchor from Route C: sessionKey=${sessionKey.substring(0,60)} ts=${inboundMessageTs}`);
          }
        }
      }

      if (process.env.OCTOCLAW_ACK_DEBUG) {
        // Log what we extracted so we can debug thread anchor issues
        const ctxKeys = Object.keys(ctx).join(",");
        console.error(`[ack-dbg] inboundMessageTs=${inboundMessageTs || "(empty)"} sessionKey=${stringValue(ctx.sessionKey).substring(0,50)} ctxKeys=${ctxKeys.substring(0,120)}`);
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
          const latencyResult = await maybeSendLatencyAck(currentDecision, latencyMetadata, timerStateKey, asRecord(getPolicyStateForContext(ctx).state), ctx, pi.logger ?? {}, "direct_lookup");
          if (latencyResult?.sent) {
            cancelAckGuard(preSessionKey);
          }
        }, LATENCY_ACK_DELAY_MS);
        pendingLatencyAckTimers.set(timerStateKey, timer);
      };

      if (preSessionKey) {
        if (process.env.OCTOCLAW_ACK_DEBUG) {
          console.error(`[ack-dbg] preSessionKey=${preSessionKey.substring(0,40)} inboundMessageTs=${inboundMessageTs || "(empty)"}`);
        }
        startAckGuard(preSessionKey, stringValue(ctx.cwd) || process.cwd(), {
          stateKey: preStateKey,
          decision: {},
          state: buildReactionAckState(preSessionKey),
          replyToMessageId: inboundMessageTs,
        });
      }
      const preliminaryState = getPolicyStateForContext(ctx).state;
      if (preliminaryState) {
        applyReactionAckState(preliminaryState, preSessionKey);
        preliminaryState.ackGuardKey = preSessionKey || "";
        if (inboundMessageTs) {
          preliminaryState.inboundMessageTs = inboundMessageTs;
        }
      }

      startLatencyAckTimer(preStateKey);

      const resolved = await resolvePolicyDecisionForContext(
        prompt,
        ctx,
        process.cwd(),
        pi.logger,
      ).catch((judgeErr: unknown) => {
        if (pi.logger?.warn) {
          pi.logger.warn(`octoclaw judge failed: ${String(judgeErr)}`);
        }
        return null;
      });
      pendingDecision.value = asRecord(resolved?.decision);

      if (resolved) {
        const postDecision = asRecord(resolved?.decision);
        updateAckGuardDecision(preStateKey || preSessionKey, postDecision ?? {});
      }

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
      if (stateKey) {
        updatePolicyState(stateKey, (current) => ({
          ...current,
          ...buildReactionAckState(preSessionKey),
          ackGuardKey: preSessionKey || current.ackGuardKey || "",
          inboundMessageTs: inboundMessageTs || current.inboundMessageTs,
        }));
      }
      if (effectiveState) {
        applyReactionAckState(effectiveState, preSessionKey);
        effectiveState.ackGuardKey = preSessionKey || "";
        if (inboundMessageTs) {
          effectiveState.inboundMessageTs = inboundMessageTs;
        }
      }

      // D1: Route Commit ACK — send truthful ACK projection after route seal, before dispatch.
      // For delegate/observe routes: send immediately (user needs to know task was delegated).
      // For reply routes: delay 500ms so fast local models don't produce a simultaneous ACK+reply.
      // At fire time, check firstTokenSeen/formalReplyVisible — if agent already responded, skip.
      const routeCommitRoute = stringValue(asRecord(asRecord(effectiveDecision).route_decision).route);
      const isReplyRoute = routeCommitRoute !== "delegate" && routeCommitRoute !== "observe";
      const routeCommitAckParams = {
        sessionKey: preSessionKey || stringValue(ctx.sessionKey) || "",
        stateKey: stringValue(resolved?.stateKey || resolvePolicyStateKey(ctx) || ""),
        decision: effectiveDecision ?? {},
        state: asRecord(effectiveState),
        replyToMessageId: inboundMessageTs,
        cwd: stringValue(ctx.cwd) || process.cwd(),
        logger: pi.logger,
      };
      const doSendRouteCommitAck = async () => {
        try {
          const liveState = getPolicyStateForContext(ctx).state;
          // For reply routes: cancel if agent has already started responding.
          // Check ack tracking state (reliable even when policyState is null/stale)
          // as well as policy state fields (both camelCase and snake_case variants).
          if (isReplyRoute) {
            const trackingStateKey = routeCommitAckParams.stateKey || preStateKey;
            const tracking = getAckTrackingState(trackingStateKey);
            const ls = liveState as UnknownRecord | null;
            const alreadyReplied =
              Boolean(tracking.formal_reply_visible)
              || Boolean(ls?.formal_reply_visible)
              || Boolean(ls?.formalReplyVisible)
              || Boolean(ls?.finalResponseStreaming)
              || Boolean(ls?.final_response_streaming)
              || Boolean(ls?.delivered)
              || Boolean(ls?.firstTokenSeen)
              || Boolean(ls?.first_token_seen);
            if (alreadyReplied) {
              pi.logger?.debug?.("octoclaw route-commit-ack: skipped, agent already responded");
              return;
            }
            // Second check: wait 600ms more, then check again.
            // Handles models that respond in the 800ms–1400ms window (check 1 passed
            // but model responds before sendRouteCommitAck HTTP call completes).
            await new Promise<void>((r) => { const t = setTimeout(r, 600); (t as unknown as { unref?: () => void }).unref?.(); });
            const tracking2 = getAckTrackingState(trackingStateKey);
            if (Boolean(tracking2.formal_reply_visible)) {
              pi.logger?.debug?.("octoclaw route-commit-ack: skipped on second check, agent responded during wait");
              return;
            }
          }
          const routeCommitResult = await sendRouteCommitAck({
            ...routeCommitAckParams,
            state: asRecord(liveState ?? effectiveState),
          });
          if (routeCommitResult.sent && effectiveState) {
            effectiveState.routeCommitAckSent = true;
            effectiveState.route_commit_ack_sent = true;
            effectiveState.routeCommitAckId = routeCommitResult.routeCommitId;
          }
        } catch (routeCommitErr) {
          pi.logger?.warn?.(`octoclaw route-commit-ack error: ${String(routeCommitErr)}`);
        }
      };
      if (isReplyRoute) {
        // Delay for reply routes: cancel if agent starts within 500ms
        const REPLY_ACK_DELAY_MS = 800;
        const replyAckTimer = setTimeout(() => { void doSendRouteCommitAck(); }, REPLY_ACK_DELAY_MS);
        (replyAckTimer as unknown as { unref?: () => void }).unref?.();
      } else {
        void doSendRouteCommitAck();
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
      const toolName = stringValue(event.toolName || ctx.toolName);
      const toolParams = asRecord(event.params || event.arguments || event.input);
      let { key: stateKey, state } = getPolicyStateForContext(ctx);
      if (toolName === "octoclaw_dispatch") {
        const taskPolicyContext = policyState.getToolPolicyContext(ctx, stringValue(toolParams.task));
        const taskDecision = asRecord(taskPolicyContext.state?.decision);
        const taskRoute = stringValue(asRecord(taskDecision.route_decision).route);
        const taskToolPolicy = asRecord(taskDecision.tool_policy);
        const taskRouteHintPolicy = asRecord(taskDecision.route_hint_policy);
        const taskUpdatedAt = Number(taskPolicyContext.state?.updatedAt || taskPolicyContext.state?.createdAt || 0);
        const currentUpdatedAt = Number(state?.updatedAt || state?.createdAt || 0);
        const taskHasSubmittedHint = taskPolicyContext.state?.routeHintSubmitted === true || taskRouteHintPolicy.submitted === true;
        const taskAllowsDispatch = taskRoute === "delegate"
          && taskHasSubmittedHint
          && (!currentUpdatedAt || taskUpdatedAt >= currentUpdatedAt)
          && (stringValue(taskToolPolicy.must_delegate_via) === "octoclaw_dispatch"
            || stringArray(taskToolPolicy.allowed_control_tools).includes("octoclaw_dispatch"));
        if (taskAllowsDispatch) {
          stateKey = stringValue(taskPolicyContext.key) || stateKey;
          state = taskPolicyContext.state as PolicyStateEntry | null;
        }
      }
      const decision = asRecord(state?.decision);
      const hookConfig = asRecord(asRecord(decision.hook_interface).before_tool_call);
      if (!hookConfig.enabled) return;

      const routeHintTool = stringValue(hookConfig.route_hint_tool || "octoclaw_route_hint");
      const routeHintIsRequired = routeHintRequired(decision) || Boolean(hookConfig.route_hint_required);
      const delegationEnforcementEnabled = Boolean(hookConfig.delegate_required || hookConfig.delegation_enforcement);
      const routeHintAlreadySubmitted = Boolean(state?.routeHintSubmitted) || Boolean(asRecord(decision.route_hint_policy).submitted);
      const allowedPreHintTools = preHintAllowedTools(decision, routeHintTool);
      const allowedObserverTools = observerControlTools(decision, routeHintTool);
      const allowedSessionTools = sessionControlTools(decision, routeHintTool);
      const toolPolicy = asRecord(decision.tool_policy);
      const metadata = buildPolicyMetadata(ctx, { stateKey });
      if (["octoclaw_status", "octoclaw_task_action"].includes(toolName)) {
        updatePolicyState(stateKey, (current) => ({
          ...current,
          controlToolsSeen: Array.from(new Set([
            ...(Array.isArray(current?.controlToolsSeen) ? current.controlToolsSeen : []),
            toolName,
          ])),
        }));
      }
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
        const latencyAck = await maybeSendLatencyAck(decision, metadata, stateKey, asRecord(state), ctx, pi.logger ?? {}, toolName);
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
        void recordPolicyReplay(
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
        ).catch(() => {});
        void recordPolicyReplay(
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
        ).catch(() => {});
      }

      if (isControlObserverDecision(decision)) {
        if (allowedObserverTools.has(toolName)) {
          return;
        }
        updatePolicyState(stateKey, (current) => ({
          ...current,
          blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
        }));
        void recordPolicyReplay(
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
        ).catch(() => {});
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
        void recordPolicyReplay(
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
        ).catch(() => {});
        return {
          block: true,
          blockReason: `OctoClaw current-session control request must use session control tools only: ${[...allowedSessionTools].join(", ")}.`,
        };
      }

      const routeAllowsDirectTools = stringValue(asRecord(decision.route_decision).route) === "reply"
        || Boolean(toolPolicy.allow_direct_tools);
      const directReplyToolsAllowed = routeAllowsDirectTools
        && !isControlObserverDecision(decision)
        && !isSessionControlDecision(decision);
      if (routeHintIsRequired && !routeHintAlreadySubmitted && !directReplyToolsAllowed && !allowedPreHintTools.has(toolName)) {
        updatePolicyState(stateKey, (current) => ({
          ...current,
          blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
        }));
        void recordPolicyReplay(
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
        ).catch(() => {});
        return {
          block: true,
          blockReason: `OctoClaw runtime policy requires ${routeHintTool} before using other tools.`,
        };
      }

      const workContractProjection = asRecord(decision.work_contract);
      const forbiddenContractTools = new Set(stringArray(workContractProjection.forbiddenTools || workContractProjection.forbidden_tools));
      const routeDecision = asRecord(decision.route_decision);
      const isDeterministicFallbackToDelegate = stringValue(routeDecision.route) === "delegate"
        && (stringValue(routeDecision.route_source) === "fallback" || stringValue(routeDecision.fallback_reason).includes("explicit_delegate"));
      if (forbiddenContractTools.has(toolName) && !isDeterministicFallbackToDelegate) {
        void recordPolicyReplay(
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
        ).catch(() => {});
        return {
          block: true,
          blockReason: `OctoClaw WorkContract forbids ${toolName} for this turn.`,
        };
      }
      const blockedPatterns = Array.isArray(toolPolicy.block_tool_patterns)
        ? toolPolicy.block_tool_patterns.map((item) => stringValue(item)).filter(Boolean)
        : [];
      const delegateTool = stringValue(toolPolicy.must_delegate_via || "octoclaw_dispatch");
      const isPolicyControlTool = toolName.startsWith("octoclaw_") || toolName === routeHintTool || toolName === delegateTool;
      if (!isPolicyControlTool && matchesBlockedPattern(stringifyParamsForPolicy(event.params), blockedPatterns)) {
        void recordPolicyReplay(
          "tool_blocked_manual_delegation",
          {
            sessionKey: stateKey || "",
            sessionId: stringValue(ctx.sessionId),
            route: stringValue(asRecord(decision.route_decision).route),
            toolName,
          },
          pi.logger,
          decision,
        ).catch(() => {});
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
      void recordPolicyReplay(
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
      ).catch(() => {});
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
        policyState.update(stateKey, () => ({
          canonicalSessionKey: stateKey,
          latestExecutionReceipt: finalReceipt,
          workContractId: finalReceipt.workContractId ?? undefined,
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
      const stopReason = stringValue(message.stopReason || event.stopReason);
      if (stopReason && stopReason !== "stop") return;
      const { key: stateKey, state } = getPolicyStateForContext({
        ...ctx,
        sessionKey: stringValue(ctx.sessionKey),
        agentId: stringValue(ctx.agentId),
      });
      if (!state) return;
      updateAckTrackingState(stateKey, { final_response_streaming: true, tool_active: false });
      const stateRecord = asRecord(state);
      const guarded = guardAssistantMessageForPolicyState(message, stateRecord);
      const visibleMessage = guarded.mode === "replace" && guarded.message ? guarded.message : message;
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
      if (visibleMessage !== asRecord(event.message)) {
        return { message: visibleMessage };
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

    if (deliveryOutboxInterval) {
      clearInterval(deliveryOutboxInterval);
    }
    runDeliveryOutboxFlush(pi.logger);
    deliveryOutboxInterval = setInterval(() => {
      runDeliveryOutboxFlush(pi.logger);
    }, 30_000);

    if (typeof pi.registerTool === "function") {
      for (const tool of getToolRegistrations({ subagentRuntime: pi.runtime?.subagent })) {
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
