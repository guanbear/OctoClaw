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
}): Promise<PolicyStateEntry | null | undefined> {
  const decision = shouldBackstopReplyFinalDelivery({
    state: input.state,
    event: input.event,
    ctx: input.ctx,
  });
  if (!decision.shouldSend || !decision.intent) {
    if (decision.intent) {
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
    const finalReceipt = buildTurnExecutionReceipt(
      { ...(state ?? {}), canonicalSessionKey: stateKey, toolsUsed } as Parameters<typeof buildTurnExecutionReceipt>[0],
      Math.max(0, finalNow - Number(state?.createdAt || state?.updatedAt || finalNow)),
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
    const postBackstopState = finalReceipt.route === "reply"
      ? await maybeSendReplyFinalBackstop({ deps, event, ctx, stateKey, state, displayModel })
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
      if (!formalReplyVisible) {
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
