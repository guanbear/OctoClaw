import { type WorkContract } from "@octoclaw/contracts/work-contract";
import { policyState, type PolicyStateEntry } from "../state/policy-state.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";
import { nativeSpawnIntentDisplayModel } from "../hooks/footer-mode.js";
import { type NativeAnnounceBlocker, type NativeAnnounceCompletion } from "./native-announce-types.js";
import { contractNativeIds } from "./native-announce-delivery.js";

export function buildNativeAnnouncePolicyState(input: {
  current: PolicyStateEntry;
  stateKey: string;
  contract: WorkContract;
  completion: NativeAnnounceCompletion;
  delivered: boolean;
  now: number;
  blocker?: NativeAnnounceBlocker | null;
}): PolicyStateEntry {
  const ids = contractNativeIds(input.contract);
  const decision = asRecord(input.current.decision);
  const hookInterface = asRecord(decision.hook_interface);
  const beforeToolCall = asRecord(hookInterface.before_tool_call);
  const routeDecision = asRecord(decision.route_decision);
  const modelPolicy = asRecord(decision.model_policy);
  const runtimeTruth = asRecord(decision.runtime_truth);
  const runtimeBinding = asRecord(runtimeTruth.binding);
  const runtimeEvidence = asRecord(runtimeTruth.evidence);
  const workContractProjection = asRecord(decision.work_contract);
  const childSessionKey = ids.childSessionKey || input.completion.sourceSessionKey;
  const runId = ids.runId || ids.childRunId;
  const isBlocked = input.blocker?.blocked === true;
  const nativeModel = nativeSpawnIntentDisplayModel(input.contract);
  return {
    ...input.current,
    canonicalSessionKey: input.stateKey,
    prompt: input.current.prompt || input.contract.userAsk,
    decision: {
      ...decision,
      route_decision: {
        ...routeDecision,
        route: "delegate",
        route_source: isBlocked ? "native_announce_blocker" : "native_announce",
        task_class: isBlocked
          ? "delegated_completion_blocked"
          : stringValue(routeDecision.task_class) || "delegated_completion_delivery",
      },
      model_policy: nativeModel
        ? {
            ...modelPolicy,
            selected_model: nativeModel,
            model: nativeModel,
          }
        : modelPolicy,
      work_contract: {
        ...workContractProjection,
        workContractId: input.contract.workContractId,
        work_contract_id: input.contract.workContractId,
        route: "delegate",
        status: isBlocked ? "blocked" : stringValue(workContractProjection.status || "completed"),
        childSessionKey,
        openclawRunId: runId,
        spawnIntentId: ids.spawnIntentId,
        ...(isBlocked ? { blocker: input.blocker?.reason } : {}),
      },
      runtime_truth: {
        ...runtimeTruth,
        binding: {
          ...runtimeBinding,
          runId,
          childRunId: ids.childRunId || runId,
          childSessionKey,
        },
        evidence: {
          ...runtimeEvidence,
          resultMaterialized: true,
          result_materialized: true,
          childSessionKey,
          runId,
        },
      },
      delivery: {
        ...asRecord(decision.delivery),
        status: isBlocked ? "blocked" : input.delivered ? "delivered" : "pending",
        resultMaterialized: true,
        result_materialized: true,
        ...(isBlocked ? { blocker: input.blocker?.reason } : {}),
      },
      hook_interface: {
        ...hookInterface,
        before_tool_call: {
          ...beforeToolCall,
          enabled: true,
        },
      },
    },
    delegated: true,
    dispatchRoute: "delegate",
    dispatchStatus: isBlocked ? "blocked" : input.delivered ? "result_delivered" : "result_ready",
    dispatchExecuted: true,
    dispatch_executed: true,
    spawnExecuted: true,
    spawn_executed: true,
    resultMaterialized: true,
    result_materialized: true,
    workContractId: input.contract.workContractId,
    work_contract_id: input.contract.workContractId,
    spawnIntentId: ids.spawnIntentId,
    spawn_intent_id: ids.spawnIntentId,
    runId,
    run_id: runId,
    childRunId: ids.childRunId || runId,
    child_run_id: ids.childRunId || runId,
    childSessionKey,
    child_session_key: childSessionKey,
    ...(isBlocked ? {
      nativeAnnounceBlocked: true,
      native_announce_blocked: true,
      nativeAnnounceBlocker: input.blocker?.reason,
      native_announce_blocker: input.blocker?.reason,
      nativeAnnounceBlockedHash: input.completion.resultHash,
      native_announce_blocked_hash: input.completion.resultHash,
      nativeAnnounceCompletionPending: false,
      native_announce_completion_pending: false,
      nativeAnnounceDelivered: false,
      native_announce_delivered: false,
    } : {
      nativeAnnounceCompletionPending: !input.delivered,
      native_announce_completion_pending: !input.delivered,
      nativeAnnounceDelivered: input.delivered,
      native_announce_delivered: input.delivered,
      nativeAnnounceResultHash: input.completion.resultHash,
      native_announce_result_hash: input.completion.resultHash,
    }),
    ...(input.delivered ? {
      nativeAnnounceDeliveredAt: input.now,
      native_announce_delivered_at: new Date(input.now).toISOString(),
    } : {}),
    deliveryStatus: isBlocked ? "blocked" : input.delivered ? "delivered" : "pending",
    delivery_status: isBlocked ? "blocked" : input.delivered ? "delivered" : "pending",
    formal_reply_visible: input.delivered || input.current.formal_reply_visible,
    updatedAt: input.now,
  } as PolicyStateEntry;
}

export function isNativeAnnounceDeliveryState(state: unknown): boolean {
  const record = asRecord(state);
  const dispatchStatus = stringValue(record.dispatchStatus || record.dispatch_status);
  return record.nativeAnnounceCompletionPending === true
    || record.native_announce_completion_pending === true
    || record.nativeAnnounceDelivered === true
    || record.native_announce_delivered === true
    || dispatchStatus === "result_ready"
    || dispatchStatus === "result_delivered"
    || Boolean(stringValue(record.nativeAnnounceResultHash || record.native_announce_result_hash));
}

export function isNativeAnnounceBlockedState(state: unknown): boolean {
  const record = asRecord(state);
  return record.nativeAnnounceBlocked === true || record.native_announce_blocked === true;
}

export function isNativeAnnounceAlreadyDelivered(state: unknown): boolean {
  const record = asRecord(state);
  if (!isNativeAnnounceDeliveryState(record)) return false;
  return record.nativeAnnounceDelivered === true
    || record.native_announce_delivered === true
    || stringValue(record.deliveryStatus || record.delivery_status).toLowerCase() === "delivered";
}

export function nativeAnnounceDeliveredAtMs(state: UnknownRecord): number {
  const raw = state.nativeAnnounceDeliveredAt
    ?? state.native_announce_delivered_at
    ?? state.updatedAt
    ?? state.updated_at;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const parsed = Date.parse(stringValue(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shouldCancelNativeAnnounceDeliveredOutbound(match: { anchored: boolean; state: PolicyStateEntry }, state: UnknownRecord, now: number): boolean {
  if (!isNativeAnnounceAlreadyDelivered(state)) return false;
  if (match.anchored) return true;
  const deliveredAt = nativeAnnounceDeliveredAtMs(state);
  return deliveredAt > 0 && now - deliveredAt <= 60 * 1000;
}

export function applyNativeAnnounceCompletionState(input: {
  ctx: UnknownRecord;
  stateKey: string;
  contract: WorkContract;
  completion: NativeAnnounceCompletion;
  delivered: boolean;
  now: number;
  blocker?: NativeAnnounceBlocker | null;
}): void {
  const aliasKeys = Array.from(new Set([
    input.stateKey,
    input.contract.sessionKey,
    stringValue(ctxValue(input.ctx, "sessionKey")),
    stringValue(ctxValue(input.ctx, "canonicalSessionKey")),
    stringValue(ctxValue(input.ctx, "sessionId")),
  ].filter(Boolean)));
  for (const aliasKey of aliasKeys) {
    updatePolicyState(aliasKey, (current) => buildNativeAnnouncePolicyState({
      current,
      stateKey: input.contract.sessionKey || input.stateKey || aliasKey,
      contract: input.contract,
      completion: input.completion,
      delivered: input.delivered,
      now: input.now,
      blocker: input.blocker,
    }));
  }
}

function ctxValue(ctx: UnknownRecord, key: string): unknown {
  return ctx[key];
}

function updatePolicyState(stateKey: string, mutator: (current: PolicyStateEntry) => PolicyStateEntry): void {
  const key = stringValue(stateKey);
  if (!key) {
    return;
  }
  policyState.update(key, (current) => mutator(current));
}
