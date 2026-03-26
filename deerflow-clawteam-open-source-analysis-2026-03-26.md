# DeerFlow / ClawTeam / HiClaw / LangGraph 方向分析 (2026-03-26)

## 1. 先说结论

这轮判断可以收敛成 4 句话：

1. **ClawTeam 值得直接复用 runtime / CLI，而不只是借思想。**
2. **DeerFlow 不适合整套嵌进 OpenClaw 当主 runtime，但非常值得借执行哲学。**
3. **LangGraph 仍有借鉴价值，但更适合借 graph semantics，不适合当前阶段再引入一套新的主 runtime 依赖。**
4. **HiClaw 有借鉴点，但它更偏透明协作 + IM + 企业安全治理，不是当前 OctoClaw 的最优主线。**

一句话版：

> **OpenClaw 做壳，OctoClaw 做脑，ClawTeam 做工位和任务面，DeerFlow 提供重任务执行思想，LangGraph 做 graph 思想参考。**

---

## 2. ClawTeam：不只是借思想，值得直接复用

### 2.1 为什么 ClawTeam 值得直接复用

ClawTeam 的公开定位非常清楚：

- 兼容 OpenClaw / Claude Code / Codex 等 CLI agent
- `task` / `inbox` / `board` / `workspace` 都是一等能力
- 默认 backend 就是 `tmux`
- 所有状态落在 JSON 文件里，天然适合外部编排和审计

对 OctoClaw 来说，这意味着它不是单纯的“设计灵感”，而是可以直接当：

- execution fabric
- collaboration runtime
- tmux-backed workbench
- task / inbox / board control plane

### 2.2 最值得复用的部分

- `task create/update/list/wait`
- `inbox send/receive/peek`
- `board show/live/attach/serve`
- `tmux` 工位
- `git worktree` 隔离
- `launch` 模板和 team archetype

### 2.3 为什么它对 OpenClaw 更贴

因为 ClawTeam 的抽象层级正好比 OpenClaw 高半层：

- OpenClaw 提供 agent loop / session / workspace
- ClawTeam 提供 team/task/inbox/tmux runtime
- OctoClaw 正好可以继续负责 route / model policy / patrol / review gate

所以它非常适合作为 OctoClaw 的共享运行面，而不是竞争“大脑”。

### 2.4 对 OctoClaw 的建议

ClawTeam 不是只留在 `spawn_multi`。

更合理的方向是：

- `direct` 留在主链路
- `runner` 进入共享 task runtime，tmux 里占固定 daemon 工位
- `spawn_single` 用 ClawTeam worker 工位
- `spawn_multi` 用 ClawTeam team/task/tmux

也就是：

> **ClawTeam 要复用，而且要复用成统一运行面。**

---

## 3. DeerFlow：要借思想，但不要整套塞进 OpenClaw

### 3.1 DeerFlow 最值得借的不是“多 agent”，而是执行哲学

DeerFlow 2.0 官方把自己定义为：

- super agent harness
- sub-agents + memory + sandboxes
- execution modes: `flash / standard / pro / ultra`
- isolated sub-agent context
- summarization + filesystem offloading

这套设计和 OctoClaw 的目标非常契合：

- 按任务等级选择执行模式
- 子 agent 只吃最小 brief
- 中间结果摘要化
- 复杂任务进入重模式

### 3.2 为什么不建议直接复用 DeerFlow 主 runtime

因为它和 OpenClaw / OctoClaw 会抢同一层控制权：

- DeerFlow 有自己的 lead agent / planner / reporter
- 自己管理 sandboxes / memory / heavy execution
- 自己决定何时 fan-out sub-agents

如果整套引入，会出现：

- 双调度器
- 双状态机
- 双上下文管理
- 双模型选择入口

对 OctoClaw 来说，这种重叠比“功能不够”更危险。

### 3.3 DeerFlow 最值得借的 4 个点

#### 1. Execution mode 分层

OctoClaw 可以显式收敛成：

- `L0 direct`
- `L1 runner`
- `L2 single`
- `L3 multi`
- `L4 heavy profile`

#### 2. Isolated sub-agent context

每个 sub-agent 只拿：

- task brief
- constraints
- expected output
- 必要 artifact refs

而不是完整主会话。

#### 3. Aggressive summarization

中间结果优先下沉文件系统，主链路默认只读取：

- summary
- status
- artifacts
- next step

#### 4. Heavy profile 是特殊模式

只有研究型、长流程、sandbox-heavy、多步探索任务才启用 DeerFlow-like heavy protocol。

### 3.4 对 OctoClaw 的建议

> **DeerFlow 借执行协议和 heavy-profile 思想，不借主控制 loop。**

---

## 4. 有了 ClawTeam，DeerFlow 还要借吗

要。

因为两者解决的不是同一个问题。

### ClawTeam 解决的是

- 任务身份
- agent 协作
- inbox/message
- board/tmux/workbench
- worktree 隔离
- 人类介入点

### DeerFlow 解决的是

- 执行模式分层
- 上下文隔离
- 中间结果压缩
- 重任务长流程执行
- sandbox / filesystem / heavy protocol

所以不是二选一，而是：

- **ClawTeam 借 runtime**
- **DeerFlow 借 execution philosophy**

---

## 5. DeerFlow 已经 graph 化了，还要借 LangGraph 吗

要借，但要分清楚“借什么”。

### 5.1 不建议额外引入 LangGraph 当主 runtime

DeerFlow 本身已经是一个基于 LangGraph 的 opinionated harness。

如果 OctoClaw 现在再额外把 LangGraph 当主 orchestration runtime，会进一步增加：

- runtime 重叠
- checkpoint / memory / event model 冲突
- OpenClaw 集成复杂度

### 5.2 但 LangGraph 的 graph semantics 仍值得借

尤其是这些思想：

- graph state 是一等公民
- node / edge / conditional routing
- checkpoint / pause / resume
- human-in-the-loop
- tool-handoff 不是 prompt 魔法，而是结构化控制流

### 5.3 最务实的建议

对 OctoClaw 来说，LangGraph 更适合：

- 借状态流思想
- 借 node/edge/checkpoint 设计
- 借 supervisor pattern 的控制边界

不一定适合：

- 直接把 LangGraph 作为新的核心依赖引进来

> **结论：借 graph semantics，不急着引入 LangGraph runtime。**

---

## 6. 其他开源项目是否值得借

下面按“对 OctoClaw 当前目标的价值”排序。

### 6.0 一眼判断

| 项目 | 是否需要借 | 借到什么程度 |
|---|---|---|
| OpenHands | **是，高优先级** | 借 delegation tool / tracing / context condenser，不迁整套 runtime |
| CrewAI Flows | **可以，但不是现在最优先** | 借 flow/state/HITL 思想，不建议当前直接上主依赖 |
| MetaGPT | **要借一部分** | 借 SOP / artifact schema / code-review pipeline，不借主 runtime |
| HiClaw | **有借鉴意义** | 借透明协作 / shared FS / gateway secrets，不迁 Matrix 栈 |

### 6.1 OpenHands：高优先级

最值得借的点：

- 把 delegation 做成一等工具
- `spawn` / `delegate` 显式分离
- 独立上下文
- 并行 delegation
- tracing / observability

对 OctoClaw 的意义：

- 证明“委派应该是 tool/runtime 行为，而不是 prompt 习惯”
- 很适合指导你把 `delegate_task` / `request_review` 做成硬接口

判断：

- **高优先级借鉴**
- 借 delegation tool / tracing / context condenser
- 不需要整套迁移

### 6.2 HiClaw（阿里）：中优先级

HiClaw 官方定位是：

- collaborative multi-agent OS
- Manager-Workers architecture
- Matrix rooms 透明协作
- shared file system
- gateway 集中托管密钥
- human-in-the-loop by default

它最有借鉴意义的点：

- 透明协作和可观察性
- 共享文件系统降 token
- 凭据不暴露给 worker
- manager / worker 边界清晰

但它不太适合作为 OctoClaw 的主干：

- 太偏 IM / Matrix 房间协作
- 太偏企业协作 / chat-room workflow
- 本地 CLI coding / tmux 工作台这条线不如 ClawTeam 贴

判断：

- **中优先级借鉴**
- 借透明协作、shared FS、gateway secret isolation
- 不建议整套采用 Matrix/IM 栈

### 6.3 MetaGPT：中优先级

最值得借的点：

- 角色 SOP
- 固定产物格式
- code/review pipeline

对 OctoClaw 的意义：

- 适合给 code task 设计标准 pipeline
- 比如 `spec -> implement -> test -> review`

判断：

- **中优先级借鉴**
- 适合 code pipeline 和 artifact schema

### 6.4 Microsoft Agent Framework：中优先级

最值得借的点：

- Agents 和 Workflows 明确分开
- workflow 强调显式控制、多步骤协调
- middleware / session / checkpoint 这些概念明确

对 OctoClaw 的意义：

- 很适合加强“agent vs workflow”分层
- 也支持把 middleware 当 runtime enforcement 点

判断：

- **中优先级借鉴**
- 借 workflow / middleware / checkpoint 思想
- 不建议当前阶段直接引入作为主依赖

### 6.5 CrewAI：低到中优先级

最值得借的点：

- autonomy 和 determinism 分开
- Crew vs Flow 的边界

判断：

- **可以借思想**
- 但对 OctoClaw 当前阶段不如上面几个直接

### 6.6 对这 3 个项目的最终判断

#### OpenHands sub-agent delegation

**需要借。**

原因：

- 它把委派做成了一等工具，而不是 prompt 习惯
- `spawn` / `delegate` 分离得很清楚
- 支持并行和最大子 agent 数限制

这非常适合 OctoClaw 下一步把“委派”从 `AGENTS.md` / `skills` 提升成 runtime policy。

#### CrewAI Flows

**可以借，但优先级没那么高。**

最值得借的是：

- flow/state/event-driven 思想
- autonomy 和 determinism 分层
- human feedback / review gate

但它离 OpenClaw / tmux / CLI runtime 这条线比较远，所以更适合拿来帮 OctoClaw设计流程层，不适合现在直接引进来当主框架。

#### MetaGPT

**要借一部分，而且对 code pipeline 很值。**

最适合借：

- 角色 SOP
- 固定产物格式
- `spec -> implement -> test -> review` 这种明确 pipeline

不适合借：

- 整个“软件公司”主 runtime

所以它的正确位置更像：

- code/review pipeline 参考实现
- artifact schema 参考
- review 阶段的任务模板库

---

## 7. AGENTS.md / skills / 插件：到底谁负责什么

这是当前 OctoClaw 最关键的架构边界。

### 7.1 AGENTS.md

适合负责：

- 静态铁律
- 主 agent 必须优先使用 OctoClaw runtime
- 不允许绕过路由/派发/收口

不适合负责：

- 稳定委派
- 动态分流
- 复杂调度决策

### 7.2 Skills

适合负责：

- 能力包
- 工具说明
- 流程建议
- 子任务模板

不适合负责：

- 强制执行的调度纪律

### 7.3 插件 / middleware / runtime policy

适合负责：

- 任务分类
- 是否委派
- 是否 review
- 选模型 / 选 profile
- 拦截主 agent 不该亲自做的重任务

> **真正要稳，委派必须从 prompt 行为升级成 runtime policy。**

---

## 8. OctoClaw 的真实短板

结合当前代码与这轮调研，我认为 OctoClaw 现在最该补的不是“更多 agent”，而是下面 4 个点。

### 8.1 委派仍偏软

即使有 `AGENTS.md` / `SKILL.md` / prompt 注入，稳定性仍受模型服从度影响。

正确方向：

- 前置 router
- runtime policy
- delegate/review 结构化工具

### 8.2 协作协议刚起来，但还不够彻底

你已经把 ClawTeam 的 `task/inbox/tmux` 接进来了，但还需要继续把：

- runner
- spawn_single
- spawn_multi

全部收敛到统一任务控制面。

### 8.3 子任务 I/O 还可以更 DeerFlow 化

最终目标应该是：

- brief 输入
- summary 输出
- artifact first
- 文件卸载中间结果
- 主链路不看完整 transcript

### 8.4 可视化要双轨

OctoClaw 现有状态面板值得保留，但还要继续强化：

- tmux board/workbench
- Web UI / task graph / artifact explorer

也就是：

- 运维视角
- 工作台视角

两者都要。

---

## 9. 推荐的最终架构

### 9.1 四层结构

#### 1. OpenClaw layer

- session
- authoritative loop
- workspace
- channel / interaction shell

#### 2. OctoClaw policy layer

- route
- cost policy
- model tier / profile resolution
- review gate
- patrol / retry / escalation

#### 3. ClawTeam runtime layer

- task
- inbox
- board
- tmux
- worktree
- launch templates

#### 4. Heavy profile on top of ClawTeam runtime

- long research
- sandbox-heavy tasks
- recursive exploration
- large intermediate artifacts

### 9.2 一句话版

> **OpenClaw 做壳，OctoClaw 做脑，ClawTeam 做运行面，DeerFlow 提供重任务执行思想。**

---

## 10. 推荐的重构顺序

### Phase 1：先把委派变成系统行为

- 前置 router
- runtime policy
- delegate/review hard gate
- 主 agent 不再“想起来才委派”

### Phase 2：把协作控制面全面 ClawTeam 化

- 非 `direct` 任务统一进入 task/inbox/board
- tmux 成为默认工作台
- runner 也进入共享 runtime，但仍保留 queue/daemon 内核

### Phase 3：把子任务协议全面 DeerFlow 化

- brief / constraints / expected_output
- summary / artifacts / next_step / status
- 文件系统下沉中间结果

### Phase 4：最后把 heavy profile 叠到 ClawTeam runtime 上

- 长任务
- 复杂研究
- sandbox-heavy 执行
- 递归探索
- 但不引入单独 DeerFlow 主 runtime

这样风险最小、收益最大。

---

## 11. 最终判断

### 是否直接复用 ClawTeam 客户端 / CLI

**是。**

它是最适合当前 OctoClaw 直接复用的外部 runtime。

### DeerFlow 在有了 ClawTeam 之后还要不要借

**要。**

但借的是：

- execution mode
- isolated context
- summarization
- heavy protocol / heavy profile

不是借它的主调度 loop。

### DeerFlow 已经 graph 化了，还要不要借 LangGraph

**要借思想，但不急着引依赖。**

更准确地说：

- DeerFlow 是 graph 思想的一个 concrete realization
- LangGraph 仍然值得借 graph semantics / checkpoint / HITL / supervisor 边界

### HiClaw 值不值得借

**有借鉴意义，但不是当前最优主线。**

最值得借：

- 透明协作
- shared file system
- gateway secret isolation

不建议当前阶段整套采用：

- Matrix rooms
- IM-first runtime

---

## 12. Sources

- [DeerFlow GitHub](https://github.com/bytedance/deer-flow)
- [DeerFlow README](https://raw.githubusercontent.com/bytedance/deer-flow/main/README.md)
- [ClawTeam GitHub](https://github.com/HKUDS/ClawTeam)
- [ClawTeam README](https://raw.githubusercontent.com/HKUDS/ClawTeam/main/README.md)
- [ClawTeam-OpenClaw GitHub](https://github.com/win4r/ClawTeam-OpenClaw)
- [ClawTeam-OpenClaw README](https://raw.githubusercontent.com/win4r/ClawTeam-OpenClaw/main/README.md)
- [HiClaw GitHub](https://github.com/alibaba/hiclaw)
- [HiClaw README](https://raw.githubusercontent.com/alibaba/hiclaw/main/README.md)
- [OpenHands Sub-Agent Delegation](https://docs.openhands.dev/sdk/guides/agent-delegation)
- [CrewAI Flows](https://docs.crewai.com/en/concepts/flows)
- [LangGraph Supervisor README](https://raw.githubusercontent.com/langchain-ai/langgraph-supervisor-py/main/README.md)
- [Microsoft Agent Framework Overview](https://learn.microsoft.com/en-us/agent-framework/overview/)
- [MetaGPT GitHub](https://github.com/FoundationAgents/MetaGPT)
