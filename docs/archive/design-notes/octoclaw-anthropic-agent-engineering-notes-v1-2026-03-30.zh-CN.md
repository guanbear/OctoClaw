# OctoClaw Anthropic Agent Engineering Notes v1

日期：2026-03-30

## 1. 目的

本文记录了 OctoClaw 应该从 Anthropic 官方工程文章与 Claude Cookbooks 中借鉴什么。

本文有意仅聚焦于 OctoClaw。

本文不打算重新设计 Ironclaw、OpenClaw 或 ClawTeam。

## 2. 已阅读的官方来源

### 2.1 Anthropic 工程文章

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- [The "think" tool](https://www.anthropic.com/engineering/claude-think-tool)
- [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Introducing Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Claude Code: Best practices for agentic coding](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Beyond permission prompts: making Claude Code more secure and autonomous](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Code execution with MCP: Building more efficient agents](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [A postmortem of three recent issues](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues)

### 2.2 Claude Cookbooks

- [Claude Cookbooks](https://platform.claude.com/cookbooks)
- [The chief of staff agent](https://platform.claude.com/cookbook/claude-agent-sdk-01-the-chief-of-staff-agent)
- [The observability agent](https://platform.claude.com/cookbook/claude-agent-sdk-02-the-observability-agent)
- [The site reliability agent](https://platform.claude.com/cookbook/claude-agent-sdk-03-the-site-reliability-agent)
- [Session memory compaction](https://platform.claude.com/cookbook/misc-session-memory-compaction)
- [Programmatic tool calling (PTC)](https://platform.claude.com/cookbook/tool-use-programmatic-tool-calling-ptc)
- [Tool search with embeddings](https://platform.claude.com/cookbook/tool-use-tool-search-with-embeddings)
- [Tool evaluation](https://platform.claude.com/cookbook/tool-evaluation-tool-evaluation)

## 3. 主要结论

Anthropic 的材料并不意味着 OctoClaw 应该变成一个更大、更通用的框架。

恰恰相反，它们给出的建议是：

- 保持 workflow-first
- 保持 policy-first
- 让 multi-agent 只在必要时使用
- 让 context、tools、harness 和 eval 都变得更有意识、更精细

对于 OctoClaw 来说，当前的架构方向依然是正确的：

- OpenClaw 仍然是外层壳与用户交互循环
- ClawTeam 仍然是执行运行时
- OctoClaw 仍然是编排、路由、模型策略与可观测性层

**更新（2026-04-02）：OpenClaw 3.31/4.1 引入了原生 flow task 能力（任务创建、状态追踪、子任务生命周期，以及可能的 DAG 支持）。这改变了 ClawTeam 的角色：它不再是必需的执行运行时。现在更推荐的架构是 `OpenClaw → OctoClaw policy → OpenClaw native flow_task → workers`，而 ClawTeam 被重新定位为一个可选的 tmux 操作工作台。第 6 节中的六项借鉴仍然有效，但它们的实现路径已经改变，见下文第 6.4 节。**

因此，结论是：

> OctoClaw 不需要重写产品定位，但确实需要调整优先级。

## 4. 开发重点应该如何变化

### 4.1 不需要大的定位变化

OctoClaw 仍然应该是：

- 调度大脑
- 成本大脑
- 执行控制大脑
- 展示与恢复大脑

它不应该变成：

- 一个通用 agent SDK
- 一个新的类 LangGraph 运行时
- 一个默认就完整展开的研究系统

### 4.2 优先级转移

Anthropic 的官方指导非常明确地表明，OctoClaw 应该提高以下事项的优先级：

1. context engineering
2. tool ergonomics
3. long-running harness durability
4. eval 与 postmortem discipline

同时降低以下事项的紧迫性：

- 过早增加更多自治复杂度
- 默认扩展 multi-agent 拓扑
- 依赖只靠 prompt 的 delegation 行为

## 5. 基于来源的 OctoClaw 指导

### 5.1 Workflow-first，agent-second

`Building effective agents` 支持一个简单但重要的规则：

- 从狭窄、明确的 workflows 开始
- 只在真实存在不确定性时使用 agents
- 只有在拆解确实有价值时才使用 multi-agent

对 OctoClaw 的含义是：

- `direct / runner / spawn_single / spawn_multi` 仍然是正确的顶层结构
- `spawn_multi` 应继续保持保守
- coding 和 ops 任务默认不应被推进 multi-agent 执行

### 5.2 Context engineering 比 prompt 小聪明更重要

`Effective context engineering for AI agents` 是与 OctoClaw 最匹配的文章之一。

它的实际教训是：

- context 是稀缺的运行时资源
- 重要的不只是 system prompt
- 更重要的是每一步向模型暴露了哪些 state、summaries、artifacts 和 recent actions

对 OctoClaw 的含义是：

- `brief / summary / artifact` 不是边缘协议，而是核心产品行为
- follow-up 处理应该基于紧凑的 context packs，而不是原始 transcript 回放
- 长时间运行的任务应该为后续 session 留下清晰的中间 artifacts
- task 和 thread state 应该是显式的运行时真相，而不是从聊天历史中反向重建

### 5.3 Tools 是产品的一部分，不只是底层 plumbing

`Writing effective tools for agents`、`Introducing advanced tool use` 和 `The "think" tool` 都指向同一个方向：

- tool descriptions 很重要
- tool results 应该为模型使用而塑形，而不只是给人看
- parallel 与 nested tool use 应该是有意识设计的
- 有时候，让 agent 先停下来想一想再行动会更好

对 OctoClaw 的含义是：

- runner 与 runtime tools 需要更清晰的契约，而不只是更多路由逻辑
- tool eval 应该成为 OctoClaw 回归体系的常规组成部分
- think/checkpoint 风格的暂停，比盲目提高 autonomy 更有用

### 5.4 Long-running harness 是一级关注点

`Effective harnesses for long-running agents` 几乎直接映射到 OctoClaw 最近的失败模式。

这篇文章强化了以下几点：

- resumability
- handoff artifacts
- checkpointing
- cross-session continuity
- explicit progress surfaces

对 OctoClaw 的含义是：

- ownership lock 与 dead-agent recovery 不是可有可无的打磨项
- worker session resume 应该变成显式存储
- delegated tasks 在最终完成前，应该先发出 progress 与 readiness signals

### 5.5 Multi-agent 应继续保持选择性

`How we built our multi-agent research system` 很有价值，但主要价值在于提醒约束：

- multi-agent 对广泛研究和并行探索有帮助
- 它成本更高
- 它会引入更多状态与集成风险

对 OctoClaw 的含义是：

- 保留 orchestrator-worker 这种模式
- 不要把所有复杂任务都变成 research-style decomposition
- 保持 `spawn_single` 作为默认的 delegated lane

### 5.6 Evals 与 postmortems 应该成为日常工程实践

`Demystifying evals for AI agents` 和 `A postmortem of three recent issues` 支持的是同一条运维教训：

- 尽早建立小型 evals
- 为真实故障做 instrumentation
- 保持短反馈闭环

对 OctoClaw 的含义是：

- replay 与 policy drift 已经是正确方向
- delegated runtime events 应该反哺 eval fixtures
- state-machine regressions 应被视为一级故障

### 5.7 MCP、programmatic tool calling 与 tool search 属于后阶段升级

`Code execution with MCP`、`Programmatic tool calling (PTC)` 和 `Tool search with embeddings` 都是相关方向，但紧迫性并不相同。

对 OctoClaw 来说：

- MCP 很重要，因为执行表面应该标准化且可组合
- programmatic tool calling 对高频 tool workflows 很有前景
- 只有当 tool surface 足够大时，tool search 才真正有价值

这些都是有意义的扩展，但不是 OctoClaw 接下来最该优先构建的内容。

## 6. 这对 DeerFlow 和 ClawTeam 借鉴项意味着什么

更早提出的六项、基于来源的借鉴仍然成立。

它们应该继续推进。

但优先级顺序需要调整。

### 6.1 六项都保留

仍然值得实现：

1. 更丰富的 delegated event stream
2. 更严格的 IM thread 与 topic binding
3. artifact index 与 retrieval
4. ownership lock 加 dead-agent recovery
5. delegated worker session resume
6. 在 context loss 下保持 todo 与 checklist 持久化

### 6.2 重新排序

Anthropic 关于 long-running harness 与 context engineering 的指导，暗示了如下顺序：

#### P0 正确性与连续性

1. 更丰富的 delegated event stream
2. 更严格的 IM thread 与 topic binding
3. ownership lock 加 dead-agent recovery
4. delegated worker session resume

这四项会直接提升：

- state truth
- session continuity
- operator visibility
- stuck-task recovery

#### P1 可交付性与检索

5. artifact index 与 retrieval

这项应放在 event 和 state truth 夯实之后，否则索引只会为不稳定记录建目录。

#### P2 context 耐久性

6. 在 context loss 下保持 todo 与 checklist 持久化

这项仍然有价值，但最适合建立在以下基础之上：

- 稳定的 event truth
- 稳定的 thread identity
- 稳定的 session resume

### 6.3 精炼，而不是替换

这六项借鉴不需要被替换。

它们需要被精炼：

- event stream 应包含 checkpoint 与 deliverable-readiness signals
- IM thread binding 应被视为一种通用 IM primitive，而不只是 Slack-only fix
- artifact retrieval 应支持为后续 follow-up 生成 context packs
- session resume 应是显式运行时真相，而不是尽力重新发现
- checklist persistence 应聚焦于 parent-task continuity，而不只是 worker-local notes

### 6.4 OpenClaw 原生 flow task（2026-04-02 新增）之后的实现路径

随着 OpenClaw 3.31/4.1 提供原生 flow task，每项借鉴的实现路径也发生了变化：

| 借鉴项 | flow task 之前的路径 | flow task 之后的路径 |
|-----------|-------------------|---------------------|
| 1. 更丰富的 delegated event stream | 自建 `task-events.jsonl` | 消费原生 flow task events；OctoClaw 作为适配层 |
| 2. IM thread binding | 从 ClawTeam 借用 | 仍然由 OctoClaw 自己实现；flow task 不处理 IM 层 |
| 3. Artifact index 与 retrieval | 从 ClawTeam inbox 借用 | OctoClaw 在原生 artifacts 之上维护检索层 |
| 4. Ownership lock + dead-agent recovery | ClawTeam task lifecycle | 优先采用原生 flow task state；patrol 退居监控层 |
| 5. Delegated worker session resume | ClawTeam session store | 原生 flow task 也许会提供；OctoClaw 作为兜底 |
| 6. Todo/checklist persistence | DeerFlow todo_middleware | 仍然由 OctoClaw 自己实现 |

`task-state.json` 的定位也发生了变化：它不再是执行层的事实来源（这一角色现在由原生 flow task 承担），而是变成 OctoClaw 自己的**策略元数据存储**（模型选择、成本记录、路由决策、patrol 元数据）。

## 7. 推荐的下一步实现顺序

对 OctoClaw 来说，接下来的顺序应该是：

1. delegated event stream
2. IM thread/topic binding
3. ownership lock 加 dead-agent recovery
4. worker session resume store
5. artifact index 与 retrieval
6. todo/checklist persistence

并行推进：

- 持续改进 `brief / summary / artifact`
- 增加更多 tool evaluation cases
- 让 replay 与 state-machine evals 持续贴近生产故障

## 8. 决策总结

### 8.1 OctoClaw 的开发方向要改吗？

要改，但只是强调重点的变化。

它应该转向：

- context engineering
- harness durability
- tool quality
- eval discipline

它不应该转向：

- 更重的通用框架
- 更宽泛的默认 multi-agent 执行
- 在 observability 还没准备好之前就继续增加 autonomy

### 8.2 之前的 DeerFlow 与 ClawTeam 借鉴还要继续吗？

要继续。

这六项借鉴仍然是正确的执行轨道。

变化的是它们的顺序和 framing：

- 先把 delegated runtime truth 与 continuity 做硬
- 再让 artifacts 更容易检索
- 然后再加更强的 context persistence layers

## 9. 相关 OctoClaw 说明文档

- [octoclaw-product-design-v2-2026-03-27.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-product-design-v2-2026-03-27.md)
- [octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md)
- [octoclaw-state-machine-remediation-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-state-machine-remediation-v1-2026-03-29.md)
