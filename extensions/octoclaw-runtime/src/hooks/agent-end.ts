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
import { policyState } from "../state/policy-state.js";
import { buildTurnExecutionReceipt } from "../receipt.js";
import { recordRuntimeCostEventAndBudget } from "../router-cost-runtime.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import { stringValue } from "../extension-entry-shared.js";
import { clearBudgetedMainTimer } from "../budgeted-main.js";
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

    if (finalReceipt.route === "delegate" && shouldRetainPolicyStateOnAgentEnd(asRecord(state))) {
      const formalReplyVisible = Boolean(state?.formal_reply_visible);
      let noticeDeliveryState = "not_attempted";
      const deliverySessionKey = stringValue(state?.ackGuardKey || state?.ack_guard_key || ctx.sessionKey || stateKey);
      updateAckTrackingState(stateKey, { delegate_without_dispatch: true });
      updatePolicyState(stateKey, (current) => ({ ...current, delegate_without_dispatch: true, dispatchExecuted: false, spawnExecuted: false }));
      if (!formalReplyVisible) {
        try {
          const noticeResult = await sendDelegateWithoutDispatchNotice({
            sessionKey: deliverySessionKey,
            stateKey,
            decision: asRecord(state?.decision),
            state: asRecord(state),
            replyToMessageId: deliveryTargetReplyTo(asRecord(state)) || stringValue(ctx.inboundMessageTs || state?.inboundMessageTs),
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

      const workContract = asRecord(asRecord(state?.decision).work_contract);
      const routeSeal = asRecord(asRecord(state?.decision).routeSeal);
      void recordPolicyReplay("delegate_without_dispatch", {
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
      }, deps.pi.logger, state?.decision as Record<string, unknown> | null).catch(() => {});
      return;
    }
    if (shouldRetainCompactReceipt) {
      const decision = asRecord(state?.decision);
      const routeDecision = asRecord(decision.route_decision);
      const workContract = asRecord(decision.work_contract);
      const replyToMessageId = deliveryTargetReplyTo(asRecord(state)) || stringValue(state?.inboundMessageTs || state?.replyToMessageId || state?.message_id || ctx.inboundMessageTs);
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
  };
}
