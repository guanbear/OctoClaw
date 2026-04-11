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

- main-grade stateless judge live
  - 现在仍存在 `legacy_planner_until_stateless_judge_live`
- cheap/local shadow -> partial live rollout
  - 只有 shadow report，未接真实路由
- cost/latency/UX 的正式量化门槛
  - 例如 ACK p95、route decision p95、provenance correctness >= 98%
- 完整 Slack / macmini 生产验收闭环
  - 当前仍缺“真实 channel delivery + 真 runner task + 真 completion relay”的最终确认

---

## 5. 当前结论

结论不是“所有设计目标都已完成”，而是：

- 本轮重构最关键的两个系统性问题已经有代码级收口：
  - runner on-demand 假启动导致 queued 卡死
  - 多类本机 / fresh / follow-up 请求掉回 legacy 直答
- 当前本地自动化已经可以证明：
  - 路由主链比之前更贴近设计目标
  - runner 失败面不会再静默说谎
  - completion relay / delivery reconcile 的关键 contract 在回归里可见
- 还不能诚实宣称“设计文档所有验收标准都已达到”
  - 尤其是 stateless judge live、线上 ACK p95、线上 completion relay 生产闭环，这三项仍需要下一轮真实环境验收
