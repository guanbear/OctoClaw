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
- [ ] 新增 `docs/octoclaw-auto-router-design.md`
- [ ] 新增 `docs/octoclaw-auto-router-implementation-checklist.md`
- [ ] 在 `docs/octoclaw-execution-plan.md` 中引用它们
- [ ] 在 `README.md` 中补入口

## Phase 2.5B：做 current code boundary map
- [ ] 明确 `octoclaw_route.py` → Router Core
- [ ] 明确 `octoclaw_policy.py` → Policy/Gateway Adapter
- [ ] 明确 `model-intel.py` → Model-Intel Layer
- [ ] 明确 `budget.py` → Budget Planner
- [ ] 明确 replay/validation/learning → Feedback Interface

## Phase 2.5C：定义 signal schema
- [ ] request fields
- [ ] contract fields
- [ ] continuity fields
- [ ] model signals
- [ ] feedback signals
- [ ] producer/consumer mapping

## Phase 2.5D：定义 recommendation contract
- [ ] route
- [ ] work_contract
- [ ] confidence
- [ ] reason_codes
- [ ] model_recommendation
- [ ] budget_recommendation
- [ ] review_required
- [ ] evidence_source
- [ ] policy_phase

## Phase 2.5E：定义 budget planner contract
- [ ] target_model
- [ ] fallback_model
- [ ] output_budget
- [ ] retry_budget
- [ ] latency_target
- [ ] max_workers
- [ ] upgrade_allowed
- [ ] cost_ceiling

## Phase 2.5F：定义 internal-first recommendation surface
- [ ] internal recommendation object
- [ ] future OpenAI-compatible mapping notes
- [ ] future OpenRouter Auto-like mapping notes
- [ ] 明确“不服务化”的当前边界

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

- [ ] 两份缺失文档补齐
- [ ] current code → target layer 映射完整
- [ ] recommendation contract 明确
- [ ] signal schema 明确
- [ ] budget planner contract 明确
- [ ] internal-first vs extractable 分界明确

---

## 7. 何时可宣称 `internal auto router ready`

满足以下条件：

- signal schema 已定
- recommendation contract 已定
- route / budget / model-intel 的边界已清楚
- current runtime 能明确通过 adapter 消费 recommendation
- feedback loop 能为 router 提供校准证据

---

## 8. 何时才进入 `extractable`

必须至少满足：

- internal contract 稳定
- recommendation surface 稳定
- model-intel update 机制稳定
- replay-driven eval 形成常态
- route-budget integration 测试可持续运行

没满足前，不建议拆仓。
