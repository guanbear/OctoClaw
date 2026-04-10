# OctoClaw Router Policy Refactor Review Draft

日期：2026-04-10  
状态：review draft，先评审设计，未进入实现  
目标：快回复、低成本、少误判、执行事实可信、代码架构更简洁

---

## 1. 这次要修的根问题

过去几轮的问题不是某一句话没覆盖，而是 router policy 的主判定方式错了：

- 试图用关键词把自然语言分到固定 lane，天然会漏。
- 同一句话在 front gate、route、tool policy、follow-up grounding 里被多次解释。
- 主 agent、runner、patrol、task-state 对“任务有没有真的执行”有不同说法。
- ACK、执行、完成通知、provenance 没有绑定同一份事实。

因此这次重构不能继续扩大 regex。  
新的原则是：

> 自然语言语义默认交给模型 judge；硬规则只做机器可确定的安全短路。

---

## 2. 设计原则

### 2.1 宁可用模型，不用不靠谱关键词硬判

关键词只能做低层 signal extraction，不做最终分类。

允许硬判的只有：

- 显式命令：`details <task_id>`、`queue`、`status` 这类已经是产品命令的输入。
- 显式 task id / runner id / known artifact id。
- 系统结构化 metadata：例如 `forceRoute`、已有 task binding、channel/session binding。

不允许硬判的自然语言：

- `你的 Control UI 地址是啥`
- `你现在啥版本`
- `OpenClaw 有新发版吗`
- `刚才是不是主 agent 查的`
- `macmini 上 gateway 正常吗`

这些都需要语义判断 scope、target、evidence source，不能靠词面硬分。

### 2.2 ACK 不等模型

快回复不是靠“更快分类”，而是靠独立的 ACK timer。

- 收到消息后立刻启动一个短定时器，例如 500-800ms。
- 如果 direct answer / route decision 在定时器内完成，就不额外发 ACK。
- 如果没完成，先发中性 ACK：`我先看一下，马上给你结论。`
- ACK 不声明已经查过、不声明已经派发，只说明系统开始处理。

这样即使 policy judge 或 runner 慢，用户也不会干等。

### 2.3 Judge 必须 stateless、小上下文、结构化输出

Policy Judge 不是让当前 Slack 主会话自由发挥。  
即使默认使用“主 agent 同等级大模型”，也必须是独立的 stateless judge call / ephemeral judgment session。

换句话说：

- 不是当前主会话凭完整聊天历史判断。
- 不是带工具的 agent 自己边查边判。
- 不是让子任务污染过的 session 继续解释路由。
- 而是一个无工具、短上下文、JSON-only 的判定器。

输入包括：

- 当前用户消息
- 当前会话绑定信息
- 最近 execution ledger 摘要
- 已知 target 列表，例如 `current_session`、`current_gateway`、`macmini`、`ai.guanbear.com`、`upstream_openclaw`
- 可用 action 列表，例如 `answer_direct`、`ledger_read`、`local_probe`、`remote_probe`、`web_lookup`、`spawn_work`

输出包括：

- `request_kind`
- `scope`
- `target`
- `route`
- `evidence_required`
- `ack_required`
- `budget_band`
- `confidence`
- `abstain_reason`
- `reason_codes`

约束：

- 不允许工具。
- 不带完整 transcript。
- 输入建议限制在 1-2k tokens。
- 输出只接受 schema JSON。
- 超时或 schema invalid 必须 fallback。
- judge 结果必须写 execution ledger。

### 2.4 低置信就 abstain，不强判

分类准确性不靠“永远判对”，而靠：

- 允许 `undetermined`
- 允许要求澄清
- 允许安全 fallback
- 禁止低置信时执行有副作用动作

例如 scope 不清楚时：

- 可以回复：`你是想查当前 Slack 连接的 gateway，还是 macmini 本机？`
- 或只做只读、低风险 probe，不能假装知道。

---

## 3. 新 Router Pipeline

```text
User message
  -> ACK Timer
  -> Minimal Signal Extractor
  -> Policy Judge
  -> Decision Validator
  -> Route + Budget Planner
  -> Native Task / Runner Goal Contract
  -> Execution Ledger
  -> Delivery Relay
  -> Follow-up reads Ledger only
```

### 3.0 理想运行时形态

重构后的目标不是再多加一个 OctoClaw daemon，而是把 live 主链收回 OpenClaw gateway 这一条常驻 runtime。

```text
OpenClaw Gateway / Channel Runtime
  -> OctoClaw Node Runtime Extension
      -> ACK timer
      -> signal extractor
      -> policy judge adapter
      -> decision validator
      -> route + budget planner
      -> runner pool scheduler
      -> execution ledger
      -> delivery relay

Optional runner worker backend
  -> tmux
  -> node child process
  -> native worker session future
```

必须常驻：

- OpenClaw gateway / channel runtime

可选常驻：

- runner pool workers，默认 2 个，用于降低轻任务冷启动

不再常驻：

- patrol loop
- runner shell loop
- cron patrol
- separate Python route/patrol engine

按需执行：

- reconcile-once
- repair-once
- eval/replay/nightly
- migration/compat tools

这条边界很重要：OctoClaw 不再安装一堆自己的守护进程来补主链路。主链路由 gateway extension 驱动，runner worker 只是 execution backend。

### 3.0.1 三层 plane

为了避免组件继续互相抢职责，重构后固定分成三层：

```text
Live Plane
  -> ACK timer
  -> signal extractor
  -> policy judge adapter
  -> decision validator
  -> route + budget planner
  -> delivery relay

Execution Plane
  -> runner pool
  -> spawn_single / spawn_multi
  -> native task / TaskFlow binding
  -> optional tmux/backend worker

Evaluation Plane
  -> golden fixtures
  -> replay
  -> shadow judge eval
  -> nightly/postmortem
```

约束：

- Live Plane 必须 Node-first、短路径、低延迟。
- Execution Plane 可以慢，但必须写 native task + execution ledger。
- Evaluation Plane 离线跑，不参与当前用户 turn。
- patrol / nightly / replay 不允许成为 live turn 的事实主链。

### 3.1 Minimal Signal Extractor

Node 实现，极窄、快速、无模型。

它只抽取 signal，不做最终语义分类：

- explicit command
- explicit task id
- explicit route override
- known session binding
- possible target mentions
- possible artifact references

输出示例：

```json
{
  "explicit_command": "",
  "task_id": "",
  "target_mentions": ["macmini"],
  "surface_mentions": ["gateway"],
  "needs_semantic_judge": true
}
```

注意：`surface_mentions=["gateway"]` 不等于 `local_surface_lookup`。  
它只是给 judge 的证据。

### 3.2 Policy Judge

默认使用 main-grade stateless policy judge；可选切到便宜模型或本地模型。

这里的 `main_grade_model` 表示“使用主 agent 同等级模型能力”，但不是当前主会话本身。

推荐配置：

```json
{
  "policy_router": {
    "mode": "model_first",
    "default_judge": "main_grade_model",
    "timeout_ms": 1200,
    "confidence_threshold": 0.78,
    "fallback": "safe_ack_or_clarify",
    "cache_ttl_seconds": 120,
    "candidates": {
      "main_grade_model": {
        "enabled": true,
        "provider": "stateless_ephemeral_judge",
        "model": "inherit_main_grade",
        "tools": "none",
        "max_context_tokens": 2000
      },
      "cheap_model": {
        "enabled": false,
        "provider": "openai_compatible",
        "model": "",
        "tools": "none"
      },
      "local_model": {
        "enabled": false,
        "provider": "openai_compatible",
        "base_url": "http://127.0.0.1:11434/v1",
        "model": "",
        "tools": "none"
      }
    }
  }
}
```

阶段策略：

1. 先默认用 `main_grade_model` judge，保准确。
2. 便宜模型和本地模型先 shadow run，不影响真实路由。
3. golden cases 达标后，再让便宜/本地模型接一部分低风险请求。
4. 低置信或模型超时，回到 `main_grade_model` 或 safe fallback。

成本策略：

- 对同一 normalized message + session binding + recent ledger hash 做短 TTL cache。
- cache 命中时不重复调用 judge。
- cheap/local 先 shadow，不直接接真实流量。
- cheap/local 达标后只接低风险 surface/fresh lookup。

### 3.3 Decision Validator

Validator 不重新做语义分类，只做一致性校验：

- JSON schema 是否有效
- route 是否允许
- scope 和 evidence 是否匹配
- 有副作用动作是否需要确认
- confidence 是否达标
- follow-up 是否必须读 ledger

如果 validator 不通过：

- 不执行危险动作
- 不编 provenance
- 走澄清或安全只读 fallback

### 3.4 Decision Cache

省钱不能靠一上来使用便宜模型，而应先减少不必要调用。

cache key 建议包含：

- normalized user message
- session binding
- channel/target binding
- recent ledger hash
- runtime config version

cache value 只能缓存 validator 通过的 `RouterDecision v2`。

约束：

- TTL 短，例如 120 秒。
- 涉及 task status/progress 的 follow-up 默认不缓存。
- ledger hash 变化后必须失效。
- cache 命中也要写 `decision_cache_hit` ledger event。

### 3.5 全链路 ID 与幂等

每个用户 turn 必须有稳定 ID，贯穿 ACK、judge、runner、ledger、delivery。

```text
turn_id
  -> decision_id
  -> task_id / runner_job_id
  -> ledger event ids
  -> delivery_id
```

约束：

- ACK event 必须绑定 `turn_id`。
- RouterDecision 必须绑定 `decision_id`。
- runner/spawn 必须绑定 `task_id` 或 `runner_job_id`。
- final delivery 必须绑定 `delivery_id`。
- follow-up 只能通过这些 ID 回读，不允许靠聊天记忆猜。

同一 turn 的重复处理必须幂等：

- 同一 `turn_id + normalized_message + ledger_hash` 不重复派 job。
- 同一 `delivery_id` 不重复发最终通知。
- 用户发起新请求时，可以 supersede 旧 job。
- 用户取消时，task/runner job 必须进入 `cancelled` 或 `superseded`。

### 3.6 Feature flags 与 kill switch

这次重构触及 live 主链，必须支持灰度和快速止血。

建议 flags：

```json
{
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

约束：

- 任一新 live 能力必须可关闭。
- fallback 不能重新引入“凭记忆回答事实”。
- flag 状态必须写入 RouterDecision / ledger，方便复盘。

当前实现补充：

- feature flags 现在不是分散读取，而是通过统一 runtime snapshot 解析后下发到 JS/Python 热路径。
- 支持环境变量 kill switch，优先级高于磁盘配置；其中 `OCTOCLAW_RUNTIME_SAFE_MODE=1` 会把系统切到更保守的止血姿态。
- safe mode 不会把系统打回“任意凭记忆回答”，而是：
  - 锁定 judge 到 `main_grade_model`
  - 关闭 cheap/local judge live
  - 关闭 runner pool live
  - 保留 legacy runner fallback
  - 保持 delivery relay 可单独受控
- rollout flags 会进入：
  - RouterDecision `runtime_switches`
  - replay event `rolloutFlags`
  这样后续看 `policy_resolved / policy_judged / route_validated` 时，可以直接知道当时是哪个 rollout 姿态。

### 3.7 ACK / Progress / Final 三段消息契约

用户体验问题不能只靠“发消息”，必须区分消息语义。

- ACK：只表示系统开始处理，不得声称已查、已派发、已完成。
- Progress：表示 job/task 已启动、排队、重试、超时、失败等中间状态。
- Final：必须绑定 result、evidence、delivery ledger。

建议字段：

```json
{
  "message_kind": "ack | progress | final",
  "turn_id": "...",
  "task_id": "...",
  "delivery_id": "...",
  "evidence_refs": []
}
```

UX deadline：

- `ack_deadline_ms`: 500-800
- `decision_deadline_ms`: 1200-1500
- `first_progress_deadline_ms`: 3000-5000
- `max_user_silence_seconds`: 20

超过 deadline 必须发 progress 或明确失败，不能静默。

---

## 4. Router Decision Contract

新 contract 不再只给 `intent_class`，而是把 scope 和 evidence 写清楚。

```json
{
  "schema_version": "octoclaw.router_decision/v2",
  "request_kind": "surface_query",
  "scope": "remote_instance",
  "target": "macmini",
  "route": "runner",
  "work_contract": "inspect_report",
  "evidence_required": ["remote_probe", "execution_ledger"],
  "ack": {
    "required": true,
    "text": "我先看一下 macmini 上的 gateway 状态，马上给你结论。"
  },
  "budget": {
    "latency_target": "interactive",
    "cost_band": "low",
    "max_output_tokens": 400
  },
  "confidence": 0.84,
  "decision_source": "policy_judge",
  "reason_codes": ["surface_query", "target_macmini", "read_only_probe"]
}
```

### 4.1 request_kind

只表达“请求大类”，不是最终路由：

- `chat_or_explain`
- `execution_followup`
- `surface_query`
- `fresh_external_lookup`
- `work_request`
- `ambiguous`

### 4.2 scope

这是之前最容易错的地方，必须显式化：

- `current_session`
- `current_gateway`
- `current_workspace`
- `task_context`
- `local_host`
- `remote_host`
- `upstream_project`
- `product_docs`
- `unknown`

其中 `work_request` 不能因为没有明确本机/远程对象就落成 `unknown`。代码修改、测试、部署等执行请求默认绑定 `current_workspace`；调研、写作、方案整理等交付型请求默认绑定 `task_context`。这两类 scope 表示“交给执行图/子任务处理”，不表示已经知道了外部事实。

### 4.3 evidence_required

回答必须绑定证据源：

- `none`
- `execution_ledger`
- `local_probe`
- `remote_probe`

### 4.4 provenance guard

执行事实比模型叙述优先级更高。回复中如果出现“我用了 `web_fetch` / `exec` / `openclaw` 命令查的”这类工具来源声明，必须能在 execution ledger 中找到对应 direct tool 记录；否则回复要被替换成“当前没有可验证工具事实，不能声称已经查过”。这条 guard 不是路由分类规则，而是事实完整性约束。

### 4.5 ACK hot path

pre-dispatch ACK 不能阻塞主回复链路。prompt build 阶段只负责异步投递 eager ACK，并给 channel delivery 设置短超时；dispatch 工具阶段仍会执行 `ensurePreDispatchAck`，作为投递补偿与 progress fallback。这样 ACK 失败不会拖慢主 agent，同时执行链路仍保留可观测记录。

### 4.6 stateless judge adapter

policy judge 不是把模型调用硬塞进 `buildDecision()`，而是走独立 adapter：

- fixture adapter：用于 replay / golden / regression
- command adapter：用于接本地脚本或便宜模型入口
- openai-compatible adapter：用于接本地模型服务或兼容网关

judge 结果只有在以下条件同时满足时才能覆盖 legacy planner：

- schema 正常
- `route/scope/evidence_required` 通过 validator
- confidence 高于阈值
- 没有 `forceRoute`
- 没有 sticky lane 抢占

否则必须显式回退到 legacy planner，并把 `judgeValidationProblems` 写进 replay。

### 4.7 delivery relay

delivery relay 的目标不是“帮用户回答”，而是保证系统知道：

- 哪个 delegated reply 已经进入待通知状态
- 哪条 assistant final 已经被用户可见地写出
- 哪些任务在 agent 结束时仍处于“待用户可见 final”

当前最小事件集合：

- `delivery_pending`
- `delivery_observed`
- `delivery_agent_end_pending`
- `delivery_compensated`
- `delivery_failed`
- `delivery_retry_deferred`

这三类事件写入独立 relay ledger，后续 patrol/reconciler 只消费 ledger，不再从 Slack 现象反推。
其中真实 completion relay 发送链路也必须把结果写回同一 ledger，而不是只让 Node extension 侧“事后猜到”。
如果 completion relay 刚刚失败，reconciler 不应在下一次 turn 里立刻无冷却重试；应进入短冷却窗口，再由后续 turn 或 repair 工具继续补偿。
- `web_lookup`
- `taskflow_state`
- `artifact_read`

如果 `evidence_required` 不是 `none`，最后回答必须能说明证据来自哪里。

---

## 5. 如何保证分类更准确

无法数学保证每次都对，但可以系统性降低错误并让错误可控。

### 5.1 不让关键词做最终分类

旧方案最大问题是：

```text
关键词 -> intent_class -> route
```

新方案改成：

```text
signals -> model judge -> validator -> route
```

关键词只作为 signal，不能直接声称“这是本机查 status”。

### 5.2 用模型判 scope

最难的不是识别 `gateway`，而是判断用户说的是：

- 当前 gateway
- macmini gateway
- VM gateway
- OpenClaw 产品文档里的 gateway

这类必须由模型结合上下文判断。  
如果上下文不够，模型必须输出：

```json
{
  "scope": "unknown",
  "route": "direct",
  "abstain_reason": "target_instance_ambiguous"
}
```

然后系统澄清，不强查。

### 5.3 用 confidence threshold

建议阈值：

- `>= 0.85`：可以直接执行只读/低风险路线。
- `0.70 - 0.85`：只允许只读 probe 或发澄清。
- `< 0.70`：不能执行，必须澄清或 safe fallback。

### 5.4 用 shadow eval 验证便宜/本地模型

便宜模型和本地模型不能一开始接真实流量。

流程：

- 主 agent judge 真实生效。
- cheap/local judge 同步 shadow 输出。
- 对比 golden cases 和真实结果。
- 达到阈值后逐步放量。

建议门槛：

- route accuracy >= 95%
- scope accuracy >= 95%
- dangerous false positive = 0
- provenance correctness >= 98%
- ack latency p95 < 1s

### 5.5 每个 live 事故进入 harness

不再“补一句 regex”，而是把事故变成 fixture：

```json
{
  "message": "你的controlui的访问地址是啥",
  "expected": {
    "request_kind": "surface_query",
    "scope": "current_gateway_or_bound_instance",
    "route": "runner",
    "evidence_required": ["local_probe"]
  },
  "must_not": [
    "answer_from_memory",
    "web_lookup_product_docs",
    "claim_direct_tool_without_ledger"
  ]
}
```

每次改 router 都跑 fixture，而不是凭感觉。

### 5.6 Harness gate 是上线门槛

Harness 不是事后分析，而是 router policy 上线门槛。

每次修改 router / judge / validator / runner contract 前，必须先补或确认 fixture。  
每次上线前至少跑：

- router golden
- scope golden
- ACK latency test
- policy judge shadow report
- runner pool timeout/crash test
- ledger follow-up test
- delivery failure compensation test

不允许以“这次只是修一句话”为理由跳过 harness。

### 5.7 成功指标

这次重构是否成功，用指标判断，不凭感觉：

- ACK p95 < 1s
- route decision p95 < 1.5s
- route accuracy >= 95%
- scope accuracy >= 95%
- dangerous false positive = 0
- provenance correctness >= 98%
- runner job ledger coverage = 100%
- fresh lookup / surface query 不默认走 spawn 冷启动
- duplicate delivery rate = 0
- stale/provenance memory answer rate = 0
- judge cache hit rate 可观测
- cost per routed turn 可观测

---

## 6. Runner / Native Task / tmux

### 6.1 Runner 改成 Goal Contract

Runner 不再接固定命令模板，而是接结构化目标。

```json
{
  "schema_version": "octoclaw.runner_goal/v1",
  "goal": "查询 OpenClaw 上游最新 release 和 Memory 相关更新",
  "scope": "upstream_project",
  "target": "openclaw/openclaw",
  "allowed_actions": ["web_lookup", "github_api"],
  "evidence_required": ["web_lookup"],
  "output_schema": "octoclaw.runner_result/v1"
}
```

Runner 可以自主选择工具和 fallback，但必须返回：

- 做了什么
- 用了什么证据源
- 查到什么
- 失败原因
- 是否可安全告知用户

当前已落地的最小 execution truth：

- `runner goal contract` 进入 runner artifacts，作为执行边界与 native task 绑定摘要。
- runner dispatch 入口先生成统一 `runner runtime resolution`，把 queue counts、health snapshot、dispatch mode 固化下来。
- stale running job 在 runtime resolution 前会先尝试回收，并把 task-state 同步成 failed。
- worker heartbeat 现在会记录 `failure_streak / last_job_status`，连续失败会转成不健康 worker。
- runner 入队后写 `task_bound`。
- runner 入队时补 `dispatch_started / progress_note`。
- 缺少健康常驻 worker 时，dispatch 可以 bootstrap 一个后台 runner worker，而不是只能等外部 daemon。
- worker 真正开始执行时写 `runner_started`。
- task finalize 继续写 `result_ready`。
- completion relay 成功/失败会回写 `delivery_sent` / `delivery_failed` task event。
- `materialization_failed` 的 dispatch 不再登记 `delivery_pending`，避免“没派发成功却像在等 final”。

### 6.2 常驻 runner pool 用来降冷启动

`spawn_single` 冷启动对轻任务太重。对于 release lookup、gateway/status、日志回读、轻量 probe 这类任务，常驻 runner pool 是合理的。

推荐默认：

- 2 个 runner worker 常驻。
- worker 接 `RunnerGoalContract`，不接固定 shell 命令。
- scheduler 负责 queue、lease、timeout、retry。
- 每个 job 前必须 fresh context，或者能证明上下文隔离。
- 每个 job 后必须写 result + provenance ledger。
- worker 不直接对用户下最终结论，最终通知走 delivery relay。

常驻 runner pool 解决的是速度，不解决真相。  
真相仍然必须来自 TaskFlow + ledger。

runner pool 的 scheduler 应该在 Node runtime extension 内，或由 gateway extension 启动/管理。  
不再用独立 `runner-daemon.sh` + `runner_loop.sh` 作为默认主链路。

在完整 scheduler 完成前，dispatch 入口至少要有一层最小 gate：

- 先读 `runner_pool` config。
- 先读 queue pressure / worker health。
- 明确给出 `dispatch_mode=daemon|ondemand|deferred`。
- 同一 session 命中 `per_user_concurrency` 时，直接返回结构化阻塞原因。
- worker 连续失败达到阈值时，也要直接视为 unhealthy。
- 如果允许 fallback 且没有健康常驻 worker，runtime 要能自己拉起一个后台 worker。
- queue 满或 worker unhealthy 时，返回结构化 capability failure，而不是继续声称任务已经派发。

### 6.2.1 Runner pool backpressure

runner pool 不能变成新的隐形堵点，必须有 backpressure。

建议默认：

```json
{
  "runner_pool": {
    "size": 2,
    "max_queue_size": 20,
    "per_user_concurrency": 1,
    "lease_timeout_seconds": 90,
    "job_timeout_seconds": 120,
    "worker_unhealthy_after_failures": 2,
    "busy_strategy": "queue_or_progress"
  }
}
```

约束：

- queue 满了不能继续吞任务，必须告知用户或 fallback。
- lease 超时必须释放 job 并写 ledger。
- worker 连续失败要标记 unhealthy。
- 同一用户/同一 channel 的轻任务要限并发。
- job timeout 后必须 final 或 progress failure，不能卡在 running。

### 6.2.2 RunnerGoalContract 安全边界

RunnerGoalContract 必须携带安全与工具边界。

新增字段：

- `access_mode`: `read_only | write_allowed`
- `scope`: `local_host | remote_host | upstream_project | product_docs | current_workspace | task_context`
- `allowed_tools`
- `allowed_hosts`
- `timeout_seconds`
- `max_output_chars`
- `secrets_redaction_required`
- `destructive_action_requires_confirmation`

低风险 runner 默认 `read_only`。  
任何写操作、部署、删除、重启都必须走确认或 spawn/review lane，不能由轻 runner 静默执行。

### 6.3 Native Task / TaskFlow 做 job 真相源

不建议把“常驻 runner worker 本身”建模成一个长期 native task。  
否则一个 worker 一天处理 100 个 job，会让用户追问 task id、artifact、完成状态时全部混在一起。

正确分工：

```text
runner worker: 常驻进程 / session
runner job: 每次绑定一个 native task
```

推荐路径：

```text
User request
  -> RouterDecision
  -> create/bind native task: task-123
  -> enqueue RunnerGoalContract(job_id=task-123)
  -> runner-1 consumes job
  -> runner writes progress/result to task-123 + execution ledger
  -> TaskFlow marks done/failed
  -> Delivery relay notifies user
```

Native Task / TaskFlow 负责：

- task id
- parent/child lineage
- state
- artifact
- progress
- completion truth
- delivery target

Runner、spawn、tmux、daemon 都只是 backend，不是真相源。

### 6.4 tmux 只做 optional supervisor

tmux 可以作为 runner worker backend，尤其在 macOS/本机环境里很实用：

- 容易保活。
- 容易 attach 查看现场。
- 比重造一套 supervisor 快。
- 适合 2 个轻量 runner worker。

但 tmux 不能承担：

- 路由判断
- 状态真相
- provenance 真相
- 上下文正确性保证

如果使用 tmux runner pool：

- 每个 job 前必须 fresh context。
- `/new` 成功要可观测。
- job result 必须写 ledger。
- tmux session 死亡不能导致 task-state 说谎。
- tmux window/session 由 Node scheduler 管理，不再由独立 runner daemon 管理。

### 6.5 多 agent 不默认用 tmux

tmux 适合 runner pool，不代表所有 multi-agent 都应该上 tmux。

建议分层：

- 轻量、频繁、低风险、需要快的任务：runner pool，可用 tmux supervisor。
- 复杂研究/代码/评审：native `spawn_single` / native task session 优先。
- 真正并行多 agent：native TaskFlow 优先，tmux 只做 fallback 或 operator workbench。
- 需要人工观察/调试：tmux 很适合。
- 需要严格隔离和可追溯：依赖 TaskFlow + ledger，不依赖 tmux。

因此最终接口应抽象成：

```text
RunnerPoolBackend
  - tmux
  - node_daemon
  - native_worker_session future
```

上层 router、ledger、delivery 不依赖具体 backend。  
如果 OpenClaw 未来提供稳定 persistent worker session，再把 backend 从 tmux 换成 native。

### 6.6 patrol 退出常驻主链路

`patrol-loop.sh` 不应该继续作为常驻事实补偿主循环。  
重构后 patrol 的职责收缩为按需工具：

- `reconcile-once`
- `repair-once`
- `delivery-retry-once`
- `nightly/report`

patrol 可以读 ledger 和 taskflow 做修复，但不能再成为：

- completion truth source
- provenance truth source
- route fallback engine
- notify 主链路

completion 和 notify 应由 task finalize / runner result / delivery relay 触发。  
patrol 只处理异常修复，且默认不常驻。

---

## 7. 代码收敛方向

### 7.1 Node-first live hot path

应留在 Node 的：

- ACK timer
- signal extractor
- policy judge adapter
- decision validator
- route + budget planner
- runner goal contract builder
- runner pool scheduler
- execution ledger writer/reader
- delivery relay
- follow-up grounding

### 7.2 Python 退出 live router

Python 保留：

- replay/eval/nightly
- model-intel batch sync
- report/review
- migration/compat
- heavy patrol repair

Python 不再作为实时路由真相源。

当前已落地的收口（2026-04-10）：

- `dispatch_task.py` 的 live hot path 已改成“默认必须携带预计算 `policy_json`”，不再静默调用 Python `octoclaw_policy.py`。
- 如果确实要做兼容回退，必须显式打开 `runtime_policy.features.legacy_policy_fallback` 或 `OCTOCLAW_LEGACY_POLICY_FALLBACK=1`。
- `spawn_multi` 的 planner/review step 已从主 `RouterDecision` 合成，不再额外通过 Python policy 派生子决策。
- extension 内 `resolveToolPolicyContext`、`octoclaw_route`、`/octoroute` 已统一切到 Node `buildDecision(...)`，旧 `inferRoute(...)` 不再参与 live tool policy 语义。
- `octoclaw_policy_decide` 仍保留，但角色已经收缩为 debug/parity helper。
- `bin/octoclawctl.sh` 已改成以 `observe-once / reconcile-once / repair-once / runner-pool-status` 为主；`patrol` 不再是默认受支持 target。
- `install.sh` 默认不再安装 patrol/runner loop、cron、systemd/tmux 常驻运行面，并会清理旧 cron/systemd 默认入口。
- `patrol.py` 默认作为按需 reconcile/repair 工具；runner 自动重启只有显式开关下才允许。
- `lib/patrol-loop.sh` / `lib/runner-daemon.sh` / `lib/runner_loop.sh` 已降级为 legacy wrapper 或 legacy loop，避免继续把旧 loop 生态当成推荐主链。
- `lib/systemd/octoclaw-patrol.service` / `lib/systemd/octoclaw-runner.service` 也已降成 compat-only 模板，只用于显式 opt-in。
- 新增本地统一 harness gate：`python3 lib/harness_gate.py --preset quick|full`，把 router golden、route parity、runtime policy、policy judge shadow report、dispatch/runner/runtime extension 等关键回归收成固定入口。
- `eval_suite.py` 在调用 legacy `runner_loop.sh` 做评测时，已显式启用 compat 开关，避免评测链和运行时链对 legacy loop 的语义不一致。
- 第一批 harness synthetics 已落地：ACK progress fallback、slow direct-lookup latency-ack、delivery compensation 幂等、runner backpressure gate，并纳入 `harness_gate.py` 的 preset。
- `lib/policy_judge_shadow_report.py` 已落地，用于把 cheap/local shadow judge 与主决策按 `route/request_kind/scope/target/evidence_required` 做对照汇总。

### 7.3 要删除或降级

- `octoclaw_route.py` / `octoclaw_policy.py` 作为 live parity 路由源：降级到测试/迁移。
- 大量自然语言 route regex：删除或降级为 signal extractor。
- runner fixed playbook：降级为 legacy adapter。
- patrol completion/provenance 推断：改为 ledger reconcile，不再自己讲故事。
- `patrol-loop.sh`：删除默认常驻路径，保留按需 reconcile/repair。
- `runner-daemon.sh` / `runner_loop.sh`：删除默认常驻路径，runner pool 改由 Node scheduler 管理。
- `octoclaw-patrol.service` / `octoclaw-runner.service`：废弃，不再作为默认安装产物。
- install/reconcile 默认只安装 gateway extension，不再额外注册 OctoClaw cron/systemd/shell loop。

---

## 8. 实施阶段

### Phase 0：只做文档和 fixtures

- 敲定本设计。
- 把最近 Slack 失败样例写成 golden fixtures。
- 明确 route/scope/evidence 期望。

### Phase 1：Policy Judge shadow mode

- 新增 Node policy judge adapter。
- 默认主 agent judge 生效或 shadow，按最终确认选择。
- cheap/local judge 只 shadow。
- 不改 runner 执行。

### Phase 2：RouterDecision v2

- 引入 `request_kind/scope/target/evidence_required`。
- route.js 不再自行扩大自然语言分类。
- validator 接管安全一致性检查。

### Phase 3：ACK timer 独立化

- ACK 不再依赖 route 完成。
- 500-800ms 未完成就发中性 ACK。
- 禁止 ACK 提前声称“已查/已派发”。

### Phase 4：RunnerGoalContract

- fresh lookup / surface query 改成 goal contract。
- 旧 playbook 只作为 adapter。
- runner result 必须写 ledger。

### Phase 5：Execution Ledger + Follow-up

- direct tool、runner、spawn、delivery 全部写同一 ledger。
- `怎么查的`、`任务怎么样` 只读 ledger。
- ledger 缺失时明确说不知道，不允许模型补叙事。
- 当前已落地的归一化 replay event：
  - `policy_judged`
  - `route_validated`
  - `ack_sent`
  - `tool_used`
  - `decision_cache_hit`
  - `decision_cache_miss`
- grounding 已直接读取 judge / validation / cache / ack 事实，不再只看 `policy_resolved` 的大杂烩 payload。
- task event / delivery relay 也已经并入 follow-up facts：
  - `job_cancelled`
  - `job_superseded`
  - `completion_relay_sent / completion_relay_failed / user_notified`
  - `delivery_observed / delivery_compensated / delivery_reconciled_delivered`

### Phase 6：删除旧 live route 旁路

- 收掉 Python live parity。
- 删除重复 route regex。
- patrol 退成 observe/reconcile/repair。

---

## 9. Review 问题

需要你确认的不是代码细节，而是这些产品/架构取舍：

1. 是否接受“自然语言语义默认交给模型 judge”，而不是继续关键词分类？
2. 默认 judge 是否先用主 agent，cheap/local 先 shadow？
3. ACK 是否接受“中性 ACK timer”，不等路由完成？
4. scope 是否必须成为一等字段？
5. follow-up 是否严格只读 ledger，ledger 缺失就承认不知道？
6. tmux 是否只保留为 optional supervisor，不再做状态真相源？

如果这 6 点确认，后续代码重构就围绕这条主线做，不再继续 case-by-case patch。
