# OctoClaw Auto Router 设计稿

> 状态：P2.5 canonical design（2026-04-05）  
> 用途：定义 OctoClaw 内部可拆分 Auto Router 核心的边界、分层和 contract。  
> 关联文档：[`octoclaw-auto-router-implementation-checklist.md`](./octoclaw-auto-router-implementation-checklist.md)、[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)、[`octoclaw-design-foundation.md`](./octoclaw-design-foundation.md)

---

## 1. 文档目的

这份文档回答的不是“OctoClaw 要不要继续做 router”，而是：

1. OctoClaw 里哪些能力已经构成了 **Auto Router 基础**
2. 这些能力该如何从完整 runtime 中切出一个 **可抽离的 router core**
3. 在不拆仓、不服务化的前提下，如何先把 **内部接口** 做正确

P2.5 的目标不是马上把 OctoClaw 变成通用代理，而是：

> **先把 router 相关能力在 OctoClaw 内部收成一个边界清楚、可持续演进、未来可独立开源的 Auto Router 子系统。**

### 当前实现状态（2026-04-05）

P2.5 的 internal-first baseline 已经落地：

- `lib/auto_router.py`
  - 统一 signal / router_core / budget_planner / adapter / model_intel contract
  - 直接输出 internal-first recommendation payload
- `lib/octoclaw_policy.py`
  - `build_decision()` 现在附带 `auto_router` recommendation

这意味着：

> **P2.5 已从纯文档阶段进入“internal-first contract 已实现”的状态。**

---

## 2. 非目标

当前阶段不做：

- 不把整个 OctoClaw runtime 变成 router
- 不立即拆成独立仓库
- 不做完整 OpenAI-compatible proxy / gateway
- 不重写 observer / patrol / IM/display / substrate
- 不把 replay / learning 逻辑塞进 router core 本体

一句话：

> **P2.5 先收边界，不先收部署形态。**

---

## 3. 为什么现在要做 Auto Router

当前 OctoClaw 已经不只是 `route score` 脚本了，而是逐步形成了：

- signal extraction
- route / work-contract 决策
- model / budget 决策
- model-intel / health / cooldown
- replay / validation / learning feedback

如果这一层不单独定义，后面会有两个坏结果：

1. **整个 OctoClaw 被误读成一个黑盒 router**
2. **真正可以独立沉淀的 router core 永远绑死在当前 runtime 细节里**

所以现在要做的不是“急着拆”，而是：

> **先把 Auto Router 的内部边界、输入、输出、分层和演化路径钉死。**

---

## 4. 总体结构

推荐把 Auto Router 收成 5 层：

```text
Signal Layer
  -> Router Core
       -> Budget Planner
            -> Policy / Gateway Adapter
                 -> Model-Intel / Auto-Update Layer

Feedback Loop (replay / validation / learning)
  -> feeds calibration data into Signal / Router / Budget layers
```

关键原则：

- **router core 只做 recommendation / decision**
- **policy adapter 负责接入当前 runtime**
- **feedback loop 是校准面，不是 router 本体**

---

## 5. 五层结构详解

## 5.1 Signal Layer

### 目标
把当前分散在 route / policy / budget / feedback 工具链中的输入信号，收成标准 router input。

### 输入来源
- task text / command / metadata
- `work_contract_hint`
- `route_hint`
- sticky lane / follow-up continuity
- session context / resume signals
- model health / cooldown / availability
- pricing / quota / budget pressure
- replay / validation / learning evidence
- runtime policy phase

### 输出
一个标准化 signal object，例如：

```json
{
  "request": {
    "task": "...",
    "command": "...",
    "metadata": {}
  },
  "contract": {
    "work_contract_hint": "inspect_report",
    "artifact_need": true,
    "durable_runtime_need": false,
    "parallel_gain": "low",
    "risk_level": "low"
  },
  "continuity": {
    "route_hint": "spawn_single",
    "sticky_lane": "runner",
    "followup_kind": "ack",
    "session_resume": {}
  },
  "model_signals": {
    "health": {},
    "cooldown": {},
    "quota_pressure": {},
    "pricing": {}
  },
  "feedback_signals": {
    "replay_summary": {},
    "validation_status": {},
    "promotion_eligibility": "",
    "learning_flags": []
  }
}
```

### 当前代码映射
- `lib/octoclaw_route.py`：早期 signal 抽取和 hard gates
- `lib/octoclaw_policy.py`：metadata / sticky lane / route hint merge
- `lib/model-intel.py`：model capability / health / price输入
- `lib/budget.py`：cost / budget pressure输入
- feedback loop：`replay_summary.py`、`replay_validation.py`、`learning_log.py`

---

## 5.2 Router Core

### 目标
只负责 recommendation，不直接耦合具体 runtime 执行逻辑。

### 建议拆成两段

#### A. Rule Layer
- hard runner gates
- direct veto / spawn veto
- work-contract-first bias
- durable runtime / artifact / coordination need

#### B. Semantic Layer
- gray-zone route judgement
- route confidence
- semantic review trigger
- optional tiny local judge 预留位

### 输出
router core 输出应至少包含：

```json
{
  "route": "runner",
  "work_contract": "inspect_report",
  "confidence": 0.91,
  "reason_codes": ["hard_runner_only", "inspect_report_contract"],
  "required_evidence": [],
  "review_required": false,
  "next_evaluation_target": "replay"
}
```

### 当前代码映射
- `lib/octoclaw_route.py`
  - hard gate
  - `infer_work_contract_hint`
  - `contract_driven_route_bias`
  - `should_request_semantic_review`

---

## 5.3 Budget Planner

### 目标
把“选模型”和“选预算”统一成一个 planner，而不是只选 model。

### 核心问题
当前预算和路由虽然已经存在，但还没有正式被定义成 router 的一层。

### 预算规划对象应至少包含

```json
{
  "target_model": "minimax-portal/MiniMax-M2.7-highspeed",
  "fallback_model": "zai/glm-4.7",
  "output_budget": "small",
  "retry_budget": 1,
  "latency_target": "interactive",
  "max_workers": 1,
  "upgrade_allowed": true,
  "cost_ceiling": "low"
}
```

### 当前代码映射
- `lib/budget.py`
- `lib/octoclaw_policy.py::budget_policy`
- `lib/model-intel.py` 的 role-aware selection 结果

### 原则
- budget planner 不替代 router core
- budget planner 是 router recommendation 的并列输出层

---

## 5.4 Policy / Gateway Adapter

### 目标
把 router core recommendation 接入当前 OctoClaw runtime，而不让 runtime 反过来污染 router core。

### 负责的事情
- merge route hint / sticky lane / follow-up policy
- 映射到 dispatch / hook / prompt contract
- provider 偏好、隐私限制、fallback chain
- 未来兼容 OpenAI-like recommendation output

### 当前代码映射
- `lib/octoclaw_policy.py`

### 原则
- adapter 可以依赖当前 runtime
- router core 不应直接依赖 adapter

---

## 5.5 Model-Intel / Auto-Update Layer

### 目标
把 model catalog / pricing / health / cooldown / capability profile 视为独立数据平面。

### 负责的事情
- capability profile
- pricing refresh
- health / cooldown refresh
- availability signals
- plan/quota state
- auto-update pipeline

### 当前代码映射
- `lib/model-intel.py`
- `lib/model_health*.py`
- `lib/model_plan_state.py`
- `lib/model_pricing.py`

### 原则
- 这层未来最适合成为可独立的支撑层
- Auto Router 不应直接把 provider-specific 逻辑写死在 route core 里

---

## 6. 当前代码映射表

| 当前模块 | 当前职责 | 目标层 |
|---|---|---|
| `lib/auto_router.py` | internal-first signal / recommendation / adapter contract aggregation | Auto Router composition layer |
| `lib/octoclaw_route.py` | route heuristics / work-contract bias / gray-zone judgement | Router Core |
| `lib/octoclaw_policy.py` | route merge / sticky lane / budget policy / dispatch-facing decision | Policy / Gateway Adapter |
| `lib/model-intel.py` | model scoring / capability / role preference / health signal整合 | Model-Intel / Auto-Update |
| `lib/budget.py` | budget tracking / cost estimation / pressure hints | Budget Planner |
| `lib/runtime_policy_rollout.py` | rollout / promotion decision interface | Feedback Interface → Adapter Support |
| `lib/replay_summary.py` / `lib/replay_validation.py` / `lib/learning_log.py` | router 反馈与校准证据 | Feedback Interface |

---

## 7. Recommendation Contract

P2.5 建议统一成一个 internal-first recommendation object：

```json
{
  "schema_version": "octoclaw.auto_router.recommendation/v1",
  "route": "spawn_single",
  "work_contract": "deliverable_work",
  "confidence": 0.82,
  "reason_codes": ["deliverable_work_contract", "semantic_review_needed"],
  "model_recommendation": {
    "target_model": "zai/glm-5",
    "fallback_model": "zai/glm-4.7",
    "model_band": "strong"
  },
  "budget_recommendation": {
    "output_budget": "medium",
    "retry_budget": 1,
    "latency_target": "background",
    "cost_ceiling": "medium"
  },
  "review_required": true,
  "evidence_source": {
    "signal_schema_version": "octoclaw.auto_router.signal/v1",
    "feedback_trace": []
  },
  "policy_phase": "guided",
  "operator_notes": []
}
```

### 约束
- `route` / `work_contract` 来自 Router Core
- model / budget recommendation 来自 Model-Intel + Budget Planner
- `policy_phase` / `operator_notes` 可由 Adapter 层补充

---

## 8. Internal-first vs future standalone boundary

### 当前阶段：internal-first
- 先作为 OctoClaw 内部 recommendation core
- 接 current runtime hooks / dispatch / prompts
- 不单独服务化

### 未来阶段：extractable
满足以下条件后再谈拆分：
- signal schema 稳定
- recommendation contract 稳定
- model-intel update 面稳定
- route-budget integration 测试齐全
- replay-driven eval 能持续校准 recommendation

---

## 9. Feedback loop 如何喂给 router

feedback loop 不属于 router core，但必须成为它的校准面。

### 建议的输入方式
- replay summary → 进入 signal layer 的反馈信号
- validation summary → 进入 promotion / model / route calibration
- learning flags → 进入 risk / provider / route guardrail 调整

### 原则
- feedback loop 喂给 router 的是 **证据** 和 **校准信号**
- 不是把 replay 脚本直接塞进 router core 里

---

## 10. 风险与延后项

### 当前风险
1. route / policy / budget 的边界仍容易混层
2. model-intel 当前仍偏 OctoClaw 内部实现，不是纯数据平面
3. feedback evidence 还没形成 router 专用的校准接口

### 明确延后
- 独立服务化
- provider-gateway 化
- 完整 OpenAI-compatible API
- tiny judge 真正实现
- 对外开源仓拆分

---

## 11. 完成定义

P2.5 设计阶段完成时应满足：

1. 有独立的 auto-router design doc
2. 有明确的 5 层结构
3. 有 recommendation contract
4. 有 current code → target layer 映射
5. internal-first 与 future extractable 分界明确
6. feedback loop 与 router 的关系被定义清楚
