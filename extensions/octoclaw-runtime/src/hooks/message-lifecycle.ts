import { updateAckTrackingState } from "../ack/ack-guard.js";
import {
  assistantMessageText,
  guardAssistantMessageForPolicyState,
  replaceAssistantMessageText,
} from "../replay/message-guard.js";
import { isManagedAgentContext } from "../resolve/session.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import { firstStringValue, stringValue } from "../extension-entry-shared.js";
import { extractPromptText } from "../extension-entry-helpers.js";
import { handleRouterWizardAction, maybeSendRouterWizardOnboarding } from "../router-onboarding.js";
import {
  extractInboundMessageTimestampWithSource,
  resolveSlackMessageReceivedSessionKey,
  type InboundMessageTimestampSource,
} from "../inbound-timestamps.js";
import {
  appendReplyProjectionFooter,
  buildImmutableDeliveryTarget,
  cancelNeutralAckTimersForContext,
  guardOutboundMessageForPolicyState,
} from "./footer-mode.js";
import {
  completeBudgetedMainIfActive,
} from "../budgeted-main.js";
import {
  getPolicyStateForContext,
  hydrateOutboundStateWithNativeRefs,
  isNativeAnnounceAlreadyDelivered,
  isNativeAnnounceDeliveryState,
  markNativeAnnounceCompletionOnContract,
  outboundDeliveryContent,
  outboundLooksLikeVisibleDeliveryHook,
  replyDispatchSourceContext,
  resolveOutboundPolicyTarget,
  sendCompactionNotice,
  updatePolicyState,
  wrapReplyDispatchFooterProjection,
  type NativeAnnounceCompletion,
} from "../extension-entry.js";

export interface MessageLifecycleDeps {
  pi: PluginInterface;
  recordNeutralAckCancellations: (
    hookName: string,
    cancellations: Array<{ sessionKey: string; replyToMessageId: string; fallbackStage?: string }>,
    reason: string,
    stateKey: string,
  ) => void;
  maybeSendNeutralInboundAckForContext: (
    hookName: string,
    event: UnknownRecord,
    ctx: UnknownRecord,
    prompt?: string,
    overrides?: { stateKey?: string; sessionKey?: string; inboundMessageTs?: string; inboundMessageTsSource?: InboundMessageTimestampSource },
  ) => Promise<void>;
}

export function makeMessageSendingHook(deps: Pick<MessageLifecycleDeps, "pi" | "recordNeutralAckCancellations">) {
  return (event: UnknownRecord, ctx: UnknownRecord) => {
    const eventRecord = asRecord(event);
    const ctxRecord = asRecord(ctx);
    const visibleDelivery = outboundLooksLikeVisibleDeliveryHook(eventRecord, ctxRecord);
    const content = outboundDeliveryContent(eventRecord);
    const stateInfo = visibleDelivery ? getPolicyStateForContext(ctxRecord) : { key: "", state: null };
    const stateRecord = asRecord(stateInfo.state);
    if (visibleDelivery && outboundDeliveryContent(eventRecord).trim().toUpperCase() !== "NO_REPLY") {
      const cancellations = cancelNeutralAckTimersForContext(eventRecord, ctxRecord, stateRecord);
      if (cancellations.length > 0) {
        deps.recordNeutralAckCancellations("message_sending", cancellations, "formal_reply_visible", stateInfo.key);
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
        deps.pi.logger,
        null,
      ).catch(() => {});
    }
    return guarded;
  };
}

export function makeReplyDispatchHook(deps: Pick<MessageLifecycleDeps, "pi">) {
  return (event: UnknownRecord, ctx: UnknownRecord) => {
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
        deps.pi.logger,
        null,
      ).catch(() => {});
    }
  };
}

export function makeMessageReceivedHook(deps: Pick<MessageLifecycleDeps, "pi" | "maybeSendNeutralInboundAckForContext">) {
  return (event: UnknownRecord, ctx: UnknownRecord) => {
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
        logger: deps.pi.logger,
      });
    }).catch((error) => {
      deps.pi.logger?.warn?.(`octoclaw router wizard onboarding failed: ${String(error)}`);
    });
    if (anchor.ts) {
      const now = Date.now();
      updatePolicyState(stateKey, (current) => ({
        ...(() => {
          const currentRecord = asRecord(current);
          const previousAnchor = stringValue(
            currentRecord.inboundMessageTs
            || currentRecord.message_id
            || currentRecord.messageId
            || currentRecord.replyToMessageId
            || currentRecord.reply_to_id,
          );
          if (!previousAnchor || previousAnchor === anchor.ts) return current ?? {};
          return {
            canonicalSessionKey: stringValue(currentRecord.canonicalSessionKey || currentRecord.canonical_session_key),
            canonical_session_key: stringValue(currentRecord.canonicalSessionKey || currentRecord.canonical_session_key),
            ackGuardKey: stringValue(currentRecord.ackGuardKey || currentRecord.ack_guard_key),
            ack_guard_key: stringValue(currentRecord.ackGuardKey || currentRecord.ack_guard_key),
            channelTone: stringValue(currentRecord.channelTone || currentRecord.channel_tone),
            channel_tone: stringValue(currentRecord.channelTone || currentRecord.channel_tone),
          };
        })(),
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
    void recordPolicyReplay("message_received_observed", {
      sessionKey,
      channelId: stringValue(ctxRecord.channelId || eventRecord.channelId),
      conversationId: stringValue(ctxRecord.conversationId || eventRecord.conversationId),
      stateKey,
      inboundMessageTs: anchor.ts,
      anchor_source: anchor.source,
    }, deps.pi.logger, null).catch(() => {});
    void deps.maybeSendNeutralInboundAckForContext("message_received", event, { ...ctxRecord, sessionKey }, prompt, {
      stateKey,
      sessionKey,
      inboundMessageTs: anchor.ts,
      inboundMessageTsSource: anchor.source,
    }).catch((error) => {
      deps.pi.logger?.warn?.(`octoclaw neutral inbound ACK failed: ${String(error)}`);
    });
  };
}

export function makeBeforeCompactionHook(deps: Pick<MessageLifecycleDeps, "pi">) {
  return (event: UnknownRecord, ctx: UnknownRecord) => {
    void sendCompactionNotice(event, ctx, deps.pi.logger).catch((error) => {
      deps.pi.logger?.warn?.(`octoclaw compaction notice failed: ${String(error)}`);
    });
  };
}

export function makeBeforeMessageWriteHook(deps: Pick<MessageLifecycleDeps, "pi" | "recordNeutralAckCancellations">) {
  return (event: UnknownRecord, ctx: UnknownRecord) => {
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
        deps.recordNeutralAckCancellations("before_message_write", cancellations, "reply_streaming", stateKey);
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
      updatePolicyState(stateKey, (current) => ({ ...(current ?? {}), ...stateRecord }));
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
        logger: deps.pi.logger,
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
        void recordPolicyReplay("native_announce_final_delivered", {
          sessionKey: stateKey,
          sessionId: stringValue(ctx.sessionId),
          workContractId,
          resultHash: completion.resultHash,
        }, deps.pi.logger, asRecord(stateRecord.decision)).catch(() => {});
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
          ...(isNativeAnnounceDeliveryState(stateRecord) ? {
            nativeAnnounceCompletionPending: false,
            native_announce_completion_pending: false,
            nativeAnnounceDelivered: true,
            native_announce_delivered: true,
            deliveryStatus: "delivered",
            delivery_status: "delivered",
            resultMaterialized: true,
            result_materialized: true,
          } : {}),
          outbound_projection_footer_appended: projectedText !== contentText || current?.outbound_projection_footer_appended === true,
          outbound_projection_footer_appended_at: projectedText !== contentText ? new Date().toISOString() : current?.outbound_projection_footer_appended_at,
        }));
      }
    }
    if (outputMessage !== asRecord(event.message)) {
      return { message: outputMessage };
    }
  };
}
