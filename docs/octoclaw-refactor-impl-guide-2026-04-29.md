# OctoClaw 重构实施指南

> 给实施 AI 看的操作文档。架构分析和背景见：`octoclaw-architecture-diagnosis-and-refactor-plan-2026-04-29.md`  
> 日期：2026-04-29  
> 分支：`release/0.3.0-ts-rebuild`

---

## 阅读须知

**在开始任何任务前，请先阅读本节。**

### 优先级总览

| 优先级 | 任务 | 影响 | 依赖 |
|--------|------|------|------|
| P0-T1 | Completion File Protocol | **最高** — delegate 能正常返回结果 | 无 |
| P0-T2 | 删除 minified alias | 高 — 防止 OpenClaw 升级崩溃 | 无 |
| P0-T3 | ACK guard 先于 judge | 高 — judge 超时不影响 ACK | 无 |
| P0-T4 | 删除 remote judge | 中 — 清理 300 行空转代码 | 无 |
| P1-T5 | IM adapter 注册表 | 中 — 可插拔其他 IM | P0 全完成 |
| P1-T6 | PolicyStateEntry 类型安全 | 中 — 编译期错误检测 | P0 全完成 |
| P1-T7 | ACK/Progress 三相模型 | 中 — 用户体验，消除重复代码 | P0-T1 完成 |
| P1-T8 | replay-logger 拆分 | 中 — 可维护性 | P0-T4 完成 |
| P2-T9 | 合并幽灵包 | 低 — 减少 build 步骤 | P1 全完成 |
| P2-T10 | 插件开关 + config 清理 | 高 — 开箱体验关键 | P0 全完成 |
| P2-T11 | octoclawctl 统一 | 高 — 安装体验，开源必要 | P2-T10 完成 |
| QF-1..4 | 4 个小修 | 低 | 随时可做 |

**执行顺序**：P0-T1 → P0-T2/T3/T4（可并行）→ P1 各任务（可并行）→ P2（建议 T10→T11→T9）→ QF

- 任务按优先级完成，每个任务完成后运行 `pnpm test` 确认无新增失败
- 不要一次做多个任务
- 每个任务的"绝对不能做"列表必须严格遵守

**工作目录**：`/tmp/octoclaw`（已克隆的仓库）  
**构建命令**：`pnpm --filter @octoclaw/contracts run build && pnpm --filter @octoclaw/policy run build && pnpm --filter @octoclaw/runtime run build`  
**测试命令**：`pnpm test`

---

## P0 任务（最高优先级，先全部完成）

---

### P0-T1：实现 Completion File Protocol

**目标**：让 child worker 完成任务后写结构化 JSON 文件，parent session 读这个文件获得结果，彻底替代"猜最后一条消息"的逻辑。

**涉及文件**：
- 新建：`packages/octoclaw-contracts/src/completion.ts`
- 修改：`extensions/octoclaw-runtime/src/resolve/env.ts`
- 修改：`extensions/octoclaw-runtime/src/tools/registration.ts`（`buildSubagentSpawnMessage` 函数，L729）
- 完全重写：`extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`

---

#### 步骤 1：新建合同文件

创建 `packages/octoclaw-contracts/src/completion.ts`，内容如下（不要增删字段）：

```typescript
export interface WorkerCompletionResult {
  schemaVersion: "octoclaw.worker_completion/v1";
  workContractId: string;
  childSessionKey: string;
  delegateTaskId: string;
  status: "success" | "failure" | "partial";
  summary: string;           // 纯文本，max 2000 字符，给用户和父 agent 读
  artifacts?: string[];      // 产出物路径列表（可选）
  errorCode?: string;        // 失败时的错误码（可选）
  errorMessage?: string;     // 失败时的错误描述（可选）
  completedAt: string;       // ISO 8601 timestamp
}
```

在 `packages/octoclaw-contracts/src/index.ts` 里导出这个类型。

---

#### 步骤 2：添加路径解析函数

在 `extensions/octoclaw-runtime/src/resolve/env.ts` 里新增两个函数（不要修改已有函数）：

```typescript
export function resolveWorkerCompletionPath(workContractId: string): string {
  const root = resolveWorkspaceRoot();
  return path.join(root, ".octoclaw", "completions", `${workContractId}.completion.json`);
}

export function resolveDeliveryOutboxPath(): string {
  const root = resolveWorkspaceRoot();
  return path.join(root, ".octoclaw", "delivery-outbox.json");
}
```

---

#### 步骤 3：修改 worker prompt

找到 `registration.ts` 中的 `buildSubagentSpawnMessage` 函数（L729-739），在任务内容之前插入 completion 指令。

**新的函数实现**：

```typescript
function buildSubagentSpawnMessage(params: {
  task: string;
  childSessionKey: string;
  delegateTaskId: string;
  workContractId: string;
}): string {
  const completionPath = resolveWorkerCompletionPath(params.workContractId);
  const completionTemplate = JSON.stringify({
    schemaVersion: "octoclaw.worker_completion/v1",
    workContractId: params.workContractId,
    childSessionKey: params.childSessionKey,
    delegateTaskId: params.delegateTaskId,
    status: "success",
    summary: "（在此填写任务结果摘要，最多 2000 字）",
    artifacts: [],
    completedAt: new Date().toISOString(),
  }, null, 2);

  return [
    "[OctoClaw Delegated Task]",
    `childSessionKey: ${params.childSessionKey}`,
    `delegateTaskId: ${params.delegateTaskId}`,
    `workContractId: ${params.workContractId}`,
    "",
    "## Completion Requirement",
    "When the task is done, you MUST write the result to this file using the Write tool:",
    `File path: ${completionPath}`,
    "File content (fill in your actual results):",
    "```json",
    completionTemplate,
    "```",
    "Rules:",
    "- status: use \"success\" if task completed, \"failure\" if it failed, \"partial\" if partially done",
    "- summary: plain text description of what was done and the key results (no raw transcripts)",
    "- If failed, add errorCode and errorMessage fields",
    "- Writing this file is your LAST action. Do not output anything after writing it.",
    "",
    "## Task",
    params.task,
  ].filter(Boolean).join("\n");
}
```

在文件顶部 import `resolveWorkerCompletionPath`。

---

#### 步骤 4：重写 child-finalizer.ts

**完全替换**现有的 `child-finalizer.ts`（530 行）为如下实现（约 180 行）。

**注意**：保留现有的 `ChildCompletionFinalizerOptions` 和 `ChildCompletionFinalizerResult` 接口签名（`scheduleChildCompletionFinalizer` 和 `finalizeChildSessionOnce` 的对外接口不变），因为其他文件依赖这些接口。

```typescript
import fsSync from "node:fs";
import path from "node:path";
import type { WorkerCompletionResult } from "@octoclaw/contracts/completion";
import { getAdapterForSession } from "../im/index.js";
import { resolveWorkerCompletionPath, resolveWorkspaceRoot, resolveTaskStatePath } from "../resolve/env.js";
import { atomicWriteJsonSync } from "../util/atomic-write.js";
import { loadWorkContract } from "../work-contract/store.js";
import { materializeWorkContractSuccess } from "../work-contract/materializer.js";

// === 接口定义（保持与原来完全一致，其他文件依赖这些） ===

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
  cwd?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  initialDelayMs?: number;
  // 下面这些保留但不再使用（向后兼容）
  runtime?: unknown;
  sessionsDir?: string;
  taskStatePath?: string;
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

// === 核心逻辑 ===

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

function updateTaskStateRecord(options: ChildCompletionFinalizerOptions, completion: WorkerCompletionResult, deliveryStatus: string): void {
  try {
    const taskPath = options.taskStatePath || resolveTaskStatePath();
    let existing: { tasks?: unknown[] } = { tasks: [] };
    try {
      existing = JSON.parse(fsSync.readFileSync(taskPath, "utf-8")) as { tasks?: unknown[] };
    } catch { /* file may not exist yet */ }
    const tasks = Array.isArray(existing.tasks) ? existing.tasks as Record<string, unknown>[] : [];
    const taskId = options.nativeTaskId || options.delegateTaskId;
    const idx = tasks.findIndex((t) => String(t.id || "") === taskId);
    const now = new Date().toISOString();
    const entry = {
      ...(idx >= 0 ? tasks[idx] : {}),
      id: taskId,
      workContractId: options.workContractId,
      status: deliveryStatus === "delivered" ? "completed" : "deliverable_ready",
      summary: completion.summary.slice(0, 600),
      childSessionKey: options.childSessionKey,
      runId: options.runId || options.childRunId,
      completion,
      delivery_status: deliveryStatus,
      completed_at: now,
      updated_at: now,
      resultMaterialized: true,
      dispatchExecuted: true,
      spawnExecuted: true,
    };
    if (idx >= 0) tasks[idx] = entry;
    else tasks.unshift(entry);
    const dir = path.dirname(taskPath);
    fsSync.mkdirSync(dir, { recursive: true });
    atomicWriteJsonSync(taskPath, { tasks });
  } catch { /* best effort */ }
}

export async function finalizeChildSessionOnce(
  options: ChildCompletionFinalizerOptions,
): Promise<ChildCompletionFinalizerResult> {
  if (!options.workContractId || !options.parentSessionKey) {
    return { status: "missing_identity", error: "missing workContractId or parentSessionKey" };
  }

  const completion = readCompletionFile(options.workContractId);
  if (!completion) return { status: "pending" };

  // 发送到 IM
  const sendFn = options.sendFinalMessage;
  const message = formatDeliveryMessage(completion, options);
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
      // 写入 delivery outbox（下个 watchdog 周期重试）
      try {
        const outboxPath = resolveDeliveryOutboxPath();
        let outbox: unknown[] = [];
        try { outbox = JSON.parse(fsSync.readFileSync(outboxPath, "utf-8")) as unknown[]; } catch { /* empty */ }
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
      } catch { /* best effort */ }
      updateTaskStateRecord(options, completion, "queued_for_retry");
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
  updateTaskStateRecord(options, completion, deliveryStatus);

  // 更新 WorkContract
  try {
    const contract = loadWorkContract(options.workContractId);
    if (contract) {
      const nativeBinding = contract.delegate?.nativeBinding ?? {
        status: "succeeded",
        nativeTaskId: options.nativeTaskId || "",
        nativeFlowId: options.nativeFlowId || "",
        taskId: options.nativeTaskId || "",
        flowId: options.nativeFlowId || "",
        childSessionKey: options.childSessionKey,
        runId: options.runId || options.childRunId || "",
        revision: 0,
        expectedRevision: 0,
      };
      materializeWorkContractSuccess({
        workContractId: options.workContractId,
        nativeBinding: { ...nativeBinding, status: "succeeded" },
        delegateTaskId: options.delegateTaskId,
        attemptId: contract.delegate?.currentAttemptId || options.delegateTaskId,
        childSessionKey: options.childSessionKey,
        runId: options.runId || options.childRunId,
        substrateState: "completed",
        spawnExecuted: true,
        resultMaterialized: true,
        deliveryStatus,
      });
    }
  } catch { /* best effort */ }

  return {
    status: sent ? "completed" : "delivery_failed",
    resultText: completion.summary,
    sent,
    error: deliveryError || undefined,
  };
}

const activeFinalizers = new Map<string, ReturnType<typeof setTimeout>>();

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
        // timeout: 更新 task state
        try {
          const taskPath = options.taskStatePath || resolveTaskStatePath();
          let existing: { tasks?: unknown[] } = { tasks: [] };
          try { existing = JSON.parse(fsSync.readFileSync(taskPath, "utf-8")) as { tasks?: unknown[] }; } catch { /* */ }
          const tasks = Array.isArray(existing.tasks) ? existing.tasks as Record<string, unknown>[] : [];
          const taskId = options.nativeTaskId || options.delegateTaskId;
          const idx = tasks.findIndex((t) => String(t.id || "") === taskId);
          const entry = {
            ...(idx >= 0 ? tasks[idx] : {}),
            id: taskId,
            status: "timed_out",
            updated_at: new Date().toISOString(),
            failed_at: new Date().toISOString(),
            failureCode: "completion_file_not_written",
            failureMessage: `Worker did not write completion file within ${Math.round(timeoutMs / 1000)}s`,
          };
          if (idx >= 0) tasks[idx] = entry;
          else tasks.unshift(entry);
          atomicWriteJsonSync(taskPath, { tasks });
        } catch { /* best effort */ }
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

// 向后兼容：这两个函数原来被测试文件用到，保留但返回 null
export function findChildFinalResult(): null { return null; }
```

> **注意**：`resolveDeliveryOutboxPath` 需要从 `env.ts` import。

---

**验收标准 P0-T1**：
- [ ] `pnpm --filter @octoclaw/contracts run build` 通过，`WorkerCompletionResult` 类型可导出
- [ ] `pnpm test` 没有新增失败（原有测试仍通过）
- [ ] `child-finalizer.ts` 不再包含 `.jsonl`、`readdirSync`、`[OctoClaw Delegated Task]` 字符串
- [ ] `buildSubagentSpawnMessage` 的输出中包含 `octoclaw.worker_completion/v1` 和 completion file 路径
- [ ] `finalizeChildSessionOnce` 在没有 completion file 时返回 `{ status: "pending" }`
- [ ] `finalizeChildSessionOnce` 在有 completion file 时调用 IM adapter 发送消息并返回 `{ status: "completed" }` 或 `{ status: "delivery_failed" }`

**绝对不能做**：
- 不能修改 `ChildCompletionFinalizerOptions` 和 `ChildCompletionFinalizerResult` 的接口签名（其他文件依赖）
- 不能删除 `scheduleChildCompletionFinalizer` 和 `resetChildCompletionFinalizers` 函数（其他文件调用）
- 不能修改 TaskFlow bridge 相关代码
- 不能修改 `registration.ts` 里除 `buildSubagentSpawnMessage` 以外的任何函数

---

### P0-T2：删除 detached-task-runtime-host 的 minified alias 逻辑

**目标**：停止加载 OpenClaw 内部 bundle，改为 stub runtime。

**涉及文件**：
- 完全重写：`extensions/octoclaw-runtime/src/adapter/detached-task-runtime-host.ts`

**背景**：原来这个文件加载 `tasks/task-executor.js`（OpenClaw 内部 minified bundle）并用 `["a","o","f","l","i","s","d"]` 这些单字母别名找函数。OpenClaw 每次升级可能改变这些别名，导致整个项目崩溃。

**新的实现**（完全替换原文件）：

```typescript
import { randomUUID } from "node:crypto";
import type { DetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";

/**
 * 创建一个最小化的 stub DetachedTaskRuntime。
 *
 * 原来的实现通过 loadOpenClawDistModule("tasks/task-executor.js") 加载
 * OpenClaw 内部 minified bundle，使用单字母 alias ["a","o","f","l","i","s","d"]
 * 访问内部函数。这在 OpenClaw 升级时极易断裂。
 *
 * 新实现：Task 生命周期通过 completion file protocol 处理（child-finalizer.ts），
 * 不再依赖 OpenClaw 内部模块。此处仅提供满足接口的 stub。
 */
export function createHostDetachedTaskLifecycleRuntime(): Promise<DetachedTaskLifecycleRuntime> {
  return Promise.resolve(createStubDetachedTaskRuntime());
}

function createStubDetachedTaskRuntime(): DetachedTaskLifecycleRuntime {
  return {
    createQueuedTaskRun: (params) => ({
      taskId: randomUUID(),
      requesterSessionKey: params.requesterSessionKey,
      parentFlowId: params.parentFlowId,
      status: "queued",
    }),
    createRunningTaskRun: (params) => ({
      taskId: randomUUID(),
      requesterSessionKey: params.requesterSessionKey,
      parentFlowId: params.parentFlowId,
      status: "running",
    }),
    startTaskRunByRunId: () => [],
    recordTaskRunProgressByRunId: () => [],
    completeTaskRunByRunId: () => [],
    failTaskRunByRunId: () => [],
    setDetachedTaskDeliveryStatusByRunId: () => [],
    cancelDetachedTaskRunById: async () => ({ found: false, cancelled: false }),
  };
}

// 以下导出保留，供测试文件使用
export { resolveExport, requireFunctionWithAliases } from "./detached-task-runtime-stub-compat.js";
```

> **重要**：如果有测试文件 import 了 `resolveExport` 或 `requireFunctionWithAliases`，需要创建一个 `detached-task-runtime-stub-compat.ts` 文件提供这些函数的空实现，防止测试失败。先用 `grep -r "resolveExport\|requireFunctionWithAliases" --include="*.ts"` 检查是否有依赖，如果没有就不需要这个 compat 文件，直接删除 export 行。

---

**验收标准 P0-T2**：
- [ ] `detached-task-runtime-host.ts` 不再包含 `loadOpenClawDistModule`、`task-executor`、`TASK_EXECUTOR_ALIASES`、`["a"]`、`["o"]`、`["f"]` 等字符串
- [ ] `pnpm test` 没有新增失败
- [ ] `pnpm --filter @octoclaw/runtime run build` 通过
- [ ] OpenClaw 运行时不可用时（`openclaw` 命令不存在），进程不崩溃，输出 warn 日志

**绝对不能做**：
- 不能修改 `taskflow-bridge.ts`（这个文件用的是稳定 API，不是内部 bundle）
- 不能修改 `detached-task-runtime.ts`（接口定义文件，保持不变）
- 不能删除 `createHostDetachedTaskLifecycleRuntime` 函数名（`plugin.ts` 里有调用）

---

### P0-T3：ACK Guard 在 Judge 之前启动

**目标**：确保 judge 超时时 ACK guard 已经启动，用户不会因为 judge 慢而收不到任何反馈。

**涉及文件**：
- 修改：`extensions/octoclaw-runtime/src/extension-entry.ts`（`before_prompt_build` hook，约 L800-880）
- 修改：`extensions/octoclaw-runtime/src/ack/ack-guard.ts`（新增一个函数）

---

#### 步骤 1：在 ack-guard.ts 里新增 updateAckGuardDecision

找到 `startAckGuard` 函数，在它下面新增：

```typescript
/**
 * 用 judge 完成后的实际决策更新已启动的 ACK guard。
 * ACK guard 先用空决策启动，judge 完成后调用此函数补充信息。
 */
export function updateAckGuardDecision(
  sessionKey: string,
  decision: Record<string, unknown>,
): void {
  const key = asString(sessionKey);
  if (!key) return;
  updateAckTrackingState(key, {
    decision,
    decision_updated_at: Date.now(),
  });
}
```

---

#### 步骤 2：修改 before_prompt_build hook 的执行顺序

找到 `before_prompt_build` hook 的注册（`registerLifecycleHook("before_prompt_build", ...)`），修改 hook 内部的执行顺序。

**现在的顺序**（错的）：
```
startLatencyAckTimer → judge → sendRouteCommitAck → startAckGuard
```

**改后的顺序**（对的）：
```
startAckGuard（用空决策）→ startLatencyAckTimer → judge → updateAckGuardDecision → sendRouteCommitAck
```

具体改动：找到 `startAckGuard(preSessionKey, ...)` 的调用位置（在 judge 完成后，约 L877），将它**移动到** judge 调用之前（约 L823 的 `startLatencyAckTimer` 调用之前或之后）。

```typescript
// 改后的关键顺序：
// ① 先启动 ACK guard（用空决策）
if (preSessionKey) {
  startAckGuard(preSessionKey, stringValue(ctx.cwd) || process.cwd(), {
    stateKey: preStateKey,
    decision: {},   // 空决策，guard 自己有 timeout 保障
    replyToMessageId: inboundMessageTs,
  });
  if (effectiveState) {
    effectiveState.ackGuardKey = preSessionKey;
    if (inboundMessageTs) effectiveState.inboundMessageTs = inboundMessageTs;
  }
}

// ② 启动 latency ACK timer
startLatencyAckTimer(preStateKey);

// ③ 调用 judge（可能超时，但 guard 已启动）
const resolved = await resolvePolicyDecisionForContext(
  prompt, ctx, process.cwd(), pi.logger,
).catch((err) => {
  pi.logger?.warn?.(`octoclaw judge failed: ${String(err)}`);
  return null;
});

// ④ judge 完成后更新 guard 的决策信息
if (resolved && preSessionKey) {
  updateAckGuardDecision(preSessionKey, effectiveDecision ?? {});
}

// ⑤ route commit ACK（可选，失败不阻塞）
try {
  await sendRouteCommitAck({ ... });
} catch (err) {
  pi.logger?.warn?.(`route commit ack failed: ${String(err)}`);
}
```

> **注意**：原来 `startAckGuard` 后面还有 `effectiveState.ackGuardKey = preSessionKey` 等状态更新，需要同步移到新位置。

---

**验收标准 P0-T3**：
- [ ] 在 `before_prompt_build` 的代码里，`startAckGuard` 的调用在 `resolvePolicyDecisionForContext` 调用**之前**
- [ ] `updateAckGuardDecision` 函数存在于 `ack-guard.ts`
- [ ] `pnpm test` 没有新增失败
- [ ] 以下场景不会导致 ACK guard 未启动：judge LLM 调用抛异常、judge 返回 null、judge 超时

**绝对不能做**：
- 不能删除 `cancelAckGuardForState`、`watchdogTick` 等现有 ACK guard 函数
- 不能修改 ACK guard 的 watchdog 逻辑
- 不能修改 `sendRouteCommitAck` 函数本身
- 不能修改 `startLatencyAckTimer` 的延迟时间（3500ms）

---

### P0-T4：Judge 架构简化（删除 Remote Judge）

**目标**：删除永远不会生效的 remote judge 层，简化为单 judge 架构。约删除 300 行代码，零功能损失。

**涉及文件**（只删除，不新增逻辑）：
- `packages/octoclaw-policy/src/judge/judge-schema.ts`
- `extensions/octoclaw-runtime/src/resolve/llm-judge.ts`
- `packages/octoclaw-policy/src/judge/judge-prompt.ts`
- `packages/octoclaw-policy/src/spec/prompt-builder.ts`
- `extensions/octoclaw-runtime/src/extension-entry.ts`（删 ~15 行）
- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`（简化 ~100 行）

---

#### 步骤 1：judge-schema.ts 删除类型

删除以下内容（保留其他所有内容）：
- `DualJudgeConfig` interface
- `RemoteJudgeConfig` interface
- `EscalationReason` type
- `RemoteJudgeOutput` interface
- `REMOTE_JUDGE_DEFAULTS` 常量
- `ESCALATION_DEFAULTS` 常量

---

#### 步骤 2：llm-judge.ts 删除函数

删除以下函数和所有相关 import（保留其他所有内容）：
- `callRemoteJudge()` 整个函数（约 L516-589）
- `shouldEscalate()` 整个函数（约 L485-513）
- `resolveDualJudgeConfig()` 整个函数（约 L139-170）
- `resolveDualJudgeConfigFromEnv()` 整个函数

删除这些函数的同时，删除它们对应的 export 和 import。

---

#### 步骤 3：judge-prompt.ts 删除函数

删除：
- `buildRemoteJudgeSystemPrompt()` 函数和它的 export
- `buildRemoteJudgeUserPrompt()` 函数和它的 export

---

#### 步骤 4：prompt-builder.ts 删除函数

删除 `buildRemoteJudgeSystemPrompt` 和 `buildRemoteJudgeUserPrompt` 相关函数（以及 `RemoteJudgeExpandedPacket` 引用，如果 spec 里有的话）。

---

#### 步骤 5：extension-entry.ts 删除 remote judge 配置注入

找到如下代码块并删除（约 L685-700）：

```typescript
const remoteJudgeFromEnv = (() => { ... })();
const remoteJudgeFromPlugin = ...;
const remoteJudgeRaw = ...;
```

以及所有使用 `remoteJudgeRaw` 的地方（传给 `preMetadata._remoteJudgeConfig = ...`）。

---

#### 步骤 6：policy-resolver.ts 简化 judge 调用

找到 `resolveStatelessPolicyDecision` 函数里的 judge 调用段（约 L1597-1877），将 dual judge 流程替换为单 judge：

**删除**：
- `let dualJudgeConfig = resolveDualJudgeConfig(...)`
- `let remoteJudgeResult = null`
- `let remoteJudgeOverrideApplied = false`
- `escalationReason = shouldEscalate(...)` 相关块
- `callRemoteJudge(...)` 相关块
- 所有 `remote_override_applied`、`remote_judge_enabled`、`escalation_reason`、`judgment_shadow_log.remote_*` 字段的赋值

**保留**（只是去掉 dual judge 包装层）：
- `const judgeConfig = resolveJudgeConfig(asRecord(asRecord(options.metadata)._judgeFastConfig))`
- `const judgeResult = await callLlmJudge(judgeInput, judgeConfig)`
- 后续 `isActionableJudgeResult`、`judgeResultToRouteOverride` 等判断逻辑
- `judgeShadowLog` 里 local judge 相关字段

---

**验收标准 P0-T4**：
- [ ] `pnpm --filter @octoclaw/policy run build` 通过
- [ ] `pnpm --filter @octoclaw/runtime run build` 通过
- [ ] `pnpm test` 没有新增失败
- [ ] 代码里不再有 `DualJudgeConfig`、`callRemoteJudge`、`shouldEscalate`、`resolveDualJudgeConfig` 字符串
- [ ] 代码里不再有 `remoteJudgeRaw`、`_remoteJudgeConfig`、`remoteJudgeOverrideApplied` 字符串
- [ ] `resolveJudgeConfig` 函数仍然存在且工作正常
- [ ] `callLlmJudge` 函数仍然存在且工作正常
- [ ] 不配置 `OCTOCLAW_JUDGE_FAST` 时，judge 跳过，`routeHintRequired=true` 被注入 system prompt

**绝对不能做**：
- 不能删除 `callLlmJudge`、`resolveJudgeConfig`、`isActionableJudgeResult`、`judgeResultToRouteOverride`
- 不能修改 judge 的 prompt（`buildJudgeSystemPrompt`、`buildJudgeUserPrompt`）
- 不能修改 `JudgeFastConfig` 类型定义（只删 Dual/Remote 相关的）
- 不能修改 Ollama 的特殊处理逻辑（`isOllamaEndpoint`、`postOllamaNative`）

---

## P1 任务（P0 全部完成后再做）

---

### P1-T5：IM Adapter 提取接口，支持注册

**目标**：抽取 `IMAdapter` 接口，`im/index.ts` 改为注册表模式，Slack 作为内置适配器。支持外部注册其他 IM（飞书、微信等）而不需要修改核心代码。

**涉及文件**：
- 新建：`extensions/octoclaw-runtime/src/im/adapter.ts`（接口定义）
- 修改：`extensions/octoclaw-runtime/src/im/index.ts`（改为注册表）
- 修改：`extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`（实现接口）

---

#### 步骤 1：新建接口文件

创建 `extensions/octoclaw-runtime/src/im/adapter.ts`：

```typescript
export interface IMSendParams {
  sessionKey: string;
  message: string;
  replyToMessageId?: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface IMSendResult {
  sent: boolean;
  delivered: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
}

export interface IMAdapter {
  readonly channel: string;
  canHandle(sessionKey: string): boolean;
  send(params: IMSendParams): Promise<IMSendResult>;
}
```

---

#### 步骤 2：修改 index.ts

```typescript
import { SlackAdapter } from "./slack/index.js";
import type { SlackAdapterConfig } from "./slack/index.js";
import type { IMAdapter } from "./adapter.js";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

export type { IMAdapter } from "./adapter.js";

const adapterRegistry: IMAdapter[] = [];

function readSlackReplyToMode(): "off" | "first" | "all" {
  // 保持原来的实现不变
}

function buildSlackAdapterConfig(): Partial<SlackAdapterConfig> {
  return { replyToMode: readSlackReplyToMode() };
}

// 注册内置 Slack adapter
adapterRegistry.push(new SlackAdapter(buildSlackAdapterConfig()));

export function registerIMAdapter(adapter: IMAdapter): void {
  // 同一 channel 后注册的会优先（unshift）
  adapterRegistry.unshift(adapter);
}

export function getAdapterForSession(sessionKey: string): IMAdapter | null {
  return adapterRegistry.find((adapter) => adapter.canHandle(sessionKey)) ?? null;
}

export { SlackAdapter } from "./slack/index.js";
export type { SlackAdapterConfig } from "./slack/index.js";
```

---

#### 步骤 3：让 SlackAdapter 实现 IMAdapter 接口

在 `slack-adapter.ts` 里：
1. import `IMAdapter` from `"../adapter.js"`
2. `SlackAdapter` 类声明改为 `export class SlackAdapter implements IMAdapter`
3. 新增 `canHandle(sessionKey: string): boolean` 方法：

```typescript
canHandle(sessionKey: string): boolean {
  const lower = sessionKey.toLowerCase();
  return lower.startsWith("slack:") || lower.includes(":slack:");
}
```

---

**验收标准 P1-T5**：
- [ ] `pnpm --filter @octoclaw/runtime run build` 通过
- [ ] `pnpm test` 没有新增失败
- [ ] `getAdapterForSession("slack:user:ABC123")` 返回 SlackAdapter 实例
- [ ] `getAdapterForSession("feishu:user:ABC123")` 返回 null（未注册时）
- [ ] 调用 `registerIMAdapter(customAdapter)` 后，`getAdapterForSession` 能找到自定义 adapter
- [ ] 原来调用 `getAdapterForSession` 的代码（`child-finalizer.ts`、`ack-guard.ts` 等）不需要修改

**绝对不能做**：
- 不能修改 `SlackAdapter` 的 `send`、`react`、`executeSend` 等已有方法的实现
- 不能修改 `ack-guard.ts` 里对 `getAdapterForSession` 的调用

---

### P1-T6：PolicyStateEntry 删除 [key: string]: unknown

**目标**：给 `PolicyStateEntry` 枚举所有已知字段，删除索引签名，让 TypeScript 恢复类型检查能力。

**注意**：这个改动会产生大量 TypeScript 编译错误，需要逐一修复。大多数修复是把 `state.someField` 改为 `state.extraState?.someField` 或直接 cast。**不要为了消除编译错误而把索引签名加回来**。

**涉及文件**：
- 主要修改：`extensions/octoclaw-runtime/src/state/policy-state.ts`
- 修复编译错误的文件：`extension-entry.ts`、`resolve/policy-resolver.ts`、`replay/replay-logger.ts` 等（哪里报错改哪里）

---

#### 步骤 1：修改 PolicyStateEntry

将现有的 `PolicyStateEntry` interface 中的 `[key: string]: unknown` 替换为明确的字段列表（参考架构文档中 P7 问题的改后版本）。

同时新增 `extraState?: Record<string, unknown>` 收容真正需要动态字段的场景。

---

#### 步骤 2：修复 PolicyStateStore 的 entries() 方法

找到 `policy-state.ts:494-496` 的 type cast：
```typescript
Array.from((store as unknown as { entries: Map<string, PolicyStateEntry> }).entries.entries())
```

在 `PolicyStateStore` 类里添加 `public entries()` 方法：

```typescript
public entries(): Map<string, PolicyStateEntry> {
  return this.entries;
}
```

但要注意：`entries` 已经是成员变量名，需要改一下命名，比如：
- 内部成员变量改名为 `_entries`
- 公开方法命名为 `entries()`

然后在 `createPolicyStateStore` 的 wrapper 里更新对应调用。

---

#### 步骤 3：修复编译错误

运行 `pnpm --filter @octoclaw/runtime run check`（只类型检查不编译），逐一修复报错。

常见修复模式：
- `state.someArbitraryField` → `(state as Record<string, unknown>).someArbitraryField`（临时 cast，不影响功能）
- 对于明确知道是什么类型的字段，直接加到 `PolicyStateEntry` 里

---

**验收标准 P1-T6**：
- [ ] `PolicyStateEntry` 接口里没有 `[key: string]: unknown` 行
- [ ] `pnpm --filter @octoclaw/runtime run build` 通过（零类型错误）
- [ ] `pnpm test` 没有新增失败
- [ ] `entries()` 方法在 `PolicyStateStore` 上是 public 方法（不通过 type cast 访问）

**绝对不能做**：
- 不能加回 `[key: string]: unknown`
- 不能用 `any` 类型逃避修复（`as unknown as X` 是可以的）
- 不能删除现有字段

---

### P1-T7：ACK/Progress 统一——三相模型

**目标**：合并两套并行的通知系统，统一发送路径，精简模板池，修复 `no_valid_thread_anchor` 静默 skip。

**涉及文件**：
- 新建：`extensions/octoclaw-runtime/src/im/send.ts`（统一发送函数）
- 重写：`extensions/octoclaw-runtime/src/ack/ack-templates.ts`（精简模板）
- 删除：`extensions/octoclaw-runtime/src/ack/ack-template-registry.ts`（第二套模板系统）
- 修改：`extensions/octoclaw-runtime/src/ack/ack-timing.ts`（delegate 路由禁用 tier1/2/3）
- 修改：`extensions/octoclaw-runtime/src/ack/ack-guard.ts`（`sendAckDirectDetailed` 改调统一函数）
- 修改：`extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts`（修复 skip + 改调统一函数）

---

#### 步骤 1：新建统一发送函数

创建 `extensions/octoclaw-runtime/src/im/send.ts`：

```typescript
import { getAdapterForSession } from "./index.js";
import { resolveWorkspaceRoot } from "../resolve/env.js";

export interface SendIMParams {
  sessionKey: string;
  message: string;
  replyToMessageId?: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface SendIMResult {
  sent: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
}

export async function sendIMMessage(params: SendIMParams): Promise<SendIMResult> {
  const adapter = getAdapterForSession(params.sessionKey);
  if (!adapter) {
    return { sent: false, error: "no_im_adapter" };
  }
  const result = await adapter.send({
    sessionKey: params.sessionKey,
    message: params.message,
    replyToMessageId: params.replyToMessageId,
    timeoutMs: params.timeoutMs ?? 5000,
    cwd: params.cwd ?? resolveWorkspaceRoot(),
  });
  return {
    sent: result.sent || result.delivered,
    messageId: result.messageId,
    threadTs: result.threadTs,
    error: result.error,
  };
}
```

---

#### 步骤 2：精简 ack-templates.ts

**完整替换** `ack-templates.ts` 为以下内容（约 60 行，原来 311 行）：

```typescript
// 精简后的模板池：每 stage 5-6 条，覆盖语气变化即可
// 不再有 AckStage enum、AckTemplateEntry 接口、ACK_TEMPLATE_POOL Map 等复杂结构

export const ACK_TEMPLATES = {
  pre_route:  ["收到，看下", "稍等", "收到", "在", "好", "马上看"],
  reply:      ["想一下", "稍等我回你", "在想", "马上", "收到，组织下", "让我想想"],
  delegate:   ["收到，开始处理", "好的，处理中", "在跑了", "开工", "这就安排", "着手处理中"],
  observe:    ["看下情况", "查一下", "在看了", "扫一眼", "检查中", "在查了"],
  queued:     ["排队中，稍等", "前面有任务在跑", "等一下马上到"],
  blocked:    ["卡了，需要点信息", "处理受阻：{reason}", "遇到点问题"],
  stale:      ["还在跑，稍等", "还没好，再等等", "处理中..."],
  timeout:    ["超时了，要继续吗？", "跑的时间有点长，要不要停掉？"],
} as const;

export type AckStageKey = keyof typeof ACK_TEMPLATES;

export function pickAckText(stage: AckStageKey, vars?: Record<string, string>): string {
  const pool = ACK_TEMPLATES[stage] as readonly string[];
  const text = pool[Math.floor(Math.random() * pool.length)];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

// 向后兼容 export（供旧代码过渡，后续可删）
export const AckStage = {
  PreRouteSoftAck: "pre_route",
  DelegateStarted: "delegate",
  ObserveStarted: "observe",
  ReplySoftAck: "reply",
  Queued: "queued",
  Blocked: "blocked",
  ProgressNudge: "stale",
  ToolStillWorking: "stale",
  ToolComplexTask: "stale",
  ToolAskContinue: "timeout",
  ToolSuggestStop: "timeout",
} as const;

export type AckStageType = typeof AckStage[keyof typeof AckStage];

export function ackStageText(stage: string, vars?: Record<string, string>): string {
  const mapped = Object.values(AckStage).includes(stage as AckStageType)
    ? stage as AckStageKey
    : "stale";
  return pickAckText(mapped as AckStageKey, vars);
}

// selectAckTemplate 向后兼容（调用 pickAckText）
export function selectAckTemplate(stage: string, _inputs?: unknown): { text: string } | null {
  const text = ackStageText(stage);
  return text ? { text } : null;
}
```

> **重要**：保留 `AckStage`、`ackStageText`、`selectAckTemplate` 的导出，因为 `ack-guard.ts` 里有调用。这些是向后兼容的 shim，之后可以逐步去掉。

---

#### 步骤 3：删除 ack-template-registry.ts

删除整个文件。先用 `grep -r "ack-template-registry" --include="*.ts"` 找到所有 import，将它们改为从 `ack-templates.ts` import 对应的函数（用步骤 2 的 `selectAckTemplate` 和 `pickAckText` 替代）。

---

#### 步骤 4：ack-timing.ts 新增按路由的 tier 配置

在 `ack-timing.ts` 里新增（不修改现有函数）：

```typescript
import type { AckRoutePhase } from "./ack-decision.js";

/**
 * 根据路由阶段返回 tier1/2/3 的延迟。
 * delegate/observe 路由下禁用（返回 0），进度通知由 execution transitions 负责。
 * reply/pre_route 保留，用于主 agent 直接回答时的"还在想"提示。
 */
export function getAckTierDelays(routePhase: AckRoutePhase): [number, number, number] {
  if (routePhase === "delegate" || routePhase === "observe") {
    return [0, 0, 0];
  }
  return [DEFAULT_TIER_DELAYS_MS[0], DEFAULT_TIER_DELAYS_MS[1], DEFAULT_TIER_DELAYS_MS[2]];
}
```

然后在 `ack-guard.ts` 里找到 `createAckTimers` 的调用，改为使用 `getAckTierDelays(routePhase)` 的返回值作为延迟配置，而不是硬编码的 `DEFAULT_TIER_DELAYS_MS`。

---

#### 步骤 5：修复 execution-transition-notifier.ts 的 no_valid_thread_anchor

找到 L377-398 的判断逻辑，删除 `!hasValidThreadAnchor` 的 skip 分支：

```typescript
// 改前（删掉这段）：
if (!hasValidTarget || !hasValidThreadAnchor) {
  const reason = !hasValidTarget ? "no_valid_target" : "no_valid_thread_anchor";
  // ... 记录 replay 并 return skipped
}

// 改后（只检查 target，anchor 缺失时发 top-level 消息）：
if (!hasValidTarget) {
  // 没有 target 才真的无法发
  return { sent: false, skipped: true, reason: "no_valid_target", ... };
}
// hasValidThreadAnchor 为 false 时：replyToMessageId 为 undefined，发 top-level 消息
```

同时，将 `sendExecutionTransitionDirect` 函数**改为调用** `sendIMMessage`（来自步骤 1）。删除 `sendExecutionTransitionDirect` 内部的 `runCommand("openclaw", ...)` 实现（约 50 行）。

---

#### 步骤 6：ack-guard.ts 的 sendAckDirectDetailed 改调统一函数

找到 `sendAckDirectDetailed` 函数（L444-547），保留函数签名和返回类型，内部改为：

```typescript
async function sendAckDirectDetailed(
  sessionKey: string,
  message: string,
  cwd?: string,
  options: UnknownRecord = {},
): Promise<AckSendResult> {
  const replyToMessageId = asString(options.replyToMessageId) || undefined;
  const result = await sendIMMessage({
    sessionKey,
    message,
    replyToMessageId,
    timeoutMs: Math.max(500, Number(options.timeoutMs || 5000)),
    cwd: asString(cwd) || resolveWorkspaceRoot(),
  });

  const resolved = resolveAckTargetFromSessionKey(sessionKey);
  return {
    attempted: true,
    delivered: result.sent,
    sent: result.sent,
    error: result.error || "",
    reason: result.sent ? "channel_message_sent" : "channel_message_failed",
    ack_target_resolution_state: resolved.target ? "resolved" : "target_resolution_failed",
    ack_delivery_state: result.sent ? "sent" : "failed",
    target: resolved.target,
    threadId: result.threadTs || "",
  };
}
```

> 保留 `AckSendResult` 接口和 `sendAckDirectDetailed` 的返回格式不变，只替换内部实现。

---

**验收标准 P1-T7**：

- [ ] `pnpm --filter @octoclaw/runtime run build` 通过
- [ ] `pnpm test` 没有新增失败
- [ ] `ack-template-registry.ts` 文件不存在
- [ ] `ack-templates.ts` 行数 ≤ 80 行
- [ ] `ack-templates.ts` 不再包含 `AckTemplateEntry`、`ACK_TEMPLATE_POOL`、`buildTemplateEntry` 等旧结构
- [ ] `execution-transition-notifier.ts` 里不再有 `no_valid_thread_anchor` → skip 的逻辑（改为发 top-level 消息）
- [ ] `ack-guard.ts` 里的 `sendAckDirectDetailed` 不再包含 `runCommand("openclaw", ...)` 的 HTTP/CLI 实现
- [ ] `execution-transition-notifier.ts` 里不再包含 `runCommand("openclaw", ...)` 的发送实现
- [ ] delegate 路由下，timer 系统的 tier1/2/3 不再触发（`getAckTierDelays("delegate")` 返回 `[0,0,0]`）
- [ ] reply 路由下，tier1/2/3 仍然正常工作（18s/45s/120s）
- [ ] `im/send.ts` 存在且 `sendIMMessage` 可导出

**绝对不能做**：
- 不能删除 `AckStage`、`ackStageText`、`selectAckTemplate` 的导出（向后兼容，ack-guard.ts 有调用）
- 不能修改 `sendReactionAckDetailed` 函数（emoji reaction 逻辑与文字 ACK 不同，保持不变）
- 不能删除 execution-transition-notifier.ts 的 `emitExecutionTransitionNotification` 函数（`child-finalizer.ts` 等有调用）
- 不能修改 `detectExecutionTransition` 函数（状态机检测逻辑保持不变）
- 不能改变 ACK tier 对 reply 路由的行为（reply 路由下 tier1/2/3 必须仍然工作）

---

### P1-T8：replay-logger.ts 拆分——从 God File 到职责清晰的 4 个文件

**目标**：把 1715 行、5 种职责的 God File 拆成职责单一的小文件，删除被 completion protocol 取代的 delivery relay 代码（约 350 行）。

**涉及文件**：
- 新建：`extensions/octoclaw-runtime/src/receipt.ts`
- 新建：`extensions/octoclaw-runtime/src/replay/replay.ts`
- 新建：`extensions/octoclaw-runtime/src/replay/message-guard.ts`
- 新建：`extensions/octoclaw-runtime/src/replay/policy-utils.ts`
- 删除内容：`replay-logger.ts` 中 L830-1185 的 delivery relay 部分
- 最终：`replay-logger.ts` 变成只 re-export 其他文件（约 20 行）或完全删除

---

#### 步骤 1：确认 delivery relay 是否可删除

先运行：

```bash
grep -rn "registerPendingDelivery\|reconcilePendingDeliveriesForSession\|recordDeliveryRelayEvent\|hasDeliveryRelayEvent\|deliveryRelayEnabled\|shouldRegisterPendingDelivery\|resolveDeliveryRelaySettings\|deliveryIdFor" \
  extensions/ packages/ --include="*.ts" | grep -v "replay-logger.ts" | grep -v ".test."
```

如果结果只有：
- `extension-entry.ts` 里的 `registerPendingDelivery` 和 `recordDeliveryRelayEvent` 调用
- `ack-route-commit.ts` 里的 `deliveryRelayEnabled` 调用

则这些调用可以一起删除（在 P0-T1 实施后，delivery 由 `delivery-outbox.ts` 负责，delivery relay 的功能被完全取代）。**删除前确保 P0-T1 已完成且通过验收**。

---

#### 步骤 2：新建 receipt.ts

把 `replay-logger.ts` L45-487（`TurnExecutionReceipt` 接口和 `buildTurnExecutionReceipt` 函数）移到 `extensions/octoclaw-runtime/src/receipt.ts`：

```typescript
// extensions/octoclaw-runtime/src/receipt.ts
// TurnExecutionReceipt — 执行回执类型和构建函数
// 这是 execution coverage 的主要来源，不是 replay 日志

export interface TurnExecutionReceipt {
  turnId: string;
  sessionKey: string;
  route: string;
  // ... （完整保留原有字段）
}

export function buildTurnExecutionReceipt(
  state: PolicyContextState,
  durationMs: number,
  completedAt?: number,
): TurnExecutionReceipt {
  // ... （完整保留原有实现）
}
```

---

#### 步骤 3：新建 replay/replay.ts

把 `replay-logger.ts` L517-695（`appendJsonl`、`recordPolicyReplay`、`recordAckReplay`、`buildPolicyResolvedReplayPayload`、`buildPolicyJudgedReplayPayload`、`buildRouteValidatedReplayPayload`）移到 `extensions/octoclaw-runtime/src/replay/replay.ts`：

```typescript
// extensions/octoclaw-runtime/src/replay/replay.ts
// 写 replay log JSONL 文件的函数
// 这些函数是 observability 旁路，不在 live path 里，全部 async fire-and-forget

export async function appendJsonl(pathname: string, payload: Record<string, unknown>): Promise<void> { ... }
export async function recordPolicyReplay(event: string, payload: Record<string, unknown>, logger?: LoggerLike, decision?: Record<string, unknown>): Promise<void> { ... }
// ...
```

**关键改动**：把 `recordPolicyReplay` 和其他 record 函数改为 **async fire-and-forget**（调用方不 await，失败不影响主流程）：

```typescript
// 改前（extension-entry.ts 里的调用）：
await recordPolicyReplay("policy_resolved", payload, logger, decision);

// 改后（不 await，fire-and-forget）：
void recordPolicyReplay("policy_resolved", payload, logger, decision).catch(() => {});
// 或者 replay.ts 内部本身就是 fire-and-forget，外部调用不需要 await
```

---

#### 步骤 4：新建 replay/message-guard.ts

把 `replay-logger.ts` L1187-1505（`assistantMessageText`、`assistantMessageRole`、`guardAssistantMessageForPolicyState`、`delegationFailureReply`、`sanitizeDelegationReasoning`、`looksLikeGenericGreeting` 等消息处理函数）移到 `extensions/octoclaw-runtime/src/replay/message-guard.ts`。

这些函数和 replay 没有关系，它们是在 `before_message_write` hook 里对消息内容进行清洗。新文件名清楚地表达了职责。

---

#### 步骤 5：新建 replay/policy-utils.ts

把 `replay-logger.ts` L1507-1715（`preHintAllowedTools`、`observerControlTools`、`sessionControlTools`、`workflowEnforcementRule`、`isDelegatedRoute`、`routeHintRequired`、`compactPolicyPrompt`、`matchesBlockedPattern` 等 policy 工具函数）移到 `extensions/octoclaw-runtime/src/replay/policy-utils.ts`。

这些函数是 policy 判断的工具函数，和 replay logging 没有关系。

---

#### 步骤 6：更新 replay-logger.ts 为 re-export shim

所有代码移走后，`replay-logger.ts` 改为 re-export（向后兼容，现有 import 不需要修改）：

```typescript
// extensions/octoclaw-runtime/src/replay/replay-logger.ts
// Backward-compatible re-exports. Import from specific files for new code.

export type { TurnExecutionReceipt } from "../receipt.js";
export { buildTurnExecutionReceipt, emitResultReadyIfTransition } from "../receipt.js";
export { appendJsonl, recordPolicyReplay, recordAckReplay, recordDispatchLifecycleReplayEvents,
  buildPolicyResolvedReplayPayload, buildPolicyJudgedReplayPayload, buildRouteValidatedReplayPayload,
  recordDeliveryRelayEvent, recordObservedDeliveryFromMessage } from "./replay.js";
export { assistantMessageRole, assistantMessageText, replaceAssistantMessageText,
  guardAssistantMessageForPolicyState, delegationFailureReply, contaminationFallbackReply,
  sanitizeDelegationReasoning, looksLikeGenericGreeting, claimedDirectToolNames,
  looksLikeToolProvenanceClaim, ungroundedToolProvenanceReply,
  stripStaleDelegateFailureProjection, genericGreetingFallbackReply } from "./message-guard.js";
export { preHintAllowedTools, observerControlTools, sessionControlTools, runnerWorkflowTools,
  workflowEnforcementRule, isControlObserverDecision, isSessionControlDecision,
  isDelegatedRoute, routeHintRequired, shouldRetainPolicyStateOnAgentEnd,
  compactPolicyPrompt, policySummaryText, stringifyParamsForPolicy,
  matchesBlockedPattern, runtimeSwitches, buildRolloutFlags } from "./policy-utils.js";
// delivery relay 相关 export 已删除（被 delivery-outbox.ts 取代）
```

---

**验收标准 P1-T8**：
- [ ] `pnpm --filter @octoclaw/runtime run build` 通过
- [ ] `pnpm test` 没有新增失败
- [ ] `receipt.ts` 存在，包含 `TurnExecutionReceipt` 和 `buildTurnExecutionReceipt`
- [ ] `replay/message-guard.ts` 存在，包含 `guardAssistantMessageForPolicyState`
- [ ] `replay/policy-utils.ts` 存在，包含 `workflowEnforcementRule`
- [ ] `replay-logger.ts` 行数 ≤ 30 行（只有 re-exports）
- [ ] `registerPendingDelivery`、`reconcilePendingDeliveriesForSession` 不再在 codebase 里（如果 P0-T1 已完成）
- [ ] `recordPolicyReplay` 的调用在 `extension-entry.ts` 里改为 fire-and-forget（不 await）

**绝对不能做**：
- 不能改变任何 export 的函数签名（向后兼容）
- 不能删除 `replay-logger.ts`（其他文件还 import 它）
- 不能改变 `guardAssistantMessageForPolicyState` 的逻辑（只是移动位置）
- 如果 P0-T1 未完成，不能删除 delivery relay 相关函数

---

## P2 任务（P1 全部完成后再做）

---

### P2-T9：合并幽灵包——octoclaw-fast-reply 和 octoclaw-delegation 内联

**目标**：把两个只被 `runtime-payloads.ts` 内部使用的包合并进 `octoclaw-runtime`，删除两套独立的 package.json / tsconfig / build 步骤。

**涉及文件**：
- 新建目录：`extensions/octoclaw-runtime/src/payloads/fast-reply/`
- 新建目录：`extensions/octoclaw-runtime/src/payloads/delegation/`
- 修改：`extensions/octoclaw-runtime/src/runtime-payloads.ts`
- 修改：`pnpm-workspace.yaml`
- 删除：`extensions/octoclaw-fast-reply/` 整个目录
- 删除：`extensions/octoclaw-delegation/` 整个目录

---

#### 步骤 1：移动代码

把 `octoclaw-fast-reply/src/` 下的所有 `.ts` 文件（不含 `.test.ts`）复制到 `extensions/octoclaw-runtime/src/payloads/fast-reply/`。

把 `octoclaw-delegation/src/` 下的所有 `.ts` 文件（不含 `.test.ts`）复制到 `extensions/octoclaw-runtime/src/payloads/delegation/`。

**测试文件也一起带过来**，它们放在对应的 `__tests__/` 或同名 `.test.ts`。

---

#### 步骤 2：修改 runtime-payloads.ts 的 import

```typescript
// 改前
import { buildCompoundDelegationPlaceholder, materializeDelegatedWork } from "@octoclaw/delegation";
import { buildFastReplyAck, buildDirectReply, buildDirectReplyContext } from "@octoclaw/fast-reply";

// 改后
import { buildCompoundDelegationPlaceholder, materializeDelegatedWork } from "./payloads/delegation/index.js";
import { buildFastReplyAck, buildDirectReply, buildDirectReplyContext } from "./payloads/fast-reply/index.js";
```

---

#### 步骤 3：清理 pnpm workspace

从 `pnpm-workspace.yaml` 删除：
```yaml
# 删除这两行
- "extensions/octoclaw-fast-reply"
- "extensions/octoclaw-delegation"
```

运行 `pnpm install` 确认依赖图更新。

---

#### 步骤 4：删除旧目录

```bash
rm -rf extensions/octoclaw-fast-reply
rm -rf extensions/octoclaw-delegation
```

---

**验收标准 P2-T9**：
- [ ] `pnpm --filter @octoclaw/runtime run build` 通过
- [ ] `pnpm test` 没有新增失败（原 fast-reply 和 delegation 的测试现在在 runtime 里跑）
- [ ] `extensions/octoclaw-fast-reply/` 目录不存在
- [ ] `extensions/octoclaw-delegation/` 目录不存在
- [ ] `pnpm-workspace.yaml` 里不再有这两个包
- [ ] `runtime-payloads.ts` 的 import 改为相对路径
- [ ] 7 个 build 步骤减少为 5 个

**绝对不能做**：
- 不能修改移过来的函数逻辑（只是搬家，不做代码改动）
- 不能删除测试文件

---

### P2-T10：插件开关 + `openclaw.plugin.json` 配置清理

**目标**：让 OctoClaw 可以通过配置快速关闭而不卸载；清理 configSchema 里的废弃字段。

**涉及文件**：
- 修改：`extensions/octoclaw-runtime/src/extension-entry.ts`（加 enabled 检查）
- 修改：`extensions/octoclaw-runtime/openclaw.plugin.json`（更新 configSchema）

---

#### 步骤 1：extension-entry.ts 加 enabled 检查

找到 `plugin.register(pi: PluginInterface)` 函数（约 L681），在函数体第一行加：

```typescript
register(pi: PluginInterface): void {
  // 插件开关 — enabled=false 时不注册任何 hook
  if (pi.pluginConfig?.enabled === false) {
    pi.logger?.info?.("octoclaw-runtime: disabled via config (enabled=false), skipping hook registration");
    return;
  }

  // ... 原有的所有注册逻辑
  envOverrides.octoclawRoot = stringValue(pi.pluginConfig?.octoclawRoot);
  // ...
}
```

---

#### 步骤 2：更新 openclaw.plugin.json 的 configSchema

用以下内容**完整替换** configSchema 的 properties 部分（删除 remoteJudge 相关、timeoutLocalMs、local 字段，加入 enabled）：

```json
{
  "id": "octoclaw-runtime",
  "name": "OctoClaw Runtime",
  "description": "Runtime policy hooks, dispatch tools, and replay logging for OctoClaw",
  "version": "0.3.0",
  "main": "./dist/extension-entry.js",
  "extensions": ["./dist/extension-entry.js"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true,
        "description": "Enable or disable OctoClaw. Set false to disable all hooks without uninstalling."
      },
      "octoclawRoot": {
        "type": "string",
        "minLength": 1,
        "description": "Override OCTOCLAW_ROOT path"
      },
      "workspaceRoot": {
        "type": "string",
        "minLength": 1,
        "description": "Override WORKSPACE_ROOT path"
      },
      "delegationEnabled": {
        "type": "boolean",
        "default": true,
        "description": "Enable delegation routing. When false, all requests route to reply."
      },
      "judgeFast": {
        "type": "object",
        "description": "LLM semantic routing judge (optional, any OpenAI-compatible endpoint)",
        "properties": {
          "enabled": { "type": "boolean", "default": false },
          "shadowMode": { "type": "boolean", "default": false,
            "description": "Log judge decisions but don't apply them. Safe for testing." },
          "modelId": { "type": "string", "minLength": 1,
            "description": "Model ID, e.g. 'llama-3.1-8b-instant' or 'qwen2.5:3b'" },
          "baseUrl": { "type": "string", "minLength": 1,
            "description": "OpenAI-compatible endpoint, e.g. Groq or local Ollama" },
          "apiKey": { "type": "string", "default": "" },
          "timeoutMs": { "type": "number", "minimum": 500, "default": 1200,
            "description": "Judge call timeout in ms. 800ms recommended for local Ollama." },
          "minConfidence": { "type": "number", "minimum": 0, "maximum": 1, "default": 0.6,
            "description": "Minimum confidence to use judge result. Below this, falls back to main agent." },
          "judgeAckEnabled": { "type": "boolean", "default": true,
            "description": "Use judge-generated ack_text for the initial ACK message." }
        },
        "required": ["modelId", "baseUrl"],
        "additionalProperties": false
      }
    }
  }
}
```

**关键**：删除了 `ackTimerFirstTierMs`、`ackTimerTierCount`（现在由 `getAckTierDelays` 自动管理）、以及所有 remoteJudge 相关字段。

---

**验收标准 P2-T10**：
- [ ] `pnpm --filter @octoclaw/runtime run build` 通过
- [ ] `pnpm test` 没有新增失败
- [ ] 把 pluginConfig 的 `enabled` 设为 `false` 时，`register()` 函数直接 return，不注册任何 hook
- [ ] `openclaw.plugin.json` 不再包含 `remoteJudge`、`timeoutLocalMs`、`local`、`ackTimerFirstTierMs`、`ackTimerTierCount`
- [ ] `openclaw.plugin.json` 包含 `enabled` 字段，`default: true`
- [ ] `judgeFast` 的 configSchema 只有 7 个字段（enabled, shadowMode, modelId, baseUrl, apiKey, timeoutMs, minConfidence, judgeAckEnabled）

**绝对不能做**：
- 不能删除 `delegationEnabled` 字段（现有用户可能配置了这个）
- 不能修改 hook 注册逻辑本身（只是在 register 开头加 enabled 检查）

---

### P2-T11：octoclawctl 统一——合并两个安装工具

**目标**：把 `tools/install` 和 `tools/manage` 合并为 `tools/octoclawctl`，单一 CLI，统一配置文件，去掉 macOS 专属 launchctl 代码。

**涉及文件**：
- 新建：`tools/octoclawctl/src/cli.ts`（命令路由）
- 新建：`tools/octoclawctl/src/install.ts`（install/update/deploy 逻辑）
- 新建：`tools/octoclawctl/src/config.ts`（配置读写）
- 新建：`tools/octoclawctl/src/manage.ts`（enable/disable/status/restart）
- 新建：`tools/octoclawctl/src/platform.ts`（平台抽象，替代 launchctl）
- 新建：`tools/octoclawctl/package.json`
- 新建：`tools/octoclawctl/tsconfig.json`
- 保留但标为 deprecated：`tools/install/`、`tools/manage/`（向后兼容，内部 forward 到 octoclawctl）

---

#### 步骤 1：新建 tools/octoclawctl/src/platform.ts

这个文件抽象掉 macOS launchctl 和 Linux systemd 的差异：

```typescript
// tools/octoclawctl/src/platform.ts

export interface ServiceRestartResult {
  success: boolean;
  error?: string;
}

export async function restartOpenClawGateway(openclawHome: string): Promise<ServiceRestartResult> {
  // 尝试 1: openclaw gateway restart（最优先）
  const r1 = await tryRun("openclaw", ["gateway", "restart"]);
  if (r1.success) return r1;

  // 尝试 2: macOS launchctl kickstart
  if (process.platform === "darwin") {
    const uid = await captureOutput("id", ["-u"]);
    const r2 = await tryRun("launchctl", ["kickstart", "-k", `gui/${uid}/ai.openclaw.gateway`]);
    if (r2.success) return r2;
  }

  // 尝试 3: systemctl (Linux)
  if (process.platform === "linux") {
    const r3 = await tryRun("systemctl", ["--user", "restart", "openclaw-gateway"]);
    if (r3.success) return r3;
  }

  return { success: false, error: "Unable to restart OpenClaw gateway on this platform" };
}

export async function restartOpenClawNode(openclawHome: string): Promise<ServiceRestartResult> {
  // 同上，换成 node service
}

async function tryRun(cmd: string, args: string[]): Promise<ServiceRestartResult> {
  // spawn + wait，返回 success/error
}

async function captureOutput(cmd: string, args: string[]): Promise<string> {
  // spawn + capture stdout
}
```

---

#### 步骤 2：新建 tools/octoclawctl/src/config.ts

统一配置文件的读写：

```typescript
// tools/octoclawctl/src/config.ts

export interface OctoclawConfig {
  _version: "1";
  _updatedAt: string;
  enabled: boolean;
  features: {
    delegation: boolean;
    imNotifications: boolean;
    statusPanel: boolean;
  };
  judge: {
    enabled: boolean;
    modelId: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    minConfidence: number;
    shadowMode: boolean;
    judgeAckEnabled: boolean;
  };
  models: {
    mode: "auto" | "custom";
    overrides: Record<string, string>;
  };
}

export function defaultConfig(): OctoclawConfig { /* ... */ }

export async function readConfig(openclawHome: string): Promise<OctoclawConfig> {
  const path = configPath(openclawHome);
  // 读取，不存在则返回 defaultConfig()
}

export async function writeConfig(openclawHome: string, config: OctoclawConfig): Promise<void> { /* ... */ }

export async function setConfigField(openclawHome: string, key: string, value: string): Promise<void> {
  // 支持 "judge.modelId" 这样的点号路径
  const config = await readConfig(openclawHome);
  setNestedField(config, key.split("."), value);
  await writeConfig(openclawHome, config);
}

function configPath(openclawHome: string): string {
  return path.join(openclawHome, "..", ".octoclaw", "config.json");
}

// 把 OctoclawConfig 同步到 OpenClaw 的 extension pluginConfig
export async function syncToOpenClawPluginConfig(openclawHome: string, config: OctoclawConfig): Promise<void> {
  // 读取 OpenClaw 的 extension 配置
  // 把 OctoclawConfig 映射到 openclaw.plugin.json 的 pluginConfig 字段
  // 写回
}
```

---

#### 步骤 3：新建 tools/octoclawctl/src/install.ts

合并 `tools/install/src/index.ts` 和 `tools/manage/src/index.ts` 的核心逻辑：

```typescript
// tools/octoclawctl/src/install.ts

// 从 tools/install 迁移的核心函数：
export async function deployPackages(octoclawRoot: string, openclawHome: string): Promise<void> { ... }
export async function deployExtension(octoclawRoot: string, openclawHome: string): Promise<void> { ... }
export async function setupSymlinks(openclawHome: string): Promise<void> { ... }
export async function validateLoad(openclawHome: string): Promise<void> { ... }

// 从 tools/manage 迁移的核心函数：
export async function cloneOrUpdate(octoclawRoot: string, repoUrl: string, branch: string): Promise<void> { ... }
export async function buildWorkspace(octoclawRoot: string): Promise<void> { ... }

// 删除 syncJudgeFastEnv（launchctl 专属）— 不再需要，judge 配置通过 pluginConfig 传递
// 删除 injectAgentsMd 相关（AGENTS.md 注入改为可选）
```

---

#### 步骤 4：新建 tools/octoclawctl/src/manage.ts

```typescript
// tools/octoclawctl/src/manage.ts

export async function enablePlugin(openclawHome: string): Promise<void> {
  const config = await readConfig(openclawHome);
  config.enabled = true;
  await writeConfig(openclawHome, config);
  await syncToOpenClawPluginConfig(openclawHome, config);
  await restartOpenClawGateway(openclawHome);
  await restartOpenClawNode(openclawHome);
  console.log("✅ OctoClaw enabled and OpenClaw restarted");
}

export async function disablePlugin(openclawHome: string): Promise<void> {
  const config = await readConfig(openclawHome);
  config.enabled = false;
  await writeConfig(openclawHome, config);
  await syncToOpenClawPluginConfig(openclawHome, config);
  await restartOpenClawGateway(openclawHome);
  await restartOpenClawNode(openclawHome);
  console.log("✅ OctoClaw disabled and OpenClaw restarted (install preserved)");
}

export async function showStatus(openclawHome: string): Promise<void> {
  const config = await readConfig(openclawHome);
  const manifest = readSourceManifest(openclawHome);
  console.log([
    `enabled: ${config.enabled}`,
    `version: ${manifest?.commit ?? "unknown"} (${manifest?.branch ?? "?"})`,
    `installed_at: ${manifest?.installedAt ?? "unknown"}`,
    `judge: ${config.judge.enabled ? `enabled (${config.judge.modelId})` : "disabled"}`,
    `delegation: ${config.features.delegation}`,
    `im_notifications: ${config.features.imNotifications}`,
  ].join("\n"));
}
```

---

#### 步骤 5：新建 tools/octoclawctl/src/cli.ts

```typescript
// tools/octoclawctl/src/cli.ts

const commands = {
  install: "首次安装（clone + build + deploy + configure）",
  update:  "拉最新代码并重新部署",
  deploy:  "仅重新部署（开发者，不 pull）",
  status:  "查看安装状态和配置摘要",
  enable:  "启用插件",
  disable: "禁用插件（保留安装）",
  config:  "配置管理（config set key value / config get）",
  restart: "重启 OpenClaw 服务",
  uninstall: "卸载",
};
```

---

#### 步骤 6：删除 macOS 专属的 `syncJudgeFastEnv`

在合并后的 `install.ts` 里，**不包含** 原来 `tools/install/src/index.ts:675-688` 的 `syncJudgeFastEnv` 函数。

Judge 配置现在通过 `config.ts` 的 `syncToOpenClawPluginConfig` 传递，不依赖 `launchctl setenv`。

---

**验收标准 P2-T11**：
- [ ] `tools/octoclawctl/` 目录存在，有 `package.json` 和 `tsconfig.json`
- [ ] `pnpm --filter octoclawctl run build` 通过
- [ ] `pnpm --filter octoclawctl run test` 通过
- [ ] `node tools/octoclawctl/dist/cli.js --help` 显示命令列表
- [ ] `node tools/octoclawctl/dist/cli.js status` 可以正常运行并输出状态
- [ ] `octoclawctl enable` 修改 pluginConfig `enabled: true` 并重启
- [ ] `octoclawctl disable` 修改 pluginConfig `enabled: false` 并重启
- [ ] `tools/octoclawctl/src/` 不包含任何 `launchctl setenv` 调用
- [ ] `tools/octoclawctl/src/platform.ts` 的 restartService 支持 macOS 和 Linux
- [ ] `~/.octoclaw/config.json` 文件可被正确读写

**绝对不能做**：
- 不能直接删除 `tools/install/` 和 `tools/manage/`（可以保留但 forward 到 octoclawctl，或者加 deprecation notice）
- 不能引入任何新的 OpenClaw 内部 API 依赖（只用 `openclaw` CLI 命令）
- 不能修改 extension 的运行时逻辑（只改安装/配置工具）

---

## Quick-fix 任务（不依赖 P0/P1，可随时做）

这些任务相互独立，可以任意顺序完成，每个都很小。

---

### QF-1：修复 "lost" 状态映射到 "queued"

**文件**：`extensions/octoclaw-runtime/src/work-contract/materializer.ts`  
**行数**：L40-59，`mapSubstrateToContractStatus` 函数

**改动**：在 `switch` 语句的 `case "cancelled":` 后面、`default:` 前面，加一行：

```typescript
case "lost": return "failed";
```

**验收**：`pnpm test` 通过，`lost` 状态在 switch 里有明确处理（不走 default）。

---

### QF-2：ACK 时间常量去重

**文件**：`extensions/octoclaw-runtime/src/ack/ack-decision.ts` 和 `ack-timing.ts`

**步骤**：
1. 在 `ack-timing.ts` 里，确认 `DEFAULT_TIER_DELAYS_MS = [18_000, 45_000, 120_000, 0]` 的定义在
2. 在 `ack-decision.ts` 里，删除 `ACK_TIMING` 常量的本地定义（L42-49）
3. 在 `ack-decision.ts` 顶部 import `DEFAULT_TIER_DELAYS_MS` from `"./ack-timing.js"`
4. 把 `ack-decision.ts` 里原来用 `ACK_TIMING.tier1_ms` 等的地方改为用 `DEFAULT_TIER_DELAYS_MS[1]` 等

**验收**：`pnpm test` 通过；`ack-decision.ts` 里不再有独立定义的 `tier1_ms: 18000` 这类常量。

---

### QF-3：delegate-packets.ts 消除 runtime throw

**文件**：`extensions/octoclaw-runtime/src/context/delegate-packets.ts`  
**行数**：L69-72

**现状**：
```typescript
if (input.relevantExcerpts && input.relevantExcerpts.length > 0 && !input.contextEscalationReason) {
  throw new Error("context_escalation_reason_required");
}
```

**改法**：将 `BuildDelegateHandoffPacketInput` 接口里的 `contextEscalationReason` 改为**必填**（去掉 `?`）：

```typescript
// 改前
contextEscalationReason?: ContextEscalationReason;

// 改后
contextEscalationReason: ContextEscalationReason | null;
```

然后删除那三行 runtime throw。所有调用 `buildDelegateHandoffPacket` 的地方如果原来没传 `contextEscalationReason`，需要显式传 `null`。

**验收**：`pnpm --filter @octoclaw/runtime run build` 通过（TypeScript 在编译期强制而非运行时）；删除了那三行 `throw`。

---

### QF-4：PolicyStateStore entries() 方法

（此 QF 是 P1-T6 的前置依赖，但可以提前单独做）

**文件**：`extensions/octoclaw-runtime/src/state/policy-state.ts`

**问题所在**（L494-496）：
```typescript
entries: () => {
  return Array.from((store as unknown as { entries: Map<string, PolicyStateEntry> }).entries.entries())
    .map(([key, state]) => ({ key, state: { ...state } }));
},
```

**改法**：

1. 将 `PolicyStateStore` 里的私有成员 `private readonly entries = new Map<string, PolicyStateEntry>()` 改名为 `private readonly _entries = new Map<string, PolicyStateEntry>()`（所有对 `this.entries` 的引用改为 `this._entries`）

2. 新增 public 方法：
```typescript
public getEntries(): Array<[string, PolicyStateEntry]> {
  return Array.from(this._entries.entries());
}
```

3. `createPolicyStateStore` 的 wrapper 里改为：
```typescript
entries: () => store.getEntries().map(([key, state]) => ({ key, state: { ...state } })),
```

**验收**：`pnpm test` 通过；`PolicyStateStore` 里的 `entries` 成员改名为 `_entries`；不再有 `as unknown as` type cast 访问内部 entries。

---

### QF-5：调整 ACK tier 时间——收紧等待时长

**文件**：
- `extensions/octoclaw-runtime/src/ack/ack-decision.ts`（`ACK_TIMING` 常量）
- `extensions/octoclaw-runtime/src/ack/ack-timing.ts`（`DEFAULT_TIER_DELAYS_MS` 常量）

**问题**：现有 tier 时间偏长，用户等待体验差：
- reaction_ack 1000ms → Slack 里 1 秒才加 emoji，稍慢
- tier1 18s → 18 秒没回复用户已经很焦虑
- tier2 45s、tier3 120s 同理

**注意**：QF-2 要求先完成（`ACK_TIMING` 常量要从 `ack-timing.ts` import），此任务在 QF-2 完成后做，或合并成一次改动。

**改法**：

`ack-timing.ts` 中将 `DEFAULT_TIER_DELAYS_MS` 改为：
```typescript
// 改前
export const DEFAULT_TIER_DELAYS_MS: [number, number, number, number] = [18_000, 45_000, 120_000, 0];

// 改后
export const DEFAULT_TIER_DELAYS_MS: [number, number, number, number] = [12_000, 30_000, 90_000, 0];
```

`ack-decision.ts` 中将 `ACK_TIMING` 改为（QF-2 完成前的临时状态，QF-2 完成后这里改为 import）：
```typescript
// 改前
export const ACK_TIMING = {
  reaction_ack_ms: 1000,
  text_ack0_ms: 3000,
  ack0_hard_ceiling_ms: 5000,
  tier1_ms: 18000,
  tier2_ms: 45000,
  tier3_ms: 120000,
} as const;

// 改后
export const ACK_TIMING = {
  reaction_ack_ms: 800,    // 稍快，即时感更强
  text_ack0_ms: 2500,      // 轻微收紧
  ack0_hard_ceiling_ms: 5000,
  tier1_ms: 12000,         // 12s 没回复就 nudge
  tier2_ms: 30000,         // 30s
  tier3_ms: 90000,         // 1.5min 后再问
} as const;
```

**验收**：`pnpm test` 通过（注意有 ACK timing 相关的测试，确认没有新增失败）；`DEFAULT_TIER_DELAYS_MS` 值为 `[12_000, 30_000, 90_000, 0]`。

---

### QF-6：Reaction ACK emoji 配置从 judgeFast 解耦

**文件**：
- `extensions/octoclaw-runtime/openclaw.plugin.json`（configSchema 里新增顶层字段）
- `extensions/octoclaw-runtime/src/extension-entry.ts`（读取新字段）

**问题**：`reactionAckEnabled` 目前从 `judgeFast.ackReactionEmoji` 读取，与 judge 配置耦合。没配 judge 就永远无法启用 reaction ACK，而这两者本应是独立的。

**改法**：

`openclaw.plugin.json` 的 `configSchema.properties` 里新增（在 `judgeFast` 的同级别）：
```json
"ackReactionEmoji": {
  "type": "string",
  "default": "",
  "description": "If set, react with this emoji on message receipt (e.g. 'eyes'). Empty to disable. Independent of judge config."
}
```

`extension-entry.ts` 里找到读取 `reactionAckEnabled` 的地方，改为同时检查顶层 `ackReactionEmoji` 和 `judgeFast.ackReactionEmoji`：

```typescript
// 改前（只从 judgeFast 读）
const reactionEmoji = stringValue(judgeFastRaw.ackReactionEmoji);

// 改后（顶层优先，judgeFast 作为 fallback 向后兼容）
const reactionEmoji = stringValue(pi.pluginConfig?.ackReactionEmoji)
  || stringValue(judgeFastRaw.ackReactionEmoji);
const reactionAckEnabled = reactionEmoji.length > 0;
```

**绝对不能做**：不能删除 `judgeFast.ackReactionEmoji` 的读取（向后兼容，已有用户可能这么配的）。

**验收**：
- `pnpm --filter @octoclaw/runtime run build` 通过
- `pnpm test` 无新增失败
- `openclaw.plugin.json` 的 `configSchema.properties` 里有顶层 `ackReactionEmoji` 字段
- `pluginConfig.ackReactionEmoji = "eyes"` 时 `reactionAckEnabled = true`（即使 judgeFast 未配置）

---

完成所有任务后，运行以下检查：

```bash
# 构建所有包
pnpm --filter @octoclaw/contracts run build
pnpm --filter @octoclaw/policy run build
pnpm --filter @octoclaw/runtime-core run build
pnpm --filter @octoclaw/runtime run build

# 运行全量测试
pnpm test

# P0 验证 — 关键字符串已删除
grep -r "task-executor\|TASK_EXECUTOR_ALIASES\|\[\"a\"\]\|\[\"o\"\]\|\[\"f\"\]" extensions/ packages/ --include="*.ts"
# 应无输出

grep -r "DualJudgeConfig\|callRemoteJudge\|shouldEscalate\|remoteJudgeRaw\|_remoteJudgeConfig" extensions/ packages/ --include="*.ts"
# 应无输出

grep -r "readdirSync.*session\|\[OctoClaw Delegated Task\].*finaliz" extensions/ --include="*.ts"
# 应无输出

# P1 验证 — ACK/Progress 清理
grep -r "no_valid_thread_anchor.*skipped" extensions/ --include="*.ts"
# 应无输出

grep -r "ACK_TEMPLATE_POOL\|buildTemplateEntry\|AckTemplateEntry" extensions/ --include="*.ts"
# 应无输出

ls extensions/octoclaw-runtime/src/ack/ack-template-registry.ts 2>/dev/null && echo "ERROR" || echo "OK: deleted"

# P1-T8 验证 — replay-logger 拆分
wc -l extensions/octoclaw-runtime/src/replay/replay-logger.ts
# 应 ≤ 30 行

ls extensions/octoclaw-runtime/src/receipt.ts 2>/dev/null || echo "ERROR: receipt.ts missing"
ls extensions/octoclaw-runtime/src/replay/message-guard.ts 2>/dev/null || echo "ERROR: message-guard.ts missing"
ls extensions/octoclaw-runtime/src/replay/policy-utils.ts 2>/dev/null || echo "ERROR: policy-utils.ts missing"

grep -r "registerPendingDelivery\|reconcilePendingDeliveriesForSession" extensions/ --include="*.ts" | grep -v "replay-logger.ts"
# 应无输出（P0-T1 完成后）

# P2 验证 — 包合并
ls extensions/octoclaw-fast-reply 2>/dev/null && echo "ERROR: still exists" || echo "OK: deleted"
ls extensions/octoclaw-delegation 2>/dev/null && echo "ERROR: still exists" || echo "OK: deleted"

# P2-T10 验证 — 插件开关
grep -n '"enabled"' extensions/octoclaw-runtime/openclaw.plugin.json
# 应有输出

grep -r "launchctl.*setenv.*OCTOCLAW" tools/ --include="*.ts"
# 应无输出

# 关键新增内容存在
grep -r "octoclaw.worker_completion/v1" extensions/ packages/ --include="*.ts" | wc -l
# 应 > 0

grep -r "sendIMMessage" extensions/ --include="*.ts" | wc -l
# 应 > 0 (P1-T7 完成后)

grep -r "enabled === false.*return" extensions/octoclaw-runtime/src/extension-entry.ts
# 应有输出 (P2-T10 完成后)
```

**最终验收**：
- [ ] 全量 build 通过（包数量：P2 完成后应为 4 个，原来 7 个）
- [ ] 全量 test 通过（允许 skip，不允许 fail）
- [ ] 以上 grep 检查全部通过
- [ ] 文件行数变化：
  - `child-finalizer.ts` ≤ 220 行
  - `detached-task-runtime-host.ts` ≤ 80 行
  - `llm-judge.ts` 比原来少 150+ 行
  - `ack-templates.ts` ≤ 80 行
  - `ack-template-registry.ts` 不存在
  - `replay-logger.ts` ≤ 30 行（re-export only）
- [ ] P2 完成后，`pnpm-workspace.yaml` 里的包从 7 个变为 5 个（contracts, policy, runtime-core→合并, runtime, status-surface, octoclawctl）
- [ ] 整体净减少行数 ≥ 1800 行（不含新增文件）

完成所有任务后，运行以下检查：

```bash
# 构建所有包
pnpm --filter @octoclaw/contracts run build
pnpm --filter @octoclaw/policy run build
pnpm --filter @octoclaw/runtime-core run build
pnpm --filter @octoclaw/runtime run build

# 运行全量测试
pnpm test

# 检查关键字符串已删除
grep -r "task-executor\|TASK_EXECUTOR_ALIASES\|\[\"a\"\]\|\[\"o\"\]\|\[\"f\"\]" extensions/ packages/ --include="*.ts"
# 应该无输出

grep -r "DualJudgeConfig\|callRemoteJudge\|shouldEscalate\|remoteJudgeRaw\|_remoteJudgeConfig" extensions/ packages/ --include="*.ts"
# 应该无输出

grep -r "readdirSync.*session\|jsonl.*finaliz\|\[OctoClaw Delegated Task\].*finaliz" extensions/ --include="*.ts"
# 应该无输出（child-finalizer 里不再有文件扫描）

grep -r "no_valid_thread_anchor.*skipped\|skipped.*no_valid_thread_anchor" extensions/ --include="*.ts"
# 应该无输出（该 skip 已修复）

grep -r "ACK_TEMPLATE_POOL\|buildTemplateEntry\|AckTemplateEntry" extensions/ --include="*.ts"
# 应该无输出（旧模板结构已删除）

# 检查 ack-template-registry.ts 已删除
ls extensions/octoclaw-runtime/src/ack/ack-template-registry.ts 2>/dev/null && echo "ERROR: file still exists" || echo "OK: file deleted"

# 检查关键新增内容存在
grep -r "octoclaw.worker_completion/v1" extensions/ packages/ --include="*.ts"
# 应该有输出

grep -r "resolveWorkerCompletionPath" extensions/ --include="*.ts"
# 应该有输出

grep -r "sendIMMessage" extensions/ --include="*.ts"
# 应该有输出（im/send.ts 定义，ack-guard.ts / execution-transition-notifier.ts 调用）

grep -r "getAckTierDelays" extensions/ --include="*.ts"
# 应该有输出（ack-timing.ts 定义，ack-guard.ts 调用）
```

**最终验收（所有任务完成后）**：
- [ ] 全量 build 通过
- [ ] 全量 test 通过（允许 skip，不允许 fail）
- [ ] 以上 grep 检查全部通过
- [ ] 文件行数变化合理：
  - `child-finalizer.ts` ≤ 220 行
  - `detached-task-runtime-host.ts` ≤ 80 行
  - `llm-judge.ts` 比原来少 150+ 行
  - `ack-templates.ts` ≤ 80 行
  - `ack-template-registry.ts` 不存在
- [ ] 整体净减少行数 ≥ 1200 行（不含新增文件）
