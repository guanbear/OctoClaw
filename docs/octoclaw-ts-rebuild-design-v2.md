# OctoClaw TS 重构设计 v2（重写版）

日期：2026-05-01
分支：`refactor/0.4.0-stable`
代码基线：`refactor/0.4.0-stable`（N0 文档收口后校准点：`53b6e6c`）
状态：current architecture baseline + next work plan
替代：2026-04-15 的 `OctoClaw TS 重构设计 v1`

> 2026-05-09 更新：`v0.5.0` 已执行 runtime convergence cleanup。planner/native path 不再使用 completion file、child-finalizer、JSON delivery outbox、`octoclaw_spawn`、`runtime.subagent.run()` fallback 或 fake detached runtime。详细模块图见 [`octoclaw-architecture-map-2026-05-09.md`](./octoclaw-architecture-map-2026-05-09.md)，仓库债务边界见 [`octoclaw-repo-debt-cleanup-plan-2026-05-09.md`](./octoclaw-repo-debt-cleanup-plan-2026-05-09.md)。

---

## 0. 这份重写版回答什么

原 v1 文档写在 TS 重构启动期，它的主要价值是判断“要不要从旧 Python/JS 运行面迁到 TypeScript、如何切分 runtime / policy / harness”。到 `refactor/0.4.0-stable`，这些问题已经不再是未来计划，而是大部分已经落进代码。

这份重写版只回答当前还真正有用的四个问题：

1. 现在 OctoClaw 的系统定义和架构边界是什么。
2. 原 v1 中哪些设计已经完成，哪些已经演进，哪些应该废弃。
3. 当前代码里的权威模型、状态真相和运行路径如何理解。
4. 接下来应该按什么顺序继续做。

当代码、本文、其他文档和历史规划冲突时，优先级如下：

```text
refactor/0.4.0-stable 代码
  > 本文
  > docs/ 下较新的活跃设计文档
  > docs/archive/ 和旧分支历史规划
```

本文不是外部宣传页，也不是逐行实现手册。它是维护者做后续开发、删旧路径、补测试和判断优先级时的设计基线。

---

## 1. 当前一句话定义

OctoClaw 现在不是“准备重写的旧系统”，而是：

> **OpenClaw 之上的 TypeScript-first 执行策略层、委派 harness、反馈闭环和 IM/operator 控制面。**

更具体地说：

- OpenClaw 继续负责 substrate：native task、TaskFlow、session、runtime extension 接入。
- OctoClaw 负责 policy：意图分类、route seal、WorkContract、模型/角色/worker pool 映射。
- OctoClaw 负责 delegation harness：dispatch、managed TaskFlow binding、worker handoff、native spawn intent/confirm、runtime metadata ledger 和状态投影。
- OctoClaw 负责 feedback loop：replay、nightly、review、curate、validate、promote。
- OctoClaw 负责 IM/operator surface：Slack/Feishu/WeChat adapter、status/details/queue/timeline、`octoclawctl`。

所以后续目标不再是“大爆炸式 TS 重写”，而是：

> **把已经能跑的 TS runtime 收成更轻、更稳、更少历史歧义的正式产品面。**

---

## 2. 最重要的术语修正

### 2.1 live route 只有 `reply | delegate`

当前代码权威是 `packages/octoclaw-policy/src/route/index.ts`：

```ts
export const LIVE_PHASE_TWO_ROUTES = ["reply", "delegate"] as const;
```

因此后续文档和实现必须把下面两层拆开：

| 层级 | 权威字段 | 作用 |
|------|----------|------|
| live route | `reply | delegate` | 主线程是直接回复，还是进入委派执行 |
| execution contract / lane | `direct / runner / spawn_single / spawn_multi / observe / session_control` | 委派或控制面内部如何执行、如何展示、如何兼容旧语义 |

`direct / runner / spawn_single / spawn_multi` 可以继续存在，但它们不是新的 live route authority。它们应该是 Auto Router 或 runtime policy 输出的 execution contract，再映射到 `reply | delegate`。

这个修正会反过来影响现有少量文档：如果文档把 `direct / runner / spawn_single / spawn_multi` 写成顶层 route，应按本文解释为 execution contract 或兼容视图。

### 2.2 四类角色的当前边界

| 角色 | 当前定义 | 不应该承担的事 |
|------|----------|----------------|
| Observer | 只读 read-model / status / details / timeline 查询 | 不派发新任务，不当执行者 |
| Runner | 委派任务的 worker / execution lane | 不当状态真相源，不当第二控制平面 |
| Patrol | detect / reconcile / notify / bounded recovery | 不当主生命周期引擎，不暗中自动重跑 |
| Ctl | `octoclawctl` 和 session control 操作面 | 不绕过 runtime contracts 改状态 |

代码内部仍会出现 `worker_pool`、`observer_probe`、`control_observer`、`session_control` 等实现名；面向设计判断时，用上表边界。

---

## 3. 当前代码架构

### 3.1 Monorepo 结构

当前 TS monorepo 的核心单元已经收成四个包/扩展和一个工具入口：

| 单元 | 职责 |
|------|------|
| `packages/octoclaw-contracts` | WorkContract、delegate/result/event/delivery/status/thread binding 等稳定合同 |
| `packages/octoclaw-policy` | intent、judge schema、route、role、model profile、gate、compound/capability/admission |
| `extensions/octoclaw-runtime` | OpenClaw runtime extension、hooks、dispatch materialization、ACK、IM、delivery、replay、state |
| `extensions/octoclaw-status-surface` | status/details/queue/timeline 的 read model 和 renderer |
| `tools/octoclawctl` | install/update/deploy、enable/disable、status、nightly、review、curate、calibration gate |

`tools/install` 和 `tools/manage` 已降级为 deprecated README，不再是 workspace package。`packages/octoclaw-runtime-core` 也不再存在，runtime core 已并入 `extensions/octoclaw-runtime/src/core/*`。

### 3.2 当前主路径

```text
user turn
  -> intent / conversation grounding / execution coverage / memory coverage
  -> local rules + optional judge
  -> validator
  -> WorkDecisionSeal
  -> WorkContract
  -> route commit ACK
  -> reply path OR delegate path
```

`reply` 路径：

```text
reply.answer / reply.clarify / status_summary
  -> evidence-grounded response
  -> no new execution unit
```

`delegate` 路径：

```text
octoclaw_dispatch
  -> WorkContract + NativeSpawnIntent persisted in SQLite metadata ledger
  -> sessions_spawn args
  -> octoclaw_dispatch_confirm binds accepted run evidence
  -> worker handoff packet
  -> OpenClaw native TaskFlow lifecycle
  -> native announce / channel delivery
  -> generated task-state status projection
```

### 3.3 当前状态真相

| 层级 | 当前作用 | 约束 |
|------|----------|------|
| OpenClaw native TaskFlow | execution lifecycle truth | `running / waiting / completed / failed / cancel` 等生命周期事实优先相信 substrate |
| WorkContract | semantic / handoff / continuity truth | route、role、scope、allowed tools、model profile、child session continuity 都必须可恢复 |
| SQLite runtime ledger | OctoClaw metadata / audit truth | WorkContract、route seal、native refs、spawn intent、runtime events 从这里恢复 |
| `task-state.json` | generated read-model cache / status projection | 可删除、可重建；不能当 WorkContract 正常 read path |
| `policyState` | per-turn cache | 只能做 ACK guard、route-hint/dispatch guard、prompt correlation；不能当跨 turn 状态真相 |
| replay log | observability / evaluation event log | 不能反向成为 runtime 行为真相 |

当前最重要的工程规则：

> **凡是用户可见、重启后仍应成立的状态，必须先写入 durable projection，再被 IM/status/operator surface 展示。**

---

## 4. 原 v1 设计的状态

### 4.1 已完成或基本完成

| v1 主题 | 当前状态 |
|---------|----------|
| TS/Node 成为 live path 主语言 | 已落地：contracts/policy/runtime/status/ctl 均为 TS |
| Python 退出 live authority | 基本完成：Python 不再是 route/status 真相；后续只应做 compat/offline |
| `reply | delegate` 顶层 route | 已落地于 `@octoclaw/policy` 和 runtime helper |
| WorkContract-centered delegation | 已落地：WorkContract、route seal、coverage、continuity、SQLite metadata store + status projection |
| OpenClaw native TaskFlow integration | 已落地：managed binding、adapter、bridge、native helper、planner/confirm |
| ACK 独立和状态门控 | 已落地：ACK guard、ACK timing、route commit ACK、delegate tier suppression |
| progress / final 分离 | 已落地：execution-transition-notifier、native announce/channel delivery、status projection |
| artifact / packet first | 已落地一部分：delegate packets、worker brief/result/completion，不再默认 raw transcript |
| replay / nightly / calibration gate | 已落地：`octoclawctl nightly/review/curate/nightly-eval/promote` |
| IM adapter registry | 已落地：Slack、Feishu L1、WeChat L0，含 L1/L0 降级 |
| unified install tool | 已落地：`octoclawctl install/update/deploy/enable/disable` 与 `~/.octoclaw/config.json` |

### 4.2 `archive/octoclaw-next-phase-roadmap-2026-04-30.md` 合并后的阶段状态

`archive/octoclaw-next-phase-roadmap-2026-04-30.md` 的核心判断已合入本文：**Auto Router 不是早期优先级；必须先有可证明的状态、耗时、成本、交付和回归基线，再做自动优化。**

按当前代码重新核查后，阶段状态如下：

| roadmap 阶段/主题 | 当前状态 | 合并后的判断 |
|-------------------|----------|--------------|
| 五阶段 TS 重构 | ✅ 已完成 | contracts/policy/runtime/status/ctl 已经 TS-first；旧 Python/大 JS live authority 不再是主线 |
| Phase 0 高危修复 | ✅ 已完成 | thread anchor、native delivery relay、delegate tier suppression、protected lane、judge timeout、runtime replay 事件均已落地 |
| Phase 1 真相收敛 + 术语统一 | ✅ 已完成 | status 读 durable state；replay 是 observability 旁路；Observer/Patrol/Runner/Ctl 已有角色文档和工具拦截 |
| Phase 2 反馈链路统一 | ✅ 已完成 | `nightly/review/curate/nightly-eval/promote` 已接成 observe -> summarize -> review -> curate -> validate -> promote -> learn |
| Phase 2 lightweight install / runtime core merge | ✅ 已完成 | `tools/install`、`tools/manage` 降级；`octoclawctl` 是统一入口；runtime core 并入 extension |
| Phase 3 IM 能力矩阵 | ✅ baseline 已完成，仍需产品化 | roadmap 中“飞书/微信待做”的说法已过期；当前已有 Feishu L1、WeChat L0、Slack L2 和 `sendWithDegradation` 测试 |
| Phase 4 基底收敛 | ✅ 基本完成，仍需持续验收 | live path 已收成 `syncMode=managed`，legacy mirrored 只读归一；还应继续做 field/revision/wait/cancel 映射审计 |
| Phase 5 Auto Router | ⚠️ 基础已完成，核心仍待实现 | route/budget/outcome schema、model shadow、nightly gate 已有；真正的 router core、shadow recommendation outcome、gated promotion 仍是下一阶段 |

2026-05-08 优先级更新：本机 OpenClaw + OctoClaw 当前 Slack/委派体感性能已经明显改善，性能不再是最近一轮主要阻塞项。warm pool / resident runner 继续保持非主线；OpenClaw prep performance 只作为观测和上游 PR 跟踪保留。近期主线转为 **Auto Router shadow-first**：先做可解释推荐、replay diff、nightly gate，不直接接管 live route。

### 4.3 roadmap 中逐项落地清单

| roadmap 项 | 当前状态 |
|------------|----------|
| Completion file protocol | ✅ 已从 planner/native path 删除；历史 completion 只可作为 migration/import 证据 |
| Native final delivery | ✅ JSON outbox 已从新 runtime path 删除；final relay 交给 native announce/channel delivery |
| ACK guard + execution notifications | ✅ ACK0、route commit ACK、execution transition notifier 已落地 |
| IM adapter registry | ✅ Slack、Feishu、WeChat 内置；自定义 adapter 可注册 |
| Slack status mrkdwn + 重要性排序 | ✅ status renderer 已有 Slack 输出 |
| 动态 model map | ✅ `openclaw models list --json` + 5 分钟缓存 + fallback defaults |
| `octoclawctl` 统一安装工具 | ✅ install/update/deploy/enable/disable/config/nightly 均在 CLI |
| `judge-fast.json` 自动迁移 | ✅ 统一配置会 import legacy judge-fast |
| 插件开关 enabled=false | ✅ runtime 早退，不卸载 plugin |
| Slack thread anchor Route C | ✅ `slack-thread-anchor.ts` 从 conversations history 找最新用户消息 |
| `ackNoTarget` 进入 fail bucket | ✅ nightly classifier 已将 no-target 从 unknown 改为 fail |
| DM 频道 footer 支持 | ✅ session key channel 匹配支持 D/C/U 前缀 |
| reply route ACK 顺序修复 | ✅ route commit ACK 不再依赖 `liveState` 非空 |
| delivery lane replay 新事件 | ✅ 历史 classifier 保留旧事件识别；新 runtime 不再产生 completion/outbox 正常路径事件 |

这里也修正 roadmap 的一个措辞：`direct / runner / spawn_single / spawn_multi` 不是“正确顶层 route”，而是下一阶段 Auto Router 可推荐的 execution contract / lane；live route authority 仍固定为 `reply | delegate`。

### 4.4 N0 代码审查后的校准

2026-05-01 针对 `refactor/0.4.0-stable` 的重点审查结论如下。这些不是重新打开 TS 重构，而是把已完成主线中的硬缺口排进下一轮。

| 审查点 | 当前判断 | 后续动作 |
|--------|----------|----------|
| 委派链路 | dispatch/materialize/planner-confirm/native announce 主链路已收口；completion file、finalizer recovery、delivery outbox 已从 planner/native path 删除 | 继续补 live Slack acceptance smoke 和 preferred child session 复用审计 |
| follow-up 路由 | `execution_followup` 已有强制 reply / control-observer 设计和部分测试 | P1-3 不再通过补关键词修 “为啥没派发成功 / 为什么没有 spawn / no_dispatch_evidence” 这类 case；N1 采用轻量 judge signal + runtime hard gate：judge 可建议 `is_followup_to_recent_execution` / `is_new_work` / `expected_deliverable`，但只有非空 `expected_deliverable` + 有效 ticket 才能 ordinary dispatch |
| retry | delegate core 有 `retryDelegateAttempt` 数据模型；final delivery retry 不再由 OctoClaw JSON outbox 承担 | `/octotask retry` / `octoclaw_task_action retry` 仍需实现同一 delegate task 的新 attempt，并明确 stop/approve/reject 的语义 |
| 真相层 | WorkContract/native refs 默认走 SQLite metadata ledger；task-state 是可重建 projection | 继续审计 status/grounding/watchdog 是否只通过 projection 读状态 |
| 并发 / 排队 / 修订 | TaskFlow、delegate attempt、continuity 已有底层元素 | 还缺明确 scheduler / amendment protocol：独立任务应可并发，有依赖时排队，补充/修改已有任务时应 steer / queue-after / cancel-respawn 三选一 |
| main-agent rule 注入 | 当前不是仓库文件式 `AGENTS.md`，而是 runtime 通过 `prependSystemContext` 注入 rule/policy projection | 这个方向正确；后续要给 rule 注入做 contract/snapshot test，确保它只承载协作宪法和 objection 协议，不复制 judge 规则 |
| policy spec / judge | judge prompt 已从 canonical spec 渲染，route 仍收口为 `reply | delegate` | runtime validator 弱于 spec：缺失 `scope/tool_need_hint/duration_hint` 仍可能通过；N1/N2 要收紧 schema 或显式记录 fallback/degraded |
| ACK | ACK guard、route commit ACK、delegate tier suppression 的主链路已稳 | 口径已收齐：reaction ACK0 为 primary；reaction 发送/尝试后不再 text fallback；无 reaction channel 走 2500ms gated text ACK0；delegate route 不发送 reply-style ACK0；ACK tests 174/174 pass |

特别澄清：`AGENTS.md` 在当前系统里不是必须存在的 repo 文件。历史文档中说的 `AGENTS.md` 职责，现在应理解为“注入给主 agent 的静态协作 rule”。它不负责 judge 路由；真正的 route/mode/role/scope 规则仍只来自 canonical decision policy spec。

### 4.5 已经演进，不应照旧理解

| v1 说法 | 新理解 |
|---------|--------|
| “建议阶段 Phase 0-4” | 这些已经多数变成历史施工阶段；新计划不要沿用旧 phase 编号制造歧义 |
| “runner pool / tmux workbench 可作为 acceleration backend” | 仍可选，但默认心智是 `ondemand` lane，不是常驻控制平面 |
| “task-state 是 projection/cache/policy metadata” | 当前它同时是 OctoClaw durable business-state projection；但 substrate lifecycle truth 仍在 OpenClaw TaskFlow |
| “Auto Router 接下来做” | 只能在 shadow + baseline + gate 下做；先推荐 execution contract，不直接改 live route authority |
| “IM/display 是后续能力” | Slack/Feishu/WeChat baseline 已有，接下来是 capability matrix 产品化和真实渠道验收 |
| “AGENTS.md 是当前 repo 文件” | 当前实现是 runtime rule 注入，不依赖仓库内存在 `AGENTS.md` 文件 |

### 4.6 应明确废弃

1. 不再回到 Python live route parity。
2. 不再把 `runner / spawn / direct / observe` 当作和 `reply | delegate` 平级的 route truth。
3. 不再把 replay、delivery relay、patrol、display 或 policy cache 当执行真相源。
4. 不再默认引入 ClawTeam/tmux/resident runner 作为系统成立前提。
5. 不再让 raw child transcript 回灌主线程作为默认交付方式。
6. 不再让 Auto Router 绕过 nightly/cost/latency/correctness gate 直接接管 live path。

---

## 5. 当前核心设计原则

### 5.1 Workflow-first, agent-second

只要任务需要新执行单元、环境探测、文件/命令/日志读取、长耗时处理或可恢复交付，就优先进入 `delegate`，再决定具体 lane。不要把主 agent 当万能执行容器。

### 5.2 Contract-first, prompt-second

Prompt 可以辅助 judge 和 worker brief，但系统边界必须由合同固定：

- `WorkContract`
- `WorkDecisionSeal`
- `DelegateContract`
- `ReplyContract`
- `NativeBindingRef`
- `TaskStatusProjection`
- `runtime-policy-replay-event/v1`
- route / budget / outcome schema

模型输出必须被 schema、validator、route seal 和 gate 收口。

### 5.3 Substrate-first, projection-second

OpenClaw TaskFlow 是生命周期事实。OctoClaw 的 `task-state.json` 负责把 WorkContract、native binding、dispatch/spawn/result/delivery 事实投影成 status/read model。两者不能互相伪造。

### 5.4 ACK / progress / final 三段分离

- ACK：快速确认收到，不承诺执行结果。
- Progress：只来自执行转换事件，不靠 tier timer 编“还在跑”的幻觉。
- Final：来自 completion/result fact，delivery 成功后才标 `delivered`。

特别要分清：

- anchor sync：任务锚点或状态更新。
- completion relay：最终结果明确送达原 thread / session。

不能把 anchor edit 当成 final delivered。

### 5.5 Feedback-first operations

任何路由、模型、budget、worker pool 的优化，都必须能进入：

```text
observe -> summarize -> review -> curate -> validate -> promote -> learn
```

没有 replay outcome、nightly report、calibration gate，就不要推广到 live。

### 5.6 Rule injection is cooperation, not route authority

主 agent 需要规则注入，但注入内容必须保持窄职责：

1. runtime policy authoritative for this run。
2. delegated route 时主 agent 是 coordinator，必须走 `octoclaw_dispatch`。
3. 不手写 session/subagent spawn 命令。
4. 不向用户解释隐藏的 route rationale、delegation strategy 或 task boundary 分析。
5. 主 agent 只有 route hint / objection / status coordination 权，没有 silent override 权。

这些 rule 可以通过 `prependSystemContext`、plugin rule、host rule 或未来等价机制注入，不要求仓库内存在实体 `AGENTS.md`。但它们不能变成第二份 judge rubric；judge、validator 和 route seal 的规则真相仍是 canonical decision policy spec。

---

## 6. 接下来要做什么

下面不用旧的 Phase 0-5 命名，避免和历史施工阶段混在一起。新的执行顺序用 `N0-N4`。

### N0：文档、术语和缺口校准（已完成：2026-05-01）

目标：让维护者读文档时不再被旧 phase 和 route 词汇误导。

本轮已完成：

1. 以本文为入口，修正活跃文档中把 `direct / runner / spawn_single / spawn_multi` 写成 live route authority 的表述。
2. 同步更新 `README.md` 与 `README.zh-CN.md`，把主入口收成 TS monorepo、runtime extension、`octoclawctl`、feedback loop 和 IM matrix。
3. 给 `docs/` 做 active/archive 清理：原 v1、2026-04-30 roadmap、Phase 1 和 Phase 2 施工设计都转为归档快照；活跃文档只保留仍指导后续实现的设计面。
4. `octoclaw-next-phase-roadmap-2026-04-30.md` 已归档为 dated snapshot；其阶段状态和计划已经合入本文。
5. 补充 N0 代码审查校准：resume/retry/truth/judge/ACK 的剩余缺口已经进入本文，不再藏在历史 roadmap 或临时 review 里。
6. 修正 `AGENTS.md` 表述：当前实现是 rule 注入链路，不要求 repo 内存在同名文件。

完成标准：

- 新人只读 README、本文、role terminology、state convergence，就能理解当前系统和下一轮硬缺口。
- 活跃文档中 `direct / runner / spawn_single / spawn_multi` 的出现均应按 execution contract / lane 解读；live route authority 固定为 `reply | delegate`。
- 归档文档可以保留历史措辞，但不再作为当前实现决策权威。
- review finding 不再散落在线程里；必须在本文或细分 spec 中能找到对应下一步。

### N1：恢复、重试和状态真相加固（立即，1-2 周）

目标：先把“发生了什么、谁做的、是否可恢复/可重试/已交付”收成可证明事实，再继续产品化 IM 和 Auto Router。2026-05-09 后，N1 中关于 completion file、child-finalizer、delivery outbox、`octoclaw_spawn`、direct subagent fallback 的旧表述已被 runtime convergence cleanup 覆盖；当前执行以 SQLite metadata ledger + native planner/confirm + native announce + projection builder 为准。

N1 采用最小可恢复 ledger 路径，不做大爆炸：第一步实现 `work_contracts`、`delegation_tickets`、`task_attempts`、`scheduler_queue`、`completion_bindings`、`runtime_events` 六张核心表，并补充 `native_spawn_intents` 作为 planner/confirm 辅助表。`delivery_outbox`、`amendments`、`resource_locks` 不进入当前生产 schema。Scheduler 限定为单进程 SQLite 事务队列/lease，无常驻 daemon，无分布式调度。设计见 `octoclaw-judge-dispatch-complexity-improvement-2026-05-01.md`，实施包见 `octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md`，当前修复 work packet 见 `octoclaw-n1-runtime-ledger-repair-packet-2026-05-01.md`。

#### N1-A：judge / dispatch 授权边界

1. judge 输出从单一 route 扩展为结构化 proposal：`route`、`is_followup_to_recent_execution`、`is_new_work`、`needs_side_effect`、`needs_fresh_state`、`expected_deliverable`、`complexity`、`duration_hint`、`tool_need_hint`、`confidence`。
2. runtime 只做薄授权：`route=delegate` 但没有新工作或可验收交付物时降级 reply；本 turn 已 direct action/visible reply 后撤销 dispatch eligibility；sealed delegate 后禁止 main final 抢答。
3. `octoclaw_dispatch` 强制一次性 delegation ticket；无 ticket、过期、已用、撤销、scope 不匹配都不得创建新 WorkContract/native task，只返回可回复状态包或 no-verifiable-record。
4. ticket 必须绑定非空 `workContractId`、`delegateTaskId`、`deliveryTarget`、`expectedDeliverable`、canonical complexity 和 native binding candidate。

#### N1-B：completion binding 与结果物化

1. planner/native path 不生成 completion path，不要求 worker 写 completion file。
2. `workContractId`、`delegateTaskId`、`nativeTaskId`、`childSessionKey` 必须通过 native spawn intent / confirm 绑定 accepted run evidence。
3. stale/timeout 判定前必须 probe child session terminal state、native task state 和 projection metadata；不能只因 task-state 长时间 running 就断言 result=none。
4. 历史 orphan completion 只可作为 migration/import 输入，不能驱动新 runtime。
5. final result ready 后由 native announce/channel delivery 负责 relay；OctoClaw 记录 replay/projection/delivery metadata，不能用 JSON outbox 伪装 delivered。

#### N1-C：scheduler、并发、依赖和锁

1. dispatch materialization 与 main turn lock 解耦；main lock 只保护 transcript/delivery 一致性，不阻塞独立 worker spawn。
2. 引入 OctoClaw runtime ledger（SQLite）作为 scheduler/attempt/ticket/metadata 的事务真相；OpenClaw `flows/registry.sqlite` 和 `tasks/runs.sqlite` 作为 native lifecycle authority，但生产同步应优先通过 bridge/API，`queryNativeState` 只是 staged/diagnostic hook，不声明生产直接读取 OpenClaw native DB。N1-MVP 表为 `work_contracts`、`delegation_tickets`、`task_attempts`、`scheduler_queue`、`completion_bindings`、`runtime_events`，另有 `native_spawn_intents` 辅助表；`delivery_outbox`、`amendments`、`resource_locks` 不在当前生产 schema。Scheduler 限定单进程 SQLite 事务队列/lease，无常驻 daemon。
3. `task-state.json` 降为可重建 read-model snapshot / compatibility projection，不再承担并发 queue pop、lease、resource lock、attempt transition 的唯一 durable truth。
4. 独立任务可并发 spawn；同一资源/写域/显式依赖的任务必须排队，状态写成 `queued_after=<taskId>` 或 `blocked_by=<resource>`。
5. scheduler queue 必须有 `queue_status`、`dependency_ids`、`resource_keys`、`lease_owner`、`lease_expires_at`、`revision`、`wakeup_at`，并用 CAS/transaction 防止双 pop。
6. `spawn_confirmed=true` 必须有 current native task/session/process evidence；仅注册 WorkContract、进入 queue 或遇到锁等待不得返回 spawn confirmed。
7. 如果 host/backend 暂不支持并发，必须显式返回 `blocked/queued` 和原因，不能 silent no-op 或伪装成已派发。
8. `resume_preferred` 必须真复用：dispatch 选出的 preferred `childSessionKey` 必须通过 native planner/confirm 能力复用；新 spawn 只在无 preferred、preferred retired 或 scope 不兼容时发生。

#### N1-D：task amendment protocol

1. 对正在跑或刚完成任务的补充修改，先判定 `steer_child`、`queue_after`、`cancel_and_respawn`、`reply_status_only`。
2. 判定依据是 WorkContract scope、读写集、当前阶段、child continuity、是否已有有价值产出、result 是否已 materialized、语义差异和用户显式要求；不能只靠 prompt 相似度或关键词。
3. `steer_child` 追加到同一 child/session；`queue_after` 在同一 delegate task 下创建 queued amendment attempt；`cancel_and_respawn` 记录取消原因并创建新 attempt；`reply_status_only` 不创建任务。
4. 实现 `/octotask retry` / `octoclaw_task_action retry`：从 task-state 读取 WorkContract，同一 `delegateTaskId` 下创建新 attempt，复用或退休 child session，并写回 durable projection / replay。
5. 定义 `stop / approve / reject` 行为：要么明确实现状态转换，要么从 tool enum 暂时移除，不能继续暴露成只读假动作。

#### N1-E：状态真相、状态面和 policyState 禁区

1. task-state 读取必须区分文件不存在、JSON 损坏、schema 不可读和 IO 异常；禁止把损坏/异常当空状态写回覆盖 durable truth。
2. observer snapshot 是唯一 read-model producer：`status/details/queue/timeline/retrieve/protected-lane answer` 都先读同一套 projection。
3. 状态面默认展示 compact canonical verdict：`completion_orphaned`、`binding_mismatch`、`stale_running`、`timeout_no_result`、`deliverable_ready`、`delivered` 等；raw/debug 才展示 native/replay/projection 细节。
4. 明确 `policyState` 禁区：不得恢复成 status fallback、spawn proof、result proof 或 cross-turn ledger。
5. complexity 只展示 WorkContract canonical `complexity_final`；judge proposed/final diff 只进 replay/nightly/raw。
6. ACK text ACK0 口径已对齐：reaction ACK0 为 primary；reaction 发送/尝试后不再 text fallback；无 reaction channel 走 2500ms gated text ACK0；delegate route 不发送 reply-style ACK0；text ACK0 是 active fallback，不是禁用路径。

#### N1 验收标准

- “为什么刚才自己回复一次又派发一次 / 为啥没派发成功呢”这类执行追问永远不创建新的 WorkContract/delegate task；实现上不靠补关键词，也不需要大 taxonomy。judge 只给 `is_followup_to_recent_execution` / `is_new_work` / `expected_deliverable` 建议，runtime 以有效 ticket + 非空 `expected_deliverable` 为硬门；没有交付物的 delegate 倾向只能 reply/status refresh/no-verifiable-record。
- `octoclaw_dispatch` / `octoclaw_spawn` 的测试能证明没有有效 delegation ticket 时不会创建新任务；ticket 有效、未过期、未撤销且绑定当前 turn/session/WorkContract 时才允许 materialize。
- completion 写到错误路径或 `workContractId` 为空时，状态进入 `completion_orphaned` / `binding_mismatch`，orphan scanner 能找回候选结果；不能继续普通显示 `running/result=none`。
- `resume_preferred` 的测试能证明同一 WorkContract follow-up 复用 preferred child session，而不是生成新 UUID。
- `retry` 的测试能证明新 attempt 仍属于同一 delegate task，并且 status/timeline/replay 能区分原失败 attempt 和新 attempt。
- 两个独立 delegated tasks 能并发 running；有依赖的 task 显示 `queued_after=<taskId>`；主会话忙不能导致 no-op dispatch。
- scheduler/attempt/ticket/completion binding 有事务 ledger；`task-state.json` 可删除后由 ledger + OpenClaw bridge/API native lifecycle snapshot + replay 重建 status projection。
- 对运行中任务的补充修改能稳定落到 steer / queue-after / cancel-respawn / status-only 之一，并写入 durable projection。
- task-state 损坏不会被当成空状态写回覆盖；operator/status 能看到明确 recovery signal。
- 重启后 `octoclaw_status` 与 IM/status projection 对同一任务给出一致状态。
- 任务完成但 final relay 未成功时，状态是 `deliverable_ready` 或 `delivery retry`，不能显示成 `completed/delivered`。
- protected-lane 问题必须 state-grounded，不能凭上一轮自然语言回答。
- judge spec、runtime validator、main-agent rule injection 三者职责清楚：rule 注入只指导协作，judge validator 才校验 route contract。
- N1 实施包的 OpenSpec packet 必须是单 slice、有 review gate；验收不只是“tests pass”，而是 reviewer 确认实现达到了 slice 的 stated purpose，且没有引入可避免的复杂架构。

### N2：IM capability matrix 产品化（2-4 周）

目标：把已经落地的 Slack/Feishu/WeChat baseline 从“代码可用”推进到“可验收、可降级、可说明”。

要做：

1. 把 L0/L1/L2 capability matrix 从文档落实为 runtime 可读能力对象和 acceptance fixtures。
2. Slack 继续作为 L2 基准：thread anchor、mrkdwn/status、delivery retry、重要性排序、DM/channel 行为都要覆盖。
3. Feishu 固定 L1：text + thread reply；如果要做 card，先以 capability flag 接入，不要污染 L0/L1。
4. WeChat 固定 L0：plain text + truncation + no thread；所有 thread/action 语义必须有清晰降级。
5. Telegram/Discord 暂不默认宣传为已实现；可以保留接口设计。

完成标准：

- 每个已启用 channel 都有 ACK/progress/final 的降级测试。
- `sendWithDegradation` 的 degraded outcome 进入 replay/nightly 统计。
- README 能清楚告诉用户不同 IM 的能力差异。

### N3：Auto Router shadow-first（4-8 周）

目标：做推荐器，不做新的总控运行时；先 shadow，后 gate，再推广。2026-05-08 起，N3 是性能线之后的推荐主线，但第一阶段仍然不改变 live path。

当前前置判断：

1. `reply | delegate` 仍是唯一 live route authority；Auto Router Lite 第一阶段只推荐模型、预算、配置缺口和 shadow diff，不推荐 execution contract / worker pool。
2. warm pool / resident runner 不作为 Auto Router 前置条件，也不作为近期默认优化。
3. 已有 judge 字段已经简化，Auto Router 不应重新引入 role/workType/tool_need_hint/duration_hint 这类未消费胖字段。
4. 所有关键词型拦截只能降级为 fixture/规则测试素材；不能再作为 live guard 的主要实现方式。
5. P5-Lite-A/B/C 的成功标准是“模型推荐可信且可度量”，不是“马上让路由变聪明”。

实现顺序：

1. P5-Lite-A：在 `@octoclaw/policy` 内先落 `router-lite` model-intel snapshot。
   - 输入：OpenClaw config、pricing cache、provider catalog、auth profile usage/cooldown。
   - 输出：候选模型的价格、能力、健康、quota pressure、source。
   - 未知套餐额度保持 `quotaPressure=unknown`，不能当免费。
2. P5-Lite-B：配置缺口 proposal。
   - 识别只配强模型、缺低成本候选的情况。
   - 只输出 proposal，不自动写 OpenClaw config。
3. P5-Lite-C：shadow recommendation 接线。
   - 不改变 live path。
   - 只写 replay outcome：actualModel vs recommendedModel、eligible/rejected、ignoredReason、estimated cost delta。
   - 至少连续 7 天 nightly baseline。
4. P5-Lite-D：gated live。
   - 只对 `liveRoute=delegate` 且 `configured=true` 候选开放。
   - quality / cost / fallback / timeout 全过 gate 后，才允许局部 live。

硬边界：

- 不做 online RL / bandit。
- 不把 learned router 放入 hot path。
- 不新增 tiny judge；现有 judge 四字段继续作为语义信号来源。
- 不用 Auto Router 重新解决子 agent 冷启动；性能只进入 budget/latency telemetry。
- 不优化 `control_observer` / `session_control` 这类 protected lane。
- 不跳过 nightly-eval 和 calibration gate。

完成标准：

- Auto Router 推荐可以解释、可 replay、可对比、可回滚。
- live route authority 仍是 `reply | delegate`。
- 任何推广都有 baseline、candidate、rollback target。

### N4：发布和开源产品面收口（并行推进）

目标：把当前内部能力整理成用户能安装、能理解、能信任的版本。

要做：

1. README 中英文同步到 TS monorepo、`octoclawctl`、runtime extension、IM matrix、feedback loop。
2. Quick Start 只保留 `octoclawctl install/update/deploy/enable/disable/status` 这一条主线。
3. 给 `schemas/` 和 public exports 做最小兼容承诺，避免外部用户依赖内部路径。
4. 固定 release gate：`pnpm check`、focused runtime tests、nightly-eval sample、Slack acceptance、doc link check。
5. 给 operator 准备一份最短故障处理路径：status、details、queue、timeline、patrol、repair、nightly review。

---

## 7. 下一阶段不要做什么

1. 不要新增一个常驻 runner/daemon 作为默认依赖。
2. 不要为了 Auto Router 重新发明第二套路由字段。
3. 不要把 multi-agent / compound flow 提前变成主线；`solo_worker` 和单一 completion relay 先彻底稳定。
4. 不要把 Web/UI cockpit 放到 IM matrix 稳定之前。
5. 不要把评估和学习放进 live hot path。
6. 不要为了“更聪明”削弱 WorkContract、TaskFlow 和 task-state 的可恢复性。

---

## 8. 当前活跃文档关系

| 文档 | 当前用途 |
|------|----------|
| `octoclaw-ts-rebuild-design-v2.md` | 本文：TS 重构完成后的总设计入口和下一步计划 |
| `octoclaw-design-foundation.md` | 系统定义和长期设计原则，保留为背景底稿；N0 后已标注 TS 当前实现入口 |
| `octoclaw-state-convergence-4-4-design.md` | 状态真相和 task-state convergence 规则 |
| `octoclaw-work-contract-centered-delegation-design-2026-04-25.md` | WorkContract 委派合同细节 |
| `octoclaw-judge-ack-policy-spec-2026-04-21.md` | judge / ACK / policy labels 的细化规范 |
| `octoclaw-judge-dispatch-complexity-improvement-2026-05-01.md` | N1 补充：judge 语义建议、delegation ticket、单 owner、防双路径和 complexity canonicalization |
| `octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md` | N1 实施包：SQLite schema、迁移步骤、scheduler protocol、验收矩阵和 OpenSpec 模板 |
| `octoclaw-role-terminology.md` | Observer/Patrol/Runner/Ctl 术语边界 |
| `octoclaw-feedback-loop-contracts.md` | observe -> summarize -> review -> curate -> validate -> promote -> learn |
| `octoclaw-im-display-contract.md` | IM/display 能力矩阵和 surface 语义；N0 已标注当前 TS 入口，N2 继续产品化 |
| `octoclaw-phase5-auto-router-design-2026-04-30.md` | Auto Router 专项设计；N0 已修正 router core 落点和 live route / execution contract 边界，N3 继续实现 |
| `archive/octoclaw-ts-rebuild-design-v1.md` | 原 v1 设计快照；只用于追溯 TS 重构启动期判断 |
| `archive/octoclaw-phase1-stabilization-design-2026-04-29.md` | Phase 1 状态/ACK/replay 稳定化施工快照；完成状态已合入本文 |
| `archive/octoclaw-phase2-lightweight-install-design-2026-04-30.md` | Phase 2 安装工具和 package 收口施工快照；完成状态已合入本文 |
| `archive/octoclaw-next-phase-roadmap-2026-04-30.md` | 2026-04-30 dated roadmap snapshot；核心内容已合入本文 |

历史设计可以继续保留在 `docs/archive/`，只用于查漏，不再作为当前实现的决策权威。

---

## 9. 最终判断

OctoClaw 的 TS 重构不再是“接下来要不要做”的问题。当前分支已经完成了主要迁移：合同、policy、runtime、IM、status、install、feedback loop 都已经有 TypeScript 主线。

真正的下一步是收口：

1. 收口术语：live route 和 execution contract 不再混用。
2. 收口状态：TaskFlow / WorkContract / task-state / replay / policyState 各归其位。
3. 收口交付：ACK、progress、final relay 各自只表达自己有证据表达的事实。
4. 收口评估：任何路由和模型优化都先进入 shadow + nightly + gate。
5. 收口产品面：README、IM matrix、`octoclawctl` 和 release gate 变成用户可理解的主路径。

一句话：

> **不要再重写 OctoClaw；现在要把它从“重构完成的系统”打磨成“可发布、可验证、可恢复、可演进的系统”。**
