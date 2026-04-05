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
- `lib/budget.py`

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
