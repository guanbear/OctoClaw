import type { TaskStatusProjection } from "@octoclaw/contracts/status-projection";
import {
  detectExecutionTransition,
  emitExecutionTransitionNotification,
} from "./ack/execution-transition-notifier.js";

type UnknownRecord = Record<string, unknown>;

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
