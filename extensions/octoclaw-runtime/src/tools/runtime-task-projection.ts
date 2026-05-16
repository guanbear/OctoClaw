import { firstDisplayModel } from "../model-display.js";
import {
  reduceCanonicalStatus,
  type LifecycleReconcileInput,
  type NativeLifecycleStatus,
} from "../runtime-ledger/lifecycle-reconciler.js";
import { captureTmuxEvidence, isTmuxEvidenceEnabled, type TmuxEvidenceSnapshot, type TmuxPaneMapping } from "../runtime-ledger/tmux-evidence.js";
import { truncateText } from "../resolve/env.js";
import { normalizeLiveRoute } from "../resolve/route-helpers.js";
import type { NativeStatusProjection, NativeStatusProjectorInput } from "../state/native-status-projector.js";
import { asBoolean, asRecord, asString, type UnknownRecord } from "../util/type-coercion.js";
import {
  formatAbsoluteShort,
  formatElapsed,
  formatTimeAgo,
  firstTimestamp,
  hasExplicitFalse,
  hasExplicitTrue,
  optionalString,
  timestampMs,
  type RuntimeTaskStateRecord,
} from "./registration-helpers.js";

export type RuntimeTaskProjectionRecord = RuntimeTaskStateRecord;

export interface RuntimeStatusTaskView {
  taskId: string;
  status: string;
  rawStatus: string;
  route: string;
  title: string;
  summary: string;
  complexityBand: string;
  updatedAt: string;
  delegatedAt: string;
  startedAt: string;
  completedAt: string;
  elapsedMs: number | null;
  elapsedText: string;
  startedAtDisplay: string;
  completedAtDisplay: string;
  model: string;
  backend: string;
  workerPool: string;
  childSessionKey: string;
  runId: string;
  statusReason: string;
  resultLocation: string;
}

const STATUS_STALE_AFTER_MS = 5 * 60 * 1000;
const STATUS_HARD_TIMEOUT_AFTER_MS = 90 * 60 * 1000;

function workContractRecord(record: RuntimeTaskProjectionRecord): UnknownRecord {
  const contract = asRecord(record.workContract);
  return Object.keys(contract).length > 0 ? contract : asRecord(record.work_contract);
}

export function deliveryEvidence(record: RuntimeTaskProjectionRecord): UnknownRecord {
  const delivery = asRecord(record.delivery);
  const workContract = workContractRecord(record);
  const telemetry = asRecord(workContract.telemetry);
  const artifacts = asRecord(record.artifacts);
  const runtimeTruth = asRecord(artifacts.runtime_truth);
  const runtimeDelivery = asRecord(runtimeTruth.delivery || runtimeTruth.resultDelivery);
  return {
    ...runtimeDelivery,
    ...delivery,
    resultHash: optionalString(
      record.nativeAnnounceResultHash,
      record.native_announce_result_hash,
      delivery.resultHash,
      delivery.result_hash,
      runtimeDelivery.resultHash,
      runtimeDelivery.result_hash,
      telemetry.nativeAnnounceResultHash,
      telemetry.native_announce_result_hash,
    ),
    messageId: optionalString(
      delivery.messageId,
      delivery.message_id,
      runtimeDelivery.messageId,
      runtimeDelivery.message_id,
      telemetry.deliveryMessageId,
      telemetry.delivery_message_id,
    ),
    replyToMessageId: optionalString(
      delivery.replyToMessageId,
      delivery.reply_to_message_id,
      runtimeDelivery.replyToMessageId,
      runtimeDelivery.reply_to_message_id,
      telemetry.deliveryReplyToMessageId,
      telemetry.delivery_reply_to_message_id,
    ),
    sessionKey: optionalString(
      delivery.sessionKey,
      delivery.session_key,
      runtimeDelivery.sessionKey,
      runtimeDelivery.session_key,
      telemetry.deliverySessionKey,
      telemetry.delivery_session_key,
    ),
    transport: optionalString(
      delivery.transport,
      delivery.deliveryTransport,
      delivery.delivery_transport,
      runtimeDelivery.transport,
      runtimeDelivery.deliveryTransport,
      runtimeDelivery.delivery_transport,
      telemetry.deliveryTransport,
      telemetry.delivery_transport,
    ),
    targetSource: optionalString(
      delivery.targetSource,
      delivery.target_source,
      runtimeDelivery.targetSource,
      runtimeDelivery.target_source,
      telemetry.deliveryTargetSource,
      telemetry.delivery_target_source,
    ),
    deliveredAt: optionalString(
      delivery.deliveredAt,
      delivery.delivered_at,
      runtimeDelivery.deliveredAt,
      runtimeDelivery.delivered_at,
      telemetry.nativeAnnounceDeliveredAt,
      telemetry.native_announce_delivered_at,
    ),
  };
}

export function runtimeStatusEvidence(record: RuntimeTaskProjectionRecord): {
  hasDispatchEvidence: boolean;
  hasSpawnEvidence: boolean;
  resultMaterialized: boolean;
  dispatchRejected: boolean;
  mainFallbackExecuted: boolean;
  childSessionKey: string;
  runId: string;
} {
  const artifacts = asRecord(record.artifacts);
  const runtimeTruth = asRecord(artifacts.runtime_truth);
  const evidence = asRecord(runtimeTruth.evidence);
  const metadata = asRecord(record.metadata);
  const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
  const nativeBinding = asRecord(delegateAttempt.nativeBinding);
  const nativeTaskBinding = asRecord(runtimeTruth.nativeTaskBinding);
  const delivery = asRecord(runtimeTruth.delivery || runtimeTruth.resultDelivery);
  const workContract = workContractRecord(record);
  const telemetry = asRecord(workContract.telemetry);
  const continuity = asRecord(runtimeTruth.childSessionContinuity || runtimeTruth.continuity);
  const childSessionKey = optionalString(
    record.childSessionKey,
    record.child_session_key,
    delegateAttempt.childSessionKey,
    continuity.childSessionKey,
    evidence.childSessionKey,
  ) ?? "";
  const runId = optionalString(
    record.runId,
    record.run_id,
    record.childRunId,
    record.child_run_id,
    delegateAttempt.runId,
    delegateAttempt.run_id,
    delegateAttempt.childRunId,
    delegateAttempt.child_run_id,
    continuity.runId,
    continuity.run_id,
    evidence.childRunId,
    evidence.child_run_id,
    evidence.runId,
    evidence.run_id,
  ) ?? "";
  const childSessionId = optionalString(
    record.childSessionId,
    record.child_session_id,
    delegateAttempt.childSessionId,
    delegateAttempt.child_session_id,
    continuity.childSessionId,
    continuity.child_session_id,
    evidence.childSessionId,
    evidence.child_session_id,
  ) ?? "";
  const hasDispatchEvidence = asBoolean(record.dispatchExecuted)
    || asBoolean(record.dispatch_executed)
    || asBoolean(evidence.dispatchExecuted)
    || asBoolean(evidence.dispatch_executed)
    || asBoolean(delegateAttempt.dispatchExecuted)
    || asBoolean(delegateAttempt.dispatch_executed)
    || Boolean(asString(nativeBinding.nativeFlowId || nativeTaskBinding.nativeFlowId))
    || Boolean(asString(record.flow_id));
  const spawnSignals = [
    record.spawnExecuted,
    record.spawn_executed,
    evidence.spawnExecuted,
    evidence.spawn_executed,
    delegateAttempt.spawnExecuted,
    delegateAttempt.spawn_executed,
  ];
  const hasSpawnEvidence = hasExplicitTrue(spawnSignals)
    || Boolean(runId || childSessionId)
    || (!hasExplicitFalse(spawnSignals) && Boolean(childSessionKey));
  const resultMaterialized = asBoolean(record.resultMaterialized)
    || asBoolean(record.result_materialized)
    || asBoolean(evidence.resultMaterialized)
    || asBoolean(evidence.result_materialized)
    || asBoolean(runtimeTruth.resultMaterialized)
    || asBoolean(runtimeTruth.result_materialized)
    || asBoolean(delivery.resultMaterialized)
    || asBoolean(delivery.result_materialized)
    || Boolean(asString(record.report_path || delivery.artifact_path || delivery.result_path));
  const dispatchRejected = asBoolean(record.dispatchRejected)
    || asBoolean(record.dispatch_rejected)
    || asBoolean(metadata.dispatchRejected)
    || asBoolean(metadata.dispatch_rejected)
    || asBoolean(evidence.dispatchRejected)
    || asBoolean(evidence.dispatch_rejected)
    || asBoolean(runtimeTruth.dispatchRejected)
    || asBoolean(runtimeTruth.dispatch_rejected)
    || asBoolean(telemetry.dispatchRejected)
    || asBoolean(telemetry.dispatch_rejected)
    || ["rejected", "admission_rejected", "dispatch_rejected"].includes(asString(record.status).toLowerCase());
  const mainFallbackExecuted = asBoolean(record.mainFallbackExecuted)
    || asBoolean(record.main_fallback_executed)
    || asBoolean(metadata.mainFallbackExecuted)
    || asBoolean(metadata.main_fallback_executed)
    || asBoolean(evidence.mainFallbackExecuted)
    || asBoolean(evidence.main_fallback_executed)
    || asBoolean(runtimeTruth.mainFallbackExecuted)
    || asBoolean(runtimeTruth.main_fallback_executed)
    || asBoolean(telemetry.mainFallbackExecuted)
    || asBoolean(telemetry.main_fallback_executed);
  return { hasDispatchEvidence, hasSpawnEvidence, resultMaterialized, dispatchRejected, mainFallbackExecuted, childSessionKey, runId };
}

function hasDelegatedExecutionIdentity(record: RuntimeTaskProjectionRecord): boolean {
  return Boolean(optionalString(
    record.attemptId,
    record.attempt_id,
    record.delegateTaskId,
    record.delegate_task_id,
    record.nativeTaskId,
    record.native_task_id,
    record.nativeFlowId,
    record.native_flow_id,
    record.flowId,
    record.flow_id,
    record.runId,
    record.run_id,
    record.childRunId,
    record.child_run_id,
    record.childSessionKey,
    record.child_session_key,
  ));
}

export function runtimeTaskRoute(record: RuntimeTaskProjectionRecord): string {
  const contract = workContractRecord(record);
  return normalizeLiveRoute(optionalString(record.route, contract.route), "delegate");
}

export function shouldDisplayRuntimeStatusRecord(record: RuntimeTaskProjectionRecord): boolean {
  if (runtimeTaskRoute(record) !== "delegate") return false;
  const rawStatus = asString(record.status).toLowerCase();
  const workContractStatus = asString(record.workContractStatus || record.work_contract_status).toLowerCase();
  if (rawStatus !== "sealed" && workContractStatus !== "sealed") return true;
  const evidence = runtimeStatusEvidence(record);
  return evidence.hasDispatchEvidence || hasDelegatedExecutionIdentity(record);
}

export function nativeStatusInputForTask(record: RuntimeTaskProjectionRecord, ctx: UnknownRecord): NativeStatusProjectorInput {
  const contract = workContractRecord(record);
  const delegate = asRecord(contract.delegate);
  const nativeBinding = asRecord(delegate.nativeBinding);
  const nativeRefs = asRecord(contract.nativeSpawnRefs);
  const telemetry = asRecord(contract.telemetry);
  const continuity = asRecord(contract.continuity);
  const evidence = runtimeStatusEvidence(record);
  return {
    ctx,
    sessionKey: optionalString(record.session_key, record.sessionKey, contract.sessionKey),
    workContractId: optionalString(record.workContractId, record.work_contract_id, contract.workContractId, record.id),
    openclawRunId: optionalString(nativeRefs.openclawRunId, record.openclawRunId, record.runId, record.run_id, nativeBinding.runId, telemetry.openclawRunId, evidence.runId),
    openclawTaskId: optionalString(nativeRefs.openclawTaskId, record.openclawTaskId, record.nativeTaskId, record.native_task_id, nativeBinding.nativeTaskId),
    openclawFlowId: optionalString(nativeRefs.openclawFlowId, record.openclawFlowId, record.nativeFlowId, record.native_flow_id, record.flowId, record.flow_id, nativeBinding.flowId, telemetry.nativeFlowId),
    childSessionKey: optionalString(nativeRefs.childSessionKey, record.childSessionKey, record.child_session_key, nativeBinding.childSessionKey, continuity.preferredChildSessionKey, evidence.childSessionKey),
    cache: {
      status: asString(record.status),
      rawStatus: asString(record.rawStatus || record.raw_status),
      summary: asString(record.summary),
    },
  };
}

function workContractMainContext(record: RuntimeTaskProjectionRecord): UnknownRecord {
  return asRecord(workContractRecord(record).mainContext);
}

function runtimeTaskTitle(record: RuntimeTaskProjectionRecord): string {
  const contract = workContractRecord(record);
  const mainContext = workContractMainContext(record);
  return truncateText(optionalString(
    record.title,
    record.taskSummary,
    record.task_summary,
    mainContext.summary,
    contract.userAsk,
    record.summary,
  ) ?? "未命名任务", 160);
}

function runtimeTaskComplexityBand(record: RuntimeTaskProjectionRecord): string {
  const metadata = asRecord(record.metadata);
  const contract = workContractRecord(record);
  const decision = asRecord(contract.decision);
  const routeDecision = asRecord(decision.route_decision);
  return optionalString(
    record.complexityBand,
    record.complexity_band,
    metadata.complexityBand,
    metadata.complexity_band,
    decision._judge_complexity_band,
    routeDecision._judge_complexity_band,
    routeDecision.complexity_band,
  ) ?? "unknown";
}

function runtimeTaskModel(record: RuntimeTaskProjectionRecord, runtimeTruth: UnknownRecord, delegateAttempt: UnknownRecord): string {
  return firstDisplayModel(
    record.model,
    asRecord(runtimeTruth.model_policy).selected_model,
    runtimeTruth.model,
    delegateAttempt.model,
    record.modelProfile,
    record.model_profile,
    delegateAttempt.modelProfile,
    delegateAttempt.model_profile,
  );
}

function timestampIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  const text = asString(value);
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  return timestampMs(text) === null ? null : text;
}

function firstTimestampIso(...values: unknown[]): string | null {
  for (const value of values) {
    const iso = timestampIso(value);
    if (iso) return iso;
  }
  return null;
}

function timestampPlusIso(value: unknown, deltaMs: number): string | null {
  const ms = timestampMs(value);
  return ms === null ? null : new Date(ms + deltaMs).toISOString();
}

function lifecycleStatusFromNativeProjection(
  nativeProjection: NativeStatusProjection | undefined,
  terminalStatus: string,
  rawStatus: string,
): NativeLifecycleStatus {
  if (terminalStatus === "completed") return "completed";
  if (terminalStatus === "failed") return "failed";
  if (terminalStatus === "timed_out") return "timed_out";
  if (nativeProjection?.status === "completed") return "completed";
  if (nativeProjection?.status === "failed") return "failed";
  if (nativeProjection?.status === "timed_out") return "timed_out";
  if (nativeProjection?.status === "running") return "running";
  if (nativeProjection?.reason === "native_registry_unavailable") return "unavailable";
  if (nativeProjection?.status === "lost" || nativeProjection?.status === "unknown" || nativeProjection?.status === "degraded") return "missing";
  if (["running", "in_progress", "active", "executing", "started"].includes(rawStatus)) return "running";
  if (["completed", "done", "succeeded", "success"].includes(rawStatus)) return "completed";
  if (["failed", "error", "errored"].includes(rawStatus)) return "failed";
  if (["timed_out", "timeout", "expired"].includes(rawStatus)) return "timed_out";
  return "missing";
}

function runtimeResultEvidence(record: RuntimeTaskProjectionRecord, evidence: ReturnType<typeof runtimeStatusEvidence>): {
  hasCompletionReceipt: boolean;
  hasArtifactRef: boolean;
  hasReportPath: boolean;
  hasResultSummary: boolean;
  hasDeliveryAck: boolean;
} {
  const artifacts = asRecord(record.artifacts);
  const runtimeTruth = asRecord(artifacts.runtime_truth);
  const delivery = asRecord(runtimeTruth.delivery || runtimeTruth.resultDelivery || record.delivery);
  const completion = asRecord(record.completion);
  const completionBinding = asRecord(record.completionBinding || record.completion_binding);
  const workContract = workContractRecord(record);
  const delegate = asRecord(workContract.delegate);
  const telemetry = asRecord(workContract.telemetry);
  const compactPacket = asRecord(record.compact_parent_packet);
  const deliveryEvidenceRecord = deliveryEvidence(record);
  const artifactRefs = [
    ...(Array.isArray(record.artifact_refs) ? record.artifact_refs : []),
    ...(Array.isArray(compactPacket.artifactRefIds) ? compactPacket.artifactRefIds : []),
    ...(Array.isArray(delegate.artifactRefs) ? delegate.artifactRefs : []),
    ...(Array.isArray(completion.artifacts) ? completion.artifacts : []),
  ].map(String).filter(Boolean);
  const completionVerdict = asString(record.completionVerdict || record.completion_verdict || completionBinding.verdict).toLowerCase();
  const deliveryStatus = asString(
    record.delivery_status
      || delivery.status
      || delivery.deliveryStatus
      || runtimeTruth.deliveryStatus
      || telemetry.deliveryStatus
      || telemetry.delivery_status,
  ).toLowerCase();
  return {
    hasCompletionReceipt: Boolean(Object.keys(completion).length > 0 || ["matched", "success", "valid"].includes(completionVerdict)),
    hasArtifactRef: evidence.resultMaterialized || artifactRefs.length > 0,
    hasReportPath: Boolean(optionalString(
      record.report_path,
      artifacts.report_path,
      artifacts.result_path,
      artifacts.output_path,
      delivery.artifact_path,
      delivery.result_path,
      compactPacket.resultLocation,
    )),
    hasResultSummary: Boolean(optionalString(
      record.resultSummary,
      record.result_summary,
      completion.summary,
      completion.resultSummary,
      completion.result_summary,
      runtimeTruth.resultSummary,
      runtimeTruth.result_summary,
      delivery.summary,
      compactPacket.summary,
    )),
    hasDeliveryAck: ["delivered", "acknowledged", "acked", "sent"].includes(deliveryStatus)
      || Boolean(optionalString(deliveryEvidenceRecord.messageId, deliveryEvidenceRecord.resultHash)),
  };
}

function runtimeLifecycleDeadlines(record: RuntimeTaskProjectionRecord, nativeStatus: NativeLifecycleStatus): {
  expectedAt: string | null;
  hardTimeoutAt: string | null;
  lastHeartbeatAt: string | null;
  lastProgressAt: string | null;
} {
  const artifacts = asRecord(record.artifacts);
  const runtimeTruth = asRecord(artifacts.runtime_truth);
  const metadata = asRecord(record.metadata);
  const workContract = workContractRecord(record);
  const telemetry = asRecord(workContract.telemetry);
  const activeUpdatedAt = firstTimestamp(record.updated_at, record.started_at, record.spawned_at, record.created_at);
  const fallbackDeadline = timestampPlusIso(activeUpdatedAt, STATUS_STALE_AFTER_MS);
  const fallbackHardDeadline = timestampPlusIso(activeUpdatedAt, STATUS_HARD_TIMEOUT_AFTER_MS);
  const expectedAt = firstTimestampIso(
    record.expectedAt,
    record.expected_at,
    metadata.expectedAt,
    metadata.expected_at,
    runtimeTruth.expectedAt,
    runtimeTruth.expected_at,
    telemetry.expectedAt,
    telemetry.expected_at,
  ) ?? fallbackDeadline;
  const explicitHardTimeoutAt = firstTimestampIso(
    record.hardTimeoutAt,
    record.hard_timeout_at,
    record.timeoutAt,
    record.timeout_at,
    metadata.hardTimeoutAt,
    metadata.hard_timeout_at,
    metadata.timeoutAt,
    metadata.timeout_at,
    runtimeTruth.hardTimeoutAt,
    runtimeTruth.hard_timeout_at,
    runtimeTruth.timeoutAt,
    runtimeTruth.timeout_at,
    telemetry.hardTimeoutAt,
    telemetry.hard_timeout_at,
  );
  return {
    expectedAt,
    hardTimeoutAt: explicitHardTimeoutAt ?? (nativeStatus === "running" ? null : fallbackHardDeadline),
    lastHeartbeatAt: firstTimestampIso(
      record.lastHeartbeatAt,
      record.last_heartbeat_at,
      record.heartbeatAt,
      record.heartbeat_at,
      runtimeTruth.lastHeartbeatAt,
      runtimeTruth.last_heartbeat_at,
      telemetry.lastHeartbeatAt,
      telemetry.last_heartbeat_at,
    ),
    lastProgressAt: firstTimestampIso(
      record.lastProgressAt,
      record.last_progress_at,
      runtimeTruth.lastProgressAt,
      runtimeTruth.last_progress_at,
      telemetry.lastProgressAt,
      telemetry.last_progress_at,
    ),
  };
}

function tmuxPaneMappingFromRecord(record: RuntimeTaskProjectionRecord): TmuxPaneMapping | null {
  const artifacts = asRecord(record.artifacts);
  const runtimeTruth = asRecord(artifacts.runtime_truth);
  const runtimeEvidence = asRecord(runtimeTruth.evidence);
  const metadata = asRecord(record.metadata);
  const contract = workContractRecord(record);
  const telemetry = asRecord(contract.telemetry);
  const nestedCandidates = [
    asRecord(record.tmux),
    asRecord(record.tmux_evidence),
    asRecord(record.tmuxEvidence),
    asRecord(metadata.tmux),
    asRecord(metadata.tmux_evidence),
    asRecord(runtimeTruth.tmux),
    asRecord(runtimeTruth.tmux_evidence),
    asRecord(runtimeEvidence.tmux),
    asRecord(telemetry.tmux),
    asRecord(telemetry.tmux_evidence),
  ];

  const directSession = optionalString(record.tmuxSession, record.tmux_session, record.tmuxTarget, record.tmux_target);
  const directWindow = optionalString(record.tmuxWindow, record.tmux_window);
  const directPane = optionalString(record.tmuxPane, record.tmux_pane, record.tmuxPaneId, record.tmux_pane_id);
  if (directSession || directPane) {
    return { session: directSession, window: directWindow, pane: directPane };
  }

  for (const candidate of nestedCandidates) {
    const session = optionalString(candidate.session, candidate.sessionName, candidate.session_name, candidate.tmuxSession, candidate.tmux_session, candidate.target);
    const window = optionalString(candidate.window, candidate.windowName, candidate.window_name, candidate.tmuxWindow, candidate.tmux_window);
    const pane = optionalString(candidate.pane, candidate.paneId, candidate.pane_id, candidate.tmuxPane, candidate.tmux_pane, candidate.tmuxPaneId, candidate.tmux_pane_id);
    if (session || pane) {
      return { session, window, pane };
    }
  }

  return null;
}

function reducerTmuxEvidence(snapshot: TmuxEvidenceSnapshot | null): LifecycleReconcileInput["tmuxEvidence"] {
  if (!snapshot) return null;
  return {
    enabled: snapshot.enabled,
    available: snapshot.available,
    alive: snapshot.alive,
    outputChangedSinceLastCheck: snapshot.outputChangedSinceLastCheck === true,
    lastOutputAt: snapshot.lastOutputAt ?? null,
  };
}

function runtimeTmuxEvidence(record: RuntimeTaskProjectionRecord): LifecycleReconcileInput["tmuxEvidence"] {
  if (!isTmuxEvidenceEnabled()) return null;
  const mapping = tmuxPaneMappingFromRecord(record);
  return mapping ? reducerTmuxEvidence(captureTmuxEvidence(mapping)) : null;
}

export function projectRuntimeStatus(
  record: RuntimeTaskProjectionRecord,
  nowMs = Date.now(),
  nativeProjection?: NativeStatusProjection,
): { status: string; reason: string } {
  const rawStatus = asString(record.status, "unknown");
  const normalizedRawStatus = rawStatus.toLowerCase();
  const route = runtimeTaskRoute(record);
  const evidence = runtimeStatusEvidence(record);
  const terminalStatus = ["failed", "completed", "done", "succeeded", "cancelled", "canceled", "blocked", "timed_out"].includes(normalizedRawStatus)
    ? normalizedRawStatus === "done" || normalizedRawStatus === "succeeded" ? "completed" : normalizedRawStatus === "cancelled" ? "canceled" : normalizedRawStatus
    : "";
  const resultEvidence = runtimeResultEvidence(record, evidence);
  const completionStatus = asString(asRecord(record.completion).status).toLowerCase();

  const reconcileResult = asRecord(record.lifecycle_reconcile_result);
  const rawStatusIsTerminal = Boolean(terminalStatus || normalizedRawStatus === "deliverable_ready");
  if (!rawStatusIsTerminal && typeof reconcileResult.status === "string") {
    const canonicalStatuses = new Set(["queued", "running", "running_slow", "stalled", "timed_out", "failed", "degraded", "completed"]);
    if (canonicalStatuses.has(reconcileResult.status)) {
      return { status: reconcileResult.status, reason: asString(reconcileResult.reason, "lifecycle_reducer") };
    }
  }
  if (["failure", "failed", "error"].includes(completionStatus)) return { status: "failed", reason: "failure_receipt" };
  if (["timed_out", "timeout", "expired"].includes(completionStatus)) return { status: "timed_out", reason: "timeout_receipt" };

  if (route === "delegate") {
    if (evidence.dispatchRejected && evidence.mainFallbackExecuted) {
      return { status: "main_fallback", reason: "dispatch_rejected_main_fallback" };
    }
    if (!evidence.hasDispatchEvidence) return { status: "registered", reason: "no_dispatch_evidence" };
    if (!evidence.hasSpawnEvidence && !["failed", "canceled", "blocked", "timed_out"].includes(terminalStatus)) {
      return { status: "queued", reason: "dispatch_materialized_but_no_spawn_evidence" };
    }
    if (normalizedRawStatus === "deliverable_ready") {
      return Object.values(resultEvidence).some(Boolean)
        ? { status: "deliverable_ready", reason: "final_result_exists_delivery_pending" }
        : { status: "degraded", reason: "completed_without_result" };
    }
  }

  if (nativeProjection?.status === "degraded" && nativeProjection.reason === "native_registry_unavailable" && !terminalStatus) {
    return { status: "degraded", reason: nativeProjection.reason };
  }
  if (nativeProjection?.status === "canceled" && !terminalStatus) {
    return { status: "canceled", reason: nativeProjection.reason };
  }

  if (terminalStatus && !["completed", "failed", "timed_out"].includes(terminalStatus)) {
    return { status: terminalStatus, reason: "terminal_or_explicit_status" };
  }

  const nativeStatus = lifecycleStatusFromNativeProjection(nativeProjection, terminalStatus, normalizedRawStatus);
  const deadlines = runtimeLifecycleDeadlines(record, nativeStatus);
  const reconciled = reduceCanonicalStatus({
    currentStatus: terminalStatus || rawStatus,
    nativeStatus,
    ...resultEvidence,
    expectedAt: deadlines.expectedAt,
    hardTimeoutAt: deadlines.hardTimeoutAt,
    lastHeartbeatAt: deadlines.lastHeartbeatAt,
    lastProgressAt: deadlines.lastProgressAt,
    tmuxEvidence: runtimeTmuxEvidence(record),
    now: new Date(nowMs).toISOString(),
  });

  if (nativeProjection?.status === "lost" && !terminalStatus && reconciled.status !== "timed_out") {
    return { status: "lost", reason: nativeProjection.reason };
  }
  if (reconciled.reason === "no_dispatch_evidence" && rawStatus) return { status: rawStatus, reason: "raw_status_projection" };
  return { status: reconciled.status, reason: reconciled.reason };
}

export function buildRuntimeTaskProjection(
  record: RuntimeTaskProjectionRecord,
  options: { nowMs?: number; nativeProjection?: NativeStatusProjection } = {},
): RuntimeStatusTaskView {
  const nowMs = options.nowMs ?? Date.now();
  const nativeProjection = options.nativeProjection;
  const artifacts = asRecord(record.artifacts);
  const runtimeTruth = asRecord(artifacts.runtime_truth);
  const delegateAttempt = asRecord(runtimeTruth.delegateAttempt);
  const binding = asRecord(runtimeTruth.binding);
  const evidence = runtimeStatusEvidence(record);
  const materializedAt = firstTimestamp(record.materialized_at, record.created_at, record.spawned_at, record.started_at, record.updated_at);
  const startedAt = evidence.hasSpawnEvidence ? firstTimestamp(record.started_at, record.spawned_at, materializedAt) : "";
  const delegatedAt = firstTimestamp(record.spawned_at, record.started_at, materializedAt, record.updated_at);
  const completedAt = firstTimestamp(record.completed_at, record.failed_at, delegateAttempt.completedAt, delegateAttempt.failedAt);
  const startMs = timestampMs(startedAt || delegatedAt);
  const endMs = timestampMs(completedAt) ?? nowMs;
  const elapsedMs = startMs === null ? null : Math.max(0, endMs - startMs);
  const fallbackProjection = projectRuntimeStatus(record, nowMs, nativeProjection);
  const fallbackTerminal = ["completed", "failed", "canceled"].includes(fallbackProjection.status);
  const nativeProjectionAuthoritative = Boolean(nativeProjection && (
    ["run", "flow", "latest"].includes(nativeProjection.source)
    || (!fallbackTerminal && (
      nativeProjection.reason === "native_id_known_but_registry_missing"
      || nativeProjection.reason === "native_registry_lookup_failed"
      || nativeProjection.reason === "native_registry_unavailable"
      || nativeProjection.reason === "task_state_cache_degraded"
    ))
  ));
  const projected = fallbackProjection;
  const workerPool = optionalString(record.worker_pool, binding.workerPool, delegateAttempt.workerPool) ?? "unknown";
  const artifactRefs = Array.isArray(record.artifact_refs) ? record.artifact_refs.map(String).filter(Boolean) : [];
  const compactPacket = asRecord(record.compact_parent_packet);
  const compactArtifactRefs = Array.isArray(compactPacket.artifactRefIds) ? compactPacket.artifactRefIds.map(String).filter(Boolean) : [];
  const delivery = deliveryEvidence(record);
  const deliveryRef = optionalString(
    delivery.messageId ? `delivered:${delivery.messageId}` : undefined,
    delivery.resultHash ? `result_hash:${delivery.resultHash}` : undefined,
  );
  const resultLocation = optionalString(
    record.report_path,
    artifacts.report_path,
    artifacts.result_path,
    artifacts.output_path,
    deliveryRef,
    artifactRefs.length > 0 ? `artifact_refs=${artifactRefs.join(",")}` : undefined,
    compactArtifactRefs.length > 0 ? `artifact_refs=${compactArtifactRefs.join(",")}` : undefined,
  ) ?? "none";
  const formatTimestampDisplay = (valueMs: number | null): string => {
    if (valueMs === null) return "";
    const relative = formatTimeAgo(valueMs, nowMs);
    const absolute = formatAbsoluteShort(valueMs);
    return [relative, absolute].filter(Boolean).join(" · ");
  };
  const startedAtDisplay = formatTimestampDisplay(startMs ?? timestampMs(delegatedAt));
  const completedTimestampMs = timestampMs(completedAt);
  const completedAtDisplay = formatTimestampDisplay(completedTimestampMs);
  const actionableReason = (() => {
    if (projected.reason === "native_id_known_but_registry_missing") return "native_accepted_result_not_reconciled";
    if (projected.reason === "native_registry_lookup_failed") return "native_accepted_result_not_reconciled";
    if (projected.reason === "native_registry_unavailable") return "native_registry_unavailable_diagnostic";
    if (projected.reason === "task_state_cache_degraded") return "cache_degraded_rebuild_recommended";
    return projected.reason;
  })();
  return {
    taskId: asString(record.id),
    status: projected.status,
    rawStatus: nativeProjectionAuthoritative ? (nativeProjection?.rawStatus || asString(record.status, "unknown")) : asString(record.status, "unknown"),
    route: runtimeTaskRoute(record),
    title: runtimeTaskTitle(record),
    summary: (() => {
      const completion = record.completion as Record<string, unknown> | undefined;
      if (completion && typeof completion === "object") {
        const completionSummary = asString(completion.summary);
        if (completionSummary) {
          const statusEmoji = asString(completion.status) === "success" ? "✅"
            : asString(completion.status) === "partial" ? "⚠️" : "❌";
          return `${statusEmoji} ${completionSummary.slice(0, 200)}`;
        }
      }
      return (nativeProjectionAuthoritative ? nativeProjection?.summary : "") || asString(record.summary) || runtimeTaskTitle(record);
    })(),
    complexityBand: runtimeTaskComplexityBand(record),
    updatedAt: asString(record.updated_at),
    delegatedAt,
    startedAt,
    completedAt,
    elapsedMs,
    elapsedText: formatElapsed(elapsedMs),
    startedAtDisplay,
    completedAtDisplay,
    model: runtimeTaskModel(record, runtimeTruth, delegateAttempt),
    backend: optionalString(record.backend, workerPool, binding.controllerId, runtimeTruth.backend) ?? "unknown",
    workerPool,
    childSessionKey: optionalString(nativeProjectionAuthoritative ? nativeProjection?.childSessionKey : "", evidence.childSessionKey) ?? "",
    runId: optionalString(nativeProjectionAuthoritative ? nativeProjection?.runId : "", evidence.runId) ?? "",
    statusReason: actionableReason,
    resultLocation,
  };
}
