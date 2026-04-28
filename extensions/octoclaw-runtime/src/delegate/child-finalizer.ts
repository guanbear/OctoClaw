import fsSync from "node:fs";
import path from "node:path";
import type { NativeBindingRef } from "@octoclaw/contracts/work-contract";
import { getAdapterForSession } from "../im/index.js";
import { recordPolicyReplay } from "../replay/replay-logger.js";
import { resolveMainAgentSessionsPath, resolveTaskStatePath, resolveWorkspaceRoot } from "../resolve/env.js";
import { atomicWriteJsonSync } from "../util/atomic-write.js";
import { loadWorkContract } from "../work-contract/store.js";
import { materializeWorkContractSuccess } from "../work-contract/materializer.js";
import { emitExecutionTransitionNotification } from "../ack/execution-transition-notifier.js";

export interface ChildCompletionRuntime {
  waitForRun?(params: { runId: string; timeoutMs?: number }): Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
  getSessionMessages?(params: { sessionKey: string; limit?: number }): Promise<{ messages: unknown[] }>;
}

interface ChildFinalResult {
  text: string;
  source: "runtime_completion" | "session_file_fallback";
  sessionFile?: string;
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

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!isRecord(part)) return "";
    if (part.type === "text") return asString(part.text);
    return "";
  }).filter(Boolean).join("\n");
}

function messageRoleAndText(value: unknown): { role: string; text: string; timestamp: string } | null {
  if (!isRecord(value)) return null;
  const message = isRecord(value.message) ? value.message : value;
  const role = asString(message.role || value.type).toLowerCase();
  const text = textFromContent(message.content);
  return { role, text, timestamp: asString(value.timestamp) };
}

function textFromJsonlLine(line: string): { role: string; text: string; timestamp: string } | null {
  try {
    return messageRoleAndText(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function isFinalAssistantCandidate(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length < 20) return false;
  if (/^\[thinking\]/iu.test(normalized) && !normalized.replace(/\[thinking\]|\[toolCall\]/giu, "").trim()) return false;
  if (/\[toolCall\]/iu.test(normalized) && normalized.length < 120) return false;
  return true;
}

function sanitizeResultPacket(text: string, maxLength = 3500): string {
  const cleaned = text
    .replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/giu, "[internal context omitted]")
    .replace(/rawTranscript\s*[:=][\s\S]*/iu, "rawTranscript: [omitted]")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 40).trim()}\n…[result packet truncated]`;
}

function sessionsDirectory(explicit?: string): string {
  if (explicit) return explicit;
  return path.dirname(resolveMainAgentSessionsPath());
}

async function recordFinalizerReplay(event: string, payload: Record<string, unknown>, options: ChildCompletionFinalizerOptions): Promise<void> {
  if (options.recordReplay === false) return;
  await recordPolicyReplay(event, payload, options.logger);
}

export function findChildFinalResult(options: Pick<ChildCompletionFinalizerOptions, "childSessionKey" | "delegateTaskId" | "workContractId" | "sessionsDir">): { text: string; sessionFile: string } | null {
  const childSessionKey = asString(options.childSessionKey);
  const delegateTaskId = asString(options.delegateTaskId);
  const workContractId = asString(options.workContractId);
  if (!childSessionKey && !delegateTaskId && !workContractId) return null;
  const dir = sessionsDirectory(options.sessionsDir);
  let files: string[] = [];
  try {
    files = fsSync.readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name))
      .sort((a, b) => Number((fsSync.statSync(b) as unknown as { mtimeMs?: number }).mtimeMs || 0) - Number((fsSync.statSync(a) as unknown as { mtimeMs?: number }).mtimeMs || 0))
      .slice(0, 80);
  } catch {
    return null;
  }

  for (const file of files) {
    let raw = "";
    try {
      raw = fsSync.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!raw.includes("[OctoClaw Delegated Task]")) continue;
    if (childSessionKey && !raw.includes(childSessionKey)) continue;
    if (delegateTaskId && !raw.includes(delegateTaskId)) continue;
    if (workContractId && !raw.includes(workContractId)) continue;

    let sawDelegatedTask = false;
    let finalText = "";
    for (const line of raw.split(/\n/u).filter(Boolean)) {
      if (line.includes("[OctoClaw Delegated Task]")) {
        sawDelegatedTask = true;
      }
      if (!sawDelegatedTask) continue;
      const parsed = textFromJsonlLine(line);
      if (!parsed || parsed.role !== "assistant") continue;
      if (isFinalAssistantCandidate(parsed.text)) {
        finalText = parsed.text;
      }
    }
    if (finalText) return { text: sanitizeResultPacket(finalText), sessionFile: file };
  }
  return null;
}

function selectLastAssistantResult(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parsed = messageRoleAndText(messages[index]);
    if (!parsed || parsed.role !== "assistant") continue;
    if (isFinalAssistantCandidate(parsed.text)) return sanitizeResultPacket(parsed.text);
  }
  return "";
}

async function findRuntimeChildFinalResult(options: ChildCompletionFinalizerOptions): Promise<ChildFinalResult | null> {
  const runtime = options.runtime;
  const runId = asString(options.runId || options.childRunId);
  if (!runtime || !runId || typeof runtime.waitForRun !== "function") return null;
  try {
    const wait = await runtime.waitForRun({
      runId,
      timeoutMs: Math.max(500, Number(options.completionProbeTimeoutMs || 1000)),
    });
    if (wait.status === "timeout") return null;
    if (wait.status === "error") {
      await recordFinalizerReplay("child_result_runtime_completion_error", {
        sessionKey: options.parentSessionKey,
        stateKey: options.parentSessionKey,
        workContractId: options.workContractId,
        taskId: options.delegateTaskId,
        childSessionKey: options.childSessionKey,
        childRunId: runId,
        error: asString(wait.error || "runtime_wait_error"),
      }, options);
      return { text: `子任务执行失败：${asString(wait.error || "runtime_wait_error")}`, source: "runtime_completion" };
    }
    if (typeof runtime.getSessionMessages !== "function") {
      return { text: "子任务已完成，但当前 OpenClaw runtime 未提供结果包读取接口。", source: "runtime_completion" };
    }
    const messages = await runtime.getSessionMessages({ sessionKey: options.childSessionKey, limit: 8 });
    const text = selectLastAssistantResult(Array.isArray(messages.messages) ? messages.messages : []);
    return {
      text: text || "子任务已完成，但没有返回可投影的安全结果包。",
      source: "runtime_completion",
    };
  } catch (error) {
    await recordFinalizerReplay("child_result_runtime_probe_failed", {
      sessionKey: options.parentSessionKey,
      stateKey: options.parentSessionKey,
      workContractId: options.workContractId,
      taskId: options.delegateTaskId,
      childSessionKey: options.childSessionKey,
      childRunId: runId,
      error: error instanceof Error ? error.message : String(error),
    }, options);
    return null;
  }
}

async function resolveChildFinalResult(options: ChildCompletionFinalizerOptions): Promise<ChildFinalResult | null> {
  const runtimeResult = await findRuntimeChildFinalResult(options);
  if (runtimeResult) return runtimeResult;
  const fallback = findChildFinalResult(options);
  return fallback ? { ...fallback, source: "session_file_fallback" } : null;
}

function updateTaskStateCompleted(options: ChildCompletionFinalizerOptions, resultText: string, deliveryStatus: string): void {
  const taskId = asString(options.nativeTaskId || options.delegateTaskId);
  if (!taskId) return;
  const taskStatePath = options.taskStatePath || resolveTaskStatePath();
  let existing: { tasks?: unknown[] } = { tasks: [] };
  try {
    existing = JSON.parse(fsSync.readFileSync(taskStatePath, "utf-8")) as { tasks?: unknown[] };
  } catch {}
  const tasks = Array.isArray(existing.tasks) ? existing.tasks as Record<string, unknown>[] : [];
  const now = new Date().toISOString();
  const idx = tasks.findIndex((item) => asString(item.id) === taskId || asString(item.nativeTaskId) === taskId);
  const previous = idx >= 0 ? tasks[idx] : {};
  const next = {
    ...previous,
    id: taskId,
    flow_id: asString(options.nativeFlowId || previous.flow_id),
    session_key: options.parentSessionKey,
    route: "delegate",
    status: deliveryStatus === "delivered" ? "completed" : "deliverable_ready",
    summary: resultText.slice(0, 600),
    model: asString(options.modelId || previous.model),
    completed_at: now,
    updated_at: now,
    dispatchExecuted: true,
    spawnExecuted: true,
    resultMaterialized: true,
    delivery_status: deliveryStatus,
    childSessionKey: options.childSessionKey,
    child_session_key: options.childSessionKey,
    runId: options.runId || options.childRunId,
    run_id: options.runId || options.childRunId,
    childRunId: options.childRunId || options.runId,
    child_run_id: options.childRunId || options.runId,
  };
  if (idx >= 0) tasks[idx] = next;
  else tasks.unshift(next);
  fsSync.mkdirSync(path.dirname(taskStatePath), { recursive: true });
  atomicWriteJsonSync(taskStatePath, { tasks });
}

async function sendFinalMessage(options: ChildCompletionFinalizerOptions, resultText: string): Promise<{ sent: boolean; delivered: boolean; error?: string }> {
  const message = [
    "子任务完成，结果摘要如下：",
    "",
    resultText,
    "",
    `证据投影：WorkContract=${options.workContractId}；dispatchExecuted=true；spawnExecuted=true；resultMaterialized=true${options.nativeTaskId ? `；native_task=${options.nativeTaskId}` : ""}。`,
  ].join("\n");
  if (options.sendFinalMessage) {
    return options.sendFinalMessage({ sessionKey: options.parentSessionKey, message, replyToMessageId: options.replyToMessageId, cwd: options.cwd });
  }
  const adapter = getAdapterForSession(options.parentSessionKey);
  if (!adapter) return { sent: false, delivered: false, error: "no_adapter_for_parent_session" };
  return adapter.send({
    sessionKey: options.parentSessionKey,
    message,
    replyToMessageId: options.replyToMessageId,
    timeoutMs: 8000,
    cwd: options.cwd || resolveWorkspaceRoot(),
  });
}

function materializeCompletedWorkContract(options: ChildCompletionFinalizerOptions, deliveryStatus: string): void {
  const contract = loadWorkContract(options.workContractId);
  const nativeBinding = contract?.delegate?.nativeBinding;
  if (!contract || !nativeBinding) return;
  const nextBinding: NativeBindingRef = {
    ...nativeBinding,
    status: "succeeded",
    nativeTaskId: options.nativeTaskId || nativeBinding.nativeTaskId,
    taskId: options.nativeTaskId || nativeBinding.taskId,
    nativeFlowId: options.nativeFlowId || nativeBinding.nativeFlowId,
    flowId: options.nativeFlowId || nativeBinding.flowId,
    childSessionKey: options.childSessionKey || nativeBinding.childSessionKey,
    runId: options.runId || nativeBinding.runId,
    childRunId: options.childRunId || nativeBinding.childRunId,
  };
  materializeWorkContractSuccess({
    workContractId: options.workContractId,
    nativeBinding: nextBinding,
    delegateTaskId: options.delegateTaskId,
    attemptId: contract.delegate?.currentAttemptId || options.delegateTaskId,
    nativeTaskId: options.nativeTaskId || nativeBinding.nativeTaskId || nativeBinding.taskId,
    nativeFlowId: options.nativeFlowId || nativeBinding.nativeFlowId || nativeBinding.flowId,
    childSessionKey: options.childSessionKey,
    childSessionId: options.childSessionKey,
    runId: options.runId || options.childRunId,
    substrateState: "completed",
    spawnExecuted: true,
    resultMaterialized: true,
    deliveryStatus,
  });
}

export async function finalizeChildSessionOnce(options: ChildCompletionFinalizerOptions): Promise<ChildCompletionFinalizerResult> {
  if (!asString(options.childSessionKey) || !asString(options.delegateTaskId) || !asString(options.parentSessionKey)) {
    return { status: "missing_identity", error: "missing childSessionKey/delegateTaskId/parentSessionKey" };
  }
  const found = await resolveChildFinalResult(options);
  if (!found) return { status: "pending" };

  await recordFinalizerReplay("child_result_materialized", {
    sessionKey: options.parentSessionKey,
    stateKey: options.parentSessionKey,
    workContractId: options.workContractId,
    taskId: options.delegateTaskId,
    nativeTaskId: options.nativeTaskId || "",
    childSessionKey: options.childSessionKey,
    childRunId: options.childRunId || options.runId || "",
    resultSource: found.source,
    sessionFile: found.sessionFile || "",
    resultPacketTokens: Math.ceil(found.text.length / 4),
  }, options);

  const sendResult = await sendFinalMessage(options, found.text);
  const deliveryStatus = sendResult.sent || sendResult.delivered ? "delivered" : "failed";
  updateTaskStateCompleted(options, found.text, deliveryStatus);
  materializeCompletedWorkContract(options, deliveryStatus);

  if (deliveryStatus === "failed") {
    try {
      await emitExecutionTransitionNotification({
        transitionKind: "delivery_failed",
        projection: {
          schemaVersion: "octoclaw.task_status_projection/v1" as const,
          projectionId: `child_finalizer_${options.delegateTaskId}_${Date.now()}`,
          generatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          requestId: "",
          flowId: options.nativeFlowId || options.workContractId,
          taskId: options.nativeTaskId || options.delegateTaskId,
          workContractId: options.workContractId,
          title: "Child result materialized but delivery failed",
          summary: found.text.slice(0, 500),
          taskSummary: found.text.slice(0, 500),
          route: "delegate" as const,
          role: "default",
          backend: "octoclaw.delegate",
          modelProfile: options.modelId || "",
          status: "deliverable_ready",
          statusReason: "final_result_exists_delivery_pending",
          success: false,
          dispatchExecuted: true,
          spawnExecuted: true,
          resultMaterialized: true,
          elapsedMs: 0,
          childSessionKey: options.childSessionKey,
          childSessionId: options.childSessionKey,
          runId: options.runId || options.childRunId,
          childRunId: options.childRunId || options.runId,
          artifactRefs: [],
          artifactRefIds: [],
          actions: ["details", "copy_ref"],
        },
        attemptId: options.delegateTaskId,
        workContractId: options.workContractId,
        sessionKey: options.parentSessionKey,
        stateKey: options.parentSessionKey,
        replyToMessageId: options.replyToMessageId,
        cwd: options.cwd,
        logger: options.logger,
      });
    } catch {}
  }

  return {
    status: deliveryStatus === "delivered" ? "completed" : "delivery_failed",
    resultText: found.text,
    sessionFile: found.sessionFile,
    sent: sendResult.sent || sendResult.delivered,
    error: sendResult.error,
  };
}

export function scheduleChildCompletionFinalizer(options: ChildCompletionFinalizerOptions): boolean {
  const key = [options.workContractId, options.delegateTaskId, options.childSessionKey, options.runId || options.childRunId].map(asString).filter(Boolean).join(":");
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
        await recordFinalizerReplay("child_result_finalizer_timeout", {
          sessionKey: options.parentSessionKey,
          stateKey: options.parentSessionKey,
          workContractId: options.workContractId,
          taskId: options.delegateTaskId,
          nativeTaskId: options.nativeTaskId || "",
          childSessionKey: options.childSessionKey,
          childRunId: options.childRunId || options.runId || "",
          timeoutMs,
        }, options);
        return;
      }
      const timer = setTimeout(tick, pollIntervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      activeFinalizers.set(key, timer);
    } catch (error) {
      activeFinalizers.delete(key);
      options.logger?.warn?.(`child finalizer failed: ${String(error)}`);
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
