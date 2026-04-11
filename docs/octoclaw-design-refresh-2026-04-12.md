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
- patrol / runner shell loop / cron / systemd 已在设计上降成 compat-only。

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

虽然最近已经从 `patrol.py` 迁成 `lib/patrol/__init__.py`，但当前代码现实仍然是：

- `lib/patrol/__init__.py` 仍有 `5816` 行
- patrol 相关逻辑仍混有大量 legacy compat、修复、通知、分类、观察职责

这说明：

- “patrol package 化”已经发生
- 但“patrol 依赖真正从默认主链退出”还没有完全做到

短期不一定要为了“拆文件而拆文件”立刻做一次大切分，但必须先收掉两件事：

1. 默认运行面不再依赖 patrol 常驻
2. patrol 只保留 reconcile / repair / notify coordinator 角色

### 3.2 install / ctl 的默认运行面还不够瘦

当前代码里仍能看到较重的 legacy compat 面：

- `install.sh` 仍保留 `patrol-loop`、`runner-daemon`、cron 注册、systemd 模板、tmux 托管分支
- `bin/octoclawctl.sh` 仍保留大量 patrol/runner compat target

这不一定意味着现在默认行为已经完全错误，但它至少说明：

- 默认运行面与 compat 运行面还没有彻底分层
- 维护者仍然容易把 legacy 控制路径当成推荐路径

### 3.3 真实 Slack E2E 还不够“生产验收级”

`lib/slack_e2e_acceptance.py` 当前只有 3 个 smoke 场景：

- `fresh_live_lookup`
- `provenance_followup`
- `local_surface_lookup`

缺的正好是最影响真实体验的三类：

- `plain_chat`
- `execution_followup` 的任务判定问句
- `delegated_work`

而且目前 harness 还没有自动验证：

- provenance 回答内容是否真的匹配 ledger
- 真实 fast ACK 是否符合目标
- delegated work 的 pre_dispatch_ack / progress / final 三段链路是否完整

### 3.4 安全收口还不能算完成

从 Slack acceptance 文档与 verification 结果看，短期仍然存在两类上线风险：

- `groupPolicy=open` 仍未收成 allowlist
- Slack-facing tool exposure 仍需更保守的 profile/allowlist

这说明：在“更快/更省/更好”之外，**更可控** 仍然是短期主线的一部分。

---

## 4. 哪些短期计划是“本来就该做，但现在还没做完”

### 4.1 第一优先级：默认运行面收口

这条线是短期最值钱的技术债，优先级高于继续加 router 小功能。

短期要完成的不是“再给 patrol 加能力”，而是：

1. 把 patrol 从默认运行面彻底降成按需 reconcile/repair 工具
2. 把 install/ctl 的默认路径收成 gateway + Node runtime extension + optional backend
3. 把 compat 路径和推荐路径彻底分开

这里的关键不是“把 patrol 拆成更多小文件”本身，而是：

- 是否继续让 patrol 成为默认依赖
- 是否继续让 install/ctl 暗中维持旧 loop 心智

### 4.2 第二优先级：真正的生产级自动化 E2E 验收

这是目前最需要从“工具”升级成“系统”的一条线。

建议目标：

1. 单独 Slack bot / 单独测试 workspace 或测试 channel
2. 单独 acceptance agent/session，不复用主生产会话
3. 覆盖完整 6 类核心句子
4. 不只统计 ACK/final timing，还要校验内容正确性：
   - provenance 是否真实
   - follow-up 是否绑到正确 execution ledger
   - delegated work 是否真的 materialize
5. 失败结果自动沉淀成：
   - fixture
   - acceptance report
   - 可选 issue / backlog item

这里更接近 Anthropic 笔记里的 `eval + postmortem discipline`，而不是“写一个临时 smoke 脚本”。

### 4.3 第三优先级：Slack/IM 安全与投递策略收口

短期必须完成：

1. `groupPolicy=open -> allowlist`
2. Slack-facing tool exposure 收紧
3. 明确哪些 surface 允许：
   - plain chat
   - local surface lookup
   - fresh live lookup
   - delegated work
4. 让 acceptance harness 能把安全配置也一并检查

### 4.4 第四优先级：把 GitHub CI/CD 变成真正的 rollout gate

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

### 4.5 第五优先级：IM / display 产品化，而不是继续停留在 baseline

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

### 4.6 需要后移的，不要抢到前面

以下内容值得做，但不应排到短期核心之前：

- `Decision cache`
- `cheap/local shadow ledger`
- `cheap/local partial rollout`
- `spawn_multi` 进一步产品化
- Anthropic 风格的 advisor / consultant mode

这些都应建立在：

1. K1 judge cascade 结构稳定
2. 默认运行面收口
3. 真实 Slack 生产验收闭环成立

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

---

## 6. 更新后的推荐阶段顺序

### Phase A：默认运行面收口

目标：让系统“默认更小、更真、更少旁路”。

优先做：

1. patrol 角色收缩与依赖剥离
2. install / octoclawctl 默认路径收瘦
3. compat-only 与 recommended path 明确分层

### Phase B：真实生产验收与安全闭环

目标：让“体验好”变成可测事实。

优先做：

1. dedicated Slack acceptance bot / channel / session
2. 6 个核心句子全覆盖
3. provenance/follow-up 内容断言
4. allowlist + tool exposure 收紧
5. 自动沉淀 bad case 与 issue/backlog

### Phase C：CI/CD rollout gate

目标：把本地测试、nightly、acceptance、artifact 沉淀收成默认工程纪律。

优先做：

1. PR quick gate
2. nightly full gate
3. acceptance/shadow/failure artifact upload
4. issue/backlog integration

### Phase D：IM / display 产品化

目标：把 baseline capability 收成用户感知一致的产品行为。

优先做：

1. status panel on demand
2. per-IM capability-aware rendering
3. anchor / update / final / fallback 统一语义

### Phase E：K1 后续性能与成本深化

目标：在稳定主链上继续降成本、降抖动。

优先做：

1. Decision cache
2. cheap/local shadow ledger
3. cheap/local partial rollout

### Phase F：探索项

目标：只在前四阶段稳定后再扩。

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
