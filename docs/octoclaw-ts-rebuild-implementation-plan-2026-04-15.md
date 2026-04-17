# OctoClaw TS 重构细化施工计划 v0

日期：2026-04-15

状态：draft

用途：这份文档不是讲方向，而是给执行者直接开工用。目标是把 OctoClaw v2 的 TS 重构拆成可并行、可验收、可交接的工作包，方便交给其他 AI 或协作者推进。

关联文档：

1. `octoclaw-ts-rebuild-design-v1.md`
2. `octoclaw-harness-contract-inventory.md`
3. `octoclaw-harness-ownership-map.md`
4. `octoclaw-im-display-contract.md`

---

## 1. 施工总原则

### 1.1 技术原则

1. 正式产品代码全部用 TypeScript 重写。
2. 旧 Python/JS 文件只能参考，不能继续补丁演进。
3. Python 只保留测试脚本、运维脚本、一次性迁移脚本、临时分析脚本。
4. 以 OpenClaw 原生 task/flow 为执行真相源。
5. 以 plugin/runtime-first 为接入方式，不以 CLI create 为前提。

### 1.2 架构原则

1. `judge-first`，不是 `rule-first`
2. 语义判断不使用关键词匹配
3. 主模型默认只吃最小上下文
4. artifact-first / state-first / event-first
5. telemetry 必须从第一阶段开始进入链路

### 1.3 施工原则

1. 先定 contract，再写模块。
2. 先建最小可运行骨架，再扩能力。
3. 先做 `reply + delegate.single + observe`，后做 compound。
4. 先把热路径跑稳，再做自动选模/自学习。
5. 每个 work package 都要有明确输入、输出、依赖、验收标准。

---

## 2. 目标目录骨架

```text
extensions/
  octoclaw-runtime/
  octoclaw-auto-router/
  octoclaw-fast-reply/
  octoclaw-delegation/
  octoclaw-status-surface/
  octoclaw-im-adapters/

packages/
  octoclaw-contracts/
  octoclaw-policy/
  octoclaw-runtime-core/
  octoclaw-evals/

tools/
  octoclawctl/
  migration/
```

---

## 3. Workstream 拆分

## WS0：Contract Foundation

目标：先把 v2 的公共 contract 定死，避免后面每个模块各写一份近似结构。

交付：

1. `packages/octoclaw-contracts/src/events.ts`
2. `packages/octoclaw-contracts/src/artifacts.ts`
3. `packages/octoclaw-contracts/src/results.ts`
4. `packages/octoclaw-contracts/src/deliveries.ts`
5. `packages/octoclaw-contracts/src/telemetry.ts`
6. `packages/octoclaw-contracts/src/schemas.ts`

至少包含这些 contract：

1. request context
2. route decision
3. worker brief
4. checkpoint event
5. worker result
6. delivery envelope
7. optimization telemetry
8. status surface view model
9. idempotency keys / delivery receipt
10. task claim / lease metadata
11. read_scope / write_scope / workspace_mode
12. acceptance_criteria / task packet
13. capability descriptor
14. session_thread / agent_instance metadata
15. advice_packet / advisor_policy
16. thread handoff / inbox message
17. surface_anchor / session binding
18. active_context_budget / summary snapshot metadata
19. future `context_file` / `skill_ref` artifact kinds（仅 contract 预留，不要求 runtime 落地）

验收标准：

1. 所有字段有类型定义
2. 有 schema version
3. 有最小 fixture
4. 后续模块只依赖 contracts，不再自造 JSON shape

依赖：无

适合最先开工。

---

## WS1：Policy Core

目标：把当前 `decide/route/judge/model/planner` 的热路径语义迁到 TS，并收成纯逻辑包。

交付：

1. `packages/octoclaw-policy/src/intent`
2. `packages/octoclaw-policy/src/judge`
3. `packages/octoclaw-policy/src/route`
4. `packages/octoclaw-policy/src/model`
5. `packages/octoclaw-policy/src/roles`
6. `packages/octoclaw-policy/src/compound`（Phase 3 预留占位，不进 Phase 1 live path）

必须实现：

1. `reply / delegate.single / observe` 基础决策
2. hard-boundary gate
3. `judge_fast` 接口与输出 schema
4. preset role:
   - `main_reply`
   - `observer_probe`
   - `worker_research`
   - `worker_code`
   - `worker_review`
5. budget/latency/worker 上限决策
6. admission control / queue budget
7. capability-aware route guard
8. compound 只保留 future schema slot，不进入 Phase 1 route authority
9. future coordination_mode / advisor_policy 预留接口
10. resident runner absent 视为默认正常态，不作为 route 降级理由
11. backend planner 只降 execution profile，不篡改 semantic route

明确禁止：

1. 关键词匹配做语义路由
2. 主模型承担 route authority

验收标准：

1. 纯函数可测
2. 有 golden cases
3. 有 invalid case coverage
4. 不依赖 OpenClaw runtime

依赖：WS0

---

## WS2：Runtime Core

目标：把消息进入、ACK、任务物化、workflow 状态机、delivery/recovery 收成可复用 TS 核心。

交付：

1. `packages/octoclaw-runtime-core/src/ack`
2. `packages/octoclaw-runtime-core/src/requests`
3. `packages/octoclaw-runtime-core/src/tasks`
4. `packages/octoclaw-runtime-core/src/workflow`
5. `packages/octoclaw-runtime-core/src/delivery`
6. `packages/octoclaw-runtime-core/src/recovery`

必须实现：

1. inbound request normalization
2. independent ACK
3. task/flow materialization interface
4. workflow state machine
5. progress/final delivery protocol
6. recovery hooks
7. telemetry emission
8. ingress/workflow orchestration split
9. timeout/failure deadline checks
10. idempotent task materialization
11. claim / lease renewal and expiry
12. delivery outbox / delivery receipt handling
13. thread-aware state aggregation 预留接口
14. surface anchor -> thread/session binding
15. summary snapshot / context budget hook
16. runner absent -> on-demand execution fallback
17. backend unavailable / queue full -> queued or blocked delivery path

实现口径：

1. 不做独立 orchestrator daemon
2. orchestration layer 统一落在 runtime core
3. ingress orchestration 作为短命请求级逻辑实现
4. workflow orchestration 作为 runtime core + plugin handler 组合实现
5. reconcile/recovery 作为 orchestration layer 内的补偿子域实现
6. 它可以暴露 optional worker 入口，但不是独立系统
7. timeout 检测按 `queue/start/progress/runtime/delivery` 五类 deadline 拆开
8. 每个 delegated task 只有一个有效 claim owner
9. delivery side effect 必须经过 outbox/receipt
10. future multi-agent 先按 one-level thread hierarchy 设计
11. gateway/IM continuity 统一通过 thread/session binding 进入 runtime core
12. `context_file` / `skill_ref` 只作为 artifact 引用流经 contracts，不在 Phase 1-2 演化成 memory runtime
13. resident runner 默认关闭；runtime 默认按 native task/flow + on-demand worker 实现
14. `reply / observe / delegate.single` 的语义 route 不因 runner 缺席而改写
15. 开启 resident runner 只代表 acceleration lane 可用，不代表 tmux 成为必需依赖

关键状态：

1. `checkpoint_emitted`
2. `deliverable_ready`
3. `waiting_input`
4. `backend_retry_scheduled`
5. `delivery_pending`
6. `stale`
7. `timed_out`

验收标准：

1. `reply + delegate.single + observe` 能跑通最小 happy path
2. ACK 不依赖复杂后续链
3. delivery 有结构化输出
4. telemetry 能记录 request/task/flow

依赖：WS0、WS1

---

## WS3：OpenClaw Runtime Adapter

目标：用 TS 接 OpenClaw 原生 runtime seam，不再依赖 Python taskflow adapter 作为正式实现。

交付：

1. `extensions/octoclaw-runtime/src/plugin.ts`
2. `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts`
3. `extensions/octoclaw-runtime/src/adapter/webhook-surface.ts`
4. `extensions/octoclaw-runtime/src/config`

必须实现：

1. bind session
2. create managed flow
3. run task
4. read flow/task state
5. cancel/read-only operator seam

边界约束：

1. 插件内优先 runtime seam
2. 插件外优先 webhook
3. CLI 不承担 create 主路径

验收标准：

1. 不通过 Python helper 也能创建和跟踪 flow/task
2. native task/flow 成为真相源
3. state/details 读取与 substrate 对齐

依赖：WS0、WS2

---

## WS4：Delegation Plugin

目标：把 worker brief、backend profile、single delegate 收成独立插件，并为 future compound helper 预留边界。

交付：

1. `extensions/octoclaw-delegation/src/brief`
2. `extensions/octoclaw-delegation/src/profiles`
3. `extensions/octoclaw-delegation/src/materialize`
4. `extensions/octoclaw-delegation/src/compound`（预留，不进 Phase 1）

必须实现：

1. brief builder
2. preset role binding
3. backend selection interface
4. single delegate materializer
5. compound 占位接口
6. write scope / workspace mode assignment
7. conflict policy hook
8. future callable role registry
9. future advisor consult adapter

验收标准：

1. worker 默认只拿最小上下文
2. transcript 不直接全量传递
3. 可按 preset role 选择工具权限、模型 profile、输出 contract
4. delegated task 默认带 read/write scope
5. overlapping write 默认不会并发踩同一工作区
6. Phase 3 起可扩到 thread handoff / inbox / advice packet

依赖：WS0、WS1、WS2、WS3

---

## WS5：Fast Reply Plugin

目标：把直接回答、快速 ACK、reply lane 优化单独插件化。

交付：

1. `extensions/octoclaw-fast-reply/src/ack`
2. `extensions/octoclaw-fast-reply/src/direct`
3. `extensions/octoclaw-fast-reply/src/instrumentation`

必须实现：

1. brief ACK template
2. direct reply flow
3. reply lane telemetry
4. reply lane baseline report input

验收标准：

1. direct path 上下文最小化
2. 能测 `ack_ms`、`total_latency_ms`
3. 不污染 delegation runtime

依赖：WS0、WS1、WS2

---

## WS6：Status Surface

目标：尽快恢复旧版“产品感”强的状态面，而且统一读 substrate-first truth。

交付：

1. `extensions/octoclaw-status-surface/src/view-model`
2. `extensions/octoclaw-status-surface/src/renderers/text`
3. `extensions/octoclaw-status-surface/src/renderers/rich`
4. `extensions/octoclaw-status-surface/src/actions`
5. `tools/octoclawctl`

说明：

1. `renderers/rich` 在 Phase 1 可以只是最小占位，不要求先做 cockpit/graph
2. Phase 1 的目标是把信息架构立住，不是把富展示一次做满

最小 v1 必须有：

1. `status`
2. `details`
3. `queue`
4. `timeline` 占位

最小字段：

1. `task_id`
2. `state`
3. `route`
4. `role`
5. `coordination_mode`
6. `backend_summary`
7. `substrate_summary`
8. `action_availability`
9. `queue_position`
10. `model_summary`
11. `cost_estimate`
12. `claim_owner`
13. `lease_state`
14. `workspace_mode`
15. `write_scope_summary`
16. `thread_count`
17. `advisor_usage_summary`

验收标准：

1. Phase 1 就能出最小 operator surface
2. Phase 2 起 `status/details/queue` 全读 substrate truth
3. renderer 不再自己猜状态
4. 能看出 task 是否被 claim、是否 stale、是否因冲突排队
5. 为 Phase 3 的 child thread / advisor 预留展示字段

说明：

1. `graph` / richer board 不进入 Phase 1
2. 这些能力放到 Phase 3-4 的 richer status surface 再做

依赖：WS0、WS2、WS3

---

## WS7：IM Adapters

目标：把 Slack/Feishu/Telegram/Discord 等适配收成插件，不污染 runtime core。

交付：

1. `extensions/octoclaw-im-adapters/src/slack`
2. `extensions/octoclaw-im-adapters/src/feishu`
3. `extensions/octoclaw-im-adapters/src/telegram`
4. `extensions/octoclaw-im-adapters/src/discord`
5. `extensions/octoclaw-im-adapters/src/shared`

必须实现：

1. anchor/update/close
2. fallback rules
3. surface capability matrix
4. action rendering
5. shared gateway/surface adapter contract
6. surface anchor 到 thread/session 的统一绑定入口

验收标准：

1. IM 只是 adapter，不拥有真相
2. channel 差异收在 adapter 层
3. 共用统一 view model
4. continuity 逻辑不散落在各 adapter 私有实现里

依赖：WS0、WS6

---

## WS8：Eval & Harness Gate

目标：把 replay/eval/acceptance/preflight 收成正式 TS 包，作为回归门禁。

交付：

1. `packages/octoclaw-evals/src/preflight`
2. `packages/octoclaw-evals/src/contracts`
3. `packages/octoclaw-evals/src/golden`
4. `packages/octoclaw-evals/src/acceptance`
5. `packages/octoclaw-evals/src/replay`
6. `packages/octoclaw-evals/src/reporting`

必须实现：

1. environment preflight
2. route golden tests
3. contract tests
4. black-box IM acceptance
5. replay fixtures
6. telemetry baseline report
7. duplicate request / duplicate delivery regression tests
8. claim expiry / stale recovery tests
9. write-scope conflict / queueing tests
10. reply lane / delegate lane baseline compare
11. shadow recommendation / promotion gate scaffold

验收标准：

1. CI 可以独立跑
2. 能阻止明显回归
3. 能输出成本/速度基线
4. 能抓住重复派活、双 delivery、双执行这类稳定性回归
5. 能判断“更快但更差”或“更便宜但更差”的优化无效

依赖：WS0，随后逐步接 WS1-WS7

---

## WS9：Auto Router

目标：后置能力。先只建接口，不在早期自动调参。

交付：

1. `extensions/octoclaw-auto-router/src/consumers`
2. `extensions/octoclaw-auto-router/src/calibration`
3. `extensions/octoclaw-auto-router/src/provider-slots`

第一阶段只做：

1. 读取 telemetry
2. 输出报告
3. 建 shadow recommendation

明确不做：

1. online self-tuning
2. 自动切主模型
3. 自动改 live route

依赖：WS8

---

## 4. 推荐阶段顺序

### Phase 0

1. WS0 Contract Foundation
2. WS8 preflight/golden 最小门禁
3. 旧模块到新包的 ownership map
4. reply / delegate.single lane baseline 固定

### Phase 1

1. WS1 Policy Core
2. WS2 Runtime Core
3. WS5 Fast Reply
4. WS6 Status Surface MVP

目标：先跑通 `reply + delegate.single + observe`

补充口径：

1. `judge_fast` 默认固定映射到便宜快模型
2. resident runner 缺席视为默认正常态
3. 默认执行心智是 native task/flow + on-demand worker

### Phase 2

1. WS3 OpenClaw Runtime Adapter
2. WS4 Delegation Plugin
3. WS7 IM Adapters shared contract + 一个 reference adapter

目标：把 native task/flow 接上，替换正式 Python runtime 路径

说明：

1. advisor 在 Phase 2 不是必做项
2. 只允许保留 `advisor_policy` / `advice_packet` / consult adapter 这些骨架接口
3. 是否灰度上线 advisor-assisted，取决于 Phase 1-2 的 telemetry / stability gate
4. 不要求 Slack/Feishu/Telegram/Discord 一次性全部落地，先把 shared adapter boundary 做对
5. 只有 resident runner 被证明能显著改善 queue / first_progress 指标时，才值得作为 opt-in acceleration 推广

### Phase 3

1. WS8 完整 replay/acceptance
2. WS4 compound 占位升级
3. WS6 richer status/details/queue
4. WS7 渠道扩展
5. advisor-assisted lane 灰度
6. one-level threaded subagents skeleton

目标：从 single delegate 扩到可控的 compound / controlled multi-agent，但不做自由 swarm

### Phase 4

1. WS9 Auto Router
2. 本地模型 provider slot
3. heavy/research profile
4. richer multi-agent board / cockpit
5. advisor / subagent / model 一体化自动选择
6. harness-driven policy tuning / recommendation promotion

---

## 5. 旧模块到新模块映射表

| 旧模块 | 新归属 | 处理方式 |
| --- | --- | --- |
| `extensions/octoclaw-runtime/index.js` | `extensions/octoclaw-runtime` + `packages/octoclaw-runtime-core` | 重写 |
| `extensions/octoclaw-runtime/policy/*.js` | `packages/octoclaw-policy` | 重写 |
| `lib/dispatch_task.py` | `packages/octoclaw-runtime-core` + `extensions/octoclaw-delegation` | 重写 |
| `lib/openclaw_taskflow_adapter.py` | `extensions/octoclaw-runtime` | 重写 |
| `lib/task_display.py` | `extensions/octoclaw-status-surface` | 重写 |
| `lib/status_render.py` | `extensions/octoclaw-status-surface` | 重写 |
| `lib/im_display_contract.py` | `packages/octoclaw-contracts` | 重写 |
| `lib/worker_taxonomy.py` | `packages/octoclaw-policy/src/roles` | 重写 |
| `lib/model-intel.py` | `packages/octoclaw-policy/src/model` / `extensions/octoclaw-auto-router` | 重写 |
| `lib/budget.py` | `packages/octoclaw-policy` / telemetry path | 重写 |
| `lib/eval_suite.py` | `packages/octoclaw-evals` | 重写 |

---

## 6. 可并行分包建议

如果要交给多个 AI 并行做，建议按这个拆法分：

### Worker A：Contracts + Policy

负责：

1. WS0
2. WS1

写入范围：

1. `packages/octoclaw-contracts`
2. `packages/octoclaw-policy`

### Worker B：Runtime + Delegation

负责：

1. WS2
2. WS3
3. WS4

写入范围：

1. `packages/octoclaw-runtime-core`
2. `extensions/octoclaw-runtime`
3. `extensions/octoclaw-delegation`

### Worker C：Status + IM

负责：

1. WS6
2. WS7
3. `tools/octoclawctl`

写入范围：

1. `extensions/octoclaw-status-surface`
2. `extensions/octoclaw-im-adapters`
3. `tools/octoclawctl`

### Worker D：Eval + Harness Gate

负责：

1. WS8
2. telemetry baseline/reporting

写入范围：

1. `packages/octoclaw-evals`

### Worker E：Auto Router 后置接口

负责：

1. WS9 的只读/影子部分

写入范围：

1. `extensions/octoclaw-auto-router`

---

## 7. 每个 AI 工作者必须遵守的规则

1. 不在旧 Python/JS 正式模块上继续补功能。
2. 不把关键词匹配重新塞回语义决策。
3. 不让主模型背整段 transcript。
4. 不引入第二套执行真相源。
5. 不把 tmux / daemon / patrol 当架构前提。
6. 不绕过 contracts 自造 payload shape。
7. 不让本地模型提前进默认热路径。

---

## 8. 最小里程碑定义

### M1：TS skeleton ready

完成标准：

1. monorepo 骨架建好
2. contracts 可编译
3. policy core 有最小测试

### M2：reply/observe/delegate.single live

完成标准：

1. ACK 独立
2. small judge 可接
3. single delegate 可 materialize
4. telemetry 开始落地

### M3：native task/flow convergence

完成标准：

1. 正式链路不再依赖 Python taskflow adapter
2. status/details/queue 读 substrate truth
3. IM anchor 与 delivery 接通

### M4：eval gate active

完成标准：

1. preflight/golden/acceptance/replay 能跑
2. 产出成本/速度基线
3. 有 promotion/block gate

---

## 9. 当前最值得先分给其他 AI 的任务

如果现在就要开始派活，我建议优先派这 5 个：

1. 搭 `packages/octoclaw-contracts`，定 `route decision / worker brief / telemetry / status view model`
2. 搭 `packages/octoclaw-policy`，先做 `judge-first` 的最小 pure functions
3. 搭 `packages/octoclaw-runtime-core`，先做 ACK、request normalization、workflow 状态机
4. 搭 `extensions/octoclaw-status-surface`，先恢复 `status/details/queue` 的 TS MVP
5. 搭 `packages/octoclaw-evals`，先把 preflight + golden gate 接起来

这 5 个做完，后面接 OpenClaw native runtime 和 IM adapter 会顺很多。
