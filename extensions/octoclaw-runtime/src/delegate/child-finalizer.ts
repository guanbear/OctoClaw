import fsSync from "node:fs";
import path from "node:path";
import type { WorkerCompletionResult } from "@octoclaw/contracts/completion";
import type { NativeBindingRef } from "@octoclaw/contracts/work-contract";
import { getAdapterForSession } from "../im/index.js";
import { resolveDeliveryOutboxPath, resolveTaskStatePath, resolveWorkerCompletionPath, resolveWorkspaceRoot } from "../resolve/env.js";
import { atomicWriteJsonSync } from "../util/atomic-write.js";
import { materializeWorkContractSuccess } from "../work-contract/materializer.js";
import { loadWorkContract } from "../work-contract/store.js";

export interface ChildCompletionRuntime {
  waitForRun?(params: { runId: string; timeoutMs?: number }): Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
  getSessionMessages?(params: { sessionKey: string; limit?: number }): Promise<{ messages: unknown[] }>;
}
export interface ChildCompletionFinalizerOptions {
  childSessionKey: string; delegateTaskId: string; workContractId: string; parentSessionKey: string;
  replyToMessageId?: string; nativeTaskId?: string; nativeFlowId?: string; runId?: string; childRunId?: string; modelId?: string;
  sessionsDir?: string; taskStatePath?: string; cwd?: string; timeoutMs?: number; pollIntervalMs?: number; initialDelayMs?: number;
  runtime?: ChildCompletionRuntime | null; completionProbeTimeoutMs?: number; sessionFallbackIdleMs?: number; recordReplay?: boolean;
  sendFinalMessage?: (params: { sessionKey: string; message: string; replyToMessageId?: string; cwd?: string }) => Promise<{ sent: boolean; delivered: boolean; error?: string }>;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}
export interface ChildCompletionFinalizerResult { status: "completed" | "pending" | "missing_identity" | "delivery_failed"; resultText?: string; sessionFile?: string; sent?: boolean; error?: string }

type TaskStateFile = { tasks?: unknown[] };
const activeFinalizers = new Map<string, ReturnType<typeof setTimeout>>();

function readJsonFile<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(fsSync.readFileSync(filePath, "utf-8")) as T; } catch { return fallback; }
}
function readCompletionFile(workContractId: string): WorkerCompletionResult | null {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(resolveWorkerCompletionPath(workContractId), "utf-8")) as WorkerCompletionResult;
    return parsed.schemaVersion === "octoclaw.worker_completion/v1" && parsed.workContractId && parsed.status && parsed.summary ? parsed : null;
  } catch { return null; }
}
function writeJsonFile(filePath: string, value: unknown): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteJsonSync(filePath, value);
}
function formatDeliveryMessage(completion: WorkerCompletionResult, options: ChildCompletionFinalizerOptions): string {
  const lines = [`${completion.status === "success" ? "✅" : completion.status === "partial" ? "⚠️" : "❌"} 子任务完成`, "", completion.summary];
  if (completion.artifacts?.length) lines.push("", `产出物：${completion.artifacts.join(", ")}`);
  if (completion.status === "failure" && completion.errorMessage) lines.push("", `错误：${completion.errorMessage}`);
  lines.push("", `[route=delegate | model=${options.modelId || "unknown"} | workContract=${options.workContractId}]`);
  return lines.join("\n");
}
function taskIds(options: ChildCompletionFinalizerOptions): Record<string, string | undefined> {
  const runId = options.runId || options.childRunId;
  return { taskId: options.nativeTaskId || options.delegateTaskId, flowId: options.nativeFlowId, runId, childRunId: options.childRunId || options.runId };
}
function updateTaskStateRecord(options: ChildCompletionFinalizerOptions, patch: Record<string, unknown>): void {
  const { taskId, flowId, runId, childRunId } = taskIds(options);
  if (!taskId) return;
  const taskStatePath = options.taskStatePath || resolveTaskStatePath();
  const tasks = Array.isArray(readJsonFile<TaskStateFile>(taskStatePath, { tasks: [] }).tasks)
    ? readJsonFile<TaskStateFile>(taskStatePath, { tasks: [] }).tasks as Record<string, unknown>[] : [];
  const idx = tasks.findIndex((item) => String(item.id || "") === taskId);
  const previous = idx >= 0 ? tasks[idx] : {};
  const next = { ...previous, id: taskId, flow_id: flowId || previous.flow_id, session_key: options.parentSessionKey, route: "delegate", model: options.modelId || previous.model, childSessionKey: options.childSessionKey, child_session_key: options.childSessionKey, runId, run_id: runId, childRunId, child_run_id: childRunId, ...patch };
  if (idx >= 0) tasks[idx] = next; else tasks.unshift(next);
  writeJsonFile(taskStatePath, { tasks });
}
function updateTaskStateCompleted(options: ChildCompletionFinalizerOptions, completion: WorkerCompletionResult, deliveryStatus: string): void {
  const now = new Date().toISOString();
  updateTaskStateRecord(options, { status: deliveryStatus === "delivered" ? "completed" : "deliverable_ready", summary: completion.summary.slice(0, 600), report_path: `child_session:${options.childSessionKey}`, artifact_refs: [`child_session:${options.childSessionKey}`], completed_at: now, updated_at: now, dispatchExecuted: true, spawnExecuted: true, resultMaterialized: true, delivery_status: deliveryStatus, completion });
}
function buildNativeBinding(options: ChildCompletionFinalizerOptions, nativeBinding: Partial<NativeBindingRef> | undefined): NativeBindingRef {
  return { status: "succeeded", nativeTaskId: options.nativeTaskId || nativeBinding?.nativeTaskId || "", taskId: options.nativeTaskId || nativeBinding?.taskId || "", nativeFlowId: options.nativeFlowId || nativeBinding?.nativeFlowId || "", flowId: options.nativeFlowId || nativeBinding?.flowId || "", childSessionKey: options.childSessionKey || nativeBinding?.childSessionKey || "", runId: options.runId || nativeBinding?.runId || "", childRunId: options.childRunId || nativeBinding?.childRunId || "", ownerKey: nativeBinding?.ownerKey || "", controllerId: nativeBinding?.controllerId || "octoclaw.delegate", syncMode: nativeBinding?.syncMode || "managed", revision: nativeBinding?.revision ?? 0, expectedRevision: nativeBinding?.expectedRevision ?? 0 };
}
function materializeCompletedWorkContract(options: ChildCompletionFinalizerOptions, deliveryStatus: string): void {
  try {
    const contract = loadWorkContract(options.workContractId);
    if (!contract) return;
    const binding = buildNativeBinding(options, contract.delegate?.nativeBinding ?? undefined);
    materializeWorkContractSuccess({ workContractId: options.workContractId, nativeBinding: binding, delegateTaskId: options.delegateTaskId, attemptId: contract.delegate?.currentAttemptId || options.delegateTaskId, nativeTaskId: options.nativeTaskId || binding.nativeTaskId, nativeFlowId: options.nativeFlowId || binding.nativeFlowId, childSessionKey: options.childSessionKey, childSessionId: options.childSessionKey, runId: options.runId || options.childRunId, substrateState: "completed", spawnExecuted: true, resultMaterialized: true, deliveryStatus });
  } catch {}
}
function queueOutboxDelivery(options: ChildCompletionFinalizerOptions, message: string): void {
  try {
    const outboxPath = resolveDeliveryOutboxPath();
    const outbox = readJsonFile<unknown[]>(outboxPath, []);
    outbox.push({ workContractId: options.workContractId, parentSessionKey: options.parentSessionKey, replyToMessageId: options.replyToMessageId, message, createdAt: new Date().toISOString(), attempts: 0, nextRetryAt: new Date(Date.now() + 30_000).toISOString() });
    writeJsonFile(outboxPath, outbox);
  } catch {}
}
async function sendCompletionMessage(options: ChildCompletionFinalizerOptions, message: string): Promise<{ sent: boolean; error: string }> {
  if (options.sendFinalMessage) {
    const result = await options.sendFinalMessage({ sessionKey: options.parentSessionKey, message, replyToMessageId: options.replyToMessageId, cwd: options.cwd });
    return { sent: result.sent || result.delivered, error: result.error || "" };
  }
  const adapter = getAdapterForSession(options.parentSessionKey);
  if (!adapter) return { sent: false, error: "no_im_adapter_queued_for_retry" };
  const result = await adapter.send({ sessionKey: options.parentSessionKey, message, replyToMessageId: options.replyToMessageId, timeoutMs: 8000, cwd: options.cwd || resolveWorkspaceRoot() });
  return { sent: result.sent || result.delivered, error: result.error || "" };
}
function markTimedOut(options: ChildCompletionFinalizerOptions, timeoutMs: number): void {
  updateTaskStateRecord(options, { status: "timed_out", updated_at: new Date().toISOString(), failed_at: new Date().toISOString(), dispatchExecuted: true, spawnExecuted: true, resultMaterialized: false, failureCode: "completion_file_not_written", failureMessage: `Worker did not write completion file within ${Math.round(timeoutMs / 1000)}s` });
}

export async function finalizeChildSessionOnce(options: ChildCompletionFinalizerOptions): Promise<ChildCompletionFinalizerResult> {
  if (!options.workContractId || !options.parentSessionKey) return { status: "missing_identity", error: "missing workContractId or parentSessionKey" };
  const completion = readCompletionFile(options.workContractId);
  if (!completion) return { status: "pending" };
  const message = formatDeliveryMessage(completion, options);
  const result = await sendCompletionMessage(options, message);
  if (result.error === "no_im_adapter_queued_for_retry") {
    queueOutboxDelivery(options, message);
    updateTaskStateCompleted(options, completion, "queued_for_retry");
    return { status: "delivery_failed", resultText: completion.summary, error: result.error };
  }
  const deliveryStatus = result.sent ? "delivered" : "failed";
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
      if (result.status !== "pending") { activeFinalizers.delete(key); return; }
      if (Date.now() >= deadline) { activeFinalizers.delete(key); markTimedOut(options, timeoutMs); return; }
      const timer = setTimeout(tick, pollIntervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      activeFinalizers.set(key, timer);
    } catch (err) { activeFinalizers.delete(key); options.logger?.warn?.(`child finalizer error: ${String(err)}`); }
  };
  const timer = setTimeout(tick, Math.max(0, Number(options.initialDelayMs || 3_000)));
  (timer as unknown as { unref?: () => void }).unref?.();
  activeFinalizers.set(key, timer);
  return true;
}

export function resetChildCompletionFinalizers(): void { for (const timer of activeFinalizers.values()) clearTimeout(timer); activeFinalizers.clear(); }
export function findChildFinalResult(): null { return null; }
