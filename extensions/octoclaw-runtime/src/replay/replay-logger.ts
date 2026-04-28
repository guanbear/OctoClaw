import fsSync from "node:fs";
import path from "node:path";
import {
  resolveDeliveryRelayPath,
  resolveReplayLogPath,
  stableId,
  truncateText,
} from "../resolve/env.js";
import type { TaskStatusProjection } from "@octoclaw/contracts/status-projection";
import {
  detectExecutionTransition,
  emitExecutionTransitionNotification,
} from "../ack/execution-transition-notifier.js";
import {
  authoritativeDecisionRoute,
  canonicalizeDecisionForPolicyState,
  DELEGATED_ROUTE_NAMES,
  isDelegatedRoute as isDelegatedRouteName,
  isObserveMode,
  normalizeLiveRoute,
} from "../resolve/route-helpers.js";
import { ackDeliveryState, ackTargetResolutionState } from "../resolve/session.js";
import { updateAckTrackingState } from "../ack/ack-guard.js";
import { policyState } from "../state/policy-state.js";

type UnknownRecord = Record<string, unknown>;
type LoggerLike = { warn?: (message: string) => void } | null | undefined;

type PolicyContextState = UnknownRecord & {
  canonicalSessionKey?: string;
  decision?: UnknownRecord;
  delegateTaskContext?: unknown;
  delegated?: boolean;
  dispatchExecuted?: boolean;
  spawnExecuted?: boolean;
  directToolsSeen?: unknown;
  toolsUsed?: unknown;
  workContractId?: unknown;
};

/**
 * Structured receipt of what execution happened in a turn.
 * This is the PRIMARY provenance source — not regex, not model claims.
 */
export interface TurnExecutionReceipt {
  /** Unique turn ID */
  turnId: string;
  /** Session key */
  sessionKey: string;
  /** Route that was used */
  route: string;
  /** Whether delegation actually happened (verified via dispatch ledger) */
  delegated: boolean;
  /** Whether octoclaw_dispatch actually executed (not just planned) */
  dispatchExecuted: boolean;
  /** Whether a child session/task run actually spawned (not just TaskFlow created) */
  spawnExecuted: boolean;
  /** WorkContract id when this turn has a sealed contract */
  workContractId: string | null;
  /** Delegate task ID if delegated */
  delegateTaskId: string | null;
  /** Native taskflow task ID (from taskflow port / plugin binding) */
  nativeTaskId: string | null;
  /** Native taskflow flow ID */
  nativeFlowId: string | null;
  /** Child session continuity key */
  childSessionKey: string | null;
  /** Provider child session id */
  childSessionId: string | null;
  /** Child run id when distinct from provider session id */
  childRunId: string | null;
  /** Native TaskFlow revision observed by the turn */
  nativeFlowRevision: number | null;
  /** Native TaskFlow expected revision used for mutation */
  nativeFlowExpectedRevision: number | null;
  /** Native mutation attempted */
  nativeFlowMutation: string | null;
  /** Whether native mutation was applied */
  nativeFlowMutationApplied: boolean | null;
  /** Native mutation error, if any */
  nativeFlowMutationError: string | null;
  /** Worker pool that handled execution */
  workerPool: string | null;
  /** Tools that were actually called (verified, not claimed) */
  toolsUsed: string[];
  /** Whether a result was materialized (artifact/output produced) */
  resultMaterialized: boolean;
  /** Delivery status for the delegated result */
  deliveryStatus: string | null;
  /** Duration in ms */
  durationMs: number;
  /** Outcome */
  outcome: "completed" | "failed" | "timeout" | "unknown";
  /** Timestamp */
  completedAt: number;
  /** Execution coverage telemetry */
  executionCoverage: string | null;
  executionSupportsProvenanceReply: boolean;
  executionSupportsStatusReply: boolean;
  executionRequiresControlPlaneRefresh: boolean;
  /** Memory coverage telemetry */
  memoryCoverage: string | null;
  /** Authority relationship between execution and memory */
  authority: string | null;
  /** Parent context pollution telemetry */
  parentContextTokensAdded: number;
  resultPacketTokens: number;
  artifactReopenCount: number;
}

interface PolicyStateApiLike {
  get: (stateKey: string) => UnknownRecord | undefined;
  update: (stateKey: string, mutator: (current: UnknownRecord) => UnknownRecord) => void;
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

function asBoolean(value: unknown): boolean {
  return value === true;
}

function explicitBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function hasExplicitTrue(values: unknown[]): boolean {
  return values.some((value) => explicitBoolean(value) === true);
}

function hasExplicitFalse(values: unknown[]): boolean {
  return values.some((value) => explicitBoolean(value) === false);
}

function hasCurrentSpawnEvidence(...records: UnknownRecord[]): boolean {
  return records.some((record) => Boolean(asString(
    record.runId
      ?? record.run_id
      ?? record.childRunId
      ?? record.child_run_id
      ?? record.childSessionId
      ?? record.child_session_id
      ?? record.childSessionKey
      ?? record.child_session_key,
  )));
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value ?? "").trim();
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function asString(value: unknown, fallback: string | null = null): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export function buildTurnExecutionReceipt(
  state: PolicyContextState,
  durationMs: number,
  completedAt?: number,
): TurnExecutionReceipt {
  const decision = asRecord(state.decision);
  const routeDecision = asRecord(decision.route_decision);
  const delegateCtx = asRecord(state.delegateTaskContext);
  const runtimeTruth = asRecord(decision.runtime_truth);
  const workContract = asRecord(decision.work_contract);
  const executionLayer = asRecord(decision.execution_layer ?? decision._execution_coverage);
  const memoryLayer = asRecord(decision.memory_layer ?? decision._memory_coverage);
  const coverageSnapshot = asRecord(decision.context_coverage ?? decision.coverage);
  const telemetry = asRecord(decision.telemetry ?? workContract.telemetry);
  const delegateTask = asRecord(runtimeTruth.delegateTask);
  const binding = asRecord(runtimeTruth.binding);
  const nativeTaskBinding = asRecord(runtimeTruth.nativeTaskBinding);
  const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
  const nativeAttemptBinding = asRecord(delegateAttempt.nativeBinding);
  const evidence = asRecord(runtimeTruth.evidence);
  const status = asString(delegateCtx.taskStatus ?? delegateCtx.status);
  const hasDelegateIdentity = Boolean(
    asString(delegateCtx.delegateTaskId ?? delegateCtx.taskId ?? delegateTask.delegateTaskId ?? binding.taskId),
  );
  const routeWasDelegate = asString(routeDecision.route) === "delegate";
  const delegated = state.delegated === true || (routeWasDelegate && hasDelegateIdentity);
  const nativeTaskId = asString(
    nativeTaskBinding.nativeTaskId ?? nativeAttemptBinding.nativeTaskId ?? binding.taskId,
  );
  const nativeFlowId = asString(
    nativeTaskBinding.nativeFlowId ?? nativeAttemptBinding.nativeFlowId ?? binding.flowId,
  );
  const dispatchExecuted = state.dispatchExecuted === true || decision.dispatchExecuted === true;
  const spawnSignals = [
    state.spawnExecuted,
    state.spawn_executed,
    decision.spawnExecuted,
    decision.spawn_executed,
    executionLayer.spawn_executed,
    runtimeTruth.spawnExecuted,
    runtimeTruth.spawn_executed,
    delegateAttempt.spawnExecuted,
    delegateAttempt.spawn_executed,
    nativeTaskBinding.spawnExecuted,
    nativeTaskBinding.spawn_executed,
    nativeAttemptBinding.spawnExecuted,
    nativeAttemptBinding.spawn_executed,
    evidence.spawnExecuted,
    evidence.spawn_executed,
  ];
  const spawnExecuted = hasExplicitTrue(spawnSignals)
    || hasCurrentSpawnEvidence(nativeTaskBinding, nativeAttemptBinding, delegateAttempt, evidence, binding);
  const delivery = asRecord(decision.delivery);
  const resultMaterialized = Boolean(asString(delivery.artifact_path) || asString(delivery.result_path));
  const deliveryStatus = asString(
    delivery.status ?? delivery.delivery_status ?? decision.delivery_status,
  );
  const childSessionKey = asString(
    workContract.childSessionKey
      ?? binding.childSessionKey
      ?? nativeTaskBinding.childSessionKey
      ?? nativeTaskBinding.child_session_key
      ?? nativeAttemptBinding.childSessionKey
      ?? nativeAttemptBinding.child_session_key
      ?? delegateAttempt.childSessionKey
      ?? delegateAttempt.child_session_key
      ?? evidence.childSessionKey
      ?? evidence.child_session_key,
  );
  const childSessionId = asString(
    workContract.childSessionId
      ?? binding.childSessionId
      ?? nativeTaskBinding.childSessionId
      ?? nativeTaskBinding.child_session_id
      ?? nativeAttemptBinding.childSessionId
      ?? nativeAttemptBinding.child_session_id
      ?? delegateAttempt.childSessionId
      ?? delegateAttempt.child_session_id
      ?? evidence.childSessionId
      ?? evidence.child_session_id,
  );
  const childRunId = asString(
    workContract.childRunId
      ?? binding.childRunId
      ?? binding.runId
      ?? binding.run_id
      ?? nativeTaskBinding.childRunId
      ?? nativeTaskBinding.child_run_id
      ?? nativeTaskBinding.runId
      ?? nativeTaskBinding.run_id
      ?? nativeAttemptBinding.childRunId
      ?? nativeAttemptBinding.child_run_id
      ?? nativeAttemptBinding.runId
      ?? nativeAttemptBinding.run_id
      ?? delegateAttempt.childRunId
      ?? delegateAttempt.child_run_id
      ?? delegateAttempt.runId
      ?? delegateAttempt.run_id
      ?? evidence.childRunId
      ?? evidence.child_run_id
      ?? evidence.runId
      ?? evidence.run_id,
  );
  const executionCoverage = asString(
    telemetry.executionCoverage
      ?? executionLayer.coverage
      ?? asRecord(coverageSnapshot.execution).coverage,
  );
  const memoryCoverage = asString(
    telemetry.memoryCoverage
      ?? memoryLayer.coverage
      ?? asRecord(coverageSnapshot.memory).coverage,
  );
  return {
    turnId: asString(state.canonicalSessionKey) || `turn-${completedAt ?? Date.now()}`,
    sessionKey: asString(state.canonicalSessionKey) ?? "",
    route: asString(routeDecision.route, "reply") ?? "reply",
    delegated,
    dispatchExecuted,
    spawnExecuted,
    workContractId: asString(state.workContractId ?? decision.workContractId ?? workContract.workContractId),
    delegateTaskId: asString(delegateCtx.delegateTaskId ?? delegateCtx.taskId ?? delegateCtx.task_id),
    nativeTaskId,
    nativeFlowId,
    childSessionKey,
    childSessionId,
    childRunId,
    nativeFlowRevision: asNumber(
      telemetry.nativeFlowRevision
        ?? nativeTaskBinding.nativeFlowRevision
        ?? nativeTaskBinding.revision
        ?? nativeAttemptBinding.nativeFlowRevision
        ?? nativeAttemptBinding.revision
        ?? binding.revision,
    ),
    nativeFlowExpectedRevision: asNumber(
      telemetry.nativeFlowExpectedRevision
        ?? nativeTaskBinding.nativeFlowExpectedRevision
        ?? nativeTaskBinding.expectedRevision
        ?? nativeAttemptBinding.nativeFlowExpectedRevision
        ?? nativeAttemptBinding.expectedRevision
        ?? binding.expectedRevision,
    ),
    nativeFlowMutation: asString(telemetry.nativeFlowMutation ?? runtimeTruth.nativeFlowMutation),
    nativeFlowMutationApplied: (
      telemetry.nativeFlowMutationApplied !== undefined || runtimeTruth.nativeFlowMutationApplied !== undefined
        ? asBoolean(telemetry.nativeFlowMutationApplied ?? runtimeTruth.nativeFlowMutationApplied)
        : null
    ),
    nativeFlowMutationError: asString(telemetry.nativeFlowMutationError ?? runtimeTruth.nativeFlowMutationError),
    workerPool: asString(routeDecision.worker_pool),
    toolsUsed: asStringArray(state.toolsUsed ?? state.directToolsSeen ?? []),
    resultMaterialized,
    deliveryStatus,
    durationMs,
    outcome: delegated
      ? (status === "completed" ? "completed" : status === "failed" ? "failed" : status === "timeout" || status === "timed_out" ? "timeout" : "unknown")
      : "completed",
    completedAt: completedAt ?? Date.now(),
    executionCoverage,
    executionSupportsProvenanceReply: asBoolean(telemetry.executionSupportsProvenanceReply ?? executionLayer.supports_provenance_reply),
    executionSupportsStatusReply: asBoolean(telemetry.executionSupportsStatusReply ?? executionLayer.supports_status_reply),
    executionRequiresControlPlaneRefresh: asBoolean(telemetry.executionRequiresControlPlaneRefresh ?? executionLayer.requires_control_plane_refresh),
    memoryCoverage,
    authority: asString(telemetry.authority ?? coverageSnapshot.authority),
    parentContextTokensAdded: asNumber(telemetry.parentContextTokensAdded ?? decision.parentContextTokensAdded) ?? 0,
    resultPacketTokens: asNumber(telemetry.resultPacketTokens ?? delivery.resultPacketTokens ?? delivery.result_packet_tokens) ?? 0,
    artifactReopenCount: asNumber(telemetry.artifactReopenCount ?? state.artifactReopenCount) ?? 0,
  };
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

function buildMinimalProjectionForDelivery(record: UnknownRecord, sessionKey: string): TaskStatusProjection {
  const generatedAt = new Date().toISOString();
  const deliveryId = asString(record.deliveryId) ?? "";
  const taskId = asString(record.taskId ?? record.task_id ?? deliveryId, deliveryId) ?? deliveryId;
  const runnerJobId = asString(record.runnerJobId ?? record.runner_job_id);
  const summary = asString(record.summary ?? record.error, "") ?? "";
  return {
    schemaVersion: "octoclaw.task_status_projection/v1" as const,
    projectionId: `delivery:${deliveryId || taskId}:${generatedAt}`,
    generatedAt,
    requestId: "",
    flowId: runnerJobId ?? "",
    taskId,
    parentThreadKey: sessionKey || undefined,
    title: summary,
    summary,
    taskSummary: summary,
    route: "delegate" as const,
    role: "default",
    backend: "octoclaw.delivery_relay",
    modelProfile: "",
    status: "failed",
    statusReason: "delivery_failed",
    success: false,
    failureCode: "delivery_failed",
    failureMessage: asString(record.error) ?? undefined,
    createdAt: generatedAt,
    failedAt: generatedAt,
    elapsedMs: 0,
    dispatchExecuted: true,
    spawnExecuted: true,
    resultMaterialized: true,
    artifactRefs: [],
    artifactRefIds: [],
    actions: ["details", "copy_ref", "retry"],
  };
}

function buildMinimalProjectionForReceipt(receipt: TurnExecutionReceipt): TaskStatusProjection {
  const generatedAt = new Date(receipt.completedAt || Date.now()).toISOString();
  const taskId = receipt.delegateTaskId ?? receipt.nativeTaskId ?? receipt.turnId;
  const summary = receipt.resultMaterialized ? "Task result is ready for delivery." : "";
  return {
    schemaVersion: "octoclaw.task_status_projection/v1" as const,
    projectionId: `receipt:${receipt.turnId}:${generatedAt}`,
    generatedAt,
    requestId: receipt.turnId,
    flowId: receipt.nativeFlowId ?? receipt.workContractId ?? "",
    taskId,
    workContractId: receipt.workContractId ?? undefined,
    parentThreadKey: receipt.sessionKey || undefined,
    title: summary,
    summary,
    taskSummary: summary,
    route: receipt.delegated ? "delegate" as const : "reply" as const,
    role: receipt.delegated ? "default" : "main",
    backend: receipt.workerPool ?? "octoclaw.delegate",
    modelProfile: "",
    status: receipt.resultMaterialized ? "deliverable_ready" : "running",
    statusReason: receipt.resultMaterialized ? "final_result_exists_delivery_pending" : "execution_receipt",
    success: false,
    createdAt: generatedAt,
    completedAt: receipt.outcome === "completed" ? generatedAt : undefined,
    elapsedMs: Math.max(0, receipt.durationMs),
    dispatchExecuted: receipt.dispatchExecuted,
    spawnExecuted: receipt.spawnExecuted,
    resultMaterialized: receipt.resultMaterialized,
    nativeFlowRevision: receipt.nativeFlowRevision ?? undefined,
    nativeFlowExpectedRevision: receipt.nativeFlowExpectedRevision ?? undefined,
    childSessionKey: receipt.childSessionKey ?? undefined,
    childSessionId: receipt.childSessionId ?? undefined,
    runId: receipt.childRunId ?? undefined,
    childRunId: receipt.childRunId ?? undefined,
    artifactRefs: [],
    artifactRefIds: [],
    actions: ["details", "copy_ref", "open"],
  };
}

export function emitResultReadyIfTransition(params: {
  previousReceipt: TurnExecutionReceipt | null;
  currentReceipt: TurnExecutionReceipt;
  stateKey?: string;
  replyToMessageId?: string;
  cwd?: string;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}): void {
  // Side-effect helper for receipt consumers (for example extension-entry.ts agent_end
  // or before_message_write hooks). Keep buildTurnExecutionReceipt pure.
  const transition = detectExecutionTransition(params.previousReceipt, params.currentReceipt);
  if (transition !== "result_ready") {
    return;
  }
  try {
    void emitExecutionTransitionNotification({
      transitionKind: "result_ready",
      projection: buildMinimalProjectionForReceipt(params.currentReceipt),
      attemptId: String(params.currentReceipt.delegateTaskId ?? params.currentReceipt.nativeTaskId ?? params.currentReceipt.turnId),
      workContractId: params.currentReceipt.workContractId ?? "",
      sessionKey: params.currentReceipt.sessionKey,
      stateKey: params.stateKey ?? params.currentReceipt.sessionKey,
      replyToMessageId: params.replyToMessageId,
      cwd: params.cwd,
      logger: params.logger,
    });
  } catch (_) { /* fire-and-forget */ }
}

export async function appendJsonl(pathname: string, payload: Record<string, unknown>): Promise<void> {
  fsSync.mkdirSync(path.dirname(pathname), { recursive: true });
  (fsSync as unknown as { appendFileSync(pathname: string, data: string, encoding: string): void })
    .appendFileSync(pathname, `${JSON.stringify(payload)}\n`, "utf8");
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
    const raw = fsSync.readFileSync(pathname, "utf8");
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
  const route = String(payload.route ?? materialization.type ?? "").trim();
  const runtimeTruth = asRecord(payload.runtime_truth);
  const nativeTaskBinding = asRecord(runtimeTruth.nativeTaskBinding);
  const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
  const nativeAttemptBinding = asRecord(delegateAttempt.nativeBinding);
  const evidence = asRecord(runtimeTruth.evidence);
  const spawnSignals = [
    payload.spawn_executed,
    payload.spawnExecuted,
    nativeTaskBinding.spawnExecuted,
    nativeTaskBinding.spawn_executed,
    delegateAttempt.spawnExecuted,
    delegateAttempt.spawn_executed,
    nativeAttemptBinding.spawnExecuted,
    nativeAttemptBinding.spawn_executed,
    evidence.spawnExecuted,
    evidence.spawn_executed,
  ];
  const hasStrongRunEvidence = Boolean(
    asString(nativeTaskBinding.runId)
    || asString(nativeTaskBinding.run_id)
    || asString(nativeTaskBinding.childRunId)
    || asString(nativeTaskBinding.child_run_id)
    || asString(nativeTaskBinding.childSessionId)
    || asString(nativeTaskBinding.child_session_id)
    || asString(delegateAttempt.runId)
    || asString(delegateAttempt.run_id)
    || asString(delegateAttempt.childRunId)
    || asString(delegateAttempt.child_run_id)
    || asString(delegateAttempt.childSessionId)
    || asString(delegateAttempt.child_session_id)
    || asString(nativeAttemptBinding.runId)
    || asString(nativeAttemptBinding.run_id)
    || asString(nativeAttemptBinding.childRunId)
    || asString(nativeAttemptBinding.child_run_id)
    || asString(nativeAttemptBinding.childSessionId)
    || asString(nativeAttemptBinding.child_session_id)
    || asString(evidence.runId)
    || asString(evidence.run_id)
    || asString(evidence.childRunId)
    || asString(evidence.child_run_id)
    || asString(evidence.childSessionId)
    || asString(evidence.child_session_id)
  );
  const hasCurrentChildSessionKey = Boolean(
    asString(nativeTaskBinding.childSessionKey)
    || asString(nativeTaskBinding.child_session_key)
    || asString(delegateAttempt.childSessionKey)
    || asString(delegateAttempt.child_session_key)
    || asString(nativeAttemptBinding.childSessionKey)
    || asString(nativeAttemptBinding.child_session_key)
    || asString(evidence.childSessionKey)
    || asString(evidence.child_session_key)
  );
  const hasSpawnEvidence = hasExplicitTrue(spawnSignals)
    || hasStrongRunEvidence
    || (!hasExplicitFalse(spawnSignals) && hasCurrentChildSessionKey);

  if (failureReason || materializationStatus === "materialization_failed") {
    return { allowed: false, reason: "materialization_failed" };
  }
  if (!taskId && !runnerJobId) {
    return { allowed: false, reason: "missing_execution_identity" };
  }
  if (route === "delegate" && !runnerJobId && !hasSpawnEvidence) {
    return { allowed: false, reason: "spawn_not_confirmed" };
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
    updateAckTrackingState(stateKey, { delivery_pending: true, delegated_running: false });
  }

  const executed = Boolean(payload.executed);
  if (taskId && executed) {
    try {
      void emitExecutionTransitionNotification({
        transitionKind: "result_ready",
        projection: {
          schemaVersion: "octoclaw.task_status_projection/v1" as const,
          projectionId: `exec_transition_${taskId}_${Date.now()}`,
          generatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          requestId: "",
          flowId: asString(materialization.flow_id) ?? "",
          taskId,
          title: "",
          summary: truncateText(summary, 500),
          taskSummary: "",
          route: "delegate" as const,
          role: "",
          backend: "octoclaw.delegate",
          modelProfile: "",
          status: "deliverable_ready",
          statusReason: "final_result_exists_delivery_pending",
          success: false,
          dispatchExecuted: true,
          spawnExecuted: true,
          resultMaterialized: true,
          elapsedMs: 0,
          artifactRefs: [],
          artifactRefIds: [],
          actions: [],
        },
        attemptId: taskId,
        workContractId: asString(payload.work_contract_id ?? decision.workContractId ?? "") ?? "",
        sessionKey: replaySessionKey,
        stateKey,
        logger: logger as { debug?: (msg: string) => void; warn?: (msg: string) => void },
      });
    } catch (_) {}
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
      const sessionKey = String(result.session_key ?? "");
      try {
        void emitExecutionTransitionNotification({
          transitionKind: "delivery_failed",
          projection: buildMinimalProjectionForDelivery({ ...record, deliveryId }, sessionKey),
          attemptId: String(record.taskId ?? deliveryId),
          workContractId: "",
          sessionKey: sessionKey,
          stateKey: sessionKey,
        });
      } catch (_) { /* fire-and-forget */ }
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
  updateAckTrackingState(stateKey, { delivery_pending: false, delivered: true });
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
  const decision = canonicalizeDecisionForPolicyState(asRecord(state.decision));
  const route = authoritativeDecisionRoute(decision, "reply");
  const intentClass = String(state.conversationIntentClass ?? conversationIntentClass(decision) ?? "").trim();
  const observe = route === "delegate" && isObserveMode(
    String(asRecord(decision.route_decision).judge_role ?? asRecord(decision).role ?? "").trim(),
    String(asRecord(decision).executionProfile ?? "").trim(),
  );
  const text = observe && ["fresh_live_lookup", "local_surface_lookup"].includes(intentClass)
    ? "这次查询还没拿到结果，等我拿到真实执行结果后回复。"
    : "这次任务还没派发成功，等我拿到真实执行结果后回复。";
  return { mode: "replace", message: { role: "assistant", content: [{ type: "text", text }] } };
}

export function contaminationFallbackReply(): { mode: string; message: Record<string, unknown> } {
  return {
    mode: "replace",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "让我先查一下当前任务最新状态。" }],
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

function hasStatusProjectionToolEvidence(state: Record<string, unknown>): boolean {
  const seenTools = new Set([
    ...asStringArray(state.controlToolsSeen),
    ...asStringArray(state.directToolsSeen),
  ].map((item) => item.toLowerCase()));
  return seenTools.has("octoclaw_status") || seenTools.has("octoclaw_task_action");
}

function looksLikeTransientProcessingAck(text: string): boolean {
  const raw = String(text || "").trim();
  return raw.length > 0 && raw.length < 30 && (
    /^(收到|好的|好|明白|正在|处理中)(?:[，,。.!！\s]|$)/u.test(raw)
    || /^(ok|okay|working|checking|looking|processing)\b/iu.test(raw)
  );
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

const DELEGATION_REASONING_PATTERNS: readonly RegExp[] = [
  /(?:先确认一下|先看看|让我先确认|确认一下).{0,30}(派发|委派|delegation|dispatch|边界|boundary)/iu,
  /(?:任务边界|派发边界|委派边界).{0,20}(清楚|清晰|明确)/iu,
  /(?:适合|适合独立|应当).{0,15}(派发|委派|delegate)/iu,
  /(?:这条追问命中了被子任务污染|contaminated.*subagent)/iu,
  /(?:OctoClaw runtime policy is authoritative|Do not hand-write session)/iu,
];

function looksLikeRawSubagentContextLeak(text: string): boolean {
  return /BEGIN_OPENCLAW_INTERNAL_CONTEXT|Internal task completion event|source:\s*subagent|session_key:\s*agent:.*subagent|childTranscript|rawTranscript|workerChainOfThought|subagent session_key|child session transcript/iu.test(text)
    || /(?:我是|作为).{0,12}(?:子\s*agent|subagent|worker)/iu.test(text)
    || /(?:子\s*agent|subagent|worker).{0,20}(?:完整|原始|raw).{0,20}(?:transcript|对话|记录|上下文)/iu.test(text);
}

export function sanitizeDelegationReasoning(text: string): string {
  let result = text;
  for (const pattern of DELEGATION_REASONING_PATTERNS) {
    result = result.replace(pattern, "");
  }
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  if (!result) {
    return "收到，正在处理。";
  }
  return result;
}


function appendExecutionCoverageProjection(replyText: string, state: Record<string, unknown>): string {
  const decision = asRecord(state.decision);
  const workContract = asRecord(decision.work_contract);
  const executionPacket = asRecord(decision._execution_coverage_packet);
  const executionLayer = asRecord(decision.execution_layer ?? decision._execution_coverage);
  const routeDecision = asRecord(decision.route_decision);
  const routerDecision = asRecord(decision.router_decision_v2);
  const requestKind = String(routerDecision.request_kind ?? "").trim();
  const isCoverageAnswer = String(workContract.decisionSource ?? "") === "execution_coverage"
    || String(executionPacket.replyMode ?? workContract.replyMode ?? "") === "answer"
    || decision._execution_supports_provenance_reply === true
    || decision._execution_supports_status_reply === true
    || requestKind === "status_or_provenance";
  if (!isCoverageAnswer || String(routeDecision.route ?? workContract.route ?? "reply") !== "reply") {
    return replyText;
  }
  if (/(?:WorkContract|ExecutionCoverage|coverage|证据)/iu.test(replyText)) {
    return replyText;
  }
  const contractId = String(workContract.workContractId ?? decision.workContractId ?? "unknown").trim();
  const coverage = String(asRecord(asRecord(executionPacket.coverage).execution).coverage ?? executionLayer.coverage ?? "unknown").trim();
  const dispatchExecuted = String(executionPacket.dispatchExecuted ?? executionLayer.dispatch_executed ?? state.dispatchExecuted ?? false);
  const spawnExecuted = String(executionPacket.spawnExecuted ?? executionLayer.spawn_executed ?? state.spawnExecuted ?? false);
  const routeSource = String(workContract.decisionSource ?? routeDecision.route_source ?? "unknown").trim();
  return `${replyText.trim()}\n\n证据投影：WorkContract=${contractId}；ExecutionCoverage coverage=${coverage}；route_source=${routeSource}；dispatchExecuted=${dispatchExecuted}；spawnExecuted=${spawnExecuted}。`;
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
  const dispatchRoute = String(state.dispatchRoute ?? state.dispatch_route ?? "").trim();
  const dispatchExecuted = state.dispatchExecuted === true || state.dispatch_executed === true;
  const spawnExecuted = state.spawnExecuted === true || state.spawn_executed === true;
  const resultMaterialized = state.resultMaterialized === true || state.result_materialized === true;
  const statusProjectionToolSeen = hasStatusProjectionToolEvidence(state);
  const hasExecutionEvidence = dispatchExecuted || spawnExecuted || resultMaterialized;
  if (
    isDelegatedRoute(asRecord(state.decision))
    && !statusProjectionToolSeen
    && !hasExecutionEvidence
    && !(dispatchRoute === "reply" && dispatchExecuted)
    && !looksLikeTransientProcessingAck(replyText)
  ) {
    const fallback = delegationFailureReply(state);
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }
  const sessionBoundary = asRecord(state.sessionBoundary);
  if (String(sessionBoundary.status ?? "").trim() === "contaminated_subagent_identity" && looksLikeRawSubagentContextLeak(replyText)) {
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
  const sanitized = sanitizeDelegationReasoning(replyText);
  if (sanitized !== replyText) {
    return { mode: "replace", message: replaceAssistantMessageText(message, sanitized) };
  }
  const provenanceProjected = appendExecutionCoverageProjection(replyText, state);
  if (provenanceProjected !== replyText) {
    return { mode: "replace", message: replaceAssistantMessageText(message, provenanceProjected) };
  }
  if (!statusProjectionToolSeen && !(dispatchExecuted || spawnExecuted)) {
    const dispatchClaimPatterns = [
      /(?:已经|已|刚)?(?:派|委派|分派|指派|分配|delegate|dispatch|spawn|启动|启动了).*(?:子?\s*agent|worker|任务|task)/iu,
      /(?:让|叫|请).*(?:去|来|做|处理|执行|查).*(?:子?\s*agent|worker)/iu,
      /(?:已|已经)?(?:交给|分配给|指派给|派给).*(?:处理|执行|完成)/iu,
      /(?:子?\s*agent|worker|子任务).{0,30}(?:已|已经|刚|刚才|之前)?.{0,10}(?:跑完|完成|返回|回传|拿到|给出)/iu,
      /(?:已|已经|刚|刚才|之前).{0,30}(?:子?\s*agent|worker|子任务).{0,30}(?:跑完|完成|返回|回传|拿到|给出)/iu,
      /sessions_spawn|session_spawn/iu,
      /(?:route|路由).*(?:switched|切换|改为|切换到).*(?:delegate|delegat|委派|派发)/iu,
    ];
    for (const pattern of dispatchClaimPatterns) {
      if (pattern.test(replyText)) {
        return { mode: "replace", message: replaceAssistantMessageText(message, "这次任务还没派发成功，等我拿到真实执行结果后回复。") };
      }
    }
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
  const workContract = asRecord(decision.work_contract);
  const allowed = new Set([routeHintTool, "octoclaw_status", "octoclaw_task_action"].filter(Boolean));
  const delegateTool = String(toolPolicy.must_delegate_via ?? "").trim();
  if (delegateTool) {
    allowed.add(delegateTool);
  }
  for (const toolName of asStringArray(toolPolicy.allowed_control_tools)) {
    allowed.add(toolName);
  }
  for (const toolName of asStringArray(workContract.allowedTools ?? workContract.allowed_tools)) {
    allowed.add(toolName);
  }
  return allowed;
}

export function observerControlTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const workContract = asRecord(decision.work_contract);
  const allowed = new Set(asStringArray(toolPolicy.observer_control_tools));
  if (routeHintTool) allowed.add(String(routeHintTool).trim());
  allowed.add("octoclaw_status");
  allowed.add("octoclaw_task_action");
  allowed.add("session_status");
  for (const toolName of asStringArray(workContract.allowedTools ?? workContract.allowed_tools)) {
    allowed.add(toolName);
  }
  return allowed;
}

export function sessionControlTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const workContract = asRecord(decision.work_contract);
  const allowed = new Set(asStringArray(toolPolicy.session_control_tools));
  if (routeHintTool) allowed.add(String(routeHintTool).trim());
  allowed.add("octoclaw_status");
  allowed.add("session_status");
  for (const toolName of asStringArray(workContract.allowedTools ?? workContract.allowed_tools)) {
    allowed.add(toolName);
  }
  return allowed;
}

export function runnerWorkflowTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const workContract = asRecord(decision.work_contract);
  const allowed = new Set(asStringArray(toolPolicy.allowed_control_tools));
  const delegateTool = String(toolPolicy.must_delegate_via ?? "").trim();
  if (delegateTool) allowed.add(delegateTool);
  if (routeHintTool) allowed.add(String(routeHintTool).trim());
  allowed.add("octoclaw_status");
  allowed.add("octoclaw_task_action");
  for (const toolName of asStringArray(workContract.allowedTools ?? workContract.allowed_tools)) {
    allowed.add(toolName);
  }
  return allowed;
}

export function isControlObserverDecision(decision: Record<string, unknown>): boolean {
  return String(asRecord(decision.route_decision).task_class ?? "").trim() === "control_observer";
}

export function isSessionControlDecision(decision: Record<string, unknown>): boolean {
  return String(asRecord(decision.route_decision).task_class ?? "").trim() === "session_control";
}

export function isRunnerDecision(decision: Record<string, unknown>): boolean {
  return normalizeLiveRoute(asRecord(decision.route_decision).route, "reply") === "delegate"
    && isObserveMode(
      String(asRecord(decision.route_decision).judge_role ?? asRecord(decision).role ?? "").trim(),
      String(asRecord(decision).executionProfile ?? "").trim(),
    );
}

export function workflowEnforcementRule(
  decision: Record<string, unknown>,
  toolName: string,
  routeHintTool: string,
): { block: boolean; delegateTool?: string; allowedTools: string[]; route?: string } {
  const route = String(asRecord(decision.route_decision).route ?? "").trim();
  const routeDecision = asRecord(decision.route_decision);
  const toolPolicy = asRecord(decision.tool_policy);
  const workContract = asRecord(decision.work_contract);
  const delegateTool = String(toolPolicy.must_delegate_via ?? "").trim();
  const allowedTools = runnerWorkflowTools(decision, routeHintTool);
  const forbiddenTools = new Set(asStringArray(workContract.forbiddenTools ?? workContract.forbidden_tools));
  const isDeterministicFallbackToDelegate = route === "delegate"
    && (String(routeDecision.route_source ?? "").trim() === "fallback" || String(routeDecision.fallback_reason ?? "").includes("explicit_delegate"));
  if (forbiddenTools.has(toolName) && !isDeterministicFallbackToDelegate) {
    return { block: true, route, delegateTool, allowedTools: [...allowedTools] };
  }
  const workflowRequired = DELEGATED_ROUTE_NAMES.has(route);
  if (!workflowRequired) {
    return { block: false, route, delegateTool, allowedTools: [...allowedTools] };
  }
  if ((delegateTool && toolName === delegateTool) || allowedTools.has(toolName)) {
    return { block: false, route, delegateTool, allowedTools: [...allowedTools] };
  }
  return { block: true, route, delegateTool, allowedTools: [...allowedTools] };
}

export function isDelegatedRoute(decision: Record<string, unknown>): boolean {
  return isDelegatedRouteName(authoritativeDecisionRoute(decision, "reply"));
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
  const canonicalDecision = canonicalizeDecisionForPolicyState(decision);
  const routeDecision = asRecord(canonicalDecision.route_decision);
  const routerDecision = asRecord(canonicalDecision.router_decision_v2);
  const policyRouter = asRecord(canonicalDecision.policy_router);
  const judge = asRecord(policyRouter.judge);
  const toolPolicy = asRecord(canonicalDecision.tool_policy);
  const workContract = asRecord(canonicalDecision.work_contract);
  const executionPacket = asRecord(canonicalDecision._execution_coverage_packet);
  const executionLayer = asRecord(canonicalDecision.execution_layer ?? canonicalDecision._execution_coverage);
  const blocked = asStringArray(toolPolicy.blocked_patterns).slice(0, 8);
  const allowedControls = asStringArray(toolPolicy.allowed_control_tools).slice(0, 8);
  const evidenceSummary = String(executionPacket.evidenceSummary ?? executionLayer.evidence_summary ?? "").trim();
  const parts = [
    `route=${String(routeDecision.route ?? "reply")}`,
    `worker_pool=${String(routeDecision.worker_pool ?? "octoclaw-main")}`,
    `task_class=${String(routeDecision.task_class ?? "")}`,
    `request_kind=${String(routerDecision.request_kind ?? "")}`,
    `protected_lane=${String(routeDecision.protected_lane ?? "")}`,
    `must_delegate_via=${String(toolPolicy.must_delegate_via ?? "")}`,
    `policy_judge=${String(judge.selected ?? "")}`,
    `WorkContract=${String(workContract.workContractId ?? canonicalDecision.workContractId ?? "")}`,
    `work_contract_route=${String(workContract.route ?? "")}`,
    `decision_source=${String(workContract.decisionSource ?? routeDecision.route_source ?? "")}`,
    `ExecutionCoverage=${String(executionPacket.packetId ?? "")}`,
    `coverage=${String(asRecord(asRecord(executionPacket.coverage).execution).coverage ?? executionLayer.coverage ?? "")}`,
    `reply_mode=${String(executionPacket.replyMode ?? workContract.replyMode ?? "")}`,
    `dispatch_executed=${String(executionPacket.dispatchExecuted ?? executionLayer.dispatch_executed ?? "")}`,
    `spawn_executed=${String(executionPacket.spawnExecuted ?? executionLayer.spawn_executed ?? "")}`,
    `evidence=${evidenceSummary}`,
  ].filter((item) => !item.endsWith("=") && !item.endsWith("=undefined"));
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
