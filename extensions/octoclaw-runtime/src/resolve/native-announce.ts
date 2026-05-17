import { resolvePolicyStateKey } from "./session.js";
import { policyState, type PolicyStateEntry } from "../state/policy-state.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { findWorkContractByNativeChildSessionKey } from "../work-contract/store.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";
import { buildPromptContextProjection } from "../extension-entry-helpers.js";
import { deliveryRelayVerdict } from "../im/delivery-relay-verdict.js";
import { type SendIMResult } from "../im/send.js";
import { type WorkContract } from "@octoclaw/contracts/work-contract";
import { type NativeAnnounceBlocker, type NativeAnnounceCompletion, type NativeAnnounceSendMessage } from "./native-announce-types.js";
import { extractNativeAnnounceBlocker, extractNativeAnnounceCompletion, readNativeChildSessionCompletion } from "./native-announce-parse.js";
import { contractNativeIds, deliverNativeAnnounceCompletion, markNativeAnnounceCompletionOnContract, nativeAnnounceDeliveryAlreadySent, nativeAnnounceDirectDeliveryEnabled } from "./native-announce-delivery.js";
import { applyNativeAnnounceCompletionState } from "./native-announce-state.js";
import { buildLegacyHeuristicFallbackEvent, legacyHeuristicVerdict } from "../state/legacy-heuristics.js";

export { NATIVE_ANNOUNCE_BLOCKED_TOOLS } from "./native-announce-types.js";
export type { NativeAnnounceBlocker, NativeAnnounceCompletion, NativeAnnounceSendMessage } from "./native-announce-types.js";
export { contractNativeIds, deliverNativeAnnounceCompletion, markNativeAnnounceCompletionOnContract, nativeAnnounceSendOverride, slackThreadFromSessionKey } from "./native-announce-delivery.js";
export { isNativeAnnounceAlreadyDelivered, isNativeAnnounceBlockedState, isNativeAnnounceDeliveryState, shouldCancelNativeAnnounceDeliveredOutbound } from "./native-announce-state.js";

function getPolicyStateForContext(ctx: UnknownRecord): { key: string; state: PolicyStateEntry | null } {
  const resolved = policyState.resolveForContext(ctx);
  return {
    key: stringValue(resolved.key),
    state: resolved.state ?? null,
  };
}

function hasNativeAnnounceStructuredProvenance(event: UnknownRecord): boolean {
  const direct = asRecord(event.provenance);
  if (stringValue(direct.sourceTool || direct.source_tool || direct.kind)) return true;
  const message = asRecord(event.message);
  const messageProvenance = asRecord(message.provenance);
  if (stringValue(messageProvenance.sourceTool || messageProvenance.source_tool || messageProvenance.kind)) return true;
  const messages = Array.isArray(event.messages) ? event.messages : [];
  return messages.some((item) => {
    const provenance = asRecord(asRecord(item).provenance);
    return Boolean(stringValue(provenance.sourceTool || provenance.source_tool || provenance.kind));
  });
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

  const hasStructuredProvenance = hasNativeAnnounceStructuredProvenance(input.event);
  const textParsedAnnounce = !hasStructuredProvenance;
  const messageGuardVerdict = legacyHeuristicVerdict({
    surface: "message_guard",
    hasNativeTruth: hasStructuredProvenance,
    hasKnownNativeId: false,
    hasLegacySignal: textParsedAnnounce,
    newTask: false,
    reason: hasStructuredProvenance ? "native_kind_present" : "text_native_announce_parse",
  });
  if (messageGuardVerdict.source === "legacy_heuristic_read_only") {
    void recordPolicyReplay("legacy_heuristic_fallback_used", buildLegacyHeuristicFallbackEvent({
      surface: "message_guard",
      reason: messageGuardVerdict.reason,
      newTask: false,
      allowed: messageGuardVerdict.allowed,
    }), input.logger, null).catch(() => undefined);
  }

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
  const directDeliveryAttempted = !blocker && !alreadyDelivered && directDeliveryEnabled;
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
  const nativeDeliveryVerdict = deliveryRelayVerdict({
    nativeDelivery: delivered
      ? {
          status: "delivered",
          messageId: directDelivery.messageId || "",
          resultHash: nativeAnnounceCompletion.resultHash,
        }
      : directDeliveryAttempted
        ? { status: "failed", error: directDelivery.error || "native_delivery_send_failed" }
        : {},
    nativeResultExists: true,
    relayResultHash: alreadyDelivered ? nativeAnnounceCompletion.resultHash : "",
  });
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
      native_delivery_verdict: nativeDeliveryVerdict,
      directDeliveryAttempted,
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

export async function handleNativeSubagentEndedCompletion(input: {
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
  const nativeDeliveryVerdict = deliveryRelayVerdict({
    nativeDelivery: delivered
      ? {
          status: "delivered",
          messageId: directDelivery.messageId || "",
          resultHash: completion.resultHash,
        }
      : directDeliveryEnabled
        ? { status: "failed", error: directDelivery.error || "native_delivery_send_failed" }
        : {},
    nativeResultExists: true,
  });
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
      native_delivery_verdict: nativeDeliveryVerdict,
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
