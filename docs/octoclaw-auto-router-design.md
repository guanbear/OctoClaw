# OctoClaw Auto Router 设计草案

> 状态：P2.5 配套设计底稿（2026-04-04）  
> 用途：把 OctoClaw 内部的路由子系统收成独立设计面，供 P2 / P2.5 / P4 实现时统一边界。  
> 关联文档：[`octoclaw-design-foundation.md`](./octoclaw-design-foundation.md)、[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)、[`octoclaw-auto-router-implementation-checklist.md`](./octoclaw-auto-router-implementation-checklist.md)

---

## 1. 这份文档要解决什么问题

现在的 OctoClaw 已经不只是“挑模型的几段脚本”了，而是在逐渐形成：

- signal extraction
- route / model / budget decision
- provider policy / fallback / cooldown
- replay / validation / learning feedback
- model-intel refresh

如果不单独把这一块收口，会出现两种常见漂移：

1. 把整套 OctoClaw 错看成一个黑盒 router
2. 把本来可以积累成 Auto Router 的核心，永远绑死在当前 runtime 细节里

所以这份文档的目标不是讨论“OctoClaw 是否要做路由”，而是更具体地回答：

> **OctoClaw 应该怎样把 Auto Router 做成一个可抽离、可演进、又不脱离当前 runtime 现实的子系统。**

---

## 2. 一句话定义

> **OctoClaw Auto Router 是一个放在 runtime policy 面之前的推荐与约束子系统，用来联合决定 `execution contract -> agent scope -> model candidate -> output budget -> fallback policy`。**

这里特意写成“推荐与约束子系统”，而不是“一个万能代理层”，因为它在 OctoClaw 里的正确边界应当是：

- **负责**
  - 信号抽取
  - 路由判断
  - budget 选择
  - policy 适配
  - outcome 反馈回流
- **不负责**
  - 取代 OpenClaw runtime substrate
  - 取代 observer / patrol / TaskFlow orchestration
  - 取代 IM / display / task action surface

这里的一个关键补充是：

- `execution contract` 不是附属字段，而是路由结果的一部分
- 对 OctoClaw 而言，这个 contract 当前仍然主要是：
  - `direct`
  - `runner`
  - `spawn_single`
  - `spawn_multi`

## 2.1 当前代码基线（2026-04-05 校验）

这次设计不是只基于本地 checkout 写的，而是同时对了 GitHub 最新代码。

- 本地 `openclaw-octopus` 当前在 `7faae36`
- GitHub `codex/release-v0.1.0` 最新是 `a82361d`
- 本地工作树已经有未提交文档修改，所以这次没有直接在本地仓库上强拉最新代码，而是用独立 clone 对最新实现做校验

对 P2.5 最重要的现实是：

- Auto Router **不是从 0 开始造**
- 当前代码里已经有：
  - `runtime-policy decision` schema
  - JS 热路径上的 policy mirror
  - Python 侧 model/policy resolver
  - feedback manifest / validation summary
  - runtime snapshot / runner health / queue truth
  - rollout / promotion gate

也就是说，P2.5 真正要做的是：

> **把现有路由与反馈能力收成可抽离的 recommendation kernel，而不是再平地起一个“第三套路由器”。**

---

## 3. 外部参考应该怎么吸收

### 3.1 ClawXRouter：适合借“自动路由接线方式”，不适合整块照搬

ClawXRouter 最有价值的，不是它已经有一套完美 router，而是它证明了三件事：

1. **自动路由应该挂在 runtime hook 上**
   - 它在 `before_model_resolve` 里直接改 `provider/model`
   - 这比让主 agent 用 prompt “自己决定要不要换模型”更稳定

2. **v1 自动路由可以先从可解释版本做起**
   - 它的 `token-saver` 本质是 `LLM-as-judge -> tier -> static model map`
   - 这非常适合作为 OctoClaw 的第一拍，而不是一上来就做在线学习

3. **router pipeline 应该支持 checkpoint、权重和短路**
   - 快规则先跑
   - 明显命中的情况直接短路
   - 只把模糊样本送进更贵的 judge / classifier

但它也有明显不适合直接照搬的点：

- 当前主要还是静态 tier 映射，不是 feedback-driven auto router
- 隐私分层、proxy、双轨 memory 很强，但会把 OctoClaw 的当前目标拉偏
- 它深度绑定 OpenClaw 插件运行面，不适合作为 OctoClaw 内部 canonical 边界

对 OctoClaw 来说，正确吸收方式是：

- **借**
  - runtime hook 接线方式
  - router pipeline 结构
  - cheap judge + deterministic rule 的混合模式
- **不借**
  - 把静态 tier map 当成最终形态
  - 把隐私 proxy / memory isolation 当成 Auto Router 的中心职责

### 3.2 NVIDIA LLM Router v2：更像 recommendation substrate，而不是完整运行面

NVIDIA LLM Router v2 给 OctoClaw 的启发非常直接：

- 它把 router 做成一个**返回推荐模型名**的服务，而不是替代上层执行系统
- 它同时展示了两种不同路线：
  - **intent-based router**
    - 用小模型先识别任务/意图，再映射到候选模型
  - **auto-routing**
    - 用 embedding + 训练过的 neural router 直接预测最优模型
- 它把这两种路线都包在 OpenAI-compatible 的 response surface 后面

这对 OctoClaw 的意义有三层：

1. **router core 和 runtime 可以明确解耦**
   - router 返回 recommendation
   - policy / gateway adapter 决定最终落到哪个 provider/model

2. **v1 和 v2 可以共存**
   - v1 用 intent / complexity route
   - v2 用 learned router
   - 两者不需要用同一个实现去覆盖全部阶段

3. **OpenAI-compatible recommendation surface 是值得保留的目标**
   - 不一定现在就做外部 API
   - 但内部接口应该朝这个方向收

OctoClaw 不需要照搬 NVIDIA 的具体模型、embedding 方案或训练工艺，但很值得吸收它的这条结构性判断：

> **Auto Router 的理想形态，更像一个可独立提供 recommendation 的子系统，而不是一个把整套 orchestration 都吞掉的大代理。**

### 3.3 R2-Router：预算不该只是附加字段，而应是核心决策变量

R2-Router 最关键的地方在于，它不是“先选模型，再顺手给个 max tokens”，而是把问题写成：

> **联合选择 `(LLM, output_budget)`，并让预算直接进入质量/成本目标函数。**

这条判断对 OctoClaw 非常重要，因为当前很多路由误差都不是“模型完全选错”，而是：

- 明明该让强模型简答，却给了弱模型长答
- 明明是低风险任务，却给了高成本长输出
- 明明需要 reasoning，但预算设置太紧，导致质量看起来像模型错选

所以对 OctoClaw 来说，R2 的真正借鉴不是某个具体算法，而是：

- `budget` 必须 first-class
- replay / validation 里要记录预算和实际产出长度
- route 优劣不能只看模型名，还要看 `(model, budget, response_style)` 的组合

### 3.4 RouteLLM：更适合借“离线评估 / 阈值校准 / learned router 接口”

RouteLLM 对 OctoClaw 最有用的不是它的二选一路由本身，而是它把 learned router 这件事拆得很清楚：

- router 输出一个可校准分数
- 阈值决定 strong/weak 切换
- evaluation / benchmark / threshold calibration 是一等能力

它不够覆盖 OctoClaw 的地方也很明显：

- 更偏 `strong vs weak` 二元选择
- 不直接覆盖 `execution contract / worker_pool / handoff contract`
- 对 `runner / subagent / main-agent` lane 差异没有原生表达

所以对 OctoClaw 来说，更正确的吸收方式是：

- **借**
  - learned router 的接口形式
  - threshold calibration
  - offline evaluation harness
- **不借**
  - 把 OctoClaw 路由收缩成单纯 strong/weak 二元分类

### 3.5 LiteLLM Router：更适合借“工程化控制面”，不适合借语义真相源

LiteLLM Router 给 OctoClaw 最有价值的是工程基础设施：

- budget limiting
- cooldown cache
- deployment filtering
- retry / fallback / health-aware routing
- 可插拔 routing strategy

但它不适合作为 OctoClaw 的 canonical route brain，因为：

- 它更像 provider/deployment router
- 关注点主要是调用层稳定性，而不是 `execution contract + lane-local policy`

所以它最值得借的地方是：

- policy adapter 的工程化写法
- 独立 router/service 的产品形态
- 预算、健康、fallback 的运行时治理手法

### 3.6 NadirClaw：更适合借“独立产品化”与 proxy ergonomics

NadirClaw 对 OctoClaw 最有价值的不是语义分类本身，而是它把“本地代理式 Auto Router”做成了一个完整产品：

- session pinning
- fallback chains
- dashboard / metrics / budgets
- OpenAI-compatible proxy surface

这对 P2.5 的意义是：

- 如果后续真的要把 Auto Router 单独插件化、再进一步服务化，NadirClaw 是很好的产品形态参考
- 但在 OctoClaw 当前阶段，它更适合作为 **独立化第二阶段** 的参考，而不是当前 route brain 的起点

---

## 4. OctoClaw Auto Router 的推荐边界

### 4.1 五层结构

1. **Signal layer**
   - task_type
   - complexity
   - reasoning_need
   - tool_need
   - context_size
   - latency_sensitivity
   - cost_sensitivity
   - language
   - workspace/risk hints

2. **Router core（V1/V2-style）**
   - deterministic rules
   - intent / semantic route
   - optional tiny judge
   - optional learned recommender
   - 输出 route class 与 candidate set

3. **Budget planner（R2-style）**
   - 联合选择 `(model, output_budget)`
   - 决定 verbosity / reasoning allowance / max output budget
   - 允许“强模型短答”与“弱模型长答”进入同一目标函数

4. **Policy / gateway adapter**
   - provider allowlist
   - health / cooldown
   - runner / queue / executor health
   - quota / plan pressure
   - privacy / deployment policy
   - fallback chain
   - 实际 provider/model 落点决策

5. **Model-intel / feedback loop**
   - price
   - capability profile
   - health / cooldown
   - quota pressure / plan state
   - source adapters / freshness / decay
   - `openrouter_catalog` 目录与价格主源
   - `openrouter_rankings` 低权重生态信号
   - route outcome
   - replay / validation / promotion inputs

### 4.1.1 `runner` 不是遗漏项，而是 execution lane

这份设计如果只写“选哪个模型”，就会和 OctoClaw 当前真实架构脱节，因为 OctoClaw 不是只有主 agent / 子 agent 二元选择。

当前更准确的理解是：

- `direct`
  - 主 agent 直接完成
- `runner`
  - 交给轻任务执行 lane
  - 可以是常驻 runner，也可以是 on-demand runner
- `spawn_single`
  - 交给单个子 agent / worker
- `spawn_multi`
  - 交给多 worker / 父子 TaskFlow

所以 OctoClaw Auto Router 的第一步不应只是“选模型”，而应先回答：

> **这次请求应该落在哪个 execution contract 上。**

然后才是该 lane 内部的模型与预算决策：

- `direct`
  - 是否保持主 agent 稳定脑
  - 是否允许 direct override
- `runner`
  - 选择 runner 的 `model_band / profile / output_budget`
  - 决定 daemon / on-demand 下的执行预算
- `spawn_single`
  - 选择子 agent 的 profile / model / budget
- `spawn_multi`
  - 选择 parent planner / worker / review 三类 step 的 lane-local 策略

也就是说，Auto Router 对 OctoClaw 更准确的描述应该是：

- 先做 `execution contract routing`
- 再做 `lane-local model/budget routing`

### 4.1.2 OctoClaw 的 route output 不能缩成“只剩模型”

这是我上一版写得偏窄的地方。

结合当前 OctoClaw 的 decision contract，Auto Router 的输出至少还应覆盖：

- `worker_pool`
- `work_type`
- `phase`
- `protocol`
- `profile`
- `skill_bundle`

原因很直接：

- OctoClaw 不是只靠模型名驱动行为
- 很多运行面差异其实由 `worker_pool / phase / protocol / profile` 决定
- `skill bundle` 也不是纯 prompt 装饰，而是 delegated lane 的能力边界之一

所以更准确的理解应该是：

> **Auto Router 输出的是一份 lane-aware execution recommendation，而不只是一个 model recommendation。**

### 4.1.3 Review / Handoff / Delivery contract 也是 route truth

对 OctoClaw 来说，route 还天然带着一组交付约束：

- 是否 `artifact_first`
- 是否需要 `review_gate`
- 是否允许 `direct_reply`
- 是否需要 `final_compose`
- handoff 是 `direct_answer / runner_report / deliverable_handoff / team_evidence_handoff`

这点和一般“只负责选模型”的 router 很不一样。

因此在 OctoClaw 语境里，Auto Router 应把下面这些都看成一份统一 route contract 的组成部分：

- execution contract
- model / budget decision
- review policy
- prompt / handoff / delivery contract

如果缺了这层，后面很容易出现：

- 模型选得没问题，但交付形态不对
- runner 结果应该 artifact-first，却被当成主会话直答
- spawn_multi 明明需要 evidence compose，却被压成单 worker reply

### 4.1.4 `control_observer` 不应被当成普通业务 direct

这是之前还没写进这份文档、但结合最新代码必须补上的 OctoClaw-specific 边界。

OctoClaw 当前已经存在一类明确不同于普通业务请求的任务：

- `status`
- `details`
- timeline / runtime snapshot
- retrieve / observer surface query

这些请求在策略上更接近 `control_observer`，而不是普通的“主 agent 直接干活”。

这里还应明确包括一类经常被误分到 delegated lane 的元问题：

- 当前主会话在用什么模型
- 这次是否走了 `dispatch`
- 刚才是不是子任务做的
- 当前 route / policy / provenance 是什么

它们虽然不是传统的 `status/details` 命令，但本质上仍是 workflow/session metadata query。
默认应归到 `control_observer`，避免误落到 `deliverable_work -> spawn_single`。

因此 Auto Router 默认应把它们视为：

- `direct`
- `main-agent stable scope`
- 短预算 / 总结型输出优先
- 不触发 delegated lane 自动优化

更重要的是：

> **这类样本不应和普通业务 `direct` 混在一起训练 learned router。**

### 4.2 正确的数据流

```text
request/task
  -> signal extraction
  -> execution contract routing
  -> router core
  -> budget planner
  -> policy/gateway adapter
  -> final provider/model/budget decision
  -> execution
  -> replay/validation/outcome capture
  -> route learning / policy update
```

### 4.3 关键边界判断

- `router core` 不直接感知具体 gateway 细节
- `policy adapter` 不重复做语义分类
- `budget planner` 不应该退化成“只是补一个 max_tokens”
- `feedback loop` 不只是做报表，而要反哺 route / budget 决策

### 4.4 主 agent 与子 agent 的默认作用域

这也是 OctoClaw 和 ClawXRouter 一个非常关键的不同点。

ClawXRouter 的默认心智更接近：

- 直接在主会话的 `before_model_resolve` 上改当前 agent 的 provider/model

但 OctoClaw 当前更合理、也更符合现有实现默认值的心智是：

> **主 agent 默认保持稳定的编排/决策脑，Auto Router 默认优先作用于 `runner` 和 `spawn_*` 这些 delegated lanes。**

这条边界当前已经和实现对齐：

- `runtime_policy.switches.direct_model_override` 默认是 `false`
- `before_model_resolve` 即使存在，也只在 `direct` route 且显式开启 override 时才该生效
- `runner` / `spawn_single` / `spawn_multi` 则天然更适合接 lane-local 的 model/profile/budget 决策

### 4.4.1 模型测速类请求应先落 workflow，不要默认上 agent

另一类近期暴露出的高频误判，是“比较两个模型的首 token / 吞吐 / 响应速度”。

这类请求如果直接落到 `spawn_single`，通常会有三个问题：

- 本来只需要读本地 telemetry / health snapshot，却先付出 agent dispatch 成本
- 结果不稳定，容易受 delegated lane 自身波动影响
- 和 `workflow-first, agent-second` 的总原则冲突

因此更合理的默认 contract 是：

- `runner`
- `inspect_report`
- 本地 telemetry / model-health snapshot workflow

也就是说：

> **模型测速/比速问题默认应先当成 workflow inspect，而不是 generic delegated task。**

### 4.4.2 fallback 事实应回灌 model-health，但不应偷偷切主模型

OpenClaw 主会话在运行中产生的 `timeout / auth / failover`，如果只停留在 gateway log，
后续 route/model selection 就无法及时感知这些坏事实。

因此需要一条轻量反馈线：

- 从 fallback log 回灌 `model-health`
- 让 timeout / auth / failover 进入 degraded / cooldown 判断
- 采用 stale-gated refresh，避免每轮都重扫日志

但这条线不等于放开主会话自动改模：

- `direct_model_override` 默认仍保持 `false`
- health feedback 先服务于 health-aware selection / visibility
- 是否 override main-agent 仍是后续独立 rollout 决策

因此这份设计里的 `agent scope` 应明确分成：

1. **main-agent stable scope**
   - 默认不改
   - 主 agent 主要负责理解、编排、委派、收口
   - 只在特殊配置或显式实验模式下允许 direct override

2. **delegated lane scope**
   - `runner`
   - `spawn_single`
   - `spawn_multi`
   - 这是 Auto Router 默认应优先优化的对象

3. **explicit override scope**
   - 用户或策略显式要求时，才允许改主 agent
   - 例如高成本直答会话、特定 workspace、某类强 reasoning 任务

这点对后续实现很重要，因为它决定了：

- 不能把 ClawXRouter 的“默认改主 agent”心智直接搬进 OctoClaw
- OctoClaw 的 route truth 里必须记录 `agent_scope`
- main / runner / subagent 三类结果不能混在一起评估

### 4.5 Session continuity、route stickiness 与 channel/surface awareness

这也是 OctoClaw 特有、但上一版没收进去的边界。

Auto Router 不应把每一轮都当成完全独立的 stateless query，因为 OctoClaw 当前已经有：

- route stickiness
- ack-followup lane continuation
- channel / session / thread truth
- language pack 选择

这意味着 Auto Router 至少要感知三类 continuity signal：

1. **session continuity**
   - follow-up 是否应沿用上一个 delegated lane
   - 是否因为 sticky lane 而抑制重复 route_hint

2. **surface/channel context**
   - 当前是在 CLI、IM、群聊、私聊还是其他 surface
   - 这会影响 output budget、summary style、artifact strategy

3. **language context**
   - route language pack 不只是展示层问题
   - 它也会影响 prompt budget 和 handoff 形态

所以这里应补一条原则：

> **OctoClaw Auto Router 默认是 session-aware、surface-aware、channel-aware 的，不是纯 query-only router。**

### 4.6 rollout / shadow mode 也是一等设计约束

P2.5 不能按“写完就直接切主路径”的方式推进，因为 OctoClaw 最新代码已经有：

- feedback manifest
- validation summary
- runtime policy rollout gate

这意味着 Auto Router 的正确上线方式应当是：

1. **shadow / recommend-only**
   - 先给 recommendation
   - 不立刻接管最终落点
2. **diff logging**
   - 记录 `old decision vs new recommendation`
   - 看成本、延迟、validation、user correction 差异
3. **gated promotion**
   - 只有验证通过，才允许扩大生效范围

也就是说：

> **P2.5 首先是 recommendation system rollout，不是一次性替换当前 runtime policy。**

---

## 5. 推荐的第一版实现形态

### 5.0 这件事能不能做

可以，而且当前代码已经具备了比较完整的前置基线。

真正已经存在的东西包括：

- `execution contract` 路由
- `worker_pool / phase / protocol / profile` 决策
- model health / quota penalty / cooldown
- runner health / queue snapshot
- replay / validation / promotion gate
- OpenClaw runtime hook 接线

所以 P2.5 的关键缺口不是“缺一个神经网络”，而是：

- 缺一份独立的 recommendation schema
- 缺 JS / Python 共享的 router contract 与测试夹具
- 缺 route outcome 的统一沉淀面
- 缺 shadow rollout 和 diff 评估闭环

这也是为什么我现在更倾向于把 P2.5 定义成：

> **extract + formalize + instrument，而不是 rewrite。**

### 5.1 V1：先做可解释的 automatic router

V1 不追求“最聪明”，而追求：

- 稳
- 可解释
- 可回放
- 容易校准

推荐形态：

1. **rule-first**
   - 明显的路由模式先由规则命中
   - 例如：极短问答、长上下文摘要、代码修改、研究型问答、强 reasoning 任务

2. **cheap judge for ambiguous cases**
   - 模糊样本再走小模型 judge
   - 可以是本地小模型，也可以是便宜云模型
   - 重点不是“必须本地”，而是“足够便宜且稳定”

3. **route class 而不是直接写死模型**
   - 先输出 `fast_chat / coding / research / reasoning / long_context` 一类 route class
   - 再由 policy adapter 映射到当时健康、允许、便宜的具体模型

4. **budget 作为同步输出**
   - 每次 route 同时给出 `output_budget`
   - 例如：`short / medium / long / deep`

5. **默认只优化 delegated lanes**
   - `runner` / `spawn_single` / `spawn_multi` 优先接 Auto Router
   - `direct` 默认保持主 agent 稳定，不自动改主模型
   - 只有显式打开 `direct_model_override` 或特定策略命中时，才进入 main-agent override

这一步很像 ClawXRouter 的升级版，但有两个关键差异：

- 不把 tier 直接等同于最终模型
- 从第一天就把 `budget` 纳入 route 输出
- 不把“默认改主 agent”当成前提
- 不把 route contract 缩成“只剩 model recommendation”

### 5.2 V1.5：把 recommendation surface 稳定下来

在 V1 足够可用后，第二步不是急着上复杂学习，而是先把内部接口收干净：

- `recommend(request) -> route_decision`
- `resolve(route_decision, policy_state) -> final_target`
- `record_outcome(route_decision, execution_result) -> replay_event`

推荐的 route decision 最小 schema：

```json
{
  "execution_contract": "spawn_single",
  "agent_scope": "delegated",
  "route_class": "coding",
  "worker_pool": "octoclaw-code",
  "phase": "implement",
  "protocol": "normal",
  "profile": "code",
  "skill_bundle": ["repo", "test", "review"],
  "candidate_models": ["provider_a/model_x", "provider_b/model_y"],
  "recommended_model": "provider_a/model_x",
  "output_budget": "medium",
  "reasoning_mode": "normal",
  "review_required": false,
  "artifact_first": true,
  "handoff_contract": "deliverable_handoff",
  "reason_codes": ["task_type:coding", "tool_need:high"],
  "judge": {
    "kind": "rules+tiny-judge",
    "confidence": 0.74
  }
}
```

### 5.3 V2：再走 feedback-driven / learned router

V2 才值得开始吸收 NVIDIA auto-routing 与 learned router 的那一侧能力。

推荐方向：

- 用 replay / validation 数据做训练样本
- 学习目标不是“哪个模型最好”，而是“在当前 policy 下哪个 `(model, budget)` 组合最优”
- 允许 learned recommender 输出 candidate set 与 confidence
- 低 confidence 时回退到 V1 的 rule/judge 路线
- 同时保留 route contract 的其他维度
  - worker_pool / protocol / review / handoff / surface

这里最重要的不是某个具体算法，而是训练数据闭环：

- 输入：query/task signals
- 中间：route decision / budget decision / actual target / execution contract / surface context
- 结果：cost / latency / retries / validation score / user correction / promotion outcome / handoff quality

### 5.4 推荐的 P2.5 实施切片

如果按当前最新代码现实来做，我建议把 P2.5 拆成 4 个切片，而不是一口气做“自动选模系统”。

#### P2.5-A：先把 recommendation contract 独立出来

这一拍不改主脑，只做抽离：

- 从当前 `buildDecision(...)` 里抽出 `recommendExecution(...)`
- 明确区分：
  - `recommendation`
  - `resolution`
  - `execution result`
- 产出独立 schema：
  - `route recommendation`
  - `budget recommendation`
  - `route outcome`

这一拍的目标是让当前 Python / JS 两侧都能消费同一份 contract。

#### P2.5-B：把 runtime hot path 收成 lane-aware router kernel

这一拍开始接真实 runtime，但仍以 rule-first 为主：

- 先做 `execution contract routing`
- 再做 `lane-local route class / profile / budget`
- 先收 protected direct lanes：
  - `control_observer`
  - workflow/session metadata query
  - task action / queue / details / status
- 先建立误判 goldens 与 Python / JS / runtime parity
- 默认只优化：
  - `runner`
  - `spawn_single`
  - `spawn_multi`
- `main-agent direct` 仍默认稳定
- `control_observer` 默认 bypass delegated optimization

#### P2.5-C：引入 cheap judge，但只处理模糊样本

这一拍才需要 tiny judge：

- 规则明确命中的 case 不走 judge
- protected lanes 不走 judge
- goldens 已覆盖的稳定边界不走 judge
- judge 输出：
  - `route_class`
  - `budget_hint`
  - `confidence`
- 不直接输出最终 provider 绑定

这样可以把语义推荐和运行时 provider 漂移拆开。

#### P2.5-D：把 outcome 回流到 feedback loop，再做 learned router

最后一拍才开始真正吸收 RouteLLM / NVIDIA / R2 那侧：

- replay / validation 里沉淀 route outcome
- 做 threshold / budget calibration
- 在低风险 lane 上先试 learned recommender
- 低 confidence 时回退到 rule/judge path

---

## 6. Tiny Judge、本地模型、规则三者怎么配

这是第一版里最容易写散的地方，建议明确成下面这条顺序：

0. **protected lanes 先收硬边界**
   - `control_observer`
   - workflow/session provenance
   - status/details/task-action
   - 这些 lane 默认 bypass delegated optimization，也不进普通业务训练面

1. **规则先跑**
   - 负责明显 case 的快速命中
   - 负责 hard guard / allowlist / cooldown 这种非语义约束
   - 负责把 request 先稳定归到少数 contract / lane

2. **tiny judge 只处理模糊样本**
   - 用于复杂度、reasoning need、研究型倾向之类难靠纯规则稳定判断的情况
   - 它输出的是 route class / budget hint，不是最终 provider 绑定

3. **policy adapter 最后落点**
   - 根据健康、价格、授权、区域、fallback 决定最终具体模型

4. **runtime capacity checks 再收口**
   - runner health
   - queue pressure
   - subagent / worker availability
   - quota / cooldown pressure

这样做的好处是：

- 规则保持可控
- judge 成本可控
- 误判先靠系统边界收敛，而不是把所有问题都推给语义模型
- provider 漂移不会污染前面的语义层
- executor 抖动和 quota 压力不会误伤语义层

关于本地模型，这里建议保持务实：

- **不强制本地 judge**
  - 如果本地小模型稳定、便宜、足够准，可以优先用
  - 如果便宜云模型更稳，也可以用云 judge
- **不要把“必须本地”写成架构前提**
  - 对 Auto Router 来说，关键是低成本与高一致性，不是部署位置本身

---

## 6.1 实现语言与插件化边界

### 6.1.1 运行时与离线层建议分语言

如果只看 OctoClaw 当前代码现实，我的建议非常明确：

- **runtime hot path：TypeScript / Node**
- **offline learning / eval / calibration：Python**

原因不是“语言偏好”，而是当前代码边界已经基本给出答案：

- OpenClaw plugin hook 面在 JS/TS
- 当前 runtime policy mirror 已经有 `extensions/octoclaw-runtime/policy/decide.js`
- `before_prompt_build / before_model_resolve` 这类热路径不适合再套一层 Python 子进程
- feedback / replay / validation / promotion 这一整套当前主要在 Python
- RouteLLM / R2 这类 learned / calibration 参考也天然更贴近 Python 生态

如果后续被迫只保留一种语言做“独立 Auto Router runtime”，我会选：

> **TypeScript**

因为它更贴近 OpenClaw 插件、未来 npm 包形态、以及真正要走的 request hot path。

### 6.1.2 推荐的插件化拆分

这里先明确一个容易误解的边界：

> **P2.5 的默认目标不是先做独立 router service，而是先把 Auto Router 收成可抽离的 OpenClaw plugin-first 内核。**

也就是说：

- 第一目标是 `OpenClaw plugin / extension` 内部可复用
- 第二目标才是“未来如果有必要，可额外长出 recommendation service”
- 当前不把“独立 HTTP 服务”当成前置里程碑

比较稳的拆法不是把整个 OctoClaw 搬出去，而是拆成三层：

1. **`router-core`（TypeScript，纯库）**
   - signal extraction
   - execution-contract routing
   - lane-local route / budget recommendation
   - policy adapter interface
   - JSON schema / fixtures

2. **`octoclaw-runtime adapter`（TypeScript，OpenClaw 插件层）**
   - hook 接线
   - session state / sticky lane
   - replay logging
   - route hint / handoff glue

3. **`router-learning`（Python，离线层）**
   - replay export
   - validation join
   - threshold calibration
   - learned router training / evaluation

如果插件形态跑稳、后面又真的有跨产品复用需求，再考虑加：

4. **`router-service`（可选，TypeScript 或 Python）**
  - OpenAI-compatible recommendation endpoint
  - 返回 recommendation，不直接代理实际模型调用

这样拆的好处是：

- 先服务 OctoClaw，不耽误当前路线
- 先贴合 OpenClaw plugin 现实，而不是为了“完全独立”提前抽象过头
- 后面真要单独插件化或开源，不需要推翻当前实现
- runtime 和 offline 学习不会被强行塞进同一个部署面

### 6.1.3 JS / Python 双实现的现实怎么处理

P2.5 还有一个很现实的问题：OctoClaw 现在已经同时有：

- JS runtime mirror
- Python model/policy resolution

所以不能再继续让两边各自长各自的语义。

建议的处理方式是：

- **schema 共享**
  - `recommendation`
  - `resolution`
  - `outcome`
- **fixture 共享**
  - 同一批样例同时喂给 JS / Python
- **热路径收 JS**
  - runtime 决策优先由 JS/TS 负责
- **学习与分析留 Python**
  - Python 负责生成新阈值、策略候选和验证结论

这会让 P2.5 从“继续双写逻辑”变成“共享 contract，不共享热路径实现”。

---

## 7. P2 / P2.5 / P4 具体会受什么影响

### 7.1 对 P2 的影响：不改主线，但应补 route outcome 字段

你现在做的 P2 不需要回退，但建议在 replay / validation 里补下面这些字段：

- `execution_contract`
- `agent_scope`
- `worker_pool`
- `phase`
- `protocol`
- `profile`
- `skill_bundle`
- `route_class`
- `recommended_model`
- `resolved_model`
- `output_budget`
- `review_required`
- `artifact_first`
- `handoff_contract`
- `reason_codes`
- `judge_kind`
- `judge_confidence`
- `route_source`
  - rule / judge / learned / manual override
- `sticky_applied`
- `ack_followup_applied`
- `channel`
- `route_language_packs`
- `fallback_taken`
- `runner_health_snapshot`
- `queue_pressure_band`
- `quota_pressure_band`
- `actual_cost`
- `actual_latency`
- `validation_outcome`

并且至少要把三类 outcome 分开看：

- main-agent direct
- runner lane
- subagent / team lane

这会直接决定后面 V2 有没有可用训练面。

### 7.2 对 P2.5 的影响：这是主施工位

P2.5 应该从“抽象讨论路由”收成下面几件明确交付：

- router boundary map
- route decision schema
- budget decision schema
- route outcome schema
- policy adapter contract
- model-intel refresh inputs
  - 包括 `OpenRouter catalog / rankings` source adapter 与 freshness/decay 语义
- replay/outcome schema 增量
- internal recommendation surface
- shadow rollout / diff logging contract
- JS runtime hot-path ownership
- Python offline calibration ownership

再具体一点，主施工顺序建议是：

1. 先抽 contract，不先换默认行为
2. 先 delegated lanes，再碰 main-agent direct
3. 先 rule/judge recommendation，再做 learned recommendation
4. 先 shadow / diff logging，再做 promotion

### 7.3 对 P4 的影响：要让 substrate 能看见 route truth

P4 不需要把 TaskFlow 变成 router，但要让 route truth 能跟着任务走：

- task / TaskFlow metadata 里可挂 route summary
- parent/child task 可以保留 route / budget lineage
- 取消、重试、fallback 时要能看见 route 级别的真相

这会让后面的 observer / timeline / review 更完整。

---

## 8. 当前不建议做的事

- 不建议一开始就上在线 bandit / RL
- 不建议把 learned router 当成 P2.5 前置条件
- 不建议把 provider 细节混进 signal layer
- 不建议把 Auto Router 直接写成另一个黑盒 runtime
- 不建议把脱敏 / proxy / memory isolation 作为当前主线

这些都可能以后要做，但不是当前这版设计的主轴。

---

## 9. 结论

当前最合理的路线不是“马上做一个神奇的全自动选模系统”，而是分三拍：

1. **先做 ClawXRouter 启发下的可解释 automatic router**
   - rule + tiny judge + route class + budget
2. **再做 NVIDIA-style recommendation surface**
   - router core 与 policy/gateway adapter 解耦
3. **最后做 R2-style `(model, budget)` 联合优化**
   - 由 replay / validation / promotion 数据驱动

如果这条线收得住，OctoClaw 内部就会形成一个边界清楚的 Auto Router 子系统：

- 今天先服务 OctoClaw
- 明天也可以独立抽成开源项目

---

## 10. 参考

- ClawXRouter 源码：`/tmp/ClawXRouter`
- NVIDIA LLM Router: <https://github.com/NVIDIA-AI-Blueprints/llm-router>
- R2-Router 论文：<https://arxiv.org/abs/2602.02823>
- R2-Router 参考实现：<https://huggingface.co/JiaqiXue/r2-router>
- RouteLLM：`/tmp/RouteLLM`
- LiteLLM Router 参考：`/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/litellm`
- NadirClaw：`/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/nadirclaw`
