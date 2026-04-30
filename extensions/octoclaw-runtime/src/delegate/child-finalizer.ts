import fsSync from "node:fs";
import type { WorkerCompletionResult } from "@octoclaw/contracts/completion";
import type { NativeBindingRef } from "@octoclaw/contracts/work-contract";
import { appendToDeliveryOutbox } from "../delivery/delivery-outbox.js";
import { sendIMMessage } from "../im/send.js";
import { resolveWorkerCompletionPath, resolveWorkspaceRoot } from "../resolve/env.js";
import {
  upsertTaskStateRecord,
  type TaskStateRecord,
} from "../state/task-state-store.js";

/** Shorten a raw model ID or profile name for display: "zhipu/GLM-5.1" → "GLM-5.1" */
function shortModelName(raw: string | undefined): string {
  if (!raw) return "unknown";
  const parts = raw.split("/");
  return parts[parts.length - 1] || raw;
}
import { materializeWorkContractSuccess } from "../work-contract/materializer.js";
import { loadWorkContract } from "../work-contract/store.js";

export interface ChildCompletionFinalizerOptions {
  childSessionKey: string;
  delegateTaskId: string;
  workContractId: string;
  parentSessionKey: string;
  replyToMessageId?: string;
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
  sendFinalMessage?: (params: { sessionKey: string; message: string; replyToMessageId?: string; cwd?: string }) => Promise<{ sent: boolean; delivered: boolean; error?: string }>;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}

export interface ChildCompletionFinalizerResult {
  status: "completed" | "pending" | "missing_identity" | "delivery_failed";
  resultText?: string;
  sent?: boolean;
  error?: string;
}

const activeFinalizers = new Map<string, ReturnType<typeof setTimeout>>();

function readCompletionFile(workContractId: string): WorkerCompletionResult | null {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(resolveWorkerCompletionPath(workContractId), "utf-8")) as WorkerCompletionResult;
    return parsed.schemaVersion === "octoclaw.worker_completion/v1" && parsed.workContractId && parsed.status && parsed.summary ? parsed : null;
  } catch {
    return null;
  }
}

function formatDeliveryMessage(completion: WorkerCompletionResult, options: ChildCompletionFinalizerOptions): string {
  const lines = [`${completion.status === "success" ? "✅" : completion.status === "partial" ? "⚠️" : "❌"} 子任务完成`, "", completion.summary];
  if (completion.artifacts?.length) lines.push("", `产出物：${completion.artifacts.join(", ")}`);
  if (completion.status === "failure" && completion.errorMessage) lines.push("", `错误：${completion.errorMessage}`);
  lines.push("", `[route=delegate | model=${shortModelName(options.modelId)} | workContract=${options.workContractId}]`);
  return lines.join("\n");
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

function updateTaskStateRecord(options: ChildCompletionFinalizerOptions, patch: TaskStateRecord): void {
  const { taskId, flowId, runId, childRunId } = taskIds(options);
  if (!options.workContractId) return;
  const now = new Date().toISOString();
  upsertTaskStateRecord({
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
  }, options.taskStatePath);
}

function updateTaskStateCompleted(options: ChildCompletionFinalizerOptions, completion: WorkerCompletionResult, deliveryStatus: string): void {
  const now = new Date().toISOString();
  updateTaskStateRecord(options, {
    status: deliveryStatus === "delivered" ? "completed" : "deliverable_ready",
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
    completion,
  });
}

function buildNativeBinding(options: ChildCompletionFinalizerOptions, nativeBinding: Partial<NativeBindingRef> | undefined): NativeBindingRef {
  return {
    status: "succeeded",
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

function materializeCompletedWorkContract(options: ChildCompletionFinalizerOptions, deliveryStatus: string): void {
  try {
    const contract = loadWorkContract(options.workContractId, options.taskStatePath);
    if (!contract) return;
    const binding = buildNativeBinding(options, contract.delegate?.nativeBinding ?? undefined);
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
      substrateState: "completed",
      spawnExecuted: true,
      resultMaterialized: true,
      deliveryStatus,
    });
  } catch {}
}

function queueOutboxDelivery(options: ChildCompletionFinalizerOptions, message: string): void {
  try {
    appendToDeliveryOutbox({
      workContractId: options.workContractId,
      kind: "final_result",
      parentSessionKey: options.parentSessionKey,
      replyToMessageId: options.replyToMessageId,
      message,
      cwd: options.cwd,
    });
  } catch {}
}

async function sendCompletionMessage(options: ChildCompletionFinalizerOptions, message: string): Promise<{ sent: boolean; error: string }> {
  if (options.sendFinalMessage) {
    const result = await options.sendFinalMessage({ sessionKey: options.parentSessionKey, message, replyToMessageId: options.replyToMessageId, cwd: options.cwd });
    return { sent: result.sent || result.delivered, error: result.error || "" };
  }
  const result = await sendIMMessage({ sessionKey: options.parentSessionKey, message, replyToMessageId: options.replyToMessageId, timeoutMs: 8000, cwd: options.cwd || resolveWorkspaceRoot() });
  return { sent: result.sent, error: result.error === "no_im_adapter" ? "no_im_adapter_queued_for_retry" : result.error || "" };
}

function markTimedOut(options: ChildCompletionFinalizerOptions, timeoutMs: number): void {
  const now = new Date().toISOString();
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
    failureMessage: `Worker did not write completion file within ${Math.round(timeoutMs / 1000)}s`,
  });
}

export async function finalizeChildSessionOnce(options: ChildCompletionFinalizerOptions): Promise<ChildCompletionFinalizerResult> {
  if (!options.workContractId || !options.parentSessionKey) return { status: "missing_identity", error: "missing workContractId or parentSessionKey" };
  const completion = readCompletionFile(options.workContractId);
  if (!completion) return { status: "pending" };
  const message = formatDeliveryMessage(completion, options);
  const result = await sendCompletionMessage(options, message);
  if (!result.sent) {
    const deliveryStatus = "queued_for_retry";
    queueOutboxDelivery(options, message);
    updateTaskStateCompleted(options, completion, deliveryStatus);
    materializeCompletedWorkContract(options, deliveryStatus);
    return { status: "delivery_failed", resultText: completion.summary, error: result.error || deliveryStatus };
  }
  const deliveryStatus = "delivered";
  updateTaskStateCompleted(options, completion, deliveryStatus);
  materializeCompletedWorkContract(options, deliveryStatus);
  return { status: result.sent ? "completed" : "delivery_failed", resultText: completion.summary, sent: result.sent, error: result.error || undefined };
}

export function scheduleChildCompletionFinalizer(options: ChildCompletionFinalizerOptions): boolean {
  const key = [options.workContractId, options.delegateTaskId, options.childSessionKey].filter(Boolean).join(":");
  if (!key || activeFinalizers.has(key)) return false;
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs || 240_000));
  const pollIntervalMs = Math.max(1_000, Number(options.pollIntervalMs || 5_000));
  const deadline = Date.now() + timeoutMs;
  const tick = async () => {
    try {
      const result = await finalizeChildSessionOnce(options);
      if (result.status !== "pending") {
        activeFinalizers.delete(key);
        return;
      }
      if (Date.now() >= deadline) {
        activeFinalizers.delete(key);
        markTimedOut(options, timeoutMs);
        return;
      }
      const timer = setTimeout(tick, pollIntervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      activeFinalizers.set(key, timer);
    } catch (error) {
      activeFinalizers.delete(key);
      options.logger?.warn?.(`child finalizer error: ${String(error)}`);
    }
  };
  const timer = setTimeout(tick, Math.max(0, Number(options.initialDelayMs || 3_000)));
  (timer as unknown as { unref?: () => void }).unref?.();
  activeFinalizers.set(key, timer);
  return true;
}

export function resetChildCompletionFinalizers(): void {
  for (const timer of activeFinalizers.values()) clearTimeout(timer);
  activeFinalizers.clear();
}
