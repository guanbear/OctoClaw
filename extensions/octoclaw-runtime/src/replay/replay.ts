import fsSync from "node:fs";
import path from "node:path";
import { resolveReplayLogPath, truncateText } from "../resolve/env.js";
import { ackDeliveryState, ackTargetResolutionState } from "../resolve/session.js";
import { policyState } from "../state/policy-state.js";
import { buildRolloutFlags, runtimeSwitches } from "./policy-utils.js";

type UnknownRecord = Record<string, unknown>;
type LoggerLike = { warn?: (message: string) => void } | null | undefined;

interface PolicyStateApiLike {
  get: (stateKey: string) => UnknownRecord | undefined;
}

const policyStateApi = policyState as unknown as PolicyStateApiLike;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}



function currentAckOwner(stateKey = ""): string {
  if (!stateKey) return "";
  const state = policyStateApi.get(stateKey) ?? {};
  return String(state.ackOwner ?? state.ack_owner ?? "").trim();
}

function readCorrelation(decision: UnknownRecord): UnknownRecord {
  return asRecord(decision.correlation);
}

function buildRouteOutcome(eventType: string, decision: UnknownRecord, payload: UnknownRecord): UnknownRecord {
  return {
    event: String(eventType || "").trim(),
    route: String(asRecord(decision.route_decision).route ?? payload.route ?? "").trim(),
    taskClass: String(asRecord(decision.route_decision).task_class ?? payload.taskClass ?? "").trim(),
    workerPool: String(asRecord(decision.route_decision).worker_pool ?? payload.workerPool ?? "").trim(),
    requestKind: String(asRecord(decision.router_decision_v2).request_kind ?? payload.requestKind ?? "").trim(),
    delegated: Boolean(payload.delegated),
    executed: Boolean(payload.executed),
  };
}

export async function appendJsonl(pathname: string, payload: Record<string, unknown>): Promise<void> {
  fsSync.mkdirSync(path.dirname(pathname), { recursive: true });
  (fsSync as unknown as { appendFileSync(pathname: string, data: string, encoding: string): void })
    .appendFileSync(pathname, `${JSON.stringify(payload)}\n`, "utf8");
}


export function buildPolicyResolvedReplayPayload(options: Record<string, unknown>): Record<string, unknown> {
  const decision = asRecord(options.decision);
  const ctx = asRecord(options.ctx);
  const boundary = asRecord(options.boundary);
  const metadata = asRecord(options.metadata);
  const conversationControl = asRecord(metadata.conversation_control);
  const intentPacket = asRecord(metadata.intent_packet);
  const routeDecision = asRecord(decision.route_decision);
  const routeHintPolicy = asRecord(decision.route_hint_policy);
  const stateGrounding = asRecord(decision.state_grounding);
  const latencyAck = asRecord(decision.latency_ack);
  const routeRecommendation = asRecord(decision.route_recommendation);
  const arbitration = asRecord(routeRecommendation.arbitration);
  const routerDecision = asRecord(decision.router_decision_v2);
  const routerValidation = asRecord(routerDecision.validation);
  const policyRouter = asRecord(decision.policy_router);
  const judge = asRecord(policyRouter.judge);
  const judgeValidation = asRecord(judge.validation);
  const cache = asRecord(policyRouter.cache);
  const ticketCandidate = asRecord(options.delegationTicketCandidate ?? decision.delegation_ticket_candidate);

  return {
    sessionKey: String(options.stateKey ?? ""),
    sessionId: String(ctx.sessionId ?? ""),
    trigger: String(ctx.trigger ?? ""),
    route: String(routeDecision.route ?? ""),
    systemPreferredRoute: String(routeDecision.system_preferred_route ?? ""),
    workerPool: String(routeDecision.worker_pool ?? ""),
    taskClass: String(routeDecision.task_class ?? ""),
    protectedLane: String(routeDecision.protected_lane ?? ""),
    routeHintRequired: Boolean(routeHintPolicy.required),
    routeHintSubmitted: Boolean(options.routeHintSubmitted),
    stateGroundingRequired: Boolean(stateGrounding.required),
    latencyAckRequired: Boolean(latencyAck.required),
    stickyApplied: Boolean(routeHintPolicy.sticky_applied),
    ackFollowupCandidate: Boolean(routeHintPolicy.ack_followup_candidate),
    ackFollowupApplied: Boolean(routeHintPolicy.ack_followup_applied),
    routeRecommendationConflict: Boolean(arbitration.required),
    routeRecommendationStrategy: String(arbitration.strategy ?? ""),
    routeRecommendationConflictType: String(arbitration.conflict_type ?? ""),
    routeLanguagePacks: asStringArray(decision.route_language_packs),
    sessionBoundaryStatus: String(boundary.status ?? ""),
    canonicalSessionKey: String(boundary.canonicalSessionKey ?? options.stateKey ?? ""),
    conversationControlKind: String(conversationControl.kind ?? ""),
    conversationIntentClass: String(intentPacket.intent_class ?? conversationControl.intent_class ?? ""),
    routerRequestKind: String(routerDecision.request_kind ?? ""),
    routerScope: String(routerDecision.scope ?? ""),
    routerTarget: String(routerDecision.target ?? ""),
    routerEvidenceRequired: asStringArray(routerDecision.evidence_required),
    routerDecisionSource: String(routerDecision.decision_source ?? ""),
    routerDecisionValid: Boolean(routerValidation.passed),
    decisionBucket: String(routeDecision.decision_bucket ?? decision._decision_bucket ?? ""),
    startupCostPolicy: asRecord(routeDecision.startup_cost_policy ?? decision._startup_cost_policy),
    durationHint: String(routeDecision.duration_hint ?? decision._duration_hint ?? ""),
    toolNeedHint: String(routeDecision.tool_need_hint ?? decision._tool_need_hint ?? ""),
    hardDelegateSignal: Boolean(routeDecision.hard_delegate_signal ?? decision._hard_delegate_signal),
    routeReasonCodes: asStringArray(routeDecision.reason_codes),
    delegateReasonCodes: asStringArray(routeDecision.delegate_reason_codes ?? decision._delegate_reason_codes),
    policyJudgeSelected: String(judge.selected ?? ""),
    policyJudgeInvoked: Boolean(judge.invoked),
    policyJudgeApplied: Boolean(judge.applied),
    policyJudgeInvocationState: String(judge.invocation_state ?? ""),
    policyJudgeConfidence: Number(judge.confidence ?? 0),
    policyJudgeValidationProblems: asStringArray(judgeValidation.problems),
    policyJudgePromptVersion: String(judge.prompt_version ?? ""),
    policyJudgeSchemaVersion: String(judge.schema_version ?? ""),
    decisionCacheState: String(cache.state ?? ""),
    usedCachedPolicy: Boolean(options.usedCachedPolicy),
    intentPacketConfidence: Number(intentPacket.confidence ?? 0),
    intentPacketReasons: asStringArray(intentPacket.reason_codes),
    executionCoverage: asRecord(options.executionCoverage),
    executionFreshness: String(options.executionFreshness ?? ""),
    executionSupportsProvenanceReply: Boolean(options.executionSupportsProvenanceReply),
    executionSupportsStatusReply: Boolean(options.executionSupportsStatusReply),
    executionRequiresControlPlaneRefresh: Boolean(options.executionRequiresControlPlaneRefresh),
    lastRoute: String(options.lastRoute ?? ""),
    lastToolsUsed: Array.isArray(options.lastToolsUsed) ? options.lastToolsUsed as string[] : [],
    dispatchExecuted: Boolean(options.dispatchExecuted),
    spawnExecuted: Boolean(options.spawnExecuted),
    nativeTaskId: String(options.nativeTaskId ?? ""),
    nativeFlowId: String(options.nativeFlowId ?? ""),
    resultMaterialized: Boolean(options.resultMaterialized),
    deliveryStatus: String(options.deliveryStatus ?? ""),
    executionCoverageConflict: Boolean(options.executionCoverageConflict),
    ticket_decision: String(ticketCandidate.ticket_decision ?? ""),
    ticket_denial_reason: String(ticketCandidate.ticket_denial_reason ?? ""),
    is_new_work: Boolean(ticketCandidate.is_new_work),
    expected_deliverable: String(ticketCandidate.expected_deliverable ?? ""),
    workContractId: String(options.workContractId ?? asRecord(decision).workContractId ?? ""),
    workContractRoute: String(options.workContractRoute ?? asRecord(asRecord(decision).work_contract).route ?? ""),
    decisionSource: String(options.decisionSource ?? asRecord(asRecord(decision).work_contract).decisionSource ?? ""),
    memoryCoverage: String(options.memoryCoverage ?? ""),
    memoryFreshnessRisk: String(options.memoryFreshnessRisk ?? ""),
    parentContextTokensAdded: Number(options.parentContextTokensAdded ?? 0),
    prompt: truncateText(options.prompt),
  };
}

export function buildPolicyJudgedReplayPayload(decision: Record<string, unknown>): Record<string, unknown> {
  const routeDecision = asRecord(decision.route_decision);
  const policyRouter = asRecord(decision.policy_router);
  const judge = asRecord(policyRouter.judge);
  const validation = asRecord(judge.validation);

  return {
    route: String(routeDecision.route ?? ""),
    taskClass: String(routeDecision.task_class ?? ""),
    protectedLane: String(routeDecision.protected_lane ?? ""),
    policyJudgeSelected: String(judge.selected ?? ""),
    policyJudgeInvoked: Boolean(judge.invoked),
    policyJudgeApplied: Boolean(judge.applied),
    policyJudgeInvocationState: String(judge.invocation_state ?? ""),
    policyJudgeRoute: String(judge.route ?? ""),
    policyJudgeConfidence: Number(judge.confidence ?? 0),
    policyJudgeValidationProblems: asStringArray(validation.problems),
    policyJudgePromptVersion: String(judge.prompt_version ?? ""),
    policyJudgeSchemaVersion: String(judge.schema_version ?? ""),
    validationOutcome: Boolean(validation.passed) ? "passed" : "failed",
  };
}

export function buildRouteValidatedReplayPayload(decision: Record<string, unknown>): Record<string, unknown> {
  const routeDecision = asRecord(decision.route_decision);
  const routerDecision = asRecord(decision.router_decision_v2);
  const validation = asRecord(routerDecision.validation);
  const problems = asStringArray(validation.problems);

  return {
    route: String(routeDecision.route ?? ""),
    systemPreferredRoute: String(routeDecision.system_preferred_route ?? ""),
    workerPool: String(routeDecision.worker_pool ?? ""),
    taskClass: String(routeDecision.task_class ?? ""),
    protectedLane: String(routeDecision.protected_lane ?? ""),
    routerRequestKind: String(routerDecision.request_kind ?? ""),
    routerScope: String(routerDecision.scope ?? ""),
    routerTarget: String(routerDecision.target ?? ""),
    routerEvidenceRequired: asStringArray(routerDecision.evidence_required),
    routerDecisionSource: String(routerDecision.decision_source ?? ""),
    routerDecisionValid: Boolean(validation.passed),
    validationOutcome: Boolean(validation.passed) ? "passed" : "failed",
    reason: problems[0] ?? "",
  };
}

export async function recordPolicyReplay(
  eventType: string,
  payload: Record<string, unknown>,
  logger?: unknown,
  decision?: Record<string, unknown> | null,
): Promise<void> {
  const decisionRecord = asRecord(decision);
  if (decision && !runtimeSwitches(decisionRecord).replay_logging_enabled) {
    return;
  }
  const correlation = readCorrelation(decisionRecord);
  const routeOutcomeEvents = new Set(["policy_resolved", "dispatch_called", "agent_end"]);
  const routeOutcome = decision && routeOutcomeEvents.has(String(eventType || "").trim())
    ? buildRouteOutcome(eventType, decisionRecord, payload)
    : null;

  try {
    await appendJsonl(resolveReplayLogPath(), {
      schema_version: "octoclaw.runtime_policy.replay_event/v1",
      event: eventType,
      at: new Date().toISOString(),
      turnId: String(correlation.turn_id ?? payload.turnId ?? ""),
      decisionId: String(correlation.decision_id ?? payload.decisionId ?? ""),
      deliveryId: String(correlation.delivery_id ?? payload.deliveryId ?? ""),
      runnerJobId: String(correlation.runner_job_id ?? payload.runnerJobId ?? ""),
      taskId: String(correlation.task_id ?? payload.taskId ?? ""),
      ...(decision ? { rolloutFlags: buildRolloutFlags(decisionRecord) } : {}),
      ...(routeOutcome ? { routeOutcome } : {}),
      ...payload,
    });
  } catch (err) {
    (logger as LoggerLike)?.warn?.(`octoclaw runtime replay log failed: ${String(err)}`);
  }
}

export async function recordAckReplay(options: Record<string, unknown>): Promise<void> {
  const decision = asRecord(options.decision);
  const ctx = asRecord(options.ctx);
  const result = asRecord(options.result);
  const kind = String(options.kind ?? "");
  const reason = String(result.reason ?? "");
  const logger = options.logger;
  if (!kind) return;
  if (!Boolean(result.attempted) && !Boolean(result.sent) && !reason) return;
  if (!Boolean(result.attempted) && !Boolean(result.sent) && reason === "not_required") return;

  const sent = Boolean(result.sent);
  const fallbackUsed = Boolean(result.fallback_used);
  const ackMode = sent ? (fallbackUsed ? "progress_update" : "channel_message") : "not_sent";
  await recordPolicyReplay(
    "ack_sent",
    {
      sessionKey: String(options.stateKey ?? asRecord(decision.request).session_key ?? ""),
      sessionId: String(ctx.sessionId ?? ""),
      route: String(asRecord(decision.route_decision).route ?? ""),
      taskClass: String(asRecord(decision.route_decision).task_class ?? ""),
      protectedLane: String(asRecord(decision.route_decision).protected_lane ?? ""),
      phase: String(options.phase ?? ""),
      toolName: String(options.toolName ?? ""),
      ackKind: kind,
      ackMode,
      ack_owner: String(result.ack_owner ?? currentAckOwner(String(options.stateKey ?? "")) ?? ""),
      ack_delivery_state: ackDeliveryState(result),
      ack_target_resolution_state: ackTargetResolutionState(result),
      ackSent: sent,
      reason,
      ackMessage: truncateText(result.message ?? "", 400),
    },
    logger,
    decision,
  );
}

export async function recordDispatchLifecycleReplayEvents(options: Record<string, unknown>): Promise<void> {
  const decision = asRecord(options.decision);
  const payload = asRecord(options.payload);
  const logger = options.logger;
  const sessionKey = String(options.sessionKey ?? "").trim();
  const sessionId = String(options.sessionId ?? "").trim();
  const deliveries = asRecord(payload.deliveries);
  const materialization = asRecord(payload.materialization);
  const routeDecision = asRecord(decision.route_decision);
  const route = String(routeDecision.route ?? payload.route ?? "").trim();
  const workerPool = String(routeDecision.worker_pool ?? payload.worker_pool ?? "").trim();
  const taskClass = String(routeDecision.task_class ?? "").trim();
  const protectedLane = String(routeDecision.protected_lane ?? "").trim();
  const taskId = String(payload.task_id ?? materialization.task_id ?? "").trim();
  const flowId = String(payload.flow_id ?? materialization.flow_id ?? "").trim();
  const executed = Boolean(payload.executed);

  const progress = asRecord(deliveries.progress);
  if (Object.keys(progress).length > 0) {
    await recordPolicyReplay(
      "checkpoint_emitted",
      {
        sessionKey,
        sessionId,
        route,
        workerPool,
        taskClass,
        protectedLane,
        taskId,
        flowId,
        executed,
        summary: truncateText(progress.summary ?? payload.summary ?? "", 1000),
        channel: String(progress.channel ?? "").trim(),
        artifactRefs: asStringArray(progress.artifactRefs),
      },
      logger,
      decision,
    );
  }

  const finalDelivery = asRecord(deliveries.final);
  if (Object.keys(finalDelivery).length > 0) {
    await recordPolicyReplay(
      "deliverable_ready",
      {
        sessionKey,
        sessionId,
        route,
        workerPool,
        taskClass,
        protectedLane,
        taskId,
        flowId,
        executed,
        summary: truncateText(finalDelivery.summary ?? payload.summary ?? "", 1000),
        channel: String(finalDelivery.channel ?? "").trim(),
        artifactRefs: asStringArray(finalDelivery.artifactRefs),
      },
      logger,
      decision,
    );
  }
}
