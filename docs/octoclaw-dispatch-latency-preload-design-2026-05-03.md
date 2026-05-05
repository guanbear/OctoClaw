# OctoClaw 委派延迟预加载机制设计

日期：2026-05-03

状态：设计草案，待可行性验证后进入 roadmap

关联文档：
- [`octoclaw-openclaw-native-slimming-review-2026-05-01.md`](./octoclaw-openclaw-native-slimming-review-2026-05-01.md) Section 13 Deferred
- [`octoclaw-native-slimming-implementation-plan-2026-05-01.md`](./octoclaw-native-slimming-implementation-plan-2026-05-01.md) Section 1.4 SR-P2 / PC12 / 18.4 第 10 条

---

## 1. 背景与定位

### 1.1 两个不同的慢点

0.5.0 planner/confirm 主链跑通后，实测 delegate 路径中用户从发消息到看到"任务已启动"约 90s。延迟来自两段不同的瓶颈，需要分开处理：

**瓶颈 A：parent agent 链路慢**

| 阶段 | 耗时来源 |
| --- | --- |
| 主 agent embedded run 启动 | 工具 bundle、system prompt、stream setup |
| 主 agent 首轮 LLM 决策 | judge + route + dispatch 工具调用（2-3 轮）|
| `sessions_spawn` 调用 | gateway round-trip |

这段耗时即使对 reply 路由也存在。如果普通 reply 也很慢，说明 parent 链路是主要瓶颈，preload 方案对此**无效**。

**解法**：reply fast path（绕过 remote judge/WorkContract）、`before_dispatch fast delegate`（高置信委派直接跳过 parent 首轮 LLM/工具握手）。

**瓶颈 B：child bootstrap 慢**

| 阶段 | 耗时来源 |
| --- | --- |
| 子 agent embedded run 启动 | bootstrap context（full mode 30-60s，lightContext 5-10s）|
| 子 agent 首轮 LLM 推理 | 任务执行 |

`lightContext=true` 优化后仍需 5-10s。slimming review Section 13 把 **warm worker pool / A2A 常驻 worker** 列为 Deferred 研究项，原因是"不承诺 child start p95 <= 10s"——即机制存在，但无法对端到端延迟做强保证。

**解法**：本文的方案 B/A，通过 `mode: "session"` + `sessions_send` continuation turn 跳过 bootstrap。

### 1.2 本文的定位

**本文方案（B/A）针对瓶颈 B（child bootstrap），不替代针对瓶颈 A 的 `before_dispatch fast delegate`。**

两者是互补关系：

| 场景 | 推荐方案 |
| --- | --- |
| 简单问题 | reply fast path，跳过 remote judge/WorkContract |
| 高置信委派（parent 也慢）| `before_dispatch fast delegate`，绕过 parent 首轮 LLM/工具握手 |
| 委派已确认、child bootstrap 是瓶颈 | 本文方案 B/A，warm session continuation turn |
| 灰区任务 | planner/confirm 原链路 |

理想最终组合（每层独立可选）：

```
简单问题       → reply fast path
高置信委派     → before_dispatch fast delegate（直接 spawn，绕过 parent）
child 启动优化 → 有可用 warm session 则 sessions_send；没有则 sessions_spawn
灰区任务       → planner-native 原链路 + lightContext
```

---

## 2. OpenClaw v2026.4.29 源码验证

### 2.1 关键机制：continuation turn 跳过 bootstrap

**源码位置**：`src/agents/pi-embedded-runner/run/attempt.context-engine-helpers.ts`

```ts
const context = isContinuationTurn
  ? ({ bootstrapFiles: [], contextFiles: [] } as unknown as TContext)  // 续 turn：完全跳过
  : await params.resolveBootstrapContextForRun();  // 首次 turn：5-60s 在这里
```

**结论**：同一个 session 的第二条及后续消息（`isContinuationTurn=true`）完全跳过 `resolveBootstrapContextForRun()`。这是 warm worker 机制的底层基础——如果能把任务作为续 turn 而非首次 turn 发送，bootstrap 开销为 0。

### 2.2 `mode: "session"` 创建持久 session

**源码位置**：`src/agents/subagent-spawn.ts` 第 366-377 行

```ts
const requestThreadBinding = params.thread === true;
// ...
if (spawnMode === "session" && !requestThreadBinding) {
  return {
    status: "error",
    error: 'mode="session" requires thread=true so the subagent can stay bound to a thread.',
  };
}
```

**关键约束**：`mode: "session"` 强制要求 `thread=true`，session 与发起 spawn 的 thread 绑定。这意味着 pool **不是全局常驻 worker**，而是 **per-thread standby session**——跨 thread 无法复用同一个 pool slot。

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
- `timeoutSeconds: 0` 时立即返回 `{ status: "accepted" }`，异步走 A2A announce flow，兼容 native announce/delivery chain。

### 2.4 Hook 能力边界（事实修正）

**源码位置**：`src/plugins/hook-before-agent-start.types.ts`

```ts
// before_model_resolve：只能 override model/provider，不能注入 prompt
export type PluginHookBeforeModelResolveResult = {
  modelOverride?: string;
  providerOverride?: string;
};

// before_prompt_build：可注入 system prompt context
export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;  // 静态指令，走 prompt cache
  appendSystemContext?: string;
};
```

**结论**：方案 B 需要向主 agent 注入 speculative spawn 指令，必须使用 `before_prompt_build`（`prependContext` 或 `appendSystemContext`），不能用 `before_model_resolve`。

### 2.5 综合结论

| 机制 | 源码位置 | 验证结论 |
| --- | --- | --- |
| continuation turn 跳过 bootstrap | `attempt.context-engine-helpers.ts` | 确认 |
| `mode: "session"` 持久 session | `subagent-spawn.ts:366-377` | 确认，强制 `thread=true`，per-thread 绑定 |
| `sessions_send` 续 turn 派发 | `sessions-send-tool.ts` | 确认，`AGENT_LANE_NESTED` |
| 指令注入 hook | `hook-before-agent-start.types.ts` | 必须用 `before_prompt_build`，非 `before_model_resolve` |

**根本约束**：OctoClaw plugin 无法直接从插件上下文调用 `sessions_spawn`。所有 spawn 必须通过主 agent 的 tool call 触发。这是两个方案都面临的架构边界，也是 warm worker pool 在 slimming review 中被列为"研究项"的根本原因。

---

## 3. 方案 B：投机并行 spawn（`before_prompt_build` 注入）

### 3.1 设计原理

`before_prompt_build` hook 在主 agent embedded runner 内部、prompt 组装阶段触发，可以注入 `prependContext` 内容。

核心思路：把子 agent 的 bootstrap 时间与主 agent 的首轮 LLM 推理时间**并行化**。注意：这只优化 child bootstrap（瓶颈 B），主 agent 自身的 LLM turns 不减少。

### 3.2 时序

```
T=0    before_prompt_build 触发
         local precheck 信号强（likely delegate）
         注入 prependContext：
         "OCTOCLAW_SPECULATIVE_SPAWN:
          当你的路由分析需要委派任务时，请在第一次工具调用中包含
          sessions_spawn(mode='session', thread=true, lightContext=true,
            label='octoclaw-speculative-{turnId}',
            task='Standby worker. 等待 sessions_send 分配任务。')"
T=0~5s 主 agent 首轮 LLM 推理（judge + 决定同时调用 sessions_spawn）
T=5s   sessions_spawn tool call 执行 → 子 agent bootstrap 开始（lightContext ~5-10s）
T=5~8s 主 agent 第二轮 LLM（处理 spawn 结果，确认 route decision）
T=8s   route=delegate → 调 sessions_send(label='octoclaw-speculative-{turnId}', message=actual_task)
         此时子 agent 已 bootstrap 5s，剩余 0-5s 等待
         sessions_send → continuation turn → 任务开始执行
       route=reply   → standby session 进入 pool 等待复用（见方案 A）
T=8~45s 子 agent 执行任务
```

### 3.3 延迟分析

方案 B 优化的是 child bootstrap，不是 parent 链路：

| 路径 | parent overhead | child bootstrap wait | T=0 到任务开始 |
| --- | --- | --- | --- |
| 当前基线（无优化）| 15-25s（3+ turns）| 30-60s（full）| 45-85s |
| lightContext only | 15-25s | 5-10s（串行）| 20-35s |
| 方案 B | ~10s（2 turns）| 0-5s（并行）| **15-20s** |
| `before_dispatch fast delegate` | ~0-3s（绕过 parent）| 5-10s（lightContext）| **5-15s** |

如果 parent 链路（普通 reply）已经很慢（> 30s），方案 B 的收益会被 parent 拖死，应先修 reply fast path 和 `before_dispatch fast delegate`。

### 3.4 实现要点

**`before_prompt_build` hook 注入**

```ts
// extension-entry.ts → before_prompt_build
const result: PluginHookBeforePromptBuildResult = {};
if (policy.speculativeSpawnEnabled && precheck.likelyDelegate && !pool.hasIdle(threadId)) {
  result.prependContext = [
    "OCTOCLAW_SPECULATIVE_SPAWN_HINT:",
    "如果路由分析判断需要委派，请在首轮工具调用中包含：",
    `sessions_spawn(mode: "session", thread: true, lightContext: true,`,
    `  label: "octoclaw-speculative-${turnId}",`,
    `  task: "Standby worker. 等待 sessions_send 分配任务。不要主动执行任何操作。")`,
    "完成后继续正常路由分析。",
  ].join("\n");
}
return result;
```

注意用 `prependContext`（per-turn，可变内容）而非 `prependSystemContext`（走 prompt cache，不适合含 turnId 的动态内容）。

**关键参数**

```ts
sessions_spawn({
  mode: "session",          // 持久 session，支持续 turn
  thread: true,              // mode=session 强制要求
  lightContext: true,        // 跳过 bootstrap 文件加载
  label: `octoclaw-speculative-${turnId}`,
  task: "Standby worker. Do not execute any task. Await task assignment via sessions_send.",
  model: policy.defaultWorkerModel,
  thinking: "low",
  runTimeoutSeconds: 300,    // 5 分钟超时后自动 expire
})
```

**`before_tool_call` gate 例外**

speculative spawn 发生在 `octoclaw_dispatch` 之前，没有匹配的 NativeSpawnIntent。需要新增 speculative spawn 白名单，避免 gate 误阻：

```ts
// delegate/native-spawn-gate.ts
if (isSpeculativeSpawnIntent(toolArgs)) {
  // label 符合 octoclaw-speculative-{turnId} 格式，且 task 是 standby 指令
  return { allowed: true, reason: "speculative_preload" };
}
```

**dispatch 时的 `sessions_send` 路径**

route 确认为 delegate 后，`octoclaw_dispatch` 检查 pool/speculative session，决定 dispatch 模式：

```ts
interface NativeSpawnIntent {
  // ...原有字段...
  speculativeSessionLabel?: string;  // 存在时 dispatch 使用 sessions_send
  dispatchMode: "new_spawn" | "send_to_speculative";
}
```

**`octoclaw_dispatch_confirm` 兼容**

`sessions_send` 返回 `{ runId, status: "accepted", sessionKey }`，confirm 逻辑处理此 case 并写入 `WorkContract native refs`。

### 3.5 误判处理

route=reply 时已经 spawn 了 speculative session：

- session 状态：standby，什么都没执行
- 保留在 pool 中（`cleanup: "keep"`），可被后续 turn 复用
- `runTimeoutSeconds: 300` 保证最终自动 expire，不无限占用资源
- **不需要 cancel API**（OctoClaw plugin 没有 cancel arbitrary subagent 的能力）

### 3.6 触发条件

注入指令应只在以下条件下触发：

- local precheck 初步信号强：`tool_need_hint=required` 或 `complexity_band=deep` 或 explicit delegate 关键词
- 当前 turn 不是 execution followup / status lookup
- pool 中没有可用的 idle standby session（否则直接走方案 A）
- 当前 thread 有 `thread=true` 绑定（`mode: "session"` 的前提）

---

## 4. 方案 A：预热 Session Pool（持久化复用）

### 4.1 设计原理

方案 B 在 route=reply 时会留下一个 bootstrap 完成的 idle standby session。方案 A **持久化管理这些 per-thread session**，让后续 delegate turn 直接复用，跳过 speculative spawn 的 tool call 开销。

**重要约束**：因为 `mode: "session"` 要求 `thread=true`，pool 是 **per-thread** 的，不是全局 worker pool。Pool key = `(agentId, threadId)`，每个 Slack thread 最多 N 个 standby slot。

本质：方案 B 是方案 A 的冷启动路径。方案 A 是方案 B 的稳态形态。

### 4.2 时序（pool 命中）

```
T=0    before_prompt_build 触发
         查 pool(threadId) → 找到 status=idle 的 session: octoclaw-standby-xyz
         注入指令（appendSystemContext，走 prompt cache）：
         "有可用 standby session (label=octoclaw-standby-xyz)。
          路由确认 delegate 后，调用 sessions_send 而非 sessions_spawn。"
T=0~5s 主 agent 首轮 LLM 推理（judge + route）
T=5s   route=delegate → 调 sessions_send(label='octoclaw-standby-xyz', message=actual_task)
         continuation turn → bootstrap=0 → 任务立即开始
       route=reply   → pool 中 session 保持 idle
T=5~35s 子 agent 执行任务
```

pool 命中时注入内容是静态的（只包含 label），可以用 `appendSystemContext` 走 prompt cache，避免每 turn token 成本。

### 4.3 延迟对比

| 路径 | parent overhead | child bootstrap | T=0 到任务开始 |
| --- | --- | --- | --- |
| 方案 B | ~10s（2 turns）| 0-5s（并行）| 15-20s |
| 方案 A（pool 命中）| ~5s（1 turn）| 0s | **5-6s** |
| 方案 A vs B 差值 | -5s | -0~5s | **节省 5-10s** |

### 4.4 Pool 数据结构

```ts
interface StandbySession {
  sessionKey: string;
  label: string;
  agentId: string;
  threadId: string;             // mode=session 绑定的 thread，per-thread 管理
  bootstrappedAt: number;
  lastUsedAt: number | null;
  status: "idle" | "dispatched" | "stale" | "expired";
  workerModel: string;
  expiresAt: number;            // bootstrappedAt + TTL（默认 5 分钟）
}
```

存储位置：OctoClaw SQLite metadata store（`standby_sessions` 表）。

索引：`(agentId, threadId, status, expiresAt)` — 便于快速按 thread 查询 idle session。

### 4.5 Pool 生命周期

```
spawn ──→ idle ──→ dispatched ──→ remove from pool
                                       ↓
                              spawn replacement → idle

idle   ──→ stale   (health check 失败或 expiresAt 超时) → remove
idle   ──→ expired (OpenClaw session 已回收) → remove
```

**Pool 补充时机**：

1. `octoclaw_dispatch_confirm` 成功后，异步触发为该 thread 补充一个新 standby session。
2. Pool 为空且 precheck 信号强时（方案 B 冷启动路径），spawn 后写入 pool。

**Pool 大小**：per-thread 默认 1 slot。

### 4.6 健康检查

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

健康检查必须有超时（< 500ms），失败则标记 stale，退化到方案 B。

---

## 5. 从方案 B 进化到方案 A 的增量路径

### 5.1 进化步骤

**步骤 1：实现方案 B**

- `before_prompt_build` hook 条件注入 speculative spawn 指令
- `before_tool_call` gate 新增 speculative spawn 白名单
- `octoclaw_dispatch` 返回 `dispatchMode: "new_spawn" | "send_to_speculative"`
- `octoclaw_dispatch_confirm` 兼容 `sessions_send` 路径

验收：投机 spawn 能跑通，child bootstrap 与主 agent LLM turn 并行化，整体 delegate 延迟 < 20s。

**步骤 2：加 pool 回收**

- 新增 `standby_sessions` SQLite 表（含 `threadId` 字段）
- speculative spawn 成功后写入 pool（`status=idle`）
- `octoclaw_dispatch_confirm` 后标记 `dispatched`，触发补充
- route=reply 时 session 保留在 pool

**步骤 3：pool 命中逻辑**

- `before_prompt_build` 先查 pool(threadId) → 有 idle session → 注入 "直接用 sessions_send" 指令
- 跳过 speculative spawn → 主 agent 一个 turn 直接 dispatch → 方案 A 形态

**步骤 4（可选）：pool 预热**

- `before_prompt_build` 首次触发时（如果 pool 空），异步触发 standby session spawn
- 第二次请求起命中 pool

### 5.2 回退规则

| 情况 | 行为 |
| --- | --- |
| pool 有 idle session（同 thread）| 方案 A 路径（sessions_send，1 turn）|
| pool 为空，precheck 信号强 | 方案 B 路径（speculative spawn，2 turns）|
| pool 为空，precheck 信号弱 | 普通 planner/confirm 路径（sessions_spawn，2-3 turns）|
| pool session health check 失败 | 标记 stale，退化到方案 B |

任何 pool 异常都退化到现有 0.5.0 planner/confirm 主链，对核心链路完全透明。

---

## 6. 可行性验证步骤

### 6.1 验证 1：continuation turn 确实跳过 bootstrap

**方法**：

1. 手动用 `sessions_spawn(mode: "session", thread: true, lightContext: true)` 创建 standby session。
2. 立即用 `sessions_send(sessionKey, message: "echo: hello")` 发续 turn。
3. 测量第二条消息从 send 到 agent 开始 LLM inference 的时间。
4. 与 fresh `sessions_spawn` 的 child bootstrap 时间对比。

**成功标准**：续 turn 延迟 < fresh spawn bootstrap 延迟的 50%，且 p50 < 3s。

> 如果续 turn 延迟 > 5s，方案 B/A 的收益缩水，需要重新评估优先级。

### 6.2 验证 2：`sessions_send` native announce 完整链路

**方法**：

1. 向已有 standby session 发 `sessions_send(message: "完成一个简单任务，输出 DONE")`。
2. 确认子 agent final reply 通过 native announce 回到 requester session。
3. 确认 `deliver: false` + A2A flow 正常触发（`runSessionsSendA2AFlow`）。

**成功标准**：requester session 收到 native announce，WorkContract 可记录到 `runId`，无需 OctoClaw finalizer 介入。

### 6.3 验证 3：`before_tool_call` gate 的 speculative spawn 兼容性

**方法**：

1. 观察主 agent 调用 speculative spawn（非 matched NativeSpawnIntent）时 gate 的行为。
2. 确认加白名单后 speculative spawn 能正常执行。
3. 确认白名单不影响正常 intent-matched spawn 的 hash 校验（不产生安全漏洞）。

**成功标准**：gate 不误阻 speculative spawn；正常 intent-matched 和 speculative 两条路径均能正确通过/阻止。

### 6.4 验证 4：pool 健康检查 API 可用性

**方法**：

1. 创建 `mode: "session"` standby session，存入 pool。
2. 5 分钟后用 `api.runtime.tasks.runs.bindSession(sessionKey).findLatest()` 查状态。
3. 验证 API 能区分"session 仍然存活"和"session 已 expire/回收"。

**成功标准**：health check 在 500ms 内返回；session expire 后正确返回失败。

---

## 7. 验收标准

### 7.1 方案 B 验收

- child bootstrap 阶段 p50 < 3s（续 turn，无 bootstrap）。
- delegate 整体路径 T=0 到任务开始 p50 < 20s（基线约 45-90s）。
- 投机 spawn 与主 agent LLM turn 真正并行（Slack smoke 可见 spawn accepted 时间与 judge 完成时间重叠）。
- route=reply 时 speculative session 进入 pool，不向用户发 ACK。
- 误判连续时 pool 不无限堆积；expired session 自动移除。
- `before_tool_call` gate 在 speculative spawn 开启后不产生误阻。

### 7.2 方案 A 验收（在方案 B 稳定后）

- pool 命中路径 T=0 到任务开始 p50 < 8s。
- pool 命中时主 agent 只需 1 次 LLM turn（Slack smoke 可见 `sessions_send` 而非 `sessions_spawn`）。
- pool miss 自动退化到方案 B，延迟不超过方案 B 基线。
- health check 失败时退化到普通 planner/confirm 路径。
- 进程重启后 pool 冷启动，第一次 delegate 退化到方案 B，第二次起命中 pool。

---

## 8. 已知限制和风险

### 8.1 `mode: "session"` per-thread 约束（非全局 worker pool）

`mode: "session"` 强制 `thread=true`，pool slot 与 Slack thread 绑定，不同 thread 不能共享同一个 standby session。

**影响**：高频单 thread 对话收益最大；不同 thread 每条都是冷启动（直到该 thread 自己积累 pool）。

**当前建议**：Pool 按 `(agentId, threadId)` 管理，接受跨 thread 无法复用。若 OpenClaw 后续放开 thread 绑定要求，再扩展为 global pool。

### 8.2 OctoClaw plugin 无法直接 spawn

所有 spawn 必须通过主 agent tool call，Pool 预热无法在进程启动时完成，需等到第一次处理消息后触发。

**当前建议**：接受"首次冷启动退化到方案 B"，不在 0.5.0/0.5.x 范围内实现进程预热。

### 8.3 Continuation turn 延迟的不确定性

即使 bootstrap 跳过，continuation turn 仍需 embedded runner 进程启动 + session transcript 加载。p95 < 5s 需实际测量（验证 6.1），如果 > 5s 则方案收益大幅缩水。

### 8.4 `before_prompt_build` 注入对 prompt cache 的影响

`prependContext` 是 per-turn 动态内容，会破坏 prompt cache prefix。注入内容中如果包含 turnId 等动态值，每轮 cache miss。

**缓解**：pool 命中时注入的是静态 label，用 `appendSystemContext`（走 cache）；speculative spawn 的注入是通用模板（不含 turnId），也可以用 `prependSystemContext` 减少 cache 破坏。

### 8.5 与 0.5.0 planner gate 的兼容性

Speculative spawn 在 `octoclaw_dispatch` 之前，gate 需要区分三类 `sessions_spawn`：

1. OctoClaw 注入的 speculative spawn → 白名单允许
2. 主 agent 自行决定调用 → 应阻止
3. OctoClaw dispatch 授权的 → 匹配 intent hash，允许

Gate 逻辑修改需仔细测试，避免破坏现有 intent-matched 路径的安全性。

---

## 9. 与 `before_dispatch fast delegate` 的关系

本文方案和 `before_dispatch fast delegate` 解决的是**不同的瓶颈**，不是竞争关系：

| | `before_dispatch fast delegate` | 本文方案 B/A |
| --- | --- | --- |
| 优化目标 | parent agent 链路（LLM turns、工具握手）| child bootstrap |
| 机制 | 在 parent embedded runner 启动前 hook，高置信直接 spawn，`handled: true` 跳过主模型 | parent 正常运行，但提前/复用 child session |
| parent 节省 | 绕过整个 parent LLM cycle（30-60s）| 无（parent 链路不变）|
| child 节省 | 0（child 仍需 bootstrap）| 5-60s（continuation turn 跳 bootstrap）|
| 误判代价 | 子 agent 启动了但不该启动（任务错误）| 子 agent standby 等待，最终 expire |
| 适用场景 | 高置信委派，快速绕过 parent | 委派已确认，优化 child 启动 |

理想组合：`before_dispatch fast delegate`（砍 parent overhead） + 本文方案（砍 child bootstrap）可以叠加，端到端延迟最小。

---

## 10. 与 0.5.0 planner/confirm 主链的关系

本文描述的两个方案是对 0.5.0 主链的**延迟优化层**，不是替代。核心不变：

- 仍然需要 `octoclaw_dispatch` 生成 NativeSpawnIntent / send_to_speculative intent。
- 仍然需要 `octoclaw_dispatch_confirm` 校验 runId 并写入 WorkContract native refs。
- delegate ACK 仍然只在 confirm 成功后发送。
- 任何 pool 异常都退化到现有 planner/confirm 路径。

**进入 roadmap 的前置条件**：

1. 0.5.0 Must ship 已在真实 Slack smoke 中稳定。
2. 完成 Section 6 的四项可行性验证（尤其是验证 6.1：续 turn p50 < 3s）。
3. 普通 reply 路径已经正常（parent 链路不是主要瓶颈）；如果 reply 也慢，应先做 reply fast path 和 `before_dispatch fast delegate`。

---

## 11. 推荐优先级

2026-05-05 调整：0.5.1 先做方案 B 的可回退实现切片，而不是先做方案 A pool 或 direct backend。原因是方案 B 只依赖 OpenClaw 4.29 已有 `sessions_spawn(mode="session")` 和 `sessions_send(timeoutSeconds=0)`，可以 feature flag 关闭，且任何失败都退回 0.5.0 planner/confirm 主链；方案 A 需要新增 `standby_sessions` 持久池、health check 和补充逻辑，风险更高。

| 阶段 | 内容 | 前置条件 |
| --- | --- | --- |
| **0.5.1 P0** | 保留 30s soft budget，但超时后允许 late final / 一次轻量只读工具；prompt 注入不再强制 delegate | 0.5.0 release branch |
| **0.5.1 P1** | 方案 B feature-flag 实现：`before_prompt_build` 注入 standby spawn、speculative spawn 白名单、`octoclaw_dispatch` 返回 `dispatchMode=send_to_speculative`、`sessions_send` 走 pending intent gate、confirm 继续 fail-closed | `OCTOCLAW_SPECULATIVE_PRELOAD=1`；默认关闭 |
| **0.5.1 P2** | Section 6 live 验证：续 turn 延迟、`sessions_send` native announce、gate 安全、confirm ACK/footer | P1 本地 tests 通过 |
| **0.5.1 P3** | 如果 P2 证明收益稳定，再默认开启或按 allowlist 开启；记录 accepted ACK / task-start 分段延迟 | 连续 Slack smoke 稳定 |
| **0.5.x 后续** | 方案 A：SQLite `standby_sessions` 表 + pool 查询 + health check + 补充逻辑 | 方案 B 在 nightly smoke 中稳定 |
| **Pool 预热增强**（可选）| heartbeat 或首次 turn 预热 | 方案 A 稳定，有真实高频需求 |

### 11.1 0.5.1 P1 实现状态

当前实现是 feature-flag implementation slice，不默认改变线上行为：

- `OCTOCLAW_SPECULATIVE_PRELOAD=1` 时，`before_prompt_build` 只对 runtime 已判定为 delegate 的 turn 注入 `OCTOCLAW_SPECULATIVE_SPAWN_HINT`，不靠用户文本关键词。
- speculative standby spawn 必须满足固定安全形态：`mode="session"`、`thread=true`、`context="isolated"`、`lightContext=true`、label 前缀 `octoclaw-speculative-`、standby task 精确匹配；否则 planner gate 不放行。
- `octoclaw_dispatch` 在看到当前 policyState 的 standby spawn 已进入 `spawn_call_started` 后，创建 `dispatchMode="send_to_speculative"` 的 pending intent，并返回 `sessionsSendArgs`；未命中则退回原 `sessionsSpawnArgs` 路径。
- `sessions_send` 在 planner delegate 路径下必须匹配 pending send intent hash，才会推进到 `spawn_call_started`；`octoclaw_dispatch_confirm` 仍要求 accepted + 非空 runId，ACK 仍晚于 confirm。
- 本地验收：`extension-entry.test.ts` 覆盖 hint 注入、白名单允许/误 label 拦截、`sessions_send` gate；`registration-planner.test.ts` 覆盖 dispatch 返回 `send_to_speculative` 和 pending intent。
