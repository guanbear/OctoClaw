import { cancelAckGuardForState, updateAckTrackingState } from "../ack/ack-guard.js";
import { sendDelegateWithoutDispatchNotice } from "../ack/ack-delegate-without-dispatch.js";
import {
  lastGroundedPromptByStateKey,
  pendingLatencyAckTimers,
} from "../ack/ack-scheduler.js";
import { resolveWorkspaceRoot } from "../resolve/env.js";
import { isManagedAgentContext } from "../resolve/session.js";
import { shouldRetainPolicyStateOnAgentEnd } from "../replay/policy-utils.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { policyState, type PolicyStateEntry } from "../state/policy-state.js";
import { buildTurnExecutionReceipt } from "../receipt.js";
import { recordRuntimeCostEventAndBudget } from "../router-cost-runtime.js";
import { recordRuntimeHealthCall } from "../router-lite/health-recorder.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import { stringValue } from "../extension-entry-shared.js";
import { clearBudgetedMainTimer } from "../budgeted-main.js";
import { sendIMMessage, type SendIMParams, type SendIMResult } from "../im/send.js";
import {
  recordReplyFinalDeliveryResultForState,
  recordReplyFinalDeliverySkipForState,
  recordReplyFinalTextForState,
  replyFinalDeliveryIntentFromState,
  shouldBackstopReplyFinalDelivery,
} from "../resolve/reply-final-delivery-intent.js";
import {
  buildImmutableDeliveryTarget,
  deliveryTargetReplyTo,
  resolveDisplayModel,
  resolveRouteSource,
} from "./footer-mode.js";
import {
  clearPolicyStateForContext,
  getPolicyStateForContext,
  handleNativeSubagentEndedCompletion,
  nativeAnnounceSendOverride,
  slackThreadFromSessionKey,
  updatePolicyState,
} from "../extension-entry.js";

export interface AgentEndDeps {
  pi: PluginInterface;
  sendFinalReply?: (params: SendIMParams) => Promise<SendIMResult>;
}

function currentInboundReplyToMessageId(ctx: UnknownRecord): string {
  return stringValue(
    ctx.inboundMessageTs
    || ctx.inbound_message_ts
    || ctx.replyToMessageId
    || ctx.reply_to_message_id
    || ctx.messageId
    || ctx.message_id
    || ctx.threadTs
    || ctx.thread_ts,
  );
}

function agentEndReplyToMessageId(state: UnknownRecord | null | undefined, ctx: UnknownRecord): string {
  const stateRecord = asRecord(state);
  return currentInboundReplyToMessageId(ctx)
    || deliveryTargetReplyTo(stateRecord)
    || stringValue(
      stateRecord.inboundMessageTs
      || stateRecord.inbound_message_ts
      || stateRecord.replyToMessageId
      || stateRecord.reply_to_message_id
      || stateRecord.message_id,
    );
}

function nestedEventValue(event: UnknownRecord, key: string): unknown {
  const root = asRecord(event);
  const result = asRecord(root.result);
  const meta = asRecord(root.meta);
  return root[key] ?? result[key] ?? meta[key];
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => stringValue(item)).filter(Boolean);
  }
  const text = stringValue(value);
  return text ? [text] : [];
}

function textBlob(value: unknown): string {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter(Boolean).join("\n")
    : stringValue(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => stringValue(value)).filter(Boolean)));
}

function extractAgentEndFinalText(event: UnknownRecord): string {
  const candidates = [
    ...stringValues(nestedEventValue(event, "assistantTexts")),
    ...stringValues(nestedEventValue(event, "assistantText")),
    ...stringValues(nestedEventValue(event, "finalText")),
    ...stringValues(nestedEventValue(event, "replyText")),
  ].map((value) => value.trim()).filter((value) => value && value.toUpperCase() !== "NO_REPLY");
  return candidates.length > 0 ? candidates[candidates.length - 1] : "";
}

function messageIdsFromRecord(record: UnknownRecord): string[] {
  return uniqueStrings([
    stringValue(record.inboundMessageTs),
    stringValue(record.inbound_message_ts),
    stringValue(record.replyToMessageId),
    stringValue(record.reply_to_message_id),
    stringValue(record.reply_to_id),
    stringValue(record.messageId),
    stringValue(record.message_id),
    stringValue(record.threadTs),
    stringValue(record.thread_ts),
  ]);
}

function messageIdsFromFinalPrompt(event: UnknownRecord): string[] {
  const promptText = textBlob(nestedEventValue(event, "finalPromptText"));
  if (!promptText) return [];
  const ids: string[] = [];
  const pattern = /"(?:message_id|messageId|reply_to_id|replyToMessageId|reply_to_message_id|inboundMessageTs|inbound_message_ts|threadTs|thread_ts)"\s*:\s*"([^"]+)"/g;
  for (const match of promptText.matchAll(pattern)) {
    ids.push(stringValue(match[1]));
  }
  return uniqueStrings(ids);
}

function explicitAgentEndMessageIds(event: UnknownRecord, ctx: UnknownRecord): string[] {
  const promptMessageIds = messageIdsFromFinalPrompt(event);
  if (promptMessageIds.length > 0) return promptMessageIds;
  return uniqueStrings([
    ...messageIdsFromRecord(event),
    ...messageIdsFromRecord(asRecord(event.result)),
    ...messageIdsFromRecord(asRecord(event.meta)),
    ...messageIdsFromRecord(ctx),
  ]);
}

function stripThreadSuffix(stateKey: string): string {
  const marker = ":thread:";
  const index = stateKey.lastIndexOf(marker);
  return index >= 0 ? stateKey.slice(0, index) : stateKey;
}

function threadStateKeyFor(baseKey: string, replyToMessageId: string): string {
  const base = stripThreadSuffix(stringValue(baseKey));
  const anchor = stringValue(replyToMessageId);
  return base && anchor ? `${base}:thread:${anchor}` : "";
}

function candidateReplyFinalStateKeys(input: {
  stateKey: string;
  state: PolicyStateEntry | null | undefined;
  event: UnknownRecord;
  ctx: UnknownRecord;
}): string[] {
  const stateRecord = asRecord(input.state);
  const eventMessageIds = uniqueStrings([
    ...messageIdsFromFinalPrompt(input.event),
    ...messageIdsFromRecord(input.event),
    ...messageIdsFromRecord(asRecord(input.event.result)),
    ...messageIdsFromRecord(asRecord(input.event.meta)),
    ...messageIdsFromRecord(input.ctx),
  ]);
  const stateMessageIds = uniqueStrings([
    ...messageIdsFromRecord(stateRecord),
    deliveryTargetReplyTo(stateRecord),
  ]);
  const directKeys = uniqueStrings([
    input.stateKey,
    stringValue(input.ctx.canonicalSessionKey || input.ctx.canonical_session_key),
    stringValue(input.ctx.sessionKey || input.ctx.session_key),
    stringValue(input.ctx.sessionId || input.ctx.session_id),
    stringValue(stateRecord.canonicalSessionKey || stateRecord.canonical_session_key),
  ]);
  const baseKeys = uniqueStrings([
    input.stateKey,
    stringValue(input.ctx.sessionKey || input.ctx.session_key),
    stringValue(input.ctx.canonicalSessionKey || input.ctx.canonical_session_key),
    stringValue(stateRecord.ackGuardKey || stateRecord.ack_guard_key),
    stringValue(stateRecord.canonicalSessionKey || stateRecord.canonical_session_key),
    stringValue(stateRecord.latestTurnStateKey || stateRecord.latest_turn_state_key),
  ]).map(stripThreadSuffix);
  const eventThreadKeys = eventMessageIds.flatMap((messageId) => baseKeys.map((baseKey) => threadStateKeyFor(baseKey, messageId)));
  const latestTurnKey = stringValue(stateRecord.latestTurnStateKey || stateRecord.latest_turn_state_key);
  const stateThreadKeys = stateMessageIds.flatMap((messageId) => baseKeys.map((baseKey) => threadStateKeyFor(baseKey, messageId)));
  return uniqueStrings([
    ...directKeys,
    ...eventThreadKeys,
    latestTurnKey,
    ...stateThreadKeys,
  ]);
}

function aliasKeysForReplyFinalBackstop(input: {
  originalStateKey: string;
  resolvedStateKey: string;
  state: PolicyStateEntry | null | undefined;
  ctx: UnknownRecord;
}): string[] {
  const stateRecord = asRecord(input.state);
  return uniqueStrings([
    input.originalStateKey,
    stringValue(input.ctx.sessionId || input.ctx.session_id),
    stringValue(input.ctx.sessionKey || input.ctx.session_key),
    stringValue(input.ctx.canonicalSessionKey || input.ctx.canonical_session_key),
    stringValue(stateRecord.ackGuardKey || stateRecord.ack_guard_key),
    stringValue(stateRecord.canonicalSessionKey || stateRecord.canonical_session_key),
  ]).filter((key) => key !== input.resolvedStateKey);
}

function shouldSyncReplyFinalAlias(aliasState: PolicyStateEntry | undefined, resolvedStateKey: string, replyToMessageId: string): boolean {
  const stateRecord = asRecord(aliasState);
  if (!aliasState) return false;
  const latestTurnStateKey = stringValue(stateRecord.latestTurnStateKey || stateRecord.latest_turn_state_key);
  const canonicalSessionKey = stringValue(stateRecord.canonicalSessionKey || stateRecord.canonical_session_key);
  const existingIntent = replyFinalDeliveryIntentFromState(aliasState);
  const aliasReplyTo = deliveryTargetReplyTo(stateRecord) || agentEndReplyToMessageId(stateRecord, {});
  return latestTurnStateKey === resolvedStateKey
    || canonicalSessionKey === resolvedStateKey
    || existingIntent?.replyToMessageId === replyToMessageId
    || aliasReplyTo === replyToMessageId;
}

function syncReplyFinalDeliveryResultAliases(input: {
  aliasStateKeys?: string[];
  resolvedStateKey: string;
  resolvedState: PolicyStateEntry | null | undefined;
}): void {
  const intent = replyFinalDeliveryIntentFromState(input.resolvedState);
  if (!intent) return;
  for (const aliasKey of uniqueStrings(input.aliasStateKeys ?? [])) {
    const aliasState = policyState.get(aliasKey);
    if (!shouldSyncReplyFinalAlias(aliasState, input.resolvedStateKey, intent.replyToMessageId)) continue;
    updatePolicyState(aliasKey, (current) => ({
      ...(current ?? {}),
      replyFinalDeliveryIntent: intent,
      reply_final_delivery_intent: intent,
      updatedAt: Date.now(),
    }));
  }
}

function resolveReplyFinalBackstopState(input: {
  stateKey: string;
  state: PolicyStateEntry | null | undefined;
  event: UnknownRecord;
  ctx: UnknownRecord;
}): { stateKey: string; state: PolicyStateEntry | null | undefined; aliasStateKeys: string[] } {
  const finalText = extractAgentEndFinalText(input.event);
  const explicitMessageIds = explicitAgentEndMessageIds(input.event, input.ctx);
  let firstIntentCandidate: { stateKey: string; state: PolicyStateEntry } | null = null;
  for (const candidateKey of candidateReplyFinalStateKeys(input)) {
    const candidateState = candidateKey === input.stateKey
      ? (input.state ?? policyState.get(candidateKey))
      : policyState.get(candidateKey);
    const intent = replyFinalDeliveryIntentFromState(candidateState);
    if (!candidateState || !intent) continue;
    if (explicitMessageIds.length > 0 && !explicitMessageIds.includes(intent.replyToMessageId)) continue;
    if (intent.finalText && intent.finalHash && intent.dedupeKey) {
      return {
        stateKey: candidateKey,
        state: candidateState,
        aliasStateKeys: aliasKeysForReplyFinalBackstop({
          originalStateKey: input.stateKey,
          resolvedStateKey: candidateKey,
          state: input.state,
          ctx: input.ctx,
        }),
      };
    }
    if (!firstIntentCandidate) {
      firstIntentCandidate = { stateKey: candidateKey, state: candidateState };
    }
    if (
      finalText
      && (explicitMessageIds.length === 0 || explicitMessageIds.includes(intent.replyToMessageId))
    ) {
      updatePolicyState(candidateKey, (current) => recordReplyFinalTextForState({
        state: current,
        finalText,
      }));
      return {
        stateKey: candidateKey,
        state: policyState.get(candidateKey) ?? candidateState,
        aliasStateKeys: aliasKeysForReplyFinalBackstop({
          originalStateKey: input.stateKey,
          resolvedStateKey: candidateKey,
          state: input.state,
          ctx: input.ctx,
        }),
      };
    }
  }
  if (firstIntentCandidate) {
    return {
      ...firstIntentCandidate,
      aliasStateKeys: aliasKeysForReplyFinalBackstop({
        originalStateKey: input.stateKey,
        resolvedStateKey: firstIntentCandidate.stateKey,
        state: input.state,
        ctx: input.ctx,
      }),
    };
  }
  return { stateKey: input.stateKey, state: input.state, aliasStateKeys: [] };
}

export function makeSubagentEndedHook(deps: AgentEndDeps) {
  return async (event: UnknownRecord, ctx: UnknownRecord) => {
    await handleNativeSubagentEndedCompletion({
      event,
      ctx,
      pluginConfig: deps.pi.pluginConfig,
      logger: deps.pi.logger,
      cwd: stringValue(ctx.cwd) || process.cwd(),
      sendMessage: nativeAnnounceSendOverride(deps.pi.pluginConfig),
    });
  };
}

async function maybeSendReplyFinalBackstop(input: {
  deps: AgentEndDeps;
  event: UnknownRecord;
  ctx: UnknownRecord;
  stateKey: string;
  state: PolicyStateEntry | null | undefined;
  displayModel: string;
  aliasStateKeys?: string[];
}): Promise<PolicyStateEntry | null | undefined> {
  const decision = shouldBackstopReplyFinalDelivery({
    state: input.state,
    event: input.event,
    ctx: input.ctx,
  });
  if (!decision.shouldSend || !decision.intent) {
    if (decision.intent && decision.reason !== "already_delivered") {
      const skipReason = decision.reason === "missing_message_tool_delivery"
        ? "no_missing_delivery_evidence"
        : decision.reason;
      updatePolicyState(input.stateKey, (current) => recordReplyFinalDeliverySkipForState({
        state: current,
        reason: skipReason,
      }));
    }
    void recordPolicyReplay("reply_final_delivery_backstop_skipped", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      reason: decision.reason,
      intentId: stringValue(decision.intent?.intentId),
      replyToMessageId: stringValue(decision.intent?.replyToMessageId),
    }, input.deps.pi.logger, asRecord(input.state?.decision)).catch(() => {});
    return policyState.get(input.stateKey) ?? input.state;
  }

  const intent = decision.intent;
  const send = input.deps.sendFinalReply ?? sendIMMessage;
  try {
    const result = await send({
      sessionKey: intent.sessionKey,
      message: intent.finalText ?? "",
      replyToMessageId: intent.replyToMessageId,
      cwd: resolveWorkspaceRoot(),
      suppressProjectionFooter: true,
      footerMode: "off",
      deliveryKind: "reply_final_backstop",
      deliveryTargetSource: "inbound_anchor",
      deliveryProvenance: {
        route: "reply",
        model: input.displayModel,
        via: resolveRouteSource(asRecord(input.state)),
        runId: stringValue(input.event.runId || input.ctx.runId),
      },
      dedupeKey: intent.dedupeKey,
    });
    updatePolicyState(input.stateKey, (current) => recordReplyFinalDeliveryResultForState({
      state: current,
      result,
    }));
    const updatedState = policyState.get(input.stateKey) ?? input.state;
    syncReplyFinalDeliveryResultAliases({
      aliasStateKeys: input.aliasStateKeys,
      resolvedStateKey: input.stateKey,
      resolvedState: updatedState,
    });
    void recordPolicyReplay(result.sent ? "reply_final_delivery_backstop_sent" : "reply_final_delivery_backstop_failed", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      reason: decision.reason,
      intentId: intent.intentId,
      replyToMessageId: intent.replyToMessageId,
      messageId: stringValue(result.messageId),
      threadTs: stringValue(result.threadTs),
      transport: stringValue(result.transport),
      error: stringValue(result.error),
    }, input.deps.pi.logger, asRecord(input.state?.decision)).catch(() => {});
  } catch (err) {
    updatePolicyState(input.stateKey, (current) => recordReplyFinalDeliveryResultForState({
      state: current,
      result: { sent: false, error: String(err) },
    }));
    const updatedState = policyState.get(input.stateKey) ?? input.state;
    syncReplyFinalDeliveryResultAliases({
      aliasStateKeys: input.aliasStateKeys,
      resolvedStateKey: input.stateKey,
      resolvedState: updatedState,
    });
    void recordPolicyReplay("reply_final_delivery_backstop_failed", {
      sessionKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
      reason: decision.reason,
      intentId: intent.intentId,
      replyToMessageId: intent.replyToMessageId,
      error: String(err),
    }, input.deps.pi.logger, asRecord(input.state?.decision)).catch(() => {});
    input.deps.pi.logger?.warn?.(`reply_final_delivery_backstop failed: ${String(err)}`);
  }
  return policyState.get(input.stateKey) ?? input.state;
}

export function makeAgentEndHook(deps: AgentEndDeps) {
  return async (event: UnknownRecord, ctx: UnknownRecord) => {
    if (!isManagedAgentContext(ctx)) return;
    const { key: stateKey, state } = getPolicyStateForContext(ctx);
    if (!stateKey) return;
    recordRuntimeCostEventAndBudget({ event, ctx, state, stateKey, logger: deps.pi.logger });
    lastGroundedPromptByStateKey.delete(stateKey);
    clearBudgetedMainTimer(stateKey);
    const pendingTimer = pendingLatencyAckTimers.get(stateKey);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingLatencyAckTimers.delete(stateKey);
    }
    cancelAckGuardForState(stateKey);
    updateAckTrackingState(stateKey, { tool_active: false, final_response_streaming: false });
    const finalNow = Date.now();
    const directToolsSeen = Array.isArray(state?.directToolsSeen) ? state.directToolsSeen : [];
    const toolsUsed = Array.from(new Set([
      ...(Array.isArray(state?.toolsUsed) ? state.toolsUsed : []),
      ...directToolsSeen,
    ].map((value) => stringValue(value)).filter(Boolean)));
    const liveDurationMs = Number(asRecord(state?.replyUsageState || state?.reply_usage_state).durationMs);
    const durationMs = Number.isFinite(liveDurationMs) && liveDurationMs > 0
      ? liveDurationMs
      : Math.max(0, finalNow - Number(state?.createdAt || state?.updatedAt || finalNow));
    const finalReceipt = buildTurnExecutionReceipt(
      { ...(state ?? {}), canonicalSessionKey: stateKey, toolsUsed } as Parameters<typeof buildTurnExecutionReceipt>[0],
      durationMs,
      finalNow,
    );
    const displayModel = resolveDisplayModel(asRecord(state), event, asRecord(ctx));
    recordRuntimeHealthCall({
      event: {
        ...event,
        latencyMs: finalReceipt.durationMs,
        errorCode: finalReceipt.outcome === "timeout" ? "TIMEOUT" : (finalReceipt.outcome === "failed" ? "RUNTIME_ERROR" : undefined),
      },
      ctx,
      state,
      stateKey,
      model: displayModel,
      success: finalReceipt.outcome === "completed",
      logger: deps.pi.logger,
    });
    const replyFinalBackstopState = finalReceipt.route === "reply"
      ? resolveReplyFinalBackstopState({ stateKey, state, event, ctx })
      : { stateKey, state, aliasStateKeys: [] };
    const postBackstopState = finalReceipt.route === "reply"
      ? await maybeSendReplyFinalBackstop({
        deps,
        event,
        ctx,
        stateKey: replyFinalBackstopState.stateKey,
        state: replyFinalBackstopState.state,
        displayModel,
        aliasStateKeys: replyFinalBackstopState.aliasStateKeys,
      })
      : state;
    void recordPolicyReplay("agent_end", {
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
      routeLanguagePacks: Array.isArray(asRecord(state?.decision).route_language_packs) ? asRecord(state?.decision).route_language_packs : [],
    }, deps.pi.logger, state?.decision as Record<string, unknown> | null).catch(() => {});
    const shouldRetainCompactReceipt = Boolean(
      finalReceipt.route === "reply"
      || finalReceipt.toolsUsed.length > 0
      || finalReceipt.dispatchExecuted
      || finalReceipt.spawnExecuted
      || finalReceipt.resultMaterialized
      || asRecord(state?.latestAnomalyNotice).kind,
    );

    if (finalReceipt.route === "delegate" && shouldRetainPolicyStateOnAgentEnd(asRecord(postBackstopState))) {
      const stateRecord = asRecord(postBackstopState);
      const formalReplyVisible = Boolean(stateRecord.formal_reply_visible);
      let noticeDeliveryState = "not_attempted";
      const deliverySessionKey = stringValue(stateRecord.ackGuardKey || stateRecord.ack_guard_key || ctx.sessionKey || stateKey);
      updateAckTrackingState(stateKey, { delegate_without_dispatch: true });
      updatePolicyState(stateKey, (current) => ({ ...current, delegate_without_dispatch: true, dispatchExecuted: false, spawnExecuted: false }));
      // When the model completed the task in the main session via ordinary
      // tools (ignoring the dispatch directive), the "暂时不能启动后台任务"
      // notice is misleading — the work was actually done. Suppress the notice
      // in that case and record the suppression reason for telemetry.
      const taskCompletedInMain = finalReceipt.toolsUsed.length > 0 && finalReceipt.outcome === "completed" && formalReplyVisible;
      if (taskCompletedInMain) {
        noticeDeliveryState = "suppressed_task_completed_in_main";
      } else if (!formalReplyVisible) {
        try {
          const noticeResult = await sendDelegateWithoutDispatchNotice({
            sessionKey: deliverySessionKey,
            stateKey,
            decision: asRecord(stateRecord.decision),
            state: stateRecord,
            replyToMessageId: agentEndReplyToMessageId(stateRecord, ctx),
            cwd: resolveWorkspaceRoot(),
            logger: deps.pi.logger,
          });
          noticeDeliveryState = noticeResult.sent ? "sent" : (noticeResult.skipped ? "skipped" : "failed");
        } catch (err) {
          deps.pi.logger?.warn?.(`delegate_without_dispatch notice failed: ${String(err)}`);
          noticeDeliveryState = "error";
        }
      } else {
        noticeDeliveryState = "suppressed_reply_visible";
      }

      const workContract = asRecord(asRecord(stateRecord.decision).work_contract);
      const routeSeal = asRecord(asRecord(stateRecord.decision).routeSeal);
      void recordPolicyReplay("delegate_without_dispatch", {
        sessionKey: stateKey,
        sessionId: stringValue(ctx.sessionId),
        route: stringValue(asRecord(stateRecord.decision).route_decision && asRecord(asRecord(stateRecord.decision).route_decision).route),
        systemPreferredRoute: stringValue(asRecord(asRecord(stateRecord.decision).route_decision).system_preferred_route),
        workerPool: stringValue(asRecord(asRecord(stateRecord.decision).route_decision).worker_pool),
        taskClass: stringValue(asRecord(asRecord(stateRecord.decision).route_decision).task_class),
        delegated: false,
        delegationTool: "",
        dispatchExecuted: false,
        spawnExecuted: false,
        delegate_without_dispatch: true,
        notificationDeliveryState: noticeDeliveryState,
        routeCommitId: stringValue(workContract.workContractId),
        routeSealId: stringValue(routeSeal.routeSealId || routeSeal.requestId),
      }, deps.pi.logger, stateRecord.decision as Record<string, unknown> | null).catch(() => {});
      return;
    }
    if (shouldRetainCompactReceipt) {
      const latestState = policyState.get(stateKey) ?? postBackstopState ?? state;
      const latestRecord = asRecord(latestState);
      const decision = asRecord(latestRecord.decision);
      const routeDecision = asRecord(decision.route_decision);
      const workContract = asRecord(decision.work_contract);
      const replyToMessageId = agentEndReplyToMessageId(latestRecord, ctx);
      const replyFinalDeliveryIntent = latestRecord.replyFinalDeliveryIntent || latestRecord.reply_final_delivery_intent;
      const latestAnomalyNotice = asRecord(latestRecord.latestAnomalyNotice);
      const outboundProjection = {
        route: finalReceipt.route,
        model: resolveDisplayModel(latestRecord, {}, asRecord(ctx)),
        via: resolveRouteSource(latestRecord),
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
        ackGuardKey: stringValue(latestRecord.ackGuardKey || latestRecord.ack_guard_key || ctx.sessionKey),
        inboundMessageTs: replyToMessageId || undefined,
        replyToMessageId: replyToMessageId || undefined,
        message_id: replyToMessageId || undefined,
        deliveryTarget: buildImmutableDeliveryTarget(stringValue(latestRecord.ackGuardKey || latestRecord.ack_guard_key || ctx.sessionKey || stateKey), replyToMessageId),
        delivery_target: buildImmutableDeliveryTarget(stringValue(latestRecord.ackGuardKey || latestRecord.ack_guard_key || ctx.sessionKey || stateKey), replyToMessageId),
        ...(replyFinalDeliveryIntent ? {
          replyFinalDeliveryIntent: asRecord(replyFinalDeliveryIntent),
          reply_final_delivery_intent: asRecord(replyFinalDeliveryIntent),
        } : {}),
        directToolsSeen: finalReceipt.toolsUsed,
        toolsUsed: finalReceipt.toolsUsed,
        dispatchExecuted: finalReceipt.dispatchExecuted,
        spawnExecuted: finalReceipt.spawnExecuted,
        resultMaterialized: finalReceipt.resultMaterialized,
        ...(latestAnomalyNotice.kind ? { latestAnomalyNotice } : {}),
        createdAt: finalNow,
        updatedAt: finalNow,
      }));
      return;
    }
    clearPolicyStateForContext(ctx);
  };
}
