import { type SendIMResult, sendIMMessage } from "../im/send.js";
import { renderIMProjectionFooter } from "../im/projection-footer.js";
import { fetchLatestUserMessageTsForSessionKey } from "../im/slack-thread-anchor.js";
import { resolveWorkspaceRoot } from "./env.js";
import { updateWorkContract } from "../work-contract/store.js";
import { type WorkContract } from "@octoclaw/contracts/work-contract";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";
import {
  footerDebugEnabled,
  resolveNativeAnnounceDisplayModel,
  resolveFooterComplexityBand,
  resolveProjectionChannel,
} from "../hooks/footer-mode.js";
import { type NativeAnnounceBlocker, type NativeAnnounceCompletion, type NativeAnnounceSendMessage } from "./native-announce-types.js";
import { regexGroup } from "./native-announce-parse.js";

export function contractNativeIds(contract: WorkContract): {
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

export function nativeAnnounceDeliveryAlreadySent(contract: WorkContract): boolean {
  const deliveryStatus = stringValue(contract.telemetry?.deliveryStatus).toLowerCase();
  return ["delivered", "sent"].includes(deliveryStatus);
}

export function nativeAnnounceDirectDeliveryEnabled(pluginConfig: UnknownRecord | undefined): boolean {
  const raw = stringValue(process.env.OCTOCLAW_NATIVE_ANNOUNCE_DIRECT_DELIVERY || pluginConfig?.nativeAnnounceDirectDelivery).toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

export function nativeAnnounceSendOverride(pluginConfig: UnknownRecord | undefined): NativeAnnounceSendMessage | undefined {
  const candidate = pluginConfig?.nativeAnnounceSendMessageForTests;
  return typeof candidate === "function" ? candidate as NativeAnnounceSendMessage : undefined;
}

export function slackThreadFromSessionKey(sessionKey: string): string {
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

function shouldResolveSlackDmAnchor(sessionKey: string, replyToMessageId: string): boolean {
  return !replyToMessageId && /(?:^|:)slack:/u.test(sessionKey.toLowerCase()) && sessionKey.includes(":direct:");
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
  const complexityBand = resolveFooterComplexityBand(nativeAnnounceFooterState(input.contract, input.state));
  if (!content) return "";
  return renderIMProjectionFooter({
    content,
    projection: {
      route: "delegate",
      model: resolveNativeAnnounceDisplayModel(input.contract, input.state, input.event, input.ctx),
      complexityBand,
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

function nativeAnnounceDeliveryProvenance(
  contract: WorkContract,
  completion: NativeAnnounceCompletion,
  model?: string,
  complexityBand = "",
): {
  route: "delegate";
  model?: string;
  complexityBand?: string;
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
    ...(complexityBand ? { complexityBand } : {}),
    via: "native_announce",
    workContractId: contract.workContractId,
    ...(ids.runId ? { runId: ids.runId } : {}),
    ...(childSessionKey ? { childSessionKey } : {}),
  };
}

function nativeAnnounceFooterState(contract: WorkContract, state: UnknownRecord): UnknownRecord {
  const decision = asRecord(state.decision);
  return {
    ...state,
    decision: {
      ...decision,
      work_contract: asRecord(decision.work_contract || contract),
    },
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
  resolveReplyToMessageId?: (sessionKey: string) => Promise<string>;
}): Promise<SendIMResult & { sessionKey: string; replyToMessageId: string }> {
  const ctx = asRecord(input.ctx);
  const event = asRecord(input.event);
  const state = asRecord(input.state);
  const sessionKey = resolveNativeAnnounceDeliverySessionKey(input.contract, ctx);
  let replyToMessageId = resolveNativeAnnounceReplyToMessageId(input.contract, ctx, state);
  if (shouldResolveSlackDmAnchor(sessionKey, replyToMessageId)) {
    const resolveReplyToMessageId = input.resolveReplyToMessageId ?? ((key: string) => fetchLatestUserMessageTsForSessionKey(key, 1200));
    replyToMessageId = stringValue(await resolveReplyToMessageId(sessionKey));
  }
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
  const complexityBand = resolveFooterComplexityBand(nativeAnnounceFooterState(input.contract, state));
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
      complexityBand,
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

export function markNativeAnnounceCompletionOnContract(
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
