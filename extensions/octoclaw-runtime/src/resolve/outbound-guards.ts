import { assistantMessageText, replaceAssistantMessageText } from "../replay/message-guard.js";
import { isDelegatedRoute } from "../replay/policy-utils.js";
import { policyState, type PolicyStateEntry } from "../state/policy-state.js";
import { loadWorkContract } from "../work-contract/store.js";
import { stringValue } from "../extension-entry-shared.js";
import { extractPromptText } from "../extension-entry-helpers.js";
import { extractInboundMessageTimestamp, findInboundMessageTimestamp, SLACK_MESSAGE_TS_PATTERN } from "../inbound-timestamps.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import { deliveryTargetReplyTo } from "../hooks/footer-mode.js";
import { hasNativeAnnounceHardDeliveryEvidence, isNativeAnnounceAlreadyDelivered } from "./native-announce-state.js";

function normalizeOutboundTargetKey(value: unknown): string {
  return stringValue(value)
    .toLowerCase()
    .replace(/^channel:/u, "")
    .replace(/^user:/u, "")
    .replace(/[^a-z0-9_.:-]+/gu, "");
}

export function outboundTargetLooksLikeSlack(value: unknown): boolean {
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

export function resolveOutboundPolicyTarget(event: UnknownRecord, ctx: UnknownRecord): unknown {
  const candidates = outboundTargetCandidates(event, ctx);
  return candidates.find((candidate) => outboundTargetLooksLikeSlack(candidate))
    || candidates.find((candidate) => stringValue(candidate))
    || "";
}

export function outboundDeliveryContent(event: UnknownRecord): string {
  const message = asRecord(event.message);
  return stringValue(event.content)
    || assistantMessageText(message)
    || stringValue(message.content)
    || stringValue(message.text);
}

export function outboundGuardReplacement(event: UnknownRecord, content: string): { content: string; message?: UnknownRecord } {
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

function stateMatchesOutboundTarget(state: PolicyStateEntry, targetKey: string): boolean {
  if (!targetKey) return false;
  const stateRecord = asRecord(state);
  const deliveryTarget = asRecord(stateRecord.deliveryTarget || stateRecord.delivery_target);
  const candidates = [
    stateRecord.canonicalSessionKey,
    stateRecord.canonical_session_key,
    stateRecord.ackGuardKey,
    stateRecord.ack_guard_key,
    stateRecord.sessionKey,
    stateRecord.session_key,
    deliveryTarget.sessionKey,
    deliveryTarget.session_key,
    deliveryTarget.target,
    deliveryTarget.to,
    deliveryTarget.channel,
    deliveryTarget.channelId,
    deliveryTarget.channel_id,
  ];
  return candidates
    .map(normalizeOutboundTargetKey)
    .some((candidate) => candidate.includes(targetKey));
}

function policyStateLooksRelevantForOutbound(key: string, state: PolicyStateEntry, targetKey: string, anchors: string[], now: number): boolean {
  if (!targetKey) return false;
  const stateRecord = asRecord(state);
  const keyLower = key.toLowerCase();
  const anchorMatches = stateMatchesOutboundAnchor(key, state, anchors);
  const targetMatches = keyLower.includes(targetKey) || stateMatchesOutboundTarget(state, targetKey);
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

export function outboundLooksLikeVisibleDeliveryHook(event: UnknownRecord, ctx: UnknownRecord): boolean {
  if (outboundHasDeliveryMetadata(event)) return true;
  // Also treat Slack delivery targets as visible:
  // event.to can be a Slack user/channel ID (U*/C*) or contain "slack" when
  // OpenClaw sends via native Slack transport without standard metadata fields.
  if (outboundTargetCandidates(event, ctx).some((candidate) => outboundTargetLooksLikeSlack(candidate))) return true;
  return stringValue(ctx.channelId || ctx.channel).toLowerCase() === "slack";
}

export function findRecentOutboundPolicyState(
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

export function hydrateOutboundStateWithNativeRefs(state: UnknownRecord): UnknownRecord {
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
  const deliveryMessageId = stringValue(telemetry.deliveryMessageId || telemetry.delivery_message_id);
  const nativeAnnounceDeliveredAt = stringValue(telemetry.nativeAnnounceDeliveredAt || telemetry.native_announce_delivered_at);
  const resultMaterialized = telemetry.resultMaterialized === true;
  const delivered = deliveryStatus === "delivered" && hasNativeAnnounceHardDeliveryEvidence(telemetry);
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
    ...(deliveryMessageId ? { deliveryMessageId, delivery_message_id: deliveryMessageId } : {}),
    ...(nativeAnnounceDeliveredAt ? { nativeAnnounceDeliveredAt, native_announce_delivered_at: nativeAnnounceDeliveredAt } : {}),
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
