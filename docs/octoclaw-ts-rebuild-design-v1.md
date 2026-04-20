# OctoClaw TS 重构设计 v1

日期：2026-04-15

状态：finalized v1

作者：Codex（基于现有文档、代码、提交历史、OpenClaw 上游现状与外部资料整理）

## 0. 这份正式版回答什么

这份文档回答 4 个问题：

1. OctoClaw 现在最核心的产品目标到底是什么。
2. 现有系统里哪些东西应该复用，哪些应该推翻。
3. 如果重构为 TypeScript，骨架应该怎么定，才能避免再次长成屎山。
4. Anthropic / 开源项目 / OpenClaw 上游里，哪些思想值得借，哪些不该硬搬。

本文是当前的**正式版 v1**，作为后续 TS 重构的设计基线使用。

它的立场很明确：

> OctoClaw 接下来不应该继续在旧架构上打补丁，而应该围绕“快首响、稳委派、稳交付、低成本”四个目标，做一次以 TypeScript 为主、以 harness 为核心、以 OpenClaw 原生 task/flow 为执行真相源的重构。

---

## 1. 执行摘要

### 1.1 核心判断

OctoClaw 的核心目的不是“做一个更大的 agent 框架”，也不是“做一个更聪明的多 agent 系统”。

它最核心的目标一直都很朴素：

1. 用户发来消息后，**主链路要先快速响应**。
2. 简单任务直接回，复杂任务**按需委派**。
3. 委派后整个过程要**稳定、可恢复、可观察、可回传**。
4. 子 agent / 子任务要用**合理模型分层**来控成本。

一句话：

> **OctoClaw 的本质是 OpenClaw 上的一层 execution policy + delegation harness，而不是另起一套总控运行时。**

### 1.2 当前真正的问题

不是功能太少，而是：

1. 热路径职责过多，首响和稳定性互相拖累。
2. 同一条消息被 front gate / route / tool policy / follow-up grounding 重复解释。
3. JS、Python、patrol、display、replay 等层对“状态真相”都有发言权。
4. `runner / spawn / patrol / relay / task-state` 的边界不清。
5. 代码里越来越多是“为了补前一个洞而加的控制逻辑”，而不是清晰骨架。

### 1.3 这次重构的总策略

1. **缩小 live hot path**。
2. **把 LLM 职责和脚本职责重新切开**。
3. **把执行真相收敛到单一来源**。
4. **把 harness 明确设计成一级系统**，而不是零碎 glue code。
5. **用 TS/Node 对齐 OpenClaw 生态**，Python 只保留在离线/评估/迁移兼容面。
6. **做成 plugin-first 骨架**，让 auto router、快回复、委派、展示、IM 适配都能独立插件化。

---

## 2. 核心目标、非核心目标、已落地能力、未来能力

## 2.1 最核心目标

我认为 OctoClaw v2 的 `R0` 目标只有 4 个：

1. **Fast First Response**
   用户消息进入后，应先稳定给出 ACK / 首响，而不是让主模型卡在复杂决策链上。
2. **On-Demand Delegation**
   简单任务不委派，复杂任务才委派；默认单 worker，必要时再 compound / multi-step。
3. **Stable Delegation Lifecycle**
   委派任务必须有可追踪的开始、进度、阻塞、交付、失败、恢复。
4. **Cost-Aware Model Use**
   真正需要快的是 `judge/ACK` 和主入口控制链，而不是强行把主回答 agent 压成最便宜模型。
   `direct_main` 可以比 `judge_fast` 更强，先保证主回答质量；子任务再按复杂度和角色分层，用固定映射把成本打下来，后续再接自动选模。

这 4 个里，前 3 个比“更智能”更重要。

## 2.2 非核心但重要的后续能力

这些不是不重要，而是**不能先于 `R0/R1` 稳定性目标**：

1. 自动选模型 / 动态模型学习
2. harness 自进化 / policy self-tuning
3. 更复杂的 multi-agent swarming
4. 更丰富的状态展示面板
5. 更强的 IM / topic / 展示适配
6. 更大的 MCP / tool search / tool marketplace

这些都应该建立在稳定骨架之上。

另外还有一个我认为应该提前纳入架构约束的方向：

7. **功能可插拔、可独立开源的插件化能力**

这不是简单的“以后拆包”。

它意味着从 v2 一开始就要避免把以下能力焊死在同一个核心 runtime 里：

1. auto router
2. fast reply / ACK enhancement
3. subagent / delegation runtime
4. multi-agent status surface
5. IM adapter optimizations

## 2.3 已经落地、值得保留的东西

从现有文档和代码看，OctoClaw 并不是“什么都没成”，相反，很多关键设计已经落地：

1. route / policy-first 的总体方向是对的。
2. `intent_class`、conversation control、follow-up grounding 这些概念是对的。
3. 模型策略分层和 model-health/fallback 方向是对的。
4. compound request / compound plan 的 schema 方向是对的。
5. `brief / result / artifact / event / eval outcome` 这些 harness contract 已经写得比较清楚。
6. ownership lock、dead-agent recovery、session resume、artifact index、checklist persistence 这些 durability 能力已经有雏形。
7. replay / review / acceptance / fixture export 的意识是对的。
8. JS 热路径优先、Python 逐步退出 live path 的方向，文档里已经非常明确。

换句话说：

> **需要推翻的主要不是“产品判断”，而是“当前实现形态”。**

## 2.4 未来能力应该如何排序

这里建议用 `R0-R4` 表示**能力优先级**，避免和后文 `Phase 1-4` 的实施阶段混淆。

建议排序：

1. `R0`：快首响 + 单一路径 + 单一真相源 + 单 worker 稳定委派
2. `R1`：compound request / dependency-aware flow
3. `R2`：黑盒 acceptance + replay/eval 常态化
4. `R3`：IM 展示、控制面、状态产品化
5. `R4`：自动选模型、自进化 harness、重型 research profile

---

## 3. 现有系统里该复用什么，推翻什么

### 3.0 代码现状快照（2026-04-15）

我对当前代码的判断，不只是基于设计文档，也基于现有代码形态本身。

当前仓库大致呈现出这样一个结构：

1. 总文件约 295 个，总行数约 114,943 行
2. Python 约 164 个文件 / 64,312 行
3. JS 约 16 个文件 / 11,783 行
4. Markdown 文档约 64 个文件 / 26,017 行
5. `extensions/octoclaw-runtime/index.js` 单文件约 3,544 行
6. `extensions/octoclaw-runtime/policy/decide.js` 约 1,801 行
7. `extensions/octoclaw-runtime/policy/route.js` 约 1,578 行
8. `lib/dispatch_task.py` 约 1,796 行

这说明当前系统的真实形态是：

1. **Node/JS 已经承担了热路径中的关键语义决策**
2. **Python 仍然承担了大量运行期协调与兼容职责**
3. **入口过大、跨语言边界过多、状态文件过多**

所以这次重构不是“从 Python 换成 TS 就会 magically 变好”。

真正要解决的是：

1. 热路径边界
2. source of truth
3. route/backend/model/profile 的拆分
4. harness 的一等化

## 3.1 建议复用

### 3.1.1 设计与协议层

建议直接继承，而不是重新发明：

1. `intent_class` 与 conversation control 思想
2. route / policy / model policy 的语义拆分
3. `octoclaw.worker_result/v1` 等 contract 思想
4. compound plan 的 schema / validate / schedule 思路
5. event / artifact / eval outcome 的 contract inventory
6. ownership / resume / checklist / artifact index 这些 durability 需求定义

### 3.1.2 代码层

以下 JS 模块更适合**迁移到 TS 并重组**，而不是概念上推倒：

1. `extensions/octoclaw-runtime/policy/decide.js`
2. `extensions/octoclaw-runtime/policy/route.js`
3. `extensions/octoclaw-runtime/policy/judge.js`
4. `extensions/octoclaw-runtime/policy/model.js`
5. `extensions/octoclaw-runtime/policy/planner.js`
6. `extensions/octoclaw-runtime/policy/compound_plan.js`
7. `extensions/octoclaw-runtime/conversation-control.js`

这些文件的问题主要是：

1. 还是 JS，不够类型化。
2. 模块边界还不够干净。
3. 和 `index.js` 这种大入口耦合过重。

但它们里面的很多规则、枚举、校验、判定逻辑是可以迁移的。

### 3.1.3 现有评估资产

建议保留：

1. 现有 acceptance case
2. replay fixture export
3. Slack/IM 黑盒 case 思路
4. route/policy golden 测试思想

它们应该成为 v2 harness 的回归资产。

## 3.2 建议推翻或降级

### 3.2.1 必须推翻的

1. **`extensions/octoclaw-runtime/index.js` 这种超大总入口**
   它现在像一个“神文件”，同时承担插件入口、状态管理、ACK、relay、dispatch、policy、持久化等职责。
2. **Python live-path parity**
   Python 不应该再和 TS/JS 一起竞争 live route authority。
3. **把 patrol 当半个执行引擎来补洞**
   patrol 可以保留，但只能做 reconcile / inspect / repair helper，不能继续承担常态执行真相。
4. **多份文件都像 source of truth 一样存在**
   `task-state.json`、`task-events.jsonl`、delivery relay、session store 等不能继续“看起来都像真相源”。
5. **prompt-heavy front gate**
   不能继续靠大量 prompt pattern + hardcoded keyword 判断来支撑热路径语义。

### 3.2.2 应该降级的

1. `runner` 不应再是和 `direct / spawn_single / spawn_multi` 平级的“语义 route”。
2. ClawTeam 不应再被视为默认必需 runtime。
3. replay / display / learning 不应参与 live route 真相判断。
4. Python dispatch / bridge 只能作为过渡兼容层，不能继续是核心架构依赖。

## 3.3 一个非常重要的重构结论

建议把“语义 route”和“执行 backend”彻底拆开。

当前很多复杂度来自把这些东西揉在一起：

1. 这条请求属于什么类型
2. 要不要委派
3. 委派后是单 worker、advisor-assisted 还是 multi-agent
4. 用哪个 backend 跑
5. 用哪个模型

v2 应改成：

### 语义 route

1. `reply`
2. `delegate`

### coordination mode

1. `solo_worker`
2. `advisor_assisted`
3. `threaded_subagents`
4. `compound`

### execution backend

1. `openclaw-native`
2. `clawteam`
3. `legacy-python`（仅迁移期）

### model profile

1. `local_judge`
2. `remote_judge`
3. `observer_probe`
4. `direct_main`
5. `worker_default`
6. `worker_code_normal`
7. `worker_code_deep`
8. `worker_review`
9. `worker_deep`

这样组合关系会简单很多。

---

## 4. Anthropic 值得借什么

现有你自己的 Anthropic 笔记判断基本是对的，我这里做一次收束。

## 4.1 最值得借的不是“多 agent”，而是 4 个工程原则

### 4.1.1 Workflow-first，agent-second

Anthropic 一直强调先用简单、可组合的 workflow，再决定是否真的需要更强 agent 化。

对 OctoClaw 的含义：

1. 默认单 worker。
2. compound / multi-step 只在必要时启用。
3. 不要把所有复杂请求都升级成 research swarm。

### 4.1.2 Context engineering 比 prompt 花活重要

最该借的是这条：

> 真正影响稳定性的，不只是 system prompt，而是每一步暴露给模型的 state、tool result、summary、artifact 和 recent actions。

对 OctoClaw 的含义：

1. 不要靠 transcript 回放支撑 follow-up。
2. 要靠 `context pack / brief / artifact refs / summary` 做跨 session 交接。
3. 子 agent 必须只吃最小必要上下文。

### 4.1.3 Harness 是一级系统

Anthropic 关于长流程 harness 的经验，和 OctoClaw 最近暴露的失败模式几乎完全对齐。

最应该吸收的是：

1. 结构化 handoff artifact
2. checkpoint / resumability
3. cross-session continuity
4. progress surface
5. end-state evaluation

### 4.1.4 Tool / contract / eval 要一起设计

工具描述、工具结果塑形、tool eval、真实故障 postmortem，不该拆开看。

对 OctoClaw 的含义：

1. tool result 必须为后续模型和状态机消费而塑形。
2. progress / result / artifact / delivery 都要有 schema。
3. harness regression 需要黑盒 acceptance 和端态评估。

### 4.1.5 Managed Agents / Advisor：借稳定接口，不绑死单家实现

Anthropic 在 2026-04-16 可见的两条官方资料里，最值得借的不是“他们有托管能力”，而是两种接口思路：

1. **Managed Agents 的 many brains / many hands / session-thread 接口**
2. **Advisor tool 的 cheap executor + strong advisor 模式**

第一条的启发是：

1. brain 不该和 hands/sandbox/session 耦死
2. 多 agent 时，thread 应该是上下文隔离的一等对象
3. coordinator 和 subagent 应共享 flow truth，但不共享上下文窗口
4. 一层 delegation 往往比递归 swarm 更稳

第二条的启发是：

1. 不是所有复杂任务都要起子 agent
2. 很多场景更适合“执行模型 + 顾问模型”的中途咨询
3. bulk token 可以继续跑在便宜/中档模型上
4. 只有 plan / course correction / final review 才调用强模型

对 OctoClaw 的结论是：

1. **要提前为 multi-agent 设计 thread/agent/contracts**
2. **也要提前为 advisor-assisted execution 设计 provider-agnostic 接口**
3. **但不能把 Anthropic 的托管实现细节硬编码进 OctoClaw**

换句话说：

> **我们要借的是接口形态，而不是绑定某一家平台的运行时。**

## 4.2 不该误读 Anthropic 的地方

不应该从 Anthropic 那些文章里读出以下结论：

1. “我们也应该上更复杂的多 agent 拓扑”
2. “应该把 OctoClaw 做成通用 agent SDK”
3. “应该让模型承担更多运行时控制责任”

相反，真正该学到的是：

> **把复杂性放进 harness，把主流程保持简单。**

---

## 5. 开源项目里应该借什么

## 5.1 ClawTeam：借任务运行面，不借总脑

ClawTeam 最值得借的不是“大 swarm 叙事”，而是这几件实际东西：

1. task + dependency tracking
2. inbox/message
3. git worktree isolation
4. tmux workbench
5. 让任何 CLI agent 都能被纳入统一任务面

对 OctoClaw 的结论：

1. 可以把 ClawTeam 作为 `delegate` 某些 profile 的**可选 backend**。
2. 不要再把 ClawTeam 变成 OctoClaw 的必经主 runtime。
3. 可以借它的任务/依赖/收件箱思路，但 live route 和 policy 仍应由 OctoClaw 自己掌握。

## 5.2 DeerFlow：借 heavy-profile 哲学，不借主 loop

DeerFlow 值得借的是：

1. long-horizon harness 思维
2. isolated subagent context
3. sandboxes / memory / subagents / gateway 的重任务组合方式
4. 重任务与普通任务分层

对 OctoClaw 的结论：

1. 可以把 DeerFlow-like 能力收敛成 future heavy profile。
2. 不要把它整套塞成 OctoClaw 主运行时。
3. 它更适合启发 `compound / heavy / research` lane，而不是默认执行面。

## 5.3 GSD：借 context engineering 与 spec/eval discipline

GSD 最值得借的是：

1. 结构化 planning / summary / verification / retrospective 工件
2. context rot 对抗思路
3. 质量门禁和验证闭环
4. “复杂度在系统里，不在用户工作流里”的设计态度

对 OctoClaw 的结论：

1. 借 artifact 模板和验证闭环
2. 借 planning / verification / retrospective 的结构化输出
3. 不要把它整套 workflow 命令系统搬进 live runtime

## 5.4 OmO：借模型分层和稳定性护栏，不借 hook soup

OmO 最值得借的是：

1. category-based model routing
2. background task / subagent 运行与结果回收
3. 稳定性钩子、fallback、loop detection 这种“运行面护栏”意识
4. 更稳的编辑工具与执行护栏

对 OctoClaw 的结论：

1. 模型选择应该面向**任务类别**，而不是到处散落 override。
2. 背景子任务应该是 harness 的显式能力。
3. 但不能把几十个 hooks 叠成新的复杂度来源。

## 5.5 OpenHarness：借“模型负责语义，harness 负责边界”

OpenHarness 最值得借的方向是：

1. harness-first 的思维
2. 技能/知识按需加载
3. 权限、sandbox、执行边界前置

对 OctoClaw 的结论：

1. live path 不要无边界地把所有知识和控制逻辑塞给模型。
2. tool / skill / policy 都应该按需、显式、可审计地进入上下文。

## 5.6 Hermes Agent：借长驻形态与技能沉淀，不借闭环自增殖

Hermes Agent 现在热度很高，我看了它的公开 README 和相关页面后，认为它最值得借的不是“自我进化”口号，而是这几件更工程化的东西：

1. long-running agent 的运行形态
2. CLI + messaging gateway 的统一入口
3. skills / context files / memory 的显式载体
4. 可替换 terminal backends
5. 对多 provider / 多模型切换的产品化包装

对 OctoClaw 最有价值的借鉴点有 4 个：

### 5.6.1 Agent lives beyond one terminal session

Hermes 的一个强点是：它不是把 agent 绑定在某个 IDE 窗口里，而是把 agent 视为一个能跨 CLI、聊天平台、远程环境延续的实体。

这对 OctoClaw 的启发是：

1. `thread/session` 必须是一等对象
2. session continuity 要靠 substrate truth + summaries + artifacts
3. “主进程退出了”不应等于“任务身份消失了”

但这里要注意：

> **我们要借的是 continuity，不是把常驻进程重新变成架构前提。**

### 5.6.2 Skills / context files 要做成显式工件

Hermes 很强调 skills、context files、持久化记忆这些“可见载体”。

这和 OctoClaw 当前方向是相容的，但要收敛成：

1. `TaskPacket`
2. `artifact refs`
3. `summary / checkpoint`
4. future skill / context file interface

也就是：

1. 经验沉淀成显式工件
2. 工件可以复用、可审计、可回放
3. 不能把“记忆”做成又一套不透明真相源

### 5.6.3 多执行面是 backend 问题，不是 policy 真相

Hermes 支持 local / Docker / SSH / Modal / Singularity / messaging gateway 等多执行面，这一点很强。

对 OctoClaw 的启发是：

1. `hands` 应该是可替换 backend
2. runtime core 不该和某一种执行面焊死
3. gateway / chat surface / remote environment 都应该是 adapter

这和我们现在把：

1. `backend`
2. `workspace_mode`
3. `coordination_mode`

分开的方向是一致的。

### 5.6.4 产品层的模型切换体验值得学，但路由权不能回到 UI

Hermes 在“切 provider / 切 model 很顺滑”这件事上产品感很强。

这对 OctoClaw 的启发是：

1. model profile -> model id 映射应该产品化
2. provider slots 应该是正式接口
3. 后面 auto router 才能在不改主逻辑的情况下接进来

但不能学的是：

1. 让用户界面上的临时切模重新变成 live path 真相
2. 让 provider 选择绕过 policy / gate / telemetry

### 5.6.5 不该直接照搬的部分

我不建议把 Hermes 下面这些东西直接搬进 OctoClaw v1/v2 主链：

1. “built-in learning loop” 直接进 live hot path
2. 自主创建/改写 skills 的闭环先进入默认运行面
3. 持久 memory 直接参与 route authority
4. 大而全的单 agent 产品面直接压进 core

原因很简单：

1. OctoClaw 当前最缺的是稳定执行骨架，不是更强的长期自进化
2. learning loop 太早进主链，会显著增加不可解释状态
3. memory / skill / self-improvement 如果先变成热路径依赖，很容易重新长出第二套隐形真相源

所以对 OctoClaw 的最终结论是：

1. 借 Hermes 的 long-running continuity、gateway、skill/context 工件化、backend 可替换性
2. 不借 Hermes 的“自增殖学习闭环”进入 v1/v2 主路径
3. 如果以后要做 skills / context files / memory，也应先作为 artifact / projection / optional plugin 演进

---

## 6. Harness Engineering 应该怎么落到 OctoClaw

这是这次重构最关键的部分。

## 6.1 先给定义

在 OctoClaw 里，harness 不是“辅助脚本集合”，而是：

> 围绕模型建立的一整套确定性控制、状态、交付、恢复、评估系统。

LLM 负责处理语义不确定性。

harness 负责：

1. 路径选择
2. 状态转换
3. 任务物化
4. 权限与执行边界
5. 超时 / 重试 / 恢复
6. 进度与交付
7. 验证与回归

## 6.2 OctoClaw v2 的三个 harness

### 6.2.1 Runtime Harness

负责从消息进入到任务落地：

1. receive inbound request
2. build minimal request context
3. fast judge / route
4. independent ACK policy
5. materialize task/flow
6. emit initial state/event

### 6.2.2 Workflow Harness

负责委派生命周期：

1. build worker brief
2. assign backend + model profile
3. assign coordination mode
4. start worker / child thread / advisor consult
5. receive heartbeats / checkpoints / artifacts / result
6. manage thread handoff / inbox / resume
7. recover stale ownership / resume sessions
8. deliver progress and final result

### 6.2.3 Evaluation Harness

负责让系统长期可控：

1. environment preflight
2. contract tests
3. golden route tests
4. black-box IM acceptance
5. replay / regression fixtures
6. chaos / resume / timeout drills

## 6.3 这三个 harness 的关键设计原则

### 6.3.1 ACK 独立

只要任务需要委派，ACK 就不该依赖后续复杂决策链。

建议：

1. route 一旦明确落到需要长处理的路径，必须保证首个可见反馈不再长时间静默。
2. ACK 默认由模板生成，不等模型生成自然语言。
3. `reply` 路径优先让主模型快速作答；`delegate` 路径优先保证稳定首响。

这里再把 ACK 的实现口径写得更完整：

#### A. ACK 默认由 runtime ACK controller 负责

1. ACK 的**默认所有权**不在主 agent，而在 `runtime ACK controller`
2. 它属于 `packages/octoclaw-runtime-core/src/ack`
3. 它的职责是保证“首个可见反馈”在可控时间内发生
4. 它不负责最终结论，只负责首响、阶段提示和去重协调

一句话：

> **ACK 首先是运行时交互保障，不是主模型临场发挥。**

但这里再补一个更理想的优先级：

> **最理想的首响，仍然是主 agent 自己快速回；runtime ACK controller 是兜底层，不是默认想抢主角。**

所以更准确的实现心智应该是：

1. 先通过 `agent.md` / system injection / route packet 明确提示主模型优先给出快速首响
2. 如果主模型在窗口内给出**合格首响**，runtime 不再单独发 ACK
3. 如果主模型没有及时给出合格首响，runtime ACK controller 再旁路介入

也就是说：

1. **主模型优先**
2. **运行时兜底**
3. **永远不要把用户体验赌在主模型一定会快上**

这里的“注入”不建议被实现和命名成某个具体 hack。

更稳定的架构口径应该是：

> **通过 `request envelope + prompt policy injection seam` 引导主模型优先快速首响。**

也就是说：

1. 可以由 prompt builder 实现
2. 可以由 model middleware 实现
3. 可以由 runtime adapter 在调用前拼装
4. 也可以由某个 pre-model hook 实现

但在设计层，不应该把它绑定成“只能靠某个 hook 注入”。

真正重要的是这条 seam 的语义：

1. 当前 route 是什么
2. 当前是否允许主模型抢首响
3. 当前静默预算是多少
4. 什么样的短首响才算合格
5. 什么时候 runtime 会接管 ACK

#### B. ACK 是否需要 LLM

v1 默认建议：

1. **首个 ACK 不依赖 LLM**
2. 默认走 code-generated template
3. 可以根据 route / backend / queue / risk / stage 选择不同模板
4. 但不等待模型生成自然语言才发 ACK

后续如果要做更细腻的 ACK，可以允许：

1. small fast model 在极短预算内做 template selection 或一行轻量改写
2. 但它必须是 optional enhancement
3. 任何时候只要 fast model 超时，立即回退到纯模板 ACK

也就是说：

> **LLM 可以增强 ACK，但不能成为 ACK 的前提。**

这里再区分两件事：

1. **用注入去引导主模型先快回**
2. **让远端模型专门生成 ACK**

前者我认为是值得做的，后者不应该成为前提。

也就是说：

1. 可以通过 `agent.md` / injected policy 提醒主模型：
   - 如果你能在极短时间内先给一句合格首响，就先回
   - 不要一上来闷头长思考
2. 但不能为了 ACK 再专门调用一次远端模型，等它生成后才回

所以这里的边界是：

> **可以“引导主模型快 ACK”，但不能“依赖另一次模型调用来产出 ACK”。**

#### C. ACK 介入节奏

从行为心理学和交互体验看，我建议把节奏写成：

1. **0-1s**
   - 如果 route 已明确是 `delegate` 的长任务路径，尽量在这一段给出首个 ACK
   - 但如果用户仍处于 burst 输入中，优先等待一个很短的输入静默窗口再发
2. **1-3s**
   - 如果是 `reply` 路径，优先让主模型自己首响
   - 但如果到 `~3s` 还没有首 token / 首段输出，就由 ACK controller 介入一个 soft ACK
   - 如果 route 到这时仍未稳定，也要允许一个更中性的 pre-route soft ACK 先兜底
3. **6-8s**
   - 如果仍没有首 token、首进展或阶段事件，给出阶段性状态提示
4. **10-12s**
   - 如果还是长静默，应给出明确的当前阶段、剩余步骤或可打断入口

所以：

1. `5s` 可以作为“静默过久”的危险线
2. 但不适合作为首个 ACK 的目标线
3. v1 更稳的目标应该是：**不让用户连续静默超过 3s**

这里再补一个关键前提：

> **ACK 的对象是“静默”，不是“正在连续输入的用户”。**

如果用户还在 1-2 秒内连续补充消息，ACK controller 更应该：

1. 先做 burst 合并
2. 等一个很短的输入静默窗口
3. 再决定是否发 ACK / update

而不是在用户还在打字时硬插一条短回复。

#### C.1 route/judge 本身慢时怎么办

这里要补一个之前容易漏掉的点：

> **如果 route/judge 自己还没稳定，但用户已经快要感到静默过久，也需要兜底。**

所以 ACK controller 至少要支持一个 **pre-route soft ACK**：

1. 它只表达“已收到，正在判断处理方式”
2. 不表达已经进入 `reply` 或 `delegate` 中的哪一条
3. 一旦 route 稳定，再转成对应模板或直接进入正式输出

这类 ACK 必须比 `delegate_started` 更中性，避免误导。

#### D. direct 路径和 delegate 路径的差异

1. `delegate`
   - v1 默认以 runtime code-generated ACK 为主
   - 只在主模型已经热启动、且不会拖慢首响时，才允许它抢先给一句合格首响
   - 否则不要为了等主模型而推迟 delegate ACK
2. `reply`
   - 优先让 `direct_main` 自己首响
   - 只有在主模型首 token 慢时，才由 ACK controller 旁路接入

这意味着：

> **理想情况当然是主 agent 自己快速首响；但系统不能把这件事赌给主模型。**

#### E. 如何避免出现两次短回复

这是 ACK 设计里非常重要的一条。

我建议引入一个统一的 **first-visible-response lease**：

1. 谁先拿到 lease，谁就占用首个可见响应位
2. 如果主模型在 ACK deadline 前先吐出首 token，就取消 ACK
3. 如果 ACK controller 先发出 ACK，主模型后续不能再发第二条“我在看/我来处理”式短回复
4. 后续主模型只能：
   - 继续输出正式结果
   - 或更新同一个 anchor/message（如果渠道支持 edit/update）

所以：

1. 不允许“脚本先回一句，我看看；主模型又回一句，我来查一下”
2. ACK 和主模型共享同一个首响协调器

但这里还要再补一个更底层的约束：

> **不能只靠进程内布尔位防重，ACK 必须有真正的 exactly-once guard。**

像你说的这种问题：

1. `maybeSendLatencyAck` 在 `before_prompt_build` 被调一次
2. 又在 `before_tool_call` 被调一次
3. 两次之间如果只靠某个内存态 `latencyAckSent=true`
4. 就很容易因为状态不同步、异步竞态、上下文重建而重复发送

所以我建议 ACK 至少有这 3 层防重：

1. **first-visible-response lease**
   - 解决“谁先占首响位”
2. **ack idempotency key**
   - 解决“同一个 ACK 意图被调用两次”
3. **delivery outbox / receipt**
   - 解决“发送侧 effect 到底有没有真正落地”

更具体地说：

1. 每个 ACK 都要生成稳定的 `ack_key`
2. `ack_key` 至少应绑定：
   - `thread_id`
   - `anchor_id`（如果有）
   - `ack_stage`
   - `route_phase`
   - `message_turn_id` / `request_id`
3. 发送前必须做一次 compare-and-set / insert-if-absent
4. 如果同一个 `ack_key` 已存在，就直接 suppress
5. 真正的发送副作用再通过 outbox/receipt 落账

这样设计后：

1. `before_prompt_build`
2. `before_tool_call`
3. `before_stream_start`

这些 hook/middleware 就算都误触发同一个 ACK 意图，最终也只会有一次真正可见发送。

一句话：

> **ACK 去重不能只靠“记得别发两次”，必须靠幂等键和副作用账本。**

这里的“合格首响”建议也要有个明确定义，避免主模型随便吐半句就占掉位子：

1. 不是空洞 filler
2. 不是重复用户原话
3. 不冒充已经完成理解的结论
4. 长度足够短，但能传达“已收到/已开始/当前阶段”

如果主模型只吐出低质量 filler，也不应视为拿到了最终首响位，runtime 仍可按策略补一个更稳定的 ACK/update。

#### F. 首 token 慢时怎么介入

如果是 `reply` 路径，但主模型 TTFT 慢，建议这样处理：

1. 先给主模型一个很短的首响窗口
2. 如果窗口内没有首 token，则 ACK controller 发一个 soft ACK
3. soft ACK 要比 delegate ACK 更轻，不要误导成已经进入长后台任务
4. 一旦主模型开始输出，后续转入正式回答链

也就是说，ACK controller 是：

1. 首响保险丝
2. 不是主模型替身

而对 `delegate` 路径，也建议类似：

1. 先给主模型一个极短“抢首响”窗口
2. 窗口内如果它已经发出合格首响，则 runtime 抑制独立 ACK
3. 否则 runtime 立即接管首个 ACK

所以这套机制不是“程序 ACK vs 主模型 ACK 二选一”，而是：

> **主模型优先首响，运行时负责 deadline、去重和保底。**

#### G. ACK 文案分层建议

v1 不建议追求“每次都写得很灵动”，而建议固定几类 ACK：

1. `delegate_started`
   - 已接单，开始处理
2. `observer_started`
   - 已开始检查/探测
3. `reply_soft_ack`
   - 已收到，正在组织回复
4. `queued`
   - 已接单，但在排队/等待容量
5. `blocked`
   - 已识别阻塞原因，需要等待输入/权限/容量
6. `progress_nudge`
   - 还在处理，当前阶段是什么
7. `pre_route_soft_ack`
   - 已收到，正在判断处理方式

这些都应优先模板化，而不是让模型自由生成。

更具体地说，v1 不是“只有一个固定模板”，而是：

> **固定一个小模板池，再由 runtime 按状态选模板。**

建议最小模板池如下：

| 模板 key | 触发条件 | 文案方向 | 默认动作 | 适合渠道 |
| --- | --- | --- | --- | --- |
| `pre_route_soft_ack` | route/judge 还未稳定，但静默预算将耗尽 | 已收到，正在判断处理方式 | 优先短提示；后续被稳定 route 覆盖 | 聊天渠道优先 |
| `delegate_started` | 已判定 `delegate` 且成功物化 | 已接单，开始处理 | 优先新发或创建 anchor | 全渠道 |
| `observer_started` | 已判定 `delegate(role=observer, coordination_mode=solo_worker)` 且需要短探测/后台观察 | 已开始检查/探测 | 可新发，也可轻量提示 | 全渠道 |
| `reply_soft_ack` | `reply` 路径主模型首 token 超时 | 已收到，正在组织回复 | 优先短提示；后续由正式回复覆盖 | 聊天渠道优先 |
| `queued` | admission control / queue budget 命中 | 已接单，但在等待容量 | 优先更新已有 anchor | 全渠道 |
| `blocked` | 缺权限/缺输入/风险边界阻断 | 当前卡在什么条件上 | 优先新发明确说明 | 全渠道 |
| `progress_nudge` | 6-8s 仍无可见进展，但 task 还在推进 | 还在处理，当前阶段是什么 | 优先更新已有 anchor | 支持 update 的渠道优先 |

v1 默认先不要无限扩模板种类。更稳的做法是：

1. 先把这 6 类模板做稳
2. 每类允许 1-3 个轻微 wording variant
3. 但 variant 也应是固定文案池，不是自由生成

#### G.0.a 模板选择应该依据什么

模板选择默认由 runtime 根据结构化状态做，不靠语言生成。

优先输入：

1. `route`
2. `ack_stage`
3. `queue_state`
4. `blocked_reason`
5. `channel_capability`
6. `burst_state`
7. `anchor_exists`
8. `user_input_active`

所以正确心智是：

1. 先确定状态
2. 再选模板 key
3. 最后选是否新发、更新还是抑制

而不是：

1. 先让模型理解一遍
2. 再即兴写一条 ACK

#### G.0.b 模板是否允许按渠道不同

允许，但建议只在 presentation 层差异化，不在语义层分叉。

也就是：

1. 语义模板 key 统一
2. 不同渠道可以有不同 renderer
3. Slack/飞书这类支持 update 的渠道，优先 edit/update
4. 纯文本渠道可以直接发简版文案

这样可以避免：

1. 语义模板和渠道模板混成一团
2. 每个渠道自己重新发明一套 ACK 语义

#### G.1 ACK 不能每条都回：需要自适应节流与合并

这里要特别防止一种很糟的产品感：

> **用户连续输入 3-5 条补充消息，系统每条都机械回一个 ACK。**

这会让体感非常假，也会稀释真正有价值的进展反馈。

所以我建议 ACK controller 默认带一套 **adaptive ACK policy**：

1. **burst coalescing**
   - 如果用户在短窗口内连续输入多条消息，把它们视为同一波输入
   - 默认合并成一次 ACK，而不是条条回复
   - 只在检测到输入短暂停止时才真正发 ACK
2. **cooldown window**
   - 同一 thread/anchor 在刚发过 ACK 后，短时间内不再重复发同类 ACK
3. **anchor-first update**
   - 如果渠道支持 edit/update，优先更新现有 ACK/status anchor
   - 不优先新发一条消息
4. **state-change only**
   - 只有状态真的变化了，才值得发新的 ACK / nudge
   - 比如 `queued -> started`、`started -> waiting_input`
5. **silence-driven intervene**
   - ACK 介入的核心依据应是“用户侧静默过久”
   - 不是“又来了一条消息，所以我也回一条”

也就是说：

1. 用户连续追问时，系统更应该合并上下文
2. 然后给一个更准确的 ACK/update
3. 而不是每条补充都触发一个模板回执

#### G.2 ACK 是否需要“按需更智能”

需要，但建议是分层的：

1. **第 0 层：纯模板**
   - 默认安全底座
2. **第 1 层：模板选择更智能**
   - 根据 route / queue / stage / burst state 选更合适模板
3. **第 2 层：小快模型轻润色**
   - 只在预算内做非常轻的 wording adjustment
4. **第 3 层：主模型自然首响**
   - 仅当主模型本身已经准备好输出时发生

真正该“更智能”的，不是把 ACK 写得更花，而是：

1. 知道什么时候该回
2. 知道什么时候不该回
3. 知道该复用旧 anchor 还是发新消息

#### G.3 ACK 的抑制条件

建议 ACK controller 至少支持下面这些 suppress 规则：

1. 最近刚有可见 ACK，且状态未变化
2. 主模型已经开始正式输出
3. 当前用户消息属于同一 burst，只是补充细节
4. 已有 status anchor 可更新，不需要再发新短消息
5. 当前渠道不适合频繁刷短状态
6. 用户仍处于活跃连续输入中，尚未进入短静默窗口

#### G.4 从行为心理学看，ACK 的目标不是“多回”，而是“降不确定性”

这里最重要的不是 ACK 频率，而是：

1. 在用户开始不安前给出确定感
2. 在长静默时给出进展
3. 在连续互动时避免打断和刷屏

所以更准确的产品原则是：

> **ACK 的目标不是制造存在感，而是降低不确定性。**

#### H. ACK 成功标准

ACK 设计成功，不是“看起来会说话”，而是同时满足：

1. 用户侧静默时间明显缩短
2. 不制造双短回复
3. 不把主模型 context 搞脏
4. 不依赖昂贵模型
5. 不让 ACK 本身成为新的慢点
6. 不在用户连续输入时机械打断
7. 不在 route 未确认时冒充已理解并给出具体处理方案

可衡量指标至少包括：

1. `ack_ms`
2. `ack_suppressed_by_main_count`
3. `ack_fallback_template_count`
4. `double_short_reply_rate`
5. `reply_soft_ack_rate`
6. `post_ack_final_delivery_ms`
7. `ack_suppressed_rate`
8. `ack_burst_coalesced_rate`
9. `ack_update_vs_new_message_ratio`

### 6.3.2 交接靠 artifact，不靠 transcript

每个 delegated task 至少输出：

1. `brief`
2. `progress checkpoint`
3. `artifact manifest`
4. `worker result`
5. `delivery envelope`

这里还要把一个原则写死：

> **主模型默认不背全量上下文，能不看 transcript 就不看 transcript。**

具体含义是：

1. 主模型只拿当前回合真正需要的最小上下文
2. 长过程信息优先沉淀为 artifact / summary / state，而不是堆进主会话
3. 子 agent 产出的中间材料，先转成结构化结果，再决定是否回注给主模型
4. 能在 worker lane、observer lane、evaluation lane 处理的信息，不回流主模型

这样做的目的有 3 个：

1. 降低主模型上下文污染
2. 降低主模型 token 成本
3. 提高主模型最终回答质量与稳定性

### 6.3.3 中间状态必须显式化

现在最需要新增的不是更多 route，而是更好的中间事件。

建议至少补齐：

1. `checkpoint_emitted`
2. `deliverable_ready`
3. `waiting_input`
4. `backend_retry_scheduled`
5. `delivery_pending`

### 6.3.4 评估优先看 end-state，不要只看 turn-by-turn

长流程任务更适合做端态评估：

1. 是否成功完成目标
2. 是否把结果送回正确线程
3. 是否在超时/失败时进入正确终态
4. 是否保留可恢复上下文

### 6.3.5 先做 preflight，再跑语义 harness

我在 2026-04-15 本地跑 `python3 lib/harness_gate.py --preset quick --format json` 时，出现了大面积失败，主因不是语义回归，而是环境里 `node` 不在 PATH，导致大量 Node 侧用例直接 `FileNotFoundError`。

这说明 v2 harness 必须先拆出：

1. 环境失败
2. provider 失败
3. contract/schema 失败
4. route/policy 失败
5. workflow lifecycle 失败

否则测试信号会被污染。

---

## 7. LLM 和脚本控制的比例，应该怎么拿捏

这次重构最重要的不是重新选一个“比例”，而是重新划职责边界。

## 7.1 让模型做什么

模型应主要负责：

1. 语义判断
2. 模糊任务的 route/judge
3. compound request 的拆解
4. brief / summary / handoff 内容生成
5. 真正的 coding / research / ops 工作

## 7.2 让代码做什么

代码和 harness 必须负责：

1. 生命周期状态机
2. 任务 ID / flow ID / thread binding
3. 持久化
4. 超时 / 重试 / backoff
5. 进度和终态事件
6. ownership / heartbeat / resume
7. permission / backend 选择 / delivery

## 7.3 一个务实的经验法则

### live path

应当是**代码主导、模型辅助**。

### worker execution

应当是**模型主导、代码护航**。

### eval / recovery / delivery

应当是**几乎完全代码主导**。

这比“全 LLM”或“全脚本”都更稳。

---

## 8. 技术选型建议

## 8.1 主语言：TypeScript

建议结论很明确：

> **OctoClaw v2 的正式产品代码全部用 TypeScript 重写。**

原因：

1. OpenClaw 上游已经是 TS/Node 主生态。
2. 现有 OctoClaw 热路径关键模块已经主要在 JS。
3. 你当前最痛的是路径、参数、边界、跨语言热路径耦合，TS 在这里收益很大。
4. 要做 OpenClaw plugin-first 集成，TS 是更自然的语言。

这里我建议再把约束写死：

1. 旧 Python/JS 文件可以参考
2. 但正式重构时不继续在旧文件上打补丁
3. runtime / policy / control / observer / display / feedback 的正式实现全部新建 TS 模块
4. 不保留“Python 版本 + TS 版本”长期并行

换句话说：

> **可以参考旧文件，但不能舍不得重写。**

## 8.2 Python 的位置

Python 在 v2 正式代码里应当退出，只保留在这些边角位置：

1. 测试脚本
2. 运维脚本
3. 一次性迁移脚本
4. 临时分析脚本
5. 外部环境 glue script（如果短期确实省事）

但以下东西都不应继续用 Python 保留：

1. live route
2. dispatch/materialization
3. runtime observer
4. IM/display 正式实现
5. feedback/eval 正式产品代码
6. model policy / router core / taskflow adapter

也就是说：

> **除了测试脚本、运维脚本和一次性工具，OctoClaw v2 不再保留 Python 正式实现。**

## 8.3 TS / Node 版本建议

建议直接对齐 OpenClaw 上游当前基线：

1. **TypeScript：6.0.x**
2. **Node：>= 22.14.0**
3. `module/moduleResolution`: `NodeNext`
4. `target`: `ES2023`
5. 包管理：`pnpm`
6. 测试：`vitest`

这和当前 OpenClaw 上游 `package.json` / `tsconfig.json` 一致，能减少生态摩擦。

## 8.4 状态存储建议

这是一个我建议你认真考虑并大概率采纳的决定：

> **v2 不要再把 `task-state.json` 当执行真相源。**

更推荐：

1. **OpenClaw 原生 task/flow registry（SQLite）作为执行真相源**
2. OctoClaw 自己维护的 policy metadata / artifact index / delivery projection 作为派生层
3. JSON/JSONL 只做导出、投影、审计或兼容，不做核心事务真相

原因：

1. OpenClaw 上游已经有 `task` / `flow` 的 SQLite registry。
2. SQLite 比多份 JSON 文件更适合做单一状态真相。
3. 这能直接减少大量路径、锁、并发写入、派生状态漂移问题。

### 8.4.1 但要承认一个现实约束：OpenClaw 现在不是“CLI create-first”

这里需要特别说明一个落地约束。

截至这次调研时，OpenClaw 原生 task/flow 的能力更像是：

1. **有 runtime API**
2. **有 webhook surface**
3. **有 registry + status/audit/cancel CLI**
4. **但没有成熟、稳定、面向外部编排者的 `task create` / `flow create` CLI 主路径**

更具体地说：

1. OpenClaw 的 CLI 目前明显有 `tasks list/show/audit/maintenance/cancel` 与 `tasks flow list/show/cancel`
2. 但 create 路径主要还在 runtime 里，而不是标准 CLI authoring surface
3. canonical `runtime.tasks.runs` / `runtime.tasks.flows` 当前偏向 DTO/read-model
4. 真正带 create/mutate 能力的，还是 legacy alias `runtime.taskFlow` / `runtime.tasks.flow`

这意味着：

> **如果 OctoClaw v2 要押 OpenClaw 原生 task/flow，它不能假设“外部 shell 直接 openclaw task create 就行”。**

### 8.4.2 当前 OctoClaw 其实已经在绕过这个限制

现有代码里已经有一个非常有代表性的实现：

1. `lib/openclaw_taskflow_adapter.py`
2. `lib/openclaw_taskflow_runtime_helper.mjs`

它的做法不是直接走 CLI create，而是：

1. 动态定位 OpenClaw runtime bundle
2. 调 `createPluginRuntime()`
3. 调 `runtime.taskFlow.bindSession({ sessionKey })`
4. 再调用 `createManaged(...)`

也就是说，当前 OctoClaw 自己已经默认承认了一件事：

> **native create 目前主要应通过 runtime seam，而不是 CLI seam。**

### 8.4.3 所以 v2 应该怎么接

我建议把 native task/flow integration 分成三层：

#### A. 插件内主路径

如果 OctoClaw 本身就是 OpenClaw 插件：

1. 直接使用 OpenClaw plugin runtime
2. 直接调 `runtime.taskFlow.bindSession(...).createManaged(...)`
3. 直接调 `runTask(...)`

这是最自然、也最稳的路径。

#### B. 插件外受控入口

如果有外部 orchestrator / automation / bridge 需要创建 flow：

1. 不建议直接依赖不存在或未稳定的 CLI create
2. 更建议走 authenticated webhook surface
3. 由 OpenClaw 内部插件把 webhook action 映射到 runtime taskFlow create/run

这比 shelling out CLI 更稳定，也更容易做权限与审计。

#### C. CLI 仅作 read/cancel/operator fallback

CLI 更适合保留在：

1. list
2. show
3. audit
4. maintenance
5. cancel

而不是承担创建主路径。

### 8.4.4 这会改变我们对插件化的理解

这也进一步支持 plugin-first 架构：

1. `octoclaw-runtime` 插件内可以直接用 runtime seam
2. `octoclaw-auto-router` 等上层插件只和 OctoClaw contract 对话
3. 外部系统如果要编排，优先走 webhook/plugin surface，而不是直接依赖 CLI 内部细节

换句话说：

> **真正稳定的 OpenClaw 生态适配方式，不是 CLI-first，而是 plugin/runtime-first。**

### 8.4.5 一个保守建议

因此，v2 正式稿里应该把下面这条写死：

1. **不把 OpenClaw CLI create 当成关键前提**
2. **以 plugin runtime create 为首选**
3. **以 webhook create 为受控对外入口**
4. **CLI 主要承担 inspection / maintenance / cancel**

## 8.5 项目骨架建议

建议不要再做一个巨大的单插件目录。

建议骨架：

```text
extensions/
  octoclaw-runtime/
    src/
      plugin.ts
      adapter/
      config/
  octoclaw-auto-router/
    src/
  octoclaw-fast-reply/
    src/
  octoclaw-delegation/
    src/
  octoclaw-status-surface/
    src/
  octoclaw-im-adapters/
    src/

packages/
  octoclaw-contracts/
    src/
      events.ts
      artifacts.ts
      results.ts
      deliveries.ts
      schemas.ts

  octoclaw-policy/
    src/
      intent/
      judge/
      route/
      model/
      compound/

  octoclaw-runtime-core/
    src/
      ack/
      requests/
      tasks/
      workflow/
      delivery/
      recovery/

  octoclaw-evals/
    src/
      preflight/
      contracts/
      golden/
      acceptance/
      replay/

tools/
  octoclawctl/
  migration/
```

这个骨架的核心思想是：

1. adapter 薄
2. policy 可抽取
3. runtime core 不和 IM/plugin 细节绑死
4. eval 是一等包，不是边角脚本

但这里要特别强调：

> **这是逻辑目标骨架，不是要求 Phase 1 一次性把所有目录都实建出来。**

更稳的做法是：

1. 先把 `packages/octoclaw-contracts`
2. `packages/octoclaw-policy`
3. `packages/octoclaw-runtime-core`
4. `extensions/octoclaw-runtime`
5. `extensions/octoclaw-delegation`
6. `extensions/octoclaw-status-surface`
7. `packages/octoclaw-evals`

作为最小可运行骨架。

而下面这些可以晚点再真正落目录：

1. `extensions/octoclaw-auto-router`
2. `extensions/octoclaw-im-adapters`
3. richer multi-agent board / cockpit
4. advisor thread / heavy profile 扩展

也就是说：

> **先把 API 边界设计好，不等于先把所有插件都建出来。**

## 8.6 Plugin-first 原则

这次重构建议明确采用：

> **small core, optional plugins**

也就是：

### core 必须只保留

1. request normalization
2. fast judge / route contract
3. task/flow materialization
4. workflow state machine
5. delivery contract
6. eval / preflight hooks

### 默认不进 core 的能力

1. auto router 学习与高级路由
2. fast reply 的高级策略
3. subagent backend 扩展
4. multi-agent 展示面
5. IM 特定产品化增强

### 这样做的好处

1. OctoClaw 内核更稳
2. 更容易单独开源和独立演进
3. OpenClaw 生态适配更自然
4. 不同用户可以按需启用，不需要吃一整套复杂度
5. 未来你要把某一块独立成公开插件，几乎不需要再大拆骨架

### 8.6.a Anti-Bloat Guardrails

为了防止“为了可扩展而先把系统做重”，我建议再把下面这些约束写死：

1. core 不反向依赖 optional plugins
2. 一个新抽象只有在它能消灭旧复杂度时才允许引入
3. Phase 1 不允许出现第二套路由器、第二套状态机、第二套 delivery path
4. 不为未来功能先造空插件、空目录、空 registry，除非已经有明确消费者
5. `advisor`、`threaded_subagents`、`auto-router` 前期只保留 contract，不抢 live path 逻辑
6. `skills`、`context files`、`memory` 前期只允许作为 artifact/projection/plugin 能力出现，不进入 live route authority
7. IM / gateway / CLI 这些 surface adapter 只负责入口和展示，不拥有 session truth、不拥有 workflow truth
8. 任何新 plugin 都必须回答 3 个问题：
   - 它是不是可以完全不安装？
   - 它是不是不安装也不影响 core 正确性？
   - 它是不是只通过 contracts 和 core 对话？

一句话：

> **插件化是为了减核心，不是为了把未来复杂度提前搬进现在。**

## 8.7 建议的插件切分

我建议未来至少按下面的边界切：

### `octoclaw-runtime`

最小核心。

负责：

1. inbound handling
2. base route contract
3. base task/flow lifecycle
4. delivery + recovery contract

### `octoclaw-auto-router`

负责：

1. route intelligence
2. learned routing
3. cost/speed calibration
4. future auto model selection

### `octoclaw-fast-reply`

负责：

1. instant ACK strategy
2. short-answer policy
3. direct-reply optimization
4. reply latency instrumentation

### `octoclaw-delegation`

负责：

1. worker brief generation
2. subagent spawning profiles
3. backend adapters
4. compound/dependency execution helpers

### `octoclaw-status-surface`

负责：

1. progress rendering
2. task/flow status surfaces
3. multi-agent board / timeline / operator views

### `octoclaw-im-adapters`

负责：

1. Slack / Feishu / Telegram / Discord 等交互增强
2. topic/thread binding productization
3. channel-specific delivery formatting

这几个插件都可以共享：

1. `octoclaw-contracts`
2. `octoclaw-policy`
3. `octoclaw-runtime-core`

这样核心和可选能力之间会有清楚的 API 边界。

---

## 9. 推荐架构：OctoClaw v2

## 9.1 总体分层

### 第 1 层：Interaction / Policy Plane

负责：

1. inbound normalization
2. intent judge
3. route decision
4. model profile selection
5. fast ACK

### 第 2 层：Execution / Workflow Plane

负责：

1. native task/flow materialization
2. worker brief generation
3. backend assignment
4. progress / artifact / result ingestion
5. recovery / resume / delivery

### 第 3 层：Evaluation / Learning Plane

负责：

1. acceptance
2. replay
3. drift detection
4. future model tuning

注意：

1. 第 1 层必须很薄。
2. 第 2 层必须是状态机和 contract 的家。
3. 第 3 层不能再参与 live truth。

### 9.1.0.a 数据平面也要分层

除了职责分层，v1 还应该明确区分 4 类数据平面。

不然系统很容易重新滑回“每份 JSON 看起来都像真相”的老问题。

#### A. Truth Plane

唯一执行真相：

1. OpenClaw native `task/flow`
2. substrate event stream
3. SQLite registry / state

#### B. Projection Plane

供展示和策略消费的派生视图：

1. status/details/queue/timeline view model
2. delivery projection
3. policy metadata
4. artifact index

Projection 可以重建、可以修复，但不是执行真相。

#### C. Artifact Plane

供 agent 交接、review、replay 使用的任务工件：

1. `TaskPacket`
2. worker brief
3. checkpoint packet
4. result packet
5. acceptance packet

Artifact 是结构化 handoff，不是 live truth。

#### D. Telemetry Plane

供优化和门禁使用的测量数据：

1. request/task/flow telemetry
2. baseline reports
3. replay metrics
4. gate outcomes

Telemetry 只能影响未来调优，不能反过来篡改当前执行真相。

一句话：

> **truth 负责“现在到底发生了什么”，projection 负责“怎么给人看”，artifact 负责“怎么交接”，telemetry 负责“以后怎么优化”。**

### 9.1.0.b 要借 brain / hands / session，但不要照搬外部运行时

Anthropic 在 Managed Agents 里最核心的接口拆法，其实可以压缩成 3 个词：

1. `brain`
2. `hands`
3. `session`

对 OctoClaw 来说，这 3 个概念是值得借的，但要映射成我们自己的骨架：

#### A. `brain`

对应 OctoClaw 里的：

1. policy plane
2. orchestration layer
3. model calls
4. judge / advisor / coordinator logic

也就是“谁负责想、谁负责决定下一步”。

#### B. `hands`

对应 OctoClaw 里的：

1. sandbox / tool runtime
2. backend adapters
3. OpenClaw native task/flow execution
4. 可选的 worktree / shell / MCP / provider tool surface

也就是“谁负责实际动手”。

#### C. `session`

对应 OctoClaw 里的：

1. thread event stream
2. task/flow truth
3. recoverable event log
4. summaries / checkpoints / handoff history

也就是“长流程上下文和可恢复记录放在哪里”。

这里最重要的架构约束是：

1. `brain` 不能和 `hands` 焊死
2. `brain` 不能和 `session` 焊死
3. `hands` 可以替换，但不篡改执行真相
4. `session` 是可恢复的 durable context，不等于模型上下文窗口

所以我们真正该借的是：

> **thinking、acting、history 三者解耦。**

而不是照搬 Anthropic 的托管式实现。

### 9.1.0.c 这对 OctoClaw v1/v2 的直接含义

1. v1 就应该把 `thread/session` 当成正式对象设计好
2. v1 就应该把 backend/tool/sandbox 当成可替换的 `hands`
3. v1 就应该让 orchestration + model calls 站在 `brain` 一侧
4. 但 v1 不需要实现“many brains / many hands”的全部运行时复杂度
5. v1 就应该把 `thread summary / checkpoint summary / active context budget` 当成正式 contract，避免主模型上下文污染重新长出来
6. v1 就应该把 gateway/IM continuity 设计成 `surface anchor -> thread/session binding`，而不是让每个 adapter 自己维护一套会话逻辑

换句话说：

1. **接口要先对**
2. **实现先从最小单 worker 开始**
3. **advisor 先只保留 contract，不提前抢主链范围**
4. **threaded subagents 先只按 one-level skeleton 设计**

### 9.1.1 v1 Orchestration Layer 的实现口径

这里需要明确一个很容易误解的问题：

> **OctoClaw v1 需要 orchestrator 这层职责，但不需要先做成一个独立常驻守护进程。**

原因是：

1. 当前系统真正缺的是“谁对调度负责”的清晰边界
2. 不是“再多一个后台进程”
3. 如果一上来就做独立 daemon，很容易重新引入第二套状态、第二套通信和第二套故障点

这里的重点不是“做两个 orchestrator”，而是：

> **做一个 orchestration layer，并把它分成两个主作用域和一个补偿子域。**

也就是说：

1. 不是两个独立系统
2. 不是两套状态真相
3. 不是两个 daemon
4. 而是同一个 orchestration layer 里的两个主入口和一个补偿子域

更准确的实现方式应该是三层：

#### A. Ingress Orchestration（原 Request Orchestrator）

按请求触发、短命执行。

负责：

1. 读取最小 thread/session facts
2. 跑 `hard-boundary gate + judge_fast`
3. 做 `reply / delegate` 判断
4. 发送 ACK
5. 如果需要委派，则 materialize native task/flow

它不是常驻 worker，而是 request-scoped orchestration。
它的职责是 `decide + materialize`。

#### B. Workflow Orchestration（原 Workflow Orchestrator）

围绕 native task/flow 与 runtime events 持续推进。

负责：

1. 接收 checkpoint / result / artifact
2. 更新 workflow state
3. 推进 delivery / resume / recovery
4. 驱动 `status / details / queue / timeline`

它更像 runtime core + plugin handler 的组合，不是另起一个“永远跑着的大脑”。
它的职责是 `advance + recover + deliver`。

#### C. Reconcile / Recovery（Orchestration 内的补偿子域）

它属于 orchestration layer，只是不走正常主链，而是负责异常补偿和最终一致性。

负责：

1. 扫 stale task/flow
2. 补 delivery
3. 做 reconcile / repair
4. 清理 projection / mirror

它的运行入口可以是：

1. one-shot command
2. cron job
3. opt-in daemon

但它在架构上不是第二套系统，也不能成为系统主调度前提。

### 9.1.1.a 为什么不是“两个 orchestrator”

这里再明确一次，避免后面实现时误读：

1. `Ingress Orchestration` 处理“新消息该怎么办”
2. `Workflow Orchestration` 处理“已开始的 task/flow 后续怎么推进到交付”

它们的区别是作用域不同，不是系统边界不同。

因此：

1. 可以放在同一个 `packages/octoclaw-runtime-core`
2. 可以共享同一套 contracts / state / telemetry
3. `reconcile/recovery` 也可以落在同一个 orchestration module tree
4. 可以共用同一个 native task/flow truth
5. 不需要拆成两个服务
6. 不需要拆成两个产品

如果硬把它们揉成一个概念，最后很容易重新回到 `route / dispatch / delivery / status` 全缠在一起的旧问题。

### 9.1.2 为什么一开始没这么做

这不是“以前想错了”，而更像是系统演进阶段不同。

我认为主要有 4 个原因：

1. 一开始目标更偏“先跑起来”
   老版本更看重快响应、能派活，先用 LLM + 少量脚本把功能顶起来是最快路线。
2. 当时复杂度还没完全暴露
   delivery、checkpoint、recovery、IM surface、feedback loop、telemetry 这些后来才把“隐形 orchestrator”问题放大。
3. OpenClaw 原生 substrate 当时没有现在这么适合直接收敛
   尤其 create path、runtime seam、plugin-first 心智，是后来才逐渐清楚的。
4. 早期缺的不是 orchestrator 概念，而是明确 ownership
   其实当时已经存在一个“分散在 route/dispatch/patrol/delivery/status 里的隐形 orchestrator”，只是没有被显式定义。

所以这次重构真正要补的不是“一个 daemon”，而是：

> **把原来分散、隐形、多人共享的 orchestrator 职责，收成一个明确的 runtime core 角色。**

### 9.1.3 v1 的最终判断

因此，v1 我建议明确写死：

1. 不引入独立 orchestrator daemon 作为架构前提
2. orchestration layer 实现主要落在 `packages/octoclaw-runtime-core`
3. `Ingress Orchestration` 和 `Workflow Orchestration` 是同一层里的两个作用域
4. OpenClaw native task/flow 是执行真相
5. `extensions/octoclaw-runtime` 负责接 runtime/plugin seam
6. `reconcile/recovery` 作为 orchestration layer 内的补偿子域实现
7. 它可以暴露 optional worker 入口，但不做主调度

一句话：

> **v1 需要 orchestrator layer，不需要 orchestrator daemon。**

### 9.1.4 失败与超时如何及时发现

这里还要补一个系统性问题：

> **不做独立 orchestrator daemon，不等于不做 failure / timeout detection。**

真正应该设计的是一套分层检测机制，而不是把“发现异常”全部寄托给一个常驻大进程。

我建议 v1 至少同时具备这 4 类信号：

1. **native task/flow terminal state**
   如果 OpenClaw 原生 task/flow 已经进入 `failed / cancelled / completed`，这是第一优先级真相。
2. **checkpoint / heartbeat 断流**
   一段时间没有 checkpoint、heartbeat、progress event，就判定为 `stale` 候选。
3. **delivery 未闭环**
   task 已完成，但 `delivery_pending` 长时间未结束，说明交付链路出了问题。
4. **backend/runtime error**
   worker exit code、provider error、runtime exception、materialization failure 都必须进入统一 failure code。

### 9.1.5 v1 的 timeout 不是一个值，而是一组 deadline

很多系统会犯一个错误：只配一个总超时。

但 OctoClaw 更合理的做法是按生命周期拆 deadline：

1. `queue_deadline`
   任务物化后多久还没开始执行，算排队超时。
2. `start_deadline`
   该启动时还没启动。
3. `progress_deadline`
   多久没有 checkpoint / progress / heartbeat。
4. `runtime_deadline`
   总执行时长超限。
5. `delivery_deadline`
   结果应该回传但迟迟没有交付。

这样才能区分：

1. 是卡在排队
2. 是没真正启动
3. 是执行中失联
4. 是做完了但没送回来

### 9.1.6 没有 daemon 时，谁来做检测

我建议三层并存：

#### A. Event-driven checks

每次 request handler、workflow handler、task/flow event 进来时，都顺手检查相关 deadline。

这是主链内检测。

#### B. Read-time reconcile

用户查看 `status / details / queue / timeline` 时，允许做轻量 reconcile-on-read。

这能保证即使没有后台件，用户一问状态也能看到最新判断。

#### C. Optional reconcile worker

允许存在一个很轻的后台扫描器，周期性检查：

1. stale task/flow
2. delivery pending
3. missing checkpoints
4. 超时未闭环任务

它可以是：

1. one-shot command
2. cron
3. opt-in daemon

但它是**时效性增强件**，不是**正确性前提件**。

### 9.1.7 从开源借鉴里应该学什么

更详细的源码级借鉴收口，见：

- [octoclaw-native-taskflow-and-agent-runtime-borrowings-2026-04-20.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/octoclaw-native-taskflow-and-agent-runtime-borrowings-2026-04-20.md)

#### ClawTeam

ClawTeam 的长处在于：

1. team/task board
2. dependency chains
3. inbox messaging
4. git worktree isolation
5. tmux dashboards / live monitoring

它适合“很多并行 worker + 强人工观测”的场景。

对 OctoClaw 的借鉴点是：

1. 多 agent 时的 board / dependency / inbox 心智
2. worktree 隔离避免文件冲突
3. tmux 作为 operator workbench 的价值

但不适合直接搬来的点是：

1. 把 tmux 当系统前提
2. 把 swarm runtime 当默认主链
3. 让外部 runtime 反过来主导 policy truth

#### DeerFlow

DeerFlow 的长处在于：

1. Coordinator / Planner / Reporter 角色清楚
2. workflow graph 显式
3. checkpoint persistence 明确
4. state 可回放、可调试

它适合重型 research / graph workflow。

对 OctoClaw 的借鉴点是：

1. 显式 checkpoint
2. 显式 workflow state
3. replay/debug 友好的执行图

但不适合直接搬来的点是：

1. 一上来就上重 workflow engine
2. 让所有请求都进入 planner
3. 把 v1 核心路径做得过重

#### OMO / Oh My OpenAgent

OMO 值得借的是：

1. background tasks concurrency
2. `staleTimeoutMs`
3. lifecycle hooks
4. delegate retry / background notification 这种轻量运行护栏

这对 OctoClaw 的启发很直接：

1. 我们也应该有 stale timeout
2. 我们也应该有 delegate retry hook
3. 我们也应该把后台补偿件做轻，而不是做成总控大脑

### 9.1.8 最终结论

所以系统性答案是：

1. **需要 orchestrator layer**
2. **需要 failure/timeout detection**
3. **需要可选轻量后台 reconcile worker**
4. **但不需要先做一个独立 orchestrator daemon**

一句话：

> **正确做法不是“一个大守护进程盯一切”，而是“native truth + deadline metadata + event-driven checks + optional reconcile worker”。**

### 9.1.9 还建议再补强的 6 个架构骨架

在当前 v1 设计上，我认为还有 6 个值得尽早写死的结构性约束。

它们不是换方向，而是避免后面重新长出稳定性债。

#### A. 幂等键 + delivery outbox

现在文档已经有 task/flow truth、delivery state、projection 的区分，但还应该更明确：

1. ingress 请求要有 `request_idempotency_key`
2. task materialization 要有 `task_spec_hash` / `task_idempotency_key`
3. IM/update/final delivery 要有 `delivery_receipt_id`
4. delivery 走 outbox，再由 adapter 发出并确认回执

这样做的原因是：

1. request retry 不会重复创建 task
2. recover/reconcile 不会重复发 final delivery
3. webhook / event retry 不会制造幽灵重复消息

一句话：

> **重试应该是幂等重放，不是重复副作用。**

#### B. task claim / lease / ownership

v1 已经写了 heartbeat 和 deadline，但还应该再加一层更明确的“谁在跑这个任务”语义。

建议每个 delegated task 至少有：

1. `claim_owner`
2. `claim_token`
3. `lease_expires_at`
4. `last_heartbeat_at`
5. `resume_generation`

worker 只有拿到有效 claim 才能继续推进任务。

lease 续约则跟 checkpoint / heartbeat 绑定。

这样可以避免：

1. retry 和原 worker 同时写
2. reconcile 误把正在执行的任务重新拉起
3. backend 切换时出现双执行

一句话：

> **deadline 负责判断“是不是卡住了”，claim/lease 负责判断“现在到底是谁拥有执行权”。**

#### C. admission control / queue budget / backpressure

当前设计已经有 profile、cost、latency、worker 上限，但还值得明确成 admission control。

建议至少同时限制：

1. lane 级并发
2. provider / model 级并发
3. thread/session 级并发
4. write-scope 级串行约束

也就是说，不是“能 delegate 就立刻派”，而是：

1. 先 admission check
2. 再 decide enqueue / defer / reject / downgrade

这点很值得借鉴：

1. GSD 的 wave execution 和文件冲突顺序化
2. OMO 的 background concurrency / stale timeout 心智

一句话：

> **调度不是只有 route，还要有背压。**

#### D. write scope / workspace mode / conflict policy

你之前很担心文件冲突，这块我认为应该正式升成 contract，而不是运行时临场猜。

建议 delegated task 默认带上：

1. `read_scope`
2. `write_scope`
3. `workspace_mode`

其中 `workspace_mode` 至少区分：

1. `read_only`
2. `shared_workspace`
3. `isolated_worktree`

冲突策略建议写死：

1. `read_only` 可并发
2. `shared_workspace` 的 overlapping write 默认串行
3. `isolated_worktree` 可并发，但需要后续 merge/review

这块最值得借鉴的是 ClawTeam 的 git worktree isolation。

一句话：

> **文件冲突不该靠模型“感觉一下”，而要靠 write-scope contract。**

#### E. capability registry / route guard

现在 model profile 已经固定了，但还建议加一层 capability registry。

route 不该只知道“哪个模型便宜、哪个模型贵”，还应该知道：

1. 是否支持稳定 schema 输出
2. 是否适合 judge / observe / code / review
3. 是否支持需要的工具类型
4. 是否允许高风险写操作
5. 是否允许长任务 / 流式交付 / checkpoint

这样 policy 在 route 时就能做 hard guard：

1. judge lane 不能落到 schema 不稳的模型
2. review lane 不能落到能力不够的 profile
3. 某 backend 不支持当前 task contract 时，不进入 live path

一句话：

> **route 选的不是“模型名”，而是“满足 contract 的能力槽位”。**

#### F. versioned handoff packet + acceptance contract

当前 brief / artifact / delivery 已经设计得不错，但我建议再把 handoff 更明确成 versioned packet。

建议每次 delegate 默认产出一个 `TaskPacket`，至少包含：

1. `goal`
2. `constraints`
3. `expected_output`
4. `acceptance_criteria`
5. `artifact_refs`
6. `read_scope`
7. `write_scope`
8. `delivery_contract`

这样做的好处是：

1. 主模型和 worker 都保持最小上下文
2. 后续 replay/debug 更稳
3. review/eval lane 能直接消费 acceptance contract
4. 后面引入 fresh-context execution 更容易

这块值得借鉴：

1. Anthropic 对 structured handoff artifact 和逐步简化 harness 的思路
2. GSD 的 fresh context per plan / verify against goals

一句话：

> **handoff 不该只是“再写一段 prompt”，而应该是类型化任务包。**

### 9.1.10 我对优先级的建议

这 6 条里，我建议优先级这样排：

#### 必须进入 v1 / Phase 1-2 的

1. 幂等键 + delivery outbox
2. task claim / lease / ownership
3. admission control / backpressure
4. write scope / conflict policy

#### 最好在 v1 结构上预留，但实现可稍后补强的

1. capability registry / route guard
2. versioned handoff packet + acceptance contract

因为前 4 条更直接决定：

1. 会不会重复派活
2. 会不会双执行
3. 会不会一拥而上把系统拖死
4. 会不会在多任务时把工作区写乱

## 9.2 请求主路径

建议主路径：

1. receive inbound message
2. resolve `surface_anchor -> thread/session` 绑定
3. load minimal thread/session facts
4. fast judge:
   - `reply`
   - `delegate`
5. if `delegate`:
   - send ACK immediately
   - materialize native task/flow
   - enqueue worker
6. emit initial event
7. workflow plane 接管

这里再明确一次：

1. `delegate.compound` 不属于 Phase 1 live path
2. Phase 1 judge 顶层只做 `reply / delegate`
3. compound judge 只作为 Phase 3 以后的扩展位保留

### 9.2.0 refined v1 route model：顶层只保留 `reply | delegate`

这一轮设计收口后，我建议把 v1 顶层 semantic route 正式收成：

1. `reply`
2. `delegate`

这里有两个容易混淆的点，建议明确写死：

1. `clarify` 不是顶层 route，而是 `reply` 的一种处理模式
2. `observe` 也不再作为顶层 route，而是降成：
   - `reply` 下的 system-state-assisted answer
   - 或 `delegate(role=observer, coordination_mode=solo_worker)`

这样做的原因是：

1. 更符合 OpenClaw 的现实产品形态
   - 前台总有一个主 agent / main thread 在接住用户
   - 主 agent 最自然只需要理解两件事：
     - 我自己回
     - 我派一个子 agent 去做
2. 更符合当前重构目标
   - 主 agent 要快回复
   - 主 agent 要尽量少调工具
   - 主 agent 要尽量少背执行上下文和调度心智
3. 避免把执行细节错误提升为 semantic route
   - “先查状态再答”更像 `reply` 的一种实现方式
   - “真的去探测/读环境/跑 probe”更像 `delegate(role=observer, coordination_mode=solo_worker)`

因此，v1 的推荐解释是：

1. `reply`
   - 主链可以现在回答
   - 或主链现在应该先补问
   - 或系统已有 truth/state 可快速读取并组织回答
2. `delegate`
   - 需要创建一个新的执行工作单元
   - 由单个 child worker / subagent 承担

#### 9.2.0.a `reply` 的内部模式

`reply` 不是单一输出动作，它至少应支持：

1. `reply_mode = answer`
   - 当前信息已足够，主链可以直接回答
2. `reply_mode = clarify`
   - 当前信息不足，最合理下一步是补问用户

更准确地说：

1. `clarify` 不是新的 route
2. `clarify` 是 `reply` 的一种 mode
3. 这能让 main agent 的心智更轻，因为它只需要理解“我来回复”，而不是再背第三类顶层 route

#### 9.2.0.b `observe` 在新设计中的位置

v1 里仍然保留“观察/探测”能力，但不建议再暴露成顶层 route。

更合理的是拆成两种落点：

1. **已有系统事实可直接读取**
   - 例如 task/flow 状态、已有 result、已有 summary、已有 artifact refs
   - 这时仍走 `reply`
   - 系统先读取 truth/state，主 agent 只负责快速包装回复
2. **需要真实 probe / inspect / environment check**
   - 例如查本机环境、查日志、跑轻量命令、做真实探测
   - 这时走 `delegate(role=observer, coordination_mode=solo_worker)`

这条很关键，因为它把：

1. “是否是观察型工作”
2. “由谁执行”

拆成了两个层级的问题，不再混在一个顶层 route 名字里。

#### 9.2.0.c canonical 决策栈（refined）

为了避免以后又把 `route / reply_mode / role / backend / model` 搅在一起，我建议把 live path 的决策顺序更新成：

1. `route`
   - `reply`
   - `delegate`
2. `reply_mode`
   - `answer`
   - `clarify`
3. `delegate_role`
   - `observer`
   - `default`
   - `code`
   - `research`
   - `review`
4. `coordination_mode`
   - `solo_worker`
   - `advisor_assisted`
   - `threaded_subagents`
   - `compound`
5. `backend`
   - `openclaw-native`
   - `clawteam`（未来可选）
   - `legacy-python`（迁移期）
6. `workspace_mode`
   - `read_only`
   - `shared_workspace`
   - `isolated_worktree`
7. `model_profile`
   - `local_judge`
   - `remote_judge`
   - `direct_main`
   - `worker_default`
   - `worker_code_normal`
   - `worker_code_deep`
   - `worker_review`
   - `worker_deep`

一句话：

1. 先判断主链自己回还是派出去
2. 如果自己回，再判断是 `answer` 还是 `clarify`
3. 如果派出去，再判断 `delegate_role`
4. 再落 coordination / backend / workspace / model

#### 9.2.0.d 为什么不把 `single / multi` 放在顶层 route

如果未来一定会上 multi-agent，我更建议顶层 route 只保留：

1. `reply`
2. `delegate`

而把 “single / multi / advisor” 下沉到 `coordination_mode`。

理由是：

1. `single` / `multi` 更像**如何委派**
2. 不是**是否委派**

所以更稳的组合是：

1. `route = reply | delegate`
2. `coordination_mode = solo_worker | advisor_assisted | multi_agent_controlled`

这意味着：

1. v1 默认只实现 `route=delegate + coordination_mode=solo_worker`
2. v2/v3 以后如果要上 multi-agent，不需要再推翻顶层 route，只要扩 `coordination_mode`

一句话：

> **顶层回答“回还是派”，下层再回答“怎么派”。**

#### 9.2.0.e future multi-agent 应如何扩展

如果后面要支持多 agent，我建议完全建立在 `route = delegate` 之上扩展，而不是再新增一个顶层 route。

更稳的形态是：

1. `route = delegate`
2. `coordination_mode = solo_worker | advisor_assisted | multi_agent_controlled`

其中：

1. `solo_worker`
   - v1 默认唯一 live path
   - 等价于今天常说的“single delegate”
2. `advisor_assisted`
   - 仍是一个主 worker 执行
   - 中途可 consult advisor
   - 但不是多 child worker 编排
3. `multi_agent_controlled`
   - 一个 coordinator 负责编排多个 child worker
   - child worker 有明确 role / scope / dependency / budget
   - 只做受控 one-level hierarchy，不做自由 swarm

##### 9.2.0.e.1 multi-agent 的最小实现骨架

future `multi_agent_controlled` 建议最少包含：

1. 一个 parent flow
2. 一个 coordinator task
3. 多个 child task
4. `depends_on` 图
5. child thread / inbox / handoff summary
6. scheduler 级的并发与冲突控制

换句话说，多 agent 不应该是：

1. 主 agent 随手起几个子 agent
2. 子 agent 再自由套娃 delegate
3. 谁都能改路由、谁都能抢 authority

而应该是：

1. judge 只给出 `coordination_mode_hint`
2. planner / scheduler 把它物化成 parent-child graph
3. child worker 只执行各自的 bounded brief

##### 9.2.0.e.2 并行还是排队由谁判

future multi-agent 里，并行/排队不应交给主 agent，也不应交给 judge 直接拍板。

更合理的是由 scheduler 根据这些结构化信号决定：

1. `depends_on`
2. `read_scope`
3. `write_scope`
4. `workspace_mode`
5. `cost_budget`
6. `max_parallelism`
7. `queue_pressure`
8. `runner/backend availability`

因此：

1. judge 负责“像不像需要 multi-agent”
2. scheduler 负责“怎么排、能不能并行、何时必须排队”

这里还要再补一个关键收口：

> **不能把并行/排队完全写死成纯规则，也不能把它完全放给模型自由决定。**

更合理的是三段式：

1. judge 先输出：
   - `coordination_mode_hint`
   - `parallelism_hint`
   - `dependency_hint`
   - `confidence`
2. scheduler 再结合结构化现实信号收口：
   - `depends_on`
   - `write_scope`
   - `workspace_mode`
   - `cost_budget`
   - `queue_pressure`
3. 最终物化成：
   - 并行 child tasks
   - 串行 child tasks
   - 或回退到 `solo_worker`

也就是说：

1. 模型能力要用来判断“这活像不像值得拆”
2. 但真正的并行许可仍由 scheduler 根据依赖、冲突、预算来定

##### 9.2.0.e.2.a 相关开源项目给出的启发

从公开实现看，这条路其实比较一致：

1. **ClawTeam-OpenClaw**
   - 强调 `--blocked-by` 依赖链、auto-unblock、task wait、spawn retry/backoff、idempotency keys、worktree isolation
   - 启发是：**并行来自显式依赖图和隔离，不来自模型自由 swarm**
2. **open-multi-agent**
   - 强调 coordinator 先分解成 task DAG，再让独立任务并行，并把失败级联给依赖任务
   - 启发是：**模型负责 decomposition，runtime 负责 DAG 执行与 failure cascade**
3. **GSD / Get Shit Done**
   - 虽然更偏 spec/context framework，但核心启发是 phase / plan / validate / revise 的收口，不让 agent 无边界自循环
   - 启发是：**重试与修订也应该有阶段边界和 gate，不应无限自由再试**

因此我建议 OctoClaw 的 multi-agent 也保持这个原则：

1. 让模型参与“值不值得拆”“大致怎么拆”
2. 让 scheduler 决定“能不能并行”“何时阻塞”“何时回退”
3. 不做纯规则，也不做纯黑箱

##### 9.2.0.e.3 v1 到 multi-agent 的演进路线

我建议路线固定成：

1. Phase 1-2
   - `route = delegate`
   - `coordination_mode = solo_worker`
2. Phase 3
   - 保留 `advisor_assisted`
   - 灰度 `multi_agent_controlled`
3. Phase 4
   - richer board / cockpit / scheduler telemetry
   - 更完整的 auto-router / cost optimizer

这样后面就不会出现：

1. 为了 future multi 先把顶层 route 做复杂
2. 或者 future multi 上线时又要推翻 `reply / delegate` 主抽象

### 9.2.0.d canonical stack superseded

上面的 refined stack 已经替代这里更早的 `reply / observe / delegate.single` 版本。

v1 实作时应以新顺序为准：

1. `route = reply | delegate`
2. `reply_mode`
3. `delegate_role`
4. `coordination_mode`
5. `backend`
6. `workspace_mode`
7. `model_profile`

也就是说：

1. `observe` 不再单独占一个顶层 route 位
2. 原有 `observer_probe` 更适合作为 `delegate_role=observer` 之下的 role/profile 组合
3. 后续实现和测试都应以 refined stack 为 canonical 口径

### 9.2.0.b multi-agent-ready 骨架现在就要留

虽然 Phase 1 不做 compound / multi-agent live path，但骨架现在就要为它留接口。

不然以后很容易出现第二次返工。

我建议 v2 从一开始就把下面 4 个对象当成正式概念：

1. `flow`
   顶层父任务 / 父作业。
2. `task`
   可调度、可重试、可交付的执行单元。
3. `thread`
   一个 agent 的上下文隔离事件流。
4. `agent_instance`
   某次运行里的角色实例，绑定 role / toolset / model profile / workspace mode。

它们的关系建议固定成：

1. 一个 `flow` 下面可以有多个 `task`
2. 一个 `task` 默认对应一个主 `thread`
3. multi-agent 时，一个 coordinator `thread` 可以派生多个 child `thread`
4. 每个 `thread` 都要有自己的 summary / checkpoints / terminal state

这样做的好处是：

1. 现在 single delegate 不需要推翻
2. 以后加多 agent 只是把 `task -> thread` 从 1:1 放宽到 1:n
3. status surface、telemetry、recovery 都不会重做数据模型

### 9.2.0.c delegate 路径里未来会有 3 种协作形态

我建议 OctoClaw 从架构上默认支持这 3 种协作形态，只是分阶段开启：

1. `solo_worker`
   一个 worker 自己做完，这是 Phase 1 默认形态。
2. `advisor_assisted`
   一个 worker 负责执行，但可中途咨询更强 advisor。
3. `threaded_subagents`
   coordinator 把工作拆给多个上下文隔离的 child agent / thread。

这里最重要的一点是：

> **advisor-assisted 和 threaded-subagents 不是一回事。**

前者更像“一个执行者偶尔请教更强顾问”。
后者更像“一个协调者把工作分给多个执行者”。

### 9.2.0.d 什么时候该用 advisor，什么时候该用子 agent

建议写死判断原则：

#### 更适合 `advisor_assisted` 的场景

1. 还是同一个主任务、同一个 deliverable
2. 主要工作是机械执行，只有 plan / 纠偏 / final review 需要更强智能
3. 不需要额外工具权限
4. 不需要独立长时间运行的子任务

#### 更适合 `threaded_subagents` 的场景

1. 任务天然能拆成多个 well-scoped 子任务
2. 不同子任务需要不同 role / toolset / workspace mode
3. 需要并行推进来换时间
4. 需要隔离上下文，避免 coordinator 被细节污染

一句话：

> **“需要更强脑子”不等于“需要起子 agent”。**

### 9.2.0.e advisor 模式建议做成 provider-agnostic 接口

我建议现在就把 advisor 定义成 OctoClaw 自己的抽象，而不是 Anthropic 特供逻辑。

例如：

1. `consult_advisor(task_packet, checkpoint_summary) -> advice_packet`

这样未来可以有 2 种实现：

1. **native advisor tool**
   如果某 provider 原生支持 advisor，就直接用。
2. **emulated advisor thread**
   如果没有原生 advisor，就起一个 read-mostly 的 advisor thread / child agent 来模拟。

这条很关键，因为 OctoClaw 不会永远只跑在 Anthropic 单家能力上。

### 9.2.0.f advisor 的边界必须比子 agent 更严

为了控成本和避免复杂度失控，我建议 advisor 默认有更严的 contract：

1. advisor 不直接写文件
2. advisor 不直接交付给最终用户
3. advisor 不直接再 delegate
4. advisor 默认只返回 `advice_packet`
5. advisor 调用受 `max_uses`、预算桶、阶段 gating 约束

它更像：

1. 计划顾问
2. 路线纠偏器
3. 完成前审阅者

而不是另一个全功能 worker。

这里我想补一个非常重要的约束：

> **direct / delegate / observe 的判断，不能再回到“主模型自由发挥”那种模式。**

v2 应该采用：

1. **hard-boundary gate**
   只处理极窄、非语义型的硬边界：显式 control action、已存在 task/thread anchor、权限边界、危险写操作、恢复态会话。
2. **small judge model**
   负责绝大多数语义判断，包括 `reply vs delegate`、任务类别、复杂度带、上下文范围。
3. **policy code**
   把 latency target、budget cap、max workers、tool boundary、risk gate 收进代码。
4. **workflow harness**
   负责真正的物化、排队、冲突检查、重试和交付。

也就是说：

1. 是否 direct，不由主回答模型单独决定
2. 是否委派，不由 worker 自己申请
3. 是否排队，不由模型拍脑袋
4. 是否存在文件冲突，不由模型“猜”

这些都应该是 harness / scheduler / policy 的职责。

这里还要明确避免一个老问题：

> **hard-boundary gate 不是关键词路由器。**

它不应该再承担：

1. 用关键词猜用户是不是想委派
2. 用关键词猜复杂度高低
3. 用关键词猜该用什么模型
4. 用关键词猜是不是 code / research / review

这些语义判断默认都应交给 small judge。

所以 v1 顶层 `reply / delegate` 这类主语义路由，默认不是规则判，也不是主回答模型自由发挥判，而是：

1. **small judge model** 负责绝大多数语义判断
2. **hard-boundary gate** 只处理无需深语义也必须稳定成立的硬边界
3. **policy code** 负责把 judge 输出收口成可执行决策
4. **workflow/runtime harness** 负责真正物化、排队、冲突控制和交付

更直白地说：

1. 不是 `rule-first`
2. 不是 `main model decides all`
3. 而是 **`judge-first + hard-boundary + policy/harness enforcement`**

前门只保留这种“无需理解太多语义也应稳定成立”的信号：

1. 用户点了 `retry` / `stop` / `approve`
2. 当前消息明确绑定某个已有 task / anchor / thread
3. 当前会话正处于 waiting-input / recovery / approval-pending
4. 请求触达了明确的权限/写入/危险边界

所以更准确地说：

> **不是 rule-first，而是 judge-first；规则只保留在硬边界处。**

### 9.2.0.g hard-boundary gate 的允许范围与禁止范围

为了防止后面实现时又悄悄滑回关键词路由，这里建议把 `hard-boundary gate` 的边界写死。

#### 允许输入

`hard-boundary gate` 默认只允许读取**结构化信号**，例如：

1. UI action / command id
2. `task_id` / `thread_id` / `anchor_id`
3. session lifecycle state
4. permission / tool / write-scope / risk flags
5. queue state / lease state / backend availability

一句话：

> **gate 可以看结构化字段，但不应该读原始自然语言正文来猜意图。**

#### 允许职责

`hard-boundary gate` 只允许做下面这些事：

1. 识别显式 control action
2. 识别当前消息是否已绑定既有 task/thread
3. 识别当前会话是否处于 recovery / waiting-input / approval-pending
4. 识别是否触达明确权限/安全边界
5. 识别是否因 queue/backpressure/write conflict/backend down 必须改走排队或 blocked 路径

#### 明确禁止

`hard-boundary gate` 明确禁止做这些事：

1. 读取用户原文后，用关键词猜 `reply / delegate / observe`
2. 用词表猜复杂度高低
3. 用关键词猜 `code / research / review`
4. 用关键词猜该用哪个模型
5. 用 prompt pattern 或 regex 充当语义分类器

只要实现里出现“从自然语言文本里抽关键词，再决定主语义 route”，就已经违反设计。

#### 默认行为

如果没有命中明确硬信号，`hard-boundary gate` 的默认行为应该是：

1. `pass-through`
2. 把请求交给 `small judge model`
3. 再由 `policy code` 和 `workflow harness` 落地

也就是说，gate 的职责是：

1. **override / guard**
2. 不是 **semantic classify**

#### 关于误判

`hard-boundary gate` 当然仍可能有 bug，但它的误判应该被限制在：

1. 结构化状态映射错误
2. 生命周期状态判断错误
3. 权限/资源边界判断错误

而不应该退化成：

1. 语言理解误判
2. 关键词词表失控
3. prompt pattern 无限追加

这也是为什么我建议把它的输入面收窄到结构化信号。

一句话版：

> **hard-boundary gate 是硬边界守卫，不是语义路由器；没有硬信号就直接放行给 small judge。**

## 9.3 worker brief 规范

每个 worker 默认只拿：

1. task goal
2. constraints
3. expected output
4. relevant artifact refs
5. runtime limits
6. delivery contract

默认**不拿整段原始主会话**。

另外我建议把“上下文洁癖”进一步写成硬约束：

1. `judge_fast` 只读最小 route packet，不读整段 transcript
2. `direct_main` 默认只读当前请求 + thread summary + 必要 artifact refs
3. delegated worker 默认只读 `TaskPacket + checkpoint summary + artifact refs`
4. 只有在 acceptance/recovery 真的需要时，才回退到 transcript excerpt
5. 每条 lane 都应有明确 `active_context_budget`

如果必须引用历史上下文，也应该优先按这个顺序：

1. `task/thread summary`
2. `artifact refs`
3. `structured state`
4. 必要的 transcript excerpt

而不是反过来。

### 9.3.a delegated worker context：子 agent 如何拿到“合适而不是全部”的上下文

这里必须明确一个现实问题：

> **judge 判对了需要委派，不等于 child worker 就天然有足够上下文。**

子 agent 最常见的失败，不是模型笨，而是：

1. 没拿到足够的任务背景
2. 没拿到当前已经完成到哪一步
3. 不知道主线程已经问过什么、澄清过什么
4. 不知道当前到底在本地 scope、远端 scope，还是某个具体 task binding 下继续

因此 delegated worker 的输入，不能只是“一段自然语言 brief”，而应该是一个**最小但够用的 handoff packet**。

#### 9.3.a.1 v1 child worker 的最小 handoff 组成

我建议 delegated worker 默认至少拿：

1. `TaskPacket`
   - task goal
   - expected output
   - acceptance criteria
   - role
   - complexity
   - scope
2. `checkpoint_summary`
   - 到当前为止已经做了什么
   - 已知结论和中间结果是什么
   - 当前还缺什么
3. `artifact_refs`
   - 之前已经产出的结构化工件
   - 例如已有 analysis、已有 status snapshot、已有 file refs
4. `task/thread summary`
   - 简短背景
5. `delegate_reason_codes`
   - 为什么此时要委派，而不是主线程自己做
6. `runtime_limits`
   - budget、deadline、workspace/write-scope、tool allowance

也就是说：

1. child worker 不该默认吃整段主会话
2. 也不该只吃一句“帮我做 X”
3. 而应吃一个类型化 handoff packet

#### 9.3.a.2 child worker 默认不应该拿什么

默认不拿：

1. 全量 transcript
2. 全量工具输出
3. 全量 worker log
4. 所有历史 task 的原始详情

只有在这些场景才允许按需追加：

1. acceptance / recovery 明确失败，且判断为“关键信息缺失”
2. 当前任务明显依赖某段历史原文措辞
3. replay / debug 明确需要定位 handoff 丢失点

#### 9.3.a.3 child 如何知道主线程已经做到哪里

这里最关键的是：

> **child 不需要知道主线程“所有细节”，但必须知道主线程“当前阶段”。**

所以 handoff 至少应显式携带：

1. `current_stage`
   - 例如 `collecting_info / executing / waiting_input / reviewing`
2. `last_agent_act`
3. `pending_slots`
4. `open_decision`

这样 child 至少知道：

1. 现在是在接一个新执行
2. 还是在继续一个已有任务
3. 还是在接手一个已经失败/阻塞后的恢复尝试

### 9.3.b delegated failure taxonomy：子 agent 失败不是一类失败

如果不把 delegated failure 分类，后面 recovery 很容易退化成：

1. 一律重试
2. 一律换更强模型
3. 一律丢回 main agent

这三种都不对。

我建议 v1 至少把 delegated failure 正式分成这些类：

#### A. `infra_failure`

例如：

1. backend unavailable
2. tool invocation failed before real work started
3. workspace bootstrap failed
4. network / provider transient failure

这类问题通常不说明 route 判错，也不说明上下文不够。

#### B. `context_insufficient`

例如：

1. child 明确缺关键信息
2. handoff packet 缺必要背景
3. task binding / scope / target 不够明确
4. child 无法安全继续，但不是因为模型能力不足

这类问题说明：

1. 可能不是要换更强模型
2. 而是应该先补 handoff context 或补问用户

#### C. `model_capability_insufficient`

例如：

1. child 能看懂任务，但完成质量明显不够
2. role 对了，但当前模型档位太弱
3. 常见于 `simple -> normal`、`normal -> deep` 的升级边界

这类问题说明：

1. route 未必错
2. role 也未必错
3. 更像是该升 profile / 升模型重做

#### D. `route_or_role_mismatch`

例如：

1. 看起来根本不该 delegate
2. 本该是 `reply.clarify` 却过早委派
3. role 选成了 `observer`，其实需要 `code`
4. role 选成了 `research`，其实需要 `review`

这类问题说明：

1. 需要回到 orchestration 重新判
2. 而不是让当前 child 死撑

#### E. `needs_user_input`

例如：

1. child 发现缺 scope、缺 target、缺 language、缺 environment
2. 再做下去只能猜

这类问题的正确出口通常不是“继续重试 child”，而是：

1. 回主线程
2. 由 main agent 以 `reply_mode=clarify` 向用户补问

#### F. `deliverable_failed_validation`

例如：

1. child 产出了结果
2. 但 acceptance / validation / review 没过

这类问题说明：

1. 任务不是没做
2. 而是结果需要 revision、review、re-run 或 stronger model

### 9.3.c recovery ownership：失败后到底谁来决定下一步

最重要的约束是：

> **失败后下一步不应由 child 自己决定，也不应由 main agent 自己拍脑袋决定。**

更合理的是：

1. child 只上报结构化 failure packet
2. orchestration / recovery 根据 failure class 决定下一步
3. main agent 只负责用户面沟通和必要 clarify

#### 9.3.c.1 child failure packet 最小字段

建议 child 失败时至少回：

1. `failure_class`
2. `failure_reason`
3. `needs_more_context`
4. `suggested_role`
5. `suggested_complexity`
6. `retry_safe`
7. `checkpoint_summary`
8. `artifact_refs`

这样 recovery 才能判断：

1. 是原地重试
2. 是补上下文重试
3. 是换更强模型重做
4. 还是回 main agent 补问用户

### 9.3.d delegated retry policy：失败后是补上下文、升模型，还是回主线程

我建议 v1 明确写死下面这条 recovery policy：

#### 9.3.d.1 `infra_failure`

优先：

1. 同 role、同 profile 的短重试
2. 或重新 bootstrap 一个新 child instance

不优先：

1. 直接回 main agent
2. 直接升更强模型

#### 9.3.d.2 `context_insufficient`

优先：

1. 补充 handoff packet
2. 加强 `checkpoint_summary / artifact_refs / scope / binding`
3. 如仍缺用户输入，则回 main thread 走 `reply_mode=clarify`

不优先：

1. 不做“盲目换更强模型”

#### 9.3.d.3 `model_capability_insufficient`

优先：

1. role 不变
2. complexity/profile 升级
3. 用更强模型重新 materialize child attempt

例如：

1. `code.simple -> code.normal`
2. `code.normal -> code.deep`
3. `research.normal -> research.deep`

#### 9.3.d.4 `route_or_role_mismatch`

优先：

1. 回 orchestration 重新判 route / role
2. 如应回主线程，则 main agent 接管用户沟通
3. 如应换 role，则重新 materialize 新 child

#### 9.3.d.5 `needs_user_input`

优先：

1. 暂停 delegated attempt
2. main thread 发 clarify
3. 用户补齐后，再决定是 resume 原 child 还是新建 child

#### 9.3.d.6 `deliverable_failed_validation`

优先：

1. 如果只是质量不够，走 same-role stronger-profile retry
2. 如果是方向性错误，回 role/route adjudication
3. 如果需要用户选择，回 main thread clarify

### 9.3.e 何时回 main agent，何时不回

不是所有失败都该回 main agent。

更稳的规则是：

#### 应回 main agent

1. 需要用户输入
2. 需要 scope clarification
3. 需要解释为什么当前任务 blocked / partial
4. route 明显应该回到 `reply`

#### 不必回 main agent

1. 纯 infra retry
2. 同 role 下的 profile 升级重试
3. 纯 child replacement

也就是说，main agent 负责的是：

1. 用户沟通
2. clarify
3. blocked / partial / changed-plan 的对外说明

不是所有技术失败的内部调度器。

### 9.3.f main agent 怎么“知道发生了什么”而不被 child 细节淹没

这也是你刚问的关键点。

最稳的口径应该是：

> **main agent 不需要知道 child 的全部原始过程，但必须知道 child 的阶段性摘要、失败类型和下一步建议。**

所以 child 返回主线程时，建议只回：

1. `checkpoint_summary`
2. `failure_class`
3. `recovery_recommendation`
4. `artifact_refs`

而不是：

1. 全量日志
2. 全量工具输出
3. 全量中间推理

一句话：

1. child 向 orchestration 汇报原始结构化结果
2. orchestration 向 main agent 交付压缩后的 resume packet
3. main agent 再决定如何对用户说

### 9.3.g single delegate lifecycle：单 worker 也必须有完整状态机

这里要特别强调：

> **future multi-agent 不是状态设计的起点，single delegate 才是。**

即使 v1 只做 `route=delegate + coordination_mode=solo_worker`，也已经会遇到：

1. 同一线程里多次委派 child
2. child 中途失败、超时、恢复、换模型重做
3. 用户追问“到哪了”“为什么卡住”“是不是完成了”
4. IM / status surface 需要及时推送进度

如果这些在 single delegate 阶段没有设计好，后面 multi-agent 只会把问题放大。

#### 9.3.g.0 single delegate 必须显式绑定到 OpenClaw native task/flow

这里不能只停留在“OctoClaw 有 delegated task”这个产品层抽象上。

结合我们自己之前的借鉴文档和 OpenClaw native flow task 迁移结论，更稳的口径应该是：

> **OctoClaw 的 delegated task / attempt 是产品层与策略层对象，但执行真相必须绑定到 OpenClaw native task/flow。**

也就是说：

1. `delegate task`
   - 回答“这件用户可理解的委派工作是什么”
2. `delegate attempt`
   - 回答“这件委派工作当前第几次执行尝试”
3. `native task/flow`
   - 回答“OpenClaw runtime 里真正被创建、推进、终止的执行对象是什么”

这个分层，和我们在这些借鉴文档里的结论是一致的：

1. [octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md)
   - 已明确 `OpenClaw → OctoClaw policy → OpenClaw native flow_task → workers`
   - 并强调 richer event stream、ownership lock、session resume 在 flow task 之后要改成“消费原生 truth + OctoClaw 适配”
2. [octoclaw-review-and-action-plan-v1-2026-04-02.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-review-and-action-plan-v1-2026-04-02.md)
   - 已明确 `task-state.json` 不再是执行真相，而是策略元数据存储
   - 并明确 delegated event stream、ownership/recovery、session resume 的实现路径要改成 native flow task 优先
3. [octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md)
   - 强调 explicit event stream、artifact readiness、liveness truth、state distinct from transcript
   - 这正支持 delegated task 作为产品对象、native task 作为执行真相、timeline/status 作为投影

因此 v1 最稳的 contract 应该是：

1. 每个 `delegate task` 默认绑定一个 `native flow`
2. 在 `coordination_mode=solo_worker` 时，这个 flow 默认只包含一个主要 `native task`
3. 每次 `delegate attempt` 必须有：
   - `delegate_task_id`
   - `attempt_id`
   - `native_flow_id`
   - `native_task_id`（如适用）
   - `claim_owner`
   - `resume_generation`
4. 所有：
   - `running / failed / cancelled / completed`
   - checkpoint / result / artifact / delivery
   的执行真相，优先读 native task/flow substrate
5. OctoClaw 自己维护的是：
   - route / role / complexity / scope
   - delegate_reason_codes
   - attempt lineage
   - user-facing handoff / recovery / status projection

这样做的好处是：

1. 不会重造第二套 task 真相源
2. repeated retry / resume / timeout 能和 OpenClaw native state 对齐
3. 后面从 single delegate 升到 multi-agent 时，也只是把“一个 flow 下一个 task”扩成“一个 flow 下多个 child tasks”
4. IM/status/details/timeline 也能统一消费同一份 substrate-first truth

#### 9.3.g.1 v1 应把 delegated execution 拆成 `task` 和 `attempt`

建议至少区分：

1. `delegate task`
   - 表示“这次委派工作本身”
2. `delegate attempt`
   - 表示某一次具体执行尝试

这样一个 `delegate task` 下面可以有：

1. 第一次 child attempt
2. infra retry attempt
3. stronger-profile retry attempt
4. reroute 后的新 attempt

但对用户和主线程来说，它们仍然属于同一件委派工作。

这有两个直接好处：

1. 不会因为重试就把同一件事显示成很多互不相关的 task
2. status surface / recovery / telemetry 可以同时看到“任务级”和“尝试级”的真相

这里再往前一步写死：

1. `delegate task` 是 OctoClaw 产品对象
2. `delegate attempt` 是 OctoClaw 恢复/重试对象
3. `native flow/task` 是 OpenClaw substrate 对象

三者必须可追溯映射，而不是相互替代。

#### 9.3.g.1.a single delegate 与 native flow 的推荐绑定关系

v1 推荐默认采用：

1. `route=delegate`
2. `coordination_mode=solo_worker`
3. materialize 1 个 `native flow`
4. flow 下默认 1 个主 `native task`
5. 该 `native task` 对应当前活跃 `delegate attempt`

如果发生 retry / stronger-profile retry / reroute：

1. 可以替换为新的 attempt
2. 可以选择：
   - 在同一 `delegate task` 下追加新的 `native task`
   - 或在新的 `native flow` 上重建 attempt
3. 但无论哪种实现，用户面都应继续视为同一件 `delegate task`

这里实现上可以有不同策略，但 contract 应保持一致：

1. task 级 identity 稳定
2. attempt 级 identity 可变
3. native execution identity 以 substrate 为准

#### 9.3.g.1.b 哪些状态是 native truth，哪些是 OctoClaw projection

建议明确分层：

##### native truth

1. flow/task created
2. running / completed / failed / cancelled
3. checkpoint / heartbeat / progress
4. result / artifact emission
5. backend-level terminal reason

##### OctoClaw projection

1. `needs_recovery`
2. `waiting_resume`
3. `recovering`
4. `blocked_waiting_input`
5. `delivery_pending`
6. `superseded`
7. user-facing status copy
8. main-thread resume packet

这条边界非常重要：

> **native substrate 负责执行终态，OctoClaw 负责把执行终态翻译成用户可理解的恢复/交付状态。**

这和 DeerFlow 的 event/state/artifact 分离、ClawTeam 的 liveness truth 分离，以及 OpenClaw flow task 迁移文档里的方向是统一的。

#### 9.3.g.2 single delegate 的最小状态机

我建议 v1 至少把 delegated task 的状态正式收成：

1. `accepted`
2. `queued`
3. `starting`
4. `running`
5. `waiting_input`
6. `validating`
7. `delivery_pending`
8. `completed`
9. `failed`
10. `timed_out`
11. `needs_recovery`
12. `superseded`

这里：

1. `running` 只是“child 在跑”，不是“成功”
2. `completed` 必须是 deliverable / acceptance / delivery 已闭环
3. `failed` 与 `timed_out` 是 terminal attempt state，不一定是 terminal task state
4. `needs_recovery` 表示这件 delegated task 还没结束，只是下一步必须走 recovery
5. `superseded` 表示旧 attempt 已被新的恢复尝试替代

#### 9.3.g.3 delegated success 不能只看 child 退出码

这里也必须写死：

> **单 child 成功退出，不等于 delegated task 成功。**

我建议 delegated success 至少同时满足：

1. child attempt 进入成功终态
2. deliverable 通过最小 validation / acceptance
3. delivery 或 artifact handoff 已完成
4. 当前 delegate task 没有未解决的 blocked / waiting_input

也就是说：

1. `process exited 0` 只是 attempt 成功信号
2. task 真正成功，要看 acceptance + delivery 是否闭环

这点和 DeerFlow 的显式事件/中间状态思路一致，也和 Bernstein 这类“verification before landing”心智一致：**终态不应只看 worker 自报完成。**

#### 9.3.g.4 delegated progress 怎么及时推送

对于单 worker，用户最在意的其实不是“有没有多 agent”，而是：

1. 是不是开始了
2. 现在卡没卡
3. 有没有阶段性进展
4. 什么时候真的完成

所以我建议 delegated task 默认至少推这些事件：

1. `delegate.accepted`
2. `delegate.started`
3. `delegate.first_progress`
4. `delegate.checkpoint`
5. `delegate.blocked`
6. `delegate.recovering`
7. `delegate.deliverable_ready`
8. `delegate.completed`
9. `delegate.failed`
10. `delegate.timed_out`

并且这些事件要进入统一 timeline/status surface，而不是只留在 worker 私有日志里。

这样：

1. IM/status surface 能及时看到推进
2. read-time reconcile 能把最新状态读出来
3. recovery 也能基于同一份 progression truth 做判断

#### 9.3.g.5 谁负责把状态及时推到用户面

这里也不要混淆：

1. child 负责发 checkpoint / artifact / failure packet
2. orchestration 负责把它们转成统一 task/flow 事件
3. delivery / status surface 负责决定哪些事件需要推给用户、哪些只留 operator 面

也就是说：

1. child 不直接承担“对用户讲状态”的产品职责
2. main agent 也不需要自己轮询 child 原始日志
3. 真正的用户可见状态推送，应该建立在 runtime truth 之上

#### 9.3.g.6 单 worker 超时怎么判

前面已经定义了 `queue/start/progress/runtime/delivery` 五类 deadline，这里要再落到 single delegate 上。

对单 worker，最有价值的是：

1. `start_deadline`
   - 已接受但迟迟没真正启动
2. `progress_deadline`
   - 启动后长时间没有 heartbeat/checkpoint
3. `runtime_deadline`
   - 总执行明显超限
4. `delivery_deadline`
   - 已出结果但迟迟没回到主线程/用户面

而且 timeout 也不应直接等价于 task 失败。

更稳的做法是：

1. timeout 先把 attempt 送进 `timed_out`
2. task 进入 `needs_recovery`
3. recovery 再决定：
   - retry
   - stronger-profile retry
   - clarify
   - 或 terminal fail

#### 9.3.g.7 同一线程里多次 single delegate 怎么避免主线程越来越脏

建议原则是：

1. 每次 delegated task 都单独产出 `checkpoint_summary`
2. 主线程默认只保留：
   - 当前活跃 delegated task 摘要
   - 最近一个已完成 delegated task 的压缩结果
   - 必要 artifact refs
3. 更老的 delegated attempts 不直接回灌主线程 prompt，只保留在 timeline / artifact / replay 层

也就是说：

1. main agent 知道“发生过什么”
2. 但不需要背所有 child 过程细节
3. 这样 single delegate 多次发生时，主线程仍然保持干净

#### 9.3.g.8 从借鉴项目里对 single delegate 应学什么

结合现有借鉴项目，我建议 single delegate 先吸收这些心智：

1. **ClawTeam / ClawTeam-OpenClaw**
   - task lock、spawn retry/backoff、依赖阻塞、会话隔离
   - 启发是：**attempt 与 ownership 要明确，retry 要幂等**
2. **DeerFlow**
   - 中间事件、checkpoint、artifact-first progression
   - 启发是：**不要只看最终状态，要把中间推进做成正式 truth**
3. **open-multi-agent**
   - coordinator 先分 DAG，独立任务并行，失败对依赖任务级联
   - 启发是：**即使 future multi 由 DAG 驱动，single delegate 也应该先有 attempt lineage 与 failure cascade 心智**
4. **Bernstein**
   - deterministic scheduling、git worktree isolation、verification before landing
   - 启发是：**成功判定应包含验证，而不只是 worker 自报完成**
5. **OMO / Oh My OpenAgent**
   - background concurrency、`staleTimeoutMs`、provider/model concurrency gate、hook-based retry/notification
   - 启发是：**即使是 single delegate，也应显式建 stale timeout、background notification、provider/model 并发门禁**

一句话：

> **single delegate 的状态、超时、重试、resume 设计，本质上就是 future multi-agent 的最小子集。**

### 9.3.h 单 worker 重试后，到底回 main agent 还是继续后台恢复

这里再补一个更产品化的问题：

> **不是每次 child 失败都要把问题丢回 main agent；很多恢复应该在后台完成。**

我建议写死下面这条口径：

#### 应继续后台恢复

1. infra retry
2. same-role stronger-profile retry
3. same task 下补充 artifact / checkpoint 后的 resume

这些都应继续留在 delegated task 内完成，并通过状态事件向用户面表达“正在恢复”。

#### 应回 main agent

1. 用户必须补信息
2. scope / target 无法自动确定
3. 路由应回退到 `reply`
4. 需要主线程解释 changed plan / partial failure

这样主 agent 才不会变成所有 child 失败的兜底执行器。

#### 9.3.h.1 recovery 的用户面表达

用户面至少需要能区分：

1. `running`
2. `blocked_waiting_input`
3. `recovering`
4. `completed`
5. `failed`

这样即使后台发生 retry/换模型，用户看到的也是：

1. 任务还在继续
2. 当前是在恢复中
3. 还是确实已经失败，需要你介入

而不是：

1. 莫名其妙又新建一个 task
2. 或完全静默

这里还要再明确一点：

1. judge 不能被实现成“只看最后一句话的分类器”
2. 但也不应该直接吞整段原始会话
3. 更合理的是吃一个 **judge context packet**

这个 packet 在 continuation 场景下，至少应包含：

1. `current_turn`
2. `thread_summary`
3. `active_intent`
4. `last_agent_act`
5. `pending_slots`
6. `anchor/task binding`
7. 必要时附一个很短的 `recent_excerpt`

但为了真正可实现，我建议把它设计成一个分层 contract，而不是一串散字段。

#### judge context packet 分层设计

##### A. Core turn layer

这层是每次 judge 都必须有的最小输入：

1. `current_turn`
   - 当前用户这一次输入
   - 这是 judge 唯一必须看的原始自然语言
2. `turn_metadata`
   - 当前消息来源、channel、时间戳、是否编辑/补发
   - 作用是避免把重复消息、渠道差异、补发消息误判成新意图
3. `thread_summary`
   - 对当前 thread 到目前为止的压缩摘要
   - 作用是让 judge 知道“这段对话大体在干什么”

原因：

1. `current_turn` 决定这次新增了什么
2. `thread_summary` 决定这次输入放在什么大背景里理解
3. 这层解决的是“不是纯最后一句，也不是整段 transcript”这个基本矛盾

##### B. Continuation state layer

这层是减少误判最关键的一层，用来表达“当前会话还没完的事情”：

1. `active_intent`
   - 当前线程里正在进行的主意图
   - 例如 `write_script`、`debug_issue`、`status_check`
2. `intent_status`
   - 当前意图所处状态
   - 例如 `collecting_info`、`executing`、`waiting_input`、`delivering`
3. `last_agent_act`
   - 上一次系统明确做了什么
   - 例如“请求补齐语言/输入输出”“已开始执行 delegated task”“已给出初步结论”
4. `pending_slots`
   - 当前还缺哪些关键信息
   - 例如 `language/task/environment/output_format`
5. `open_question`
   - 上一轮 agent 明确向用户追问的问题

原因：

1. judge 真正常误判的，不是完全陌生的新句子
2. 而是 continuation / slot-filling / 接上文补充
3. 这层字段的作用，就是把“当前还没收尾的对话状态”显式交给 judge，而不是让模型自己从长对话里猜

##### C. Binding and control layer

这层告诉 judge：当前输入是不是已经挂在某个已有对象下，不该当新任务处理。

1. `anchor_or_task_binding`
   - 当前消息是否绑定到某个 task/thread/anchor
2. `surface_context`
   - 来自哪个 surface
   - 例如 `chat`, `details`, `queue`, `task_reply`
3. `lifecycle_flags`
   - 当前是否处于 `waiting_input`、`recovery`、`approval_pending`、`delivery_pending`

原因：

1. 很多误判本质上不是语义理解错，而是忽略了“这条消息其实已经在某个执行对象下面”
2. 这层字段能显著减少把回复 task、补充参数、approve/retry 误判成全新请求

##### D. Minimal evidence layer

这层是可选层，默认不带，只有 summary 和 state 不足时才补一点点原文证据。

1. `recent_excerpt`
   - 最近 1-3 轮最相关的原文摘录
   - 不是完整 transcript
2. `artifact_refs`
   - 若当前 turn 明显引用已有 artifact/task result，可带短引用

原因：

1. 有些边界 case，只靠 summary/state 还不够
2. 但直接把全量 transcript 喂进去会让上下文迅速变脏
3. 所以应该只补“最少证据”，不是回灌整段历史

#### judge context packet 的推荐 shape

更推荐把它组织成类似这样的结构：

```json
{
  "current_turn": "...",
  "turn_metadata": {
    "channel": "chat",
    "edited": false
  },
  "thread_summary": "...",
  "continuation_state": {
    "active_intent": "write_script",
    "intent_status": "collecting_info",
    "last_agent_act": "asked_for_language_and_io",
    "pending_slots": ["language", "task", "environment"],
    "open_question": "请补充语言、输入输出和运行环境"
  },
  "binding_state": {
    "anchor_or_task_binding": null,
    "surface_context": "chat",
    "lifecycle_flags": []
  },
  "recent_excerpt": [
    "帮我写个脚本",
    "Python吧 获取5个国家的时间"
  ]
}
```

#### 为什么要这么设计

核心原因有 5 个：

1. **防最后一句误判**
   continuation 场景不能只靠最后一句判断
2. **防全量 transcript 污染**
   judge 需要上下文，但不该背整段历史
3. **把 continuation 变成结构化状态问题**
   比起“模型猜上下文”，更稳的是“系统把未完成状态显式提供出来”
4. **降低 live judge 延迟**
   packet 结构小、字段固定，比长 prompt 更稳
5. **便于 harness 回放和校正**
   以后 replay 时可以直接回放同一个 packet，看 judge 到底哪一层信息不足

#### 构建原则

为了保证 judge packet 不会越长越脏，建议再写死 4 条构建原则：

1. summary first
   - 优先用 `thread_summary / continuation_state`
   - 不优先原始 transcript
2. state over prose
   - 能结构化表达的，就不要丢给 judge 自己读自然语言猜
3. excerpt last
   - 只有 summary/state 不足时，才补短 excerpt
4. bounded size
   - packet 必须有 token/field budget
   - 超预算先压缩，再裁剪，再丢 excerpt

例如像下面这种对话：

1. 用户先说“帮我写个脚本”
2. 系统追问语言/输入输出
3. 用户再说“Python吧 获取5个国家的时间”

如果 judge 只看最后一句，就很容易误判成一个新的碎片请求。  
而如果 judge packet 里带了：

1. 当前活跃意图是 `write_script`
2. 上一条 agent act 是“补齐脚本槽位”
3. `pending_slots.language/task` 尚未补齐

那么 judge 才能正确理解：

1. 这不是新任务
2. 这是在继续填写前一个未完成意图
3. `Python` 是 language slot
4. “获取 5 个国家的时间” 是 task intent

所以更准确的设计口径应该是：

1. 本地 judge 看的是**压缩的判定上下文**
2. 远端 judge 看的是**稍大一点但仍受预算约束的仲裁上下文**
3. 两者都不是“最后一句分类器”
4. 两者也都不是“全量 transcript 推理器”

另外，单 judge 方案下还应明确：

1. 不是每个 turn 都应该重新 judge
2. continuation / slot-filling / active task continuation 场景，应尽量复用已有 `active_intent + pending_slots + binding`
3. 只有出现真正的新意图、新 anchor、冲突状态或生命周期切换时，才值得重新触发完整 judge

这样做的核心目的不是“省一次模型调用”而已，而是：

1. 降低 live judge 总延迟
2. 降低误判率
3. 避免把补槽位对话反复当新任务分类
4. 更符合“快响应 + 低成本 + 稳定 continuation”目标

这也意味着：

1. 系统应该有 durable memory
2. 但 durable memory 不等于主 agent 或 judge 每次都要吃全部历史
3. 主 agent 默认知道“发生了什么”，应主要通过：
   - `thread summary`
   - `checkpoint summary`
   - `artifact refs`
   - `structured state snapshot`
4. 而不是通过回灌完整 transcript、完整 worker log、完整调度细节

因此更准确的口径是：

1. memory 主要属于 system-level context
2. `main_reply` 只消费经过压缩和裁剪后的 working context
3. 这样既能保留“知道做了哪些事”的能力，又能保持主 agent 上下文干净、首响快、token 低

### 9.3.a refined v1 judge architecture：本地小 judge + 远端仲裁 judge

基于当前目标，我建议把 v1 judge 正式设计成两层，但只有一层默认热路径 authority：

1. **local judge**
   - 默认使用本地小模型
   - 负责吃掉大多数便宜、快、稳定的 case
2. **remote adjudicator**
   - 默认不走常规热路径
   - 只在低置信度、高风险、强上下文歧义场景介入

这两层不是两个平级“自由大脑”，而是：

1. 本地 judge 做粗判
2. system validator/materializer 做硬约束收口
3. 远端 judge 只在必要时做仲裁

更具体地说：

1. v1 默认目标不是“两个 judge 都经常被调用”
2. 而是“本地 judge 尽量吃流量，远端 judge 只吃少量难例”

#### 9.3.a.1 local judge 的职责

local judge 负责输出结构化粗判结果：

1. `route = reply | delegate`
2. `reply_mode = answer | clarify | null`
3. `delegate_role = observer | default | code | research | review | null`
4. `coordination_mode_hint = solo_worker | advisor_assisted | multi_agent_controlled | null`
5. `complexity = simple | normal | deep | null`
6. `scope = local | remote | both | unknown`
7. `tool_need_hint = none | maybe | required`
8. `duration_hint = short | medium | long`
9. `confidence`
10. `reason_codes`

这里要强调两点：

1. `tool_need_hint` 和 `duration_hint` 只是**粗提示**
2. 它们不是 runtime 事实，不等于“工具一定要调”“一定会跑 90 秒”

local judge 回答的是：

> **“从当前上下文和语义上看，这更像是主链现在就能处理，还是更像需要创建新的执行工作单元；如果要委派，更像 single 还是 future multi。”**

#### 9.3.a.2 remote judge 的职责

remote judge 默认不是第二层常驻热路径，而是：

1. low-confidence escalation
2. high-risk adjudication
3. ambiguity resolution
4. replay / shadow / harness calibration

它更像：

1. 仲裁者
2. 复判器
3. 边界 case 稳定器

而不是：

1. 每个请求都要走的第二次默认调用
2. 主 agent 的隐藏替身

#### 9.3.a.3 v1 推荐模型映射

基于当前硬件和成本目标，我建议 v1 judge 层先固定成：

1. `local_judge` -> `Qwen3-0.6B`
2. `remote_judge` -> `omniroute/cx/gpt-5.4-mini`（关闭推理）

这套映射的含义是：

1. 本地小模型先负责大多数粗判
2. 远端 `gpt-5.4-mini` 只在本地 judge 不稳或高风险时接管
3. 这样既能压延迟和成本，又不把规则判断退回关键词表

如果后续 benchmark 证明 `Qwen3-1.7B` 在 continuation / slot-filling / active-intent continuation 上明显更稳，再把本地 primary judge 升到 `Qwen3-1.7B`。

#### 9.3.a.4 judge escalation 触发条件

只有满足下面之一时，才建议从本地 judge 升到远端 judge：

1. `confidence` 低
2. 当前 turn 极短且强依赖上下文
   - 例如“做吧”“继续”“那个也一起”
3. 当前 thread 存在多个活跃 intent / binding 冲突
4. `scope = unknown`，且不能安全双查或直接 clarify 收口
5. 涉及高风险写入、命令执行、环境探测
6. `delegate_role` 或 `complexity` 结果不稳
7. local judge 输出与 system validator 的硬约束收口差距过大

一句话：

> **远端 judge 只处理“本地 judge 不该硬猜”的 case。**

### 9.3.b small packet / expanded packet 双层上下文

为了让双层 judge 又快又稳，建议把 judge packet 正式分成两种：

#### 9.3.b.1 small packet（给本地 judge）

本地 judge 默认只吃：

1. `current_turn`
2. `thread_summary`
3. `active_intent`
4. `last_agent_act`
5. `pending_slots`
6. `open_decision`
7. `anchor_or_task_binding`
8. `scope_hint`
9. `recent_excerpt`

约束：

1. `thread_summary` 保持 1-3 句
2. `recent_excerpt` 最多 1-3 条
3. 不带长日志、不带大 artifact、不带全量 transcript

#### 9.3.b.2 expanded packet（给远端 judge）

远端 judge 可在 small packet 基础上额外看到：

1. `candidate_decision_from_local`
2. `escalation_reason`
3. `optional_task_snapshot`
4. `optional_system_state_summary`
5. 稍大一点但仍受预算限制的 `recent_excerpt`

这里仍然要写死：

1. 不允许回灌完整 transcript
2. 不允许回灌完整 worker log
3. 不允许把远端 judge 变成“看尽所有原始材料的第二个主 agent”

### 9.3.c canonical decision policy spec：judge 和 main agent 的同源规则

judge 和 main agent 不能各用一套“自己理解的规则”。

更稳的做法是：

1. 维护一份 canonical `decision policy spec`
2. judge 和 main agent 都消费这份 spec
3. 只是视图不同、authority 不同

这份 spec 至少要定义：

1. `route`
2. `reply_mode`
3. `delegate_role`
4. `complexity`
5. `scope`
6. `tool_need_hint`
7. `duration_hint`
8. `reason_codes`
9. objection protocol

#### 9.3.c.1 policy spec 的性质

它不是：

1. 关键词词表
2. regex 路由表
3. 一串 prompt 小抄

它应该是：

1. 闭集标签定义
2. 判定 rubric
3. 输出 schema
4. reason code contract

也就是说，它的作用不是替 judge 做语义理解，而是：

> **让 judge 和主 agent 按同一套制度办案。**

#### 9.3.c.2 最小 decision policy spec（v1）

建议 v1 至少固定下面这些标签：

1. `route`
   - `reply`
   - `delegate`
2. `reply_mode`
   - `answer`
   - `clarify`
3. `delegate_role`
   - `observer`
   - `default`
   - `code`
   - `research`
   - `review`
4. `coordination_mode_hint`
   - `solo_worker`
   - `advisor_assisted`
   - `multi_agent_controlled`
5. `complexity`
   - `simple`
   - `normal`
   - `deep`
6. `scope`
   - `local`
   - `remote`
   - `both`
   - `unknown`

#### 9.3.c.3 顶层判定 rubric（v1）

##### `reply`

满足下面条件时，应倾向 `reply`：

1. 不需要创建新的执行工作单元
2. 主链现在就能回答
3. 或当前最合理下一步是先补问
4. 不需要新的工作区访问、环境探测、命令执行、文件写入
5. 即使需要一点状态，也能靠现成 truth/summary/artifact refs 快速组织回复

##### `delegate`

满足下面条件时，应倾向 `delegate`：

1. 需要创建新的执行工作单元
2. 需要工作区访问、环境探测、命令执行、文件读写、日志读取、验证或较长处理过程
3. 任务值得从主 agent 上下文中剥离，用独立 child worker 完成
4. 任务适合用不同 role / model profile 来做成本和质量分层

##### `coordination_mode_hint`

满足下面条件时应倾向 `solo_worker`：

1. 一个 worker 就能完成
2. 没有明显可并行拆分的独立子任务
3. 子任务之间没有必要做依赖编排

满足下面条件时才应倾向 `multi_agent_controlled`：

1. 任务天然能拆成多个 well-scoped 子任务
2. 子任务之间的依赖关系可表达
3. 存在明显并行收益
4. write scope / workspace conflict 可被 scheduler 安全管理
5. 单 worker 会明显拖慢交付或污染上下文

v1 默认口径：

1. judge 可以保留 `multi_agent_controlled` 的 schema slot
2. 但 live path 只放行 `solo_worker`
3. `multi_agent_controlled` 先只进入 replay / shadow / future Phase 3

##### `reply_mode = clarify`

满足下面条件时，应倾向 `reply_mode = clarify`：

1. 当前信息不足，不能安全直接回答
2. 当前也不适合直接启动 delegated execution
3. 最合理下一步是让用户补 scope / target / slot

#### 9.3.c.4 AGENTS.md 与 policy spec 的职责分工

`AGENTS.md` 注入仍然值得保留，但职责必须收窄。

更准确的分工是：

1. `AGENTS.md`
   - 主 agent 行为宪法
   - 快回复原则
   - 上下文洁癖
   - objection protocol
   - 不允许 silent override
2. `decision policy spec`
   - judge 怎么判
   - route / mode / role / complexity / scope 的正式 contract
   - reason codes 和 escalation 标准

一句话：

> **`AGENTS.md` 管主 agent 怎么配合系统，policy spec 管 judge 和系统怎么判。**

#### 9.3.c.4.a 推荐的 `decision policy spec` 结构

建议不要把 policy spec 写成散落在 prompt 里的自然语言段落，而是正式收成结构化 contract。

最小 v1 可以长成这样：

```yaml
version: v1

route:
  labels:
    - reply
    - delegate.single

reply_mode:
  labels:
    - answer
    - clarify

delegate_role:
  labels:
    - observer
    - default
    - code
    - research
    - review

complexity:
  labels:
    - simple
    - normal
    - deep

scope:
  labels:
    - local
    - remote
    - both
    - unknown

tool_need_hint:
  labels:
    - none
    - maybe
    - required

duration_hint:
  labels:
    - short
    - medium
    - long
```

在这个结构上，再补：

1. label 定义
2. 顶层判定 rubric
3. escalation 条件
4. objection protocol
5. reason code contract

这样 judge、main agent、validator、replay harness 才能围绕同一份 contract 对齐。

#### 9.3.c.4.b 推荐的 `reason_codes`

为了让后续 replay / telemetry / objection 真正有解释力，建议 v1 至少固定这些 `reason_codes`：

1. `direct_generation`
2. `direct_explanation`
3. `insufficient_information`
4. `scope_unclear`
5. `target_unclear`
6. `context_hygiene`
7. `fast_first_response`
8. `background_execution`
9. `specialized_tools`
10. `workspace_required`
11. `verification_required`
12. `quality_isolation`
13. `high_risk_write`
14. `likely_long_running`

这些 reason code 的意义不是“说服模型”，而是：

1. 让 judge 的结果可解释
2. 让 main agent 的 objection 可复盘
3. 让 harness 能聚合出真正的混淆簇

#### 9.3.c.4.c 推荐的 `AGENTS.md` 宪法骨架

`AGENTS.md` 建议只保留主 agent 必须长期遵守的行为宪法，例如：

1. main agent 不是最终 route authority
2. fast first visible response 优先
3. 能直接回答就回答；信息不足就短 clarifying question
4. 默认不把长执行、工具探测、工作区操作吞进主线程
5. 收到 `delegate` 推荐时默认配合
6. 如果不同意，只能走 objection protocol，不能 silent override
7. 默认优先吃 summary / artifact refs / structured state，而不是长 transcript

也就是说，`AGENTS.md` 更像：

1. 主 agent constitution
2. main-thread discipline
3. objection protocol

而不是：

1. 语义路由表
2. 模型选择表
3. 工具调用 if/else 规则大全

#### 9.3.c.4.d 为什么两边一定要共用一份 spec

如果 judge 和 main agent 各自用一套隐式规则，后面一定会出现：

1. judge 觉得该委派
2. 主 agent 觉得自己能做
3. 两边都“有道理”
4. 但系统无法定位到底是：
   - judge 判歪了
   - 主 agent 误 objection
   - 还是 policy 边界本身写错了

因此更稳的口径应该是：

1. 一份 spec
2. 两种 view
3. judge 有 route recommendation authority
4. main agent 只有 objection 权，没有 silent override 权

#### 9.3.c.5 objection protocol

主 agent 如果不同意 judge 推荐，可以 objection，但不能 silent override。

建议协议至少包含：

1. `route_objection`
2. `requested_route`
3. `objection_reason`
4. `confidence`

这样 judge 和 main agent 即使发生分歧，也能在同一套规则框架里被 replay / telemetry / harness 复盘。

## 9.4 delivery 规范

progress delivery 和 final delivery 应该是不同协议：

### progress

1. started
2. still working
3. checkpoint ready
4. waiting user input

### final

1. success
2. partial
3. blocked
4. failed

这样 IM 侧和 operator 面才能稳定展示。

## 9.5 model policy v1

v1 不需要自动选模型，建议先写死。

这里还需要避免一个很常见的混淆：

> **role、model profile、具体模型名不是同一层。**

建议永远按下面 3 层理解：

1. `role`
   这次任务由谁承担，例如 `worker_code`、`worker_review`
2. `model_profile`
   这类角色默认吃哪种模型档位，例如 `worker_code_normal`
3. `model_id`
   最终具体落到哪个供应商/模型名，例如 `zhipu/GLM-5.1`

因此，Phase 1 真正需要写死的是 `model_profile -> model_id` 映射。

建议固定这些 profile：

1. `judge_fast`
   用于 intent / route judge，要求便宜、快、格式稳定。
2. `observer_probe`
   用于快速探测、轻量观察和最小上下文检查。
3. `direct_main`
   用于简单请求直接回答，要求速度快、质量够高。
4. `worker_default`
   用于常规 delegated task。
5. `worker_code_normal`
   用于普通代码改动、常规实现、一般修 bug。
6. `worker_code_deep`
   用于复杂实现、架构设计、难调试任务。
7. `worker_review`
   用于验证/审查。
8. `worker_deep`
   用于后续 heavy profile / 高复杂度任务。

v1 先把接口做对：

1. policy 先选 `route / role / coordination_mode / backend / workspace_mode / model_profile`
2. `model_profile` 再映射到具体模型
3. 具体模型名可以在配置里写死

不要一上来做自动学习。

另外我建议 v1 同时固定一层 **worker profile / preset role**，做法更接近 OmO，而不是让主模型临场定义角色。

建议默认先固定：

1. `main_reply`
2. `observer_probe`
3. `worker_research`
4. `worker_code`
5. `worker_review`

它们分别绑定：

1. 默认 brief 模板
2. 默认工具权限
3. 默认模型 profile
4. 默认输出 contract
5. 默认队列/并发策略

这样复杂度、成本、角色分工会更稳。

例如：

1. `observer_probe` 更像现在的 runner/inspect lane，不一定需要 generic 子 agent 长思考
2. `worker_code` 默认走代码专用 profile，需要时再升到 deep 档
3. `worker_review` 默认走验证/审查 profile

### 9.5.0 当前拍板版固定映射（v1）

基于当前讨论，v1 先固定成这套：

1. `judge_fast` -> `omniroute/cx/gpt-5.4-mini`（关闭推理）
2. `observer_probe` -> `minimax-portal/MiniMax-M2.7`
3. `direct_main` -> `zhipu/GLM-5.1`
4. `worker_research` -> `zhipu/GLM-5.1`
5. `worker_default` -> `zhipu/GLM-5.1`
6. `worker_code_normal` -> `zhipu/GLM-5.1`
7. `worker_code_deep` -> `omniroute/cx/gpt-5.4`
8. `worker_review` -> `omniroute/cx/gpt-5.4`
9. `worker_deep` -> `omniroute/cx/gpt-5.4`

这套映射的含义是：

1. 单 live judge 先用响应更稳的 `gpt-5.4-mini`（关闭推理）承担 coarse routing / continuation 判断
2. 主回答 agent 不等于 judge agent；`direct_main` 可以更强，以保证主回答质量
3. 中档模型优先承接主回答和常规 delegated work
4. 贵模型只压在代码实现、审查、复杂深任务上

这里的现实考虑是：

1. 如果当前远端非推理 judge 已经接近数秒延迟，v1 就不该再叠第二层在线 judge
2. 与其增加 `judge_strong` 热路径，不如先把 live judge 压成单层，并减少重判次数
3. continuation / slot-filling / active-intent 复用，比增加第二次在线判定更重要

其中 `worker_code` 是逻辑角色家族，当前在 model profile 层直接拆成两档：

1. `worker_code_normal` -> `zhipu/GLM-5.1`
2. `worker_code_deep` -> `omniroute/cx/gpt-5.4`

这样可以把：

1. 普通代码改动
2. 常规实现
3. 一般修 bug

先落在中档模型上。

而下面这些再升级到深档：

1. 难调试问题
2. 架构级改动
3. 大重构
4. 高风险代码 review

默认建议再补一条：

1. `worker_review` 在 v1 统一先上 `omniroute/cx/gpt-5.4`
2. 不先拆 `worker_review_normal / worker_review_deep`
3. 等 telemetry 证明 review 成本压力明显，再考虑补 normal 档

### 9.5.0.a multi-agent / advisor 的成本控制口径

既然最终要支持 multi-agent，这里建议把成本控制再往前写死一点：

1. auto router 后面不能只选 `model_id`
2. 它最终应该选择一个**执行包**：
   - `role`
   - `coordination_mode`
   - `backend`
   - `workspace_mode`
   - `model_profile`
   - `advisor_policy`

前期虽然这些都可以写死，但骨架上要留这个接口。

我建议先按下面的固定策略理解：

#### Phase 1

1. `solo_worker` only
2. 不开 advisor
3. 不开 threaded subagents

#### Phase 2

1. 只保留 `advisor_policy` / `advice_packet` / consult adapter 骨架
2. 可以做 shadow / benchmark / gate 验证
3. 不把 `advisor_assisted` 放进默认 live path

#### Phase 3 灰度

1. 只给 `worker_code_normal` / `worker_research` 灰度开 `advisor_assisted`
2. advisor 默认上 `omniroute/cx/gpt-5.4`
3. executor 继续跑 `zhipu/GLM-5.1`

#### Phase 3 后续扩展

1. 打开 `threaded_subagents`
2. 默认只做一层 delegation
3. 先支持少数固定 callable role

这里最重要的一条是：

> **自动选模型以后也不能只决定“换哪个模型”，而要决定“要不要 advisor、要不要子 agent、并发开多宽”。**

同时还要补一条很现实的约束：

1. multi-agent 的默认收益必须来自并发、隔离和质量提升，而不是“因为能多开 agent 所以多开”
2. 任何 `advisor_assisted` / `threaded_subagents` 进入 live path，都必须先通过 `cost_per_success` 和 `final_delivery_latency` 的 harness gate
3. 如果多 agent 只带来成本放大、不带来交付提升，就必须回退到 `solo_worker`

### 9.5.0.b advisor_policy 建议先做成固定字段

为了跟 harness 和成本控制接上，我建议现在就把 `advisor_policy` 当成正式字段预留。

至少包含：

1. `enabled`
2. `advisor_model_profile`
3. `max_uses_per_task`
4. `max_cost_usd`
5. `allowed_stages`

`allowed_stages` 建议默认只允许：

1. `before_commit`
2. `when_stuck`
3. `before_done`

也就是：

1. 做方案前请教一次
2. 卡住时请教一次
3. 宣称完成前请教一次

这和 Anthropic advisor tool 在 coding/agent tasks 上强调的早期规划、卡住纠偏、完成前复审思路是相符的，但我们保持 provider-agnostic。

### 9.5.1 本地模型在 v1 的位置

我建议：

1. **v1 的 `judge_fast` 默认先用便宜、独立、云端的小模型**
2. **v1 不把本地模型放进默认主链路**
3. **v1 可以为本地模型预留 provider slot / adapter 接口**
4. **等 telemetry + harness gate 稳定后，再把本地模型纳入候选**

原因很简单：

1. judge 是热路径，前期最需要的是稳定、便宜、独立、可控
2. 本地模型最容易影响首响稳定性
3. tool calling / schema adherence / context window / warmup 成本波动更大
4. 在 measurement 还没稳定前，把它放进主链只会增加变量

但中后期我认为完全可以考虑：

1. 本地模型做 `judge_fast`
2. 本地模型做 `observer_probe`
3. 本地模型做便宜的 background summarize / classify
4. 在特定机器上做 cost-optimized worker lane

前提是：

1. 它也进入同一套 telemetry
2. 它也接受同一套 gate
3. 它不是“特殊旁路”

### 9.5.2 关于关键词匹配的最终约束

这一条我建议直接写成 non-goal：

1. 不再使用关键词表做语义路由
2. 不再使用关键词表判断复杂度
3. 不再使用关键词表决定模型档位
4. 不再使用关键词表决定是否委派

允许保留的只有：

1. 明确的结构化 control action
2. 已知 anchor / task id / thread id 绑定
3. 明确的权限或危险操作边界

换句话说：

> **OctoClaw v2 不再以关键词匹配作为语义决策基础。**

## 9.6 Runner 形态建议

你这次特别提醒 runner 的实现细节，我认为非常重要，因为它直接决定系统会不会重新长回“隐形常驻件越堆越多”的老路。

### 9.6.1 先说结论

我建议 v2 的 runner 形态明确写成：

1. **默认 on-demand**
2. **daemon 只做 opt-in acceleration**
3. **tmux 只做 optional workbench/operator surface**
4. **native task/flow 不依赖 tmux**

### 9.6.2 当前代码其实已经在往这个方向收

现有代码和文档里已经出现了这些判断：

1. `resolve_runner_mode()` 默认返回 `ondemand`
2. 运行计划文档里已经写了 “runner 默认走 on-demand，daemon 退成 opt-in acceleration”
3. runtime snapshot 把无 resident runner heartbeat 解释成 `on-demand`，而不是天然异常
4. `runner_operator_surface()` 已把 tmux/workbench 表达成 optional backend

所以从方向上说，这个判断其实已经成立。

### 9.6.3 当前实现层面仍有混乱，说明这条线必须继续收口

例如当前存在这些并存路径：

1. `dispatch_task.py` 的 on-demand 路径会直接拉起 `lib/runner_loop.sh`
2. 这个 `runner_loop.sh` 自己也明确标了 `legacy-only`
3. `octoclawctl.sh` 里仍有 daemon/systemd/tmux/shell 多分支 supervisor 逻辑
4. shell supervisor 分支还存在 `python -m runner_queue runner_loop` 这样的路径，而 `runner_queue.py` 当前并没有这个子命令

这说明 runner 现在的真实问题不是“有没有能力跑”，而是：

1. 控制入口过多
2. 常驻与按需两套心智并存
3. legacy loop 还没完全退出

### 9.6.4 所以 v2 的 runner 设计建议

#### 如果任务属于 lightweight inspect/probe lane

优先：

1. enqueue
2. on-demand bootstrap 一个短命 worker
3. 干完退出

不要要求常驻件先健康。

#### 如果是高吞吐连续 runner 任务

允许：

1. opt-in daemon
2. systemd 或 shell supervisor
3. 但它只是性能优化，不是默认前提

#### 如果用户要 live workbench / operator 观察

允许：

1. tmux workbench
2. runner window / patrol window
3. 但这是 operator surface，不是 execution truth

### 9.6.4.a 默认不开 resident runner 时，policy/judge 应如何处理

这里建议再明确一个实现口径：

> **v1 默认假设“没有 resident runner”，这不是异常，而是标准起点。**

因此 route/policy/judge 在主路径里不应该先问“runner 在不在”，而应该先做语义判断，再由执行层落地。

更具体地说：

1. `reply`
   - 直接走 `direct_main`
   - 不依赖 runner
2. `delegate`
   - 默认直接 materialize native task/flow
   - execution materializer 默认落到 `openclaw-native + on-demand execution`
   - 不因为没有 resident runner 就回退成主模型硬扛整条长任务

也就是说，**fallback 不是“无 runner 时都改成 direct”**，而是：

1. `reply` 保持 direct
2. `delegate` 保持 delegate，只是落到 native substrate + on-demand worker

真正需要回退的是 execution profile，不是 semantic route。

这里还需要再说清一个很容易混淆的点：

1. `observer` 不是 runner 的别名，也不是 local backend 的别名
2. “先看、先查、先探测”在 refined v1 里不再作为顶层 route，而是：
   - `reply` 下的 state-assisted answer
   - 或 `delegate(role=observer, coordination_mode=solo_worker)`
3. `runner / openclaw-native / on-demand / tmux workbench` 都属于 execution/backend 层
4. 因此 `delegate(role=observer, coordination_mode=solo_worker)` 和其他 `delegate(role=..., coordination_mode=solo_worker)` 一样，都可能在某些执行条件下落到 runner
5. 反过来，runner 也不天然只服务某一种 role

换句话说：

1. `reply / delegate` 回答的是“这次请求本质上是什么”
2. `delegate_role=observer` 回答的是“委派出去后，这个 child worker 属于哪一类”
3. `backend` 回答的是“这次已经判定好的请求该怎么跑”

所以 v1 不应该再出现这种心智：

1. “是观察型请求就一定走 runner”
2. “是 single delegate 才能走 runner”
3. “先决定走不走 runner，再反推 semantic route”

这三种都会让系统重新长回旧的 route/backend 缠绕结构。

如果发生 backend 不可用或 admission control 拒绝，则再按下面顺序降级：

1. `delegate` -> `queued delegate`
2. `queued delegate` -> `blocked / waiting capacity`
3. 只有在任务本身被 small judge 判成“可直接短答”时，才允许改走 `reply`

这条很重要，因为否则系统很容易重新长回：

1. 语义决策被执行条件绑架
2. 主模型被迫吞下本来该委派的长任务
3. 首响和质量一起变差

### 9.6.4.b runner 开启时的机制定位

如果用户后面主动开启 resident runner，我建议把它明确成：

1. 一个 **opt-in acceleration lane**
2. 可以由 shell supervisor / systemd / hosted worker process 承载
3. 允许挂 tmux workbench 便于人工观察
4. 但 tmux 从头到尾都只是 operator workbench，不是 runner 必需机制

如果 v1 live path 默认不实现 runner，那么这里其实不必保留一个很重的独立 `backend planner` 概念。

更准确地说，v1 更需要的是一个：

1. **execution materializer**
2. 负责把 judge 的 route/role/profile 决策物化成 `native task/flow + on-demand execution`
3. 同时做 admission / write-scope / queue 这些硬约束
4. 而不是在多个 backend 之间做复杂在线选择

也就是说：

1. v1 没有 runner 时，`backend planner` 可以收缩成很薄的一层 materializer
2. 只有 future optional backend 真重新进入 live path 时，才值得把它重新扩成独立 planner

在这个前提下，v1 的执行默认心智更像：

1. judge 决定 `reply / delegate`
2. execution materializer 决定如何物化 native execution
3. 不做多 backend 竞争

如果 future 重新引入 runner，再谈更完整的 backend planning。

更进一步说，future backend planner 默认应该这样工作：

1. 默认 backend 起点是 `openclaw-native + on-demand execution`
2. backend planner 只在“明确有收益”时升级到 resident runner
3. 这个收益必须来自可解释信号，而不是语义猜测

这些可解释信号至少包括：

1. resident runner 当前可用且健康
2. 当前 queue / admission control 状态允许加速 lane 接单
3. 任务需要较长执行、持续会话或更低 `first_progress_ms`
4. 任务需要 operator attach / workbench 可视化观察
5. 任务 read/write scope 与当前 runner lane 的 workspace policy 相容
6. 成本与延迟预算支持使用该 acceleration backend
7. 任务复杂度与质量要求仍落在当前 runner model profile 的能力边界内

如果前期 runner lane 固定使用便宜模型，这里还应再加一条明确口径：

1. `runner` 可以参考任务难度和预期完成时间决定是否升级
2. 但“预计会跑很久”本身并不足以成为 runner 选择理由
3. 只有当任务 **既** 有 execution gain，**又** 没有超出 runner 模型能力边界时，runner 才是合格候选

因此 future backend planner 更合理的判断顺序是：

1. 先判断 semantic route
2. 再判断任务档位：
   - complexity band
   - expected duration
   - checkpoint intensity
   - quality bar
3. 再判断 runner eligibility：
   - runner model 是否够用
   - queue/health 是否允许
   - workspace / write scope 是否兼容
4. 最后才决定是 `native + on-demand` 还是 resident runner

这意味着：

1. 简短任务即使不难，也未必值得为 runner 升级
2. 中等难度但会跑一段时间、且便宜模型能扛住的任务，才更适合 runner
3. 高难或高质量要求任务，即使很长，也可能应该继续走更强的非-runner lane

这里还需要把“谁来做这个判断”说清楚，避免后面又把 responsibility 压错地方：

1. **不是主 agent 最终拍板**
2. **也不是让 `judge_fast` 一个人承担全部 backend 决策**
3. 在 v1 无 runner 形态下，更合理的是两段式：
   - `judge_fast` 给出粗粒度任务档位
   - `execution materializer` 负责物化 native execution
4. 如果 future backend 重新进入 live path，再升级成三段式：
   - `judge_fast` 给出粗粒度任务档位
   - `backend planner` 结合系统信号做最终 backend 判定
   - `main_reply` / worker 只负责后续执行与交付，不承担 route/backend authority

如果后面发现只靠单 judge 仍有少量高代价边界 case，还应保留一个：

1. **optional `judge_strong` / `route_adjudicator`**
2. 默认不进入 v1 热路径
3. v1 更适合作为 shadow / replay / offline adjudication lane
4. 只在 future 少量不确定、高代价、边界模糊 case 才考虑在线升级调用

它的作用不是替代主 agent，而是做独立仲裁：

1. 不直接执行任务
2. 不长期持有完整主会话
3. 不拥有 delivery authority
4. 只输出更稳的 route/backend recommendation

更合适的触发条件是：

1. `judge_fast.confidence` 过低
2. `complexity_band` 与 `quality_bar` 落在高代价边界区
3. `native + on-demand` 与 runner 的 expected gain 接近，且误判代价高
4. 任务被标记为高风险写入 / 高质量交付
5. harness 已经识别某类任务在 `judge_fast` 上误判率偏高

因此当前更稳的总口径更像：

1. v1 live path：`judge_fast -> execution materializer -> execution`
2. v1 shadow/offline：`judge_fast -> optional judge_strong -> replay/adjudication`
3. future multi-backend path：`judge_fast -> optional judge_strong -> backend planner -> execution`
4. 主 agent 始终不承担 route/backend authority

具体建议如下：

1. `judge_fast` 负责：
   - `semantic route`
   - `role`
   - `complexity_band`（粗粒度）
   - `expected_duration_band`（粗粒度）
   - `quality_bar`
   - `risk_flags`
   - `delegate_reason_codes`
   - `route_confidence`
2. `execution materializer` 在 v1 负责：
   - 读取 judge 的 route/role/band 信号
   - 物化 `native task/flow + on-demand execution`
   - 做 admission / queue / write-scope 等硬约束
3. future `backend planner` 才负责：
   - 读取 judge 的 band 信号
   - 结合 runner health / queue pressure / workspace compatibility / model eligibility
   - 决定 `native + on-demand` 还是 runner
4. `main_reply` 不负责：
   - 最终 route authority
   - 最终 runner eligibility 判定
   - 直接决定 backend

这样设计的原因是：

1. 如果全交给 `judge_fast`，小模型确实可能把复杂度或预期时长看错
2. 但如果改成让主 agent 来判，又会把主 agent 拉进更重的控制心智
3. 主 agent 一旦承担 backend/dispatch authority，就更容易吃更多上下文、更多状态、更多 token
4. 这会直接损伤首响速度、成本控制和上下文洁癖

但这不意味着主 agent 要被蒙在鼓里。

更好的做法不是“劝它听 judge”，而是给它一个明确的 route packet，让它知道：

1. judge 推荐了什么
2. 推荐理由是什么
3. 如果它不同意，允许怎样表态
4. 它不能直接悄悄推翻哪些东西

#### 主 agent 的 override / objection 协议

当前如果主 agent 对 judge 有一定主导权，我建议 v2 起改成：

1. 主 agent **可以 objection**
2. 主 agent **不能 silent override**
3. 主 agent **不能直接拿回 route/backend authority**

更具体地说：

1. judge / orchestration 会把这些字段显式传给主 agent：
   - `route_recommendation`
   - `role_recommendation`
   - `complexity_band`
   - `expected_duration_band`
   - `delegate_reason_codes`
   - `suggested_spawn_profile`
2. 如果主 agent 不同意，它必须显式返回：
   - `route_objection`
   - `objection_reason`
   - `requested_route`
   - `confidence`
3. orchestration 收到 objection 后，不能直接放任主 agent 自行改路由，而应：
   - 在低风险 case 下按 policy 接受
   - 或送去 `judge_strong` / route adjudicator 仲裁

也就是说，“要求主 agent 说明为什么不听 judge”这件事是有用的，  
但更好的做法是把它产品化成 **objection protocol**，而不是只靠 prompt 文案约束。

#### 是否要告诉主 agent 为什么委派

我认为 **要**，而且应该结构化地告诉。

这不是为了“说服”它，而是为了让它理解当前系统目标，减少它本能地什么都想自己做：

1. 保持主回答上下文干净
2. 保持首响更快
3. 把长任务移出主链
4. 给子任务匹配更合适、更便宜或更强的模型档位
5. 让 status/checkpoint/delivery 更稳定

因此 `delegate_reason_codes` 建议至少覆盖：

1. `context_hygiene`
2. `fast_first_response`
3. `background_execution`
4. `cost_tiering`
5. `specialized_tools`
6. `quality_isolation`

这样主 agent 拿到的不是一段空泛 prompt，而是“系统为什么推荐委派”的结构化理由。

#### spawn 的复杂度和模型映射

spawn/delegate 出去的任务，应该明确带复杂度档位，而不是只带一句自然语言。

v1 我建议至少固定这几类：

1. `simple`
2. `normal`
3. `deep`

再映射到静态 profile：

1. `simple`
   - 默认只用于轻观察、轻 research、轻变换类任务
   - 可落到便宜快模型 lane
2. `normal`
   - 默认落到 `GLM-5.1`
3. `deep`
   - 默认落到 `gpt-5.4`

这里要保守一点：

1. “简单任务 -> MiniMax” 这个映射对 `judge/probe/observe/simple transform` 更合理
2. 对真正写文件、复杂代码实现的 delegated task，v1 不建议轻易降到 MiniMax
3. 也就是说，`simple` 不等于“所有 spawn 都能用最便宜模型”，还要受 role 和风险边界约束

所以更稳的口径应该是：

1. `judge_fast` 只负责**粗判**
2. `execution materializer` 在 v1 负责**物化与硬约束收口**
3. `judge_strong` 在 v1 只做 shadow/offline 独立仲裁
4. future 多 backend 时，再引入更完整的 `backend planner`
5. 主 agent 最多只在后续执行中通过 plan/checkpoint 间接暴露“任务比预想更难/更长”，供 reconcile 或后续优化使用

也就是说，v1 不应该设计成：

1. “主 agent 先读很多上下文，再决定要不要走 runner”
2. “judge_fast 一次性决定 route + model + backend + duration 精细值”

而应该设计成：

1. 小 judge 给 band
2. v1 execution materializer 直接物化 native execution
3. optional `judge_strong` 先不进热路径，只做 shadow/offline
4. 后续 harness 再根据真实 telemetry 去校正 judge band 和 policy

也就是说，backend planner 的默认心智应该是：

1. 先假设不用 runner 也能正常跑
2. 再判断“用 runner 是否明显更好”
3. 而不是先问“这条请求能不能走 runner”

这同样适用于：

1. `delegate(role=observer, coordination_mode=solo_worker)` 的短探测任务
2. `delegate` 的常规子任务

两者都可以因为 execution gain 走 runner，也都可以因为默认稳态继续走 `native + on-demand`。

因此文档里更准确的口径应该是：

1. **runner 默认关闭**
2. **开启 runner 是性能优化，不是功能前提**
3. **tmux 是 runner 的可选观察面，不是 runner 的实现前提**
4. **native task/flow + on-demand worker 才是默认执行心智**
5. **v1 live path 不必实现 runner；runner 可后置为 future optional backend**
6. **v1 live path 默认只保留一个 judge；`judge_strong` 不进入在线热路径**

### 9.6.5 tmux 的定位

建议明确成一句话：

> **tmux 是可选工作台，不是底层执行依赖。**

这点对后面插件化也很关键。

因为如果把 tmux 当执行前提：

1. 插件无法跨环境稳定分发
2. CI / container / managed gateway 会变复杂
3. Windows / hosted 场景会天然掉队

### 9.6.6 我对 runner 的最终建议

因此我建议：

1. `runner` 继续保留，但退成一种 execution lane/profile
2. `runner daemon` 不作为架构前提
3. `tmux` 不作为架构前提
4. `octoclawctl` 只保留 operator convenience，不承担核心真相
5. 随着 native task/flow 成熟，越来越多 delegated work 应直接落到 native substrate，而不是再经过 legacy runner shell loop

## 9.7 成本/速度优化必须可衡量，并进入 harness 闭环

这个点我认为要正式升成 v2 架构原则。

因为如果“成本优化”“速度优化”只是口号，而不是每次请求、每个 task、每条 flow 都能被量化、回放、比较、门禁，那么后面的：

1. auto router
2. model tuning
3. fast reply 优化
4. worker profile 分层

都会重新退化成拍脑袋调参。

### 9.7.1 先说当前现状

当前仓库里这条线并不是完全没有，而是**已经有雏形，但还没有形成 runtime 闭环**。

已经存在的部分包括：

1. `budget.py` 会基于 route / model / band / worker pool 记录 `cost_estimate`
2. `eval_suite.py` 会统计 `estimated_cost_usd` 和 `avg_elapsed_ms`
3. `model-intel.py` 已经维护了 pricing / `ttft_ms` / `output_tps` / benchmark 先验
4. runtime policy 里已经有 `latency_target` / `cost_ceiling` / `route_budget_consistent`
5. workflow harness 里已经有 model telemetry / TTFT / throughput report 的概念

但当前仍缺这几个关键环节：

1. **缺每次请求级别的统一测量 schema**
2. **缺 runtime 真正采集的 ack / queue / first progress / final delivery 延迟**
3. **缺 actual usage / actual cost 与 estimate 的统一归档**
4. **缺把这些数据正式回灌到 route/model policy 的闭环**
5. **缺 promotion / block / rollback 的 harness gate**

### 9.7.2 v2 应采集什么

我建议把“优化可衡量”落实成统一的 `optimization telemetry` 记录。

这里的 `request / task / flow` 三层，最好一开始就定下来。

它们不是 3 套重复字段，而是 3 个观察视角：

1. `request`
   一次用户消息/一次主会话处理。
   重点看：`ack_ms`、`route_decision_ms`、主回答成本。
2. `task`
   一次实际物化出来的 delegated work。
   重点看：`queue_wait_ms`、`ttft_ms`、`first_progress_ms`、`final_delivery_ms`、子任务成本。
3. `flow`
   一个更高层的 parent job / task group。
   v1 即使只有 single delegate，也建议保留这一层，因为它和 OpenClaw 原生 TaskFlow 是对齐的；在 v1 里它可以退化成“一个 flow 里只有一个 task”。

所以“定死”的意思不是把每个字段都写满，而是：

1. 三层 schema 名字先固定
2. 公共字段和层级关系先固定
3. v1 可选字段允许为空

这样后面做 compound / multi-agent 时，不用再重做 telemetry 结构。

每个 request / task / flow 至少记录：

1. `request_id`
2. `task_id`
3. `flow_id`
4. `route`
5. `role`
6. `coordination_mode`
7. `backend`
8. `workspace_mode`
9. `model_profile`
10. `model_id`
11. `ack_ms`
12. `route_decision_ms`
13. `task_materialize_ms`
14. `queue_wait_ms`
15. `ttft_ms`
16. `first_progress_ms`
17. `final_delivery_ms`
18. `total_latency_ms`
19. `output_tps`
20. `input_tokens`
21. `output_tokens`
22. `total_tokens`
23. `estimated_cost_usd`
24. `actual_cost_usd`
25. `retry_count`
26. `fallback_count`
27. `failure_code`
28. `terminal_state`

其中我特别建议把延迟拆开看，而不是只看一个总耗时：

1. 首响快不快，看 `ack_ms`
2. 委派是否拖泥带水，看 `task_materialize_ms` + `queue_wait_ms`
3. worker 是否真在动，看 `first_progress_ms`
4. 用户最终体验如何，看 `final_delivery_ms`

### 9.7.3 三层 harness 怎么接这件事

#### Runtime Harness

负责采：

1. `ack_ms`
2. `route_decision_ms`
3. `task_materialize_ms`
4. route/backend/model profile 选择结果

#### Workflow Harness

负责采：

1. `queue_wait_ms`
2. `ttft_ms`
3. `first_progress_ms`
4. `final_delivery_ms`
5. checkpoint / retry / fallback / handoff 成败

#### Evaluation Harness

负责做：

1. lane 基线报告
2. 同 profile 的成本/速度回归检测
3. `estimate vs actual` 偏差分析
4. promotion / rollback gate
5. nightly benchmark / replay / acceptance 汇总

所以这里不是“再加一个 telemetry 脚本”。

而是：

> **速度/成本优化本身就是 harness 的一部分。**

### 9.7.4 v1 先做 measurement + gate，不急着 auto-optimize

我非常建议 v1 先收敛成：

1. **先测量**
2. **再报表**
3. **再设门禁**
4. **最后才做自动调参**

也就是说：

1. v1 先不要让 router 自动改模型
2. v1 先不要做 online self-tuning
3. v1 只做“看得见、比得动、退得回”

这比一上来做智能调优稳得多。

而且后面如果真要做 harness 自学习 / policy self-tuning，也必须建立在这 4 步之上：

1. 先有固定 lane baseline
2. 再有 replay 对比
3. 再有 gate 判定
4. 最后才允许 shadow recommendation / policy promotion

也就是说：

> **自学习不是“模型自己越来越会”，而是 harness 基于真实回放和指标，逐步收紧策略。**

### 9.7.5 应该怎么定义“优化成功”

不同 lane 的目标不一样，不能只看一个总分。

#### `reply` lane

优先指标：

1. `ack_ms`
2. `total_latency_ms`
3. direct reply 成功率
4. `cost_per_request`

#### `delegate` lane

优先指标：

1. `task_materialize_ms`
2. `first_progress_ms`
3. `final_delivery_ms`
4. `cost_per_success`
5. queue overflow rate / fallback rate

#### `compound` lane

优先指标：

1. flow 成功率
2. 终态正确率
3. 可恢复率
4. 总成本上限

这里再把“评估成功”的语气写得更硬一点：

1. 快响应成功，不是只看感觉“挺快”，而是 reply lane 的 `ack_ms`、`total_latency_ms`、delegate lane 的 `first_progress_ms`、`final_delivery_ms` 相比基线没有退化
2. 成本成功，不是只看单次便宜，而是 `cost_per_request`、`cost_per_success`、`actual_cost_usd` 在相同 acceptance 水平下优于基线
3. 质量成功，不是只看模型换便宜了，而是 acceptance、replay、delivery correctness 没掉
4. 任何“更快但更差”或“更便宜但回退率更高”的变化，都不算成功优化

### 9.7.5.a 后续 harness 自进化应该怎么做

如果后面要做 harness 自进化，我建议严格限定成下面这种闭环：

1. 从 production telemetry 和 replay 中抽样
2. 对比候选 policy / model bundle / advisor policy 的离线表现
3. 先给 shadow recommendation，不直接改 live path
4. 只有通过 gate 的 bundle 才允许 promotion
5. promotion 后继续监控，失败就 rollback

优化对象也要明确成执行包，而不是单个模型名：

1. `route`
2. `role`
3. `coordination_mode`
4. `backend`
5. `workspace_mode`
6. `model_profile`
7. `advisor_policy`

这样后面的“自进化”才会真的围绕：

1. 成本
2. 快响应
3. 交付质量
4. 稳定性

而不是重新变成 prompt 魔改。

### 9.7.6 对插件化的含义

你前面提到“以后 auto router、快回复、子 agent、多 agent 展示、IM 适配都想独立成插件”，这和这里其实是同一个方向。

我建议：

1. `octoclaw-runtime` 负责产出统一 telemetry 事件
2. `octoclaw-fast-reply` 消费 reply lane 指标
3. `octoclaw-delegation` 消费 worker lane 指标
4. `octoclaw-auto-router` 在 Phase 4 才开始消费闭环指标做自动调优
5. `octoclaw-status-surface` 负责把这些指标展示成 operator/user 可读视图

这样插件之间的边界会更清楚：

1. runtime 负责采集
2. eval 负责判定
3. router 才负责利用

### 9.7.7 迁移时要避免什么坑

我认为要显式避免这 4 个坑：

1. 只记录模型先验，不记录本地真实观测
2. 只记录 estimated cost，不记录 actual usage / actual billable usage
3. 只做 dashboard，不做 gate
4. 还没把 measurement 稳定下来，就让 router 自动学习

一句话：

> **没有 measurement，就没有 optimization；没有 harness gate，就没有可信的 optimization。**

---

## 10. 迁移策略

## 10.1 不建议大爆炸式重写

虽然这是重构，不是补丁，但仍然建议**分阶段重写**，而不是边跑边补。

这里要明确两条边界：

1. **分阶段**，指的是按骨架、按模块、按能力切片推进
2. **重写**，指的是正式模块落地时直接写 TS 新实现，而不是继续修老 Python/JS 文件

所以它不是：

1. 旧代码长期维持双栈
2. 看到哪坏修哪
3. 在 Python 里继续补 runtime 逻辑

而应该是：

1. 先定 contract
2. 再写 TS 新模块
3. 再切流量/切入口
4. 最后删除旧实现

## 10.2 建议阶段

### Phase 0：冻结现状并抽 contracts

目标：

1. 定义 v2 contract
2. 把 acceptance case 和 golden case 固定下来
3. 做环境 preflight harness
4. 定义 optimization telemetry schema
5. 列出“保留参考但必须重写”的旧模块清单

交付：

1. `octoclaw-contracts`
2. `octoclaw-evals` 初版
3. 当前系统基线报告
4. 成本/速度基线报告
5. TS rewrite ownership map

### Phase 1：TS live path 最小可用

目标：

1. TS policy core
2. TS runtime adapter
3. `reply + delegate`
4. 独立 ACK
5. 打通 request/task/flow 级 telemetry 采集
6. 固定 worker profile / preset role
7. 做最小 operator status surface
8. 带轻量 `timeline` 占位

这阶段不追求 compound，不追求 fancy。
但有一个硬约束：

1. 这一阶段新增正式能力只写 TS
2. 不再给对应 Python live-path 模块继续加功能
3. 老模块最多只做 shim / fallback，直到被删掉
4. 不提前做通用 skills engine / memory engine / rich gateway runtime

这里“压掉 compound”的更准确含义是：

1. v1 每次请求默认最多只物化一个 delegated child task/flow
2. 不做“一条消息自动拆成多个有依赖的 task plan”
3. 如果用户请求本身很复杂，先交给一个 single delegate worker 去处理
4. 真正的多步骤依赖编排，放到 Phase 3 再做

这不是说用户不能提复杂任务，而是说：

> **v1 先把“一个主请求 -> 一个稳定子任务”跑稳，不先做“一个主请求 -> 多任务编排器”。**

这里的 `timeline` 占位，不是说现在就做复杂事件面板。

更准确地说：

1. Phase 1 先把 `timeline` 作为正式入口保留
2. 只展示最少事件：
   - `created`
   - `acked`
   - `queued`
   - `started`
   - `checkpoint`
   - `delivered`
   - `failed`
3. 不做复杂图谱
4. 不做 rich cockpit

这样做的好处是：

1. 后面不会重做 status surface 信息架构
2. delegated work 的中间事件有自然落点
3. Phase 3 做 compound / multi-agent 时能平滑扩展
4. 但不代表 Phase 1 要一次性把 rich renderer / graph / cockpit 都做出来

### Phase 2：native task/flow integration

目标：

1. 用 OpenClaw 原生 task/flow 做执行真相
2. 打通 progress / result / delivery
3. 让 Python dispatcher 退出热路径
4. 让 telemetry 事件直接挂到 native substrate / event stream
5. status/details/queue 全部读同一份 substrate-first truth
6. surface anchor 与 thread/session binding 统一收口
7. shared IM/gateway adapter contract 落地，但不要求所有渠道一次性齐备

### Phase 3：compound / controlled multi-agent

目标：

1. compound request judge
2. plan validate / schedule
3. dependency-aware flow delivery
4. compound lane 成本/时延门禁
5. one-level threaded subagents
6. advisor-assisted lane 灰度上线
7. child thread / inbox / handoff / summary contract 打通

### Phase 4：高级能力

目标：

1. ClawTeam optional backend
2. heavy/research profile
3. richer IM/status surface
4. auto model tuning
5. telemetry 驱动的 auto router
6. wider multi-agent board / cockpit

---

## 11. 最终建议：哪些必须现在拍板

如果只挑几件必须尽快定下来的架构决策，我建议先拍板这 9 条：

1. **主语言用 TypeScript，Node 基线对齐 OpenClaw 上游。**
2. **OpenClaw 原生 task/flow 是执行真相源。**
3. **`task-state.json` 退化为 projection / policy metadata，不再是执行主真相。**
4. **ACK 独立于后续复杂决策链。**
5. **route、role、coordination_mode、backend、workspace_mode、model_profile 六者彻底解耦。**
6. **默认只做 `reply / delegate`，`observe` 降成 `reply` 内的状态读取型处理或 `delegate(role=observer, coordination_mode=solo_worker)`；compound 后置。**
7. **正式产品代码全部 TS 重写；Python 只保留测试/运维/一次性脚本。**
8. **成本优化和速度优化必须变成 request/task/flow 级可测指标。**
9. **先搭 harness 骨架、telemetry contract 和 gate，再逐步迁移功能。**

---

## 12. 我对这次重构的最终判断

OctoClaw 现在最需要的不是“更多能力”，而是一次**架构性减法**。

不是把系统做得更炫，而是把它重新收缩到：

1. 主链路快
2. 语义判断稳
3. 委派生命周期稳
4. 交付回传稳
5. 状态真相单一
6. 成本和速度可量化
7. 优化过程可回放、可门禁、可回退

如果这次重构按这个方向推进，我认为很多你现在反复修的 bug 会自然消失，因为它们并不是单点 bug，而是“职责边界错位”的产物。

换句话说：

> **OctoClaw v2 的目标，不是做一个更复杂的系统，而是做一个边界更清楚、默认路径更短、稳定性更高的系统。**

---

## 13. 待确认问题

这版初稿里，当前已确认和仍待确认的问题分开写。

### 13.1 已确认

1. `runner` 正式降级为 backend / execution lane 概念，而不是语义 route
2. v2 直接押 OpenClaw 原生 task/flow + SQLite，不继续维护 JSON 真相链
3. v1 正式产品代码全部 TS 重写；Python 只保留测试/运维/一次性脚本
4. v1 固定模型映射先按：
   - `omniroute/cx/gpt-5.4`
   - `zhipu/GLM-5.1`
   - `minimax-portal/MiniMax-M2.7`
5. v2 第一阶段完全压掉 compound，只先做 `single delegate`
6. ClawTeam 放到 Phase 4 以后再接入，且只作为可选 backend
7. `tmux` 只保留为 optional workbench/operator surface，不作为架构前提
8. v1 的 optimization telemetry schema 直接按 `request / task / flow` 三层定
9. `worker_code` 拆成：
   - `worker_code_normal` -> `zhipu/GLM-5.1`
   - `worker_code_deep` -> `omniroute/cx/gpt-5.4`
10. Phase 1 的最小 status surface 包含 `status / details / queue`，并带轻量 `timeline` 占位
11. v1 先采用双层 judge：本地 `Qwen3-0.6B` 走主判，远端 `gpt-5.4-mini` 只做 escalation / adjudication

### 13.2 仍待确认

1. `worker_research` 是否需要后续补一个 deep 档。
2. 本地 primary judge 何时从 `Qwen3-0.6B` 升到 `Qwen3-1.7B`。

当前默认建议已经是：

1. `worker_review` 在 v1 统一先上 `gpt-5.4`
2. `worker_research` 暂不补 deep 档，等 heavy/research profile 再扩
3. 本地 `judge_fast` 先不指定具体模型名，以 Phase 2 后半的 benchmark/gate 结果决定

---

## 14. 与既有设计文档的关系：哪些继承，哪些压缩，哪些舍弃

这版重构稿不是“从零另起炉灶”。

它本质上是在吸收这些旧设计来源之后做的收束：

1. `octoclaw-design-foundation.md`
2. `octoclaw-execution-plan.md`
3. `octoclaw-design-refresh-2026-04-12.md`
4. `archive/design-notes/octoclaw-product-design-v2-2026-03-27.md`
5. `archive/design-notes/octoclaw-review-and-action-plan-v1-2026-04-02.md`
6. `archive/design-notes/octoclaw-openclaw-task-flow-migration-plan-v1-2026-04-01.md`
7. `archive/design-notes/octoclaw-display-layer-productization-plan-v1-2026-03-29.md`
8. `archive/design-notes/octoclaw-task-display-schema-v1-2026-03-29.md`
9. `archive/design-notes/octoclaw-worker-taxonomy-migration-v1-2026-03-28.md`
10. `archive/design-notes/octoclaw-roadmap-multi-agent-cost-speed-2026-03-20.md`

所以答案不是“老设计都没了”，而是：

> **大方向大多被保留了，但优先级被重排了，表达方式被压缩了，少数路线被明确否决了。**

### 14.1 已明确继承到新设计里的内容

这些内容没有被放弃，而是已经进入 v2 主骨架：

1. `policy-first / workflow-first / substrate-first / harness-layered`
2. `artifact-first / event-first / state-first`
3. OpenClaw 原生 task/flow 作为执行真相源
4. ClawTeam 退为可选 backend / workbench，而不是策略脑
5. worker taxonomy / preset role / model profile 分层
6. IM / display / status surface 是正式产品面，不是“以后再说”
7. replay / eval / acceptance / promotion gate 这条反馈闭环
8. 成本与速度优化需要可衡量、可回灌
9. TypeScript/Node 对齐 OpenClaw 生态，Python 退出 live hot path

也就是说，旧稿里那些“快响应、低成本、稳定委派、可观察、可回放、可展示”的核心诉求，都还在。

### 14.2 被压缩进子规格，但没有丢的内容

这些内容在新设计里不再逐条展开写成长篇主文，而是更适合保留为子规格：

1. IM capability matrix
2. task anchor / task detail / queue / timeline / graph 的字段级 schema
3. channel-specific rendering 差异
4. worker taxonomy 的 legacy label 兼容映射
5. replay/review/curate/validate/promote/learn 的具体 nightly 流程
6. model-intel source precedence / health / cooldown / benchmark 细则

它们并不是被否定了，而是：

1. 主设计文档只保留架构骨架
2. 细节继续由 contract/schema/spec 文档承接

这是刻意的，不是遗漏。

### 14.3 这版新稿里此前表达不够的点

这一轮补完之后，我认为还有 3 条旧设计内容需要明确点名，避免误读：

1. **feedback loop 仍然是正式主线**
   新稿已经有 evaluation harness，但不该让人误解成 replay/review/validate/promote/learn 被弱化。
   更准确的理解是：它被收进了 evaluation plane，而不是被删除。
2. **display/status 不是 Phase 4 才开始**
   老稿里这条线其实已经很强，新稿现在也已经补成：
   - Phase 1 做最小 operator status surface
   - Phase 2 让 `status/details/queue` 统一读 substrate truth
3. **worker taxonomy 不是临时实现细节**
   它是 v2 里 preset role / queue strategy / model profile 的地基，不只是 display label。

### 14.4 明确延后的内容

这些内容不是反对做，而是被主动后置：

1. compound / dependency-aware plan 编译
2. richer multi-agent board / timeline / cockpit
3. auto router 自学习
4. 本地模型进入默认热路径
5. heavy/research profile 成为常规主链能力
6. 更复杂的 swarm / DAG / research runtime

这些都保留方向，但不该先于：

1. 快首响
2. 单 worker 稳定委派
3. 单一真相源
4. telemetry + harness gate

### 14.5 被明确舍弃或反转的路线

这些不是“先不做”，而是我认为应该正式宣告退出：

1. 关键词匹配驱动的语义路由
2. prompt-heavy front gate
3. 主模型背全量 transcript 做路由和交付
4. ClawTeam 作为默认必经 runtime
5. runner daemon / tmux 作为架构前提
6. patrol 作为常态生命周期引擎
7. `task-state.json` 继续充当执行真相源
8. Python 与 Node/TS 长期并行争夺 live-path authority
9. 在旧 Python/JS 正式模块上继续打补丁式演进

这几条就是这次重构最重要的“减法”。

### 14.6 一个最重要的结论

所以，如果你问：

> 以前设计文档里提到的内容，是不是都还在？

我现在更准确的回答是：

1. **核心思想大部分都还在**
2. **很多细节没有逐条写进主文，而是被压缩进子规格**
3. **有一些路线被明确推翻，这是刻意的，不是漏写**

如果再进一步收成一句话：

> **新设计不是背叛旧设计，而是把旧设计里“正确但发散”的部分收成一个更适合落地重构的骨架。**

---

## 15. 附录：必须 TS 重写的旧模块清单

这一节是给真正开工时用的，不是概念描述。

原则只有一句：

> **下面这些旧模块可以作为参考输入，但不继续补丁演进，正式实现一律落到新的 TS 包/插件里。**

### 15.1 Runtime / Policy 主链

旧参考模块：

1. `extensions/octoclaw-runtime/index.js`
2. `extensions/octoclaw-runtime/policy/decide.js`
3. `extensions/octoclaw-runtime/policy/route.js`
4. `extensions/octoclaw-runtime/policy/judge.js`
5. `extensions/octoclaw-runtime/policy/model.js`
6. `extensions/octoclaw-runtime/policy/planner.js`
7. `extensions/octoclaw-runtime/policy/compound_plan.js`
8. `extensions/octoclaw-runtime/conversation-control.js`

新归属建议：

1. `packages/octoclaw-policy`
2. `packages/octoclaw-runtime-core`
3. `extensions/octoclaw-runtime`

### 15.2 Delegation / Materialization / TaskFlow

旧参考模块：

1. `lib/dispatch_task.py`
2. `lib/openclaw_taskflow_adapter.py`
3. `lib/openclaw_taskflow_runtime_helper.mjs`
4. `lib/runtime_protocol.py`
5. `lib/runtime_task_record.py`
6. `lib/task-state-update.py`

新归属建议：

1. `packages/octoclaw-runtime-core/src/tasks`
2. `packages/octoclaw-runtime-core/src/workflow`
3. `packages/octoclaw-runtime-core/src/delivery`
4. `extensions/octoclaw-delegation`

### 15.3 Status / Display / IM

旧参考模块：

1. `lib/task_display.py`
2. `lib/status_render.py`
3. `lib/im_display_contract.py`
4. `lib/notifier.py`
5. `lib/im_thread.py`
6. `lib/task_display_cli.py`

新归属建议：

1. `packages/octoclaw-contracts`
2. `extensions/octoclaw-status-surface`
3. `extensions/octoclaw-im-adapters`
4. `tools/octoclawctl`

### 15.4 Worker Taxonomy / Role / Model Mapping

旧参考模块：

1. `lib/worker_taxonomy.py`
2. `lib/model-intel.py`
3. `lib/model_health.py`
4. `lib/model_pricing.py`
5. `lib/budget.py`

新归属建议：

1. `packages/octoclaw-policy/src/model`
2. `packages/octoclaw-policy/src/roles`
3. `extensions/octoclaw-auto-router`

### 15.5 Feedback / Eval / Replay

旧参考模块：

1. `lib/eval_suite.py`
2. `lib/replay_validation.py`
3. `lib/replay_review.py`
4. `lib/replay_summary.py`
5. `lib/reply_review_packet.py`
6. `lib/nightly_reply_review.py`
7. `lib/nightly_failure_summary.py`

新归属建议：

1. `packages/octoclaw-evals`
2. `extensions/octoclaw-status-surface`（只消费结果，不拥有逻辑）

### 15.6 可以继续留在 Python 的边角脚本

这些不属于“正式产品代码”，可以继续是 Python 或 shell：

1. 一次性迁移脚本
2. 测试辅助脚本
3. 运维脚本
4. 本地分析脚本
5. 临时数据修复脚本

但要注意：

1. 它们不再拥有 runtime authority
2. 它们不再定义正式 contract
3. 它们不再是产品主链依赖
