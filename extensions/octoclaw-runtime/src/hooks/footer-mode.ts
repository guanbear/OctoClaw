import { type WorkContract } from "@octoclaw/contracts/work-contract";
import { cancelNeutralAckTimersByCandidates, type CanceledNeutralAckTimer } from "../ack/ack-scheduler.js";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { stringValue } from "../extension-entry-shared.js";
import {
  contractNativeIds,
  findRecentOutboundPolicyState,
  hydrateOutboundStateWithNativeRefs,
  outboundDeliveryContent,
  outboundGuardReplacement,
  outboundLooksLikeVisibleDeliveryHook,
  outboundTargetLooksLikeSlack,
  resolveOutboundPolicyTarget,
  shouldCancelNativeAnnounceDeliveredOutbound,
  updatePolicyState,
} from "../extension-entry.js";
import type { IMProjectionFooter } from "../im/adapter.js";
import { renderIMProjectionFooter } from "../im/projection-footer.js";
import { firstDisplayModel } from "../model-display.js";
import { hasProjectionFooter } from "../projection-footer-sanitizer.js";
import { assistantMessageText, guardAssistantMessageForPolicyState } from "../replay/message-guard.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";

export function projectionFooterMode(): "off" | "compact" | "debug" {
  const mode = stringValue(process.env.OCTOCLAW_PROJECTION_FOOTER_MODE).toLowerCase();
  if (mode === "debug") return "debug";
  if (mode === "compact" || mode === "on" || mode === "1" || mode === "true" || mode === "yes") return "compact";
  const legacyDebug = stringValue(process.env.OCTOCLAW_FOOTER_DEBUG).toLowerCase();
  if (legacyDebug && !["0", "false", "off", "no"].includes(legacyDebug)) return "debug";
  const legacy = stringValue(process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER).toLowerCase();
  if (["0", "false", "off", "no"].includes(legacy)) return "off";
  if (["1", "true", "on", "yes", "compact"].includes(legacy)) return "compact";
  if (legacy === "debug") return "debug";
  return "compact";
}

export function replyProjectionFooterEnabled(): boolean {
  return projectionFooterMode() !== "off";
}

export function footerDebugEnabled(): boolean {
  return projectionFooterMode() === "debug" || Boolean(process.env.OCTOCLAW_FOOTER_DEBUG && !["0", "false", "off"].includes(
    stringValue(process.env.OCTOCLAW_FOOTER_DEBUG).toLowerCase()
  ));
}


export function outboundProjectionSnapshot(state: UnknownRecord): UnknownRecord {
  return asRecord(state.outboundProjection || state.outbound_projection);
}

/**
 * Resolve the model to display in the footer.
 *
 * Priority (authoritative first):
 *   1. `state.replyUsageState.model` / `resolvedRef` — the model that actually
 *      ran this turn (post-fallback), surfaced by openclaw 6.8's
 *      `reply_payload_sending` hook. This is the single source of truth.
 *   2. `spawnModel` — the model pinned to a delegated/native child session,
 *      which legitimately differs from the parent's runtime model.
 *   3. A minimal degraded fallback chain (snapshot → policy selected) used
 *      only when no live usage snapshot is available (e.g. agent turn failed,
 *      durable/replay delivery, or openclaw < 6.8).
 *
 * The previous implementation read `agents.defaults.model.primary` from
 * `openclaw.json` on disk (synchronous IO, every reply) which silently showed
 * a stale static value after a model fallback. That path is removed.
 */
export function resolveDisplayModel(state: UnknownRecord, event: UnknownRecord, ctx: UnknownRecord): string {
  const usageState = asRecord(state.replyUsageState || state.reply_usage_state);
  return resolveUsageAwareDisplayModel(usageState, state, event, ctx);
}

/**
 * Unified model resolver shared by the runtime footer path and the envelope
 * (provenance) footer path so both render the same model for a given turn.
 */
export function resolveUsageAwareDisplayModel(
  usageState: UnknownRecord | null | undefined,
  state: UnknownRecord,
  event: UnknownRecord,
  ctx: UnknownRecord,
): string {
  // 1. Authoritative: the model that actually ran (post-fallback).
  const liveModel = displayModelOrEmpty(
    usageState && asRecord(usageState).resolvedRef,
    usageState && asRecord(usageState).model,
  );
  if (liveModel) return liveModel;

  const decision = asRecord(state.decision);
  const modelPolicy = asRecord(decision.model_policy);
  const workContract = asRecord(decision.work_contract);
  const delegate = asRecord(workContract.delegate);
  const snapshot = outboundProjectionSnapshot(state);

  // 2. Delegated/native child sessions carry their own pinned model.
  const spawnModel = displayModelOrEmpty(
    delegate.modelProfile,
    delegate.model,
    delegate.model_profile,
  );
  if (spawnModel) return spawnModel;

  // 3. Degraded: no live snapshot. Fall back to the most stable persisted
  //    fields only — never read static config, which diverges from reality.
  const runtimeModel = displayModelOrEmpty(
    asRecord(event).model,
    asRecord(event).modelId,
    asRecord(event).model_id,
    asRecord(ctx).model,
    asRecord(ctx).modelId,
    asRecord(ctx).model_id,
  );
  return firstDisplayModel(
    snapshot.model,
    snapshot.modelId,
    snapshot.model_id,
    modelPolicy.selected_model,
    modelPolicy.model,
    runtimeModel || undefined,
    "direct_main",
  );
}

export function displayModelOrEmpty(...values: unknown[]): string {
  const model = firstDisplayModel(...values);
  return model === "unknown" ? "" : model;
}

export function nativeSpawnIntentDisplayModel(contract: WorkContract): string {
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

export function resolveNativeAnnounceDisplayModel(
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

export function resolveFooterComplexityBand(state: UnknownRecord): string {
  const snapshot = outboundProjectionSnapshot(state);
  const decision = asRecord(state.decision);
  const routeDecision = asRecord(decision.route_decision);
  const workContract = asRecord(decision.work_contract);
  const metadata = asRecord(workContract.metadata);
  const workContractDecision = asRecord(workContract.decision);
  const workContractTelemetry = asRecord(workContract.telemetry);
  for (const value of [
    state.complexityBand,
    state.complexity_band,
    snapshot.complexityBand,
    snapshot.complexity_band,
    decision._judge_complexity_band,
    decision.complexityBand,
    decision.complexity_band,
    decision.complexity,
    routeDecision._judge_complexity_band,
    routeDecision.complexity_band,
    routeDecision.complexity,
    metadata.complexityBand,
    metadata.complexity_band,
    workContractDecision.complexityBand,
    workContractDecision.complexity_band,
    workContractDecision.complexity,
    workContractTelemetry.complexityBand,
    workContractTelemetry.complexity_band,
    workContractTelemetry.complexity,
  ]) {
    const band = stringValue(value);
    if (band) return band;
  }
  return "";
}

/** Extract route source label for footer: "judge(0.87)" / "rule" / "fallback" / "agent↑judge=delegate" */
export function resolveRouteSource(state: UnknownRecord): string {
  const snapshot = outboundProjectionSnapshot(state);
  const decision = asRecord(state.decision);
  const routeDecision = asRecord(decision.route_decision);
  const routeHintPolicy = asRecord(decision.route_hint_policy);
  const routeSeal = asRecord(decision.routeSeal || state.routeSeal);
  const routeSealSource = stringValue(routeSeal.source);
  const source = stringValue(routeDecision.route_source || routeDecision.final_judge_source || snapshot.via || snapshot.source);
  const confidence = asRecord(decision).judge_confidence ?? routeDecision.route_confidence;
  const finalRoute = stringValue(routeDecision.route);
  const judgeRoute = stringValue(routeHintPolicy.judge_route || decision._judge_route);
  if (routeSealSource === "accepted_objection" || Boolean(routeHintPolicy.objection_accepted)) {
    return judgeRoute ? `agent↑(judge=${judgeRoute})` : "accepted_objection";
  }

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

export function internalAckProjectionSuppressed(): boolean {
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

export function cancelNeutralAckTimersForContext(event: UnknownRecord, ctx: UnknownRecord, state: UnknownRecord | null | undefined): CanceledNeutralAckTimer[] {
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

export function hasThreadProjection(event: UnknownRecord, ctx: UnknownRecord): boolean {
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

export function appendReplyProjectionFooter(content: string, state: UnknownRecord, event: UnknownRecord, ctx: UnknownRecord): string {
  const safeContent = replaceRawProviderStatusError(content);
  if (!replyProjectionFooterEnabled() || internalAckProjectionSuppressed()) return safeContent;
  // Don't double-stamp
  if (hasProjectionFooter(safeContent)) return safeContent;
  if (/\[ack\s*·/iu.test(safeContent)) return safeContent;

  const decision = asRecord(state.decision);
  const snapshot = outboundProjectionSnapshot(state);
  const workContract = asRecord(decision.work_contract);
  const routeDecision = asRecord(decision.route_decision);
  const projectedRoute = stringValue(workContract.route || routeDecision.route || state.route || snapshot.route || "reply") === "delegate"
    ? "delegate" : "reply";
  const delegateExecutionObserved = hasAcceptedDelegateFooterEvidence(state, decision, workContract);
  const route = projectedRoute === "delegate" && delegateExecutionObserved ? "delegate" : "reply";

  const debug = footerDebugEnabled();

  // Usage snapshot from openclaw 6.8 `reply_payload_sending`. Present on the
  // live dispatcher path (normal replies); absent on durable/replay paths,
  // agent-turn failures, or openclaw < 6.8 — in those cases the footer
  // degrades and surfaces a `health=no-usage` note.
  const usageState = asRecord(state.replyUsageState || state.reply_usage_state);
  const hasLiveUsage = usageState && Object.keys(usageState).length > 0;
  const fallbackUsed = hasLiveUsage && usageState.fallbackUsed === true;
  const requestedModel = fallbackUsed
    ? stringValue(usageState.requested)
    : "";
  const durationMs = hasLiveUsage && typeof usageState.durationMs === "number"
    ? Number(usageState.durationMs)
    : undefined;

  // Runtime owns the channel-neutral projection facts; IM adapters own
  // surface-specific rendering and legacy transport compatibility.
  const projection: IMProjectionFooter = {
    route,
    model: resolveDisplayModel(state, event, ctx),
    mode: debug ? "debug" : "compact",
    complexityBand: resolveFooterComplexityBand(state),
    via: resolveRouteSource(state),
    thread: hasThreadProjection(event, ctx),
    healthNote: hasLiveUsage ? resolveHealthFooterNote(state) : (resolveHealthFooterNote(state) || "no-usage"),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(fallbackUsed ? { fallbackUsed: true, requestedModel } : {}),
    usageSource: hasLiveUsage ? "live" : "degraded",
    ...(debug ? {
      workerPool: stringValue(routeDecision.worker_pool || snapshot.workerPool || snapshot.worker_pool),
      workContractId: stringValue(workContract.workContractId || decision.workContractId || snapshot.workContractId || snapshot.work_contract_id),
    } : {}),
  };
  return renderIMProjectionFooter({
    content: safeContent.trim(),
    projection,
    sessionKey: stringValue(ctx.sessionKey || event.sessionKey || event.session_key),
    channel: resolveProjectionChannel(event, ctx),
  });
}

function hasAcceptedDelegateFooterEvidence(state: UnknownRecord, decision: UnknownRecord, workContract: UnknownRecord): boolean {
  const nativeRefs = asRecord(workContract.nativeSpawnRefs || workContract.native_spawn_refs);
  const nativeBinding = asRecord(asRecord(workContract.delegate).nativeBinding || asRecord(workContract.delegate).native_binding);
  return Boolean(
    stringValue(workContract.openclawRunId || workContract.openclaw_run_id)
    || stringValue(workContract.childSessionKey || workContract.child_session_key)
    || stringValue(state.runId || state.run_id)
    || stringValue(state.childRunId || state.child_run_id)
    || stringValue(state.childSessionKey || state.child_session_key)
    || stringValue(nativeRefs.openclawRunId || nativeRefs.openclaw_run_id)
    || stringValue(nativeRefs.childSessionKey || nativeRefs.child_session_key)
    || stringValue(nativeBinding.runId || nativeBinding.run_id)
    || stringValue(nativeBinding.childRunId || nativeBinding.child_run_id)
    || stringValue(nativeBinding.childSessionKey || nativeBinding.child_session_key)
    || stringValue(asRecord(decision.runtime_truth).nativeRunId || asRecord(decision.runtime_truth).native_run_id)
  );
}

function replaceRawProviderStatusError(content: string): string {
  const trimmed = content.trim();
  const match = /^([1-5]\d\d)\s+status\s+code(?:\s+\(no body\))?$/i.exec(trimmed);
  if (!match) return content;
  return `模型调用失败：上游返回 HTTP ${match[1]}。已避免把底层错误当作正常回答发送，请重试或切到备用模型。`;
}

function resolveHealthFooterNote(state: UnknownRecord): string | undefined {
  const decision = asRecord(state.decision);
  const routeDecision = asRecord(decision.route_decision);
  const codes = [
    ...stringArray(state.routerLiteReasonCodes),
    ...stringArray(state.router_lite_reason_codes),
    ...stringArray(decision.reasonCodes),
    ...stringArray(decision.reason_codes),
    ...stringArray(routeDecision.reasonCodes),
    ...stringArray(routeDecision.reason_codes),
  ];
  const cooldown = codes.find((code) => code.startsWith("cooldown:"));
  if (!cooldown) return undefined;
  const [, reason, model] = cooldown.split(":");
  return `downgraded: ${reason || "cooldown"}${model ? ` on ${model}` : ""}`;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter(Boolean);
}

export function resolveProjectionChannel(event: UnknownRecord, ctx: UnknownRecord): string {
  const metadata = asRecord(event.metadata);
  const direct = stringValue(ctx.channel || ctx.channelId || event.channel || metadata.channel);
  if (direct.toLowerCase() === "slack" || direct.toLowerCase().startsWith("slack:")) return "slack";
  const target = stringValue(event.to || metadata.channelId || metadata.channel_id || ctx.conversationId || ctx.conversation_id);
  if (outboundTargetLooksLikeSlack(target)) return "slack";
  return direct;
}

function isLeakedNoReplyTranscript(content: string): boolean {
  const normalized = content.trim();
  if (!/^NO_REPLY\b/iu.test(normalized)) return false;
  if (normalized.toUpperCase() === "NO_REPLY") return true;
  return /\bto=functions\.[a-z0-9_]+\b/iu.test(normalized)
    || /\b(?:tool_calls|tool_use|tooluse)\b/iu.test(normalized)
    || /\bfunctions\.[a-z0-9_]+\b/iu.test(normalized)
    || /\b(?:subagent|subagents|subagent_announce)\b/iu.test(normalized);
}

export function guardOutboundMessageForPolicyState(event: UnknownRecord, ctx: UnknownRecord, now = Date.now()): { content?: string; message?: UnknownRecord; cancel?: boolean } | undefined {
  const content = outboundDeliveryContent(event);
  if (!content) return undefined;
  if (isLeakedNoReplyTranscript(content)) return { cancel: true };
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
