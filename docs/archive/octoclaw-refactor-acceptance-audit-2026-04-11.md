# OctoClaw Refactor Acceptance Audit

日期：2026-04-11

关联文档：

- [octoclaw-router-policy-refactor-plan-2026-04-10.md](./octoclaw-router-policy-refactor-plan-2026-04-10.md)
- [octoclaw-router-policy-refactor-2026-04-10.md](./octoclaw-router-policy-refactor-2026-04-10.md)
- [octoclaw-execution-plan.md](./octoclaw-execution-plan.md)

---

## 1. 范围

本次验收只评估“本轮重构后已经落到代码与自动化回归里的能力”，不把仍处于设计目标、尚未 live rollout 的未来项伪装成“已完成”。

验收口径分三类：

- `达成`：已有自动化覆盖，且本轮本地回归通过。
- `部分达成`：代码能力已落地，但缺真实线上量化或端到端验收。
- `未达成`：设计文档提出，但当前还没有完整实现或稳定验收证据。

---

## 2. 本轮已验证项

### 2.1 Router / Intent / Surface

- `达成`：`execution_followup` 统一走 `direct + control_observer + execution_ledger/taskflow_state evidence`
  - 覆盖：`怎么查的`、`刚才那个任务判定是啥`、`single 成功了吗`
  - 证据：`tests.test_runtime_policy`、`tests.test_octoclaw_runtime_extension`
- `达成`：`fresh_live_lookup` 走 `direct + latency_ack + web_lookup evidence`
  - 覆盖：OpenClaw release / Memory 更新查询
  - 证据：`tests.test_runtime_policy`、`tests.test_router_policy_v2_goldens`
- `达成`：稳定本机 surface 走 `local_surface_lookup`
  - 覆盖：`系统负载`、`当前版本`、`Control UI 地址`
  - 证据：`tests.test_runtime_policy`、`tests.test_octoclaw_runtime_extension`、`tests/fixtures/router-policy-goldens-v2.json`
- `达成`：新增 operator surface registry 覆盖 `service_health` 与 `backup_usage`
  - 当前口径：`direct + fast_local_check + inspect_report + local_probe evidence`
  - 说明：不再回退到 `legacy direct_answer`

### 2.2 Runner / Materialization / Completion

- `达成`：runner on-demand bootstrap 会显式打开内部 loop 允许位
  - 证据：`tests.test_dispatch_task`
- `达成`：runner bootstrap 秒退会被识别为 `runner_bootstrap_failed`
  - 不再留下静默 queued ghost task
  - 证据：`tests.test_dispatch_task`
- `达成`：runner materialization failure 会显式返回 capability-bound failure
  - 不再伪装成“已经派发”
  - 证据：`tests.test_dispatch_task`
- `达成`：completion relay / delivery reconcile 的基础 contract 已覆盖
  - 覆盖 `delivery_pending`、`delivery_observed`、`delivery_compensated`、`delivery_failed`、`retry_deferred`
  - 证据：`tests.test_delivery_relay_reconcile`、`tests.test_task_state_anchor_seed`、`tests.test_octoclaw_runtime_extension`

### 2.3 Runtime snapshot / Optional backend

- `达成`：runtime snapshot / status 会显式报告 optional tmux workbench 状态
  - 覆盖：`not_configured`、`tmux_session_missing`、`tmux_runner_window_missing`
  - 证据：`tests.test_runtime_snapshot`
- `达成`：tmux / runner / workbench 不再被当成状态真相源
  - 当前只作为 optional backend / operator visibility

---

## 3. 本轮自动化结果

- `达成`：局部 acceptance 子集通过
  - `python3 -B -m unittest tests.test_runtime_policy tests.test_octoclaw_runtime_extension tests.test_router_policy_v2_goldens tests.test_route_goldens tests.test_policy_judge_shadow_report`
  - 结果：`110 tests OK`
- `达成`：runner / relay / snapshot / synthetics 通过
  - 已在本轮先前回归中通过：
    - `tests.test_dispatch_task`
    - `tests.test_runner_runtime`
    - `tests.test_delivery_relay_reconcile`
    - `tests.test_runtime_snapshot`
    - `tests.test_harness_synthetics`
- `达成`：`harness_gate quick`
  - 命令：`python3 -B lib/harness_gate.py --preset quick --format json`
  - 结果：`145 tests OK`

---

## 4. 对照设计文档的达成度

### 4.1 已达成

- R0：golden fixtures 已覆盖近期坏例中的核心场景
  - Control UI
  - 本机版本
  - OpenClaw release / Memory 更新
  - 任务追问
  - provenance follow-up
- K1：policy judge cascade + SLA 已落地
  - main_grade_model -> cheap/local -> planner fallback
  - 分档超时预算
  - fallback_stage / final_judge_source / attempts / timeout_budget_ms 记录
- K2：scope boundary hardening 已落地
  - local_instance lookup -> direct
  - upstream_project lookup -> direct + latency_ack（runner unavailable 时显式 degraded）
  - sticky route bypass for local_surface_lookup / fresh_live_lookup / execution_followup
  - operator surface registry: service_health / backup_usage
  - runner bootstrap 秒退检测 -> runner_bootstrap_failed -> capability_bound_failure
- I1：canonical session boundary 已落地
  - detectSessionBoundary 检测 contaminated_subagent_identity
  - resolveAckDeliverySessionKey 过滤 subagent session
  - buildPolicyMetadata 使用 canonical session key
  - before_prompt_build 注入 contamination warning
  - after_response 阻断 contaminated control_observer 回复
- I2+I3：materialization contract 已收口
  - delegated_materialization schema (lane/kind/status/execution_contract)
  - capability_bound_failure schema
  - runner / spawn_single / spawn_multi 统一产出 materialization facts
  - executed=false 必带 capability_failure + explicit reason
- J2：single semantic truth / dispatch decision source 已落地
  - decision_source taxonomy: policy_judge / policy_judge_cascade_fallback / deterministic_front_gate / legacy_planner
  - final_judge_source / fallback_stage / attempts 全链路记录
  - replay/ledger 写入 routerDecisionSource
- J3：delegated ACK at route commit 已落地
  - pre_dispatch_ack + latency_ack 双通道
  - shouldSendPreDispatchAck / shouldSendLatencyAck 守卫
  - channel delivery + timeout + fallback to progress update
- J4：final-answer execution guard 已落地
  - ungrounded_tool_provenance_claim_blocked
  - undelegated_route_response_blocked
  - contaminated_control_observer_response_blocked
- P5I：materialization contract 基本收口
  - 无 execution identity 时不再声称已委派
  - materialization failure 有显式原因
- P5J：follow-up grounding 与 direct slow-path 基线已落地
  - follow-up 不再默认靠旧记忆
  - fresh lookup 有 latency ack contract
- P5G：completion relay / snapshot 关键 contract 已落地并有自动化覆盖

### 4.2 部分达成

- ACK timer 独立化
  - 代码与 synthetics 已有覆盖
  - 但“Slack 真实链路 p95 < 1s”目前没有本地自动量化结论，仍需 macmini/线上验收
- runner smoke without resident runner
  - 本地 contract 已成立，on-demand bootstrap 主根因已修
  - 但 macmini 真实 OpenClaw/gateway/slack 链路还需再做一次生产验收
- route accuracy / scope accuracy
  - 现有 golden 与 quick 回归在增长
  - 但尚没有足够大的 labeled eval 集支撑“>=95%”的定量结论

### 4.3 未达成

- J1 burst message decomposition
  - extractPromptText 已能拆出 burst 消息文本
  - 但尚未实现"每条子消息独立走路由判定"的完整 decomposition
  - 优先级最低，可作为后续增量
- main-grade stateless judge live
  - 现在仍存在 `legacy_planner_until_stateless_judge_live`
- cheap/local shadow -> partial live rollout
  - 只有 shadow report，未接真实路由
- cost/latency/UX 的正式量化门槛
  - 例如 ACK p95、route decision p95、provenance correctness >= 98%
- 完整 Slack / macmini 生产验收闭环
  - 当前仍缺"真实 channel delivery + 真 runner task + 真 completion relay"的最终确认

---

## 5. 当前结论

本轮（K1+K2+I1+I2+I3+J2+J3+J4）完成后：

- K1 judge cascade 已落地：main_grade -> cheap/local -> planner fallback，分档超时预算，全链路记录
- K2 scope boundary 已落地：local_instance -> direct，upstream_project -> direct+latency_ack（不再静默 fallback），sticky bypass，operator surface 扩展，bootstrap 秒退检测
- I1 session boundary 已落地：contamination 检测、canonical session 解析、subagent 过滤、before_prompt_build 注入、after_response 阻断
- I2+I3 materialization contract 已收口：delegated_materialization schema、capability_bound_failure schema、runner/spawn 统一产出 facts
- J2 decision source 已落地：decision_source taxonomy、final_judge_source、replay/ledger 记录
- J3 delegated ACK 已落地：pre_dispatch_ack + latency_ack 双通道、channel delivery + timeout
- J4 final-answer guard 已落地：ungrounded provenance blocking、delegation failure blocking

本地自动化验证：`harness_gate quick` 152 tests OK。

仍需后续继续：
- J1 burst message decomposition（每条子消息独立路由）
- stateless judge live 替换 legacy_planner
- macmini 真实生产验收闭环
