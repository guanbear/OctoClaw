# OctoClaw 执行计划

> 状态：当前 canonical 执行计划（2026-04-07）
> 优先级原则：**承认已完成的第一拍，在此基础上做收口和深化**  
> 关联文档：[`octoclaw-design-foundation.md`](./octoclaw-design-foundation.md)、[`octoclaw-transition-cleanup-design.md`](./octoclaw-transition-cleanup-design.md)、[`archive/design-notes/README.md`](./archive/design-notes/README.md)

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
- managed TaskFlow substrate for eligible delegation
- session resume context persistence
- runtime observer
- on-demand runner fallback
- patrol observation pass 收口
- unified `octoclawctl` control entrypoint
- delegated pre-dispatch ack baseline

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
- 明确 `runner = lane`、`daemon|ondemand = mode`、`status = observer view`
- 让 CLI help / README / canonical docs 都使用同一套角色定义

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
- 一套统一 feedback manifest / phase contract
- 每条工具在闭环中的角色说明
- promotion / validation / learning 之间的输入输出约定
- 明确哪些 nightly job 是核心，哪些只是辅助分析

### 为什么这是高优先级
因为“省钱”和“更稳”不应该只靠 intuition；这条线其实已经是 OctoClaw 的核心差异化之一。

---

## P2.5：把 router 核心收成可拆分 Auto Router

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
- `signal / route / budget / model_intel` 的 schema 草案
- model-intel 自动更新面
  - 价格
  - 能力画像
  - 健康/冷却
- OpenAI-compatible recommendation surface 草案
- 对应 canonical docs：
  - [`octoclaw-auto-router-design.md`](./octoclaw-auto-router-design.md)
  - [`octoclaw-auto-router-implementation-checklist.md`](./octoclaw-auto-router-implementation-checklist.md)
- internal-first implementation baseline：
  - `lib/auto_router.py`
  - `octoclaw_policy.build_decision().auto_router`

### 当前已落的 baseline（2026-04-07）
- `lib/auto_router.py` 已输出 internal-first recommendation payload
- `build_decision().auto_router` 已进入主策略决策对象
- route recommendation seam 已显式进入 policy/runtime 边界
- delegated pre-dispatch ack 已进入 runtime baseline

### 这条线的约束

- 不把 OctoClaw 完整 runtime 直接等同于 router
- 不要求现在就拆仓
- 不要求立刻变成通用 proxy
- 先把内部接口做干净，再考虑独立开源

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
- 当前 contract 文档：
  - [`octoclaw-im-display-contract.md`](./octoclaw-im-display-contract.md)
  - [`octoclaw-p3-p4-post-signoff-handoff.md`](./octoclaw-p3-p4-post-signoff-handoff.md)

### 当前状态（2026-04-07）
- P3 contract 已完成 signoff 并冻结：
  - surface ownership
  - interaction state machine
  - action taxonomy
  - capability matrix
  - accepted fallback / gap ledger
- 后续不应再回头重定义 P3 的角色边界，而应在既有 contract 下继续收口体验与验证

---

## P4：继续做 substrate convergence，但重点从“接入”转向“替换旧平行真相层”

### 当前状态
你已经把很多 substrate-aware 能力做起来了。

所以现在的重点不再是笼统写“接 OpenClaw tasks/flows”，而是：

- 哪些旧 mirror/legacy 记录还需要存在
- 哪些字段已经可以直接 substrate-first
- observer / display / retrieve / review 是否都优先消费 substrate-aware facts
- 哪些 fallback 还必须保留

### 近期目标
把“taskflow substrate 已接入”推进到“taskflow substrate 成为默认第一事实层”。

### 近期交付物
- substrate field inventory
- legacy mirror 依赖清单
- 哪些表面已完全 substrate-aware，哪些仍处于过渡态
- `spawn_single` 的 native-preferred create 路径
- simple `spawn_multi -> linear flow` 的收口路径
- legacy mirror / fallback 清理顺序

### 当前已落的 baseline（2026-04-07）
- `task_display_cli substrate` 已能输出 substrate inventory
- taskflow binding 已显式暴露 `create_preference / create_status`
- simple `spawn_multi` 已能通过 `step_order / step_task_ids` 在 graph/timeline 上形成 linear flow baseline
- taskflow mirror cleanup 已有 preview/apply contract，默认 retention `48h`
- managed TaskFlow substrate 已进入 delegation 主链
- `spawn_single` / `spawn_multi` 的 create posture 已冻结为 **native-preferred**
- P4 已按 **OpenClaw 2026.4.5 TaskFlow source semantics** 完成 closeout：
  - `display = substrate_first`
  - `retrieve = substrate_first`
  - `observer = evidenced_substrate_aware`
  - `review = evidenced_substrate_aware`
  - canonical read path 现在先读 `TaskFlow flow/task target + taskSummary + review surface`，再读 report/context

### 这条线现在最具体的推进顺序
1. 保持 `spawn_single` / `spawn_multi` 的 native-preferred create posture，不回退成 mirror-first
2. simple `spawn_multi`：继续按 linear flow 思路验证和收口，而不是回到并行 detached shell 心智
3. 清理 legacy mirror / compatibility fallback，只保留仍然有明确恢复价值的那部分
4. 更深的 substrate-only hardening 转入 `P5/P6`，不再作为 P4 exception ledger

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

### 实施原则

- 基于 **OpenClaw 2026.4.5** 的 runtime / TaskFlow 语义继续收口
- runtime hot path **优先 Node.js / JS**
- Python 优先用于 offline analysis / nightly / calibration / compatibility glue
- 不为“进程更少”而简化，而是为：
  - 降低状态漂移
  - 降低恢复复杂度
  - 降低 operator 心智负担

### 完成标准

P5 关单前，至少应满足：

1. `status / observe-once / runner-status / patrol-once` 读的是同一套 runtime truth
2. `RUNNER_MODE=ondemand` 可以作为主姿势通过 smoke
3. 没有常驻 runner 时，runner lane 仍可正常完成基础任务
4. patrol 重启不会导致真相层分叉
5. 维护者默认只靠 `octoclawctl` 就能完成日常观察与控制
6. patrol 不再像第二套 runtime engine，runner 也不再像默认真相源

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

### 设计约束

- 默认 surface 不把 heavy backend 当 primary identity
- `status / detail / retrieve / observer / notifier` 只把 backend 当 secondary operator hint
- 不显式启用 tmux / ClawTeam / resident runner 时，系统仍应呈现为完整主路径，而不是“降级模式”

### P6 子项

1. execution/operator surface backend-neutral 化
2. ClawTeam bridge / tmux workbench / resident runner optional 化
3. status / observer / display contract 口径同步
4. operator docs 与 ctl 心智同步

### 完成标准

P6 关单前，至少应满足：

1. 默认 runner / spawn surface 不再默认亮出 heavy backend 身份
2. 启用 ClawTeam / tmux / resident runner 时，surface 明确标为 `optional`
3. `status / observer / display / retrieve` 不再把 backend 当真相源
4. ClawTeam bridge 关闭时，默认主路径不受影响

### P6 之后的主线

`P4/P5/P6` baseline 与 macmini 实机验收通过后，后续主线顺序固定为：

1. **transition state 清理**
2. **router / model-intel 深化**

transition cleanup 的 focused design 见：

- [`octoclaw-transition-cleanup-design.md`](./octoclaw-transition-cleanup-design.md)

当前不再建议在这之前：

- 重开新的大设计专题
- 直接重写成全 Node/TS
- 提前拆独立 router 仓库
- 再扩新的 backend / cockpit

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
