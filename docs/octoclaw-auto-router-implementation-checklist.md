# OctoClaw Auto Router 实施清单

> 状态：P2.5 implementation checklist（2026-04-05）  
> 关联文档：[`octoclaw-auto-router-design.md`](./octoclaw-auto-router-design.md)、[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)

---

## 1. 当前已有能力盘点

已经存在的能力，不应重做：

- `octoclaw_route.py`：contract-first route bias + gray-zone judgement
- `octoclaw_policy.py`：route hint merge / sticky lane / budget policy / prompt contract
- `model-intel.py`：catalog / health / pricing / role-aware model selection
- `budget.py`：budget tracking / cost estimate / pressure hints
- feedback loop：replay / validation / learning 已落地

---

## 2. 要拆清的 boundary

## Boundary A：Route Core vs Policy Adapter
- Route Core 只给 recommendation
- Policy Adapter 再接 runtime hooks / dispatch / handoff

## Boundary B：Budget Planner vs Policy Budget Heuristics
- budget planner 负责 recommendation bundle
- policy adapter 决定如何应用到当前 runtime

## Boundary C：Model-Intel vs Runtime Policy
- model-intel 负责数据平面
- runtime policy 负责使用这些信号，不负责生产它们

## Boundary D：Feedback Interface vs Router Core
- feedback 提供校准证据
- router core 不直接包含 replay 逻辑

---

## 3. 分阶段 checklist

## Phase 2.5A：补齐设计真相源
- [x] 新增 `docs/octoclaw-auto-router-design.md`
- [x] 新增 `docs/octoclaw-auto-router-implementation-checklist.md`
- [x] 在 `docs/octoclaw-execution-plan.md` 中引用它们
- [x] 在 `README.md` 中补入口

## Phase 2.5B：做 current code boundary map
- [x] 明确 `octoclaw_route.py` → Router Core
- [x] 明确 `octoclaw_policy.py` → Policy/Gateway Adapter
- [x] 明确 `model-intel.py` → Model-Intel Layer
- [x] 明确 `budget.py` → Budget Planner
- [x] 明确 replay/validation/learning → Feedback Interface
- [x] 明确 `lib/auto_router.py` → internal-first contract composition layer

## Phase 2.5C：定义 signal schema
- [x] request fields
- [x] contract fields
- [x] continuity fields
- [x] model signals
- [x] feedback signals
- [x] producer/consumer mapping

## Phase 2.5D：定义 recommendation contract
- [x] route
- [x] work_contract
- [x] confidence
- [x] reason_codes
- [x] model_recommendation
- [x] budget_recommendation
- [x] review_required
- [x] evidence_source
- [x] policy_phase

## Phase 2.5E：定义 budget planner contract
- [x] target_model
- [x] fallback_model
- [x] output_budget
- [x] retry_budget
- [x] latency_target
- [x] max_workers
- [x] upgrade_allowed
- [x] cost_ceiling

## Phase 2.5F：定义 internal-first recommendation surface
- [x] internal recommendation object
- [x] future OpenAI-compatible mapping notes
- [x] future OpenRouter Auto-like mapping notes
- [x] 明确“不服务化”的当前边界

---

## 4. 文件映射清单

### 核心代码
- `lib/octoclaw_route.py`
- `lib/octoclaw_policy.py`
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

- [ ] 明确 `execution_contract routing` 和 `lane-local route/budget recommendation` 的分层
- [ ] 在 recommendation 中加入：
  - `agent_scope`
  - `route_class`
  - `candidate_models`
  - `output_budget`
  - `reasoning_mode`
- [ ] `runner` 可消费 recommendation 中的 `profile / model_band / output_budget`
- [ ] `spawn_single` 可消费 recommendation 中的 `worker_pool / profile / model candidate`
- [ ] `spawn_multi` 先支持 parent planner / worker / review 的 lane-local recommendation 占位
- [ ] `control_observer` 默认 bypass delegated optimization
- [ ] 保持 `main-agent direct` 默认 stable scope
- [ ] 保持 `before_model_resolve` 不因 P2.5 baseline 自动放开

### 主要文件

- `extensions/octoclaw-runtime/policy/decide.js`
- `extensions/octoclaw-runtime/policy/route.js`
- `extensions/octoclaw-runtime/policy/model.js`
- `extensions/octoclaw-runtime/index.js`
- `lib/dispatch_task.py`
- `lib/octopus_config.py`

### 测试

- [ ] `tests/test_dispatch_task.py`
- [ ] `tests/test_runtime_policy.py`
- [ ] `tests/test_runtime_policy_js_parity.py`
- [ ] 增加 `control_observer` bypass case
- [ ] 增加 delegated-only route recommendation case

### 验收标准

- `runner / spawn_*` 路径能拿到 recommendation
- main-agent direct 默认行为不变
- `control_observer` 不被 delegated recommendation 污染

### 支撑代码
- `lib/runtime_policy_rollout.py`
- replay / validation / learning 工具链

### 文档
- `docs/octoclaw-auto-router-design.md`
- `docs/octoclaw-auto-router-implementation-checklist.md`
- `docs/octoclaw-execution-plan.md`
- `docs/octoclaw-design-foundation.md`
- `README.md`

---

## 5. 测试清单（未来实现阶段）

- [ ] signal schema tests
- [ ] route-budget integration tests
- [ ] recommendation contract tests
- [ ] router core regression tests
- [ ] replay-driven router eval tests
- [ ] model-intel update compatibility tests

---

## 6. 文档/设计阶段完成标准

- [x] 两份缺失文档补齐
- [x] current code → target layer 映射完整
- [x] recommendation contract 明确
- [x] signal schema 明确
- [x] budget planner contract 明确
- [x] internal-first vs extractable 分界明确

## 6.1 当前代码实现状态

- [x] 新增 `lib/auto_router.py`
- [x] `build_decision()` 输出 `auto_router` payload
- [x] 新增 `tests/test_auto_router.py`
- [x] internal-first recommendation surface 已可直接渲染与验证

---

## 7. 何时可宣称 `internal auto router ready`

满足以下条件：

- signal schema 已定
- recommendation contract 已定
- route / budget / model-intel 的边界已清楚
- current runtime 能明确通过 adapter 消费 recommendation
- feedback loop 能为 router 提供校准证据
- `lib/auto_router.py` 已能直接输出 internal-first recommendation payload

---

## 8. 何时才进入 `extractable`

必须至少满足：

- internal contract 稳定
- recommendation surface 稳定
- model-intel update 机制稳定
- replay-driven eval 形成常态
- route-budget integration 测试可持续运行

没满足前，不建议拆仓。
