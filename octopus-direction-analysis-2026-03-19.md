---
title: 八爪鱼方向分析（2026-03-19）
tags:
  - octopus
  - openclaw
  - multi-agent
  - model-routing
  - cost-optimization
  - performance
created: 2026-03-19
---

# 八爪鱼方向分析

## 结论先说

我的判断是：**八爪鱼这个项目方向是对的，而且有意义。**

但要把目标再收敛得更明确一些：

- **主方向**应该是“多 agent 编排带来的提效与分工”
- **辅方向**应该是“模型选择与成本控制”
- 不建议把八爪鱼做成一个纯模型路由器
- 也不建议做成一个固定 8 人常驻团队
- 最合适的形态是：**主调度 + 少量常驻快腿 + 大量临时子 agent**

如果只看你的核心诉求“降本 + 提效”，那我给的总判断是：

> **多 agent 优先，模型路由辅助；临时子 agent 为主，少量固定子 agent 为辅。**

---

## 一、这个项目方向对吗

### 1.1 方向是对的

八爪鱼解决的不是“OpenClaw 里还缺一个多 agent 皮肤”，而是一个更现实的问题：

- 主 agent 很贵，不能什么事都自己做
- 有些任务需要强模型，有些任务完全不需要
- 有些任务能并行，有些必须串行
- 有些任务只值 5 秒，有些任务值 5 分钟
- OpenClaw 的官方 sub-agent 能力有了，但在你现在的 Feishu / cron / isolated spawn 现实环境里，仍然不能直接变成“低延迟长期线程团队”

所以你做的事情，本质上是在补一层 **“面向真实工作流的调度层”**：

- 任务拆解
- 角色分工
- 模型分配
- 状态落盘
- 巡逻补救
- 成本控制
- 通知与回传

这层是有价值的，尤其是在中文开发、飞书/企业场景、多套餐混用、对子任务模型成本敏感的前提下。

### 1.2 为什么它有意义

它的意义不只是“多 agent 很酷”，而是它踩中了三个真实痛点：

1. **成本痛点**
   单一主模型全包时，很多 trivial / simple / runner 任务是在浪费高价模型额度。

2. **速度痛点**
   用户感知的慢，经常不是“推理慢”，而是：
   - 主 agent 阻塞
   - 不该 spawn 的任务也 spawn 了
   - 快任务每次都重新冷启动

3. **工程痛点**
   真实工作流不是一次问答，而是：
   - 查资料
   - 改代码
   - 跑命令
   - 验证
   - 汇总
   - 失败重试

单纯模型切换解决不了这三个问题，只能解决其中一部分账单问题。

---

## 二、和“纯模型路由”相比，你的方向对不对

### 2.1 你的判断，大体是对的

你对 `ClawRouter`、`NadirClaw` 这类方案的担心，**整体是成立的**，只是需要更精确一点：

它们确实能降本，但通常更适合：

- 单 agent / 单会话
- 英文提示词占主流
- 统一 API 计费口径
- 用户愿意把“主模型人格与能力波动”交给路由层处理

而你的场景不是这样。你更像：

- 中文任务很多
- 企业 IM / 飞书强相关
- 开发任务和命令任务混合
- 模型计费方式不统一
- 你很在意主 agent 的“稳定手感”
- 你还想同时提速，而不是只省钱

### 2.2 纯模型路由的优点

`ClawRouter`、`NadirClaw` 这类方案的优点很明确：

- 接入成本低，通常只要替换 base URL
- 对已有工作流侵入小
- 对简单请求能快速降本
- 常带 fallback、缓存、可观测性
- 对“一个 agent 打天下”的用户很友好

其中：

- `ClawRouter` 明确主打按成本、延迟、能力打分，并支持缓存、回退和本地/快速判断
- `NadirClaw` 明确主打“把简单请求自动下放到便宜模型”，并且带请求日志、成本与延迟观测

参考：

- [ClawRouter](https://clawrouter.app/)
- [BlockRun ClawRouter](https://blockrun.ai/products/clawrouter)
- [NadirClaw](https://getnadir.com/)

### 2.3 纯模型路由的局限

但对你来说，纯模型路由有 6 个结构性局限。

#### A. 它只解决“这次调哪个模型”，不解决“这次该不该拆任务”

这是最核心的一点。

路由器通常只在一条请求内做：

- 分级
- 选模
- fallback

但它不负责：

- 把调研和编码拆开
- 让 runner 单独跑
- 让 review 独立进行
- 让失败任务重派
- 用不同角色并行工作

而你的收益大头，恰恰来自这些事情。

#### B. 中文、混合任务、企业语境下，分类误判风险更大

很多路由器对外宣传的 routing classifier，往往是：

- 规则
- 关键词
- 本地 judge
- 小样本 eval

这在英文泛化请求上通常够用，但在中文开发任务里，分类更容易出问题：

- “帮我看一下”可能是简单问答，也可能是复杂排障
- “顺手改一下”在真实代码里可能是多文件重构
- “查一下配置”有时只是 grep，有时需要 SSH + curl + 代码追踪

你说“对中文支持不好”，我认为这不是一定指“中文不能用”，而是：

> **中文和企业开发语境更容易让复杂度分类失真。**

这个判断是对的。

#### C. 主模型频繁切换会带来“智商变换感”

这个说法很形象，也基本成立。

“智商变换”本质上是：

- 同一个会话里，模型风格和能力突然变化
- 用户对主 agent 的预期不稳定
- 同样一句话，不同回合可能被不同模型理解

这会带来：

- 解释风格漂移
- 工具使用偏好变化
- 代码质量忽高忽低
- 对长任务的连贯性伤害

如果是主 agent 直接被路由器频繁换模型，这个问题会很明显。

#### D. 缓存命中会被模型切换和上下文差异稀释

你的判断也是对的。

响应缓存和上下文缓存都很依赖：

- 请求结构稳定
- 模型稳定
- 上下文差异小

一旦：

- 每轮模型不同
- 任务被重新分类
- 上下文拼装方式不同

缓存收益就会变差。

这点在你的场景里尤其重要，因为你已经明确提到：

- 大模型本身有缓存能力
- 命中缓存时，成本可能显著下降
- 有时缓存收益可以接近“比原价便宜很多”

因此，纯模型路由会面临一个很容易被忽略的真实问题：

> **便宜模型的单次调用价格更低，不代表整体成本一定更低。**

如果一个主模型本来能稳定复用：

- system prompt
- AGENTS 规则
- 技能说明
- 重复性工作流上下文

那么它的缓存命中率可能很高。

而一旦路由层频繁切换模型：

- 缓存通常不能跨模型复用
- provider / 版本不同也常常不能复用
- prompt 形态被 classifier 改写后也可能失配

结果就是：

- 表面上把请求降到了便宜模型
- 实际上却丢掉了原本的缓存折扣
- 总账不一定更省，速度也不一定更快

这会进一步支持一个结论：

> **主 agent 尽量稳定，子 agent 再做多模型分流，通常比“主 agent 每轮自动换模型”更适合你的场景。**

#### E. 计费单位不统一时，很多“自动最优”是假最优

你的套餐就很典型：

- `GLM-4.7 Coding Lite` 更像订阅 + prompt 配额
- `MiniMax M2.7 Plus-极速版` 更像订阅 + request 配额
- `ChatGPT Plus + Codex` 更像 seat 型能力额度
- 额外 token 包模型更像一次性流量包，不适合当长期自动路由基准

纯路由器大多默认按 `$/1M tokens` 思考。

但你这不是一个统一 token 市场，直接按公开单价路由，常常会错。

#### F. 它不能解决快任务冷启动

这是对八爪鱼最关键的一条。

即使路由器把一个任务从贵模型降到便宜模型，它也没解决：

- 你还要不要 spawn
- spawn 本身的 5-15 秒冷启动怎么办
- runner 这类任务能不能复用

所以“路由降本”不等于“工作流提速”。

### 2.4 但模型路由不是没用

我不建议你把模型路由当主产品方向，但我也不建议你完全排斥它。

更合理的定位是：

> **把模型路由降格成八爪鱼内部的一项能力，而不是八爪鱼本身。**

也就是：

- 主产品：多 agent 调度器
- 子能力：自动选模 / 成本控制 / fallback

这样它就不会主导你的架构，也不会把主 agent 的稳定性拖下水。

---

## 三、和“多 agent 开源项目”相比，你的项目处在什么位置

### 3.1 官方 OpenClaw 能力

官方现在已经有：

- `/subagents spawn`
- `/subagents list`
- `/subagents send`
- `/subagents steer`
- `sessions_spawn`
- `thread: true + mode: "session"` 的 thread-bound session
- 共享 skills：`~/.openclaw/skills` 与 `skills.load.extraDirs`

但也有重要边界：

- 官方文档明确写了 **thread-bound subagent sessions 目前只有 Discord 支持**
- `sessions_spawn` 仍然是非阻塞提交
- announce 回传是 best-effort

这意味着：

- 官方能力已经比你早期调研时更强
- 但在你的 Feishu / cron / isolated spawn 现实场景里，**官方能力还没有直接替代八爪鱼**

参考：

- [OpenClaw Skills](https://docs.openclaw.ai/tools/skills)
- [OpenClaw Sub-Agents](https://docs.openclaw.ai/tools/subagents)
- [OpenClaw Tools](https://docs.openclaw.ai/tools)

### 3.1.1 哪些能力不需要 Discord，哪些基本需要

这里需要把“官方已经支持”和“你当前能否充分用上”拆开看。

#### 不需要 Discord 的

这些能力本身和 channel 没有强绑定，理论上可以直接纳入八爪鱼现有架构：

- `sessions_spawn`
- `/subagents spawn`
- `/subagents list`
- `/subagents send`
- `/subagents steer`
- `sessions_list`
- `sessions_history`
- 共享 skills：`~/.openclaw/skills` 与 `skills.load.extraDirs`

#### 基本需要 Discord 的

这些能力和 thread binding 关系很强，目前官方重点支持在 Discord 上：

- `thread: true`
- `mode: "session"`
- `/focus`
- `/unfocus`
- `/agents`
- `/session idle`
- `/session max-age`

也就是说：

- **不用 Discord，也能吃到一部分 sub-agent / session 能力**
- **但如果想充分用到持久子会话和 thread-bound follow-up，目前基本还是要靠 Discord**

这也是为什么八爪鱼现在不能简单“切到官方原生模式”就完事。

### 3.2 社区项目分成三类

#### 第一类：模型路由器

代表：

- `ClawRouter`
- `NadirClaw`

特点：

- 接入快
- 降本强
- 对单 agent 最友好
- 但不解决复杂工作流的拆解与补救

适合作为八爪鱼的“子模块”，不适合作为八爪鱼的最终形态。

#### 第二类：多 agent 模板 / 多 persona 团队

代表：

- `openclaw-agents`
- `openclaw-multi-agent-kit`
- 各类 Telegram / 群协作模板

特点：

- 很适合快速搭一个“团队”
- 角色多，演示效果好
- 适合内容生产、群聊分工、Bot 协作

局限：

- 默认角色往往偏多
- 持久团队心智明显
- 协调成本不低
- 不一定适合“ coding + runner + review + patrol ”这种工程工作流

对你来说，这类项目最大的价值是：

- 借角色边界
- 借目录结构
- 借 prompt 组织

而不是照着搭成 9 个常驻 agent。

可参考：

- [OpenClaw 多 Agent 架构与 Telegram 分工实践](https://tenten.co/learning/openclaw-multi-agent/)

#### 第三类：编排 / DAG / 状态机型 skill

代表：

- `team-tasks`
- `division`
- `agent-team-orchestration`

特点：

- 更重视任务生命周期
- 更重视 handoff、review、依赖管理
- 更接近真正的“调度器”

这类项目和八爪鱼最像。

但它们常常默认更理想的前提：

- session 管理更完整
- worker 通讯更顺滑
- channel 更适合持续协作

你的现实约束更强，所以八爪鱼的差异化价值反而在于：

- **它不是方法论模板，而是把 workaround 落进了运行机制里**
- 例如：`task-state.json`、`patrol`、`queued deps`、失败重派、通知回传

### 3.3 八爪鱼相对这些项目的优势

我认为八爪鱼目前最有价值的，不是“角色更多”，而是下面 5 点。

#### A. 更贴真实成本结构

你不是抽象地做路由，而是在面对真实套餐：

- 月订阅
- seat
- request 配额
- token 包

这使得你的成本判断比很多开源 router 更接地气。

#### B. 更贴中文开发工作流

你要处理的是：

- 中文说明
- 企业群通知
- 开发排障
- shell / API / 文档混合任务

这和面向英文 demo 的 router / swarm 项目很不一样。

#### C. 更重异常恢复

很多多 agent 项目重“分工”，轻“收尸”。

八爪鱼相反，它很早就把：

- orphan
- ghost completion
- stuck
- queued deps
- failed retry

变成第一等公民。这个在真实工作流里非常重要。

#### D. 更适合和现有 OpenClaw 能力共存

你没有试图推翻官方，而是在官方边界内补缺：

- skills
- AGENTS.md 规则
- patrol
- model policy

这比很多“另起炉灶式” router 更利于长期维护。

#### E. 更接近“运营型系统”而不是“演示型团队”

很多项目更像 showcase：

- 10 个角色
- persona 很完整
- 群里很热闹

八爪鱼更像一套运营系统：

- 能不能可靠执行
- 能不能省钱
- 能不能发现坏任务
- 能不能通知

从你的诉求看，这条路更对。

---

## 四、固定子 agent、临时子 agent，还是两个都要

## 我的结论

**两个都要，但比例不是 5:5。**

更准确地说：

- **临时子 agent 是主力**
- **固定子 agent 只保留 1 到 2 个**

### 4.1 为什么不能全固定

全固定团队的问题是：

- 空闲也占上下文和运行资源
- 长期 session 容易上下文膨胀
- 角色多了以后协调成本上升
- 在你现在的通道能力下，持久会话未必天然顺滑
- 固定 8 个 worker 很容易变成“看起来很强，实际不划算”

如果你的目标是“省钱 + 提效”，这条路风险很高。

### 4.2 为什么也不能全临时

全临时 spawn 的问题你已经踩得很清楚了：

- 快任务冷启动慢
- runner 类任务被重复构造上下文
- 用户感知速度差
- 本来只值 2 秒的事情，被整成 10 秒

所以全临时也不对。

### 4.3 最适合你的组合

我建议这样分：

#### 固定

保留 1 到 2 个常驻执行面：

1. **主调度大脑**
   - 常驻
   - 负责拆任务、收结果、做升级判断

2. **快腿 runner**
   - 常驻
   - 负责日志、curl、grep、状态查询、轻脚本
   - 用队列轮询或等价机制复用上下文

如果飞书通知仍然要重度自动化，可以把“通知执行面”视作半常驻，但不一定要作为智能子 agent 独立存在。

### 4.3.1 固定 runner 的交互体验要求

常驻 `runner` 本身没有问题，问题通常出在“主 agent 到 runner 的交接体验”。

这块需要明确区分：

- **真实执行层**
  - 由常驻 `runner` 执行 shell/log/status/curl/grep 这类快任务
- **聊天呈现层**
  - 由主 agent 负责一句话收束和回复用户

如果只把任务异步丢给 `runner`，但不稳定把结果送回当前会话，用户会误以为“子 agent 让整体变慢了”。

所以固定 `runner` 要满足 3 条：

1. **快任务默认短等待**
   - 命中 `runner` 后，优先在当前回合等待一个很短的窗口拿结果
   - 能直接回结果就不要先发长前奏

2. **超时必须兜底回复**
   - 如果短等待拿不到结果，也必须明确告诉用户：
     - 已转后台执行
     - 可以用 `/octostatus` 查看

3. **归因必须基于 runtime 证据**
   - 不要让主 agent 自己猜“这次是不是主 agent 做的”
   - 应以 task-state / runner-queue / result 文件为准

也就是说：

- 固定 `runner` 是正确方向
- 但必须补齐“等待结果 + 超时兜底 + 正确归因”这层体验

#### 临时

这些全部建议保持临时 spawn：

- `fix`
- `test`
- `writer`
- `scout`
- `analyze`
- `power`

原因很简单：

- 它们是任务型，不是值守型
- 强依赖任务上下文
- 很适合按需换模型
- 空闲时不值得保活

### 4.4 这其实是业界更常见的组合

真正好用的 agent 系统，往往不是“所有 worker 都长驻”，而是：

- 一个稳定控制面
- 一个或少量稳定执行面
- 一批按需临时 worker

这比纯 swarm 更省钱，也比纯 one-shot 更快。

---

## 五、如果目标是降本和提效，应该把什么当主线

## 主线应该是多 agent，不是纯模型路由

这个判断我支持。

原因不是“模型路由不好”，而是它解决的问题太窄。

### 5.1 降本的真正来源

对八爪鱼来说，降本主要来自 4 件事：

1. **不该 spawn 的任务不 spawn**
2. **该拆开的任务拆给更便宜的 worker**
3. **快任务走便宜且快的执行面**
4. **高价模型只出现在高风险节点**

这 4 件事里，只有第 4 件是纯路由器真正擅长的。

### 5.2 提效的真正来源

提效主要来自 5 件事：

1. 主 agent 不阻塞
2. 可并行的任务并行
3. runner 不冷启动
4. 状态外置，不靠主模型记忆
5. 异常自动恢复

这 5 件事，几乎都属于多 agent 调度层，不属于路由器。

### 5.3 所以更准确的产品定位应该是

> 八爪鱼是一个“成本敏感的多 agent 编排器”，而不是“会多 agent 的模型路由器”。

这个定位更贴你的实际优势。

---

## 六、后面建议走什么方向

### 6.1 方向判断

建议走：

- **多 agent 编排主线**
- **自动选模辅助线**
- **少量常驻快腿**
- **任务状态机 + patrol 自愈**

不建议走：

- “全靠 router 自动选模型”
- “固定 8 个长期角色团队”
- “为了多 agent 而多 agent”

### 6.1.1 先在现有架构里补用官方通用能力

在我看来，八爪鱼下一步最值的，不是立刻改成 Discord-first，也不是推翻 `isolated spawn + task-state + patrol`，而是：

> **先在现有架构里把官方通用能力补用起来。**

最值得优先接入的是下面 4 类。

#### A. `sessions_list`

用途：

- 让 patrol 不只盯 `task-state.json`
- 主动感知哪些 session 还活着、哪些已经结束、哪些状态异常

收益：

- 更准确判断 orphan / ghost completion
- 少依赖单一文件状态
- 给“是否需要重派”提供更强证据

#### B. `sessions_history`

用途：

- 读取子 agent 最近真实输出
- 用于判断任务到底是正常收尾、卡住、还是已经报错

收益：

- 减少只靠 `status` 字段猜测任务命运
- 更容易做失败归因
- 更容易生成高质量 patrol 摘要

#### C. `/subagents send` / `sessions_send`

用途：

- 对已经存在的子 agent 会话补发说明
- 例如：纠偏、补充约束、收紧范围、要求输出更短、追加一条检查项

收益：

- 少一次完整重派
- 少一次冷启动
- 少一次重复上下文构造

即使暂时不全面转成持久子会话，这个能力也值得优先研究，因为它最接近你现在“发现问题后再重派”的中间态。

#### D. 共享 skills

用途：

- 把当前八爪鱼及相关 worker 能力更明确地放进共享 skill 目录
- 避免每个 workspace 复制一遍

收益：

- 多 agent 更容易共享同一套规范
- 维护成本更低
- 更贴近官方生态方向

### 6.1.2 更合理的演进顺序

如果目标是“充分利用官方能力，但不推翻现有系统”，我建议这样排顺序：

1. 先接 `sessions_list`
2. 再接 `sessions_history`
3. 再试 `/subagents send` / `sessions_send`
4. 同时把共享 skills 规范化
5. 最后才考虑 Discord thread-bound session 试验线

这样做的好处是：

- 不需要立刻换主通道
- 不需要一次性改写八爪鱼架构
- 可以先拿到最实际的诊断、补救和维护收益
- 后面如果验证 Discord thread bindings 值得，再单独加速

### 6.2 推荐路线图

#### 方向 A：把八爪鱼做成“工程调度器”

优先级最高。

继续强化：

- task-state
- queued deps
- retry / escalation
- patrol
- fast runner
- role-based model policy

这是最贴你的核心价值的。

#### 方向 B：把模型路由内化成能力，不做成主产品

继续保留：

- auto mode
- cost score
- local speed score
- benchmark / provider 情报

但让它服务于：

- `main`
- `runner`
- `fix`
- `analyze`

而不是让它直接控制整个系统人格。

#### 方向 C：从“8 个触手”收敛成“4 角核心”

更推荐的核心拓扑是：

- `router/planner`
- `runner`
- `builder/fix`
- `review/test`

其他角色保留为 label，而不是必须常态化存在。

#### 方向 D：逐步去飞书强依赖，但保留通知抽象

你的 `v1.2` 已经开始往这边走，这是对的。

后面建议：

- 飞书只是一个 backend
- 状态与调度不要绑定飞书
- 通知和执行分层

这样八爪鱼才更像 skill / runtime，而不是“飞书外挂”。

### 6.3 中长期形态

我最看好的终局不是：

- 一个超复杂的多 bot 群体

而是：

- 一个稳定主调度器
- 一个快腿执行面
- 一套可靠状态机
- 一层本地真实成本/速度感知
- 一批按需临时 worker

这套东西如果做扎实，竞争力会比“又一个 swarm 模板”强很多。

---

## 七、给你的最终建议

### 结论

你的大方向是对的，而且值得继续做。

但要避免两个偏航：

1. **不要把八爪鱼做成纯模型路由器**
2. **不要把八爪鱼做成固定 8 人常驻团队**

### 最推荐的定位

> **八爪鱼 = 面向中文开发与企业协作场景的成本敏感多 agent 调度器。**

### 最推荐的产品形态

> **八爪鱼主体做成 skill，运行时增强做成 plugin，最终采用混合形态。**

原因是：

- 八爪鱼最核心的价值仍然是编排规则、角色分工、spawn 规范、task-state 协议，这些都更像 skill
- 通知、测速、session 观测、runner 保活、价格与速度情报刷新，这些更像 plugin

也就是说，更合理的长期结构是：

- `octopus-skill`
  - 调度规则
  - 角色定义
  - handoff 规范
  - task-state 约定
- `octopus-runtime plugin`
  - notifier backend
  - session ops
  - runner service
  - model intel refresh
  - 配置与后台服务

如果只做 skill，会让越来越多运行时能力被迫塞进安装脚本和补丁里。

如果全做成 plugin，又会损失八爪鱼“工作流可理解、规则可改、skill 可复用”的优势。

所以混合形态是最稳的。

### 规则该放哪

这个问题后面会越来越关键。我的建议很明确：

- `AGENTS.md`
  - 只保留主 agent 每轮都必须看到的铁律
- `SKILL.md` / 共享 skills
  - 保留完整工作流、角色定义、spawn 规范、输出规范
- runtime/plugin
  - 逐步接管真正必须生效的规则

更适合迁到 runtime/plugin 的典型规则包括：

- task-state 状态机
- queued / deps 解锁
- steer / retry / escalate 恢复链
- session 观测
- session 权限探测与降级
- 常驻 runner 保活与轮换
- 自动选模候选池和评分
- 通知与状态渲染

一句话总结：

> **prompt 规则负责引导，runtime/plugin 规则负责兜底和强制执行。**

### 最推荐的架构

- 主调度常驻
- 快腿常驻
- 其他子 agent 临时 spawn
- 模型路由作为内部能力

### 为什么这条路最符合你的诉求

因为它同时兼顾了：

- **降本**：把高价模型留给高价值节点
- **提效**：把快任务从冷启动里解放出来
- **稳定**：保持主 agent 的手感一致
- **工程可控**：把状态、异常、重派变成显式机制

如果只用一句话评价：

> **你不是在做“另一个 OpenClaw 多 agent 模板”，你更像是在做一层真正面向生产工作流的调度操作系统。**

---

## 参考资料

### OpenClaw 官方

- [OpenClaw Skills](https://docs.openclaw.ai/tools/skills)
- [OpenClaw Skills Config](https://docs.openclaw.ai/tools/skills-config)
- [OpenClaw Sub-Agents](https://docs.openclaw.ai/tools/subagents)
- [OpenClaw Tools](https://docs.openclaw.ai/tools)
- [OpenClaw Discord thread bindings](https://docs.openclaw.ai/channels/discord)

### 路由器 / 降本方案

- [ClawRouter](https://clawrouter.app/)
- [BlockRun ClawRouter](https://blockrun.ai/products/clawrouter)
- [NadirClaw](https://getnadir.com/)

### 多 Agent / 社区实践

- [OpenClaw 单服务器多 Agent 架构 + Telegram 多对话分工实践](https://tenten.co/learning/openclaw-multi-agent/)
- [xmsumi: OpenClaw x 飞书 Multi-Agent 实战](https://www.xmsumi.com/detail/2535)

### 说明

- 上面对 `ClawRouter` / `NadirClaw` 的“中文复杂度分类、主模型智商变换、缓存命中被稀释”等判断，属于**基于其公开架构描述与典型 router 工作方式的工程推断**，不是这些项目官方明说的自述。
- 对“固定子 agent vs 临时子 agent”的结论，属于**结合 OpenClaw 当前通道能力边界与你现有八爪鱼实现的架构判断**。

`NadirClaw` 里最值得借的，不是“把所有请求交给代理层分类”，而是**预算防护模式**：

- 用 profile/模式表达预算倾向
- 检测 agentic / tool-heavy 任务，避免错误地下放到便宜模型
- 在预算紧张时自动降级、fallback、保护高价值任务

OctoClaw 更合理的借法是：

- 把预算防护接进 `model-plan-state.json`
- 把 `eco / balanced / premium / reasoning` 的思路接进 `octoclaw_route`
- 不只切模型，也切 route：
  - `direct`
  - `runner`
  - `spawn_single`
  - `spawn_multi`

也就是说，OctoClaw 借的是 `NadirClaw` 的预算防护思想，而不是退化成 proxy router。

---

## 补充一：模型分流方向校准

关于“模型分流到底该怎么做”，我的判断现在更明确：

- 八爪鱼**不应该**退化成一个纯代理层 router
- 八爪鱼应该继续坚持“**编排感知的模型分流**”

### 八爪鱼当前其实已经不是“纯关键词路由”

从当前实现看，八爪鱼现在已经是混合路由：

- **角色/层级硬规则**
  - `model-intel.py` 先按 `runner / fix / test / scout / writer / analyze / power / main` 角色打分，再映射到 tier
- **本地指标加权**
  - 已经纳入 `price / ttft / output_tps / reliability / role-fit`
- **描述启发式升级**
  - `resolve-model.py` 已经有一套带权重的关键词/语义近似规则，用于复杂度升级安全网

所以它不是：

- 纯关键字 router
- 纯 LLM classifier router
- 纯本地小模型 judge

而是：

> **角色硬规则 + 本地指标 + 轻量启发式升级**

这个方向我认为是对的。

### 和代理层 router 的本质差异

像 ClawRouter / NadirClaw 这类方案，更适合：

- 单 agent
- OpenAI-compatible 代理入口
- 想最小侵入替换 provider

它们擅长的是：

- 每次请求快速判断 cheap / strong / local
- 在代理层统一做 provider fallback

但它们天然不太擅长：

- 理解任务角色
- 利用任务依赖
- 结合 session 状态
- 保护主 agent 一致性与缓存命中

而八爪鱼的优势恰恰在这里。

一句话说：

> **代理层 router 优化“单次请求”；八爪鱼优化“整条任务链路”。**

### 本地小模型 judge 有必要吗

我的结论是：

- **现在不是必须**
- 以后可以做成可选增强，而不是主路径依赖

原因：

- 中文任务分类稳定性未必够
- 你已经非常在意主模型手感和缓存命中
- 多加一层本地 judge，本身也有“智商变换”和维护成本

如果后面真的要加本地小模型，我建议它只做：

- 任务家族分类
- 风险级别判断
- 是否属于 runner 候选

而**不要**让它直接决定具体模型。

具体模型选择仍应交给：

- 角色候选池
- 价格/速度/可靠性打分
- 本地 outcome learning

### 模型分流最推荐的 5 层结构

后面我最推荐把八爪鱼正式收敛成下面这条 pipeline：

1. **Hard gates**
   - 先按能力、隐私、预算、是否快任务做硬过滤
2. **Role defaults**
   - 每个角色先有默认候选池
3. **Heuristic uplift**
   - 用描述启发式做升级安全网
4. **Weighted scoring**
   - 用 `price + ttft + tps + reliability + role-fit` 决策
5. **Outcome learning**
   - 用真实成功率、重派率修正分数

这条路比“关键字 + 代理层切模型”更适合八爪鱼。

### 工程化实现建议：`octoclaw_route`

更稳的做法不是继续把“要不要分子 agent”留给主 agent 自己拍板，而是引入一个显式路由器：

> `octoclaw_route(task, metadata) -> direct | runner | spawn_single | spawn_multi`

它负责先做路由决策，再交给 `dispatch_task.py` 真正执行。

这里再补一个很关键的工程经验：

- `octoclaw_route` 只决定 **谁来执行**
- `dispatch_task.py` 负责把这个决定真正落地
- 对 `runner` 路径，不能继续要求主 agent 先自己拼 shell 命令
- 更稳的做法是加一层 **runner playbook**
  - `system_summary`
  - `service_health`
  - `local_file_probe`

这样自然语言的“本机检查”也能直接下沉到常驻 runner，而不是被迫回退成主 agent 亲自执行。

### 8.7 为什么不能只靠关键词，也不能全靠主 agent

OctoClaw 后面更合理的路，不是：

- 继续让主 agent 自己临场判断
- 也不是把 route 做成一张大关键词表

更稳的实现应该是：

1. **规则主判**
   - 基于执行信号判断：
     - 要不要工具
     - 是观察型还是实施型
     - 是否多步
     - 是否高风险
     - 是否会显著增加主上下文
2. **灰区任务再做轻量语义复核**
   - 只在不确定时才调一次便宜快模型
   - 只返回结构化 JSON，不做长推理
3. **最终 route 仍然由 OctoClaw 自己决定**
   - 规则
   - 语义复核
   - 本地健康状态
   - 套餐/预算状态
   - 本地速度

这和“纯模型路由器”最大的区别是：

- 模型在这里是**辅助判断器**
- 不是**最终裁判**

再往前推一步，OctoClaw 后续应统一采用“执行形态优先”的原则：

- **观察型工具任务**
  - 本机或远程都一样
  - 版本、端口、日志、服务状态、资源、健康检查
  - 默认优先 `runner`
- **实施型工具任务**
  - 改配置、改 cron、重启、部署、迁移、修复
  - 默认优先 `spawn_single`

这样才能避免：

- “查 macmini 版本”被主 agent 自己吞掉
- “给我一句总结”这种输出要求，把观察任务错误抬成写作/子任务

### 8.8 为什么 `router` 也该单独选快模型

如果灰区任务要做语义复核，最大的风险不是“语义不够强”，而是：

- 路由本身太慢
- 本来想提效，结果在路由层又多等一轮

因此 OctoClaw 需要把 `router` 这个角色单独建模：

- `runner`
  - 优先最低延迟、最高吞吐
- `router`
  - 同样优先最低延迟、最高吞吐
- `main/analyze`
  - 再优先强模型

这也是为什么后面 `octopus-router` 不该直接默认跟 `main_model` 走，而更适合优先选择本地实测最快、成本也合理的模型。

在你当前这套模型池里，如果本地实测持续证明 `MiniMax M2.7 highspeed` 最快，那么它很自然应该成为：

- `octopus-runner`
- `octopus-router`

而不是把灰区任务的语义判断也交给 `GPT-5.4`。

### 8.9 旧版与新版如何结合，而不是照抄旧版

老版本最强的是：

- 强 RESULT 契约
- `task-state` 先注册
- 长内容写共享文件
- patrol 用 transcript / RESULT / task-state 兜底

新版最强的是：

- `octoclaw_route`
- 常驻 `runner`
- source-aware / plan-aware 选模
- 状态面板和 handoff

最好的方向不是回退，而是：

- 保留新版 route/runtime/runner
- 把旧版最有价值的契约、恢复、上下文优化能力收进脚本层
- 再用更快的 router 模型处理灰区任务

推荐实现不是训练一个黑盒模型，而是：

1. **Hard gates**
   - 明显 direct / runner / spawn 的情况直接切掉
2. **Weighted scoring**
   - 灰区任务计算 `direct_score / runner_score / spawn_single_score / spawn_multi_score`
3. **Outcome learning**
   - 用 replay/eval 和线上结果修正

这样比：

- 纯 `AGENTS.md`
- 纯关键词路由
- 纯本地小模型分类

都更稳定、更可解释。

更准确地说，`octoclaw_route` 应该是一个**调度决策器**，不是“关键词命中器”。它至少要同时回答：

1. 主 agent 自己做，还是切走？
2. 如果切走，是给常驻 `runner`，还是给临时子 agent？
3. 如果给子 agent，是一个还是多个？

总原则也应该明确：

- `direct` 是**白名单**
- 不是默认值
- 任何需要本机工具、会显著拉长主上下文、或更适合隔离执行的任务，都应该先经过 `octoclaw_route -> dispatch`

推荐输入特征不要只盯语义关键词，而要同时看：

- `tool_need`
- `task_shape`
- `context_growth`
- `risk`
- `latency_sensitivity`
- `parallel_gain`
- `budget_pressure`
- `runtime_health`

比较稳的工程顺序是：

1. **硬门禁**
   - 明显 `direct / runner / spawn` 的情况直接切掉
2. **灰区打分**
   - 只对边界任务算 `direct_score / runner_score / spawn_single_score / spawn_multi_score`
3. **保守回退**
   - `direct` 和 `spawn_single` 接近时优先 `spawn_single`
   - `runner` 和 `direct` 接近但明显要本机状态时优先 `runner`
4. **反馈学习**
   - 用 replay/eval 和线上结果持续调权重

这样就不会退化成：

- 纯 `AGENTS.md`
- 纯关键词 router
- 纯本地小模型裁判

而是一个“执行形态、上下文成本、套餐经济学、运行时健康”一起参与的路由系统。

### 补充：如何借鉴 `ClawRouter`

`ClawRouter` 值得借鉴的不是“把 OctoClaw 做成另一个单请求代理”，而是下面 4 点：

1. **本地低延迟决策**
   - route 层尽量纯脚本、纯本地，不为路由本身再调用大模型
2. **profile 化**
   - `auto / eco / premium / private` 这类 profile 值得借
   - 但应同时影响 `route + role + model`
3. **中间层 tier**
   - 不直接从“任务文本 -> 模型”
   - 而是：
     - `task -> route -> role/tier -> model`
4. **插件化接入**
   - 把 `octoclaw_route / octoclaw_dispatch / octoclaw_status` 做成更原生的 OpenClaw tool/extension

不建议照搬的部分：

- 不要退化成纯 proxy router
- 不要只优化“单次请求选哪个模型”
- 不要把支付/钱包式结算模型直接搬过来

OctoClaw 要解决的是整条任务链：

- `direct / runner / spawn_single / spawn_multi`
- 主脑和子脑分工
- 上下文隔离
- 恢复与巡逻

所以 `ClawRouter` 对 OctoClaw 最大的启发，是“本地加权决策器 + profile + 插件化”，不是“让 OctoClaw 只做模型代理”。

### 补充：数据源治理不能只靠“多榜单混合”

OctoClaw 现在已经接入：

- `PinchBench`
- `Artificial Analysis`
- `Claw-Eval`
- `OpenRouter rankings`
- `openclaw_live_compat`

方向是对的，但后面不能停留在“把几个分数直接混合”。

更稳的做法是额外维护：

- `model-sources.json`

让来源职责显式分层：

- `OpenRouter`
  - 模型目录 / 价格 / provider / 参数 / context
  - 榜单只做低权重生态信号
- `Artificial Analysis`
  - 通用 coding / reasoning / latency
- `PinchBench`
  - OpenClaw / agent / coding 实战主榜
- `Claw-Eval`
  - agent workflow 辅助榜
- `本地实测`
  - 真正裁判

这会直接带来 3 个改进：

1. `freshness`
   - 旧榜单自动衰减
2. `confidence`
   - 不同来源置信度不同
3. `family inferred discount`
   - 家族推断值不能被当成具体型号的精确真相

一句话：

> 外部榜单负责“提供参考”，本地实测和套餐状态负责“最后拍板”。

### 补充：飞书 3.22 对 OctoClaw 的真实价值

OpenClaw 3.22 在飞书侧最值得 OctoClaw 吸收的是：

- `structured interactive approval / quick-action launcher cards`
- `current-conversation ACP + subagent session binding`
- `callback user / conversation context preservation`

但当前 OctoClaw 要分两层看：

#### 已经可以直接吃到的

- 双语结构化卡片头尾
- 更统一的状态面板 / 任务卡风格
- 快捷动作提示

#### 还需要后续重构的

- 当前会话 ACP
- 子 agent session 绑定到原飞书对话
- completion 自动回投到原飞书会话
- 真正的 callback action 路由

原因是：

- 当前飞书仍主要走 `feishu-card.py` + 直接 Feishu API
- 它已经能发卡、更新卡、发 DM
- 但还没完整接进 OpenClaw 3.22 的 shared outbound identity / ACP 体系

所以飞书 3.22 的正确借法不是“继续手写更多卡片”，而是：

1. 先把当前卡片层做统一
2. 再逐步把飞书入口迁到 shared outbound / ACP
3. 最终让飞书变成真正的会话绑定执行入口

### 补充：`sessions_spawn` 的 runtime 兼容边界

实际日志已经验证过一个明确边界：

- `streamTo is only supported for runtime=acp; got runtime=subagent`

这说明：

- 这不是单纯的 Slack 权限不足
- 而是 `sessions_spawn` 参数和 runtime 组合不兼容

因此 OctoClaw 后面必须固定规则：

- `runtime=subagent`
  - 禁止传 `streamTo`
- `runtime=acp`
  - 只有当前通道明确支持 ACP 会话绑定时，才允许 `streamTo`

也就是说：

- Slack 里的普通子任务默认应按 `subagent` 处理
- 飞书 3.22 的 ACP 会话绑定可以作为后续增强方向
- 但不能把 ACP 专属参数下放到普通 `subagent` runtime

### 补充：`octoclaw_dispatch` 的返回必须 user-safe

交互式体验里，`octoclaw_dispatch` 不能只返回：

- `route`
- `executed`
- `details`

否则主 agent 很容易在拿到一个“执行中间态”后，自己开始补脑，甚至把内部犹豫文本暴露给用户。

更稳的做法是：

- 对 `runner completed`
  - 返回一个**可直接用于收口**的 user-safe handoff
- 对 `runner timeout`
  - 返回一个**后台提示**：
    - 已转后台执行
    - 可用 `/octostatus` 查看
- 对 `spawn planned`
  - 返回简洁的计划型 handoff，不要求主 agent 自己重新推理一遍

也就是说，tool 返回不仅要“给机器看”，还要“足够适合主 agent 直接组织成用户回复”。

当前仓库已经补了一个最小 runtime extension 骨架：

- `extensions/octoclaw-runtime/package.json`
- `extensions/octoclaw-runtime/index.js`

它的价值不是替代 skill，而是给 OpenClaw 主 agent 一个更硬的工具入口，让它可以先调用 `octoclaw_route / octoclaw_dispatch / octoclaw_status`，而不是只读 `AGENTS.md` 后自己拍板。

### 补充：模型可用性与健康探测

### 补充：评测源收敛

当前更建议的外部评测源是：

- `PinchBench`
- `Artificial Analysis`
- `OpenClaw live compatibility`

像 `Aider Polyglot` 这类时效性更弱、和 OpenClaw 场景距离更远的来源，不建议继续作为核心权重。当前更合适的组合是：

- `PinchBench`
- `Artificial Analysis`
- `Claw-Eval`
- `OpenClaw live compatibility`

其中 `OpenRouter rankings` 可以补充为低权重生态信号，用来辅助判断 provider/生态可获得性，但不应作为核心能力榜。

套餐经济学后面也不应只服务于“包月/包年模型”。对于 token 计费模型，更合理的做法是引入月预算与软/硬限额，让 OctoClaw 在接近预算上限时自动降权或 fallback。

后面八爪鱼很值得再加一层：

> **Model Availability & Health Probing**

它不是纯代理层的 health check，而是面向调度器的模型健康层。

它应该回答的不是：

- 这个模型 API 能不能通

而是：

- 这个模型现在能不能用
- 适不适合做 `runner`
- 适不适合做 `fix / test`
- 适不适合做 `main`
- 是否应该临时降权或熔断

推荐记录：

- `available`
- `last_ok_at`
- `last_error_at`
- `error_rate_5m`
- `ttft_ms_p50`
- `output_tps_p50`
- `degraded`
- `disabled_reason`

这样自动选模就会从：

- “模型列表里有，所以可选”

升级成：

- “OctoClaw 自己知道这个模型现在适不适合干这个角色”

这和 OmniRoute 的 availability / fallback 有一点相似，但 OctoClaw 更适合做成：

- 角色感知
- 任务感知
- 调度感知

而不是纯 provider proxy。

## 补充二：子 Agent 形态校准

关于“子 agent 常驻还是临时”，我现在更确定地支持：

> **大部分临时，1-2 个长期，是最优结构。**

### 为什么不建议固定一整支常驻团队

如果把大量子 agent 做成长期常驻，问题会很快出现：

- 上下文膨胀
- 角色污染
- 缓存收益递减
- 协调成本升高
- 系统看起来很热闹，但不一定更快更省

而你当前最关心的是：

- 降本
- 提效
- 可恢复

这三个目标都更偏向：

- **短生命周期 worker**
- **清晰的任务边界**
- **更强的主调度和恢复链**

### 哪些更适合长期

后面最值得长期存在的，其实只有 1-2 类：

- **Runner**
  - 因为它解决的是轻任务冷启动
- **可能的持久 coding harness / ACP worker**
  - 如果以后你需要真正长时间持续调试同一个大任务

除此之外，大多数角色仍然更适合临时：

- `fix`
- `test`
- `scout`
- `writer`
- `analyze`
- `power`

### 为什么这比很多模板更成熟

很多社区模板默认是“多个专职 agent 常驻协作”。

这种方式看起来完整，但它隐含假设很多：

- 子 agent 会长期保持高质量上下文
- 通道支持稳定会话延续
- 成本不是第一优先

八爪鱼现在走的路更像：

- 主脑稳定
- runner 常驻
- 其余角色按需启动

这在“降本 + 提效”的目标下，其实更成熟。

## 补充三：有没有跑偏

我的判断是：

- **没有跑偏**
- 而且差异化方向是对的

你现在做的不是：

- 另一个 OpenClaw persona 模板
- 另一个 OpenAI-compatible 代理 router

你更像是在做：

> **一个面向真实工作流的、成本敏感的多 agent 调度层。**

如果后面继续强化：

- session-aware 观测
- steer before redispatch
- runner 快任务执行面
- 编排感知选模
- 持久 worker 轮换机制

那八爪鱼会比单纯 router 更“深”，也比纯模板更“硬”。

## 补充四：老版本还有哪些值得借鉴

从 `v1.0.33` 往回看，老八爪鱼最有价值的不是“规则很多”，而是它对子任务约束形成了一整套闭环：

- 主 Agent 基本只做两件事：文字回复 + `sessions_spawn`
- 子任务开始前必须先写 `task-state`
- 子任务结束时必须输出统一 `---RESULT---`
- 大段内容默认写共享文件，不走上下文
- patrol 会用 transcript + RESULT + task-state 三方交叉校验
- queued/deps 会在 patrol 中自动解锁继续派发

这套设计的优点是：

- 结果可恢复
- 输出可审计
- 主会话不容易被大段日志和长文污染
- 子任务做没做完，不靠主 Agent 猜

真正需要借回来的不是“更长的 AGENTS 铁律”，而是这几个机制本身。

## 补充五：新版已经更先进的地方

和老版本比，当前新版真正更先进的地方主要在运行时：

- `octoclaw_route`
  - 不再只是“需要工具就 spawn”，而是先做 `direct / runner / spawn_single / spawn_multi` 的执行形态判断
- `dispatch_task`
  - 有统一的 route/dispatch/handoff 返回，而不是只靠自然语言约定
- 常驻 `runner`
  - 快任务不再每次都冷启动一个子会话
- plan-aware / benchmark-aware model scoring
  - 已经综合本地测速、榜单、套餐状态、健康状态
- runtime extension
  - 已经有 `octoclaw_route / octoclaw_dispatch / octoclaw_status` 工具入口
- 状态面板
  - 已经恢复到接近老版本的 recent/模型/成本/tier/时长视图

所以现在最优路线不是回退到“全靠旧铁律”，而是：

- 保留新版 route/runtime/runner/状态面板
- 把老版本的 RESULT / task-state / 共享文件 / patrol 兜底经验再收紧

## 补充六：系统性改进方向

这一轮最值得做的系统性改进是：

- 新增统一 `octoclaw_spawn.py`
  - 让子任务派发不再散落在文档、提示词和临时手写参数里
- `dispatch_task` 对 `spawn_single / spawn_multi` 直接产出标准 spawn spec
- `task-state` 增加 `route / runtime / parent_id / report_path`
- 主 Agent 不再手写零散 `sessions_spawn` 参数

一句话说：

> 老版本最强的是“子任务契约”，新版最强的是“运行时分层”。OctoClaw 最好的方向，是把这两者合并。

### 11.4 继续借鉴老版本，但不要照抄：把“上下文节约”做成脚本机制

老版本有一个很对的经验：

- 子任务结束时必须输出统一 `RESULT`
- 大段内容默认写共享文件，不走上下文

新版不该只是把这条继续写在文档里，而应该把它做成真正的 runtime 机制：

- `octoclaw_spawn.py` 默认只给子任务最少必要上下文
- 历史信息只注入少量相关摘要
- 详细背景写成 `context pack`
- 长日志 / 长调研 / 长 diff 一律写 `report_path`

这样比“把最近很多历史任务塞进 prompt”更稳，也更省钱。

一句话说：

> 老版本的强项是“契约”，新版的强项是“分层运行时”。最好的结合方式，是让契约负责约束结果格式，让运行时负责约束上下文预算。

### 11.5 错误学习层也要直接兼容 `self-improving-agent`

老版本这块其实走的是一条很对的路：

- 先把错误记到 `.learnings/ERRORS.md`
- 巡逻与慢日志再持续补充
- 重复出现的问题再晋升成防御规则

这里最值得保留的不是某个具体路径，而是“**先记录、再复盘、最后晋升**”的链路。

更合理的新版实现应该是：

- **主接口**：`~/.openclaw/workspace/.learnings/ERRORS.md`
- **兼容接口**：`/workspace/.learnings/ERRORS.md`
- **镜像摘要**：`~/self-improving/domains/octopus-errors.md`

这样 OctoClaw 可以直接兼容 `self-improving-agent`，而不是自己发明一套互不相通的错误系统。

真正需要写进 `SKILL.md` 或默认代码行为的，不是所有错误，而是：

- 高频
- 通用
- 会坑到其他用户
- 已经验证能通过规则或脚本稳定避免

例如：

- `runtime=subagent` 不能带 `streamTo`
- spawn 任务必须先登记 `task-state`
- 长输出必须默认写共享文件

而像“某次 VM 上旧进程混跑”这类单次 incident，更适合留在错误日志或事故文档，不必直接污染 skill 规则。
