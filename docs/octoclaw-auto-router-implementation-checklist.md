# OctoClaw Auto Router Implementation Checklist

> 状态：P2.5 施工清单（2026-04-08，post-P2.5 深化入口已补）  
> 用途：把 [`octoclaw-auto-router-design.md`](./octoclaw-auto-router-design.md) 翻成可执行的 implementation slices。  
> 关联文档：[`octoclaw-auto-router-design.md`](./octoclaw-auto-router-design.md)、[`octoclaw-router-model-intel-deepening-design.md`](./octoclaw-router-model-intel-deepening-design.md)、[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)、[`octoclaw-design-foundation.md`](./octoclaw-design-foundation.md)

---

## 1. 这份 checklist 要解决什么问题

设计稿已经回答了：

- Auto Router 的边界是什么
- 为什么要 `plugin-first`
- 为什么是 `delegated-first`
- 为什么 runtime hot path 应该放在 Node/JS

这份 checklist 要继续往下回答：

1. 先改哪些文件
2. 每一拍做到什么算完成
3. 哪些东西先不碰
4. 哪些测试要补
5. 哪个阶段才允许放开默认行为

P2.5 之后的深化工作不再继续往这份 checklist 里平铺扩张，而是由 focused design 单独承接：

- [`octoclaw-router-model-intel-deepening-design.md`](./octoclaw-router-model-intel-deepening-design.md)

---

## 2. P2.5 的落地原则

### 2.1 当前默认不变

P2.5 第一拍不应该直接改掉当前保守默认值：

- `hard_runner_only` 默认保持现状
- `direct_model_override` 默认保持 `false`
- `before_model_resolve` 默认保持保守 rollout

第一拍的目标是：

- 先产生 recommendation
- 先记录 diff / outcome
- 先让 delegated lanes 收到 lane-local recommendation
- 不先改主 agent 的默认行为

### 2.2 `plugin-first`，不是 `service-first`

P2.5 默认目标：

- 先把 Auto Router 做成 OpenClaw 插件内部可复用的 runtime kernel
- 当前不把独立 HTTP service 当作前置里程碑
- 如果后续有跨产品复用需求，再额外长出 recommendation service

### 2.3 Node/JS 热路径优先，但不阻塞当前 repo

当前 repo 的 OpenClaw runtime extension 还是 `.js` 文件，所以这次施工要分两层理解：

- **架构所有权**：runtime hot path 归 Node/JS
- **当前仓库实现形态**：可以先继续落在 `extensions/octoclaw-runtime/policy/*.js`

也就是说：

- 不要把 P2.5 阻塞在“先搭完整 TS build 链”
- 先把热路径从 Python subprocess 语义里抽出来
- 目录边界按 future-TS-ready 方式收口

### 2.4 Python 保留为 offline / glue / evaluator

Python 在 P2.5 里继续负责：

- replay / review / validation
- feedback manifest
- calibration / learned router 实验
- model-intel backfill / analysis

Python 不再承担：

- 每轮请求热路径上的核心 recommendation 计算

---

## 3. P2.5 完成定义

满足下面这些，才算 P2.5 baseline 完成：

- 有独立的 `route recommendation` / `budget recommendation` / `route outcome` contract
- JS runtime hot path 能直接给出 delegated-lane recommendation
- replay / validation / promotion 能看到 route outcome
- shadow recommendation 有 diff logging
- `runner / spawn_single / spawn_multi` 可接 lane-local route/budget recommendation
- main-agent direct 默认仍稳定
- `control_observer` 不被混入普通业务 auto-router 训练面
- tiny judge 是可插拔选项，不是前置依赖

---

## 4. 文件落点总览

### 4.1 Runtime / plugin 面

- `extensions/octoclaw-runtime/index.js`
- `extensions/octoclaw-runtime/policy/decide.js`
- `extensions/octoclaw-runtime/policy/route.js`
- `extensions/octoclaw-runtime/policy/model.js`
- `extensions/octoclaw-runtime/policy/config.js`
- `extensions/octoclaw-runtime/policy/taxonomy.js`

建议新增：

- `extensions/octoclaw-runtime/policy/recommendation.js`
- `extensions/octoclaw-runtime/policy/outcome.js`

### 4.2 Schema / contract 面

- `schemas/runtime-policy-decision-v1.schema.json`
- `schemas/runtime-policy-replay-event-v1.schema.json`

建议新增：

- `schemas/route-recommendation-v1.schema.json`
- `schemas/budget-recommendation-v1.schema.json`
- `schemas/route-outcome-v1.schema.json`

### 4.3 Python feedback / analysis 面

- `lib/replay_summary.py`
- `lib/replay_review.py`
- `lib/replay_curate.py`
- `lib/replay_validation.py`
- `lib/replay_automation.py`
- `lib/feedback_loop.py`
- `lib/runtime_policy_rollout.py`
- `lib/dispatch_task.py`
- `lib/model_health.py`
- `lib/model-intel.py`
- `lib/model_pricing.py`
- `lib/model-sources.json`
- `lib/model-benchmarks.json`
- `lib/runtime_snapshot.py`
- `lib/octopus_config.py`

### 4.4 测试面

- `tests/test_runtime_policy.py`
- `tests/test_runtime_policy_js_parity.py`
- `tests/test_runtime_policy_replay_schema.py`
- `tests/test_dispatch_task.py`
- `tests/test_replay_summary.py`
- `tests/test_replay_review.py`
- `tests/test_replay_curate.py`
- `tests/test_replay_validation.py`
- `tests/test_replay_automation.py`
- `tests/test_runtime_policy_rollout.py`

---

## 5. 建议拆 PR / slice

## 5.1 Slice A：抽出 recommendation contract

### 目标

把当前 `buildDecision(...)` 里隐含的 recommendation 语义抽出来，形成独立 contract，但不改变现有默认行为。

> 2026-04-07 baseline：
> 已落一版薄 `route_recommendation` / arbitration seam，当前只做规则冲突裁决与 replay 记录；
> `tiny judge` 仍未接入，继续保持 `rule_fallback`。

### Checklist

- [ ] 设计并落地 `route-recommendation/v1` schema
- [ ] 设计并落地 `budget-recommendation/v1` schema
- [ ] 设计并落地 `route-outcome/v1` schema
- [ ] 在 runtime policy 决策中明确区分：
  - `recommendation`
  - `resolution`
  - `execution_result`
- [ ] 在 `extensions/octoclaw-runtime/policy/` 新建 recommendation helper 模块
- [ ] 保持当前 `runtime-policy decision` schema 向后兼容
- [ ] 不在这一拍改 `hard_runner_only` 默认值
- [ ] 不在这一拍改 `direct_model_override` 默认值

### 主要文件

- `extensions/octoclaw-runtime/policy/decide.js`
- `extensions/octoclaw-runtime/policy/recommendation.js`
- `schemas/route-recommendation-v1.schema.json`
- `schemas/budget-recommendation-v1.schema.json`
- `schemas/route-outcome-v1.schema.json`
- `schemas/runtime-policy-decision-v1.schema.json`

### 测试

- [ ] 给 recommendation schema 加结构化 fixture
- [ ] 补 `tests/test_runtime_policy.py`
- [ ] 补 `tests/test_runtime_policy_js_parity.py`
- [ ] 补 `tests/test_runtime_policy_replay_schema.py`

### 验收标准

- JS 侧能独立生成 recommendation payload
- 现有 runtime policy tests 不回归
- 新 schema 可以被 fixture 校验

---

## 5.2 Slice B：把 delegated-lane recommendation 接进 runtime hot path

### 目标

先让 `runner / spawn_single / spawn_multi` 真正消费 lane-local recommendation；main-agent direct 继续稳定。

### Checklist

- [x] 明确 `execution_contract routing` 和 `lane-local route/budget recommendation` 的分层
- [x] 建立 protected direct lanes baseline：
  - `control_observer`
  - `session_control`
  - workflow/session provenance
  - task action / queue / details / status
- [x] workflow/session metadata query 默认归到 `control_observer`
- [x] current-session model switch / session mutation 默认归到 `session_control`
- [x] protected lanes 默认 bypass delegated optimization
- [ ] protected lanes 不混入普通业务 auto-router 训练面
- [x] 建立高频误判 goldens：
  - `你现在是啥模型`
  - `你是啥模型`
  - `刚才是不是子任务做的`
  - `有没有走 dispatch`
  - `八爪鱼状态 / details / queue`
  - `切换到 Mini Max M2.7`
  - 模型测速 / 首 token / 吞吐对比
- [x] 建立 Python / JS / runtime 副本 parity check
- [x] 把 protected lane 写入 replay / review / summary，支持 nightly diff：
  - `policy_resolved.protectedLane`
  - `dispatch_called.protectedLane`
  - `protected_lane_misroute`
- [ ] 在 recommendation 中加入：
  - `agent_scope`
  - `route_class`
  - `candidate_models`
  - `output_budget`
  - `reasoning_mode`
- [ ] `runner` 可消费 recommendation 中的 `profile / model_band / output_budget`
- [ ] `spawn_single` 可消费 recommendation 中的 `worker_pool / profile / model candidate`
- [ ] `spawn_multi` 先支持 parent planner / worker / review 的 lane-local recommendation 占位
- [x] `control_observer` 默认 bypass delegated optimization
- [x] 保持 `main-agent direct` 默认 stable scope
- [x] 保持 `before_model_resolve` 不因 P2.5 baseline 自动放开
- [x] 模型测速 / 比速 query 默认走 `runner + inspect_report`
- [x] 增加 local telemetry snapshot workflow：
  - `lib/model_telemetry_report.py`
  - `runner_playbook_model_telemetry_report`
- [x] gateway fallback plain-text log 可回灌 `model-health`
- [x] stale-gated health feedback hook 已接到 Python policy 决策入口
- [x] `model_health_feedback` 通过 runtime config 显式开关，不默认放开 main-agent override

### 主要文件

- `extensions/octoclaw-runtime/policy/decide.js`
- `extensions/octoclaw-runtime/policy/route.js`
- `extensions/octoclaw-runtime/policy/model.js`
- `extensions/octoclaw-runtime/index.js`
- `lib/dispatch_task.py`
- `lib/octopus_config.py`
- `lib/model_health_backfill.py`
- `lib/model_telemetry_report.py`
- `lib/runner_playbooks.py`

### 测试

- [ ] `tests/test_dispatch_task.py`
- [x] `tests/test_runtime_policy.py`
- [x] `tests/test_runtime_policy_js_parity.py`
- [x] `tests/test_route_goldens.py`
- [x] `tests/test_runner_runtime.py`
- [x] `tests/test_model_health_backfill.py`
- [x] `tests/test_model_telemetry_report.py`
- [x] 增加 `control_observer` bypass case
- [ ] 增加 delegated-only route recommendation case

### 验收标准

- `runner / spawn_*` 路径能拿到 recommendation
- main-agent direct 默认行为不变
- `control_observer` 不被 delegated recommendation 污染
- 高优先级 workflow/meta 问题不再误落到 `spawn_single`
- 模型测速类 query 不再误落到 `spawn_single`
- fallback timeout/auth/failover 能进入 `model-health`
- Python / JS / 运行副本对同一 golden case 给出一致 lane

---

## 5.3 Slice C：route outcome + shadow rollout

### 目标

让 recommendation 不只是“算出来”，而是能被 replay / validation / promotion 看见。

### Checklist

- [ ] 为 runtime replay event 增加 recommendation / resolved target / outcome 字段
- [ ] replay summary 能看到 route diff
- [ ] replay validation 能汇总 route outcome
- [x] nightly 分析能汇总高频误判与 protected-lane 漏判
- [x] nightly packet 会优先挑出 short protected-lane / direct slow reply / delegation explanation risk
- [x] nightly reply review 默认尝试语义 review，失败时回退 packet-only review
- [ ] feedback manifest 能关联 route outcome artifacts
- [ ] rollout check / recommendation 能感知 shadow diff 指标
- [ ] 记录三类分开的 outcome：
  - `main-agent direct`
  - `runner`
  - `subagent/team`
- [ ] 记录以下关键字段：
  - `execution_contract`
  - `agent_scope`
  - `route_class`
  - `recommended_model`
  - `resolved_model`
  - `output_budget`
  - `route_source`
  - `sticky_applied`
  - `fallback_taken`
  - `runner_health_snapshot`
  - `queue_pressure_band`
  - `quota_pressure_band`
  - `actual_cost`
  - `actual_latency`
  - `validation_outcome`

### 主要文件

- `schemas/runtime-policy-replay-event-v1.schema.json`
- `lib/replay_summary.py`
- `lib/replay_review.py`
- `lib/replay_curate.py`
- `lib/replay_validation.py`
- `lib/replay_automation.py`
- `lib/feedback_loop.py`
- `lib/runtime_policy_rollout.py`

### 测试

- [ ] `tests/test_runtime_policy_replay_schema.py`
- [ ] `tests/test_replay_summary.py`
- [ ] `tests/test_replay_review.py`
- [ ] `tests/test_replay_curate.py`
- [ ] `tests/test_replay_validation.py`
- [ ] `tests/test_replay_automation.py`
- [ ] `tests/test_runtime_policy_rollout.py`

### 验收标准

- 可以对同一请求看到 `旧决策 vs 新 recommendation`
- promotion gate 能建立在 validation + outcome 上，而不是只看旧 heuristic
- delegated lanes 的结果可以单独分析

---

## 5.4 Slice D：policy adapter 收口健康 / 配额 / runtime capacity

### 目标

让 route recommendation 和最终 resolved target 之间的“运行时过滤层”清楚收口，而不是散在不同脚本里。

### Checklist

- [ ] 明确 `policy adapter` 的输入输出 contract
- [ ] 把以下因素作为 final resolution 的一等输入：
  - model health
  - cooldown
  - quota pressure
  - runner health
  - queue pressure
  - worker availability
- [ ] 推荐和最终 resolved target 分开记录
- [ ] fallback chain 的触发原因结构化
- [ ] `model_health.py` 与 runtime recommendation 的字段命名对齐
- [ ] `runtime_snapshot.py` 暴露给 route outcome 可消费的 capacity snapshot

### 主要文件

- `extensions/octoclaw-runtime/policy/model.js`
- `extensions/octoclaw-runtime/policy/recommendation.js`
- `lib/model_health.py`
- `lib/runtime_snapshot.py`
- `lib/runtime_observer.py`
- `lib/dispatch_task.py`

### 测试

- [ ] `tests/test_model_health.py`
- [ ] `tests/test_runtime_observer.py`
- [ ] `tests/test_dispatch_task.py`
- [ ] 新增 fallback / quota / queue-pressure case

### 验收标准

- recommendation 和 resolution 分层清楚
- fallback / cooldown / queue pressure 不再是隐式副作用
- outcome 中能解释“为什么没用推荐模型”

---

## 5.5 Slice E：model-intel source adapters / OpenRouter sync

### 目标

把 `model-intel / auto-update layer` 从抽象能力收成明确 source adapter，让模型目录、价格、上下文、provider 与生态信号可以自动更新，但不把 `OpenRouter rankings` 误当成最终 truth。

### Checklist

- [x] 明确区分两类 source：
  - `directory_pricing`
  - `ecosystem_signal`
- [x] 在 `model-intel` 中显式支持：
  - `openrouter_catalog`
  - `openrouter_rankings`
  - `models_dev_registry`
- [x] 定义 `OpenRouter catalog` 字段映射：
  - model id
  - pricing
  - context window
  - provider
  - modality / capability hints
- [x] 定义 `rankings` 的权重与衰减规则
- [x] 明确 `free model` 过滤或降权规则
- [x] 增加 freshness / decay / stale fallback 语义
- [x] 增加 last-good snapshot / stale-if-error cache
- [x] 保持本地 truth 优先级高于生态信号：
  - `openclaw_live_compat`
  - local pricing / overrides
  - model health / cooldown
  - runtime quota / capacity truth
- [x] 支持手动 refresh 入口
- [ ] 支持自动 refresh 调度占位
- [x] 失败时回退到 last-good snapshot，不阻塞 runtime

### 主要文件

- `lib/model-intel.py`
- `lib/model_pricing.py`
- `lib/model-sources.json`
- `lib/model-benchmarks.json`
- `lib/octopus_config.py`

### 测试

- [x] `tests/test_model_intel.py`
- [x] 新增 OpenRouter source mapping case
- [x] 新增 `models.dev` source mapping case
- [ ] 新增 stale / fallback case
- [x] 新增 rankings 不压过本地 truth case
- [x] 新增 free-model filtered rankings case

### 验收标准

- `model-intel refresh` 能产出带 source freshness 的 catalog snapshot
- `OpenRouter catalog` 可以更新目录与价格字段
- `models.dev` adapter 可以更新 capability / limits / modality 字段
- `OpenRouter rankings` 只作为低权重生态信号
- 免费模型不会误导 paid auto-routing
- runtime route 不会因为外部 source 短暂失败而退化成不可用

---

## 5.6 Slice F：tiny judge adapter（可选，不是前置）

### 目标

只给模糊样本增加便宜 judge，不把它做成前置必经路径。

### Checklist

- [ ] 定义 `judge adapter` 接口
- [ ] 支持 `rule-first -> judge-on-ambiguous`
- [ ] 明确 judge 前置条件：
  - protected lanes 已稳定
  - goldens / parity 已接入
  - judge 不接管稳定边界
- [ ] judge 输出只包含：
  - `route_class`
  - `budget_hint`
  - `confidence`
- [ ] judge 不直接决定最终 provider/model
- [ ] judge behind config
- [ ] 默认关闭或仅 shadow
- [ ] 支持：
  - local judge
  - cheap cloud judge
- [ ] 明确 timeout / error fallback：
  - judge fail -> 回到 rule-only recommendation

### 主要文件

- `extensions/octoclaw-runtime/policy/recommendation.js`
- `extensions/octoclaw-runtime/policy/config.js`
- `lib/octopus_config.py`

### 测试

- [ ] rule hit 不触发 judge
- [ ] ambiguous case 触发 judge
- [ ] judge timeout / failure 回退

### 验收标准

- tiny judge 是增强项，不是系统依赖
- 没有 judge 也能完整跑 P2.5 baseline

---

## 5.7 Slice G：offline calibration / learned-router prep

### 目标

先把训练面准备好，不把 learned router 当前置条件。

### Checklist

- [ ] 导出可训练的 route outcome dataset
- [ ] 增加 threshold calibration 脚本或 notebook
- [ ] 增加 `(model, budget)` 组合评估指标
- [ ] 在 validation 报告里区分：
  - route correctness
  - budget correctness
  - final delivery correctness
- [ ] 给后续 learned router 预留：
  - route features
  - candidate labels
  - quality/cost/latency outcome

### 主要文件

- `lib/router_eval.py`
- `lib/replay_validation.py`
- `lib/replay_summary.py`
- `lib/replay_curate.py`
- `lib/feedback_loop.py`

### 验收标准

- 训练面可导出
- 可以离线看 route threshold / budget threshold 的收益
- learned router 仍然可以完全延后

---

## 6. 建议 PR 顺序

1. **PR-1：schema + recommendation extraction**
2. **PR-2：delegated-lane runtime consumption**
3. **PR-3：route outcome + shadow rollout**
4. **PR-4：policy adapter health/capacity 收口**
5. **PR-5：model-intel source adapters / OpenRouter sync**
6. **PR-6：tiny judge adapter（可选）**
7. **PR-7：offline calibration / learned-router prep**

推荐不要打包成一个大 PR。

---

## 7. 当前明确不做

- 不在第一拍放开 main-agent auto override
- 不在第一拍把 `hard_runner_only` 直接删掉
- 不在第一拍引入在线 bandit / RL
- 不在第一拍把 Auto Router 抽成独立 HTTP service
- 不在第一拍强依赖本地小模型
- 不在第一拍重写全部 Python 逻辑

---

## 8. 首批新增文件建议

### 必加

- `docs/octoclaw-auto-router-implementation-checklist.md`
- `schemas/route-recommendation-v1.schema.json`
- `schemas/budget-recommendation-v1.schema.json`
- `schemas/route-outcome-v1.schema.json`
- `extensions/octoclaw-runtime/policy/recommendation.js`

### 建议加

- `extensions/octoclaw-runtime/policy/outcome.js`
- `tests/fixtures/route-recommendation/`
- `tests/fixtures/route-outcome/`

---

## 9. 交接提示

如果直接按这份清单开工，最稳的起手式是：

1. 先做 Slice A，不改默认行为
2. 然后做 Slice C，让 replay / validation 先看见 recommendation
3. 再做 Slice B，把 delegated lanes 真正接上

这样做的原因是：

- 先有 contract，后面不容易返工
- 先有 outcome，后面每一拍都能被验证
- 先有 shadow，再放真实生效，风险最低
