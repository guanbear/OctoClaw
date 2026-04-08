# OctoClaw Auto Router Boundary Map

> 状态：RM4 baseline（2026-04-08）  
> 用途：把 `router / model-intel` 哪些可以抽、哪些仍然必须留在 OctoClaw runtime 里明确写成 canonical boundary。  
> 关联文档：[`octoclaw-auto-router-design.md`](./octoclaw-auto-router-design.md)、[`octoclaw-router-model-intel-deepening-design.md`](./octoclaw-router-model-intel-deepening-design.md)、[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)

---

## 1. 一句话判断

> **现在已经可以讨论“抽离 recommendation kernel”，但还不能把 OctoClaw runtime adapter 一起抽走。**

换句话说：

- 可以抽的是：
  - recommendation contract
  - model-intel facts plane
  - replay-driven router eval baseline
- 不能抽的是：
  - runtime policy adapter
  - delegated lane execution adapter
  - observer / patrol / display / task action

---

## 2. 候选包的正确职责

如果后续真的抽成一个独立子包，它更像：

- `octoclaw-auto-router`

而不是：

- 新的 runtime
- 新的 task substrate
- 新的 IM/display system

这个候选包的职责应当只包括：

1. signal extraction
2. route recommendation
3. budget recommendation
4. model-intel facts plane
5. replay/eval evidence baseline

---

## 3. 当前可公开的 surface shortlist

### 3.1 Recommendation Payload

- producer:
  - `lib/auto_router.py`
- schema:
  - `octoclaw.auto_router.recommendation/v1`
  - `octoclaw.auto_router.signal/v1`
  - `octoclaw.auto_router.router_core/v1`
  - `octoclaw.auto_router.budget_planner/v1`
  - `octoclaw.auto_router.model_intel/v1`
  - `octoclaw.auto_router.adapter/v1`

判断：

- `signal / router_core / budget_planner / model_intel` 可以视为 candidate-public
- `adapter` 目前仍然偏 runtime-aware，应暂时视为 semi-public

### 3.2 Model-Intel Facts Plane

- producers:
  - `lib/model-intel.py`
  - `lib/model-intel-sync.mjs`
- files:
  - `tmp/octopus/model-catalog.json`
  - `tmp/octopus/model-policy.json`
  - `tmp/octopus/model-intel-source-status.json`

判断：

- 这是当前最适合未来抽离的 data plane
- 但仍保持 file-based / runtime-local，不急着先变服务

### 3.3 Router Eval Baseline

- producer:
  - `lib/router_eval.py`
- schema:
  - `octoclaw.router_eval/v1`

判断：

- 可以作为 extractable evidence surface
- 目前仍依赖 OctoClaw replay shape，不应假装成通用 benchmark system

---

## 4. 当前明确属于 internal-only 的耦合

### 4.1 Runtime Policy Adapter

- files:
  - `lib/octoclaw_policy.py`
  - `extensions/octoclaw-runtime/policy/decide.js`

原因：

- 这里不只是在“用 recommendation”
- 还在处理：
  - protected lane
  - route hint
  - tool gating
  - hook contract
  - pre-dispatch ack

这些都属于 OctoClaw runtime 语义，不属于 extractable router core。

### 4.2 Delegated Lane Consumption

- files:
  - `lib/dispatch_task.py`
  - `lib/octoclaw_spawn.py`

原因：

- 这里处理的是：
  - runner / spawn lane 的 execution contract
  - worker pool 落地
  - prompt/handoff/runtime constraints

这些不是 router package 本身要负责的。

### 4.3 Observer / Patrol / Display

- files:
  - `lib/runtime_observer.py`
  - `lib/patrol.py`
  - `lib/task_display.py`

原因：

- 这些组件消费 router 结果，但它们的主职责是 runtime truth / user surfaces
- 它们应该继续留在 OctoClaw 主仓

---

## 5. RM4 之后可以怎么抽

正确顺序应该是：

1. 先冻结 recommendation schema
2. 先冻结 facts-plane source/status shape
3. 先抽统一 public surface 壳
   - `manifest`
   - `facts`
   - `recommend`
   - `eval`
4. 再抽 source adapter 和 router eval
5. runtime adapter 继续留在 OctoClaw
6. 只有当 policy adapter / lane consumption 再瘦一轮之后，才讨论独立服务或 package

---

## 6. 明确不做什么

这一轮不做：

- 不把 `octoclaw_policy` 抽出去
- 不把 `patrol / observer / display` 混进 router package
- 不把 Auto Router 立刻做成 OpenAI-compatible proxy service
- 不为了“可抽离”先重写整套 runtime

---

## 7. RM4 完成标准

当以下判断成立时，RM4 baseline 就算完成：

1. 有一份 canonical boundary map
2. 有一份 machine-readable manifest
3. 可以明确指出 candidate-public surface
4. 可以明确指出 internal-only coupling
5. 后续如果讨论拆包，不再需要重新争论边界
