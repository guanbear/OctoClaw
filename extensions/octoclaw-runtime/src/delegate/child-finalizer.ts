import fsSync from "node:fs";
import path from "node:path";
import type { NativeBindingRef } from "@octoclaw/contracts/work-contract";
import type { WorkerCompletionResult } from "@octoclaw/contracts/completion";
import { getAdapterForSession } from "../im/index.js";
import { resolveWorkerCompletionPath, resolveDeliveryOutboxPath, resolveTaskStatePath, resolveWorkspaceRoot } from "../resolve/env.js";
import { atomicWriteJsonSync } from "../util/atomic-write.js";
import { loadWorkContract } from "../work-contract/store.js";
import { materializeWorkContractSuccess } from "../work-contract/materializer.js";

export interface ChildCompletionRuntime {
  waitForRun?(params: { runId: string; timeoutMs?: number }): Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
  getSessionMessages?(params: { sessionKey: string; limit?: number }): Promise<{ messages: unknown[] }>;
}

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
  sessionsDir?: string;
  taskStatePath?: string;
  cwd?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  initialDelayMs?: number;
  runtime?: ChildCompletionRuntime | null;
  completionProbeTimeoutMs?: number;
  sessionFallbackIdleMs?: number;
  recordReplay?: boolean;
  sendFinalMessage?: (params: { sessionKey: string; message: string; replyToMessageId?: string; cwd?: string }) => Promise<{ sent: boolean; delivered: boolean; error?: string }>;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}

export interface ChildCompletionFinalizerResult {
  status: "completed" | "pending" | "missing_identity" | "delivery_failed";
  resultText?: string;
  sessionFile?: string;
  sent?: boolean;
  error?: string;
}

const activeFinalizers = new Map<string, ReturnType<typeof setTimeout>>();

function readCompletionFile(workContractId: string): WorkerCompletionResult | null {
  try {
    const filePath = resolveWorkerCompletionPath(workContractId);
    const raw = fsSync.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as WorkerCompletionResult;
    if (
      parsed.schemaVersion !== "octoclaw.worker_completion/v1"
      || !parsed.workContractId
      || !parsed.status
      || !parsed.summary
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function formatDeliveryMessage(completion: WorkerCompletionResult, options: ChildCompletionFinalizerOptions): string {
  const statusEmoji = completion.status === "success" ? "✅" : completion.status === "partial" ? "⚠️" : "❌";
  const lines = [
    `${statusEmoji} 子任务完成`,
    "",
    completion.summary,
  ];
  if (completion.artifacts && completion.artifacts.length > 0) {
    lines.push("", `产出物：${completion.artifacts.join(", ")}`);
  }
  if (completion.status === "failure" && completion.errorMessage) {
    lines.push("", `错误：${completion.errorMessage}`);
  }
  lines.push("", `[route=delegate | model=${options.modelId || "unknown"} | workContract=${options.workContractId}]`);
  return lines.join("\n");
}

function updateTaskStateRecord(
  options: ChildCompletionFinalizerOptions,
  patch: Record<string, unknown>,
): void {
  const taskId = options.nativeTaskId || options.delegateTaskId;
  if (!taskId) return;
  const taskStatePath = options.taskStatePath || resolveTaskStatePath();
  let existing: { tasks?: unknown[] } = { tasks: [] };
  try {
    existing = JSON.parse(fsSync.readFileSync(taskStatePath, "utf-8")) as { tasks?: unknown[] };
  } catch {}
  const tasks = Array.isArray(existing.tasks) ? existing.tasks as Record<string, unknown>[] : [];
  const idx = tasks.findIndex((item) => String(item.id || "") === taskId);
  const previous = idx >= 0 ? tasks[idx] : {};
  const next = {
    ...previous,
    id: taskId,
    flow_id: options.nativeFlowId || previous.flow_id,
    session_key: options.parentSessionKey,
    route: "delegate",
    model: options.modelId || previous.model,
    childSessionKey: options.childSessionKey,
    child_session_key: options.childSessionKey,
    runId: options.runId || options.childRunId,
    run_id: options.runId || options.childRunId,
    childRunId: options.childRunId || options.runId,
    child_run_id: options.childRunId || options.runId,
    ...patch,
  };
  if (idx >= 0) tasks[idx] = next;
  else tasks.unshift(next);
  fsSync.mkdirSync(path.dirname(taskStatePath), { recursive: true });
  atomicWriteJsonSync(taskStatePath, { tasks });
}

function updateTaskStateCompleted(options: ChildCompletionFinalizerOptions, completion: WorkerCompletionResult, deliveryStatus: string): void {
  const now = new Date().toISOString();
  updateTaskStateRecord(options, {
    status: deliveryStatus === "delivered" ? "completed" : "deliverable_ready",
    summary: completion.summary.slice(0, 600),
    report_path: `child_session:${options.childSessionKey}`,
    artifact_refs: [`child_session:${options.childSessionKey}`],
    completed_at: now,
    updated_at: now,
    dispatchExecuted: true,
    spawnExecuted: true,
    resultMaterialized: true,
    delivery_status: deliveryStatus,
    completion,
  });
}

function materializeCompletedWorkContract(options: ChildCompletionFinalizerOptions, deliveryStatus: string): void {
  try {
    const contract = loadWorkContract(options.workContractId);
    if (!contract) return;
    const nativeBinding = contract.delegate?.nativeBinding;
    const binding: NativeBindingRef = {
      status: "succeeded",
      nativeTaskId: options.nativeTaskId || nativeBinding?.nativeTaskId || "",
      taskId: options.nativeTaskId || nativeBinding?.taskId || "",
      nativeFlowId: options.nativeFlowId || nativeBinding?.nativeFlowId || "",
      flowId: options.nativeFlowId || nativeBinding?.flowId || "",
      childSessionKey: options.childSessionKey || nativeBinding?.childSessionKey || "",
      runId: options.runId || nativeBinding?.runId || "",
      childRunId: options.childRunId || nativeBinding?.childRunId || "",
      ownerKey: nativeBinding?.ownerKey || "",
      controllerId: nativeBinding?.controllerId || "octoclaw.delegate",
      syncMode: nativeBinding?.syncMode || "managed",
      revision: nativeBinding?.revision ?? 0,
      expectedRevision: nativeBinding?.expectedRevision ?? 0,
    };
    materializeWorkContractSuccess({
      workContractId: options.workContractId,
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

export async function finalizeChildSessionOnce(options: ChildCompletionFinalizerOptions): Promise<ChildCompletionFinalizerResult> {
  if (!options.workContractId || !options.parentSessionKey) {
    return { status: "missing_identity", error: "missing workContractId or parentSessionKey" };
  }

  const completion = readCompletionFile(options.workContractId);
  if (!completion) return { status: "pending" };

  const message = formatDeliveryMessage(completion, options);
  const sendFn = options.sendFinalMessage;
  let sent = false;
  let deliveryError = "";

  if (sendFn) {
    const result = await sendFn({
      sessionKey: options.parentSessionKey,
      message,
      replyToMessageId: options.replyToMessageId,
      cwd: options.cwd,
    });
    sent = result.sent || result.delivered;
    deliveryError = result.error || "";
  } else {
    const adapter = getAdapterForSession(options.parentSessionKey);
    if (!adapter) {
      try {
        const outboxPath = resolveDeliveryOutboxPath();
        let outbox: unknown[] = [];
        try {
          outbox = JSON.parse(fsSync.readFileSync(outboxPath, "utf-8")) as unknown[];
        } catch {}
        outbox.push({
          workContractId: options.workContractId,
          parentSessionKey: options.parentSessionKey,
          replyToMessageId: options.replyToMessageId,
          message,
          createdAt: new Date().toISOString(),
          attempts: 0,
          nextRetryAt: new Date(Date.now() + 30_000).toISOString(),
        });
        fsSync.mkdirSync(path.dirname(outboxPath), { recursive: true });
        atomicWriteJsonSync(outboxPath, outbox);
      } catch {}
      updateTaskStateCompleted(options, completion, "queued_for_retry");
      return { status: "delivery_failed", resultText: completion.summary, error: "no_im_adapter_queued_for_retry" };
    }
    const result = await adapter.send({
      sessionKey: options.parentSessionKey,
      message,
      replyToMessageId: options.replyToMessageId,
      timeoutMs: 8000,
      cwd: options.cwd || resolveWorkspaceRoot(),
    });
    sent = result.sent || result.delivered;
    deliveryError = result.error || "";
  }

  const deliveryStatus = sent ? "delivered" : "failed";
  updateTaskStateCompleted(options, completion, deliveryStatus);
  materializeCompletedWorkContract(options, deliveryStatus);

  return {
    status: sent ? "completed" : "delivery_failed",
    resultText: completion.summary,
    sent,
    error: deliveryError || undefined,
  };
}

export function scheduleChildCompletionFinalizer(options: ChildCompletionFinalizerOptions): boolean {
  const key = [options.workContractId, options.delegateTaskId, options.childSessionKey]
    .filter(Boolean).join(":");
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
        try {
          const taskStatePath = options.taskStatePath || resolveTaskStatePath();
          let existing: { tasks?: unknown[] } = { tasks: [] };
          try {
            existing = JSON.parse(fsSync.readFileSync(taskStatePath, "utf-8")) as { tasks?: unknown[] };
          } catch {}
          const tasks = Array.isArray(existing.tasks) ? existing.tasks as Record<string, unknown>[] : [];
          const taskId = options.nativeTaskId || options.delegateTaskId;
          const idx = tasks.findIndex((t) => String(t.id || "") === taskId);
          const entry = {
            ...(idx >= 0 ? tasks[idx] : {}),
            id: taskId,
            status: "timed_out",
            updated_at: new Date().toISOString(),
            failed_at: new Date().toISOString(),
            dispatchExecuted: true,
            spawnExecuted: true,
            resultMaterialized: false,
            failureCode: "completion_file_not_written",
            failureMessage: `Worker did not write completion file within ${Math.round(timeoutMs / 1000)}s`,
          };
          if (idx >= 0) tasks[idx] = entry;
          else tasks.unshift(entry);
          fsSync.mkdirSync(path.dirname(taskStatePath), { recursive: true });
          atomicWriteJsonSync(taskStatePath, { tasks });
        } catch {}
        return;
      }
      const timer = setTimeout(tick, pollIntervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      activeFinalizers.set(key, timer);
    } catch (err) {
      activeFinalizers.delete(key);
      options.logger?.warn?.(`child finalizer error: ${String(err)}`);
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

export function findChildFinalResult(): null {
  return null;
}
