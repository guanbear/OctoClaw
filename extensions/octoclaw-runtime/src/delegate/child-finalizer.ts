import fsSync from "node:fs";
import path from "node:path";
import type { WorkerCompletionResult } from "@octoclaw/contracts/completion";
import type {
  TaskProjectionStatus,
  TaskStatusProjection,
} from "@octoclaw/contracts/status-projection";
import type { NativeBindingRef, WorkContract } from "@octoclaw/contracts/work-contract";
import {
  emitExecutionTransitionNotification,
  type ExecutionTransitionKind,
} from "../ack/execution-transition-notifier.js";
import { appendToDeliveryOutbox } from "../delivery/delivery-outbox.js";
import { sendIMMessage } from "../im/send.js";
import {
  resolveWorkerCompletionPath,
  resolveWorkspaceRoot,
  resolveReplayLogPath,
  resolveMainAgentSessionsPath,
} from "../resolve/env.js";
import { resolveAckDeliverySessionKey } from "../resolve/session.js";
import { observeCompletionBinding } from "../runtime-ledger/completion-binding.js";
import { resolveRuntimeLedgerFlag } from "../runtime-ledger/feature-flags.js";
import {
  readTaskStateRecords,
  upsertTaskStateRecord,
  type TaskStateRecord,
} from "../state/task-state-store.js";
import { appendJsonl } from "../replay/replay.js";
import { materializeWorkContractSuccess } from "../work-contract/materializer.js";
import { loadWorkContract } from "../work-contract/store.js";

/** Shorten a raw model ID or profile name for display: "zhipu/GLM-5.1" → "GLM-5.1" */
function shortModelName(raw: string | undefined): string {
  if (!raw) return "unknown";
  const parts = raw.split("/");
  return parts[parts.length - 1] || raw;
}

export interface ChildCompletionFinalizerOptions {
  childSessionKey: string;
  delegateTaskId: string;
  workContractId: string;
  parentSessionKey: string;
  deliverySessionKey?: string;
  replyToMessageId?: string;
  deliveryTarget?: Record<string, unknown>;
  nativeTaskId?: string;
  nativeFlowId?: string;
  runId?: string;
  childRunId?: string;
  modelId?: string;
  taskStatePath?: string;
  cwd?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  initialDelayMs?: number;
  onSuccess?: () => void | Promise<void>;
  sendFinalMessage?: (params: {
    sessionKey: string;
    message: string;
    replyToMessageId?: string;
    cwd?: string;
  }) => Promise<{ sent: boolean; delivered: boolean; error?: string }>;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}

export interface ChildCompletionFinalizerResult {
  status: "completed" | "pending" | "missing_identity" | "delivery_failed" | "completion_orphaned" | "binding_mismatch";
  resultText?: string;
  sent?: boolean;
  error?: string;
}

const activeFinalizers = new Map<string, ReturnType<typeof setTimeout>>();
const DEFAULT_CHILD_COMPLETION_TIMEOUT_MS = 600_000;
const CHILD_SESSION_ACTIVITY_GRACE_MS = 90_000;
const CHILD_SESSION_DEADLINE_EXTENSION_MS = 120_000;
const FINAL_DELIVERY_LOCK_STALE_MS = 120_000;

function completionDeliveryLockPath(workContractId: string): string {
  return path.join(path.dirname(resolveWorkerCompletionPath(workContractId)), `${workContractId}.delivery.lock`);
}

function acquireCompletionDeliveryLock(workContractId: string, nowMs = Date.now()): (() => void) | null {
  const lockPath = completionDeliveryLockPath(workContractId);
  fsSync.mkdirSync(path.dirname(lockPath), { recursive: true });
  const tryAcquire = (): (() => void) | null => {
    try {
      const fd = fsSync.openSync(lockPath, "wx");
      fsSync.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date(nowMs).toISOString() }));
      fsSync.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fsSync.unlinkSync(lockPath); } catch {}
      };
    } catch {
      return null;
    }
  };
  const release = tryAcquire();
  if (release) return release;
  try {
    const stat = fsSync.statSync(lockPath);
    if (nowMs - stat.mtimeMs > FINAL_DELIVERY_LOCK_STALE_MS) {
      fsSync.unlinkSync(lockPath);
      return tryAcquire();
    }
  } catch {}
  return null;
}


function readCompletionFile(workContractId: string): WorkerCompletionResult | null {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(resolveWorkerCompletionPath(workContractId), "utf-8")) as WorkerCompletionResult;
    return parsed.schemaVersion === "octoclaw.worker_completion/v1" && parsed.workContractId && parsed.status && parsed.summary ? parsed : null;
  } catch {
    return null;
  }
}

function extractSessionMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readNativeChildSessionCompletion(options: ChildCompletionFinalizerOptions): WorkerCompletionResult | null {
  if (!options.childSessionKey) return null;
  let latestText = "";
  let sawTerminalAssistant = false;
  for (const filePath of childSessionFileCandidates(options)) {
    let lines: string[];
    try {
      lines = fsSync.readFileSync(filePath, "utf-8").split(/\n/u).filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(record) || record.type !== "message") continue;
      const message = isRecord(record.message) ? record.message : {};
      if (stringValue(message.role).toLowerCase() !== "assistant") continue;
      const text = extractSessionMessageText(message.content);
      if (!text || text.trim().toUpperCase() === "NO_REPLY") continue;
      latestText = text;
      const stopReason = stringValue(message.stopReason || message.stop_reason || record.stopReason || record.stop_reason).toLowerCase();
      if (!stopReason || ["stop", "end_turn", "completed"].includes(stopReason)) {
        sawTerminalAssistant = true;
      }
    }
    if (latestText && sawTerminalAssistant) break;
  }
  if (!latestText || !sawTerminalAssistant) return null;
  return {
    schemaVersion: "octoclaw.worker_completion/v1",
    workContractId: options.workContractId,
    childSessionKey: options.childSessionKey,
    delegateTaskId: options.delegateTaskId,
    status: "success",
    summary: latestText,
    artifacts: [],
    completedAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function addPathCandidate(candidates: Set<string>, candidate: unknown, baseDir?: string): void {
  const text = stringValue(candidate);
  if (!text) return;
  candidates.add(path.isAbsolute(text) ? text : path.join(baseDir || path.dirname(resolveMainAgentSessionsPath()), text));
}

function childSessionFileCandidates(options: ChildCompletionFinalizerOptions): string[] {
  const sessionsPath = resolveMainAgentSessionsPath();
  const sessionsDir = path.dirname(sessionsPath);
  const refs = new Set([options.childSessionKey, options.childRunId, options.runId].map(stringValue).filter(Boolean));
  const candidates = new Set<string>();
  for (const ref of refs) {
    candidates.add(path.join(sessionsDir, `${ref}.jsonl`));
  }

  try {
    const registry = JSON.parse(fsSync.readFileSync(sessionsPath, "utf-8")) as unknown;
    if (isRecord(registry)) {
      for (const [key, value] of Object.entries(registry)) {
        if (!isRecord(value)) continue;
        const values = [
          key,
          value.sessionKey,
          value.sessionId,
          value.controlKey,
          value.channelSessionKey,
          value.bindingKey,
          value.threadKey,
          value.runId,
          value.childRunId,
        ].map(stringValue);
        if (!values.some((candidate) => refs.has(candidate))) continue;
        addPathCandidate(candidates, value.sessionFile, sessionsDir);
        const sessionId = stringValue(value.sessionId);
        if (sessionId) candidates.add(path.join(sessionsDir, `${sessionId}.jsonl`));
      }
    }
  } catch {}

  return [...candidates];
}

function childSessionLastActivityMs(options: ChildCompletionFinalizerOptions): number | null {
  let latest = 0;
  for (const filePath of childSessionFileCandidates(options)) {
    try {
      const stat = fsSync.statSync(filePath) as unknown as { isFile?: () => boolean; mtimeMs?: number; mtime?: Date };
      const isFile = stat.isFile ? stat.isFile() : true;
      const mtimeMs = typeof stat.mtimeMs === "number" ? stat.mtimeMs : stat.mtime?.getTime() || 0;
      if (isFile && mtimeMs > 0) latest = Math.max(latest, mtimeMs);
    } catch {}
  }
  return latest > 0 ? latest : null;
}

function shouldExtendDeadlineForActiveChild(options: ChildCompletionFinalizerOptions, nowMs: number): boolean {
  const lastActivityMs = childSessionLastActivityMs(options);
  return lastActivityMs !== null && nowMs - lastActivityMs <= CHILD_SESSION_ACTIVITY_GRACE_MS;
}

function isCompletionAlreadyMaterialized(options: ChildCompletionFinalizerOptions): boolean {
  try {
    return readTaskStateRecords(options.taskStatePath).some((record) => {
      const workContractId = stringValue(record.workContractId || record.work_contract_id || record.id);
      if (workContractId !== options.workContractId) return false;
      const resultMaterialized = record.resultMaterialized === true || record.result_materialized === true;
      const deliveryStatus = stringValue(record.delivery_status || (isRecord(record.delivery) ? record.delivery.status : undefined));
      const recordStatus = stringValue(record.status);
      return resultMaterialized && (
        ["delivered", "queued_for_retry"].includes(deliveryStatus)
        || (!deliveryStatus && ["completed", "deliverable_ready"].includes(recordStatus))
      );
    });
  } catch {
    return false;
  }
}

function isNativePlannerCompletionMaterialized(contract: WorkContract | null | undefined): boolean {
  if (!contract) return false;
  const telemetry = contract.telemetry ?? {};
  const nativeRefs = contract.nativeSpawnRefs ?? {};
  const nativeBinding = contract.delegate?.nativeBinding;
  const nativePlannerRef = nativeRefs.spawnBackend === "sessions_spawn_planner"
    || Boolean(nativeRefs.openclawRunId || nativeBinding?.runId || nativeBinding?.childRunId);
  if (!nativePlannerRef) return false;
  const materialized = telemetry.resultMaterialized === true
    || contract.status === "completed"
    || nativeBinding?.status === "succeeded";
  if (!materialized) return false;
  const deliveryStatus = stringValue(telemetry.deliveryStatus).toLowerCase();
  return !deliveryStatus || ["pending", "delivered", "sent", "queued_for_retry"].includes(deliveryStatus);
}

function embeddedTaskStateContracts(options: ChildCompletionFinalizerOptions): WorkContract[] {
  try {
    return readTaskStateRecords(options.taskStatePath)
      .filter((record) => {
        const workContractId = stringValue(record.workContractId || record.work_contract_id || record.id);
        return workContractId === options.workContractId;
      })
      .flatMap((record) => [record.workContract, record.work_contract])
      .filter((candidate): candidate is WorkContract => (
        Boolean(candidate)
        && typeof candidate === "object"
        && !Array.isArray(candidate)
        && stringValue((candidate as WorkContract).workContractId) === options.workContractId
      ));
  } catch {
    return [];
  }
}

function taskStateRecordHasNativePlannerRefs(record: TaskStateRecord): boolean {
  const workContract: Record<string, unknown> = isRecord(record.workContract) ? record.workContract : isRecord(record.work_contract) ? record.work_contract : {};
  const nativeRefs = isRecord(workContract.nativeSpawnRefs) ? workContract.nativeSpawnRefs : {};
  const delegate = isRecord(workContract.delegate) ? workContract.delegate : {};
  const nativeBinding = isRecord(delegate.nativeBinding) ? delegate.nativeBinding : {};
  const flowId = stringValue(record.nativeFlowId || record.native_flow_id || record.flowId || record.flow_id || nativeBinding.flowId);
  return stringValue(nativeRefs.spawnBackend) === "sessions_spawn_planner"
    || flowId.startsWith("sessions_spawn:")
    || Boolean(
      stringValue(record.runId || record.run_id || nativeRefs.openclawRunId || nativeBinding.runId)
      && stringValue(record.childSessionKey || record.child_session_key || nativeRefs.childSessionKey || nativeBinding.childSessionKey),
    );
}

function isNativePlannerTaskStateCompletionMaterialized(options: ChildCompletionFinalizerOptions): boolean {
  try {
    return readTaskStateRecords(options.taskStatePath).some((record) => {
      const workContractId = stringValue(record.workContractId || record.work_contract_id || record.id);
      if (workContractId !== options.workContractId) return false;
      if (!taskStateRecordHasNativePlannerRefs(record)) return false;
      const workContract: Record<string, unknown> = isRecord(record.workContract) ? record.workContract : isRecord(record.work_contract) ? record.work_contract : {};
      const telemetry = isRecord(workContract.telemetry) ? workContract.telemetry : {};
      const deliveryStatus = stringValue(record.delivery_status || (isRecord(record.delivery) ? record.delivery.status : undefined) || telemetry.deliveryStatus).toLowerCase();
      const completed = record.resultMaterialized === true
        || record.result_materialized === true
        || telemetry.resultMaterialized === true
        || stringValue(record.workContractStatus || record.work_contract_status).toLowerCase() === "completed"
        || stringValue(workContract.status).toLowerCase() === "completed";
      return completed && ["delivered", "sent", "queued_for_retry"].includes(deliveryStatus);
    });
  } catch {
    return false;
  }
}

function isWorkContractCompletionMaterialized(options: ChildCompletionFinalizerOptions): boolean {
  if (isNativePlannerCompletionMaterialized(loadWorkContract(options.workContractId, options.taskStatePath))) {
    return true;
  }
  return embeddedTaskStateContracts(options).some(isNativePlannerCompletionMaterialized)
    || isNativePlannerTaskStateCompletionMaterialized(options);
}

function formatDeliveryMessage(completion: WorkerCompletionResult, options: ChildCompletionFinalizerOptions): string {
  if (isNativePlannerFinalizer(options)) {
    return completion.summary;
  }
  const icon = completion.status === "success" ? "✅" : completion.status === "partial" ? "⚠️" : "❌";
  const title = completion.status === "success"
    ? "子任务完成"
    : completion.status === "partial"
      ? "子任务部分完成"
      : "子任务失败";
  const lines = [`${icon} ${title}`, "", completion.summary];
  if (completion.artifacts?.length) lines.push("", `产出物：${completion.artifacts.join(", ")}`);
  if (completion.status === "failure" && completion.errorMessage) lines.push("", `错误：${completion.errorMessage}`);
  lines.push("", `[route=delegate | model=${shortModelName(options.modelId)} | workContract=${options.workContractId}]`);
  return lines.join("\n");
}

function isNativePlannerFinalizer(options: ChildCompletionFinalizerOptions): boolean {
  if (options.nativeFlowId?.startsWith("sessions_spawn:")) return true;
  if (options.runId && options.childSessionKey?.startsWith("agent:")) return true;
  const contract = loadWorkContract(options.workContractId, options.taskStatePath);
  return contract?.nativeSpawnRefs?.spawnBackend === "sessions_spawn_planner"
    || Boolean(contract?.nativeSpawnRefs?.openclawRunId && contract?.nativeSpawnRefs?.childSessionKey);
}

function taskIds(options: ChildCompletionFinalizerOptions): Record<string, string | undefined> {
  const runId = options.runId || options.childRunId;
  return {
    taskId: options.nativeTaskId || options.delegateTaskId,
    flowId: options.nativeFlowId,
    runId,
    childRunId: options.childRunId || options.runId,
  };
}

function resolveFinalDeliverySessionKey(options: ChildCompletionFinalizerOptions): string {
  const target = options.deliveryTarget && typeof options.deliveryTarget === "object" ? options.deliveryTarget : {};
  const targetSessionKey = asStr(target.sessionKey || target.session_key);
  return options.deliverySessionKey
    || targetSessionKey
    || resolveAckDeliverySessionKey(
      { session_key: options.parentSessionKey },
      options.parentSessionKey,
      null,
      { sessionKey: options.parentSessionKey, sessionId: options.parentSessionKey },
    )
    || options.parentSessionKey;
}

function resolveFinalReplyToMessageId(options: ChildCompletionFinalizerOptions): string {
  const target = options.deliveryTarget && typeof options.deliveryTarget === "object" ? options.deliveryTarget : {};
  return options.replyToMessageId
    || asStr(target.replyToMessageId || target.reply_to_message_id || target.threadTs || target.thread_ts);
}

function updateTaskStateRecord(options: ChildCompletionFinalizerOptions, patch: TaskStateRecord): void {
  const { taskId, flowId, runId, childRunId } = taskIds(options);
  if (!options.workContractId) return;
  const now = new Date().toISOString();
  const deliverySessionKey = resolveFinalDeliverySessionKey(options);
  upsertTaskStateRecord(
    {
      id: options.workContractId,
      workContractId: options.workContractId,
      work_contract_id: options.workContractId,
      taskId,
      task_id: taskId,
      nativeTaskId: options.nativeTaskId || taskId,
      native_task_id: options.nativeTaskId || taskId,
      flowId,
      flow_id: flowId,
      nativeFlowId: options.nativeFlowId || flowId,
      native_flow_id: options.nativeFlowId || flowId,
      sessionKey: options.parentSessionKey,
      session_key: options.parentSessionKey,
      deliverySessionKey,
      delivery_session_key: deliverySessionKey,
      deliveryTarget: options.deliveryTarget,
      delivery_target: options.deliveryTarget,
      replyToMessageId: resolveFinalReplyToMessageId(options) || undefined,
      reply_to_message_id: resolveFinalReplyToMessageId(options) || undefined,
      route: "delegate",
      model: options.modelId,
      modelProfile: options.modelId,
      model_profile: options.modelId,
      childSessionKey: options.childSessionKey,
      child_session_key: options.childSessionKey,
      runId,
      run_id: runId,
      childRunId,
      child_run_id: childRunId,
      updatedAt: now,
      updated_at: now,
      ...patch,
    },
    options.taskStatePath,
  );
}

function taskStateStatusForCompletion(completion: WorkerCompletionResult, deliveryStatus: string): string {
  if (completion.status === "failure") return "failed";
  return deliveryStatus === "delivered" ? "completed" : "deliverable_ready";
}

function substrateStatusForCompletion(completion: WorkerCompletionResult): "completed" | "failed" {
  return completion.status === "failure" ? "failed" : "completed";
}

function updateTaskStateCompleted(options: ChildCompletionFinalizerOptions, completion: WorkerCompletionResult, deliveryStatus: string): void {
  const now = new Date().toISOString();
  updateTaskStateRecord(options, {
    status: taskStateStatusForCompletion(completion, deliveryStatus),
    summary: completion.summary.slice(0, 600),
    report_path: `child_session:${options.childSessionKey}`,
    artifact_refs: [`child_session:${options.childSessionKey}`],
    completedAt: now,
    completed_at: now,
    updatedAt: now,
    updated_at: now,
    dispatchExecuted: true,
    dispatch_executed: true,
    spawnExecuted: true,
    spawn_executed: true,
    resultMaterialized: true,
    result_materialized: true,
    delivery_status: deliveryStatus,
    delivery: { status: deliveryStatus, deliveredAt: deliveryStatus === "delivered" ? now : undefined },
    ...(completion.status === "failure"
      ? {
          failedAt: now,
          failed_at: now,
          failureCode: completion.errorCode || "worker_completion_failure",
          failureMessage: completion.errorMessage || completion.summary,
        }
      : {
          failedAt: undefined,
          failed_at: undefined,
          failureCode: undefined,
          failureMessage: undefined,
        }),
    completion,
  });
}

function updateTaskStateBindingRejected(
  options: ChildCompletionFinalizerOptions,
  completion: WorkerCompletionResult,
  verdict: "completion_orphaned" | "binding_mismatch",
  reason: string,
): void {
  const now = new Date().toISOString();
  updateTaskStateRecord(options, {
    status: verdict,
    summary: completion.summary.slice(0, 600),
    completedAt: undefined,
    completed_at: undefined,
    updatedAt: now,
    updated_at: now,
    dispatchExecuted: true,
    dispatch_executed: true,
    spawnExecuted: true,
    spawn_executed: true,
    resultMaterialized: false,
    result_materialized: false,
    delivery_status: "blocked",
    delivery: { status: "blocked" },
    failureCode: verdict,
    failureMessage: reason,
    completion,
  });
}

function buildNativeBinding(
  options: ChildCompletionFinalizerOptions,
  nativeBinding: Partial<NativeBindingRef> | undefined,
  status: NativeBindingRef["status"] = "succeeded",
): NativeBindingRef {
  return {
    status,
    nativeTaskId: options.nativeTaskId || nativeBinding?.nativeTaskId || "",
    taskId: options.nativeTaskId || nativeBinding?.taskId || "",
    nativeFlowId: options.nativeFlowId || nativeBinding?.nativeFlowId || "",
    flowId: options.nativeFlowId || nativeBinding?.flowId || "",
    childSessionKey: options.childSessionKey || nativeBinding?.childSessionKey || "",
    runId: options.runId || nativeBinding?.runId || "",
    childRunId: options.childRunId || nativeBinding?.childRunId || "",
    ownerKey: nativeBinding?.ownerKey || options.workContractId,
    controllerId: nativeBinding?.controllerId || "octoclaw.delegate",
    syncMode: nativeBinding?.syncMode || "managed",
    revision: nativeBinding?.revision ?? 0,
    expectedRevision: nativeBinding?.expectedRevision ?? 0,
  };
}

function materializeCompletedWorkContract(
  options: ChildCompletionFinalizerOptions,
  completion: WorkerCompletionResult,
  deliveryStatus: string,
): void {
  try {
    const contract = loadWorkContract(options.workContractId, options.taskStatePath);
    if (!contract) return;
    const binding = buildNativeBinding(
      options,
      contract.delegate?.nativeBinding ?? undefined,
      completion.status === "failure" ? "failed" : "succeeded",
    );
    materializeWorkContractSuccess({
      workContractId: options.workContractId,
      ledgerPath: options.taskStatePath,
      nativeBinding: binding,
      delegateTaskId: options.delegateTaskId,
      attemptId: contract.delegate?.currentAttemptId || options.delegateTaskId,
      nativeTaskId: options.nativeTaskId || binding.nativeTaskId,
      nativeFlowId: options.nativeFlowId || binding.nativeFlowId,
      childSessionKey: options.childSessionKey,
      childSessionId: options.childSessionKey,
      runId: options.runId || options.childRunId,
      substrateState: substrateStatusForCompletion(completion),
      spawnExecuted: true,
      resultMaterialized: true,
      deliveryStatus,
    });
  } catch {}
}

function queueOutboxDelivery(options: ChildCompletionFinalizerOptions, message: string): void {
  try {
    const deliverySessionKey = resolveFinalDeliverySessionKey(options);
    appendToDeliveryOutbox({
      workContractId: options.workContractId,
      kind: "final_result",
      parentSessionKey: deliverySessionKey,
      replyToMessageId: resolveFinalReplyToMessageId(options) || undefined,
      message,
      cwd: options.cwd,
    });
  } catch {}
}

async function sendCompletionMessage(
  options: ChildCompletionFinalizerOptions,
  message: string,
): Promise<{ sent: boolean; error: string; transport?: string; targetSource?: string; footerSource?: string }> {
  const deliverySessionKey = resolveFinalDeliverySessionKey(options);
  if (options.sendFinalMessage) {
    const result = await options.sendFinalMessage({
      sessionKey: deliverySessionKey,
      message,
      replyToMessageId: resolveFinalReplyToMessageId(options) || undefined,
      cwd: options.cwd,
    });
    return { sent: result.sent || result.delivered, error: result.error || "" };
  }
  const result = await sendIMMessage({
    sessionKey: deliverySessionKey,
    message,
    replyToMessageId: resolveFinalReplyToMessageId(options) || undefined,
    timeoutMs: 8000,
    cwd: options.cwd || resolveWorkspaceRoot(),
    deliveryKind: isNativePlannerFinalizer(options) ? "native_child_final" : "legacy_fallback",
    deliveryTargetSource: resolveFinalReplyToMessageId(options) ? "inbound_anchor" : "session_fallback",
    deliveryProvenance: isNativePlannerFinalizer(options)
      ? {
          route: "delegate",
          via: "native_announce",
          workContractId: options.workContractId,
          runId: options.runId || options.childRunId,
          childSessionKey: options.childSessionKey,
        }
      : undefined,
    footerMode: isNativePlannerFinalizer(options) ? "debug" : "off",
    dedupeKey: isNativePlannerFinalizer(options)
      ? `native_announce:${options.workContractId}:${options.runId || options.childRunId || options.childSessionKey}`
      : undefined,
  });
  return {
    sent: result.sent,
    error: result.error === "no_im_adapter" ? "no_im_adapter_queued_for_retry" : result.error || "",
    transport: result.transport,
    targetSource: result.targetSource,
    footerSource: result.footerSource,
  };
}

function timeoutFailureMessage(timeoutMs: number): string {
  return `Worker did not write completion file within ${Math.round(timeoutMs / 1000)}s`;
}

function markTimedOut(
  options: ChildCompletionFinalizerOptions,
  timeoutMs: number,
): { occurredAt: string; failureMessage: string } {
  const now = new Date().toISOString();
  const failureMessage = timeoutFailureMessage(timeoutMs);
  updateTaskStateRecord(options, {
    status: "timed_out",
    updatedAt: now,
    updated_at: now,
    failedAt: now,
    failed_at: now,
    dispatchExecuted: true,
    dispatch_executed: true,
    spawnExecuted: true,
    spawn_executed: true,
    resultMaterialized: false,
    result_materialized: false,
    failureCode: "completion_file_not_written",
    failureMessage,
  });
  return { occurredAt: now, failureMessage };
}

function buildFinalizerProjection(
  options: ChildCompletionFinalizerOptions,
  input: {
    status: TaskProjectionStatus;
    statusReason: string;
    resultMaterialized: boolean;
    occurredAt: string;
    summary?: string;
    failureCode?: string;
    failureMessage?: string;
  },
): TaskStatusProjection {
  const { taskId, flowId, runId, childRunId } = taskIds(options);
  const id = taskId || options.workContractId;
  return {
    schemaVersion: "octoclaw.task_status_projection/v1" as const,
    projectionId: `finalizer:${options.workContractId}:${input.status}:${input.occurredAt}`,
    generatedAt: input.occurredAt,
    requestId: options.workContractId,
    flowId: flowId || options.workContractId,
    taskId: id,
    workContractId: options.workContractId,
    parentThreadKey: options.parentSessionKey,
    title: input.summary || input.failureMessage || "",
    summary: input.summary || input.failureMessage || "",
    taskSummary: input.summary || input.failureMessage || "",
    route: "delegate",
    role: "default",
    backend: "octoclaw.delegate",
    modelProfile: options.modelId || "",
    modelId: options.modelId,
    status: input.status,
    statusReason: input.statusReason,
    success: input.status === "completed",
    failureCode: input.failureCode,
    failureMessage: input.failureMessage,
    createdAt: input.occurredAt,
    failedAt: input.status === "failed" || input.status === "timed_out" ? input.occurredAt : undefined,
    elapsedMs: 0,
    dispatchExecuted: true,
    spawnExecuted: true,
    resultMaterialized: input.resultMaterialized,
    childSessionKey: options.childSessionKey,
    childSessionId: options.childSessionKey,
    runId,
    childRunId,
    artifactRefs: [],
    artifactRefIds: [`child_session:${options.childSessionKey}`],
    actions: [],
    latestAnomalyNotice: input.failureCode
      ? {
          kind: input.failureCode,
          severity: "error",
          taskId: id,
          message: input.failureMessage || input.statusReason,
          createdAt: input.occurredAt,
          nativeTaskId: options.nativeTaskId || id,
          nativeFlowId: options.nativeFlowId,
          workContractId: options.workContractId,
        }
      : undefined,
  };
}

async function notifyFinalizerTransition(
  options: ChildCompletionFinalizerOptions,
  transitionKind: ExecutionTransitionKind,
  input: Parameters<typeof buildFinalizerProjection>[1],
): Promise<void> {
  try {
    const deliverySessionKey = resolveFinalDeliverySessionKey(options);
    await emitExecutionTransitionNotification({
      transitionKind,
      projection: buildFinalizerProjection(options, input),
      attemptId: options.delegateTaskId || options.nativeTaskId || options.workContractId,
      workContractId: options.workContractId,
      sessionKey: deliverySessionKey,
      stateKey: options.parentSessionKey,
      replyToMessageId: resolveFinalReplyToMessageId(options) || undefined,
      cwd: options.cwd,
      occurredAt: input.occurredAt,
      logger: options.logger,
    });
  } catch (error) {
    options.logger?.warn?.(`child finalizer transition notify failed: ${String(error)}`);
  }
}

export async function finalizeChildSessionOnce(
  options: ChildCompletionFinalizerOptions,
): Promise<ChildCompletionFinalizerResult> {
  if (!options.workContractId || !options.parentSessionKey) {
    return { status: "missing_identity", error: "missing workContractId or parentSessionKey" };
  }
  if (isCompletionAlreadyMaterialized(options) || isWorkContractCompletionMaterialized(options)) {
    return { status: "completed", sent: false };
  }
  const completion = readCompletionFile(options.workContractId)
    ?? (isNativePlannerFinalizer(options) ? readNativeChildSessionCompletion(options) : null);
  if (!completion) return { status: "pending" };
  const bindingResult = observeCompletionBinding({
    workContractId: options.workContractId,
    completionFilePath: resolveWorkerCompletionPath(options.workContractId),
    observedCompletion: completion,
    delegateTaskId: options.delegateTaskId,
    childSessionKey: options.childSessionKey,
  });
  if (resolveRuntimeLedgerFlag() === "enforce" && bindingResult.verdict !== "matched") {
    void appendJsonl(resolveReplayLogPath(), {
      schema_version: "octoclaw.runtime_policy.replay_event/v1",
      event: "completion_binding_verdict_blocked",
      at: new Date().toISOString(),
      workContractId: options.workContractId,
      verdict: bindingResult.verdict,
      completionId: bindingResult.completionId,
      description: bindingResult.description,
    }).catch(() => {});
    updateTaskStateBindingRejected(
      options,
      completion,
      bindingResult.verdict === "completion_orphaned" ? "completion_orphaned" : "binding_mismatch",
      bindingResult.description,
    );
    return {
      status: bindingResult.verdict === "completion_orphaned" ? "completion_orphaned" : "binding_mismatch",
      resultText: completion.summary,
      error: `completion_binding_${bindingResult.verdict}: ${bindingResult.description}`,
    };
  }
  if (isCompletionAlreadyMaterialized(options) || isWorkContractCompletionMaterialized(options)) {
    return { status: "completed", resultText: completion.summary, sent: false };
  }
  const releaseDeliveryLock = acquireCompletionDeliveryLock(options.workContractId);
  if (!releaseDeliveryLock) {
    return { status: "completed", resultText: completion.summary, sent: false, error: "delivery_already_in_progress" };

  }
  try {
    if (isCompletionAlreadyMaterialized(options) || isWorkContractCompletionMaterialized(options)) {
      return { status: "completed", resultText: completion.summary, sent: false };
    }
    const message = formatDeliveryMessage(completion, options);
    const result = await sendCompletionMessage(options, message);
    if (!result.sent) {
      const deliveryStatus = "queued_for_retry";
      queueOutboxDelivery(options, message);
      updateTaskStateCompleted(options, completion, deliveryStatus);
      materializeCompletedWorkContract(options, completion, deliveryStatus);
      void appendJsonl(resolveReplayLogPath(), {
        schema_version: "octoclaw.runtime_policy.replay_event/v1",
        event: "delivery_outbox_queued",
        at: new Date().toISOString(),
        workContractId: options.workContractId,
        parentSessionKey: options.parentSessionKey,
        deliverySessionKey: resolveFinalDeliverySessionKey(options),
        error: result.error || deliveryStatus,
      }).catch(() => {});
      await notifyFinalizerTransition(options, "delivery_failed", {
        status: "deliverable_ready",
        statusReason: "final_result_delivery_failed",
        resultMaterialized: true,
        occurredAt: new Date().toISOString(),
        summary: completion.summary,
        failureCode: "final_result_delivery_failed",
        failureMessage: result.error || deliveryStatus,
      });
      return {
        status: "delivery_failed",
        resultText: completion.summary,
        error: result.error || deliveryStatus,
      };
    }
    const deliveryStatus = "delivered";
    updateTaskStateCompleted(options, completion, deliveryStatus);
    materializeCompletedWorkContract(options, completion, deliveryStatus);
    await options.onSuccess?.();
    void appendJsonl(resolveReplayLogPath(), {
      schema_version: "octoclaw.runtime_policy.replay_event/v1",
      event: isNativePlannerFinalizer(options) ? "native_announce_completion_matched" : "completion_file_delivered",
      at: new Date().toISOString(),
      workContractId: options.workContractId,
      parentSessionKey: options.parentSessionKey,
      deliverySessionKey: resolveFinalDeliverySessionKey(options),
      sourceSessionKey: options.childSessionKey,
      sourceTool: isNativePlannerFinalizer(options) ? "subagent_announce" : undefined,
      delivered: true,
      directDeliveryAttempted: isNativePlannerFinalizer(options),
      directDeliverySent: isNativePlannerFinalizer(options),
      delivery_transport: result.transport,
      target_source: result.targetSource || (resolveFinalReplyToMessageId(options) ? "inbound_anchor" : "session_fallback"),
      footer_source: result.footerSource,
      hookName: isNativePlannerFinalizer(options) ? "child_finalizer_native_session" : undefined,
      runId: options.runId || options.childRunId,
      resultText: completion.summary ? String(completion.summary).slice(0, 200) : "",
    }).catch(() => {});
    if (isNativePlannerFinalizer(options)) {
      void appendJsonl(resolveReplayLogPath(), {
        schema_version: "octoclaw.runtime_policy.replay_event/v1",
        event: "native_announce_final_delivered",
        at: new Date().toISOString(),
        workContractId: options.workContractId,
        parentSessionKey: options.parentSessionKey,
        deliverySessionKey: resolveFinalDeliverySessionKey(options),
        replyToMessageId: resolveFinalReplyToMessageId(options) || undefined,
        sourceSessionKey: options.childSessionKey,
        delivery_transport: result.transport,
        target_source: result.targetSource || (resolveFinalReplyToMessageId(options) ? "inbound_anchor" : "session_fallback"),
        footer_source: result.footerSource,
        hookName: "child_finalizer_native_session",
        runId: options.runId || options.childRunId,
      }).catch(() => {});
    }
    return {
      status: result.sent ? "completed" : "delivery_failed",
      resultText: completion.summary,
      sent: result.sent,
      error: result.error || undefined,
    };
  } finally {
    releaseDeliveryLock();
  }
}

export function cancelChildCompletionFinalizer(workContractId: string): boolean {
  const key = stringValue(workContractId);
  if (!key) return false;
  const timer = activeFinalizers.get(key);
  if (!timer) return false;
  clearTimeout(timer);
  activeFinalizers.delete(key);
  return true;
}

export function scheduleChildCompletionFinalizer(options: ChildCompletionFinalizerOptions): boolean {
  const key = stringValue(options.workContractId);
  if (!key || activeFinalizers.has(key)) return false;
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs || DEFAULT_CHILD_COMPLETION_TIMEOUT_MS));
  const pollIntervalMs = Math.max(1_000, Number(options.pollIntervalMs || 5_000));
  let deadline = Date.now() + timeoutMs;
  const tick = async () => {
    try {
      if (isCompletionAlreadyMaterialized(options) || isWorkContractCompletionMaterialized(options)) {
        activeFinalizers.delete(key);
        return;
      }
      const result = await finalizeChildSessionOnce(options);
      if (result.status !== "pending") {
        activeFinalizers.delete(key);
        return;
      }
      const nowMs = Date.now();
      if (nowMs >= deadline && result.error !== "completion_delivery_in_progress") {
        if (isCompletionAlreadyMaterialized(options) || isWorkContractCompletionMaterialized(options)) {
          activeFinalizers.delete(key);
          return;
        }
        if (shouldExtendDeadlineForActiveChild(options, nowMs)) {
          deadline = nowMs + CHILD_SESSION_DEADLINE_EXTENSION_MS;
        } else {
          activeFinalizers.delete(key);
          const timeoutInfo = markTimedOut(options, timeoutMs);
          await notifyFinalizerTransition(options, "timed_out", {
            status: "timed_out",
            statusReason: "completion_file_timeout",
            resultMaterialized: false,
            occurredAt: timeoutInfo.occurredAt,
            failureCode: "completion_file_not_written",
            failureMessage: timeoutInfo.failureMessage,
          });
          void appendJsonl(resolveReplayLogPath(), {
            schema_version: "octoclaw.runtime_policy.replay_event/v1",
            event: "completion_file_timeout",
            at: new Date().toISOString(),
            workContractId: options.workContractId,
            parentSessionKey: options.parentSessionKey,
            timeoutMs,
          }).catch(() => {});
          return;
        }
      }
      const timer = setTimeout(tick, pollIntervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      activeFinalizers.set(key, timer);
    } catch (error) {
      activeFinalizers.delete(key);
      options.logger?.warn?.(`child finalizer error: ${String(error)}`);
    }
  };
  const timer = setTimeout(tick, Math.max(0, Number(options.initialDelayMs ?? 3_000)));
  (timer as unknown as { unref?: () => void }).unref?.();
  activeFinalizers.set(key, timer);
  return true;
}

export function resetChildCompletionFinalizers(): void {
  for (const timer of activeFinalizers.values()) clearTimeout(timer);
  activeFinalizers.clear();
}

export interface RecoveryResult {
  scanned: number;
  scheduled: number;
  skipped: number;
}

function asStr(value: unknown): string {
  return String(value ?? "").trim();
}

function asBool(value: unknown): boolean {
  return value === true || value === "true";
}

function recordValue(record: Record<string, unknown>, ...paths: string[][]): string {
  for (const pathParts of paths) {
    let current: unknown = record;
    for (const part of pathParts) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    const value = asStr(current);
    if (value) return value;
  }
  return "";
}

function embeddedRecordObject(record: Record<string, unknown>, ...paths: string[][]): Record<string, unknown> | undefined {
  for (const pathParts of paths) {
    let current: unknown = record;
    for (const part of pathParts) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (isRecord(current)) return current;
  }
  return undefined;
}

/**
 * Recover pending child completion finalizers from durable task-state.json.
 *
 * Scans records for delegate routes where dispatchExecuted=true, spawnExecuted=true,
 * but resultMaterialized is NOT true. For each eligible record, schedules a finalizer
 * using identities recovered from durable fields.
 *
 * Idempotent: if a finalizer is already active for the same key, the record is skipped.
 */
export function recoverPendingChildCompletionFinalizers(options?: {
  taskStatePath?: string;
  cwd?: string;
  sendFinalMessage?: ChildCompletionFinalizerOptions["sendFinalMessage"];
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}): RecoveryResult {
  const result: RecoveryResult = { scanned: 0, scheduled: 0, skipped: 0 };
  let records: TaskStateRecord[];
  try {
    records = readTaskStateRecords(options?.taskStatePath);
  } catch (error) {
    options?.logger?.warn?.(`octoclaw child finalizer recovery failed to read task-state: ${String(error)}`);
    return result;
  }

  for (const record of records) {
    result.scanned++;

    const route = asStr(record.route);
    const workContractRoute = asStr(
      (record.workContract && typeof record.workContract === "object" ? (record.workContract as unknown as Record<string, unknown>).route : undefined)
      || (record.work_contract && typeof record.work_contract === "object" ? (record.work_contract as unknown as Record<string, unknown>).route : undefined),
    );
    if (route !== "delegate" && workContractRoute !== "delegate") {
      continue;
    }

    const workContractId = asStr(record.workContractId || record.work_contract_id || record.id);
    if (!workContractId) continue;

    if (!asBool(record.dispatchExecuted) && !asBool(record.dispatch_executed)) continue;
    if (!asBool(record.spawnExecuted) && !asBool(record.spawn_executed)) continue;
    if (asBool(record.resultMaterialized) || asBool(record.result_materialized)) continue;

    const childSessionKey = recordValue(record,
      ["childSessionKey"], ["child_session_key"],
      ["workContract", "nativeSpawnRefs", "childSessionKey"], ["workContract", "native_spawn_refs", "child_session_key"],
      ["work_contract", "nativeSpawnRefs", "childSessionKey"], ["work_contract", "native_spawn_refs", "child_session_key"],
      ["workContract", "delegate", "nativeBinding", "childSessionKey"], ["work_contract", "delegate", "nativeBinding", "childSessionKey"],
      ["workContract", "telemetry", "childSessionKey"], ["work_contract", "telemetry", "childSessionKey"],
    );
    const parentSessionKey = recordValue(record,
      ["sessionKey"], ["session_key"],
      ["workContract", "sessionKey"], ["workContract", "session_key"],
      ["work_contract", "sessionKey"], ["work_contract", "session_key"],
      ["workContract", "nativeSpawnRefs", "requesterSessionKey"], ["workContract", "native_spawn_refs", "requester_session_key"],
      ["work_contract", "nativeSpawnRefs", "requesterSessionKey"], ["work_contract", "native_spawn_refs", "requester_session_key"],
    );
    const deliverySessionKey = recordValue(record,
      ["deliverySessionKey"], ["delivery_session_key"],
      ["workContract", "deliverySessionKey"], ["workContract", "delivery_session_key"],
      ["work_contract", "deliverySessionKey"], ["work_contract", "delivery_session_key"],
    );
    const deliveryTarget = embeddedRecordObject(record,
      ["deliveryTarget"], ["delivery_target"],
      ["workContract", "deliveryTarget"], ["workContract", "delivery_target"],
      ["work_contract", "deliveryTarget"], ["work_contract", "delivery_target"],
    );
    const replyToMessageId = recordValue(record,
      ["replyToMessageId"], ["reply_to_message_id"],
      ["workContract", "replyToMessageId"], ["workContract", "reply_to_message_id"],
      ["work_contract", "replyToMessageId"], ["work_contract", "reply_to_message_id"],
    );
    if (!childSessionKey || !parentSessionKey) continue;

    const delegateTaskId = recordValue(record,
      ["taskId"], ["task_id"],
      ["workContract", "delegate", "delegateTaskId"], ["work_contract", "delegate", "delegateTaskId"],
    ) || workContractId;
    const nativeTaskId = recordValue(record, ["nativeTaskId"], ["native_task_id"]) || delegateTaskId;
    const nativeFlowId = recordValue(record,
      ["nativeFlowId"], ["native_flow_id"], ["flowId"], ["flow_id"],
      ["workContract", "delegate", "nativeBinding", "flowId"], ["work_contract", "delegate", "nativeBinding", "flowId"],
    );
    const runId = recordValue(record,
      ["runId"], ["run_id"],
      ["workContract", "nativeSpawnRefs", "openclawRunId"], ["workContract", "native_spawn_refs", "openclaw_run_id"],
      ["work_contract", "nativeSpawnRefs", "openclawRunId"], ["work_contract", "native_spawn_refs", "openclaw_run_id"],
      ["workContract", "delegate", "nativeBinding", "runId"], ["work_contract", "delegate", "nativeBinding", "runId"],
    );
    const childRunId = recordValue(record,
      ["childRunId"], ["child_run_id"],
      ["workContract", "delegate", "nativeBinding", "childRunId"], ["work_contract", "delegate", "nativeBinding", "childRunId"],
      ["workContract", "telemetry", "childRunId"], ["work_contract", "telemetry", "childRunId"],
    );
    const modelId = recordValue(record,
      ["modelProfile"], ["model_profile"], ["model"],
      ["workContract", "delegate", "modelProfile"], ["work_contract", "delegate", "modelProfile"],
    );
    const hasLateCompletion = Boolean(readCompletionFile(workContractId));
    const finalizerOptions: ChildCompletionFinalizerOptions = {
      childSessionKey,
      delegateTaskId,
      workContractId,
      parentSessionKey,
      deliverySessionKey: deliverySessionKey || undefined,
      replyToMessageId: replyToMessageId || undefined,
      deliveryTarget,
      nativeTaskId,
      nativeFlowId,
      runId: runId || childRunId || undefined,
      childRunId,
      modelId: modelId || undefined,
      taskStatePath: options?.taskStatePath,
      cwd: options?.cwd,
      timeoutMs: DEFAULT_CHILD_COMPLETION_TIMEOUT_MS,
      pollIntervalMs: 5_000,
      initialDelayMs: hasLateCompletion ? 0 : 3_000,
      sendFinalMessage: options?.sendFinalMessage,
      logger: options?.logger,
    };
    if (isWorkContractCompletionMaterialized(finalizerOptions)) {
      result.skipped++;
      continue;
    }

    const terminalStatuses = new Set(["completed", "failed", "timed_out", "cancelled", "canceled", "blocked"]);
    const isTerminal = (value: unknown): boolean => terminalStatuses.has(asStr(value));
    if (!hasLateCompletion && (
      isTerminal(record.status)
      || isTerminal(record.workContractStatus)
      || isTerminal(record.work_contract_status)
      || (record.workContract && typeof record.workContract === "object" && isTerminal((record.workContract as unknown as Record<string, unknown>).status))
      || (record.work_contract && typeof record.work_contract === "object" && isTerminal((record.work_contract as unknown as Record<string, unknown>).status))
    )) {
      continue;
    }

    const scheduled = scheduleChildCompletionFinalizer(finalizerOptions);

    if (scheduled) {
      result.scheduled++;
    } else {
      result.skipped++;
    }
  }

  return result;
}
