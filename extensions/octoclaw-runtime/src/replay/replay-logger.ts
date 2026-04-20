import fsSync from "node:fs";
import path from "node:path";
import {
  resolveDeliveryRelayPath,
  resolveReplayLogPath,
  stableId,
  truncateText,
} from "../resolve/env.js";
import {
  DELEGATED_ROUTE_NAMES,
  isDelegatedRoute as isDelegatedRouteName,
  normalizeLiveRoute,
} from "../resolve/route-helpers.js";
import { ackDeliveryState, ackTargetResolutionState } from "../resolve/session.js";
import { policyState } from "../state/policy-state.js";

type UnknownRecord = Record<string, unknown>;
type LoggerLike = { warn?: (message: string) => void } | null | undefined;

interface PolicyStateApiLike {
  get: (stateKey: string) => UnknownRecord | undefined;
  update: (stateKey: string, mutator: (current: UnknownRecord) => UnknownRecord) => void;
}

const policyStateApi = policyState as unknown as PolicyStateApiLike;

interface FsPromisesLike {
  mkdir(pathname: string, options?: { recursive?: boolean }): Promise<void>;
  appendFile(pathname: string, data: string, encoding: string): Promise<void>;
  readFile(pathname: string, encoding: string): Promise<string>;
}

const fs = fsSync as unknown as FsPromisesLike;

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

function conversationIntentClass(decision: UnknownRecord): string {
  const request = asRecord(decision.request);
  const metadata = asRecord(request.metadata);
  const intentPacket = asRecord(metadata.intent_packet);
  const conversationControl = asRecord(metadata.conversation_control);
  return String(intentPacket.intent_class ?? conversationControl.intent_class ?? "").trim();
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") {
          return String(part.text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (isRecord(content) && typeof content.text === "string") {
    return String(content.text).trim();
  }
  return "";
}

function currentAckOwner(stateKey = ""): string {
  if (!stateKey) return "";
  const state = policyStateApi.get(stateKey) ?? {};
  return String(state.ackOwner ?? state.ack_owner ?? "").trim();
}

function updatePolicyState(stateKey: string, mutator: (current: UnknownRecord) => UnknownRecord): void {
  if (!String(stateKey || "").trim()) {
    return;
  }
  policyStateApi.update(stateKey, (current) => mutator(asRecord(current)));
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
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.appendFile(pathname, `${JSON.stringify(payload)}\n`, "utf8");
}

export function deliveryRelayEventIsIdempotent(eventType: string): boolean {
  return new Set([
    "delivery_pending",
    "delivery_observed",
    "delivery_compensated",
    "delivery_reconciled_delivered",
    "delivery_failed",
    "delivery_retry_deferred",
  ]).has(String(eventType || "").trim());
}

export async function hasDeliveryRelayEvent(
  pathname: string,
  eventType: string,
  deliveryId: string,
): Promise<boolean> {
  if (!deliveryRelayEventIsIdempotent(eventType) || !deliveryId) return false;
  try {
    const raw = await fs.readFile(pathname, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const payload = JSON.parse(lines[index]) as unknown;
        const record = asRecord(payload);
        if (String(record.deliveryId ?? "").trim() !== deliveryId) continue;
        if (String(record.event ?? "").trim() === String(eventType || "").trim()) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
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

export function deliveryIdFor(decision: Record<string, unknown>, payload: Record<string, unknown>): string {
  const correlation = readCorrelation(decision);
  const materialization = asRecord(payload.materialization);
  const job = asRecord(payload.job);
  return stableId("delivery", [
    String(correlation.turn_id ?? ""),
    String(correlation.decision_id ?? ""),
    String(payload.task_id ?? ""),
    String(materialization.task_id ?? ""),
    String(job.id ?? ""),
    String(payload.route ?? ""),
  ]);
}

export function deliveryRelayEnabled(decision: Record<string, unknown>): boolean {
  return Boolean(runtimeSwitches(decision).delivery_relay_enabled);
}

export function resolveDeliveryRelaySettings(runtimeCfg?: Record<string, unknown>): Record<string, unknown> {
  const relayCfg = isRecord(runtimeCfg) && isRecord(runtimeCfg.delivery_relay)
    ? runtimeCfg.delivery_relay
    : {};
  return {
    retry_cooldown_seconds: Math.max(0, Number(relayCfg.retry_cooldown_seconds ?? 30)),
  };
}

export function shouldRegisterPendingDelivery(
  _decision: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  return shouldRegisterPendingDeliveryGate(payload).allowed;
}

function shouldRegisterPendingDeliveryGate(payload: Record<string, unknown>): { allowed: boolean; reason: string } {
  const materialization = asRecord(payload.materialization);
  const materializationStatus = String(materialization.status ?? "").trim().toLowerCase();
  const capabilityFailure = isRecord(payload.capability_failure)
    ? payload.capability_failure
    : asRecord(materialization.capability_failure);
  const failureReason = String(capabilityFailure.reason ?? "").trim();
  const taskId = String(payload.task_id ?? materialization.task_id ?? "").trim();
  const runnerJobId = String(asRecord(payload.job).id ?? materialization.runner_job_id ?? "").trim();

  if (failureReason || materializationStatus === "materialization_failed") {
    return { allowed: false, reason: "materialization_failed" };
  }
  if (!taskId && !runnerJobId) {
    return { allowed: false, reason: "missing_execution_identity" };
  }
  return { allowed: true, reason: "ok" };
}

export async function registerPendingDelivery(options: Record<string, unknown>): Promise<void> {
  const decision = asRecord(options.decision);
  const payload = asRecord(options.payload);
  const stateKey = String(options.stateKey ?? "");
  const sessionKey = String(options.sessionKey ?? "");
  const logger = options.logger as LoggerLike;

  if (!deliveryRelayEnabled(decision)) return;
  const registrationGate = shouldRegisterPendingDeliveryGate(payload);
  if (!registrationGate.allowed) return;

  const deliveryId = deliveryIdFor(decision, payload);
  const materialization = asRecord(payload.materialization);
  const job = asRecord(payload.job);
  const taskId = String(payload.task_id ?? materialization.task_id ?? "").trim();
  const runnerJobId = String(job.id ?? materialization.runner_job_id ?? "").trim();
  const request = asRecord(decision.request);
  const requestMetadata = asRecord(request.metadata);
  const replaySessionKey = String(sessionKey || stateKey || requestMetadata.session_key || "").trim();
  const summary = String(options.summary ?? "");

  await recordDeliveryRelayEvent("delivery_pending", {
    deliveryId,
    sessionKey: replaySessionKey,
    turnId: String(readCorrelation(decision).turn_id ?? ""),
    decisionId: String(readCorrelation(decision).decision_id ?? ""),
    route: String(asRecord(decision.route_decision).route ?? payload.route ?? ""),
    requestKind: String(asRecord(decision.router_decision_v2).request_kind ?? ""),
    taskId,
    runnerJobId,
    state: "pending_user_visible_final",
    executed: Boolean(payload.executed),
    materialization,
    summary: truncateText(summary, 1000),
  }, logger);

  if (stateKey) {
    updatePolicyState(stateKey, (current) => ({
      ...current,
      pendingDeliveryId: deliveryId,
      pendingDeliverySummary: truncateText(summary, 1000),
      pendingDeliveryTaskId: taskId,
      pendingDeliveryRunnerJobId: runnerJobId,
      deliveryObserved: false,
    }));
  }
}

export async function reconcilePendingDeliveriesForSession(
  sessionKey: string,
  cwd: string = process.cwd(),
  logger?: unknown,
  runtimeCfg?: Record<string, unknown>,
): Promise<void> {
  void cwd;
  void runtimeCfg;
  const normalizedSessionKey = String(sessionKey || "").trim();
  if (!normalizedSessionKey) {
    return;
  }
  try {
    const relayPath = resolveDeliveryRelayPath();
    const content = fsSync.readFileSync(relayPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const items = lines
      .map((line: string): unknown => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(
        (entry: unknown): entry is Record<string, unknown> => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return false;
          }
          return String((entry as Record<string, unknown>).session_key ?? "") === normalizedSessionKey;
        },
      );
    await recordDeliveryReconcileResults({ items, session_key: normalizedSessionKey }, logger);
  } catch (err) {
    const relayPath = resolveDeliveryRelayPath();
    if (fsSync.existsSync(relayPath)) {
      (logger as LoggerLike)?.warn?.(`octoclaw delivery reconcile failed: ${String(err)}`);
    }
  }
}

export async function recordDeliveryReconcileResults(result: Record<string, unknown>, logger?: unknown): Promise<void> {
  const items = Array.isArray(result.items) ? result.items : [];
  for (const item of items) {
    const record = asRecord(item);
    const status = String(record.status ?? "").trim();
    const deliveryId = String(record.deliveryId ?? "").trim();
    if (!deliveryId || !status) continue;

    if (status === "compensated") {
      await recordDeliveryRelayEvent("delivery_compensated", {
        deliveryId,
        sessionKey: String(result.session_key ?? ""),
        taskId: String(record.taskId ?? ""),
        runnerJobId: String(record.runnerJobId ?? ""),
        state: "completion_relay_sent",
        messageId: String(record.messageId ?? ""),
        summary: truncateText(record.summary ?? "", 1000),
      }, logger);
    } else if (status === "already_delivered") {
      await recordDeliveryRelayEvent("delivery_reconciled_delivered", {
        deliveryId,
        sessionKey: String(result.session_key ?? ""),
        taskId: String(record.taskId ?? ""),
        runnerJobId: String(record.runnerJobId ?? ""),
        state: "already_delivered",
        summary: truncateText(record.summary ?? "", 1000),
      }, logger);
    } else if (status === "send_failed") {
      await recordDeliveryRelayEvent("delivery_failed", {
        deliveryId,
        sessionKey: String(result.session_key ?? ""),
        taskId: String(record.taskId ?? ""),
        runnerJobId: String(record.runnerJobId ?? ""),
        state: "completion_relay_failed",
        error: String(record.error ?? ""),
      }, logger);
    } else if (status === "retry_deferred") {
      await recordDeliveryRelayEvent("delivery_retry_deferred", {
        deliveryId,
        sessionKey: String(result.session_key ?? ""),
        taskId: String(record.taskId ?? ""),
        runnerJobId: String(record.runnerJobId ?? ""),
        state: "completion_relay_retry_deferred",
        failedAttempts: Number(record.failedAttempts ?? 0),
        retryAfter: String(record.retryAfter ?? ""),
      }, logger);
    }
  }
}

export async function recordDeliveryRelayEvent(
  eventType: string,
  payload: Record<string, unknown>,
  logger?: unknown,
): Promise<void> {
  try {
    const pathname = resolveDeliveryRelayPath();
    const deliveryId = String(payload.deliveryId ?? "").trim();
    if (await hasDeliveryRelayEvent(pathname, eventType, deliveryId)) {
      return;
    }
    await appendJsonl(pathname, {
      schema_version: "octoclaw.delivery_relay.event/v1",
      event: eventType,
      at: new Date().toISOString(),
      ...payload,
    });
  } catch (err) {
    (logger as LoggerLike)?.warn?.(`octoclaw delivery relay log failed: ${String(err)}`);
  }
}

export async function recordObservedDeliveryFromMessage(
  message: Record<string, unknown>,
  state: Record<string, unknown>,
  stateKey: string,
  logger?: unknown,
): Promise<void> {
  const deliveryId = String(state.pendingDeliveryId ?? "").trim();
  if (!deliveryId || Boolean(state.deliveryObserved)) {
    return;
  }
  const text = assistantMessageText(message);
  if (!text) return;

  await recordDeliveryRelayEvent("delivery_observed", {
    deliveryId,
    sessionKey: stateKey,
    route: String(asRecord(state.decision).route_decision && asRecord(asRecord(state.decision).route_decision).route || ""),
    taskId: String(state.pendingDeliveryTaskId ?? ""),
    runnerJobId: String(state.pendingDeliveryRunnerJobId ?? ""),
    state: "observed_assistant_final",
    messagePreview: truncateText(text, 1000),
  }, logger);

  updatePolicyState(stateKey, (current) => ({
    ...current,
    deliveryObserved: true,
    deliveredAt: Date.now(),
  }));
}

export function assistantMessageRole(message: Record<string, unknown>): string {
  return String(message.role ?? "").trim().toLowerCase();
}

export function assistantMessageText(message: Record<string, unknown>): string {
  return extractMessageText(message.content);
}

export function replaceAssistantMessageText(message: Record<string, unknown>, text: string): Record<string, unknown> {
  const next = isRecord(message) ? { ...message } : {};
  if (typeof next.content === "string") {
    next.content = text;
    return next;
  }
  if (Array.isArray(next.content)) {
    next.content = [{ type: "text", text }];
    return next;
  }
  if (isRecord(next.content)) {
    next.content = { ...next.content, text };
    return next;
  }
  next.content = [{ type: "text", text }];
  return next;
}

export function delegationFailureReply(state: Record<string, unknown>): { mode: string; message: Record<string, unknown> } {
  const decision = asRecord(state.decision);
  const route = normalizeLiveRoute(asRecord(decision.route_decision).route, "reply");
  const intentClass = String(state.conversationIntentClass ?? conversationIntentClass(decision) ?? "").trim();
  const text = route === "observe" && ["fresh_live_lookup", "local_surface_lookup"].includes(intentClass)
    ? "这次查询还没真正派发到执行链，所以我现在不能把结果说成已经查到。等拿到真实执行结果后我再回复。"
    : "这次任务还没真正派发成功，所以我现在不能把它说成已经完成。等拿到真实执行结果后我再回复。";
  return { mode: "replace", message: { role: "assistant", content: [{ type: "text", text }] } };
}

export function contaminationFallbackReply(): { mode: string; message: Record<string, unknown> } {
  return {
    mode: "replace",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "这条追问命中了被子任务污染的会话上下文，我先按最新执行事实重绑后再回答，这次先不凭旧记忆下结论。" }],
    },
  };
}

export function genericGreetingFallbackReply(state: Record<string, unknown>): { mode: string; message: Record<string, unknown> } {
  const decision = asRecord(state.decision);
  const route = String(asRecord(decision.route_decision).route ?? "").trim();
  let text = "收到，我继续按当前任务处理。";
  if (DELEGATED_ROUTE_NAMES.has(route) && !state.delegated) {
    return delegationFailureReply(state);
  }
  const taskClass = String(asRecord(decision.route_decision).task_class ?? "").trim();
  if (taskClass === "session_control") {
    text = "收到，这条我按当前会话状态继续处理，不再插入泛泛问候。";
  } else if (taskClass === "control_observer") {
    text = "我在，这条我按当前执行事实继续处理，不再复述无关内容。";
  }
  return { mode: "replace", message: { role: "assistant", content: [{ type: "text", text }] } };
}

export function looksLikeGenericGreeting(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;
  return /^(你好[！!。.]?|您好[！!。.]?|嗨[！!。.]?|hello[!.]?|hi[!.]?)(\s*|$)/iu.test(raw)
    || /(有什么需要帮忙的吗|有什么可以帮你的吗|how can i help|what can i help)/iu.test(raw);
}

export function claimedDirectToolNames(text: string): string[] {
  const raw = String(text || "");
  const normalized = raw.toLowerCase();
  const names: string[] = [];
  const add = (name: string) => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const name of [
    "web_fetch",
    "web_search",
    "web.run",
    "exec",
    "shell",
    "curl",
    "openclaw",
    "github api",
  ]) {
    if (normalized.includes(name)) add(name);
  }
  return names;
}

export function looksLikeToolProvenanceClaim(text: string): boolean {
  const raw = String(text || "");
  if (claimedDirectToolNames(raw).length === 0) return false;
  return /(我|这次|刚才|实际|确实|已经|子任务|runner|主\s*agent).{0,40}(用|用了|调用|跑|执行|查|抓|fetch|拿到|返回)/iu.test(raw)
    || /\b(i|this run|that run|actually|used|called|ran|fetched|queried)\b.{0,50}\b(web_fetch|web_search|web\.run|exec|shell|curl|openclaw|github api)\b/iu.test(raw)
    || /direct tools used.{0,80}(实际|actually|used|web_fetch|web_search|exec|unavailable)/iu.test(raw);
}

export function ungroundedToolProvenanceReply(
  state: Record<string, unknown>,
  claimedTools: string[],
): { mode: string; message: Record<string, unknown> } {
  const seen = asStringArray(state.directToolsSeen);
  const text = seen.length > 0
    ? `这条回复里有未被执行事实记录覆盖的工具来源声明（${claimedTools.join(", ")}）。目前可确认的 direct tools 只有：${seen.join(", ")}。我不能把未记录的工具说成已经用过。`
    : `这条回复试图声明用了 ${claimedTools.join(", ")}，但当前 execution facts 没有记录到可验证的 direct tool 调用。按事实口径：route=${String(asRecord(asRecord(state.decision).route_decision).route ?? "").trim() || "unknown"}，request_kind=${String(asRecord(asRecord(state.decision).router_decision_v2).request_kind ?? "").trim() || "unknown"}，Direct tools used 目前不可用。我需要重新走受控查询或执行链路，不能凭记忆声称已经查过。`;
  return { mode: "replace", message: { role: "assistant", content: [{ type: "text", text }] } };
}

export function guardAssistantMessageForPolicyState(
  message: Record<string, unknown>,
  state: Record<string, unknown>,
): { mode: string; message?: Record<string, unknown> } {
  if (assistantMessageRole(message) !== "assistant") {
    return { mode: "pass", message };
  }
  const replyText = assistantMessageText(message);
  if (!replyText) {
    return { mode: "pass", message };
  }
  if (isDelegatedRoute(asRecord(state.decision)) && !state.delegated) {
    const fallback = delegationFailureReply(state);
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }
  const sessionBoundary = asRecord(state.sessionBoundary);
  if (String(sessionBoundary.status ?? "").trim() === "contaminated_subagent_identity") {
    const fallback = contaminationFallbackReply();
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }
  const requestKind = String(asRecord(asRecord(state.decision).router_decision_v2).request_kind ?? "").trim();
  if (looksLikeGenericGreeting(replyText) && requestKind && requestKind !== "chat_or_explain") {
    const fallback = genericGreetingFallbackReply(state);
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }
  const claimedTools = claimedDirectToolNames(replyText);
  const seenTools = new Set(asStringArray(state.directToolsSeen).map((item) => item.toLowerCase()));
  const ungroundedClaims = claimedTools.filter((item) => !seenTools.has(item.toLowerCase()));
  if (ungroundedClaims.length > 0 && looksLikeToolProvenanceClaim(replyText)) {
    const fallback = ungroundedToolProvenanceReply(state, ungroundedClaims);
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }
  return { mode: "pass", message };
}

export function runtimeSwitches(decision: Record<string, unknown>): Record<string, boolean> {
  return asRecord(decision.runtime_switches) as Record<string, boolean>;
}

export function buildRolloutFlags(decision?: Record<string, unknown>): Record<string, boolean> {
  const switches = runtimeSwitches(asRecord(decision));
  const switchRecord = switches as UnknownRecord;
  return {
    contractVersion: Boolean(String(switchRecord.rollout_contract_version ?? "octoclaw.runtime_flags/v1").trim()),
    policyJudgeLiveEnabled: Boolean(switchRecord.policy_judge_live_enabled),
    cheapJudgeLiveEnabled: Boolean(switchRecord.cheap_judge_live_enabled),
    localJudgeLiveEnabled: Boolean(switchRecord.local_judge_live_enabled),
    runnerPoolEnabled: Boolean(switchRecord.runner_pool_enabled),
    deliveryRelayEnabled: Boolean(switchRecord.delivery_relay_enabled),
    legacyRunnerFallbackEnabled: Boolean(switchRecord.legacy_runner_fallback_enabled),
    patrolLoopEnabled: Boolean(switchRecord.patrol_loop_enabled),
    safeModeEnabled: Boolean(switchRecord.safe_mode_enabled),
    judgeLock: Boolean(String(switchRecord.judge_lock ?? "").trim()),
    overrideSources: Boolean(asStringArray(switchRecord.override_sources).length),
  };
}

export function preHintAllowedTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const allowed = new Set([routeHintTool, "octoclaw_status", "octoclaw_task_action"].filter(Boolean));
  const delegateTool = String(toolPolicy.must_delegate_via ?? "").trim();
  if (delegateTool) {
    allowed.add(delegateTool);
  }
  for (const toolName of asStringArray(toolPolicy.allowed_control_tools)) {
    allowed.add(toolName);
  }
  return allowed;
}

export function observerControlTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const allowed = new Set(asStringArray(toolPolicy.observer_control_tools));
  if (routeHintTool) allowed.add(String(routeHintTool).trim());
  allowed.add("octoclaw_status");
  allowed.add("octoclaw_task_action");
  allowed.add("session_status");
  return allowed;
}

export function sessionControlTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const allowed = new Set(asStringArray(toolPolicy.session_control_tools));
  if (routeHintTool) allowed.add(String(routeHintTool).trim());
  allowed.add("octoclaw_status");
  allowed.add("session_status");
  return allowed;
}

export function runnerWorkflowTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const allowed = new Set(asStringArray(toolPolicy.allowed_control_tools));
  const delegateTool = String(toolPolicy.must_delegate_via ?? "").trim();
  if (delegateTool) allowed.add(delegateTool);
  if (routeHintTool) allowed.add(String(routeHintTool).trim());
  allowed.add("octoclaw_status");
  allowed.add("octoclaw_task_action");
  return allowed;
}

export function isControlObserverDecision(decision: Record<string, unknown>): boolean {
  return String(asRecord(decision.route_decision).task_class ?? "").trim() === "control_observer";
}

export function isSessionControlDecision(decision: Record<string, unknown>): boolean {
  return String(asRecord(decision.route_decision).task_class ?? "").trim() === "session_control";
}

export function isRunnerDecision(decision: Record<string, unknown>): boolean {
  return normalizeLiveRoute(asRecord(decision.route_decision).route, "reply") === "observe";
}

export function workflowEnforcementRule(
  decision: Record<string, unknown>,
  toolName: string,
  routeHintTool: string,
): { block: boolean; delegateTool?: string; allowedTools: string[]; route?: string } {
  const route = String(asRecord(decision.route_decision).route ?? "").trim();
  const toolPolicy = asRecord(decision.tool_policy);
  const delegateTool = String(toolPolicy.must_delegate_via ?? "").trim();
  const allowedTools = runnerWorkflowTools(decision, routeHintTool);
  const workflowRequired = route === "observe" || DELEGATED_ROUTE_NAMES.has(route);
  if (!workflowRequired) {
    return { block: false, route, delegateTool, allowedTools: [...allowedTools] };
  }
  if ((delegateTool && toolName === delegateTool) || allowedTools.has(toolName)) {
    return { block: false, route, delegateTool, allowedTools: [...allowedTools] };
  }
  return { block: true, route, delegateTool, allowedTools: [...allowedTools] };
}

export function isDelegatedRoute(decision: Record<string, unknown>): boolean {
  return isDelegatedRouteName(String(asRecord(decision.route_decision).route ?? ""));
}

export function routeHintRequired(decision: Record<string, unknown>): boolean {
  const routeHintPolicy = asRecord(decision.route_hint_policy);
  if (routeHintPolicy.ack_followup_applied) return false;
  if (routeHintPolicy.sticky_applied) return false;
  return Boolean(routeHintPolicy.required);
}

export function shouldRetainPolicyStateOnAgentEnd(state: Record<string, unknown>): boolean {
  return Boolean(isDelegatedRoute(asRecord(state.decision)) && !state.delegated);
}

export function compactPolicyPrompt(decision: Record<string, unknown>): string {
  const routeDecision = asRecord(decision.route_decision);
  const routerDecision = asRecord(decision.router_decision_v2);
  const policyRouter = asRecord(decision.policy_router);
  const judge = asRecord(policyRouter.judge);
  const toolPolicy = asRecord(decision.tool_policy);
  const blocked = asStringArray(toolPolicy.blocked_patterns).slice(0, 8);
  const allowedControls = asStringArray(toolPolicy.allowed_control_tools).slice(0, 8);
  const parts = [
    `route=${String(routeDecision.route ?? "reply")}`,
    `worker_pool=${String(routeDecision.worker_pool ?? "octoclaw-main")}`,
    `task_class=${String(routeDecision.task_class ?? "")}`,
    `request_kind=${String(routerDecision.request_kind ?? "")}`,
    `protected_lane=${String(routeDecision.protected_lane ?? "")}`,
    `must_delegate_via=${String(toolPolicy.must_delegate_via ?? "")}`,
    `policy_judge=${String(judge.selected ?? "")}`,
  ].filter((item) => !item.endsWith("="));
  if (allowedControls.length > 0) parts.push(`allowed_control_tools=${allowedControls.join(",")}`);
  if (blocked.length > 0) parts.push(`blocked_patterns=${blocked.join(",")}`);
  return parts.join(" | ");
}

export function policySummaryText(payload: Record<string, unknown>): string {
  if (payload.summary) {
    return String(payload.summary);
  }
  const routeDecision = asRecord(payload.route_decision);
  const modelPolicy = asRecord(payload.model_policy);
  const reviewPolicy = asRecord(payload.review_policy);
  const route = String(routeDecision.route ?? "reply");
  const workerPool = String(routeDecision.worker_pool ?? "octoclaw-main");
  const profile = String(modelPolicy.profile ?? "");
  const model = String(modelPolicy.selected_model ?? "");
  const protocol = String(routeDecision.protocol ?? "normal");
  const review = Boolean(reviewPolicy.required) ? " / review" : "";
  const suffix = model ? ` / ${model}` : "";
  return `policy=${route} -> ${workerPool} / profile=${profile} / protocol=${protocol}${review}${suffix}`;
}

export function stringifyParamsForPolicy(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

export function matchesBlockedPattern(text: string, patterns: string[]): boolean {
  const haystack = String(text || "").toLowerCase();
  return patterns.some((pattern) => {
    const needle = String(pattern || "").trim().toLowerCase();
    return Boolean(needle) && haystack.includes(needle);
  });
}
