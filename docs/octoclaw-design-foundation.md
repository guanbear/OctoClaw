# OctoClaw 主设计底稿

> 状态：当前 canonical 设计底稿（2026-04-03）  
> 用途：给维护者自己后续开发、重构与取舍判断使用，而不是面向外部协作者的市场化介绍文档。  
> 相关文档：[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)、[`archive/design-notes/README.md`](./archive/design-notes/README.md)

---

## 1. 这份文档解决什么问题

OctoClaw 过去两周快速积累了大量设计笔记、方向分析、路线图和专题方案。它们各自都提供了价值，但也带来了三个问题：

1. **source of truth 分散**：设计判断散落在多份日期文档里，需要靠记忆决定“现在到底信哪一份”。
2. **时间序列叠加导致口径漂移**：越早的文档越强调 ClawTeam 作为核心运行面，越新的提交则明显转向 unified runtime observer、taskflow-bound substrate 和更轻的 on-demand runner。
3. **近期计划与长期终局混在一起**：有的文档更像方向分析，有的更像迁移计划，有的更像切片实施记录，缺少统一抽象层。

这份主设计底稿的目标，是把这些分散判断收口成当前可执行的长期设计真相源。

---

## 2. 当前一句话定义

> **OctoClaw 是 OpenClaw 之上的执行面调度层、成本控制层和可观察控制层。**

它的职责不是“再造一个通用 agent framework”，也不是“替代 OpenClaw 的 task runtime”，而是：

- 决定一个请求该走哪条执行 lane
- 决定不同任务该用什么 worker pool / phase / model policy
- 用统一的 runtime truth 把任务、artifact、session、状态和回传串起来
- 在需要时使用更重的 operator backend，但不把它们当成唯一依赖

---

## 3. 它不是什么

OctoClaw **不是**：

- 一个独立于 OpenClaw 的通用多 Agent 平台
- 一个只做模型打分的 router
- 一个永远依赖长期常驻 worker / tmux swarm 才能工作的 runtime
- 一个以 README 叙事为中心、却没有运行时真相源的提示词集合

换句话说，OctoClaw 不应该把“调度脑”“运行面”“展示面”“实验笔记”继续混成一团。

---

## 4. 当前架构边界

### 4.1 OpenClaw 负责 substrate facts

OpenClaw 是 runtime substrate，负责：

- detached task / flow 事实层
- 任务的基础生命周期与回到 session 的基线能力
- 原生 node / gateway / extension / tool 接入面

OctoClaw 不再把自己定位成 substrate 替代品，而是**覆盖在 substrate 上面的决策与控制层**。

### 4.2 OctoClaw 负责 policy + control

OctoClaw 继续拥有：

- route decision
- work contract / worker pool / phase / profile 选择
- model selection policy
- review / budget / delivery policy
- runtime task record 与 artifact 组织
- text-first 的 status / details / timeline / graph / retrieve / ctl 观察面

### 4.3 Operator backend 是可选层，不是核心真相源

ClawTeam、tmux workbench、programmatic tool execution 都属于**可选 operator backend**。

它们的价值在于：

- 提供更重的协作运行面
- 承载更强的 inbox / board / 人工接管 / 工作台体验
- 在重任务或人工介入场景中提升可操作性

但它们不应该继续被定义成 OctoClaw 的唯一核心运行面。当前方向已经收敛到：

- `ClawTeam`：保留为 optional backend
- `tmux`：作为推荐 operator workbench
- 更轻、更程序化的路径：优先让更多工作落在 OpenClaw substrate + OctoClaw control plane 上

---

## 5. 当前执行模型

### 5.1 四条执行 lane 仍然成立

当前仍以四条 lane 为基础：

- `direct`
- `runner`
- `spawn_single`
- `spawn_multi`

但新的解释口径不是“任务像什么”，而是“**该请求应该签哪种执行合同**”。

也就是说，route 的目标是选择：

- 是否需要 durable runtime
- 是否值得委派
- 是否需要 fan-out / multi-owner coordination
- 是否要走更重的 review / artifact / recovery protocol

### 5.2 runner 不再被理解为“必须永远常驻的快腿”

后续提交已经把方向进一步推向：

- unified runtime observer
- on-demand runner fallback
- runner task taskflow-bound substrate

因此，runner 的当前定义应调整为：

> **优先服务轻量 shell / API / 状态检查的执行 lane；具体运行形态可以是常驻、半常驻或按需拉起，但其结果必须进入统一的 runtime truth。**

### 5.3 spawn 任务必须 artifact-first

复杂任务不应把长结果直接回灌主上下文，而应优先落成：

- task event log
- artifact index
- checklist persistence
- report / packet / retrieve-friendly output

这也是 OctoClaw 区别于“只会把 prompt 扔给子 agent”的关键所在。

---

## 6. 当前运行时方向：用较新的提交校准旧设计

以下几类较新的提交，足以说明 3 月中下旬的许多文档虽然仍有价值，但已经不是完整真相源：

- `aedaffc` — Promote runner jobs to taskflow-bound tasks
- `17abf08` — Add unified octoclawctl runtime control entrypoint
- `ec335e8` — Extract runtime observer and add on-demand runner fallback
- `e9bf47b` — Unify patrol observation pass and ondemand runner mode
- `8b9510b` — add native taskflow control metadata
- `d963dfa` — persist session resume contexts

这些提交意味着：

1. **taskflow substrate 已经从 spawn 扩到 runner 与 control metadata 侧。**
2. **patrol 不再只是独立脚本语义，而是朝统一 observer 收拢。**
3. **runner 方向从“重度长期常驻”收敛到“必要时常驻、否则可按需”。**
4. **控制面已经开始收口到统一入口，而不是多个分散脚本心智模型。**
5. **resume / continuity 已经成为 runtime truth 的一部分，而不是附加功能。**

因此，凡是仍把 ClawTeam 视为唯一核心运行面、把 runner 视为必须持续常驻、或者没有把 taskflow-bound substrate 当成第一事实层的旧文档，都只能作为历史设计记录或局部参考。

---

## 7. 当前应坚持的设计原则

### 7.1 workflow-first，agent-second

优先判断 workflow 是否足以解决问题；只有当 workflow 无法满足目标，才升级到更重的 agent coordination。

### 7.2 policy-first，而不是 prompt-first

委派、回收、review、model choice、lane selection 必须先是系统行为，再由模型协助，而不是把核心判断寄托给主脑“记不记得该怎么做”。

### 7.3 substrate-first truth

任务状态、artifact、resume、control metadata 应尽量绑定 OpenClaw substrate facts，再由 OctoClaw 追加策略语义，而不是反过来伪造一套脱离 substrate 的平行真相层。

### 7.4 optional backend，而不是 backend-first

ClawTeam / tmux / heavier operator runtime 的价值是真实存在的，但它们必须是可选增强，不应再定义系统边界。

### 7.5 artifact-first，而不是 transcript-first

复杂任务的主要产出应该是 artifact 与 structured result，而不是把原始对话和长输出塞回主链。

### 7.6 文档层也要有 source-of-truth 分级

从现在开始，文档也要遵守分层：

1. **canonical**：本文件 + 执行计划
2. **active supporting references**：仍值得作为局部设计依据的专题文档
3. **historical archive**：保留决策演化背景，但不再作为当前真相源

---

## 8. 当前架构中的关键张力

### 8.1 Python control plane 仍然过重

当前 repo 仍有大量 Python runtime/control-plane 脚本。这并不等于马上要全面迁移，但意味着语言边界必须在后续执行计划里明确，不然设计和实现会继续漂移。

### 8.2 route 语义与 work contract 心智尚未完全对齐

文档层已经更偏向“执行合同选择”，但部分实现与叙事仍带有“任务像什么”的旧惯性。

### 8.3 observer / patrol / runner 的统一仍在进行中

近期提交显示方向已经清晰，但还没有完全到“单一运行时心智”。

### 8.4 README 与历史文档仍混杂操作说明、方向判断、实验材料

这是本轮文档重组要解决的问题之一：README 做入口，新 canonical docs 做判断，archive 保留历史，不再让读者在根目录里自己猜哪篇最重要。

---

## 9. 文档分级结论

完整分级见 [`archive/design-notes/README.md`](./archive/design-notes/README.md)。

高层结论是：

- **仍有局部参考价值，但不再能当总纲的文档**：`octoclaw-product-design-v2-*`、`octoclaw-review-and-action-plan-*`、`octoclaw-openclaw-task-flow-*`、`octoclaw-state-machine-remediation-*` 等
- **更偏外部研究/借鉴输入的文档**：`clawteam-*`、`deerflow-*`、`octoclaw-anthropic-agent-engineering-notes-*`
- **明显属于早期路线判断、已经被后续 runtime direction 收口的文档**：`octoclaw-direction-analysis-*`、`octoclaw-roadmap-*`、`octoclaw-strategy-summary-*`

---

## 10. 现在的目标结构

当前可以把 OctoClaw 的目标结构收敛成：

```text
OpenClaw substrate
  -> tasks / flows / native control metadata / session return baseline

OctoClaw policy + control
  -> route / dispatch / model policy / task records / artifact shaping
  -> status / details / timeline / graph / retrieve / ctl
  -> observer / resume / recovery / budget / delivery policy

Optional operator backend
  -> tmux workbench
  -> ClawTeam / heavier swarm runtime
  -> programmatic execution helpers
```

如果未来再继续演进，核心不是“再加更多 agent 类型”，而是：

- 进一步减少不必要的常驻件
- 让 substrate 绑定更完整
- 让 control surface 更一致
- 让 heavy backend 更晚、更按需地介入

---

## 11. 这份底稿的使用方式

后续所有实现判断，优先问四个问题：

1. 这项改动是在强化 substrate truth，还是又造了一套平行 truth？
2. 这项改动是在简化 lane / control / observer 心智，还是又增加新的分叉？
3. 这项改动是在削弱对重 backend 的刚性依赖，还是把系统重新绑回去？
4. 这项改动能否进入执行计划的近期优先级，而不是只停留在概念层？

如果答不上来，就先回到 [`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md) 看阶段优先级，而不是继续新增专题设计文档。
