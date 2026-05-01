# OctoClaw Judge / Dispatch / Complexity 改进设计

日期：2026-05-01  
分支：`refactor/0.4.0-stable`  
状态：N1 设计补充，等待实现  
关联：`docs/octoclaw-ts-rebuild-design-v2.md`、`docs/octoclaw-judge-ack-policy-spec-2026-04-21.md`、`docs/octoclaw-work-contract-centered-delegation-design-2026-04-25.md`

---

## 1. 问题背景

最近线上 bad case 暴露出的核心问题不是“某几个关键词没覆盖”，而是三个职责没有完全收束：

1. **judge** 有时把状态追问、执行复盘、规则核验误判成新委派任务。
2. **main agent** 在同一 turn 内可能已经读文件、解释或开始回复，之后又按 route/policy 调用 dispatch。
3. **dispatch/spawn** 入口仍更像“agent 可调用工具”，而不是“runtime 授权后的副作用动作”。

如果继续补“为啥没派发 / 没 spawn / no_dispatch_evidence / 派发失败了吗”这类短语，短期能修几个 case，但长期会变成不可维护的关键词墙，并且仍不能证明同一 turn 只有一个执行 owner。

因此本设计把问题从“补分类词表”改成：

> **judge 负责语义建议，runtime 负责副作用授权和投递一致性。**

---

## 2. 设计目标

1. 保留 judge 的主要价值：语义判断、复杂度估计、是否需要 fresh state / side effect / 长耗时执行、预期交付物说明。
2. 不让 judge 直接拥有 dispatch 权限：`route=delegate` 只是候选决策，不能直接创建任务。
3. 不靠关键词覆盖所有追问：状态/失败/来源类问题优先靠 thread anchor、WorkContract、execution receipt、dispatch ledger、TaskFlow binding 和 task-state projection 判定。
4. 默认允许主 agent 干活：简单 reply、解释、轻量本地核验不应被一堆硬门禁锁住。
5. 严格保证同一 turn 执行 owner 单一：要么 main reply，要么 delegated worker，不能同时投递用户可见 final。
6. 把 complexity 收成 canonical 字段：judge 可初判，policy 可修正，WorkContract 固化，status 只展示最终值。

---

## 3. 非目标

1. 不新增一套 live route；live route 仍只有 `reply | delegate`。
2. 不把历史 `runner / direct / spawn_single` 恢复为顶层 route authority。
3. 不把所有工具调用都硬封死；只约束会产生新委派/新 worker 的副作用入口。
4. 不做 online self-tuning；纠偏通过 replay、nightly eval、curated bad cases 和 gated promotion。
5. 不让 AGENTS/rule injection 承担 judge 规则；注入规则只负责协作宪法和 objection 协议。

---

## 4. 合理运行流程

### 4.1 输入事实包

用户消息进入 runtime 后，先构造一个不依赖关键词的事实包：

| 事实 | 来源 | 用途 |
|------|------|------|
| `deliveryTarget` | IM adapter ingress | 固定 channel/thread/reply target，后续 ACK/final/delegate completion 不再 late resolve |
| `turnActionLedger` | runtime hook | 记录本 turn 是否已有 direct tool、visible reply、route seal、dispatch attempt |
| `recentExecutionContext` | WorkContract + task-state + replay + runtime ledger | 判断当前 thread/session 是否已有 active / queued / anomalous / terminal execution，以及最近的 dispatch/spawn/result/delivery evidence |
| `executionReceipts` | dispatch/spawn/result/delivery ledger | 判断是否已有真实派发、spawn、native task、completion、delivery evidence |
| `coverage` | execution/memory coverage precheck | 判断是否可直接回答 provenance/status，或需要明确 no-verifiable-record |

这个事实包是 judge 的上下文，也是 runtime 授权的依据。它不是用户可见状态面板，也不应把 raw child transcript 注入主上下文。

#### 4.1.1 RecentExecutionContext 与关系判定

P1-3 的修复不应继续扩大 `META_PROMPT_PATTERNS` / `TASK_PROGRESS_PROMPT_PATTERNS`。关键词只能作为低置信 signal extraction，不能作为是否允许 dispatch 的最终依据。

`conversation-grounding` 应先构造 `RecentExecutionContext`，至少包含：

| 字段 | 含义 |
|------|------|
| `has_recent_execution` | 当前 delivery target / thread / session 是否能找到最近 WorkContract、task-state record、dispatch receipt 或 runtime ledger row |
| `work_contract_id` / `delegate_task_id` / `attempt_id` | 能绑定到的最近执行身份；没有时为空 |
| `execution_verdict` | `registered`、`queued`、`blocked`、`running`、`no_dispatch_evidence`、`spawn_not_confirmed`、`completion_orphaned`、`binding_mismatch`、`deliverable_ready`、`delivered`、`failed` 等 compact verdict |
| `dispatch_executed` / `spawn_executed` / `result_materialized` / `delivered` | 真实证据位，不得从 route seal 或自然语言推断 |
| `latest_anomaly` | 最近异常原因，例如 `no_dispatch_evidence`、`spawn_not_confirmed`、`parent_session_busy`、`ledger_unavailable` |
| `allowed_control_tools` | 可用于刷新事实的只读/控制面工具，例如 `octoclaw_status`、`octoclaw_task_action` |

然后由一个轻量关系判定器输出 `relation_to_recent_execution`：

```text
existing_execution_status_query
existing_execution_failure_reason_query
existing_execution_provenance_query
existing_execution_amendment
new_work
ambiguous
```

实现边界：

1. 前三类统一映射到现有 `intent_class=execution_followup`、`route_hint=reply`、`lane_hint=control_observer`、`require_state_grounding=true`，继续复用现有 `policy-resolver` / `ticket` / `dispatch` 防线。
2. `existing_execution_amendment` 进入 amendment protocol，判定 `steer_child | queue_after | cancel_and_respawn | reply_status_only`，不能直接当新独立任务派发。
3. 只有 `new_work` 才允许继续申请 delegation ticket；且仍必须满足 `is_new_work=true`、`expected_deliverable` 非空、single-owner 未被破坏。
4. `ambiguous` 不得直接 dispatch；应 clarify，或在有执行事实但关系不清时 reply 一个 state-grounded status/no-verifiable-record。

这不是新增一条平行 route，而是把现有 `conversation-grounding -> policy-resolver -> ticket -> dispatch` 的第一层从关键词判断升级为“最近执行事实 + 当前 turn 关系”。

### 4.2 Judge 输出结构

judge 仍然是主语义判断来源，但输出必须从“只给 route”升级为结构化建议：

```json
{
  "route": "reply | delegate",
  "is_new_work": true,
  "needs_side_effect": true,
  "needs_fresh_state": false,
  "expected_deliverable": "修复并验证 runtime dispatch 授权",
  "complexity": "simple | normal | deep",
  "duration_hint": "instant | short | long",
  "tool_need_hint": "none | read_only | write_or_exec | network_or_external",
  "confidence": 0.84,
  "reason_codes": ["requires_code_change", "needs_tests"]
}
```

关键点：

- `route=delegate` 不等于允许 dispatch。
- `is_new_work` 必须表示“需要创建新的执行单元”，不是“这句话提到了派发/状态/失败”。
- `expected_deliverable` 必须可验收；没有交付物的 delegate 倾向应降级为 reply。
- `complexity` 是 judge proposal，不是展示真相。

### 4.3 Runtime 薄授权

runtime 不做大词表语义分类，只做四个通用一致性校验：

1. **新工作校验**：`route=delegate` 但 `is_new_work=false`，降级为 `reply`。
2. **交付物校验**：`route=delegate` 但没有清晰 `expected_deliverable`，降级为 `reply`。
3. **单 owner 校验**：本 turn 已经发生用户可见 reply 或 direct action，撤销 delegation eligibility；后续 dispatch 只能返回状态/拒绝包。
4. **sealed delegate 校验**：dispatch 成功后，main agent 不能再 direct read/direct final 抢答；只能协调、查询状态或等待 completion relay。

这些规则不是关键词门禁，而是执行一致性边界。它们不会阻止主 agent 做普通 reply，也不会要求每个简单问题都先走 route_hint。

### 4.4 Delegation Ticket

`octoclaw_dispatch` / `octoclaw_spawn` 应改为只接受 runtime 铸造的一次性派发票据：

```json
{
  "ticket_id": "dt_...",
  "turn_id": "turn_...",
  "session_key": "...",
  "delivery_target_id": "...",
  "work_contract_id": "wc_...",
  "route": "delegate",
  "new_work_contract": true,
  "expected_deliverable": "...",
  "complexity_final": "normal",
  "expires_at": "2026-05-01T10:00:30.000Z",
  "single_use": true
}
```

授权规则：

- 没有 ticket：dispatch 不创建任务，只返回 `dispatch_not_authorized` 状态包。
- ticket 过期：不创建任务，返回 `ticket_expired`。
- ticket 已用：不创建任务，返回 `ticket_already_used`。
- ticket 被撤销：不创建任务，返回 `ticket_revoked`，并带撤销原因。
- ticket 与 turn/session/WorkContract 不匹配：不创建任务，返回 `ticket_scope_mismatch`。

这样即使 judge 或 main agent 偶尔误触发 dispatch，也不会产生新 WorkContract 或子任务。

### 4.5 状态/失败追问路径

状态、失败、来源、投递异常、规则注入核验这类问题的默认路径是：

```text
user follow-up
  -> resolve deliveryTarget/thread/session anchors
  -> build RecentExecutionContext from WorkContract/task-state/replay/runtime ledger
  -> classify relation_to_recent_execution
  -> if existing_execution_status_query / failure_reason_query / provenance_query:
       map to existing execution_followup control-observer
  -> build control-observer fact packet
  -> main agent reply with facts or no-verifiable-record
```

这里可以有少量 deterministic hint，例如精确命令 `状态面板` / `八爪鱼状态` 直接展示面板；但自然语言追问不应靠包含词直接触发脚本，也不应创建新委派任务。稳定性来自“没有 `new_work` relation 就拿不到 delegation ticket”，而不是来自穷举“为什么没派发 / 怎么没 spawn / no_dispatch_evidence”这类短语。


### 4.6 2026-05-01 07:53 事件复盘要点

本节记录 07:53 前后线上对话暴露出的 N1 具体 failure mode，作为后续实现验收样例。

#### 4.6.1 Completion 写错路径导致 result 无法物化

证据链：

1. native task `0f4a5640-377b-4141-a3b3-ad290aba893f` 已 materialized，task-state archive 里记录 `dispatchExecuted=true`、`spawnExecuted=true`、`childSessionKey=agent:main:subagent:96ccb18f-...`、`status=running`。
2. 子 session 实际完成了任务并写出 completion，但 prompt 中 `workContractId` 为空，要求写入的路径是 `~/.openclaw/workspace/.octoclaw/completions/.completion.json`。
3. 该 completion 内容 `status=success`，但 `workContractId=""`，因此不能和 native task `0f4a5640...` 或 WorkContract 绑定。
4. 后续 status/replay 只看到 native task 仍 `running`、`resultMaterialized=false`、`artifactRefIds=[]`，于是反复产生 `heartbeat_stale`，最终被 stale active retention 归档。
5. 后来另一个任务 `wc-08eafe163ea33d89` 通过人工式调查找到了这个 orphan completion，并把真实结果写进自己的 completion；这证明原任务是“完成事实丢失”，不是“worker 未执行”。

根因不是 timeout 阈值，也不是 status 面板渲染；根因是 **dispatch materialization 没有建立不可为空、可校验、单调绑定的 completion target**。

必须补的 invariant：

- 每个 delegated WorkContract 必须有非空 `workContractId`。
- completion path 必须是 deterministic task-specific path，例如 `completions/<workContractId>.completion.json` 或绑定到 `nativeTaskId` 的等价路径。
- child prompt 中的 `workContractId`、`delegateTaskId`、`nativeTaskId`、`childSessionKey`、`completionPath` 必须互相一致。
- finalizer 读取 completion 时必须校验这些字段；不一致时进入 `completion_orphaned` / `binding_mismatch`，不能静默继续显示 `running/result=none`。
- orphan completion scanner 应能按 `childSessionKey`、`delegateTaskId`、session log、mtime 找回 completion，并生成 recovery candidate；人工或自动确认后再 materialize result。

#### 4.6.2 Running / timed_out / result=none 的状态错觉

同一个任务在不同投影里出现 `running`、`timed_out`、`result=none`，不是三套真相都有效，而是缺少 canonical verdict：

```text
native task lifecycle: running/stale/timeout candidate
worker completion fact: success file exists but binding invalid
OctoClaw projection: result not materialized because completion orphaned
user-facing verdict: completion_orphaned, needs reconciliation
```

N1 状态面应该优先展示这种 compact verdict，而不是把 native running 和 Octo result=none 混成“没跑完”。建议新增状态：

| Verdict | 含义 | 用户可见解释 |
|---------|------|--------------|
| `completion_orphaned` | 找到 completion，但 WorkContract/native binding 不匹配 | 任务可能已完成，结果待回收/确认 |
| `binding_mismatch` | completion 字段与派发登记不一致 | 任务结果不能自动入账，需要修复绑定 |
| `stale_running` | 无 completion，心跳/更新时间超过阈值 | 执行进度停滞，等待 probe/timeout |
| `timeout_no_result` | 超时且无 completion/recoverable evidence | 任务失败或丢失，需要 retry |
| `deliverable_ready` | result 已物化但 delivery 未成功 | 可交付，正在重试投递 |

#### 4.6.3 主会话锁不应阻塞独立 dispatch

07:53 对话里主 agent 的分析提到：主会话等待第一个任务时，后续 dispatch 可能因锁占用只注册、不真正 materialize。这类行为必须视为 scheduler/materialization bug。

设计口径：

- main turn lock 只能保护同一 turn 的 transcript/delivery 一致性，不能作为全局 worker spawn 锁。
- dispatch materialization 应进入独立 scheduler queue，由 WorkContract scope、写域、资源、依赖关系决定并发或排队。
- 独立任务应可并发 spawn；有依赖或写域冲突的任务应显式 `queued_after=<taskId>` 或 `blocked_by=<resource>`。
- 如果 host/backend 当前不支持并发，必须返回 `blocked` / `queued` 状态和原因，不能伪装成 `spawn_confirmed`，也不能 silent no-op。
- `spawn_confirmed=true` 必须意味着有 current native task/session/process evidence；仅注册 WorkContract 不得叫 spawn confirmed。

#### 4.6.4 补充修改不是新任务默认值

对正在运行或刚完成的任务补充要求时，N1 需要 amendment protocol，而不是靠 prompt 相似度或重新 dispatch：

| 判定 | 条件 | 行为 |
|------|------|------|
| `steer_child` | 补充信息不改变交付目标，child 仍 running 且可接收输入 | 向同一 child/session 追加 steer message |
| `queue_after` | 修改 scope，但已有产出仍有价值或当前阶段不宜打断 | 在同一 delegate task 下创建 queued amendment attempt |
| `cancel_and_respawn` | 目标/写域/约束冲突，继续跑会产生错误结果 | 取消当前 attempt，带原因创建新 attempt |
| `reply_status_only` | 用户只是问状态/失败/来源 | 不新建任务，直接用 ledger/projection 回复 |

判定依据必须来自 WorkContract scope、读写集、当前阶段、child continuity、结果是否已 materialized、语义差异和用户显式要求；不能只靠关键词。

---

## 5. Complexity 判定与归一

### 5.1 职责分工

| 层 | 字段 | 职责 |
|----|------|------|
| judge | `complexity` | 语义初判：任务理解难度、执行步骤、风险 |
| policy resolver | `complexity_final` | 合并 judge、tool need、duration、side effect、freshness、scope 后给最终值 |
| WorkContract | `complexity_final` / `complexity_reason_codes` | canonical truth，后续 dispatch、worker brief、status 都读这里 |
| task-state / status | `complexity_final` | 只展示 WorkContract 投影，不从 replay/native task/judge metadata 混读 |
| replay/nightly | `complexity_proposed` vs `complexity_final` | 评估 judge 漂移和 policy override 是否合理 |

### 5.2 推荐标签

为避免标签太细导致不稳定，热路径只保留三档：

| 标签 | 含义 | 默认 owner |
|------|------|------------|
| `simple` | 可直接回复或轻量只读核验，通常不需要新 WorkContract | main reply |
| `normal` | 有明确交付物，可能需要工具/文件/网络/短测试 | 视 side effect / duration 决定 reply 或 delegate |
| `deep` | 多步骤、长耗时、写操作、测试/部署/可恢复交付 | delegate |

如果需要更细粒度成本控制，另设 `budget_class` 或 `duration_hint`，不要把复杂度标签膨胀成十几档。

### 5.3 Policy override 原则

policy 可以修正 judge complexity，但必须记录原因：

- judge 说 `simple`，但 `needs_side_effect=true` 或 `tool_need_hint=write_or_exec`：升为 `normal/deep`。
- judge 说 `deep`，但 `is_new_work=false` 且已有可回答 ledger：降为 `simple`，route 为 reply。
- judge 缺失 `complexity`：标 `unknown_proposed`，policy 根据 schema 兜底为 `normal` 或 `simple`，并写 degraded reason。
- status panel 只展示 `complexity_final`；debug/raw 才展示 proposed/final diff。

---


## 6. Scheduler Protocol 与状态存储设计

实施级 schema、迁移步骤、OpenSpec work packet 和验收矩阵见 `docs/octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md`。


### 6.1 当前存储事实

本机 OpenClaw 已有两个原生 SQLite 存储：

| 路径 | 表 | 权威范围 |
|------|----|----------|
| `~/.openclaw/flows/registry.sqlite` | `flow_runs` | 原生 TaskFlow / flow lifecycle：`flow_id`、`status`、`revision`、`blocked_task_id`、`state_json`、`wait_json` |
| `~/.openclaw/tasks/runs.sqlite` | `task_runs`、`task_delivery_state` | 原生 task run lifecycle：`task_id`、`runtime`、`owner_key`、`parent_flow_id`、`child_session_key`、`status`、`delivery_status`、`progress_summary`、`terminal_summary` |

OctoClaw 当前还维护 `tmp/octopus/task-state.json`、`task-events.jsonl`、`runtime-policy-replay.jsonl` 等文件。旧 4.4 设计把 `task-state.json` 定义为唯一 OctoClaw business-state store，这对早期“单 worker、低并发、易读 status”是可行的，但 N1 的并发/排队/重试/修复需要事务、lease、compare-and-swap 和 crash recovery，单 JSON 文件不再适合作为 scheduler truth。

### 6.2 存储取舍

结论：

1. **不直接改 OpenClaw 原生 DB schema**。`flows/registry.sqlite` 和 `tasks/runs.sqlite` 是 substrate owned store，OctoClaw 优先通过 OpenClaw runtime bridge/API 读取或同步 native lifecycle；直接 DB 读取只能作为有 schema guard 的只读诊断 fallback。
2. **OctoClaw 新增自己的 transactional runtime ledger**，建议 SQLite：`~/.openclaw/workspace/.octoclaw/runtime/octoclaw-runtime.sqlite`。它拥有 WorkContract、delegation ticket、scheduler queue、attempt、completion binding、delivery outbox、amendment 和 recovery verdict；实现上优先使用 Node 内置 `node:sqlite`，不要为 N1 引入新的 native SQLite 依赖。
3. **`task-state.json` 降为 read-model snapshot / compatibility projection**。status 面、简单工具和人工排障可以继续读它，但它必须能从 OctoClaw ledger + OpenClaw native DB + replay 重建；它不再承担并发调度的唯一写入真相。
4. **JSONL 继续做 audit log，不做调度锁**。`task-events.jsonl` / `runtime-policy-replay.jsonl` 适合审计、回放、nightly eval；不适合承载 queue pop、lease acquire、attempt transition 这类需要原子性的操作。

如果暂时不引入 SQLite 依赖，也必须至少做到：单 writer actor + append-only log + atomic snapshot + file lock + revision CAS。但这只是过渡方案；N1 正式目标应是 SQLite ledger。

### 6.3 OctoClaw runtime ledger 最小表

建议最小 schema：

| 表 | 主键 | 用途 |
|----|------|------|
| `work_contracts` | `work_contract_id` | canonical WorkContract、route、expected deliverable、complexity_final、deliveryTarget |
| `delegation_tickets` | `ticket_id` | 一次性 dispatch 授权，绑定 turn/session/WorkContract，记录 issued/used/revoked/expired |
| `task_attempts` | `attempt_id` | 每次 spawn/respawn/retry/queued amendment attempt，关联 native task/flow/session/run |
| `scheduler_queue` | `queue_id` | queued/blocked/running lease、priority、dependency、resource locks、wake condition |
| `resource_locks` | `resource_key` | 写域/资源 lease，带 holder attempt、expires_at、revision |
| `completion_bindings` | `completion_id` | deterministic completionPath、expected ids、observed ids、binding verdict、orphan recovery |
| `delivery_outbox` | `delivery_id` | final/ACK/progress delivery attempts、retry、thread target、sent proof |
| `amendments` | `amendment_id` | steer/queue-after/cancel-respawn/status-only 判定和证据 |
| `runtime_events` | autoincrement | append-only event log，用于重建 projection 和 nightly |

`task-state.json` 由这些表投影生成：

```text
OpenClaw native DBs + OctoClaw runtime ledger + replay tail
  -> observer snapshot
  -> task-state.json compatibility projection
  -> status/details/queue/timeline
```

### 6.4 Scheduler 状态机

Scheduler 不应该把 dispatch 当同步工具调用，而应是状态机：

```text
admitted
  -> queued | blocked | spawning
  -> running
  -> deliverable_ready
  -> delivered | delivery_retry
  -> completed

terminal failure:
  -> canceled | failed | timeout_no_result | completion_orphaned | binding_mismatch
```

关键字段：

| 字段 | 含义 |
|------|------|
| `queue_status` | `admitted | queued | blocked | spawning | running | terminal` |
| `dependency_ids` | 必须完成后才能运行的 WorkContract/attempt |
| `queued_after` | 用户可见的直接前序任务 |
| `blocked_by` | 资源、写域、host capability、model cooldown 或 manual approval |
| `resource_keys` | 写域/仓库路径/IM thread/native session 等资源锁 |
| `lease_owner` / `lease_expires_at` | materializer 持有的短租约，crash 后可回收 |
| `revision` | CAS 版本，避免两个 materializer 同时 pop 同一任务 |
| `wakeup_at` / `wakeup_reason` | retry、dependency completion、lock expiry、manual approve |

### 6.5 并发与排队规则

#### 独立任务并发

任务满足以下条件时可并发 materialize：

- 不共享 exclusive `resource_key`。
- 没有显式 `depends_on` / `queued_after`。
- WorkContract 写域不冲突，或都是 read-only。
- backend capacity 未超过 `max_concurrent_spawns`。
- 模型/账号/host 没有 cooldown 或全局限流。

#### 依赖任务排队

以下情况必须排队：

- 用户明确说“等 A 完成后再做 B”。
- B 需要 A 的 artifact/result。
- B 修改 A 正在写的文件或同一 resource scope。
- B 是同一 delegate task 的 amendment attempt，且当前 attempt 不能 steer。

排队结果必须写入 ledger 和 status：`queued_after=<attemptId|workContractId>`，不能只写自然语言解释。

#### 资源冲突 blocked

以下情况是 blocked，不是 queued-after：

- host/backend 不支持并发 spawn。
- 模型/credential cooling down。
- manual approval required。
- workspace lock 被非本任务持有且无法确定释放顺序。
- native DB/API 暂不可用。

blocked 必须带 `blocked_by`、`retry_after` 或 `manual_action`。

### 6.6 Dispatch 返回语义

`octoclaw_dispatch` 返回必须区分：

| 返回 | 含义 |
|------|------|
| `registered` | WorkContract/ticket 入账，但尚未调度 |
| `queued` | 已进入 scheduler queue，有明确 wake condition |
| `blocked` | 暂不能调度，有明确原因和重试/人工动作 |
| `spawning` | 已获得 lease，正在创建 native task/session |
| `spawn_confirmed` | 已有 native task/session/process evidence |
| `rejected` | ticket 无效、scope mismatch、不是新工作或已被撤销 |

`spawn_confirmed=true` 只能对应 `spawn_confirmed`，不能拿 `registered/queued/blocked` 伪装。

### 6.7 Crash recovery

重启恢复顺序：

1. 读 OctoClaw runtime ledger 中非 terminal attempts 和 queue rows。
2. 对每个 attempt 通过 OpenClaw bridge/API 读取 native lifecycle；如桥接能力缺失，才使用只读 schema-guarded diagnostic adapter 查询 `flow_runs`、`task_runs`。
3. Probe deterministic completion path 和 orphan candidates。
4. 过期 lease 释放回 queue；native 已 terminal 但 Octo 未 materialized 的进入 finalizer；completion mismatch 进入 recovery verdict。
5. 重新生成 `task-state.json` snapshot 和 status projection。

验收：杀掉 OpenClaw/OctoClaw 进程后重启，active/queued/blocked/running/deliverable_ready 状态不能丢，不能把 active 任务静默变成空状态。

---

## 7. 纠偏机制

每次 route/dispatch 需要写 replay outcome：

```json
{
  "judge_route": "delegate",
  "final_route": "reply",
  "judge_is_new_work": false,
  "dispatch_ticket": "not_issued",
  "override_reason": "delegate_without_new_work",
  "complexity_proposed": "deep",
  "complexity_final": "simple",
  "user_visible_owner": "main_agent",
  "duplicate_delivery_prevented": true
}
```

nightly eval 重点看：

1. `false_delegate`：本应 reply 却生成 delegate ticket。
2. `false_reply`：本应 delegate 却没有 ticket，导致主 agent 低质量硬答。
3. `duplicate_owner`：同一 turn 同时出现 main final 和 delegate completion。
4. `ticket_denied_after_direct_action`：主 agent 抢跑后 dispatch 被拒的频率。
5. `complexity_drift`：judge complexity 与 final complexity 长期偏差。

纠偏顺序：

```text
bad case replay
  -> judge prompt/schema 调整
  -> validator assertion 调整
  -> focused test
  -> shadow/nightly baseline
  -> gated live promotion
```

不要把单个 bad case 直接固化成 live keyword rule。

---

## 8. 实现建议

### S1：只记录，不改变 live 行为

- 在 route decision 中记录 `is_new_work`、`expected_deliverable`、`complexity_proposed`。
- 在 WorkContract 中新增或规范 `complexity_final`、`complexity_reason_codes`。
- 在 replay 中记录 judge proposal 与 policy final 的 diff。

### S2：ticket dry-run

- policy 生成 `delegation_ticket_candidate`，但 dispatch 仍兼容旧调用。
- replay 记录“如果强制 ticket，这次 dispatch 是否会被允许”。
- nightly 统计 false deny / false allow。

### S3：ticket enforced for new dispatch

- `octoclaw_dispatch` / `octoclaw_spawn` 对新任务强制 ticket。
- ticket 必须携带非空 `workContractId`、`delegateTaskId`、`nativeTaskId` 或 native binding candidate、`childSessionKey`、deterministic `completionPath`。
- 旧恢复/兼容路径必须显式标注 legacy，并有关闭计划。
- dispatch denial 返回可回复状态包，不 silent fail。

### S4：completion binding 与 orphan recovery

- finalizer 只接受 task-specific completion path；`.completion.json` 这类无 owner 路径必须拒绝或标记为 orphan。
- completion 字段与 WorkContract/native binding 不一致时，写 `completion_orphaned` / `binding_mismatch` projection，不继续显示普通 running。
- orphan scanner 按 `childSessionKey`、`delegateTaskId`、session log、mtime 生成 recovery candidate；恢复成功后补 replay event 和 result materialization。
- stale/timeout 判定前必须先 probe completion path、orphan candidates 和 child session terminal state。

### S5：scheduler / dependency / amendment protocol

- dispatch materialization 与 main turn lock 解耦；main lock 只保护 transcript/delivery，不阻塞独立 spawn。
- scheduler 根据 WorkContract scope、写域、资源和显式依赖决定 `running`、`queued_after`、`blocked_by`。
- `spawn_confirmed` 只能在 native task/session/process evidence 存在时返回 true。
- task amendment 固化为 `steer_child` / `queue_after` / `cancel_and_respawn` / `reply_status_only`，并写入 durable projection。

### S6：status 与复杂度收口

- status 默认只展示 delegate 摘要和 `complexity_final`。
- raw/debug 才展示 proposed/final、judge confidence、override reason。
- 不从 native task、policy cache、replay 自行拼复杂度展示。

---

## 9. 验收标准

1. “为什么刚才自己回复一次又派发一次”不创建新 WorkContract；主 agent 用 ledger 解释。
2. “AGENTS/rule 是否更新”如果只是核验当前规则注入，不创建 delegate；需要文件修改时才可能生成 ticket。
3. judge 误判 `delegate` 但 `is_new_work=false` 时，最终 route 为 reply，并记录 override。
4. main agent 已经 direct action 后再调用 dispatch，dispatch 返回 `ticket_revoked` 或 `dispatch_not_authorized`，不 spawn。
5. dispatch 成功后，main final 被静默或转为 coordinator/status，不与 delegate completion 双投递。
6. completion 写到错误路径或 `workContractId` 为空时，状态进入 `completion_orphaned` / `binding_mismatch`，并能通过 orphan scanner 找回候选结果；不能继续普通显示 `running/result=none`。
7. main turn lock 占用时，独立任务仍可并发 materialize；有依赖/写域冲突时显示 `queued_after` 或 `blocked_by`，不能 silent no-op。
8. 补充修改能稳定落到 `steer_child`、`queue_after`、`cancel_and_respawn`、`reply_status_only` 之一。
9. status panel 的复杂度来自 WorkContract canonical projection，不展示多个互相冲突的 complexity 来源。
10. nightly report 能看到 judge proposal、policy final、ticket allow/deny、复杂度漂移、completion orphan recovery、scheduler queue 和 duplicate-owner 防护结果。

---

## 10. 与现有文档的关系

- 本文补充 `octoclaw-ts-rebuild-design-v2.md` 的 N1 委派稳定化设计。
- `octoclaw-judge-ack-policy-spec-2026-04-21.md` 仍是 judge label 和 ACK/policy spec 的基础；后续应把 `is_new_work`、`expected_deliverable`、`complexity_final` 纳入 schema。
- `octoclaw-work-contract-centered-delegation-design-2026-04-25.md` 仍是 WorkContract 委派合同基础；后续应把 delegation ticket 作为 WorkDecisionSeal 到 dispatch materialization 的桥。
- `octoclaw-state-convergence-4-4-design.md` 仍是状态真相边界；本文要求状态追问只读其 canonical projection，不再通过新委派解释旧任务。
- `octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md` 是本文的实施包，包含 SQLite schema、分步 rollout、验收矩阵和 OpenSpec 模板。
