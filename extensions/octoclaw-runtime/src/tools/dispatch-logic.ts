import type { RouteSeal } from "@octoclaw/contracts/route-seal";
import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { compactWorkContractView } from "@octoclaw/contracts/work-contract";
import { canonicalizeDecisionForPolicyState, authoritativeDecisionRoute } from "../resolve/route-helpers.js";
import { validateRouteSeal } from "../resolve/route-seal.js";
import { resolveDispatchSessionKey, isDispatchableUserSessionKey } from "../resolve/session.js";
import { asRecord, asString, isRecord, type UnknownRecord } from "../util/type-coercion.js";
import { optionalReplyTargetId, parsePolicyDecisionJson, toolResponse } from "./registration-helpers.js";

function isRouteSealCandidate(value: unknown): value is RouteSeal {
  const record = asRecord(value);
  return Object.keys(record).length > 0
    && (record.route === "reply" || record.route === "delegate")
    && typeof record.turnId === "string"
    && typeof record.threadBindingKey === "string"
    && typeof record.createdAt === "string";
}

function routeSealTurnId(metadata: UnknownRecord, fallback = ""): string {
  return asString(metadata.turnId ?? metadata.turn_id, fallback);
}

function routeSealThreadBindingKey(metadata: UnknownRecord, fallback = ""): string {
  return asString(metadata.threadBindingKey ?? metadata.thread_binding_key)
    || asString(metadata.session_binding_key)
    || asString(metadata.session_thread_key)
    || asString(metadata.session_key)
    || fallback;
}

export function validCachedRouteSeal(state: UnknownRecord | null, decision: UnknownRecord, metadata: UnknownRecord): RouteSeal | null {
  const stateRecord = asRecord(state);
  const requestMetadata = asRecord(asRecord(decision.request).metadata);
  const candidate = isRouteSealCandidate(stateRecord.routeSeal)
    ? stateRecord.routeSeal
    : isRouteSealCandidate(decision.routeSeal)
      ? decision.routeSeal
      : isRouteSealCandidate(requestMetadata.routeSeal)
        ? requestMetadata.routeSeal
        : null;
  if (!candidate) return null;
  const turnId = routeSealTurnId(metadata, candidate.turnId);
  const threadBindingKey = routeSealThreadBindingKey(metadata, candidate.threadBindingKey);
  return validateRouteSeal(candidate, turnId, threadBindingKey) ? candidate : null;
}

export function dispatchPlannerSessionCandidates(...values: unknown[]): string[] {
  const candidates = new Set<string>();
  for (const value of values) {
    const key = asString(value);
    if (!key) continue;
    candidates.add(key);
    const threadIndex = key.indexOf(":thread:");
    if (threadIndex > 0) {
      candidates.add(key.slice(0, threadIndex));
    }
  }
  return Array.from(candidates);
}

export function selectDispatchPolicyDecision(
  stateDecision: unknown,
  policyJsonDecision: unknown,
): UnknownRecord | null {
  const explicit = parsePolicyDecisionJson(policyJsonDecision);
  if (explicit) {
    return explicit;
  }
  return isRecord(stateDecision) ? stateDecision : null;
}

export function selectDispatchWorkContractId(params: UnknownRecord, decision: UnknownRecord | null): string {
  const decisionRecord = asRecord(decision);
  return asString(params.workContractId)
    || asString(decisionRecord.workContractId)
    || asString(asRecord(decisionRecord.work_contract).workContractId);
}

export function decisionFromWorkContract(contract: WorkContract, baseDecision: UnknownRecord | null): UnknownRecord {
  const base = asRecord(baseDecision);
  const routeDecision = asRecord(base.route_decision);
  const toolPolicy = asRecord(base.tool_policy);
  const routerDecision = asRecord(base.router_decision_v2);
  const request = asRecord(base.request);
  const route = contract.route;
  return canonicalizeDecisionForPolicyState({
    ...base,
    route,
    workContractId: contract.workContractId,
    work_contract: compactWorkContractView(contract),
    request: {
      ...request,
      session_key: asString(request.session_key, contract.sessionKey),
    },
    route_decision: {
      ...routeDecision,
      route,
      system_preferred_route: route,
      task_class: route === "delegate"
        ? asString(routeDecision.task_class, contract.delegate?.role || "delegated_single")
        : asString(routeDecision.task_class, "main_direct"),
      dispatch_required: route === "delegate",
      reason_codes: Array.isArray(routeDecision.reason_codes)
        ? routeDecision.reason_codes
        : contract.decision.reasonCodes,
    },
    tool_policy: {
      ...toolPolicy,
      must_delegate_via: route === "delegate" ? asString(toolPolicy.must_delegate_via, "octoclaw_dispatch") : "",
      delegate_first: route === "delegate",
    },
    router_decision_v2: {
      ...routerDecision,
      request_kind: route === "delegate" ? "delegated_task" : asString(routerDecision.request_kind, "reply"),
    },
  });
}

export function confirmedNativePlannerRefs(contract: WorkContract | null): {
  runId: string;
  childRunId: string;
  childSessionKey: string;
  spawnIntentId: string;
} | null {
  if (!contract) return null;
  const refs = asRecord(contract.nativeSpawnRefs);
  const telemetry = asRecord(contract.telemetry);
  const spawnBackend = asString(refs.spawnBackend);
  const runId = asString(refs.openclawRunId || telemetry.openclawRunId);
  if (spawnBackend !== "sessions_spawn_planner" || !runId) return null;
  return {
    runId,
    childRunId: asString(refs.childRunId || telemetry.childRunId || runId),
    childSessionKey: asString(refs.childSessionKey || telemetry.childSessionKey),
    spawnIntentId: asString(refs.spawnIntentId),
  };
}

export function selectReplaySessionKeyForDispatch(
  ctx: UnknownRecord,
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord | null,
  decision: UnknownRecord,
  payload: UnknownRecord,
): string {
  const candidates = [
    resolveDispatchSessionKey(ctx, metadata, { stateKey, state, cachedDecision: decision }),
    metadata.session_key,
    asRecord(decision.request).session_key,
    asRecord(payload.job).session_key,
    payload.session_key,
  ].map((value) => asString(value)).filter(Boolean);
  return candidates.find((candidate) => isDispatchableUserSessionKey(candidate)) || asString(stateKey);
}

export function delegatedStickyRoute(decision: UnknownRecord): boolean {
  return authoritativeDecisionRoute(decision, "reply") === "delegate";
}

export function dispatchReplyToMessageId(metadata: UnknownRecord, state: UnknownRecord | null | undefined, ctx: UnknownRecord): string {
  const stateRecord = asRecord(state);
  const slackMetadata = asRecord(metadata.slack);
  const transportMetadata = asRecord(metadata.transport);
  const deliveryTarget = asRecord(stateRecord.deliveryTarget || stateRecord.delivery_target || metadata.delivery_target);
  return optionalReplyTargetId(
    deliveryTarget.replyToMessageId,
    deliveryTarget.reply_to_message_id,
    deliveryTarget.threadTs,
    deliveryTarget.thread_ts,
    metadata.inboundMessageTs,
    metadata.inbound_message_ts,
    metadata.replyToMessageId,
    metadata.reply_to_message_id,
    metadata.message_id,
    metadata.messageId,
    metadata.thread_ts,
    metadata.threadTs,
    slackMetadata.thread_ts,
    slackMetadata.threadTs,
    slackMetadata.reply_to_id,
    transportMetadata.thread_ts,
    transportMetadata.reply_to_id,
    stateRecord.inboundMessageTs,
    stateRecord.inbound_message_ts,
    stateRecord.replyToMessageId,
    stateRecord.reply_to_message_id,
    stateRecord.message_id,
    stateRecord.messageId,
    ctx.inboundMessageTs,
    ctx.inbound_message_ts,
    ctx.replyToMessageId,
    ctx.reply_to_message_id,
    ctx.message_id,
    ctx.messageId,
    ctx.thread_ts,
    ctx.threadTs,
  ) ?? "";
}


export function dispatchHonestySuccess(params: {
  route: string;
  workerPool: string;
  taskId: string;
  taskClass: string;
  workContractId?: string | null;
  delegateTaskId?: string | null;
  attemptId?: string | null;
  childSessionKey?: string | null;
  childSessionId?: string | null;
  runId?: string | null;
  childRunId?: string | null;
  dispatchExecuted?: boolean;
  spawnExecuted?: boolean;
  materialized?: boolean;
  executionState?: string;
  nativeTaskId?: string | null;
  nativeFlowId?: string | null;
  resultMaterialized?: boolean;
  deliveryStatus?: string | null;
  model?: string | null;
  modelProfile?: string | null;
}): Record<string, unknown> {
  const body = {
    ok: true,
    route: params.route,
    worker_pool: params.workerPool,
    task_id: params.taskId,
    task_class: params.taskClass,
    work_contract_id: asString(params.workContractId) || null,
    delegate_task_id: asString(params.delegateTaskId) || null,
    attempt_id: asString(params.attemptId) || null,
    child_session_key: asString(params.childSessionKey) || null,
    child_session_id: asString(params.childSessionId) || null,
    run_id: asString(params.runId) || null,
    child_run_id: asString(params.childRunId) || null,
    delegation_method: "octoclaw_dispatch",
    materialized: params.materialized === true,
    execution_state: asString(params.executionState) || (params.spawnExecuted === true ? "spawn_confirmed" : "unknown"),
    dispatch_executed: params.dispatchExecuted === true,
    spawn_executed: params.spawnExecuted === true,
    native_task_id: params.nativeTaskId ?? null,
    native_flow_id: params.nativeFlowId ?? null,
    result_materialized: params.resultMaterialized === true,
    delivery_status: params.deliveryStatus ?? null,
    model: asString(params.model || params.modelProfile) || null,
    model_profile: asString(params.modelProfile || params.model) || null,
  };
  return toolResponse(JSON.stringify(body), body);
}

export function dispatchHonestyFailure(params: {
  route?: string | null;
  error: string;
  sealMismatch?: boolean;
  retryable?: boolean;
  terminal?: boolean;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  const body = {
    ok: false,
    route: params.route ?? null,
    error: params.error,
    seal_mismatch: params.sealMismatch === true,
    retryable: params.retryable === true,
    terminal: params.terminal === true,
    ...(params.details ?? {}),
  };
  return toolResponse(JSON.stringify(body), body);
}
