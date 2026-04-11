# OctoClaw 执行计划

> 状态：当前 canonical 执行计划（2026-04-07）  
> 优先级原则：**承认已完成的第一拍，在此基础上做收口和深化**  
> 关联文档：[`octoclaw-design-foundation.md`](./octoclaw-design-foundation.md)、[`octoclaw-auto-router-design.md`](./octoclaw-auto-router-design.md)、[`octoclaw-auto-router-implementation-checklist.md`](./octoclaw-auto-router-implementation-checklist.md)、[`archive/design-notes/README.md`](./archive/design-notes/README.md)

---

## 1. 这次为什么要重写计划

上一个版本的问题不在于方向完全错，而在于它把很多已经落地的能力重新写成了“接下来要开始做”。

这会导致两个误判：

1. 把已经完成的第一拍工作当成未开始，低估当前系统成熟度
2. 把真正应该做的事——**统一、压缩、做深**——写成了过于基础的建设任务

所以这版计划不再从“要不要做 feedback loop / IM 适配 / observer / taskflow substrate”开始，而是先承认哪些已经存在，再决定后续主线。

---

## 2. 当前状态：哪些已经不是待办，而是 baseline

### 2.1 已完成第一拍的能力

以下能力已经进入 baseline，而不是从零开始：

#### A. substrate / continuity / observer baseline
- taskflow-bound runner jobs
- native taskflow control metadata
- session resume context persistence
- runtime observer
- on-demand runner fallback
- patrol observation pass 收口
- unified `octoclawctl` control entrypoint

#### B. feedback loop baseline
- runtime-policy replay log
- replay summary / policy diff / promotion hints
- replay review / replay curate
- nightly replay automation
- nightly reply review / local replay validation
- eval fixture export
- learning/error promotion helpers

#### C. IM / display baseline
- session-thread truth
- task anchor rendering and updates
- backend-specific notification payloads
- Slack / Discord / Telegram / Feishu / WhatsApp 等分支
- task action fallback commands
- details / timeline / graph / retrieve / explorer / queue surfaces

### 2.2 这意味着什么

当前最重要的不是“补一条新大线”，而是三件事：

1. **把已落地的多条线变成统一产品心智**
2. **把重复/漂移/重叠的实现边界收口**
3. **把真正未完成的深水区从“基础建设”里分离出来**

### 2.3 OpenClaw 2026.4.2 对当前计划的影响

`2026.4.2` 带来的核心变化不是“让前面的优先级重排”，而是把 substrate convergence 的目标说得更清楚了：

- `task` 继续是 execution unit
- `TaskFlow` 变成了更明确的 durable parent-job substrate
- upstream 已有 `task_mirrored` / `managed` 两类 sync mode
- `managed TaskFlow` 已支持 child task spawning、sticky cancel、revision / state / wait / cancel intent
- trusted authoring layer 也开始有绑定式 runtime seam

对当前计划的直接结论：

1. **P1 不回退，也不需要重开**
   - 你已经做完的 observer / patrol / runner / ctl 收口不被这次 upstream 变化推翻
   - 只需要在后续术语里把 “taskflow substrate” 说得更精确
2. **P2 不改主线**
   - feedback loop 的优先级和闭环设计不受影响
   - 只是后面在 replay / review / validate 里，可以更自然地区分 mirrored facts 与 managed substrate truth
3. **主要受影响的是 P4**
   - 原来写成 “继续接 OpenClaw tasks/flows” 的地方，现在应收成 “向 managed TaskFlow substrate 收敛”
   - `simple spawn_multi` 的目标也应从泛泛的 linear flow，升级成更明确的 `managed TaskFlow (linear-first authoring)`

### 2.4 当前稳定性整改线

在继续推进 P1/P2/P4 之前，需要先把运行模式收成一个更稳的 baseline。当前这一条整改线的目标不是“发明新能力”，而是把已经存在的能力重新排成主次。

#### A. 入口约束默认进入 guided
- 主要操控面应是 runtime policy mode，而不是零散 switches
- 默认 mode 应落在 `guided`
- 非 direct 请求原则上要走 `octoclaw_dispatch`
- `before_tool_call` 与 `delegation_enforcement` 应作为 guided baseline 打开
- `conservative` 保留给观察/灰度场景，`enforced` 留给更强 rollout

#### B. patrol 回到 detect / notify / reconcile
- 关闭 patrol 默认 auto-redispatch
- detect-only 模式下不再把 timeout/异常暗中升级成自动修复
- 先修 patrol 自己的运行面可靠性
  - config load
  - `openclaw` PATH / bin resolution
  - handoff / notify 重试的可观测性

#### C. delegated completion 改成异步 SLA
- 正常路径仍然是 runtime event / handoff 自动回推
- 但产品表述要改成“异步后台完成后回推”
- 如果 anchor / announce 未成功，要明确 fallback 到 `details` / `queue` / status surface

#### D. nightly analysis 只做分析与记录
- nightly replay validation
- nightly reply review
- nightly failure summary
- 汇总后推送到 Slack / IM channel
- 不在 nightly job 中自动修代码或自动补救任务

#### E. workflow-meta 与模型测速先收回 workflow-first baseline
- workflow/session provenance 问题默认留在 `direct + control_observer`
- 不让“当前模型 / 有没有走 dispatch / 刚才是不是子任务做的”再误落到 delegated lane
- 模型测速 / 首 token / 吞吐对比默认走 `runner + inspect_report`
- OpenClaw gateway fallback log 以 stale-gated 方式回灌 `model-health`
- 这条反馈线帮助 selection 避开坏链路，但不默认放开 main-agent `direct_model_override`

#### F. live controller recovery 先于继续补 prompt 词表
- 当前最主要的问题不是缺更多 route feature，而是 live entry 仍会把：
  - fresh live lookup
  - execution/provenance follow-up
  - local operator surface query
  混在一起
- 当前优先级应转向：先把 live controller 收成少量稳定 `intent classes`
  - `plain_chat`
  - `runtime_read_model`
  - `execution_followup`
  - `local_surface_lookup`
  - `fresh_live_lookup`
  - `delegated_work`
  - `undetermined`
- `fresh_live_lookup` 默认 workflow-first，不再随机落到 `direct_answer`
- provenance / “你是怎么查的” 只消费 execution/materialization/tool ledger
- direct 路径只保留给窄的 `plain_chat + answer_now`
- 对 lookup 还要显式区分：
  - `lookup_scope=local_instance`
  - `lookup_scope=upstream_project`
- 这样 `你现在啥版本` 不会再和 `有没有新的发版` 共享同一个执行 playbook
- 最终边界固定为：
  - `local_instance lookup -> direct`
  - `upstream_project lookup -> runner/workflow-first`
  - `runner unavailable -> explicit degraded_direct_lookup`
- `fresh_live_lookup` 不再直接等于 `direct`；它只是 front-gate hint，最终 route 仍由 stateless judge + validator 决定
- front gate / route / dispatch / follow-up 不得继续各自重判同一句自然语言；语义主判权必须收敛到单次 judge

---

## 3. 新的优先级排序

## P0：先把 canonical docs 与代码现实对齐

### 目标
以后看计划时，不再把“第一拍已完成的能力”误判成未开始。

### 完成标准
- 设计底稿明确写出 feedback loop、IM adaptation、observer/taskflow baseline 已落地
- 执行计划明确区分：已完成 baseline / 下一步深化 / 明确延后项
- canonical 文档入口固定在 `docs/`
  - `docs/octoclaw-design-foundation.md`
  - `docs/octoclaw-execution-plan.md`
  - 根目录旧文档默认视为 supporting/archive source，而不是新的计划真相源

> 这一项本轮已经完成。

---

## P1：把 observer / patrol / runner / ctl 收成一套统一运行时心智

### 为什么这仍然排第一
因为虽然这条线已经落地第一拍，但当前仍然容易出现以下心智分裂：

- patrol 是独立系统，还是 observer 的一部分？
- runner 是 runtime 组件，还是 lane 形态？
- ctl 是状态工具，还是统一控制入口？
- on-demand fallback 和常驻 runner 的职责边界到底是什么？

### 现在真正该做的，不是“开始做 observer”
而是：

- 压缩重复职责
- 定义统一术语
- 让控制入口、状态入口、恢复入口围绕同一心智工作
- 继续减少“看起来像多个系统”的感觉

### 近期交付物
- 一份更严格的 runtime role map（observer / patrol / runner / ctl）
- 对应代码中的职责清单和收口方向
- 明确哪些 loop 保留常驻、哪些改成按需或 observer 吸收

---

## P2：把 feedback loop 从“已有能力集合”收成统一闭环

### 为什么它现在应该升优先级
因为这条线你已经做了很多，反而最容易因为缺少统一产品命名而被忽视。

当前已经有：

- replay log
- replay summary
- replay review
- curate
- nightly automation
- reply review packet
- validation
- eval fixture export
- learning/error promotion
- rollout promotion hints

问题不再是“有没有”，而是：

- 哪条是主闭环
- 哪条是旁路观察工具
- 哪些输出进入策略晋升
- 哪些只是 operator review 参考
- economics / route diff / policy diff / validation / learnings 之间如何形成闭环链路

### 近期目标
把它明确收成：

```text
observe -> summarize -> review -> curate -> validate -> promote -> learn
```

### 近期交付物
- 一份 feedback loop map
- 每条工具在闭环中的角色说明
- promotion / validation / learning 之间的输入输出约定
- 明确哪些 nightly job 是核心，哪些只是辅助分析

### 为什么这是高优先级
因为“省钱”和“更稳”不应该只靠 intuition；这条线其实已经是 OctoClaw 的核心差异化之一。

---

## P2.5：把 router 核心收成可拆分 Auto Router

配套设计底稿见：[`octoclaw-auto-router-design.md`](./octoclaw-auto-router-design.md)  
施工清单见：[`octoclaw-auto-router-implementation-checklist.md`](./octoclaw-auto-router-implementation-checklist.md)

### 为什么现在该把这件事写进 canonical plan

当前 OctoClaw 已经不只是 route score 脚本了，而是逐步形成：

- signal extraction
- route / model / budget decision
- replay / validation / learning feedback
- model-intel / health / cooldown

如果这部分边界现在不写清楚，后面很容易出现两种坏结果：

1. 把整个 OctoClaw 误收成“一个黑盒 router”
2. 或者反过来，把本来可以独立沉淀的 router core 永远绑死在当前 runtime 细节里

### 目标

把 router 部分明确设计成：

- **先在 OctoClaw 内部服役**
- **但未来可以独立抽成开源 Auto Router**
- **目标兼容 OpenAI-compatible / OpenRouter Auto-like recommendation mode**

### 推荐的子层结构

1. signal layer
2. V2-style router core
   - rules
   - semantic route
   - optional tiny local judge
3. R2-style budget planner
   - `(model, output_budget)` 联合选择
4. policy / gateway adapter
5. model-intel / auto-update layer

### 近期交付物

- router boundary map
- protected lanes inventory
  - `control_observer`
  - `session_control`
  - workflow/session provenance
  - task action / queue / details / status
- `signal / route / budget / model_intel` 的 schema 草案
- `route outcome` schema 草案
- model-intel 自动更新面
  - 价格
  - 能力画像
  - 健康/冷却
  - `OpenRouter catalog` 同步
    - 目录 / 价格 / context / provider / modality
  - `OpenRouter rankings` 同步
    - 作为低权重生态信号，不压过本地 truth
    - 默认过滤免费模型，或至少单独降权免费模型
  - `models.dev` 风格 registry adapter
    - 结构化 capability / limits / modality / status
  - freshness / decay / stale fallback 语义
  - last-good snapshot / stale-if-error cache
- OpenAI-compatible recommendation surface 草案
- 在 replay / validation / promotion 里沉淀 route outcome 字段
  - 为后续从静态映射升级到 feedback-driven router 预留训练面
- shadow rollout / diff logging 约定
- golden misroute suite
  - 把高频误判样本沉淀成 durable regression set
- Python / JS / runtime parity baseline
- 明确 runtime / offline ownership
  - runtime hot path 以 JS/TS 为主
  - feedback / calibration / learned router 以 Python 为主

### 这条线的约束

- 不把 OctoClaw 完整 runtime 直接等同于 router
- 不要求现在就拆仓
- 不要求立刻变成通用 proxy
- 先把内部接口做干净，再考虑独立开源
- 先把外部 source adapter 和 online update 收稳，再深化 learned router
- 默认先走 OpenClaw plugin-first 形态，不把独立 service 当当前前置目标
- 默认先优化 delegated lanes，而不是直接改主 agent
- `control_observer` 不进入普通业务 auto-router 训练面
- 先 shadow/recommendation，再 promotion，不直接硬切主路径
- 先做 protected lanes / goldens / parity，再考虑 tiny judge

### 这条线的近期推进顺序

当前状态：`1 / 2` 已落地，`3` 仍未开始。

1. 先收 protected lanes
   - 明确哪些问题必须留在 main-agent stable scope
   - workflow-first，非必要不委派
   - current-session mutation 不能被错误委派给子任务
2. 再补 goldens / parity / replay diff
   - 先降低高频误判，再扩 recommendation 面
   - nightly 必须覆盖 direct path / protected lane / session-control 的坏例子
3. 最后才给模糊样本接 tiny judge
   - tiny judge 是歧义裁决器，不是主路由器

---

## P3：把 IM / display adaptation 从 baseline 做到“可持续产品面”

### 当前状态
这条线也已经不是空白：

- session-thread truth 有了
- task anchor 有了
- notification backend 分支有了
- task action fallback commands 有了
- Slack / Feishu / Telegram / Discord 等基础适配有了
- details/timeline/graph/retrieve/explorer 有了

### 现在真正缺的是什么
不是“再证明 IM 重要”，而是：

- capability matrix 与当前代码现实重新对齐
- channel 之间哪些是 L0/L1/L2 能力要重新定义
- IM / CLI / tmux / Web/UI 的职责边界要更清楚
- anchor / thread / action / artifact retrieval 的语义要更统一

### 近期目标
把 IM/display 线明确成：

- **IM = lightweight ops surface**
- **CLI/tmux = operator control surface**
- **Web/UI = future full cockpit**

### 近期交付物
- 一份基于当前代码的 capability matrix（不是纯设计假设）
- 不同 channel 的统一 anchor/update/action 语义说明
- 哪些 channel 已经“够用”，哪些只是基本 fallback

---

## P4：继续做 substrate convergence，但重点从“接入”转向“替换旧平行真相层”

### 当前状态
你已经把很多 substrate-aware 能力做起来了。

所以现在的重点不再是笼统写“接 OpenClaw tasks/flows”，而是：

- 哪些旧 mirror/legacy 记录还需要存在
- 哪些字段已经可以直接 substrate-first
- observer / display / retrieve / review 是否都优先消费 substrate-aware facts
- 哪些 fallback 还必须保留
- 哪些路径应该对齐 upstream `managed TaskFlow`，哪些仍然只适合停在 mirrored / binding-first

### 近期目标
把“taskflow substrate 已接入”推进到“`managed TaskFlow` 成为默认目标 substrate，旧 mirror 退成兼容层”。

### 近期交付物
- substrate field inventory
- legacy mirror 依赖清单
- 哪些表面已完全 substrate-aware，哪些仍处于过渡态
- OctoClaw 字段与 upstream `task_mirrored / managed` 的映射表
- `revision / state / wait / cancelRequestedAt` 对应到本地 runtime 语义的落点
- `spawn_single` 的 native-preferred create 路径
- simple `spawn_multi -> managed TaskFlow` 的收口路径（authoring 先保持 linear-first）
- legacy mirror / fallback 清理顺序

### 这条线现在最具体的推进顺序
1. `spawn_single`：从 mirror/binding-first 继续推进到 native-preferred create
2. simple `spawn_multi`：优先收成 `managed TaskFlow`，而不是继续长时间停留在并行 detached shell
3. display / retrieve / observer / review：把 substrate-aware facts 变成默认读面，并逐步区分 mirrored facts 与 managed truth
4. 清理 legacy mirror / compatibility fallback，只保留仍然有明确恢复价值的那部分

---

## P5：做 runtime simplification，而不是继续扩 runtime

### 当前状态
P4 之后，系统已经具备这些前提：

- substrate-first surfaces 已经建立
- runtime observer 已经落地
- `RUNNER_MODE=ondemand` 已经出现
- `octoclawctl` 已经成为统一 operator 入口雏形
- patrol / observer / runner 的边界开始收清

所以 P5 不再是“补一条新能力”，而是：

> **把当前能跑的 runtime，收成更轻、更稳、更少历史包袱的正式运行时。**

### 目标

P5 要完成的不是“更炫的运行时”，而是 4 个收口目标：

1. **observer 成为唯一 read-model truth producer**
2. **patrol 收成 recovery + notify coordinator**
3. **runner 默认走 on-demand，daemon 退成 opt-in acceleration**
4. **ctl 成为唯一推荐 operator 入口**

### 非目标

P5 不应该顺手混进这些题：

- 不重做 router / auto-router
- 不重开 P3 的产品面大题
- 不做大规模 Python -> TS 全量迁移
- 不新增一套并行 backend 或新的长期常驻件
- 不把 patrol 再做成第二个 runtime engine

### 具体工作包

#### P5A：Observer Centralization

目标：

- 把残留在 `status` / `patrol` / `task_display` / 其它 surface 里的自算真相逻辑继续往 `runtime_observer` / runtime snapshot 收

完成标志：

- `status / observe-once / detail / retrieve / review` 默认围绕同一份 substrate-aware read model
- text surface 只是 observer render，不再各自维护另一套解释器

#### P5B：Runner Simplification

目标：

- 让 `runner` 真正成为 execution lane，而不是默认常驻前提

完成标志：

- `RUNNER_MODE=ondemand` 成为主姿势
- `daemon` 明确是 opt-in acceleration
- 没有 resident runner heartbeat 时，不再天然视为 runtime 异常
- runner 类任务在无常驻 runner 情况下也能完成 smoke

#### P5C：Patrol Slimming

目标：

- 继续把 patrol 从“隐形主循环”收成 detect / reconcile / notify / bounded recovery 组件

完成标志：

- patrol 不再承担另一套主真相合成职责
- detect-only / recover / notify 语义更清晰
- patrol 停掉再拉起，不导致 runtime truth 漂移

#### P5D：Operator Consolidation

目标：

- 日常运维默认只需要 `octoclawctl`

完成标志：

- 常用操作都可通过 `octoclawctl` 完成
  - `status`
  - `observe-once`
  - `patrol-once`
  - `runner-status`
  - `ps`
  - `up/down/restart`
- 旧脚本退成 wrapper / compatibility shell，而不是 operator 的主心智

#### P5E：Optional-Backend Preparation

目标：

- 把重 backend 明确降成增强层，为 P6 做准备

完成标志：

- tmux / ClawTeam / workbench / resident runner 更明确是 optional backend
- 默认路径的核心价值继续来自
  - OpenClaw substrate
  - OctoClaw policy / observer / feedback / display

#### P5F：Harness Consolidation（non-disruptive）

目标：

- 把当前已经存在但分散的 harness 能力正式收成三层：
  - runtime harness
  - workflow harness
  - evaluation harness

完成标志：

- 有一份明确的 harness ownership map：
  - 哪些模块属于 runtime harness
  - 哪些模块属于 workflow harness
  - 哪些模块属于 evaluation harness
- `brief / result / artifact / event / eval outcome` 有统一 contract inventory
- 新增 workflow / review / benchmark / replay job 默认落到三层之一，而不是继续长成旁路脚本
- 不新增一套新的常驻 runtime，也不引入新的 super-agent 默认主路径
- 现有实现保持渐进归类，不要求一次性大迁移

当前 canonical artifact：

- `docs/octoclaw-harness-ownership-map.md`
- `docs/octoclaw-harness-contract-inventory.md`

#### P5G：Completion Relay + Observer Snapshot

目标：

- 把 delegated task 的完成收口从“native facts + task-state + patrol + assistant 口头判断”的混合链路，收成更明确的 substrate-first 关键路径：
  - native task / managed TaskFlow 负责 execution truth
  - completion relay 负责立即传播完成事实
  - observer snapshot 负责唯一读面
  - patrol 退出关键路径，只做 detect / reconcile / retry

完成标志：

- delegated task 一旦进入 native `task_started` / `task_running`，主面和主会话不再继续说 `queued`
- delegated task 一旦 native `task_completed` / `result_ready`，projection 在短时间内稳定可见
- `status / details / queue / retrieve / protected-lane state answers` 默认围绕同一份 snapshot，而不是各自猜状态
- patrol 停掉或延迟时，不会阻止已完成任务显示为完成
- tmux / runner / workbench 明确只作为 execution backend，不再承担状态真相职责

近期交付物：

- `runtime snapshot` 设计与实现清单
- `completion relay` 关键路径说明
- `task-state / task-events / native taskflow facts` 的优先级与合并规则
- protected-lane 状态问答的 snapshot grounding 规则
- patrol 从关键路径退出后的 retry / reconcile 边界

建议推进顺序：

1. 统一 `runtime snapshot`
   - 用 native task / flow facts + task-state projection + task-events 合成一份 snapshot
2. 建立 `completion relay`
   - 在 native finalize / runner finalize / dispatch 收口点立即触发 projection 持久化 + notifier
   - `task anchor` 只负责首次锚点 / 进度更新，不再兼任“最终已通知用户”
   - `completion relay` 必须发送一条新的 final relay，并且只在 relay 成功后标记 `delivered`
   - 首次 anchor 不允许回退复用通用 `last_message_id`，必须生成明确的 anchor message
3. 让主会话的 protected-lane 状态问答强制先查 snapshot
4. 把 `status / details / retrieve / review` 全部切到 snapshot 读面
5. 最后再继续瘦身 patrol，只保留 detect / reconcile / bounded retry

#### P5I：Session Boundary + Workflow Materialization Hardening

目标：

- 解决“顶层 route 判对，但在线行为没有按该 route materialize”这一类系统性失配
- 把用户入口、主会话、子任务 session、runner/spawn materialization 之间的边界收硬
- 让 `runner / spawn_single / spawn_multi` 从“标签”真正变成固定 execution contract

为什么这条线现在必须进主线：

- `workflow-first` 和 `substrate-first` 本身没有错
- 但当前在线坏例子说明，仅仅有正确的 `policy_resolved` 还不够
- 如果用户消息被错误绑定进 `octoclaw-subagent-*` session，或者 delegated lane 在执行期还能被 freeform prompt 洗掉原始 contract，
  那么前面的 route / continuity / grounding 改造都无法稳定显现到真实聊天体验里

完成标志：

- 用户消息默认只绑定 canonical main session，而不是最近活跃的 subagent session
- `runner` lane 一旦被选中，就只能 materialize 成固定 runner playbook / runner job
- `spawn_single / spawn_multi` 一旦被选中，就只能 materialize 成固定 child-task spec / task id / explicit failure
- 没有 `task_id`、没有 runner job、没有 `dispatch_called.executed=true` 时，assistant 不能声称“已经委派”或“spawn 卡 queued”
- `executed=false` 有明确 `materialization_failed` 原因，而不是再靠 assistant 口头解释

建议推进顺序：

1. session boundary hardening
   - native child 不再与 canonical main session 共享用户入口身份
   - `octoclaw-subagent-*` session 明确为内部 session class
   - 用户入口拒绝绑定到 subagent session；若检测到污染，优先纠正回 canonical main session
2. runner workflow realization hardening
   - `runner` lane 只允许进入已注册 playbook
   - 不再允许主 agent 在 `runner` lane 下拼二跳 freeform task 再次重路由
3. spawn materialization contract
   - `spawn_single / spawn_multi` 必须落到固定 child spec
   - 成功就给 `task_id`；失败就给 `materialization_failed`
4. capability-bound failure surface
   - 当前 lane 没能力时，直接暴露 capability-bound failure
   - 不再 silently 降级成 direct/freeform 试错
5. execution-fact-grounded explanation
   - ack / anchor / status / explanation 只认 materialization 与 execution facts

建议交付物：

- canonical main session 与 subagent session 的边界定义
- delegated lane materialization contract 说明
- `materialization_failed` reason taxonomy
- session binding / runner job / task id / execution fact 的 explanation grounding 规则
- 一组专门覆盖“route 判对但在线行为偏离”的 replay / smoke cases

实施分包：

1. **Package A：Delegated Materialization Contract**
   - 新增 `delegated_materialization` 与 `capability_bound_failure` contract
   - `runner / spawn_single / spawn_multi` 统一产出 materialization facts
   - `materialization_failed` reason taxonomy 先在 dispatch/spawn 层落地
2. **Package B：Canonical Session Boundary**
   - canonical main session 与 `octoclaw-subagent-*` internal session class 分离
   - policy state lookup 不再跨 subagent boundary 漂移
   - session binding 从 in-memory fallback 升级为 workspace-local durable ledger
3. **Package C：Execution-Fact-Grounded Surfaces**
   - `ack / anchor / status / details / retrieve / review packet` 统一只读 materialization + execution facts
   - 没有 `runner_job_id`、`task_id`、`dispatch_called.executed=true` 时，不再允许“已经委派”的解释

当前施工顺序：

- 先做 `Package A`
- 再做 `Package B`
- 最后做 `Package C`

这样做的原因是：

- 先补 contract，后面的 session 和 explanation 才有稳定事实层
- 否则会继续出现“route 判对但行为没 materialize，解释又先走了”的系统性失配

代码级 backlog：

- `I1 Session Boundary Hardening`
- `I2 Runner Workflow Realization Hardening`
- `I3 Spawn Materialization Contract`
- `I4 Capability-Bound Failure Surface`
- `I5 Execution-Fact-Grounded Explanation`

### P5J：Conversation Control Plane 收口

在 `I1-I5` 的 delegated materialization 基线之外，当前还需要一条更薄的 conversation refactor，专门解决：

- follow-up 仍可能按旧记忆回答，而不是按最新 execution facts 回答
- direct slow lookup 没有稳定的快速 ack
- burst 多消息仍可能被压成单一总 route
- dispatch 仍可能复用错误粒度的 cached decision
- `policy_judge` 已经是主路径，但当前只有单 judge；主 judge 超时会直接掉回 planner fallback，导致同一对话内 decision source 漂移

在进入 `J1-J4` 之前，还需要一个更前置的 judge/route 稳定化步骤：

0. **K1 Judge Cascade + SLA**
   - 主 judge 不再以 1200ms 单点超时作为唯一 gate
   - 新增 `main_grade_model -> cheap/local judge -> planner fallback` 的 cascade
   - 远端 fallback judge 不再使用过短 budget；本地 fallback judge 才适合 `500-800ms`
   - replay / ledger 明确记录 `judge_attempts / judge_fallback_stage / final_judge_source`
1. **K2 scope boundary hardening**
   - `local_instance lookup -> direct`
   - `upstream_project lookup -> runner/workflow-first`
   - runner 当前不可用时，只允许 `degraded_direct_lookup`
   - 不允许 silent direct fallback 把 `upstream_project` 查询长期吞掉

这条线固定分成四步：

1. route / task-class hardening
   - workflow meta / task progress follow-up 不再靠词表穷举，而是先走 conversation front gate
   - front gate 产出 `execution_followup` / `local_surface_lookup` / `fresh_live_lookup` hint
   - route engine 再根据 hint 把 follow-up 收到 `direct/control_observer`，把本机 operator surface 查询收进 `runner`
   - bounded software/repo update lookup 改为 workflow-first，不再继续进入 `direct/simple_lookup`
2. JS-native state grounding
   - 在 runtime hot path 接入 replay + task-state grounding
3. direct slow-path latency ack
   - direct lookup 也必须能先发轻量 ack
4. acceptance/nightly coverage
   - 为 follow-up grounding 和 latency ack 建回归与验收矩阵

但当前这四步还需要再明确成 4 个一次性整改点：

1. **J1 work-item decomposition**
   - 不再把一个 burst 内的多条消息粗暴压成单一路由
   - `control_observer / session_control` 子句与 `fresh_live_lookup / delegated_work` 子句先拆成独立 work item
2. **J2 single semantic truth**
   - 语义只由 stateless judge 判一次
   - front gate 只产出 signal / hint
   - validator / dispatch / follow-up 不再重复判自然语言
3. **J3 delegated ACK at route commit**
   - delegated ACK 从 dispatch 副作用提升为 route commit 后的入口动作
   - 不再要求模型先真的走到 `octoclaw_dispatch`
4. **J4 final-answer execution guard**
   - `dispatch_required=true` 但没有 `dispatch/materialization/handoff/capability_failure` 时，assistant 不能把结果说得像已经做完

推荐顺序：

1. `K1` judge cascade + SLA
2. `K2` scope boundary hardening
3. `I1` canonical session boundary
4. `I2 + I3` materialization contract
5. `J2` single semantic truth / dispatch decision source hardening
6. `J3` delegated ACK at route commit
7. `J4` final-answer execution guard
8. `J1` burst message decomposition
9. acceptance / nightly coverage

### 实施原则

- 基于 **OpenClaw 2026.4.5** 的 runtime / TaskFlow 语义继续收口
- runtime hot path **优先 Node.js / JS**
- Python 优先用于 offline analysis / nightly / calibration / compatibility glue
- 先读参考项目的公开设计/README 对齐方向；真正落具体 contract 时，再定点读局部源码
- 不为“进程更少”而简化，而是为：
  - 降低状态漂移
  - 降低恢复复杂度
  - 降低 operator 心智负担
- harness consolidation 以 **contract first / ownership first** 为主，不以“大重构” 为前提

### 代码级 backlog

#### H1：Harness Ownership Map

交付物：

- 在 canonical docs 中落一份 ownership map，明确：
  - 哪些文件属于 runtime harness
  - 哪些文件属于 workflow harness
  - 哪些文件属于 evaluation harness
- 对新增模块要求在 PR/提交说明里显式标注 harness layer

验收标准：

- `route / policy / dispatch / context / artifact / task-state` 已明确归到 runtime harness
- `runner_playbooks / telemetry / benchmark / inspect` 已明确归到 workflow harness
- `eval_suite / replay_validation / reply_review_packet / nightly review / failure summary` 已明确归到 evaluation harness

#### H2：Contract Inventory

交付物：

- 统一梳理并命名这 5 类 contract：
  - `brief`
  - `result`
  - `artifact`
  - `event`
  - `eval outcome`
- 为每类 contract 标出当前 canonical producer / consumer / storage

验收标准：

- 新增 workflow 不再自造一套 result/artifact 字段
- replay/nightly/eval 读取的 outcome 结构可以对齐到统一 inventory

#### H3：Workflow Harness Normalization

交付物：

- 把 benchmark / telemetry / inspect 这类“非必要不指派 agent”的流程，优先收成 workflow harness
- 要求这类能力优先走 playbook / report workflow，而不是 generic `spawn_single`

验收标准：

- 典型测速、日志、状态诊断类需求默认不再落 generic delegated agent lane
- 新增 workflow 默认产出 brief/result/artifact 三件套

#### H4：Evaluation Harness Consolidation

交付物：

- 收口 nightly / replay / review / failure summary 的 packet 和 outcome 口径
- 对 protected lane、direct slow reply、delegation explanation risk 形成固定 nightly coverage

验收标准：

- casual bad case 不再完全依赖用户二次追问才暴露
- nightly summary 能稳定区分：
  - protected-lane misroute
  - direct-path latency
  - explanation/grounding risk

#### H5：Snapshot And Completion Relay

交付物：

- 新增统一 snapshot 读面，明确：
  - native task / flow facts
  - task-state projection
  - task-events event log
  的合成规则
- 在 native finalize / runner finalize / dispatch 收口点补 completion relay
- 为 protected-lane 的状态类问题补 snapshot grounding

验收标准：

- native child 已 `running` 时，主会话与状态面不再回退为 `queued`
- native child 已 `done` 时，report / summary / handoff 可由 completion relay 直接带回，而不是等待 patrol 下一轮发现
- `queued / running / done / 谁做的 / 有没有走 dispatch` 这类回答，默认读 snapshot，而不是复用旧经验话术
- patrol 停掉后，已完成任务的 completion truth 仍可被 observer surface 正确读取

### 当前结论

按 2026-04-08 的基线，P5F 以“ownership 与 contract 收口完成、实现保持渐进归类”为完成口径。

- H1 由 `octoclaw-harness-ownership-map.md` 关单
- H2 由 `octoclaw-harness-contract-inventory.md` 关单
- H3 由既有 workflow harness baseline 关单：
  - `runner_playbooks.py`
  - `model_telemetry_report.py`
- H4 由既有 evaluation harness baseline 关单：
  - `eval_suite.py`
  - `reply_review_packet.py`
  - `replay_validation.py`
  - `replay_review.py`
  - `replay_summary.py`
  - `nightly_reply_review.py`
  - `nightly_failure_summary.py`

### 完成标准

P5 关单前，至少应满足：

1. `status / observe-once / runner-status / patrol-once` 读的是同一套 runtime truth
2. `RUNNER_MODE=ondemand` 可以作为主姿势通过 smoke
3. 没有常驻 runner 时，runner lane 仍可正常完成基础任务
4. patrol 重启不会导致真相层分叉
5. 维护者默认只靠 `octoclawctl` 就能完成日常观察与控制
6. patrol 不再像第二套 runtime engine，runner 也不再像默认真相源
7. runtime / workflow / evaluation harness 的 ownership 与 contract inventory 已明确

---

## P6：把重 backend 彻底降成可选增强层

### 当前状态
这条线不再是“是否要去 ClawTeam 化”，而是：

- 文档心智上已经应当 optional-backend 化
- 实现上还需要继续消除“默认把 ClawTeam 当主运行面”的残留假设

### 近期目标
确保默认路径的核心价值来自：

- OpenClaw substrate
- OctoClaw policy/control/feedback/display

而不是来自重 backend。

---

## 4. 明确哪些事情现在不要重做

以下事情现在不该被重新当成主线建设任务：

1. “开始做 feedback loop” —— baseline 已有，应改为统一/深化
2. “开始做 IM 适配” —— baseline 已有，应改为 capability 收口与产品化
3. “开始接 taskflow substrate” —— baseline 已有，应改为 substrate-first 清理
4. “开始做 observer” —— baseline 已有，应改为职责收口

这些都不是 0→1 问题了，而是 1→2、2→3 的问题。

---

## 5. 明确延后项

以下仍然不应排到近期主线前面：

1. 再新增一堆平级专题设计文档
2. 把系统包装成通用多 Agent framework
3. 在 current baseline 还没统一前大规模做 Web full cockpit
4. 在控制面与 substrate 关系没收清前做激进 Python→Node/TS 迁移
5. 为了抽象而抽象地重做 taxonomy / protocol 命名
6. 在 router core 的 schema 和 model-intel 更新面没收清前，急着把整个 OctoClaw 拆成单独“路由产品”

---

## 5.1 明确不是 OctoClaw 当前 blocker 的上游 caveat

以下问题需要明确标记为 upstream / environment caveat，而不是继续吞回 OctoClaw 主线：

- OpenClaw busy-queue / transcript append 在进程刷新或重连窗口下的丢消息风险
- 某些 IM ingress 没有稳定进入主会话 transcript，导致 OctoClaw replay 根本看不到事件

处理原则：

- 记录为外部依赖风险
- 在 operator 文档和排障里明确说明
- 不再把它们重新包装成 OctoClaw runtime 主线 blocker
- OctoClaw 主线只继续修“消息已经进入 session transcript 之后”的 policy / dispatch / handoff / observer 问题

但这里需要补一个明确例外：

- 如果是 **OctoClaw 自己 materialize 的 subagent session / delegated session 反过来污染了主用户入口绑定**，
  那它就不再只是 upstream caveat，而是 OctoClaw 当前主线 blocker

换句话说：

- “外部 IM ingress 根本没进 transcript” 仍然是 upstream / environment 风险
- “消息已经进了 OctoClaw 可观察范围，但被错误绑定到 `octoclaw-subagent-*` 等内部 session” 则必须纳入主线修复

因此后续的 session-boundary hardening 属于主线整改，而不是再次把上游问题吞回 OctoClaw。

---

## 6. 新的阶段顺序（更贴近当前现实）

### Phase 1：收口运行时心智
核心问题：observer / patrol / runner / ctl 的统一边界

### Phase 2：统一反馈闭环
核心问题：replay / review / validate / promote / learning 的一体化

### Phase 2.5：收口可拆分 router core
核心问题：signal / route / budget / model-intel 的边界与自动更新机制

### Phase 3：收口 IM / display 产品面
核心问题：channel capability、anchor/update/action 统一语义

### Phase 4：做 substrate-first 清理
核心问题：减少平行真相层与 legacy 依赖

### Phase 5：压缩常驻件与重 backend 依赖
核心问题：让默认路径更轻、更稳、更少历史包袱

---

## 7. 维护规则

以后如果新增重要实现，不要再先写一个新的平级“总纲”。优先问：

- 这是在补哪条主线？
  - runtime mind
  - feedback loop
  - IM/display
  - substrate convergence
  - backend simplification

然后更新这两份 canonical docs：

- 总体判断变化 → `octoclaw-design-foundation.md`
- 优先级变化 → `octoclaw-execution-plan.md`

专题笔记可以继续写，但默认进入 supporting/archive 层，而不是再次成为根目录 source of truth。
