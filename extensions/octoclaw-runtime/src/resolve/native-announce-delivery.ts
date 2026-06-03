import { type SendIMResult, sendIMMessage } from "../im/send.js";
import { renderIMProjectionFooter } from "../im/projection-footer.js";
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
import { resolveDurableDeliveryTarget, slackThreadAnchorFromSessionKey } from "./delivery-target.js";

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
  return slackThreadAnchorFromSessionKey(sessionKey);
}

function nativeAnnounceDeliveryResolution(contract: WorkContract, state: UnknownRecord, ctx: UnknownRecord) {
  const contractRecord = contract as unknown as UnknownRecord;
  const nativeRefs = asRecord(contract.nativeSpawnRefs);
  return resolveDurableDeliveryTarget({
    contract: contractRecord,
    state,
    ctx,
    fallbackSessionKeys: [nativeRefs.requesterSessionKey],
  });
}

function requiresNativeAnnounceThreadAnchor(sessionKey: string, replyToMessageId: string): boolean {
  return !replyToMessageId && /(?:^|:)slack:/u.test(sessionKey.toLowerCase());
}

function nativeAnnounceFallbackSessionKey(contract: WorkContract): string {
  const nativeRefs = asRecord(contract.nativeSpawnRefs);
  return stringValue(contract.sessionKey) || stringValue(nativeRefs.requesterSessionKey);
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
      mode: footerDebugEnabled() ? "debug" : "compact",
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
  const staleWorkContract = asRecord(decision.work_contract);
  const currentContract = contract as unknown as UnknownRecord;
  return {
    ...state,
    decision: {
      ...decision,
      work_contract: {
        ...staleWorkContract,
        ...currentContract,
        telemetry: {
          ...asRecord(staleWorkContract.telemetry),
          ...asRecord(currentContract.telemetry),
        },
      },
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
  const deliveryResolution = nativeAnnounceDeliveryResolution(input.contract, state, ctx);
  const sessionKey = deliveryResolution.target?.sessionKey || nativeAnnounceFallbackSessionKey(input.contract);
  const replyToMessageId = deliveryResolution.target?.replyToMessageId || "";
  if (!deliveryResolution.target) {
    return {
      sent: false,
      error: deliveryResolution.reason === "missing_inbound_anchor"
        ? "native_announce_missing_inbound_anchor"
        : "native_announce_missing_delivery_session",
      sessionKey,
      replyToMessageId,
    };
  }
  if (!sessionKey) {
    return { sent: false, error: "native_announce_missing_delivery_session", sessionKey, replyToMessageId };
  }
  if (requiresNativeAnnounceThreadAnchor(sessionKey, replyToMessageId)) {
    return { sent: false, error: "native_announce_missing_inbound_anchor", sessionKey, replyToMessageId };
  }
  if (deliveryResolution.source === "bound_state" && deliveryResolution.target) {
    updateWorkContract(input.contract.workContractId, (contract) => ({
      ...contract,
      deliveryTarget: deliveryResolution.target,
      delivery_target: deliveryResolution.target,
      updatedAt: new Date().toISOString(),
    }));
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
