# OctoClaw Router Policy Refactor Plan

日期：2026-04-10  
状态：review draft，等待设计确认后实施  
关联设计：[octoclaw-router-policy-refactor-2026-04-10.md](./octoclaw-router-policy-refactor-2026-04-10.md)

---

## 1. 目标

这次重构不是继续补 case，而是把 live 主链收成一条简单、可测、可替换的路径：

```text
ACK timer
  -> signal extractor
  -> policy judge
  -> decision validator
  -> route + budget
  -> native task-bound runner/spawn
  -> execution ledger
  -> delivery relay
```

达成后应具备：

- 用户消息 p95 1 秒内有 ACK 或直接回答。
- 自然语言 scope/target/route 默认由 main-grade stateless policy judge 判，不靠关键词硬判。
- 便宜模型/本地模型可 shadow eval，达标后接部分真实路由。
- runner 轻任务不再每次走高冷启动 spawn。
- 每个 runner job 都绑定 native task。
- `怎么查的`、`任务怎么样` 只读 execution ledger。
- ACK、progress、final delivery 有独立消息契约。
- turn/decision/job/delivery 全链路可追踪且幂等。
- OctoClaw 不再默认安装独立 patrol/runner shell loop。
- live 主链依附 OpenClaw gateway / Node runtime extension。
- Python 退出 live router hot path，保留 eval/replay/batch/report。

---

## 2. 非目标

本轮不做：

- 全仓库重写。
- 全量迁移到 Node。
- 直接删除所有 Python。
- 一上来让 cheap/local 模型接真实路由。
- 让当前 Slack 主会话凭完整聊天历史直接做路由 judge。
- 把 tmux 变成状态真相源。
- 把 native task 强行当常驻 worker supervisor。
- 去掉 OpenClaw gateway 常驻进程。
- 去掉所有 runner 常驻能力；runner pool 仍可作为可选加速 backend。

---

## 3. 阶段计划

### R0：冻结现状与补 golden fixtures

目的：先把失败样例变成可回归资产。

任务：

- 整理最近 Slack bad cases。
- 建 `router-policy-goldens-v2.json`。
- 每条 case 标出：
  - `message`
  - `expected.request_kind`
  - `expected.scope`
  - `expected.target`
  - `expected.route`
  - `expected.evidence_required`
  - `must_ack`
  - `must_not`

验收：

- 至少覆盖 20 个近期失败/易错 case。
- 包含 Control UI、本机版本、上游 release、Memory 更新、任务追问、怎么查的、runner 成功了吗。
- fixtures 必须覆盖 scope/target/evidence，不只覆盖 route。
- `work_request` fixtures 必须覆盖 `current_workspace` 与 `task_context`，避免执行型请求因没有本机/远程对象被误判为 `unknown`。
- ACK 验收必须检查 prompt-build hot path：eager ACK 只能异步投递，且 channel delivery 必须有短超时，不能把主回复卡在 Slack/Python 投递链路上。
- provenance 验收必须检查“怎么查的”类追问：如果 execution facts 没有记录 direct tool，就不能让回复声称用了 `web_fetch`、`exec`、`openclaw` 等工具。
- judge 验收必须覆盖三类 adapter：fixture、command、openai-compatible；其中任一 adapter 失败、超时、脏 JSON、低置信度都必须稳定回退 legacy planner。
- delivery relay 验收必须覆盖 `delivery_pending -> delivery_observed` 正常链路，以及 `delivery_agent_end_pending` 悬挂链路。

### R1：ACK timer 独立化

目的：快回复不再依赖 router、runner、tool latency。

任务：

- Node runtime 增加 ACK timer。
- 默认 500-800ms 未完成就发中性 ACK。
- ACK 文案禁止声称已查、已派发、已完成。
- delivery log 记录 ACK attempted/sent/failed。
- ACK event 绑定 `turn_id`。

验收：

- live lookup p95 ACK < 1s。
- runner/spawn 卡住时，用户仍能及时收到中性 ACK。
- ACK 不污染 execution facts。
- ACK 不会被误认为 final result。

### R1.5：Turn correlation 与消息契约

目的：解决 ACK、judge、runner、delivery 各说各话。

任务：

- 引入 `turn_id`、`decision_id`、`runner_job_id/task_id`、`delivery_id`。
- 三段消息 schema：
  - `ack`
  - `progress`
  - `final`
- final delivery 必须引用 result/evidence。
- progress 超过 deadline 必须发出或记录失败。
- 支持 supersede/cancel 标记。

验收：

- `刚才那个任务` 能通过 ID 链回到正确 turn。
- 同一 turn 不重复派发 job。
- 同一 delivery 不重复发最终消息。
- superseded/cancelled job 不再发旧 final。

### R2：Minimal Signal Extractor

目的：把关键词从“分类器”降级为“信号抽取器”。

任务：

- Node 实现 signal extractor。
- 只抽取：
  - explicit command
  - task id / runner id / artifact id
  - force route metadata
  - session/channel binding
  - target mentions
  - surface mentions
- 不输出最终 route。

验收：

- `gateway` 只产生 `surface_mentions=["gateway"]`，不直接判 local/remote/product docs。
- `openclaw version` 不直接判本机或上游。
- 除显式命令外，自然语言默认 `needs_semantic_judge=true`。

### R3：Policy Judge Adapter

目的：用模型做主语义判定，支持主 agent、便宜模型、本地模型。

任务：

- 定义 `PolicyJudgeRequest` / `PolicyJudgeResult` schema。
- 默认 `main_grade_model` judge。
- `main_grade_model` 是独立 stateless call / ephemeral judgment session，不是当前主会话。
- cheap/local judge 先 shadow。
- judge 输入小上下文：
  - user message
  - signals
  - recent ledger summary
  - known targets
  - available actions
- judge 禁止工具调用。
- judge 不带完整 transcript。
- judge 输入限制在 1-2k tokens。
- judge prompt/schema version 写入 ledger。
- judge 输出：
  - request_kind
  - scope
  - target
  - route
  - evidence_required
  - ack_required
  - confidence
  - abstain_reason
  - reason_codes

验收：

- main-grade stateless judge 能通过 R0 golden fixtures。
- cheap/local shadow result 被记录，但不影响真实路由。
- judge timeout 有 fallback，不阻塞 ACK。
- 当前主会话上下文污染不会影响 judge 输入。
- 不同 judge prompt/schema 版本的效果可在 shadow eval 中区分。

### R3.5：Decision cache

目的：在不牺牲准确率的前提下降成本。

任务：

- 增加短 TTL route-decision cache。
- cache key 包含：
  - normalized message
  - session binding
  - target/channel binding
  - recent ledger hash
  - runtime config version
- 只缓存 validator 通过的 `RouterDecision v2`。
- cache hit 写 ledger event。
- cache miss 也写轻量 ledger metric。

验收：

- 相同上下文短时间重复提问不重复调用 judge。
- ledger hash 变化后 cache 失效。
- task progress/follow-up 默认不缓存。
- cache 不会导致 stale task status 回答。

### R4：Decision Validator + RouterDecision v2

目的：模型可以判断，但不能无约束执行。

任务：

- 新增 validator。
- 检查 JSON schema、route allowed、scope/evidence 一致性、confidence threshold。
- 低置信策略：
  - `>=0.85`：只读/低风险可执行。
  - `0.70-0.85`：只读 probe 或澄清。
  - `<0.70`：澄清或 safe fallback。
- 输出 `RouterDecision v2`。

验收：

- 模型输出 invalid JSON 时不会执行。
- scope unknown 时不假装知道。
- 有副作用动作不因 judge 误判直接执行。
- evidence_required 未满足时不能最终回答事实结论。

### R5：Runner Pool Scheduler

目的：降低轻任务冷启动，不滥用 spawn agent，同时去掉独立 runner shell loop。

任务：

- Node runner scheduler。
- 默认 2 个 runner worker。
- worker backend 初始支持 tmux 或现有 runner backend。
- 每个 job 接 `RunnerGoalContract`。
- scheduler 负责 lease、timeout、retry、health。
- 每个 job 前要求 fresh context 或隔离证明。
- scheduler 由 OpenClaw gateway extension 管理，不再默认启动 `runner-daemon.sh`。
- `runner_loop.sh` 只保留为临时 legacy adapter，后续删除。
- 增加 backpressure：
  - `max_queue_size`
  - `per_user_concurrency`
  - `lease_timeout_seconds`
  - `job_timeout_seconds`
  - `worker_unhealthy_after_failures`
- queue 满或 worker 不健康时，必须 progress/fallback，不静默吞任务。

验收：

- fresh lookup / surface query 不走 spawn 冷启动。
- runner worker busy 时能排队或使用另一个 worker。
- worker 卡死不会导致 task 永远假 running。
- `install.sh reconcile` 不再默认安装 runner systemd service 或 runner shell daemon。
- queue full / timeout / unhealthy 都有 ledger event 和用户可见结果或进度。

### R6：Native Task-bound Runner Job

目的：runner 快，但每个 job 的真相仍归 native Task/TaskFlow。

任务：

- 每个 runner job 创建或绑定 native task。
- task id 等于或映射到 runner job id。
- progress/result/artifact 写 task + ledger。
- delivery relay 从 task/ledger 发最终通知。
- RunnerGoalContract 携带安全边界：
  - access_mode
  - allowed_tools
  - allowed_hosts
  - timeout_seconds
  - max_output_chars
  - secrets_redaction_required
  - destructive_action_requires_confirmation

验收：

- 用户问 `刚才任务怎么样`，能从 task/ledger 得到一致答案。
- runner 完成但 Slack 未通知时，delivery relay 可补偿。
- tmux session 死亡不会污染 task truth。
- 默认 runner job 为 read-only。
- 写操作/部署/删除/重启不能由轻 runner 静默执行。

### R7：Execution Ledger + Follow-up Grounding

目的：解决 provenance 乱说。

任务：

- 统一 ledger event：
  - `policy_judged`
  - `route_validated`
  - `ack_sent`
  - `task_bound`
  - `runner_started`
  - `tool_used`
  - `result_ready`
  - `delivery_sent`
  - `delivery_failed`
  - `decision_cache_hit`
  - `decision_cache_miss`
  - `job_superseded`
  - `job_cancelled`
- follow-up 只读 ledger。
- ledger 缺失时明确说不知道。

验收：

- `你是怎么查的` 不再从模型记忆回答。
- `Direct tools used unavailable` 时不能声称用了 web_fetch。
- 子任务污染 session 时不会凭旧上下文下结论。
- judge decision、validator result、cache hit/miss 都进入 ledger。
- stale memory answer rate = 0。

### R8：删除/降级旧 live route 旁路

目的：减少屎山感和重复真相源。

任务：

- `octoclaw_route.py` / `octoclaw_policy.py` 从 live dependency 降级到 parity/eval。
- 大量自然语言 route regex 删除或迁为 signal extractor。
- runner playbook 降级为 legacy adapter。
- patrol 从 completion/provenance 推断退成 reconcile/repair。
- JS route/decide 保留 planner/validator，不再重复语义分类。
- install/reconcile 不再注册 `octoclaw-patrol` cron/systemd/loop。

验收：

- live route hot path 不调用 Python policy。
- 同一消息只有一份 RouterDecision。
- patrol 不再像第二套 runtime engine。
- 停掉 patrol 不影响 ACK、runner result、completion delivery、follow-up grounding。

### R9：Daemon/loop cleanup

目的：把运行面收成“一个 gateway 常驻 + 可选 runner backend”，去掉 OctoClaw 自己的默认 loop 生态。

任务：

- 删除或废弃默认安装路径：
  - `lib/patrol-loop.sh`
  - `lib/runner-daemon.sh`
  - `lib/runner_loop.sh`
  - `lib/systemd/octoclaw-patrol.service`
  - `lib/systemd/octoclaw-runner.service`
- `bin/octoclawctl.sh` 改成：
  - `status`
  - `observe-once`
  - `reconcile-once`
  - `repair-once`
  - `runner-pool-status`
  - 不再默认 `up/down/restart patrol/runner daemon`
- `install.sh` 改成：
  - 默认只 reconcile extension/config/docs/smoke。
  - 不注册 cron。
  - 不安装 OctoClaw systemd service。
  - 不启动 shell loop。
- 如需 runner pool，由 gateway extension 配置启动，或显式 opt-in backend。

验收：

- 新装环境只有 OpenClaw gateway 需要常驻。
- OctoClaw 没有默认 cron/systemd/shell loop。
- runner pool 可在 gateway 内启停和查看状态。
- `reconcile-once` / `repair-once` 可按需运行，不依赖常驻 patrol。
- macmini 部署后 Slack ACK、runner result、follow-up provenance 仍可用。

### R10：Harness gate rollout

目的：遵守 harness/eval-first 原则，防止重构后继续 case-by-case patch。

任务：

- 把 R0 fixtures 接入 CI / local validation。
- 加 shadow judge comparison report。
- 加 ACK latency synthetic test。
- 加 runner pool crash/timeout synthetic test。
- 加 delivery failure compensation synthetic test。
- 加 duplicate delivery/idempotency synthetic test。
- 加 supersede/cancel synthetic test。
- 加 runner backpressure synthetic test。
- 每次 live 事故必须新增 fixture 或 postmortem item。

验收：

- router/scope/evidence golden 通过率达标。
- cheap/local shadow report 可显示与 main-grade judge 差异。
- 没有 harness 覆盖的 router 改动不能进入 live rollout。

### R11：Feature flags 与 kill switch

目的：live 主链重构必须能灰度和快速止血。

任务：

- 新增 flags：
  - `policy_judge_live`
  - `cheap_judge_live`
  - `local_judge_live`
  - `runner_pool_enabled`
  - `delivery_relay_enabled`
  - `legacy_runner_fallback`
  - `patrol_loop_enabled`
- flag 状态写入 RouterDecision 和 ledger。
- 默认关闭 patrol loop。
- runner pool 可快速关闭并 fallback。

验收：

- macmini 上无需回滚代码即可关闭 runner pool。
- judge 异常时可 fallback 到 safe clarify/main-grade judge。
- 关闭新能力不会重新允许凭记忆回答事实。

---

## 4. 默认配置策略

初始推荐：

```json
{
  "policy_router": {
    "mode": "model_first",
    "default_judge": "main_grade_model",
    "timeout_ms": 1200,
    "confidence_threshold": 0.78,
    "cache_ttl_seconds": 120,
    "cheap_model_shadow": true,
    "local_model_shadow": true,
    "cheap_model_live": false,
    "local_model_live": false
  },
  "runner_pool": {
    "enabled": true,
    "size": 2,
    "backend": "tmux",
    "managed_by": "gateway_extension",
    "fresh_context_required": true,
    "max_queue_size": 20,
    "per_user_concurrency": 1,
    "lease_timeout_seconds": 90,
    "job_timeout_seconds": 120
  },
  "features": {
    "policy_judge_live": true,
    "cheap_judge_live": false,
    "local_judge_live": false,
    "runner_pool_enabled": true,
    "delivery_relay_enabled": true,
    "legacy_runner_fallback": true,
    "patrol_loop_enabled": false
  }
}
```

切换策略：

- 第 1 阶段：main-grade stateless judge live，cheap/local shadow。
- 第 2 阶段：cheap/local 通过 golden + live shadow 后，接低风险 surface/fresh lookup。
- 第 3 阶段：本地模型稳定后，可作为默认低成本 judge。
- 任何阶段低置信、超时、schema 错误，都 fallback 到 main-grade stateless judge 或 safe clarify。

---

## 4.1 三层 plane 归属

Live Plane：

- ACK timer
- signal extractor
- policy judge adapter
- decision validator
- route + budget planner
- delivery relay

Execution Plane：

- runner pool
- spawn_single / spawn_multi
- native task / TaskFlow binding
- optional tmux/backend worker

Evaluation Plane：

- golden fixtures
- replay
- shadow judge eval
- nightly/postmortem

归属规则：

- Live Plane 必须 Node-first、短路径、低延迟。
- Execution Plane 可以慢，但必须写 native task + execution ledger。
- Evaluation Plane 离线跑，不参与当前用户 turn。
- patrol/nightly/replay 不允许成为 live turn 的事实主链。

---

## 5. 测试与验收

必须有四类测试：

- Router golden：分类、scope、target、route、evidence。
- ACK latency：慢 judge / 慢 runner 时仍先 ACK。
- Runner pool：busy、timeout、worker crash、fresh context failed。
- Ledger follow-up：怎么查的、任务状态、delivery failure 补偿。
- Shadow judge：cheap/local 与 main-grade judge 的差异报告。
- Cost/latency/UX eval：judge cost、decision latency、ACK/final coverage。

上线前最低门槛：

- ACK p95 < 1s
- route decision p95 < 1.5s
- route accuracy >= 95%
- scope accuracy >= 95%
- dangerous false positive = 0
- provenance correctness >= 98%
- ACK p95 < 1s
- runner job result ledger coverage = 100%
- fresh lookup / surface query 不默认走 spawn 冷启动
- duplicate final delivery rate = 0
- stale/provenance memory answer rate = 0
- cost per routed turn 可观测
- judge cache hit rate 可观测

---

## 6. 实施注意事项

- 先写 fixtures，再改 router。
- 不再为单条 Slack 话术加路由 regex。
- 代码按模块切，不在 `index.js` 继续堆逻辑。
- 每个阶段都可回滚到上一版。
- 每次上线后先 shadow/replay，再切 live。
- macmini 部署后必须用真实 Slack 测 ACK、runner、follow-up。
- 不再新增 shell loop；需要常驻能力时必须挂在 gateway extension 或明确 runner backend 下。
- 不再新增自然语言 route regex 作为最终分类依据。
- 删除旧 loop 必须走 deprecation gate：
  - present but disabled
  - no live dependency
  - install no longer registers
  - remove files

---

## 7. 完成定义

这次重构完成不是看“实现了多少功能”，而是看用户体验是否恢复可信：

- 用户不会再等 1 分钟才 ACK。
- `Control UI 地址` 不会凭记忆乱答。
- `OpenClaw 有新发版吗` 不会混淆本机版本和上游 release。
- `怎么查的` 不会说不存在的工具。
- runner 完成后用户一定收到结果或失败通知。
- 代码热路径比现在更短，Python live 依赖明显减少。
- 默认部署不再包含 OctoClaw patrol/runner shell loop、cron 或 systemd unit。
- cheap/local 模型是否能上线由 shadow eval 数据决定，而不是凭感觉切换。
- 同一 turn、decision、job、delivery 的全链路可追踪。
