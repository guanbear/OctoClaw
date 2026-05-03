# OctoClaw 委派延迟预加载机制设计

日期：2026-05-03

状态：设计草案，待可行性验证后进入 roadmap

关联文档：
- [`octoclaw-openclaw-native-slimming-review-2026-05-01.md`](./octoclaw-openclaw-native-slimming-review-2026-05-01.md) Section 13 Deferred
- [`octoclaw-native-slimming-implementation-plan-2026-05-01.md`](./octoclaw-native-slimming-implementation-plan-2026-05-01.md) Section 1.4 SR-P2 / PC12 / 18.4 第 10 条

---

## 1. 背景

0.5.0 planner/confirm 主链跑通后，实测 delegate 路径中用户从发消息到看到"任务已启动"约 90s，其中主要耗时分布在：

| 阶段 | 耗时来源 |
| --- | --- |
| 主 agent embedded run 启动 | 工具 bundle、system prompt、stream setup |
| 主 agent 首轮 LLM 决策 | judge + route + dispatch 工具调用 |
| `sessions_spawn` 调用 | gateway round-trip |
| 子 agent embedded run 启动 | bootstrap context（full mode 30-60s，lightContext 5-10s）|
| 子 agent 首轮 LLM 推理 | 任务执行 |

SR-P2 的目标之一（Section 1.4）是让主 agent 到 `sessions_spawn_intent_allowed` 控制在 30s 内，并把 `lightContext=true` 作为默认值降低 child bootstrap 成本。

但 `lightContext` 优化后，子 agent bootstrap 仍需 5-10s，且每次新任务都要重新走。slimming review Section 13 把 **warm worker pool / A2A 常驻 worker** 列为 Deferred 研究项，原因是"不承诺 child start p95 <= 10s"——即机制存在，但无法对端到端延迟做强保证。

本文档的目的是：
1. 在 OpenClaw v2026.4.29 源码层面验证 warm worker 机制是否真实存在。
2. 设计两个可增量实现的方案（方案 B、方案 A）。
3. 说明方案 B 如何演化成方案 A。
4. 提供可行性验证步骤和验收标准，作为未来进入 roadmap 的依据。

---

## 2. OpenClaw v2026.4.29 源码验证

### 2.1 关键机制：continuation turn 跳过 bootstrap

**源码位置**：`src/agents/pi-embedded-runner/run/attempt.context-engine-helpers.ts`

```ts
const context = isContinuationTurn
  ? ({ bootstrapFiles: [], contextFiles: [] } as unknown as TContext)  // 续 turn：完全跳过
  : await params.resolveBootstrapContextForRun();  // 首次 turn：30-60s 在这里
```

**结论**：同一个 session 的第二条及后续消息（`isContinuationTurn=true`）完全跳过 `resolveBootstrapContextForRun()`。这是 warm worker 机制的底层基础——如果能把任务作为续 turn 而非首次 turn 发送，bootstrap 开销为 0。

### 2.2 `mode: "session"` 创建持久 session

**源码位置**：`src/agents/subagent-spawn.ts` 第 372-383 行

- `mode: "session"` 需要 `thread=true`，自动设置 `cleanup: "keep"`，session 保活不自动删除。
- 用于创建可接收多条消息的持久工作 session。

### 2.3 `sessions_send` 向已有 session 发消息

**源码位置**：`src/agents/tools/sessions-send-tool.ts`

```ts
const sendParams = {
  message,
  sessionKey: resolvedKey,
  deliver: false,
  channel: INTERNAL_MESSAGE_CHANNEL,
  lane: AGENT_LANE_NESTED,
  ...
};
// callGateway({ method: "agent", params: sendParams })
```

- 支持按 `sessionKey` 或 `label` 定位目标 session。
- 触发目标 session 的新 run；因为 session transcript 已存在，embedded runner 识别为 `isContinuationTurn=true` → bootstrap 全跳过。
- `timeoutSeconds: 0` 时立即返回 `{ status: "accepted" }`，异步走 A2A announce flow，完全兼容 native announce/delivery chain。

### 2.4 综合结论

warm worker 所需的三个机制在 v2026.4.29 中均已存在：

| 机制 | 源码位置 | 验证结论 |
| --- | --- | --- |
| continuation turn 跳过 bootstrap | `attempt.context-engine-helpers.ts` | 确认 |
| `mode: "session"` 持久 session | `subagent-spawn.ts:372-383` | 确认，需 `thread=true` |
| `sessions_send` 续 turn 派发 | `sessions-send-tool.ts` | 确认，`AGENT_LANE_NESTED` |

**根本约束**：OctoClaw plugin 无法直接从插件上下文调用 `sessions_spawn`。所有 spawn 必须通过主 agent 的 tool call 触发。这是两个方案都面临的架构边界，也是 warm worker pool 在 slimming review 中被列为"研究项"而非直接实现的根本原因。

---

## 3. 方案 B：投机并行 spawn（`before_model_resolve` 注入）

### 3.1 设计原理

`before_model_resolve` hook 在主 agent embedded runner 内部、第一次 LLM call 之前触发。此时 OctoClaw 可以修改主 agent 的 effective system prompt，注入"优先投机 spawn 一个 standby session"的指令。

核心思路：把子 agent 的 bootstrap 时间与主 agent 的首轮 LLM 推理时间**并行化**。

### 3.2 时序

```
T=0    before_model_resolve 触发
         OctoClaw 注入指令：
         "首先调用 sessions_spawn(mode='session', lightContext=true,
          label='octoclaw-speculative', task='Standby. 等待 sessions_send 分配任务。')"
T=0~5s 主 agent 首轮 LLM 推理（judge + 决定调用 sessions_spawn）
T=5s   sessions_spawn tool call 执行 → 子 agent bootstrap 开始（lightContext ~5-10s）
T=5~8s 主 agent 第二轮 LLM（处理 spawn 结果，确认 route decision）
T=8s   route=delegate → 调 sessions_send(label='octoclaw-speculative', message=actual_task)
         此时子 agent 已 bootstrap 5s，剩余 0-5s bootstrap 等待
         sessions_send → continuation turn → 任务开始执行
       route=reply   → standby session 进入 pool 等待复用（见方案 A 进化路径）
T=8~45s 子 agent 执行任务
```

### 3.3 延迟对比（以 lightContext 为基准）

| 路径 | 主 agent overhead | 子 agent bootstrap wait | T=0 到任务开始 |
| --- | --- | --- | --- |
| 当前基线（无优化）| 15-25s（3+ turns）| 30-60s（full）| 45-85s |
| lightContext only | 15-25s | 5-10s | 20-35s |
| 方案 B | ~10s（2 turns）| 0-5s（并行）| **15-20s** |

### 3.4 实现要点

**`before_model_resolve` hook 注入**

在 `extension-entry.ts` 的 `before_model_resolve` hook 中，当 local precheck 初步判断 delegate 可能性高时（例如 `complexity=deep`、`tool_need_hint=required`、明确后台/并行请求），注入 speculative spawn 指令：

```ts
// extension-entry.ts → before_model_resolve
if (policy.speculativeSpawnEnabled && precheck.likelyDelegate) {
  ctx.injectSystemHint([
    "OCTOCLAW_SPECULATIVE_SPAWN:",
    "立即调用 sessions_spawn，参数：",
    "  mode: 'session', lightContext: true,",
    `  label: 'octoclaw-speculative-${turnId}',`,
    "  task: 'Standby worker. 等待 sessions_send 分配具体任务。不要主动执行任何操作。'",
    "调用完成后继续正常路由分析。",
  ].join("\n"));
}
```

**关键参数**

```ts
sessions_spawn({
  mode: "session",          // 必须：持久 session，支持续 turn
  lightContext: true,        // 必须：跳过 bootstrap 文件加载
  cleanup: "keep",           // mode=session 自动设置，确认一下
  label: `octoclaw-speculative-${turnId}`,
  task: "Standby worker. Do not execute any task. Await task assignment via sessions_send.",
  model: policy.defaultWorkerModel,
  thinking: "low",
  runTimeoutSeconds: 300,    // 5 分钟超时，pool 里不用的 session 自动 expire
})
```

**`before_tool_call` gate 例外**

当前 `before_tool_call` gate 只允许与 pending NativeSpawnIntent 匹配的 `sessions_spawn`。speculative spawn 是 OctoClaw 注入的预热行为，需要新增 speculative spawn 的 intent 类型或白名单：

```ts
// delegate/native-spawn-gate.ts
if (isSpeculativeSpawnIntent(toolArgs)) {
  return { allowed: true, reason: "speculative_preload" };
}
```

**dispatch 时的 sessions_send 路径**

route 确认为 delegate 后，`octoclaw_dispatch` 返回的 `NativeSpawnIntent` 中携带 `speculativeSessionLabel`。主 agent 调 `sessions_send` 而非新的 `sessions_spawn`：

```ts
// octoclaw_dispatch 返回的 NativeSpawnIntent 扩展
interface NativeSpawnIntent {
  // ...原有字段...
  speculativeSessionLabel?: string;  // 如果存在，dispatch 应用 sessions_send
  dispatchMode: "new_spawn" | "send_to_speculative";
}
```

**`octoclaw_dispatch_confirm` 兼容**

`sessions_send` 返回 `{ runId, status: "accepted", sessionKey }`，confirm 逻辑需要能处理这个 case 并正常写入 `WorkContract native refs`。

### 3.5 误判处理

误判（route=reply 时已经 spawn 了 speculative session）：

- session 状态：standby，什么都没执行（task="Standby, wait for sessions_send"）
- session 保留在 pool 中（`cleanup: "keep"`），可被后续 turn 复用
- `runTimeoutSeconds: 300` 保证最终自动 expire，不会无限占用资源
- **不需要 cancel API**（OctoClaw plugin 没有 cancel arbitrary subagent 的能力）

### 3.6 适用条件

方案 B 的注入指令应只在以下条件下触发，避免对所有 turn 都产生不必要的 spawn overhead：

- local precheck 初步信号：`tool_need_hint=required` 或 `complexity_band=deep` 或 explicit `delegate` 关键词
- 当前 turn 不是 execution followup / status lookup（这类 turn 不会 delegate）
- pool 中没有可用的 idle standby session（否则直接走方案 A 路径）

---

## 4. 方案 A：预热 Session Pool（持久化复用）

### 4.1 设计原理

方案 B 在 route=reply 时会留下一个 bootstrap 完成的 idle standby session。方案 A 在此基础上**持久化管理这些 session**，让后续 delegate turn 直接复用，跳过 speculative spawn 的 tool call 开销。

本质：方案 B 是方案 A 的冷启动路径。方案 A 是方案 B 的稳态形态。

### 4.2 时序（pool 命中）

```
T=0    before_model_resolve 触发
         查 pool → 找到 status=idle 的 standby session: octoclaw-standby-xyz
         注入指令：
         "有可用 standby session (label=octoclaw-standby-xyz)。
          路由确认 delegate 后，直接调用 sessions_send 而非 sessions_spawn。"
T=0~5s 主 agent 首轮 LLM 推理（judge + route）
T=5s   route=delegate → 直接调 sessions_send(label='octoclaw-standby-xyz', message=actual_task)
         continuation turn → bootstrap=0 → 任务立即开始
       route=reply   → pool 中 session 保持 idle（不消耗）
T=5~35s 子 agent 执行任务
```

### 4.3 延迟对比

| 路径 | 主 agent overhead | 子 agent bootstrap | T=0 到任务开始 |
| --- | --- | --- | --- |
| 方案 B | ~10s（2 turns）| 0-5s（并行）| 15-20s |
| 方案 A（pool 命中）| ~5s（1 turn）| 0s | **5-6s** |
| 方案 A vs 方案 B 差值 | -5s（少一次 speculative spawn tool call）| -0~5s | **节省 5-10s** |

### 4.4 Pool 数据结构

```ts
interface StandbySession {
  sessionKey: string;
  label: string;
  bootstrappedAt: number;       // unix ms
  lastUsedAt: number | null;
  status: "idle" | "dispatched" | "stale" | "expired";
  workerModel: string;
  expiresAt: number;            // bootstrappedAt + TTL（默认 5 分钟）
}
```

存储位置：OctoClaw SQLite metadata store（`standby_sessions` 表），与 WorkContract store 共存。

### 4.5 Pool 生命周期

```
spawn ──→ idle ──→ dispatched ──→ remove from pool
                                       ↓
                              spawn replacement → idle (补充 pool)

idle   ──→ stale   (health check 失败或 expiresAt 超时) → remove
idle   ──→ expired (OpenClaw session 已回收) → remove
```

**Pool 补充时机**：

1. `octoclaw_dispatch_confirm` 成功后（任务已确认派发），异步触发补充一个新 standby session。
2. Pool 为空且 local precheck 判断 delegate 可能性高时（即方案 B 的冷启动路径）。

**Pool 大小**：默认 1 slot（单并发委派）。如需支持并发委派，扩到 N slots（N = max concurrent delegates）。

### 4.6 健康检查

pool 里的 session 可能因 OpenClaw 进程重启、session TTL 过期或 keep 策略变化而失效。在 `before_model_resolve` 复用前做轻量健康检查：

```ts
async function probeStandbySession(sessionKey: string): Promise<boolean> {
  try {
    const result = await api.runtime.tasks.runs
      .bindSession(sessionKey)
      .findLatest({ status: ["idle", "waiting"] });
    return result !== null;
  } catch {
    return false;
  }
}
```

健康检查失败 → 标记为 stale → 从 pool 移除 → 退化到方案 B（重新 spawn）。

健康检查本身要有超时（< 500ms），不能阻塞 `before_model_resolve`。

---

## 5. 从方案 B 进化到方案 A 的增量路径

两个方案共享底层机制（`mode: "session"` + `sessions_send` + `isContinuationTurn`），区别只在于 pool 是否持久化管理。

### 5.1 进化步骤

**步骤 1：实现方案 B**

- `before_model_resolve` hook 注入 speculative spawn 指令（条件触发）
- `before_tool_call` gate 新增 speculative spawn 白名单
- `octoclaw_dispatch` 返回 `dispatchMode: "new_spawn" | "send_to_speculative"`
- `octoclaw_dispatch_confirm` 兼容 `sessions_send` 路径

验收：投机 spawn 能跑通，子 agent bootstrap 与主 agent LLM turn 并行化，整体 delegate 延迟 < 20s。

**步骤 2：加 pool 回收**

- 新增 `standby_sessions` SQLite 表
- 方案 B 的 speculative spawn 成功后，把 session 写入 pool（`status=idle`）
- `octoclaw_dispatch_confirm` 后标记为 `dispatched`，并触发补充
- route=reply 时 session 保留在 pool（不做任何操作）

**步骤 3：pool 命中逻辑**

- `before_model_resolve` 先查 pool → 有 idle session → 注入 "直接用 sessions_send" 指令
- 跳过 speculative spawn 的 tool call → 主 agent 一个 turn 直接 dispatch → 方案 A 形态

**步骤 4（可选）：pool 预热**

- OctoClaw extension 初始化时（`agent_start` 或 `before_model_resolve` 首次触发）自动 spawn 一个 standby session 进入 pool
- 之后 pool 常驻热态，首次 delegate 就能命中 pool

### 5.2 回退规则

| 情况 | 行为 |
| --- | --- |
| pool 有 idle session | 方案 A 路径（sessions_send，1 turn）|
| pool 为空，precheck 信号强 | 方案 B 路径（speculative spawn，2 turns）|
| pool 为空，precheck 信号弱 | 普通 planner/confirm 路径（sessions_spawn，2-3 turns）|
| pool session health check 失败 | 标记 stale，退化到方案 B 或普通路径 |

对主流程完全透明——pool 是纯优化层，任何 pool 异常都退化到现有 0.5.0 planner/confirm 主链。

---

## 6. 可行性验证步骤

### 6.1 验证 1：continuation turn 确实跳过 bootstrap

**方法**：

1. 手动用 `sessions_spawn(mode: "session", lightContext: true)` 创建一个 standby session，记录 `childSessionKey`。
2. 立即用 `sessions_send(sessionKey: childSessionKey, message: "echo: hello")` 发续 turn。
3. 测量第二条消息从 send 到 agent 开始 LLM inference 的时间。
4. 与 fresh `sessions_spawn` 的 child bootstrap 时间对比。

**预期**：续 turn 从 send 到 LLM inference < 3s；fresh spawn 的 bootstrap > 5s（lightContext）。

**成功标准**：续 turn 延迟 < fresh spawn bootstrap 延迟的 50%。

### 6.2 验证 2：`sessions_send` native announce 完整链路

**方法**：

1. 向已有 standby session 发 `sessions_send(message: "完成一个简单任务，输出 DONE")`。
2. 确认子 agent 的 final reply 能通过 native announce 回到 requester session。
3. 确认 `deliver: false` + A2A flow 正常触发（`runSessionsSendA2AFlow`）。

**预期**：final reply 在 requester session 中出现，无需 OctoClaw finalizer 介入。

**成功标准**：子 agent 完成后，requester session 收到 native announce，WorkContract 可记录到 `runId`。

### 6.3 验证 3：`before_tool_call` gate 的 speculative spawn 兼容性

**方法**：

1. 在 `before_tool_call` gate 里观察，当主 agent 调用 speculative spawn（非 matched NativeSpawnIntent）时，gate 是否阻止。
2. 确认加白名单后 speculative spawn 能正常执行。

**成功标准**：gate 不误阻 speculative spawn，且不影响正常 intent-matched spawn 的 hash 校验。

### 6.4 验证 4：pool 健康检查 API 可用性

**方法**：

1. 创建一个 `mode: "session"` standby session，存入 pool。
2. 过一段时间（5 分钟）后，用 `api.runtime.tasks.runs.bindSession(sessionKey).findLatest()` 查询状态。
3. 验证 API 是否能区分"session 仍然存活"和"session 已 expire/回收"。

**成功标准**：health check API 能在 500ms 内返回 session 状态；session expire 后 health check 正确返回失败。

---

## 7. 验收标准

### 7.1 方案 B 验收

- delegate 路径 T=0 到任务开始 p50 < 20s（基线约 45-90s）。
- 投机 spawn 与主 agent LLM turn 真正并行（Slack smoke 可见 spawn accepted 时间与 judge 完成时间重叠）。
- route=reply 时 speculative session 进入 pool，不立即删除，不向用户发 ACK。
- 误判情况下（route=reply 多次连续），pool 不无限堆积；expired session 自动从 pool 移除。
- `before_tool_call` gate 在 speculative spawn 开启后不产生误阻 false positive。

### 7.2 方案 A 验收（在方案 B 稳定后）

- pool 命中路径 T=0 到任务开始 p50 < 8s。
- pool 命中时主 agent 只需 1 次 LLM turn（Slack smoke 可见 `sessions_send` 而非 `sessions_spawn`）。
- pool miss 时自动退化到方案 B，延迟不超过方案 B 基线。
- pool session 健康检查失败时退化到普通 planner/confirm 路径，不向用户暴露错误。
- 进程重启后，pool 冷启动，第一次 delegate 退化到方案 B，第二次起命中 pool。
- pool 补充逻辑（confirm 后异步 spawn）不阻塞 delegate ACK 发送。

---

## 8. 已知限制和风险

### 8.1 OctoClaw plugin 无法直接 spawn

所有 spawn 必须通过主 agent tool call。这意味着：

- Pool 预热（extension 初始化时）需要等到主 agent 首次处理消息后才能触发，而不是进程启动时。
- 如果需要在消息处理前预热，需要利用 OpenClaw heartbeat 机制或专属"初始化 turn"，增加实现复杂度。

**当前建议**：接受"首次冷启动退化到方案 B"，不在 0.5.0/0.5.x 范围内实现进程启动时预热。

### 8.2 `mode: "session"` 需要 `thread: true`

从 `subagent-spawn.ts` 源码可以看到，`mode: "session"` 在验证时要求 `thread=true`。这意味着 standby session 需要绑定到特定线程（Slack thread 或类似）。

**影响**：pool 中的 session 与发起 spawn 的 thread 绑定，跨 thread 无法复用。Pool 实际上是 per-thread 的，而非全局的。

**当前建议**：Pool 按 thread/channel 维度管理，key = `(agentId, threadId)`。如果 OpenClaw 后续放开 `mode: "session"` 的 thread 绑定要求，再扩展为 global pool。

### 8.3 Continuation turn 延迟的不确定性

即使 bootstrap 跳过，continuation turn 仍需要：embedded runner 进程启动 + session transcript 加载 + LLM inference。这部分的 p95 是否真正 < 5s 需要实际测量（验证 6.1）。

**当前建议**：先做 6.1 验证，如果 continuation turn 延迟 < 3s，方案 B/A 有足够价值；如果 > 5s，收益缩水，需要重新评估优先级。

### 8.4 与 0.5.0 planner gate 的兼容性

Speculative spawn 在 `before_tool_call` 时还没有 NativeSpawnIntent（因为 speculative spawn 是在 dispatch 之前触发的）。Gate 需要正确区分：

- OctoClaw 自己注入的 speculative spawn（白名单）
- 主 agent 自行决定调用的 sessions_spawn（不在 intent 范围内，应阻止）
- OctoClaw dispatch 授权的 sessions_spawn（匹配 intent hash，允许）

Gate 逻辑的修改需要仔细测试，避免破坏现有 intent-matched 路径的安全性。

---

## 9. 与 0.5.0 planner/confirm 主链的关系

本文描述的两个方案是对 0.5.0 主链的**延迟优化层**，不是替代。核心不变：

- 仍然需要 `octoclaw_dispatch` 生成 NativeSpawnIntent / 或 send_to_speculative intent。
- 仍然需要 `octoclaw_dispatch_confirm` 校验 runId 并写入 WorkContract native refs。
- delegate ACK 仍然只在 confirm 成功后发送。
- 任何 pool 异常都退化到现有 planner/confirm 路径，不破坏 0.5.0 稳定性。

**进入 roadmap 的前置条件**：

1. 0.5.0 Must ship（planner/confirm 主链、native spawn gate、confirm guard、delegate ACK 时序）已在真实 Slack smoke 中稳定。
2. 完成 Section 6 的四项可行性验证。
3. SR-P2 目标（`route commit 到 sessions_spawn_intent_allowed` p95 <= 30s）已达成；本方案针对 30s 之后的"子 agent bootstrap"阶段再优化。

---

## 10. 推荐优先级

| 阶段 | 内容 | 前置条件 |
| --- | --- | --- |
| **验证阶段**（0.5.0 稳定后）| 执行 Section 6 的四项验证；重点是 6.1（continuation turn 延迟）和 6.2（native announce 完整链路）| 0.5.0 Must ship 稳定 |
| **方案 B 实现** | `before_model_resolve` 注入 + gate 兼容 + dispatch confirm sessions_send 路径 | 验证通过，continuation p50 < 3s |
| **方案 A 进化**（Pool 管理）| SQLite `standby_sessions` 表 + pool 查询 + health check + 补充逻辑 | 方案 B 在 nightly smoke 中稳定 |
| **Pool 预热增强**（可选）| extension 初始化时 / heartbeat 触发预热 | 方案 A 稳定，有真实需求 |
