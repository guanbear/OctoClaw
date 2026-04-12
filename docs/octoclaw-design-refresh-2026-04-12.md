# OctoClaw 设计刷新（2026-04-12）

> 用途：基于 2026-04-08 之后的代码与文档更新，重新判断 OctoClaw 的短期主线、设计边界与优先级。  
> 关联文档：
> - [octoclaw-design-foundation.md](./octoclaw-design-foundation.md)
> - [octoclaw-execution-plan.md](./octoclaw-execution-plan.md)
> - [octoclaw-router-policy-refactor-2026-04-10.md](./octoclaw-router-policy-refactor-2026-04-10.md)
> - [octoclaw-router-policy-refactor-plan-2026-04-10.md](./octoclaw-router-policy-refactor-plan-2026-04-10.md)
> - [octoclaw-refactor-acceptance-audit-2026-04-11.md](./octoclaw-refactor-acceptance-audit-2026-04-11.md)
> - [octoclaw-slack-production-acceptance-2026-04-11.md](./octoclaw-slack-production-acceptance-2026-04-11.md)
> - [octoclaw-slack-acceptance-results-2026-04-12.md](./octoclaw-slack-acceptance-results-2026-04-12.md)
> - [octoclaw-code-audit-2026-04-12.md](./octoclaw-code-audit-2026-04-12.md)
> - [octoclaw-runtime-slimming-plan-2026-04-12.md](./octoclaw-runtime-slimming-plan-2026-04-12.md)
> - [archive/design-notes/octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.zh-CN.md](./archive/design-notes/octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.zh-CN.md)

---

## 1. 这次刷新要回答什么

当前问题已经不是“OctoClaw 方向对不对”，而是：

1. 文档已经很多，但 2026-04-08 之后的 hardening、验收、judge cascade、Node bridge、patrol package、Slack acceptance 结果没有被重新收成一份清晰优先级。
2. 主设计稿与执行计划仍保留 2026-04-07 的口径，容易让后续判断继续围绕旧阶段推进。
3. 用户目标已经更明确：
   - 更快
   - 更省
   - 体验更好
   - 先把核心主链做扎实，再做 IM/UI 产品化，再做探索类能力

这份刷新稿的目标不是重开新方向，而是重新压缩主线。

---

## 2. 这轮 review 的核心结论

### 2.1 方向没有跑偏，但短期主线要重排

目前代码与文档共同说明：

- `policy-first / workflow-first / substrate-first / harness-layered` 这条大方向仍然正确。
- `main-grade stateless judge + validator + route contract + execution ledger + delivery relay` 仍然是对的主链。
- `IM/display` 已经不是“未来才开始”，但也还不该压过核心 runtime/acceptance 收口。

真正需要调整的不是方向，而是优先级：

1. **先收默认运行面**
2. **再补真实生产验收**
3. **再做 IM/display 产品化**
4. **最后再做 cost/speed 深化与探索项**

### 2.2 “更快 / 更省 / 体验更好”只达成了一部分

#### 更快：部分达成

已获得的进展：

- ACK / route / execution / delivery 已有明确 contract。
- Node runtime 已成为 live hot path 的权威方向。
- main-grade stateless judge 已经接通，不再只是配置占位。

仍未真正证明的点：

- 真实 Slack 链路的 fast ACK 还没有完整黑盒量化闭环。
- Slack E2E harness 目前只覆盖 6 个核心句子中的 3 个。
- provenance/follow-up 的内容正确性还没有由 harness 自动判定。

#### 更省：部分达成

已获得的进展：

- 设计已经明确 cheap/local judge 不应盲目上 live。
- runtime 正在收缩为 Node-first hot path，Python 更多退回 offline/reporting。
- patrol / runner shell loop / cron / systemd 已明确不应继续作为默认主链。

仍未真正达成的点：

- 便宜模型/本地模型还没有进入受控 shadow/live rollout。
- Decision cache 还不该现在单独推进，但也还没有在 K1 之后接入。
- 默认安装与运维面仍保留大量 legacy compat 逻辑，拖高了维护和理解成本。

#### 体验更好：部分达成

已获得的进展：

- follow-up grounding、delivery relay、snapshot 读面、IM anchor baseline 都明显进步。
- IM capability matrix、action taxonomy、display contract 已有基础。

仍未真正达成的点：

- 真实 Slack 生产验收没有形成稳定的自动化闭环。
- IM 体验仍偏“基础可用”，还没有形成产品级的一致交互层。
- status/details/retrieve 虽然已经有 contract，但“按需弹出状态面板”的体验还没有被明确产品化。

---

## 3. 当前最值得正视的代码事实

### 3.1 patrol 仍然太重

runtime slimming 第一拍已经落地，但 patrol 本体仍然很重。当前代码现实仍然是：

- `lib/patrol/__init__.py` 仍有 `5911` 行
- patrol 相关逻辑仍混有修复、通知、分类、观察与部分 legacy 收尾职责

这说明：

- “patrol 退出默认常驻主链”已经完成第一拍
- 但“patrol 剩余职责已经足够窄、足够清晰”还没有完全收尾

短期不一定要为了“拆文件而拆文件”立刻做一次大切分，但必须先收掉两件事：

1. 默认运行面不再依赖 patrol 常驻
2. patrol 只保留 reconcile / repair / notify coordinator 角色

### 3.2 install / ctl 的默认运行面还不够瘦

runtime slimming 第一拍已经把正式推荐路径切成了单一路径，但代码层仍能看到一些残余符号与辅助运维分支：

- `install.sh` 已显式标注 legacy loop / daemon / cron / systemd 被移除，但仍保留少量 cron/nightly/辅助脚本相关逻辑
- `bin/octoclawctl.sh` 的默认帮助已经切到单一推荐路径，但文件内部仍保留 systemd/tmux/shell 等控制分支和部分旧变量

这不表示默认路径切换失败，而是说明：

- “默认推荐路径”已经切换成功
- 但 install / ctl 的内部实现和 operator 心智还没有完全收成只围绕单一路径思考

### 3.3 真实 Slack E2E 还不够“生产验收级”

`lib/slack_e2e_acceptance.py` 已经不再只是 3 个 smoke case 的最小脚本。

当前它已经支持：

- `smoke` / `core6` / `acceptance` 三档 preset
- 显式绑定 `session_key / target / native_channel_id / thread_id`
- 独立 acceptance bot/channel 的黑盒验收，不再只依赖“最近 Slack session”
- 基础内容断言
  - provenance 回答禁止泄露 `route 判定 / spawn_single / playbook` 等内部中间态
  - `Control UI` 类回复要求带出地址形态
- `replay_source` 描述骨架，允许把 macmini / VM 的真实 session bundle 挂进同一份报告

但它还没有完全达到“生产级系统”：

- 真实 fast ACK 仍主要是时序观测，不是全链严格证明
- delegated work 的 `pre_dispatch_ack / progress / final` 还需要更细的内容断言
- macmini/VM 回放验收目前只是统一报告入口，还不是完整 replay scheduler
- black-box 与 replay 两条线还没有完全收成一个 nightly / CI gate

### 3.4 安全收口还不能算完成

从 Slack acceptance 文档与 verification 结果看，短期仍然存在两类上线风险：

- `groupPolicy=open` 仍未收成 allowlist
- Slack-facing tool exposure 仍需更保守的 profile/allowlist

这说明：在“更快/更省/更好”之外，**更可控** 仍然是短期主线的一部分。

### 3.5 单条长消息的 compound request 还没有进入 live 主链

当前系统已经具备一些重要底座：

- queued burst 的基础 decomposition
- runner queue / worker health / backpressure
- native task lineage / parent-child 聚合
- `spawn_multi` 的线性 flow

但它还不能把一条单句自然语言稳定编译成多个带依赖关系的 work item。

例如：

> “早上好，你是啥模型，请帮我查下 openclaw 的最新版本。如果有新版本帮我更新下”

目标态应该是：

1. `direct`：问候与本地事实
2. `runner`：远端 release 查询
3. `guard`：比较本地与远端版本
4. `spawn_single`：只有 guard 成立时才执行更新

当前 live path 仍主要假设“一个 turn 选一个主 route”，busy burst 的拆分只是一个局部 baseline，不是目标态。

这意味着下一阶段最核心的设计工作，不是再继续扩关键词规则，而是：

- 让模型输出结构化 work items / `depends_on` / `guard`
- 让代码只做 validator / materializer / scheduler / execution facts
- 让 provenance/follow-up 只认最终 execution ledger

但这里也必须明确：

- planner 是 **按需升级路径**
- 不是所有请求都默认进入 planner

也就是说：

- 单意图、无依赖、无条件、无多-lane 混合的简单请求，目标态仍应走 simple route
- 但“是否进入 planner”，不再由规则 gate 判定，而由模型统一输出：
  - `decision_mode = simple_route`
  - 或 `decision_mode = compound_plan`

---

## 4. 哪些短期计划是“本来就该做，但现在还没做完”

### 4.1 第一优先级：runtime slimming 第一拍后的残余验收与收尾

这条线今天已经完成第一拍实现，但还需要把“代码落了”真正变成“默认运行面已经稳定切换”。

短期收尾重点是：

1. 确认 patrol 只剩 `observe-once / reconcile-once / repair-once`
2. 确认 install / ctl / docs / acceptance 都只围绕单一路径描述
3. 把残余的 runtime/auxiliary helper 区分清楚，不再让 operator 把它们误读成第二条正式主链

这里的关键不是继续扩 patrol，而是确认：

- 默认运行面是否真的已经不依赖 patrol 常驻
- install / ctl 是否真的不再暗中维持旧 loop 心智
- 辅助脚本是否已经从“默认运行依赖”退成“可选运维资产”

### 4.2 第二优先级：compound request 与 dependency-aware execution

这是当前最核心、也最容易继续出“看起来像修好了，实际还会错”的功能缺口。

短期要完成的不是继续补 route case，而是：

1. 把单条长消息从“一个 turn 一个主 route”升级成“一个 turn 一个 work plan”
2. 让模型输出结构化 work items：
   - `intent_class`
   - `lane`
   - `goal`
   - `depends_on`
   - `guard`
3. 让代码只做：
   - validator
   - materializer
   - scheduler
   - execution fact grounding
4. 让 provenance/follow-up 只认最终 execution ledger，不再解释 route 中间态

同时要明确 simple / compound 的目标边界：

1. `decision_mode = simple_route`
   - 单一闲聊
   - 单一本地查询
   - 单一远端查询
   - 单一 delegated work
   - 单一 follow-up / provenance 问句
   - 这类请求由模型直接给出单 route 决策
2. `decision_mode = compound_plan`
   - 一句里有多个动作目标
   - 同时包含 `direct / runner / spawn` 候选
   - 有条件关系：如果……就……
   - 有顺序关系：先……再……
   - 有依赖关系：查完 X 再做 Y
   - 这类请求由模型输出结构化 work plan

这里直接对应今天反复暴露的问题：

- mixed-intent 单句会被压成一个主 route
- delegated lane 没 materialize 也可能被说得像已经执行了
- “你是怎么查的”还会选择性相信 route/judge 中间态

### 4.3 第三优先级：真正的生产级自动化 E2E 验收

这是目前最需要从“工具”升级成“系统”的一条线。

建议目标：

1. 单独 Slack bot / 单独测试 workspace 或测试 channel
2. 单独 acceptance agent/session，不复用主生产会话
3. 覆盖完整 6 类核心句子，再扩到 compound request / dependency 场景
4. 不只统计 ACK/final timing，还要校验内容正确性：
   - provenance 是否真实
   - follow-up 是否绑到正确 execution ledger
   - delegated work 是否真的 materialize
   - compound request 是否按依赖顺序执行
5. 失败结果自动沉淀成：
   - fixture
   - acceptance report
   - 可选 issue / backlog item

当前实现阶段可以拆成两条并行轨：

1. `acceptance-blackbox`
   - 独立 Slack bot / channel / session
   - 核心句子 + compound request 黑盒验收
2. `acceptance-replay`
   - macmini / VM 的真实 session / replay / task-state bundle
   - 用统一报告结构做回放校验与坏例沉淀

这里更接近 Anthropic 笔记里的 `eval + postmortem discipline`，而不是“写一个临时 smoke 脚本”。

当前推荐入口已经不再是手工分别跑多个小脚本，而是：

- `lib/slack_acceptance_suite.py`
  - 黑盒：调 `slack_e2e_acceptance.py`
  - 回放：消费 macmini / VM bundle，并串起 `reply_review_packet + replay_validation + failure_summary`
  - 统一产出 suite report / summary
- `bin/bootstrap-acceptance-runtime.sh`
  - 在 workspace 下自举隔离的 acceptance `OPENCLAW_HOME + WORKSPACE`
  - 复制主 auth/model 基础文件，但把 Slack bot/app token 注入到 acceptance config
  - 让 black-box 与 replay 可以落到同一套 acceptance runtime

### 4.4 第四优先级：Slack/IM 安全与投递策略收口

短期必须完成：

1. `groupPolicy=open -> allowlist`
2. Slack-facing tool exposure 收紧
3. 明确哪些 surface 允许：
   - plain chat
   - local surface lookup
   - fresh live lookup
   - delegated work
4. 让 acceptance harness 能把安全配置也一并检查

### 4.5 第五优先级：把 GitHub CI/CD 变成真正的 rollout gate

仓库里已经有基础 CI：

- [test.yml](../.github/workflows/test.yml)

当前它已经能跑：

- Python unittest 子集
- `harness_gate --preset full`

但这还不够。短期应该把 CI/CD 从“会跑测试”升级成“默认上线门槛”：

1. PR gate
   - quick harness
   - router/runtime/dispatch 关键测试
   - 基本 lint / schema / fixture sanity
2. nightly gate
   - full harness
   - replay/eval/nightly packet
   - shadow/judge 差异报告
3. acceptance artifacts
   - 上传 `harness_gate`、Slack acceptance、shadow report、failure summary
   - 让维护者不必手工去机器上翻日志
4. issue/backlog integration
   - 对稳定复现的 acceptance 失败自动沉淀 issue 或 backlog entry
   - 至少先做到标准化 failure artifact，而不是临时口头记录

这条线的意义不是“为了像正规项目一样有 CI”，而是：

- 把 rollout gate 固化
- 把验收结果沉淀成可追踪资产
- 让 bad case 更快进入 fixture / replay / issue

### 4.6 第六优先级：IM / display 产品化，而不是继续停留在 baseline

这条线不该再被当成“还没开始做”，但也不该压过核心 runtime/acceptance。

短期最值得做的 IM/UI 内容是：

1. **status panel on demand**
   - 默认消息保持轻量
   - 需要时再展开 status/details/retrieve/review
2. **per-IM capability productization**
   - Slack / Discord / Telegram / Feishu / WhatsApp 不同能力矩阵的统一表达
3. **一致的 anchor/update/final 语义**
   - 避免某个 IM 看起来像“任务完成了”，实际只是 anchor edit

也就是说，IM/UI 下一阶段的主题不是“再证明 IM 很重要”，而是：

- 把 capability matrix 变成用户感知到的一致产品行为
- 把状态面从“很多命令/很多 surface”收成“按需出现的轻量操作面”

### 4.7 需要后移的，不要抢到前面

以下内容值得做，但不应排到短期核心之前：

- `Decision cache`
- `cheap/local shadow ledger`
- `cheap/local partial rollout`
- `spawn_multi` 进一步产品化
- Anthropic 风格的 advisor / consultant mode

这些都应建立在：

1. K1 judge cascade 结构稳定
2. runtime slimming 第一拍验收闭环成立
3. compound request / dependency-aware execution 基线成立
4. 真实 Slack 生产验收闭环成立

之后再推进。

---

## 5. 对当前设计稿的更新

### 5.1 现在的核心目标不是“继续证明 router 架构成立”

router / judge / materialization / delivery 这条核心架构已经基本成立。

现在更准确的近期目标应改成：

> **把默认运行面缩小，把真实生产验收做实，把 IM/display 从 baseline 做成产品层。**

### 5.2 patrol 的正确定位

更新后的定位应该是：

- patrol 不是默认运行时引擎
- patrol 不是 completion truth 的主合成面
- patrol 不是 ACK / final / provenance 的主路径
- patrol 是：
  - detect
  - reconcile
  - repair
  - notify coordination

也就是说，短期应优先减少对 patrol 的默认依赖，而不是继续把更多逻辑堆到 patrol 里。

### 5.3 acceptance 不再是“附属验证脚本”，而是核心系统

更新后的定位应该是：

- acceptance harness 是 production readiness 的一部分
- 所有 live 事故都应沉淀进：
  - golden
  - replay
  - smoke
  - acceptance
- 如果没有真实 IM 黑盒验收，不能宣称“体验已经好了”

### 5.4 IM / display 的正确定位

更新后的定位应该是：

- IM 仍然是 lightweight ops + notifications
- CLI 仍然是 canonical text operator surface
- Web/UI 仍然是未来更强 cockpit
- 但接下来该做的是：
  - capability-aware UX
  - on-demand status panel
  - per-surface fallback consistency

不是再扩一套重 UI，也不是把所有 IM 做成同一种富交互产品。

### 5.5 cost/speed 深化的正确顺序

更新后的定位应该是：

1. 先让 main-grade judge + runtime hot path + production acceptance 稳定
2. 再做 K1 后续：
   - Decision cache
   - cheap/local shadow
   - partial rollout
3. 最后再讨论进一步节省成本或更激进的 low-cost routing

这样做的原因很简单：

- 如果核心主链还没用真实 Slack 验收闭环证明稳定
- 提前切 cheap/local 或 cache，只会让问题更难诊断

### 5.6 compound request 的正确定位

更新后的定位应该是：

1. 这不是“更聪明的 route classifier”，而是“由模型统一决定 simple route 或 compound plan 的结构化工作计划”
2. 模型负责：
   - `decision_mode`
   - simple route 或 work-item decomposition
   - `lane`
   - `depends_on`
   - `guard`
3. 代码负责：
   - validator
   - materializer
   - scheduler
   - final execution facts
4. provenance/follow-up 只认最终事实，不再混用 intent / route / dispatch 中间态
5. 代码不再用语义 gate 决定“是否进入 planner”，只保留执行与安全硬约束

当前 busy burst decomposition 只是局部 baseline，不应被误当成这个目标已经实现。

同时必须坚持：

- planner 是 `on-demand upgrade`
- simple request 继续走单 route
- compound request 才进入 planner

否则会直接损失速度、成本和稳定性，也违背“更快 / 更省”的主目标。

---

## 6. 更新后的推荐阶段顺序

### Phase A：runtime slimming 第一拍验收与残余收尾

目标：确认系统已经“默认更小、更真、更少旁路”。

优先做：

1. 确认 patrol 只剩 one-shot 角色
2. 清理 install / ctl / docs / acceptance 中残余的双路径心智
3. 明确辅助脚本与默认运行面的边界

### Phase B：compound request 与 dependency-aware execution

目标：让单条长消息不再被压成一个主 route，而是稳定编译成带依赖的 work plan。

优先做：

1. 模型统一输出 `decision_mode = simple_route | compound_plan`
2. model-planned work-item decomposition
3. validator / materializer / scheduler contract
4. `depends_on` / `guard` 执行顺序
5. provenance / follow-up 只读 final execution facts

### Phase C：真实生产验收与安全闭环

目标：让“体验好”变成可测事实。

优先做：

1. dedicated Slack acceptance bot / channel / session
2. 6 个核心句子 + compound request 场景全覆盖
3. provenance/follow-up 内容断言
4. allowlist + tool exposure 收紧
5. 自动沉淀 bad case 与 issue/backlog

### Phase D：CI/CD rollout gate

目标：把本地测试、nightly、acceptance、artifact 沉淀收成默认工程纪律。

优先做：

1. PR quick gate
2. nightly full gate
3. acceptance/shadow/failure artifact upload
4. issue/backlog integration

### Phase E：IM / display 产品化

目标：把 baseline capability 收成用户感知一致的产品行为。

优先做：

1. status panel on demand
2. per-IM capability-aware rendering
3. anchor / update / final / fallback 统一语义

### Phase F：K1 后续性能与成本深化

目标：在稳定主链上继续降成本、降抖动。

优先做：

1. Decision cache
2. cheap/local shadow ledger
3. cheap/local partial rollout

### Phase G：探索项

目标：只在前五阶段稳定后再扩。

包括：

- `spawn_multi` 更强产品化
- advisor / consultant mode
- 其它非核心自治增强

---

## 7. 一句话结论

OctoClaw 现在最需要的不是继续展开新设计专题，而是：

> **先把默认运行面收小、把真实生产验收做硬、把 IM/display 做成一致产品层；在这之后，再做 cache、cheap/local、spawn_multi、advisor 这类深化或探索。**

如果一个改动不能直接帮助下面三件事之一，它就不该排到当前短期主线前面：

1. 默认运行面更小
2. 真实体验更可证明
3. IM/UX 更一致
