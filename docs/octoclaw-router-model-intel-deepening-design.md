# OctoClaw Router / Model-Intel 深化设计稿

> 状态：focused design（2026-04-08）  
> 用途：定义 `P2.5 internal-first baseline` 之后，Router / Model-Intel 如何继续做深，而不把 OctoClaw 重新拉回“大重构”状态。  
> 关联文档：[`octoclaw-auto-router-design.md`](./octoclaw-auto-router-design.md)、[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)、[`octoclaw-design-foundation.md`](./octoclaw-design-foundation.md)

---

## 1. 这份设计要解决什么问题

截至 `2026-04-08`，OctoClaw 已经具备：

- internal-first `auto_router` recommendation seam
- `signal / route / budget / model-intel` 的基础 schema
- `build_decision().auto_router`
- feedback / replay / validation baseline
- `P4 / P5 / P6` baseline 与 transition cleanup baseline

所以后续要解决的问题已经不是：

- 要不要做 router
- 要不要做 model-intel
- 要不要把整个系统变成“一个黑盒 Auto 模式”

而是：

1. **如何把 model-intel 从“当前内部实现”推进成更可信的数据平面**
2. **如何把 router recommendation 从“能输出”推进成“能回归、能评估、能持续收敛”**
3. **如何在不重做整个 runtime 的前提下，把这条线做成未来可抽离的开源子系统**

---

## 2. 外部参考的正确吸收方式

### 2.1 `models.dev` 值得借鉴什么

[`models.dev`](https://models.dev) 的价值不在于“它也有模型列表”，而在于它把模型事实层做成了：

- provider/model 分层的**结构化 registry**
- schema-first 的数据定义
- source-attributed 的事实来源
- 生成式产物（`api.json`），而不是把抓取逻辑散落在运行时热路径里
- 明确的模型字段：
  - pricing
  - limits
  - modalities
  - tool/reasoning/structured-output capability
  - release / freshness / status

对 OctoClaw 的启发是：

> **model-intel 应该越来越像“事实数据平面”，而不是 policy 里顺手拼出来的隐含数据结构。**

### 2.2 OmniRoute 值得借鉴什么

OmniRoute 里真正值得借的不是它的整套 gateway/runtime，而是这几条工程模式：

- **外部情报同步是 opt-in、non-blocking、stale-tolerant**
- 明确的优先级覆盖链
  - 用户 override
  - 外部同步
  - 次级同步源
  - 本地默认值
- catalog / pricing / capability 与 route policy 明确分层
- 统一 catalog builder，避免多个 surface 各自再算一套事实

对 OctoClaw 的启发是：

> **Router 不应该直接读取“各处散着的价格/能力/健康逻辑”，而应该消费一层有版本、有来源、有优先级的 model-intel 读模型。**

### 2.3 不该直接照搬什么

这两类外部参考都有价值，但以下东西不适合直接搬进 OctoClaw：

- OmniRoute 的 combo/provider proxy 主心智
- 大而全的统一 gateway/runtime 产品形态
- 为 catalog/dashboard 而设计的全量字段与 UI 复杂度
- 让 router 直接依赖 provider-specific fetch logic

OctoClaw 的正确方向仍然是：

- **保留 runtime / observer / feedback / IM surface**
- **把 router / model-intel 做成内部可抽离子系统**

---

## 3. 总体设计

深化后的结构建议固定成 4 个面：

```text
Model-Intel Facts Plane
  -> Router Recommendation Plane
       -> Adapter / Runtime Consumption Plane
            -> Feedback Calibration Plane
```

其中：

- **Facts Plane** 提供“拿什么事实来选”
- **Recommendation Plane** 提供“这次怎么选”
- **Adapter Plane** 提供“这次怎么在当前 runtime 里落地”
- **Calibration Plane** 提供“选得对不对，后面怎么调”

---

## 4. Model-Intel Facts Plane

### 4.1 目标

把 `pricing / capability / limit / freshness / health / quota / cooldown` 收成一个统一事实层。

### 4.2 数据来源分层

建议明确成这 5 类来源：

1. **operator override**
   - 本地显式覆盖
   - 优先级最高
2. **curated local catalog**
   - OctoClaw 自己维护的补充映射、alias、策略标签
3. **external model registry**
   - `models.dev` 这类结构化模型事实源
4. **provider/runtime observations**
   - health / latency / quota / cooldown / auth availability
5. **built-in defaults**
   - 本地保底值

### 4.3 建议的优先级

不是所有字段都同一优先级，而是按字段分开：

- `identity / alias / family`
  - operator override
  - curated local
  - external registry
- `capabilities / limits / modalities / structured_output`
  - operator override
  - external registry
  - curated local
  - defaults
- `pricing`
  - operator override
  - external registry
  - secondary sync source
  - defaults
- `health / cooldown / quota`
  - runtime observation
  - operator override
  - defaults

### 4.4 产物

建议产出 3 个稳定读模型：

1. `model-intel-catalog/v1`
2. `model-intel-health/v1`
3. `model-intel-source-status/v1`

它们的目标不是对外服务化，而是：

- 给 router core 用
- 给 replay/eval 用
- 给 operator surfaces 用

### 4.5 实现原则

- **热路径优先 Node.js / JS**
- 外部同步尽量走单独的 JS sync 模块
- Python 继续承担：
  - offline analysis
  - replay/eval/calibration
  - compatibility glue

---

## 5. Router Recommendation Plane

### 5.1 目标

把当前 `auto_router` 从“能给 recommendation”推进到“可回归、可评估、可校准”。

### 5.2 深化重点

#### A. route-budget 一体化

要验证的不是单个 route 是否合理，而是：

- route
- target model
- fallback model
- output budget
- retry budget

这些组合起来是否合理。

#### B. recommendation contract 稳定性

需要有回归测试保证：

- route recommendation schema 不漂
- budget recommendation schema 不漂
- `reason_codes / confidence / evidence_source` 语义不漂

#### C. lane consumption 一致性

`runner / spawn_single / spawn_multi / direct(control)` 不应各自再解释一遍 recommendation。

需要明确：

- 哪些 recommendation 字段是 lane-agnostic
- 哪些是 lane-local hints
- 哪些只属于 adapter 层

#### D. fallback / upgrade ladder

要正式写清：

- 什么情况下升到更强模型
- 什么情况下退到更省模型
- 什么情况下从 direct 变 runner
- 什么情况下从 runner 变 spawn

---

## 6. Feedback Calibration Plane

### 6.1 目标

让 replay / eval / validation 真正喂回 router / model-intel，而不是只形成 operator 报告。

### 6.2 建议的深化项

1. **replay-driven router eval**
   - 对历史请求重放 recommendation
   - 比较实际结果与建议结果
2. **route-budget integration tests**
   - 防止 route 和 budget 分裂
3. **recommendation regression tests**
   - 防止 schema / resolution drift
4. **model-intel update compatibility tests**
   - 防止外部源格式变化导致 router 误选
5. **calibration evidence format**
   - 对每个 curated case 统一记录：
     - route drift class
     - budget drift class
     - overall drift class
     - budget cap / latency target / worker budget
6. **tuning inputs**
   - replay/eval 不只产 operator summary
   - 还要产后续调：
     - route ladder
     - budget threshold
     - source weighting
     的输入视图

### 6.3 原则

- calibration plane 提供的是 **证据**
- router core 仍然不直接包含 replay 逻辑
- 旧 replay 缺 recommendation 字段时，应归为 `unknown / missing_recommendation`
  - 不应被误判成 hard drift

---

## 7. Adapter / Runtime Consumption Plane

### 7.1 目标

把 recommendation 稳定地落到当前 runtime，而不让 runtime 把 router 重新耦回去。

### 7.2 需要继续明确的消费面

- `octoclaw_policy.build_decision()`
- delegated lanes 的 execution contract
- `runner` 对 `output_budget / model_band / profile` 的消费
- `spawn_*` 对 `worker_pool / profile / candidate_models` 的消费

### 7.3 原则

- adapter 可以了解当前 runtime
- recommendation plane 不应依赖 IM / patrol / notifier / substrate display 细节

---

## 8. 分阶段工作包

### RM1：Model-Intel 数据平面硬化

交付物：

- source-attributed model-intel schema
- `models.dev`-style registry adapter
- source precedence / freshness contract
- source-status snapshot
- paid-only `OpenRouter rankings` ecosystem signal + local-truth precedence clamp

### RM2：Router Recommendation 硬化

交付物：

- route-budget integration tests
- recommendation contract regression tests
- lane consumption contract
- upgrade / fallback ladder 文档化
- replay/review curated cases 携带 route-budget consistency 证据

### RM3：Replay / Eval 校准接入

交付物：

- replay-driven router eval
- calibration evidence format
- model-intel update compatibility tests
- recommendation drift diagnostics
- tuning inputs for threshold / weight adjustment
- validation summary / feedback manifest / rollout recommendation 对 route outcome metrics 的联通
- baseline 先落在：
  - `router_eval` 读 replay/curate cases 输出 route/budget drift 摘要
  - source adapter compatibility tests 覆盖 parser / last-good fallback / schema drift
  - validation summary 输出 `route correctness / budget correctness / delivery correctness / coverage`
  - rollout recommendation 在 promotion gate 中显式识别 `route outcome` coverage

### RM4：Extractable readiness baseline

交付物：

- internal interfaces 再收口
- minimal package boundary map
- public surface shortlist
- machine-readable boundary manifest
- package layout baseline
- unified public surface shell
- 明确“什么时候可以讨论拆独立 router package”

---

## 9. 完成标准

这条深化线完成时，至少应满足：

1. model-intel 已不再只是零散 helper，而是有明确来源/优先级/读模型
2. router recommendation 有 route-budget 联合测试
3. replay/eval 能对 recommendation 做回放与校准
4. runtime lanes 对 recommendation 的消费语义清楚
5. future extractable boundary 比今天更真实，而不是只停留在概念图上

---

## 10. 当前不做什么

这一轮明确不做：

- 不重开新的大 runtime 重构
- 不把 OctoClaw 立刻拆成独立 router 服务
- 不先做全量 TS 重写
- 不先做新的 cockpit / dashboard
- 不为了追求“像 OpenRouter Auto”而把 runtime / observer / feedback 价值抹掉

一句话：

> **后续的 router / model-intel 深化，应该把 OctoClaw 变得更准、更稳、更可维护，而不是把它重新变复杂。**
