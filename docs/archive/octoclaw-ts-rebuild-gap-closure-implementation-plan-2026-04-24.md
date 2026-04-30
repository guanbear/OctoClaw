# OctoClaw TS Rebuild Gap Closure Implementation Plan

日期：2026-04-24

状态：implementation handoff

目标分支：`release/0.3.0-ts-rebuild`

关联主设计：

1. [octoclaw-ts-rebuild-design-v1.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-ts-rebuild-design-v1.md)
2. [octoclaw-ts-rebuild-implementation-plan-2026-04-15.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-ts-rebuild-implementation-plan-2026-04-15.md)
3. [octoclaw-delegate-runtime-gap-closure-2026-04-22.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-delegate-runtime-gap-closure-2026-04-22.md)
4. [octoclaw-judge-ack-policy-spec-2026-04-21.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-judge-ack-policy-spec-2026-04-21.md)
5. [octoclaw-ack-decision-truth-table-2026-04-21.md](https://github.com/guanbear/OctoClaw/blob/release/0.3.0-ts-rebuild/docs/octoclaw-ack-decision-truth-table-2026-04-21.md)

OpenClaw 参考基线：`v2026.4.21`

---

## 1. 本文回答什么

这份文档不是新的方向稿，而是给执行 AI 直接开工的整改计划。

当前 release 分支的大方向已经正确：

1. 顶层 route 已基本收敛为 `reply | delegate`
2. runner 已不应是语义 route
3. 产品热路径不应再有 Python
4. OpenClaw native task/flow 应成为执行真相源

真正需要修的是落地细节：

1. route sealing 仍可能被旧 state 或兼容字段污染
2. native task/flow 还没有成为 dispatch/status/details 的唯一 authority
3. ACK 逻辑过重，但对“主 agent 慢、无首回应”的体验目标不够直接
4. 子 agent 派发结果和旧 thread history 仍可能污染主 agent 上下文
5. 大文件职责混杂，后续修改风险高
6. judge context 仍缺少 `execution coverage`，导致 provenance/status follow-up 被误判成新委派

---

## 2. 施工总约束

### 2.1 不再改回去的架构结论

1. 顶层 semantic route 只能是 `reply | delegate`
2. `observe` 是 `reply` 下的状态读取，或 `delegate(role=observer)`
3. `runner / spawn / on-demand / openclaw-native / tmux` 都是 execution backend 或兼容词，不是 route
4. `local_judge` 是热路径 route authority
5. 主 agent 不拥有 route authority，只能通过 objection protocol 请求改判
6. `ack_writer` 只写短文案，不参与 route / role / complexity 决策
7. native task/flow 是 delegated execution truth
8. `task-state.json` 只能是 projection/cache/policy metadata
9. 子 agent 不默认接收完整 thread transcript
10. 子 agent 的完整日志/报告不默认注入主 agent

### 2.2 非目标

1. 不新增 resident runner 作为默认能力
2. 不把 multi-agent 做成 Phase 1 的默认形态
3. 不为了 ACK 引入第二个强模型调用
4. 不用关键词规则重新接管 route
5. 不把 OpenClaw native flow/task 直接暴露成用户产品语义

### 2.3 与旧设计 / 借鉴文档的关系

本方案复核并吸收了这些旧设计与借鉴文档：

1. `octoclaw-router-policy-refactor-2026-04-10.md`
   - 保留：stateless judge、小上下文、信号抽取不做最终 route、ACK 不等模型、execution ledger
   - 修正：旧文档中的 `direct / runner / spawn_single / spawn_multi` 是历史 execution contract 词汇，不再作为顶层 route
2. `octoclaw-runtime-slimming-plan-2026-04-12.md`
   - 保留：默认运行面不依赖 patrol/runner daemon，legacy loop 退成 one-shot/compat
   - 修正：runner pool 可作为 opt-in acceleration backend，但不能恢复成默认 truth source
3. `octoclaw-transition-cleanup-design.md`
   - 保留：durable policy state、substrate-only read path、legacy mirror shrink、optional backend true detach
   - 修正：RouteSeal 不应只存在进程内 Map；必须进入 TTL-bound durable policy state 或等价 ledger
4. `octoclaw-auto-router-boundary-map.md`
   - 保留：router/recommendation kernel 可以抽离
   - 修正：runtime policy adapter、delegated lane execution、status/details、IM/display 仍留在 OctoClaw runtime，不放进 auto-router package
5. `octoclaw-native-taskflow-and-agent-runtime-borrowings-2026-04-20.md`
   - 保留：OpenClaw task/flow truth、ClawTeam 的 ownership/session/worktree、DeerFlow 的 event/artifact/state-vs-transcript、Hermes 的 parent-child session/timeout、open-multi-agent 的 scheduler-enforced parallelism
   - 修正：这些能力都落在 runtime/recovery/status/context 层，不进入顶层 route 词汇

旧 route 词汇统一翻译表：

| 旧词汇 | 新解释 |
| --- | --- |
| `direct` | `route=reply` |
| `runner` | `route=delegate` 下的 optional acceleration backend |
| `spawn_single` | `route=delegate, coordination_mode=solo_worker` |
| `spawn_multi` | `route=delegate, coordination_mode=multi_agent_controlled` |
| `observe` | `reply` 下状态读取，或 `delegate(role=observer)` |
| `tmux` | optional operator/workbench/backend，不是真相源 |

执行 AI 读取旧文档时，必须按这张表做语义翻译，不得把旧词汇恢复为新的顶层 route。

---

## 3. 推荐落地顺序

按下面 7 个 work package 做。不要一次性大重构。

1. WP1：route sealing 与 keyword/rule 去权威化
2. WP1b：judge context coverage，补 `memory + execution truth` 双层覆盖
3. WP2：OpenClaw `TaskFlowPort` 与 truth-source 收敛
4. WP3：ACK 简化与首回应体验修正
5. WP4：派发上下文污染治理
6. WP5：状态面/details/status 同源查询
7. WP6：大文件拆分与冗余清理

每个 WP 都要先加测试，再改实现。

---

## 4. WP1：Route Sealing

### 4.1 目标

修掉这类问题：

1. judge 判 `delegate`，dispatch 最后落成 `reply`
2. 当前 turn 的 `policyJson/forceRoute/requested_route` 被旧 state 覆盖
3. `runner/spawn/direct/observe` 兼容词重新变成 route authority
4. regex grounding 影响 route

### 4.2 新增 contract

建议在 `packages/octoclaw-contracts/src/route-seal.ts` 新增：

```ts
export type LiveRoute = "reply" | "delegate";

export type RouteSealSource =
  | "local_judge"
  | "accepted_objection"
  | "explicit_current_policy"
  | "safe_fallback";

export interface RouteSeal {
  schemaVersion: "octoclaw.route_seal.v1";
  requestId: string;
  turnId: string;
  threadBindingKey: string;
  route: LiveRoute;
  replyMode?: "answer" | "clarify";
  delegateRole?: "observer" | "default" | "code" | "research" | "review";
  coordinationMode?: "solo_worker" | "advisor_assisted" | "multi_agent_controlled";
  source: RouteSealSource;
  confidence?: number;
  reasonCodes: string[];
  createdAt: string;
  inputHash: string;
  stateGeneration: number;
}
```

### 4.3 优先级规则

实现 `resolveCurrentRouteSeal(input)`，优先级固定：

1. 当前 turn 显式 `policyJson.routeSeal`
2. 当前 turn 显式 `requested_route / forceRoute`，但必须归一到 `reply | delegate`
3. 当前 turn 的 `local_judge` 输出
4. 同一 `threadBindingKey + turnId` 的已保存 route seal
5. safe fallback：`reply`

禁止：

1. 旧 thread state 覆盖当前 turn seal
2. `task-state.json` 覆盖 current policy
3. backend availability 反推 route
4. regex/keyword 直接生成 route

### 4.3.1 持久化规则

RouteSeal 不允许只放在进程内 Map。

最低要求：

1. route seal 写入 session/thread-scoped durable policy state，或写入可查询 ledger/event artifact
2. 必须带 `turnId / threadBindingKey / stateGeneration / inputHash`
3. TTL 过期或 turnId 不匹配时不得复用
4. dispatch/status/details 只能消费 current route seal 或同一 turn 的 persisted seal
5. legacy compatibility state 只能作为 recovery hint，不能覆盖 current seal

### 4.4 代码落点

建议新增/调整：

1. `packages/octoclaw-contracts/src/route-seal.ts`
2. `packages/octoclaw-policy/src/route/seal.ts`
3. `extensions/octoclaw-runtime/src/resolve/route-seal.ts`
4. `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`
5. `extensions/octoclaw-runtime/src/tools/handlers/dispatch.ts`

### 4.5 测试

必须覆盖：

1. current `policyJson.routeSeal=delegate` 时，旧 state `reply` 不得覆盖
2. `forceRoute=delegate` 与 `route_decision.route=delegate` 时，dispatch 不得落成 direct/reply
3. `runner/spawn_single/observe/direct` 输入只允许被归一为 backend/role/compat，不得作为顶层 route 输出
4. regex grounding 命中“runner/status/继续查”等词时，不得覆盖 judge route
5. stale route seal 的 `turnId` 不匹配时不得复用

验收命令：

```bash
pnpm --filter @octoclaw/policy test
pnpm --filter octoclaw-runtime test -- route
```

---

## 4b. WP1b：Judge Context Coverage

### 4b.1 目标

修掉这类问题：

1. 用户问“你是自己查的还是子 agent 查的”，judge 默认判 `delegate`
2. 系统为了回答 provenance，又派发一个新子 agent 去查“是不是子 agent”
3. 主 agent 已有 execution receipt，但 judge 看不到，于是误判
4. memory/active-memory 有背景信息，但 execution truth 没建模，导致“记忆”和“执行事实”混用

核心原则：

> provenance/status follow-up 不是默认新工作。它优先是读取已有 execution truth。

### 4b.2 新增 packet 层

在现有 `JudgeContextPacket` 中新增两层：

```ts
export interface JudgeMemoryLayer {
  coverage?: "none" | "partial" | "strong";
  freshness_risk?: "low" | "high";
  source?: Array<"bootstrap" | "memory_search" | "active_memory">;
  supports_direct_reply?: boolean;
  supports_fresh_lookup?: boolean;
  evidence_summary?: string;
  conflict?: boolean;
}

export interface JudgeExecutionLayer {
  coverage?: "none" | "current_turn" | "recent_turn" | "thread";
  freshness?: "current" | "recent" | "stale";
  supports_provenance_reply?: boolean;
  supports_status_reply?: boolean;
  requires_control_plane_refresh?: boolean;
  last_route?: "reply" | "delegate" | "unknown";
  last_reply_mode?: "answer" | "clarify" | null;
  last_delegate_role?: "observer" | "default" | "code" | "research" | "review" | null;
  tools_used?: string[];
  dispatch_executed?: boolean;
  spawn_executed?: boolean;
  native_task_id?: string;
  native_flow_id?: string;
  result_materialized?: boolean;
  delivery_status?: "none" | "pending" | "delivered" | "failed";
  evidence_summary?: string;
  conflict?: boolean;
}
```

`memory` 只回答“已有记忆是否足够支撑直接回复”。`execution` 只回答“已有执行事实是否足够回答 provenance/status”。

### 4b.3 判断规则

必须写进 policy spec / prompt builder / validator：

1. `execution.supports_provenance_reply=true`
   - route 必须保持 `reply`
   - reply_mode 为 `answer`
   - 不允许 `octoclaw_dispatch`
   - 不允许 `octoclaw_spawn`
2. `execution.supports_status_reply=true`
   - route 保持 `reply`
   - 直接基于 receipt/status snapshot 回答
3. `execution.requires_control_plane_refresh=true`
   - 允许 `octoclaw_status` / `octoclaw_task_action`
   - 仍不得 spawn 子 agent
4. 只有新外部查询、新 workspace inspection、新命令执行、长任务，才按铁律进入 `delegate`
5. memory 与 execution 冲突时，execution wins

旧规则必须删除或改写：

```text
execution truth/provenance follow-up -> delegate
```

替换为：

```text
provenance follow-up with sufficient execution coverage -> reply.answer
status follow-up with sufficient execution coverage -> reply.answer
status follow-up requiring lightweight control-plane refresh -> reply + status/task-action control tool
new probe/work/tool execution/>1min -> delegate
```

### 4b.4 代码落点

建议新增/调整：

1. `extensions/octoclaw-runtime/src/resolve/judge-context-packet.ts`
   - 给 packet 加 `memory` / `execution`
2. `extensions/octoclaw-runtime/src/resolve/execution-coverage-precheck.ts`
   - 从 `TurnExecutionReceipt` / `RecentExecutionFacts` / route seal / tool receipt / delivery receipt 组装 `JudgeExecutionLayer`
3. `extensions/octoclaw-runtime/src/resolve/memory-coverage-precheck.ts`
   - 只聚合已有 active-memory/bootstrap signal，不主动查 memory tool
4. `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`
   - judge 前按顺序跑 `execution coverage -> memory coverage -> buildJudgeContextPacket`
5. `packages/octoclaw-policy/src/spec/decision-policy-spec.ts`
   - 改 anti-reply-bias 中 provenance 默认 delegate 的规则
6. `packages/octoclaw-policy/src/spec/prompt-builder.ts`
   - prompt view 中加入 execution coverage 例外
7. `extensions/octoclaw-runtime/src/tools/registration.ts`
   - 防御：provenance/status-only route 不得调用 `octoclaw_spawn`

### 4b.5 非目标

1. 不用关键词词表接管 provenance intent
2. 不让 memory 证明执行来源
3. 不让 active-memory 改 route
4. 不为了 provenance 启动子 agent
5. 不把完整 thread transcript 回灌给 judge

### 4b.6 测试

必须覆盖：

1. 上一轮 `route=reply + tools_used=[web_fetch]`，用户问“你是自己查的还是子 agent 查的”
   - 期望 `route=reply`
   - 不调用 `octoclaw_dispatch`
   - 不调用 `octoclaw_spawn`
2. 上一轮 `route=delegate + dispatch_executed=true + spawn_executed=true + result_materialized=true`，用户问“谁做的”
   - 期望基于 receipt 回答子 agent
3. 上一轮 `dispatch_executed=true + spawn_executed=false`，用户问“派发成功了吗”
   - 期望回答已登记但未执行/未产出
4. execution coverage 缺失，用户问 provenance
   - 期望快速回答无可验证记录
   - 最多允许 status/task-action
   - 不允许 spawn
5. `memory.coverage=strong` 但 `execution.dispatch_executed=false`
   - 期望 execution wins

验收命令：

```bash
pnpm --filter @octoclaw/policy test
pnpm --filter octoclaw-runtime test -- judge-context execution-coverage provenance
```

### 4b.7 给执行者的解释说明

这一节是为了防止实现做偏。这里修的不是“再加几个 provenance 关键词”，也不是“让 memory 压过 judge”。

真正的问题是：

1. judge 当前只知道用户问了一个看似需要查证的问题
2. 但 judge 不知道系统手里已经有 execution receipt
3. 于是它把“读取已有执行事实”误判成“创建一个新执行单元”
4. 最后出现荒诞链路：为了回答“是不是子 agent 做的”，又派了一个子 agent 去查

正确心智模型：

1. 用户问“刚才是谁做的”
2. 系统先看 execution coverage
3. 如果 receipt 已能证明：
   - 上一轮是主 agent 直接回复
   - 上一轮用了哪些工具
   - 有没有 dispatch
   - 有没有 spawn
   - 有没有 worker result
4. 那这就是一个 `reply.answer`
5. 不需要也不允许创建新的 delegated work unit

错误心智模型：

1. 用户问“谁做的”
2. 这是执行事实问题
3. 执行事实要查
4. 查就要 delegate
5. 于是 spawn 子 agent

上面第 4 步是错的。这里的“查”如果只是读取当前 runtime 已有 receipt/status snapshot，不是新工作。

### 4b.8 正确与错误例子

例子 A：上一轮主会话直接查网页。

已有 execution layer：

```json
{
  "coverage": "recent_turn",
  "supports_provenance_reply": true,
  "last_route": "reply",
  "tools_used": ["web_fetch"],
  "dispatch_executed": false,
  "spawn_executed": false,
  "result_materialized": false,
  "delivery_status": "delivered"
}
```

用户问：

```text
你是自己查的还是子 agent 查的
```

正确：

```json
{
  "route": "reply",
  "reply_mode": "answer",
  "reason_codes": ["execution_coverage_supports_provenance_reply"]
}
```

用户可见答案应类似：

```text
这条能确认是主会话自己查的：上一轮记录里是 reply 路径，直接用了 web_fetch，没有 delegated task / subagent result 记录。
```

错误：

```json
{
  "route": "delegate",
  "delegate_role": "observer"
}
```

也错误：

```text
我派个子 agent 去查一下刚才是不是子 agent 查的。
```

例子 B：上一轮只登记 dispatch，没有真正 spawn。

已有 execution layer：

```json
{
  "coverage": "recent_turn",
  "supports_provenance_reply": true,
  "last_route": "delegate",
  "dispatch_executed": true,
  "spawn_executed": false,
  "native_task_id": "task-123",
  "result_materialized": false,
  "delivery_status": "none"
}
```

用户问：

```text
派发成功了吗
```

正确答案应区分：

```text
只能确认已经登记了委派任务 task-123，但没有看到子 agent 真正启动或产出结果的 receipt，所以不能说派发执行成功。
```

不要说：

```text
已经派发成功，等结果。
```

也不要为了补这个事实再 spawn。

例子 C：用户问新的外部事实。

用户问：

```text
帮我查 OpenClaw 4.22 最新特性
```

即使 memory 里有之前版本摘要，也不能把它当 fresh truth。正确仍是：

```json
{
  "route": "delegate",
  "delegate_role": "research",
  "reason_codes": ["fresh_lookup_requires_new_work"]
}
```

### 4b.9 实现边界再确认

请按这个边界做：

1. 可以新增 `execution-coverage-precheck.ts`
2. 可以新增 `memory-coverage-precheck.ts`
3. 可以扩展 `judge-context-packet.ts`
4. 可以改 `decision-policy-spec.ts` / `prompt-builder.ts`
5. 可以加 tool guard，阻止 provenance/status-only case 调用 spawn
6. 不要新增一套 router
7. 不要把正则 pattern 当 authority
8. 不要让主 agent 自己 silent override
9. 不要让 active-memory 直接改 route
10. 不要为了 provenance 查询启动新的 worker

最低实现可以先只覆盖已有 receipt：

1. 读取最近一轮 `TurnExecutionReceipt`
2. 读取 `RecentExecutionFacts`
3. 把 route/tools/dispatch/spawn/task/result/delivery 投到 execution layer
4. local judge 消费这个 layer
5. prompt/policy 明确 execution coverage 足够时 provenance -> reply

暂时做不到完整 native task/flow 查询也可以，但必须保证：

1. 有 receipt 时不误委派
2. 没 receipt 时不胡说
3. 没 receipt 时也不 spawn

---

## 5. WP2：OpenClaw TaskFlowPort

### 5.1 目标

把当前对 OpenClaw dist bundle 的扫描桥降级为 fallback，主路径改为 OpenClaw runtime 注入。

OpenClaw `v2026.4.21` 已提供正式 runtime seam：

1. `api.runtime.taskFlow.bindSession({ sessionKey, requesterOrigin })`
2. bound runtime 支持 `createManaged/get/list/findLatest/resolve/getTaskSummary`
3. bound runtime 支持 `setWaiting/resume/finish/fail/requestCancel/cancel/runTask`

本 port 必须保持 thin-port 形态。它只是把 OctoClaw delegate/task/status 投影接到 OpenClaw runtime seam，不是第二套 task runtime，也不是对 OpenClaw task internals 的重新封装。

### 5.2 新增 port

建议在 `extensions/octoclaw-runtime/src/ports/taskflow-port.ts` 新增：

```ts
export interface TaskFlowPort {
  bindSession(input: {
    sessionKey: string;
    requesterOrigin?: unknown;
  }): BoundTaskFlowPort;
}

export interface BoundTaskFlowPort {
  createManaged(input: CreateManagedFlowInput): ManagedFlowRecord;
  runTask(input: RunNativeTaskInput): NativeTaskRunResult;
  get(flowId: string): NativeFlowRecord | null;
  resolve(token: string): NativeFlowRecord | null;
  getTaskSummary(flowId: string): NativeTaskSummary | null;
  setWaiting(input: FlowMutationInput): FlowMutationResult;
  finish(input: FlowMutationInput): FlowMutationResult;
  fail(input: FlowMutationInput): FlowMutationResult;
  cancel(input: CancelFlowInput): Promise<CancelFlowResult>;
}
```

### 5.3 适配器

实现两个 adapter：

1. `OpenClawRuntimeTaskFlowPort`
   - 从 plugin API 注入的 `runtime.taskFlow` 创建
   - 正式 live path 默认使用
2. `OpenClawDistTaskFlowPort`
   - 包装现有 `taskflow-bridge.ts`
   - 仅用于本地测试、旧安装兼容、OpenClaw runtime API 不可用时 fallback

若同时存在 detached runtime wrapper 和 TaskFlowPort：

1. TaskFlowPort 负责 flow/task creation、lookup、mutation
2. detached runtime wrapper 只负责 OpenClaw detached lifecycle ownership seam
3. 二者都不得引入第二套 truth store
4. 无 flow ownership metadata 时应返回 structured `not_found/fallback_to_core`，而不是伪造状态

### 5.4 session/thread binding

必须新增显式 binding 结构，不允许继续用 `requestId || taskId` 临时代替。

建议 contract：

```ts
export interface ThreadBinding {
  schemaVersion: "octoclaw.thread_binding.v1";
  threadBindingKey: string;
  requesterSessionKey: string;
  requesterOrigin?: unknown;
  surfaceAnchorId?: string;
  channel?: string;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
}
```

绑定规则：

1. `threadBindingKey` 是 OctoClaw 查询/恢复的稳定主键
2. `requesterSessionKey` 是 OpenClaw native task/flow 的 owner/session key
3. `requesterOrigin` 用于 OpenClaw delivery
4. `flowId/taskId` 是 native execution identity，不是 thread identity

### 5.5 truth-source 规则

dispatch/status/details 必须共用同一个查询链：

1. `threadBindingKey -> delegate_task`
2. `delegate_task -> native_flow_id/native_task_id`
3. `native_flow/task -> current status`
4. OctoClaw projection 只补 `recovering/delivery_pending/waiting_resume` 等产品态

禁止：

1. dispatch 写 native task，details 只读 `task-state.json`
2. status 只列旧 projection，不查 native flow/task
3. native 有 task id 时返回 `Task not found`

### 5.6 测试

必须覆盖：

1. fake `api.runtime.taskFlow` 注入时不触发 dist scan
2. dispatch 创建的 native task id 可被 details 查到
3. status/details 对同一个 id 返回同一 authority state
4. native status 从 `queued/running/succeeded/failed/timed_out/cancelled/lost` 映射到 OctoClaw projection
5. requesterOrigin 透传到 OpenClaw task delivery

---

## 6. WP3：ACK 简化与首回应体验

### 6.1 目标

ACK 的目标只保留 3 个：

1. 没有首回应时给用户一个轻量可见反馈
2. 主 agent reply 特别慢时安抚，不让用户以为系统没收到
3. 一旦正式输出/交付出现，立刻 suppress/cancel

ACK 不承担：

1. route 判断
2. progress 总结
3. recovery 判断
4. 子任务结果解释

### 6.2 首 ACK 不再固定等 5s

建议把首可见反馈拆成两种 modality，二选一：

1. `reaction_ack`
   - 默认检查点：`800ms - 1200ms`
   - 只在 channel 支持 reaction / emoji ack 且配置允许时使用
   - 算作 ACK0
   - 发送后不再发送 text ACK0
2. `text_ack0`
   - 默认检查点：`2500ms - 3500ms`
   - channel 不支持 reaction、用户场景偏正式、或 reaction 不可靠时使用
   - 算作 ACK0

`5s` 不再是默认等待时间，而是首 ACK 的最大保守上限。真实默认建议：

```yaml
ack_timing:
  reaction_ack_ms: 1000
  text_ack0_ms: 3000
  ack0_hard_ceiling_ms: 5000
  tier1_ms: 18000
  tier2_ms: 45000
  tier3_ms: 120000
```

与旧 router 文档中 `500ms - 800ms` 中性 ACK 的关系：

1. 旧值仍可作为 channel-specific fast text ACK profile
2. 默认 text ACK0 先取 `2500ms - 3500ms`，目的是降低和主模型首 token 争抢、双短回复的概率
3. 如果线上 p95 首 token 明显超过 2s，且 channel 不支持 reaction，可把 `text_ack0_ms` 调低到 `800ms - 1500ms`
4. 调低必须同时观测 `double_short_reply_rate` 与 `ack_suppressed_after_first_token`

### 6.3 表情 ACK 是否需要

需要，但必须作为可配置 channel capability，不是所有渠道默认开。

推荐规则：

1. 支持 reaction 且用户体验偏聊天：优先 `reaction_ack`
2. 不支持 reaction、工作流偏正式、或 reaction 可能不可见：使用 `text_ack0`
3. `reaction_ack` 与 `text_ack0` 对同一 turn 二选一
4. 出现 first token / formal reply / delivered 后两者都 suppress
5. tier1/tier2/tier3 仍可用 text nudge，但那不是 ACK0

推荐 emoji 候选：

1. `👍`
2. `👌`
3. `✅`

不建议使用含义过强、过情绪化或可能像最终答复的 emoji。

### 6.4 模板池

需要模板池，但不要做“万能随机模板池”。

正确形态是：

1. stage-scoped：`ack0 / tier1 / tier2 / tier3`
2. channel-scoped：`chat / work / cli / im`
3. tone-scoped：`neutral / warm / terse`
4. deterministic selection：用 `hash(threadBindingKey + turnId + stage)` 选择模板
5. cooldown-aware：同一 thread 最近 N 次避免重复同一模板

原因：

1. 真随机会让口吻漂移
2. 真随机会让重试/幂等难排查
3. 万能模板容易在代码执行、调研、写作、状态查询里都显得不贴合

ACK0 文案必须短，不解释路由，不暴露派发策略。

建议初始模板：

```ts
const ack0TextTemplates = [
  "收到，我在处理。",
  "收到，正在看。",
  "我看一下，马上继续。",
  "在处理了，稍等我一下。",
  "收到，我这边继续推进。"
];
```

### 6.5 新决策函数

新增纯函数：

```ts
export function decideAckAction(packet: AckDecisionPacket): AckDecision;
```

输入：

```ts
export interface AckDecisionPacket {
  route: "reply" | "delegate" | "pre_route" | "unknown";
  nowMs: number;
  inboundAtMs: number;
  firstTokenSeen: boolean;
  formalReplyVisible: boolean;
  deliveryPending: boolean;
  delivered: boolean;
  userInputActive: boolean;
  mainModelActive: boolean;
  toolActive: boolean;
  delegatedRunning: boolean;
  blocked: boolean;
  reactionAckSupported: boolean;
  reactionAckEnabled: boolean;
  reactionAckSent: boolean;
  textAck0Sent: boolean;
  tier1Sent: boolean;
  tier2Sent: boolean;
  ackWriterQueued: boolean;
  channelTone: "chat" | "work" | "cli" | "unknown";
}
```

输出：

```ts
export type AckDecisionAction =
  | "send_reaction_ack"
  | "send_text_ack0"
  | "send_tier_nudge"
  | "enqueue_ack_writer"
  | "cancel_ack_writer"
  | "suppress"
  | "no_action";
```

核心优先级：

1. `delivered/final/formal/delivery_pending` -> cancel/suppress
2. `userInputActive` -> no_action
3. `route != reply` -> v1 suppress reply-style ACK
4. 未到检查点 -> no_action
5. 无 first token 且 `mainModelActive || toolActive || blocked` -> ACK0 eligible
6. ACK0 modality 先选 reaction，否则 text
7. ACK0 已发且仍长时间静默 -> tier nudge 或 ack_writer

### 6.6 文件落点

建议：

1. `extensions/octoclaw-runtime/src/ack/ack-decision.ts`
2. `extensions/octoclaw-runtime/src/ack/ack-template-registry.ts`
3. `extensions/octoclaw-runtime/src/ack/ack-renderer.ts`
4. `extensions/octoclaw-runtime/src/ack/ack-receipts.ts`

逐步把 `ack-guard.ts` / `ack-burst.ts` 的复杂判断迁到纯函数和小模块。

### 6.7 测试

必须覆盖：

1. 1s 无 first token、支持 reaction -> `send_reaction_ack`
2. 已发 reaction ACK0 后，3s 不再发 text ACK0
3. 不支持 reaction、3s 无 first token、main model active -> `send_text_ack0`
4. first token 出现 -> suppress/cancel
5. delivered/delivery_pending/formal reply -> suppress/cancel
6. user 正在连续输入 -> no_action
7. route=delegate -> 不发 reply-style ACK0
8. 模板选择对同一 `threadBindingKey + turnId + stage` 稳定

---

## 7. WP4：派发上下文污染治理

### 7.0 来源与边界

本 WP 不是新造一套 context 协议，而是把已有设计里的 `artifact-first / brief-result-artifact` 口径落到 TS rebuild：

1. `octoclaw-harness-contract-inventory.md`
   - 已定义 canonical `brief / result / artifact / event / eval outcome`
   - 明确 `artifact` 包含 report、context pack、worker result、OpenClaw taskflow、operator surface
2. `octoclaw-harness-ownership-map.md`
   - runtime harness 负责 compact brief/context packets、dispatch、task substrate、state normalization
   - workflow harness 负责 bounded and artifact-first execution
3. `docs/archive/design-notes/octoclaw-product-design-v2-2026-03-27.md`
   - 明确 `artifact-first, event-first, state-first`
   - 长结果、日志、diff、研究材料优先落 artifact
   - 主链路不默认吞下完整 transcript
   - 每类 route 维护 context budget
4. `octoclaw-native-taskflow-and-agent-runtime-borrowings-2026-04-20.md`
   - child workers should receive typed handoff packets, not full transcripts
   - status/timeline/progress push should come from runtime truth plus projection, not raw child logs
5. `octoclaw-delegate-runtime-gap-closure-2026-04-22.md`
   - follow-up grounding 必须使用 minimal delegate status packet
   - main-agent working context 默认由 thread summary、checkpoint summary、structured task/delegate packet、artifact refs 组成

现有 TS contracts 也已有可复用基础：

1. `packages/octoclaw-contracts/src/artifacts.ts`
   - `ArtifactDescriptor`
   - `TaskPacket`
   - `WorkerBrief`
   - `ThreadHandoffPacket`
   - `ActiveContextBudget`
   - `SummarySnapshotMetadata`
2. `packages/octoclaw-contracts/src/delegate.ts`
   - `DelegateTask`
   - `DelegateAttempt`
   - `DelegateProgressEvent`
   - `ResumePacket`
   - `StatusQueryPacket`
   - `ArtifactRef`

因此本 WP 的实现原则是：

1. 优先复用/扩展这些 contract
2. 新增字段必须能映射到 `brief/result/artifact/event` 其中之一
3. 不新增第二套 artifact store
4. 不把 artifact refs 降级成普通字符串列表后失去 lineage
5. 不让完整 transcript 成为 artifact-first 的替代品

### 7.1 问题定义

“派发更污染上下文”不是 delegation 的必然结果，而是当前 delivery/context 协议的问题：

1. worker 接收过多 parent transcript
2. worker 返回完整报告
3. 主 agent 再读完整报告并重写
4. follow-up 又注入完整 thread history
5. 内部 route/delegation rationale 被用户可见文本带回上下文

目标是把 delegation 改成 packet/artifact-first。

### 7.2 新 contract

建议新增或扩展：

1. `DelegateHandoffPacket`
2. `WorkerResultPacket`
3. `DelegateStatusPacket`
4. `MainResumePacket`
5. `ContextBudgetReport`

落点：

1. `packages/octoclaw-contracts/src/delegate-context.ts`
   - 只放当前 contracts 缺失的 context-specific shape
   - 能复用 `TaskPacket / WorkerBrief / ThreadHandoffPacket / ActiveContextBudget / ArtifactRef` 的字段不要重写
2. `extensions/octoclaw-runtime/src/context/delegate-packets.ts`
   - 负责从 native truth + OctoClaw projection + artifact index 组装 packet
3. `extensions/octoclaw-runtime/src/context/context-budget.ts`
   - 负责 token/cost/pollution 预算与 telemetry
4. `extensions/octoclaw-runtime/src/artifacts/delegate-artifacts.ts`
   - 负责写入/读取 worker report、context pack、operator payload 等 artifact
   - 不应替代 OpenClaw native task/flow truth

### 7.2.1 Artifact-first 数据流

默认数据流：

```text
user turn
  -> RouteSeal
  -> DelegateHandoffPacket / TaskPacket
  -> worker
  -> WorkerResultPacket
  -> artifact writer writes full report/log/context pack
  -> WorkerResultPacket stores artifact refs
  -> DelegateStatusPacket injects compact state + artifact refs
  -> main agent reads artifacts only on demand
```

artifact 类型建议：

1. `worker_report`
   - 完整研究报告、代码审计报告、长解释
2. `worker_log_excerpt`
   - 必要日志摘录，默认截断
3. `context_pack`
   - worker 看到的 compact context，不含完整 transcript
4. `diff_or_patch`
   - 代码变更、patch、文件列表
5. `verification_evidence`
   - 测试输出摘要、命令、关键结果
6. `operator_surface`
   - 给 status/details/UI 展示的可读摘要

artifact ref 不应只是裸字符串，执行层内部应尽量使用 typed ref：

```ts
export interface DelegateArtifactRef {
  artifactId: string;
  artifactKind:
    | "worker_report"
    | "worker_log_excerpt"
    | "context_pack"
    | "diff_or_patch"
    | "verification_evidence"
    | "operator_surface";
  uri?: string;
  title?: string;
  summary?: string;
  tokenEstimate?: number;
  createdAt: string;
}
```

主 agent 默认只拿：

1. `summary`
2. `keyFindings`
3. `status`
4. `artifactRefs[].title`
5. `artifactRefs[].summary`
6. 必要时才读取 `artifactRefs[].uri`

### 7.2.2 Context budget 分层

派发污染治理要有硬预算，而不是只靠 prompt 约束。

建议默认预算：

```yaml
context_budget:
  worker_handoff_max_tokens: 1800
  worker_result_packet_max_tokens: 900
  main_resume_packet_max_tokens: 700
  artifact_summary_max_tokens: 250
  raw_transcript_default: false
  raw_worker_log_default: false
```

预算优先级复用既有 `ActiveContextBudget.priorityOrder`：

1. `task_summary`
2. `artifact_refs`
3. `structured_state`
4. `transcript_excerpt`

只有当前三层不足以完成任务时，才允许加入 `transcript_excerpt`，并且必须记录原因：

```ts
contextEscalationReason:
  | "summary_insufficient"
  | "artifact_ref_insufficient"
  | "user_asked_for_exact_prior_wording"
  | "debugging_context_pack";
```

### 7.3 DelegateHandoffPacket

worker 输入只允许这个结构或其兼容的 `TaskPacket / WorkerBrief` 投影，不允许直接塞完整 transcript：

```ts
export interface DelegateHandoffPacket {
  schemaVersion: "octoclaw.delegate_handoff.v1";
  delegateTaskId: string;
  attemptId: string;
  threadBindingKey: string;
  currentUserAsk: string;
  taskBrief: string;
  acceptanceCriteria: string[];
  readScope: string[];
  writeScope: string[];
  workspaceMode: "read_only" | "write_allowed";
  role: "observer" | "default" | "code" | "research" | "review";
  modelProfile: string;
  contextBudget: {
    maxInputTokens: number;
    maxSummaryTokens: number;
    allowRawTranscript: false;
  };
  threadSummary?: string;
  relevantExcerpts?: string[];
  artifactRefs: DelegateArtifactRef[];
  forbiddenContent: string[];
}
```

`forbiddenContent` 默认包含：

1. full thread transcript
2. route rationale
3. delegation rationale
4. contamination guard wording
5. prior assistant orchestration narration

### 7.4 WorkerResultPacket

worker 返回主 agent 的默认内容只能是 compact packet：

```ts
export interface WorkerResultPacket {
  schemaVersion: "octoclaw.worker_result.v1";
  delegateTaskId: string;
  attemptId: string;
  status: "completed" | "failed" | "blocked" | "timed_out" | "cancelled";
  summary: string;
  keyFindings: string[];
  changedFiles: string[];
  testsRun: string[];
  artifactRefs: string[];
  blockers: string[];
  confidence: "low" | "medium" | "high";
  metrics: {
    childInputTokens?: number;
    childOutputTokens?: number;
    resultPacketTokens?: number;
    artifactBytes?: number;
  };
}
```

约束：

1. `summary` 默认不超过 800 字
2. `keyFindings` 默认不超过 7 条
3. 完整报告写 `worker_report` artifact，不注入主会话
4. 日志写 `worker_log_excerpt` artifact，默认只保留摘要
5. 验证证据写 `verification_evidence` artifact
6. 主 agent 只有需要生成最终答案时才按 artifact ref 读取细节

### 7.5 DelegateStatusPacket

follow-up 只注入当前状态包：

```ts
export interface DelegateStatusPacket {
  schemaVersion: "octoclaw.delegate_status.v1";
  threadBindingKey: string;
  delegateTaskId: string;
  nativeFlowId: string;
  nativeTaskId: string;
  status: "planned" | "queued" | "running" | "completed" | "failed" | "timed_out" | "blocked" | "cancelled";
  attemptStatus: string | null;
  role: string;
  modelProfile: string;
  createdAt: string;
  lastEventAt: string;
  progressSummary: string;
  terminalSummary: string;
  error: string;
  retryable: boolean;
  artifactRefs: string[];
}
```

follow-up 注入规则：

1. current user ask
2. delegate status packet
3. optional thread summary
4. optional artifact refs

禁止默认注入：

1. full thread transcript
2. worker full log
3. route/delegation rationale
4. replay timeline

### 7.6 ContextBudgetReport

每次 delegation 都记录：

```ts
export interface ContextBudgetReport {
  parentContextTokensAdded: number;
  childInputTokens: number;
  childOutputTokens: number;
  injectedResultTokens: number;
  artifactBytes: number;
  artifactReopenCount: number;
  directWouldHaveEstimatedTokens?: number;
  delegationCostBand: "lower" | "similar" | "higher" | "unknown";
}
```

用它回答“派发和自己查哪个污染更少”，而不是凭感觉。

### 7.7 Sanitizer

新增 `sanitizeMainContextInjection(packet)`：

1. 删除 `[Thread history - for context]`
2. 删除内部 route/delegation rationale
3. 删除 contamination guard text
4. 删除 worker chain-of-thought / execution log
5. 超预算时只保留 status + artifact refs

### 7.7.1 Artifact 读取门

新增 `shouldOpenArtifactForMainAgent(request)`：

默认返回 false，只有下面情况返回 true：

1. 用户要求看完整报告/证据/日志
2. 主 agent 需要生成最终 user-facing answer 且 result packet 摘要不足
3. recovery/debug 需要判断失败原因
4. reviewer/verifier lane 明确需要检查证据

每次打开 artifact 都必须更新 `ContextBudgetReport.artifactReopenCount`。

### 7.8 测试

必须覆盖：

1. worker input 不包含 full transcript
2. worker result 注入主 agent 时只包含 compact packet
3. follow-up “好了吗/继续/结果呢” 只注入 DelegateStatusPacket
4. 内部 orchestration wording 不进入 user-visible reply
5. artifact ref 可按需读取完整报告
6. telemetry 记录 parent context added tokens
7. full report 被写为 `worker_report` artifact，而不是进入 main resume packet
8. context escalation 到 transcript excerpt 时必须有 `contextEscalationReason`

---

## 8. WP5：Status/Details 同源查询

### 8.1 目标

修复 dispatch 成功但 details/status not found 的类别问题。

### 8.2 查询路径

实现统一 resolver：

```ts
resolveDelegateLookup(token):
  1. token as delegateTaskId
  2. token as nativeTaskId
  3. token as nativeFlowId
  4. token as runId/childSessionKey
  5. latest by threadBindingKey
```

返回：

```ts
export interface DelegateLookupResult {
  found: boolean;
  delegateTask?: DelegateTaskProjection;
  nativeFlow?: NativeFlowRecord;
  nativeTask?: NativeTaskRecord;
  source: "native_task" | "native_flow" | "projection" | "not_found";
}
```

### 8.3 验收不变量

如果 native authority 有 task id：

1. `octoclaw_task_action details <task_id>` 必须找到
2. `octoclaw_status` 必须能显示
3. status/details 不能显示互相矛盾的状态
4. projection stale 时必须标记 stale，不得覆盖 native terminal

---

## 9. WP6：拆大文件与删冗余

### 9.1 拆分原则

先测试，后拆分，不改变行为。

### 9.2 policy-resolver 拆分

建议从 `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts` 拆出：

1. `prompt-extract.ts`
2. `route-seal.ts`
3. `judge-orchestrator.ts`
4. `policy-state-adapter.ts`
5. `runtime-truth-builder.ts`
6. `dispatch-materializer.ts`

### 9.3 tools/registration 拆分

建议从 `extensions/octoclaw-runtime/src/tools/registration.ts` 拆出：

1. `tools/schemas.ts`
2. `tools/handlers/route-hint.ts`
3. `tools/handlers/dispatch.ts`
4. `tools/handlers/task-action.ts`
5. `tools/handlers/status.ts`
6. `tools/handlers/spawn-compat.ts`

### 9.4 ACK 拆分

建议保留：

1. `ack-decision.ts`
2. `ack-template-registry.ts`
3. `ack-renderer.ts`
4. `ack-receipts.ts`
5. `ack-timing.ts`

逐步下线：

1. 大段重复 gate 判断
2. 多处各自决定 stage/action
3. 只在进程内 Map 去重的副作用路径

### 9.5 可删或降级的东西

1. route authority 里的 legacy `runner/spawn/direct/observe` 分支：删或降级为 compat normalizer
2. dispatch/status/details 各自读不同 state 的逻辑：删
3. ACK 中重复的“已最终输出”判断：收敛到 `decideAckAction`
4. 子任务完整报告默认注入主上下文：删
5. 旧 thread history 默认注入 follow-up：删

不能误删的东西：

1. runner pool / tmux workbench 的 opt-in backend 文档与 capability seam
2. OpenClaw native task/flow binding、delivery、cancel、maintenance seam
3. artifact index、context pack、worker result 等 artifact-first surfaces
4. replay/eval/golden fixtures
5. one-shot observe/reconcile/repair 兼容工具

这些不是默认 route/truth source，但仍是 runtime、operator、eval 或 fallback 能力。

---

## 10. 最小验收矩阵

### 10.1 Route

1. `reply` 简单问答不派发
2. `delegate` 复杂任务稳定 materialize native task
3. `observe` 不作为顶层 route
4. runner 缺席不改变 route
5. main agent objection 有记录，否则不得 silent override

### 10.1b Judge context coverage

1. provenance follow-up with execution receipt -> `reply.answer`
2. provenance follow-up must not call `octoclaw_dispatch`
3. provenance follow-up must not call `octoclaw_spawn`
4. memory strong cannot prove execution source
5. execution truth wins when memory and execution disagree

### 10.2 Native task/flow

1. dispatch 返回 task id
2. details 可查同一 task id
3. status 可列同一 task id
4. native terminal 状态覆盖 stale projection
5. cancellation 走 native cancel/requestCancel

### 10.3 ACK

1. 主 agent 1s 无首 token，支持 reaction 时发 reaction ACK
2. 主 agent 3s 无首 token，不支持 reaction 时发 text ACK0
3. reaction ACK0 与 text ACK0 二选一
4. first token/final/delivery suppress
5. tier nudge 不与正式答复竞争

### 10.4 Context hygiene

1. worker 不拿完整 transcript
2. main agent 不吃完整 worker log
3. follow-up 不注入完整 thread history
4. user-visible reply 不泄漏 route/delegation rationale
5. telemetry 可对比 direct vs delegate 的 parent context pollution

---
