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

---

## 3. 推荐落地顺序

按下面 6 个 work package 做。不要一次性大重构。

1. WP1：route sealing 与 keyword/rule 去权威化
2. WP2：OpenClaw `TaskFlowPort` 与 truth-source 收敛
3. WP3：ACK 简化与首回应体验修正
4. WP4：派发上下文污染治理
5. WP5：状态面/details/status 同源查询
6. WP6：大文件拆分与冗余清理

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

## 5. WP2：OpenClaw TaskFlowPort

### 5.1 目标

把当前对 OpenClaw dist bundle 的扫描桥降级为 fallback，主路径改为 OpenClaw runtime 注入。

OpenClaw `v2026.4.21` 已提供正式 runtime seam：

1. `api.runtime.taskFlow.bindSession({ sessionKey, requesterOrigin })`
2. bound runtime 支持 `createManaged/get/list/findLatest/resolve/getTaskSummary`
3. bound runtime 支持 `setWaiting/resume/finish/fail/requestCancel/cancel/runTask`

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

---

## 10. 最小验收矩阵

### 10.1 Route

1. `reply` 简单问答不派发
2. `delegate` 复杂任务稳定 materialize native task
3. `observe` 不作为顶层 route
4. runner 缺席不改变 route
5. main agent objection 有记录，否则不得 silent override

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

## 11. 给执行 AI 的任务话术

```text
你在 /Users/guan/Documents/New project/OctoClaw-release-0.3.0-ts-rebuild 工作。
请按 docs/octoclaw-ts-rebuild-gap-closure-implementation-plan-2026-04-24.md 执行整改。

先做 WP1-WP4，不要一次性重写全部：
1. 加 RouteSeal contract 和 resolveCurrentRouteSeal，保证当前 turn 的 delegate 不会被旧 state 降成 reply。
2. 加 TaskFlowPort，主路径使用 OpenClaw plugin runtime taskFlow 注入；现有 dist scanning bridge 只能 fallback。
3. 简化 ACK：新增 decideAckAction，支持 reaction ACK 和 text ACK0 二选一，主 agent 无首 token 时可快速安抚。
4. 加 DelegateHandoffPacket / WorkerResultPacket / DelegateStatusPacket，禁止默认注入完整 transcript、worker log 和 route/delegation rationale。

每一步都先补测试，再改实现。保持顶层 route 只有 reply | delegate。不要新增 Python。不要把 runner 恢复成 route。完成后跑：
pnpm run check
pnpm test
```
