# OctoClaw 反思与恢复计划（2026-04-10）

> 状态：面向维护者的反思文档  
> 触发原因：2026-04-09 晚间到 2026-04-10 凌晨的多轮真实 Slack/macmini 验收，暴露出“execution 层已改多轮，但 conversation 入口层仍频繁违背预期”的系统性问题。  
> 关联文档：[`octoclaw-design-foundation.md`](./octoclaw-design-foundation.md)、[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)、[`octoclaw-codebase-assessment-2026-04-08.md`](./octoclaw-codebase-assessment-2026-04-08.md)

---

## 1. 先说结论

### 1.1 代码库还没有彻底变成“不可救药的屎山”

当前代码库在最新基线上的体量大约是：

- 总文件数：`259`
- 总行数：`99,486`
- Python：`141` 文件 / `56,381` 行
- JavaScript：`14` 文件 / `7,350` 行
- Shell：`19` 文件 / `6,128` 行
- Markdown：`55` 文件 / `21,392` 行

这个规模并不算离谱。真正的问题不是“行数过大本身”，而是：

1. **live hot path 的真相源不够单一**
2. **conversation front gate 仍过度依赖 prompt 语义猜测**
3. **同一件事在 JS / Python / replay / display / deploy 层都有一份近似但不完全相同的解释**

所以当前问题更像是：

> **结构分层不够硬，导致补丁越来越多，局部正确但系统不稳定。**

### 1.2 现在最真实的判断

当前 OctoClaw 的状态不是“方向错了”，而是：

- **底层 substrate / observer / replay / display / feedback 的大骨架已经建立**
- **但 conversation entry -> route -> tool policy -> execution facts -> reply 这一条 live 主链还没有收成一个足够窄的系统**

换句话说：

> **基础设施已经很多了，但 live 主链没有被压缩到足够简单。**

这就是为什么会出现：

- 一条真实消息看起来像“已经修过”
- 下一条稍微换个说法又坏
- 再补一次后，另一边又漂

---

## 2. 当前代码事实

### 2.1 最大的热点文件

按行数看，当前最重的几个实现热点是：

- [lib/patrol.py](/tmp/octoclaw-frontgate-livefix/lib/patrol.py) `5647`
- [extensions/octoclaw-runtime/index.js](/tmp/octoclaw-frontgate-livefix/extensions/octoclaw-runtime/index.js) `2358`
- [lib/octoclaw_spawn.py](/tmp/octoclaw-frontgate-livefix/lib/octoclaw_spawn.py) `2277`
- [install.sh](/tmp/octoclaw-frontgate-livefix/install.sh) `2172`
- [lib/octoclaw_route.py](/tmp/octoclaw-frontgate-livefix/lib/octoclaw_route.py) `1678`
- [lib/task-state-update.py](/tmp/octoclaw-frontgate-livefix/lib/task-state-update.py) `1648`
- [lib/model-intel.py](/tmp/octoclaw-frontgate-livefix/lib/model-intel.py) `1562`
- [extensions/octoclaw-runtime/policy/route.js](/tmp/octoclaw-frontgate-livefix/extensions/octoclaw-runtime/policy/route.js) `1344`
- [extensions/octoclaw-runtime/policy/decide.js](/tmp/octoclaw-frontgate-livefix/extensions/octoclaw-runtime/policy/decide.js) `1242`
- [lib/task_display.py](/tmp/octoclaw-frontgate-livefix/lib/task_display.py) `1255`

### 2.2 真正危险的不是“大文件”，而是“多份近似逻辑”

尤其是这几层之间存在职责重叠：

- JS runtime front gate
- JS route policy
- Python parity route/policy
- replay/read-model grounding
- task display/retrieve surfaces
- deploy/install/update/runtime activation

这会导致：

- 改了一层，不代表 live 行为真的一致
- 测试通过，不代表当前会话/当前 extension/当前 gateway 真的在跑这份代码
- reply 里说的“执行事实”有时不是来自真正统一的 execution ledger

---

## 3. 今晚暴露出来的核心失败

### 3.1 `control_observer` 被误用

像：

- `你再看下 OpenClaw 有啥更新，尤其是 Memory 方向`
- `行 再查下 openclaw 有没有新的发版`

本质上是**新的 bounded live lookup**。

但系统有时会把它们吸进：

- `control_observer`
- 或 `direct_answer`

结果是：

- 没快速 ack
- 工具被错拦
- 或主 agent 自己查了，但 execution facts 没稳定记录下来

### 3.2 provenance / follow-up 没有建立在统一 execution facts 上

像：

- `你是怎么查的`
- `刚才那个任务判定是啥`
- `single 成功了吗`

这些本该只读最新 execution facts。

但现实里仍会出现：

- route replay 说 `direct`
- 实际模型自己跑了 `exec + web_fetch`
- replay 却没有完整 `direct_tool_called` 证据
- assistant 最后开始“解释系统为什么错了”

这说明：

> **reply 层仍在消费“局部事实 + 推断”，而不是单一事实面。**

### 3.3 部署激活链路也在制造假象

今晚还暴露过这些：

- gateway service 跑的是旧代码
- repo 更新了，但 workspace repo copy 没更新
- live extension / running gateway / current session 可能不一致

这会把本来就难的 runtime 问题再放大一层：

> **你以为在验新规则，实际上 live process 未必真的在跑那份规则。**

---

## 4. 这几轮为什么总像“补完还会坏”

### 4.1 不是因为用户提问太随机

更根本的原因是：

> **系统把“用户在问什么”分散到太多层去猜。**

当前至少有这些地方在参与解释同一条消息：

- conversation control hints
- route.js feature extraction
- decide.js policy assembly
- state grounding
- before_tool_call tool enforcement
- replay display
- model 自己从 wrapper prompt 再推断一次

只要其中任意两层定义不完全一致，就会出现：

- route 看起来对
- 但 tool policy 不对
- 或 tool policy 对了
- 但 reply grounding 还在按另一套逻辑说话

### 4.2 “关键词路由”不是唯一问题，但确实是主症状

现在最容易坏的地方，就是：

- front gate 仍然大量依赖 prompt pattern
- 一个词没覆盖到，就掉另一条 lane

这不是说“完全不能用规则”，而是：

> **不该让自由文本 pattern 直接决定那么多下游行为。**

规则只适合做：

- 很窄的 hard gate
- 很窄的 capability boundary
- 很窄的 operator surface detect

而不适合承担：

- 大量 conversation intent 语义分类
- 复杂 provenance 判定
- fresh lookup vs prior-task follow-up 的主要判断来源

### 4.3 direct path 仍然太强

当前很多“查一下”的请求，仍可能走成：

- `route=direct`
- 主 agent 自己调工具

这会带来两个直接后果：

1. 没有稳定的 delegated materialization facts
2. provenance follow-up 很难有统一读模型

也就是说：

> **只要 fresh live lookup 还允许大量走 direct，后续“你怎么查的”就天然更容易漂。**

---

## 5. 是否需要“大重构”

### 5.1 需要重构，但不是“全量 Node 重写一切”

我现在的判断是：

- **需要重构**
- 但**不需要立刻把全部 Python 重写成 Node**

理由很简单：

- 真正 live hot path 的问题集中在：
  - [extensions/octoclaw-runtime/index.js](/tmp/octoclaw-frontgate-livefix/extensions/octoclaw-runtime/index.js)
  - [extensions/octoclaw-runtime/conversation-control.js](/tmp/octoclaw-frontgate-livefix/extensions/octoclaw-runtime/conversation-control.js)
  - [extensions/octoclaw-runtime/policy/route.js](/tmp/octoclaw-frontgate-livefix/extensions/octoclaw-runtime/policy/route.js)
  - [extensions/octoclaw-runtime/policy/decide.js](/tmp/octoclaw-frontgate-livefix/extensions/octoclaw-runtime/policy/decide.js)

- Python 里很多大文件更像：
  - replay / validation / nightly
  - patrol / migration / compatibility glue
  - task display / reports / offline utilities

它们有不少历史债，但**不是当前“随便聊一句就错”的主根因**。

### 5.2 真正该做的是“收窄 live surface”

现在不该问：

- 要不要全量 Node 重写

而该问：

- **哪些东西必须留在 live hot path**
- **哪些必须移出 live hot path**

我的判断：

#### 应保留在 JS / live hot path 的

- session boundary
- conversation front gate
- route decision
- tool policy enforcement
- delegated materialization record
- ack policy

#### 应退出 live hot path 的

- Python parity route 判定作为实时真相源
- 复杂 replay 推断再参与当前 turn 判定
- 过深的 display/retrieve 文案逻辑参与当前消息路由
- deployment 过程中多份 repo copy 争抢 extension 真相

#### 保留在 Python / offline 的

- replay / validation / eval / nightly
- model-intel batch sync / calibration
- heavy reports / review / summaries
- 兼容层和迁移脚本

---

## 6. 更彻底的解决办法是什么

不是继续补 pattern。  
真正要做的是把 live 主链压缩成一套**更窄的 deterministic controller**。

### 6.1 把 live 入口只收成 5 个主类 + 1 个保守 fallback

所有用户消息先分到 5 个主类之一；真遇到模糊边界时，允许落到 `undetermined`，而不是强行错判：

1. **plain_chat**
   - 闲聊、解释、非事实性追问

2. **execution_followup**
   - 明确在追问上一条执行事实
   - 例如：`刚才那个任务判定是啥`、`single 成功了吗`

3. **local_surface_lookup**
   - 本机/本地控制面/版本/地址/状态查询
   - 例如：`你的controlui的访问地址是啥`

4. **fresh_live_lookup**
   - 新的 bounded lookup
   - 例如：`再查下 OpenClaw 最近有没有新的发版`

5. **delegated_work**
   - 真正需要 spawn / review / artifact 的工作

6. **undetermined**
   - 保守逃生口
   - 允许 tiny judge 或 workflow-first fallback 兜底，而不是把模糊请求硬塞进错误 lane

然后：

- `execution_followup` 只能走 `control_observer`
- `local_surface_lookup` 只能走受控 local inspect
- `fresh_live_lookup` 不能再掉到 `direct_answer`
- `plain_chat` 才允许普通 direct

另外需要补上一层之前缺失的执行语义：

- `lookup_scope=local_instance`
  - 例如：`你现在啥版本`、`control ui 地址`
- `lookup_scope=upstream_project`
  - 例如：`再查下 OpenClaw 有没有新的发版`

也就是说，`版本/更新` 这类词面不能再共用同一个 probe。前者查本地实例，后者查上游项目。

### 6.2 把 fresh live lookup 从 direct 主链里拿掉

这是最关键的一条。

以后像：

- `查一下最近 release`
- `看看 OpenClaw 最近有啥更新`
- `帮我确认一下当前版本`

这种都应该：

- **默认受控执行**
- 有统一 ack
- 有统一 execution facts
- provenance follow-up 只读这份事实

而不是：

- 有时 direct
- 有时 runner
- 有时又被错吸进 control_observer

### 6.3 让 provenance 只读 materialization + tool ledger

以后这类问题：

- `怎么查的`
- `谁查的`
- `是主 agent 还是 runner`

必须只读：

- delegated materialization
- direct tool ledger
- route outcome

如果 facts 不全，就明确说：

- `当前没有完整执行证据`

而不是让模型自己补叙事。

### 6.4 让 direct path 变弱，而不是更聪明

当前最危险的不是 direct path 不够强，而是**太强**。

恢复方案应该是：

- direct 只做 plain_chat + 极窄 answer_now
- 一切 fresh lookup 尽量 workflow-first

这会让系统：

- 更稳定
- 更容易测
- provenance 更可信

而不是更“聪明”但更漂。

### 6.5 session / deploy / extension 激活也要收成单真相

必须收掉这几层分叉：

- repo HEAD
- workspace repo copy
- live extension dir
- running gateway process
- current session bootstrap snapshot

升级后至少要能回答：

- 当前 live extension commit 是什么
- 当前 gateway 进程加载的是哪份 extension
- 当前 session bootstrap 版本是否过期

否则 live 验证永远会混乱。

---

## 7. 我建议的恢复路线

### R0. 先停掉“继续补词表”

在恢复计划完成前，不再做：

- 某一句话没过就加一个 regex
- 某个 provenance 回答错就补一个特殊分支

否则只会继续把 hot path 变肥。

### R1. 做一次 live controller 收窄重构

目标：

- conversation front gate 只产出上面那 5 类
- route.js 不再重复做一遍近似 intent 识别
- `conversation_control` 只提供 very small set 的 hard hints

### R2. 把 fresh live lookup 全收回 workflow-first

目标：

- fresh lookup 不再走 `direct_answer`
- 必须留下统一 execution ledger
- ack 必须稳定

### R3. 给 provenance 单独立账

目标：

- direct tool usage / delegated materialization / route outcome 写入同一 provenance ledger
- follow-up 只读它

### R4. 删一批中间层/旧旁路

建议优先删/降级的包括：

- Python parity 作为 live policy 依赖
- direct live lookup 的宽权限
- 旧 workspace repo copy 作为 extension 真相源
- 过多 session-local 解释状态

### R5. 把 Python 收成 offline / batch / reporting

这不是说删 Python，而是：

- Python 继续做 replay / validation / eval / patrol / reports
- 不再继续把 Python 作为 live 路由事实的一部分越接越深

2026-04-11 进展：route/policy 的 Python 兼容入口已经改为调用 Node runtime extension，避免 JS/Python 双实现继续漂移。Python 仍保留为 compatibility/eval/report 工具层，不再作为 live route/policy 权威。

---

## 8. 这是不是意味着之前很多实现都白做了

不是。

这些工作仍然有价值：

- substrate-first
- delegated materialization
- route outcome
- model-intel / router facts plane
- replay / validation / eval
- display / retrieve / review packet

真正的问题是：

> **这些能力已经很多，但 live controller 没有被压到足够简单。**

所以不是推倒重来，而是：

- 保留底层资产
- 重写最上面的入口和事实约束

---

## 9. 新的完成标准

只有满足下面这些，才算“真的恢复”：

1. 用户随口问一句新的 live lookup，不会随机掉到 `direct_answer` 或 `control_observer`
2. 一条 fresh lookup 必定：
   - 有明确 lane
   - 有 ack 语义
   - 有 execution facts
   - delegated 场景下还必须区分：
     - 首次 anchor / progress update
     - final completion relay
     不能再把 edit anchor 当成“用户已经收到最终结果”
3. `你是怎么查的`
   - 只能基于真实 tool/materialization 账本回答
4. 升级/部署后，可以明确知道当前 live process 和 session 用的是哪份代码
5. 不再需要围绕单句话术持续加 regex patch

---

## 10. 最后的判断

当前最需要的不是：

- 更多补丁
- 更多 pattern
- 更多“再修一下这个 case”

而是：

> **把 live controller 变窄，把 fresh lookup workflow-first 化，把 provenance 变成单账本。**

如果不这么做，代码会继续增长，但系统感受不会更稳。  
如果这么做，即使总行数不立刻减少，系统复杂度也会明显下降。

---

## 11. Router policy 重构设计更新

2026-04-10 追加 review draft：

- [octoclaw-router-policy-refactor-2026-04-10.md](./octoclaw-router-policy-refactor-2026-04-10.md)
- [octoclaw-router-policy-refactor-plan-2026-04-10.md](./octoclaw-router-policy-refactor-plan-2026-04-10.md)

这版修正了“继续用关键词分类”的错误方向：

- 自然语言语义默认交给 main-grade stateless Policy Judge，而不是当前主会话凭长上下文判断。
- 关键词/regex 只允许做机器可确定的 signal extraction，不再做最终分类。
- scope / target / evidence source 成为一等字段。
- ACK 由独立 timer 保障，不等待模型或 runner。
- 便宜模型和本地模型先 shadow eval，达标后再接真实路由。
- 常驻 runner pool 用来降低轻任务冷启动；每个 runner job 仍绑定 native task，tmux 只做 optional supervisor。
- 理想运行面收成 OpenClaw gateway / Node runtime extension；OctoClaw 不再默认安装 patrol loop、runner shell loop、cron 或 systemd unit。
- 三层 plane 固定为 Live / Execution / Evaluation；harness gate 和指标门槛成为 rollout 条件。
- 补充全链路 `turn_id / decision_id / job_id / delivery_id`、幂等/supersede、runner backpressure、feature flags/kill switch、ACK/progress/final 三段消息契约。
