# OctoClaw 执行计划

> 状态：当前 canonical 执行计划（2026-04-03）  
> 优先级原则：**近期执行优先，长期终局保留在后半部分**  
> 关联文档：[`octoclaw-design-foundation.md`](./octoclaw-design-foundation.md)、[`archive/design-notes/README.md`](./archive/design-notes/README.md)

---

## 1. 计划目的

这份计划不是简单复述旧路线图，而是把当前 repo 的实现现实、较新的提交方向、以及仍未解决的设计张力串成一个更适合继续开发的阶段计划。

它的目标是回答三件事：

1. 接下来**先做什么**最值
2. 哪些事**现在不该做**
3. 长期终局应该朝哪里收口

---

## 2. 当前判断：真正值得优先解决的问题

### P0. 文档与控制面真相源先收口

虽然本轮不改代码，但后续开发必须建立在更清晰的文档分层上：

- 设计判断看 `octoclaw-design-foundation.md`
- 阶段优先级看本文件
- 旧文档只作为 archive / decision history

否则后续每次重构都还会重新争论“到底应该按 3 月 25 日的 ClawTeam 方案，还是按 4 月 3 日的 unified runtime 方向走”。

### P1. 统一 observer / patrol / runner 的运行时心智

较新的提交已经把方向推向：

- runtime observer 收口
- on-demand runner fallback
- patrol observation pass 统一

因此近期第一优先级，不是继续发散新的 worker 形态，而是把这条线做清楚：

- 什么属于 observer
- 什么属于 runner execution
- 什么属于 control entrypoint
- 哪些状态必须统一落到 substrate + task record

### P2. 让 route / dispatch / result contract 更像“执行合同系统”

当前文档判断已经比实现更先进。接下来应优先把：

- route reason
- work contract
- result shaping
- retrieve path
- timeout / wait / handoff 语义

全部收敛到同一心智，而不是继续维持“语义分类 + 局部补丁”。

### P3. 把 taskflow-bound substrate 做成真正的默认事实层

近期提交已经证明方向正确：

- runner jobs → taskflow-bound tasks
- native taskflow control metadata
- session resume context persistence

下一步应继续补齐：

- lane 与 substrate 的对应关系
- observer / ctl 对 substrate facts 的读取优先级
- 各类 replay / review / retrieve 工具对同一事实层的复用

### P4. 把重 backend 降到真正可选

ClawTeam / heavier tmux runtime 不该立刻被删，但必须继续降级为：

- operator enhancement
- heavier collaboration path
- 特定复杂任务才启用

而不是成为默认依赖或文档心智中心。

---

## 3. 近期执行计划（推荐按这个顺序推进）

## Phase 1：统一 runtime observer 心智

### 目标

把当前 `patrol`、`runtime observer`、`on-demand runner fallback`、`octoclawctl` 的职责边界收清楚。

### 要完成的结果

- 明确 observer 的职责边界与输入输出
- 明确 patrol 是 observer 的哪一部分，而不是与 observer 平级并列的另一套世界
- 明确 runner 在“常驻 / 按需”两种形态下，统一如何进入 runtime truth
- 明确 `octoclawctl` 应该成为什么级别的统一控制入口

### 为什么排第一

因为不先收口这条线，后面的 taskflow、result shaping、optional backend 都会继续建立在模糊职责边界上。

### 成功信号

- 维护者可以用一句话解释 observer / patrol / runner / ctl 的关系
- 新增控制面逻辑时不再需要猜测应挂在哪个脚本上

### 风险

- 可能暴露大量历史脚本命名与职责重叠
- 短期会发现更多“其实该删/该合并”的组件

---

## Phase 2：把 route/dispatch 完全收口到执行合同

### 目标

把 route / dispatch / handoff / retrieve 的心智统一成执行合同系统。

### 要完成的结果

- 任务为什么走 `direct / runner / spawn_single / spawn_multi` 的原因可解释
- `wait-timeout`、`planned/executed`、handoff 语义更加一致
- summary / details / report_path 对主模型和人类都更好消费
- route 决策不再主要依赖“任务长得像什么”

### 依赖

需要先有更清晰的 observer / task truth 心智，否则 contract 无法稳定落地。

### 成功信号

- replay/review 中的误判原因更容易归因
- follow-up 不再频繁因为 route 结果不透明而重复派单

---

## Phase 3：taskflow substrate 继续扩面

### 目标

让更多 lane 和 control action 都以 taskflow-bound substrate 为第一事实层。

### 要完成的结果

- runner / spawn / retrieve / review 的核心事实都能绑定 substrate
- status / timeline / graph / retrieve 优先读 substrate-aware records
- resume / recovery / ownership 语义围绕同一事实层工作

### 为什么现在做

因为近期提交已经证明这条线有价值，而且它直接决定 OctoClaw 是否会继续维持平行 runtime truth。

### 风险

- 需要处理与旧本地镜像记录的兼容关系
- 可能暴露 OpenClaw native capability 公开面不够稳定的地方

---

## Phase 4：压缩长期常驻件，保留真正值钱的常驻能力

### 目标

进一步验证哪些 daemon / loop 必须常驻，哪些应该按需执行或被 observer 吸收。

### 要完成的结果

- 能解释为什么某个常驻进程存在
- runner 常驻不再成为默认前提
- patrol-loop 与其他 observer 逻辑不再重复保活

### 关注点

这不是“为了省进程数而省进程数”，而是为了减少状态漂移、恢复成本和运维心智负担。

---

## Phase 5：把重 backend 真正降到 optional operator lane

### 目标

把 ClawTeam / heavier tmux runtime 的角色稳定到“增强层”。

### 要完成的结果

- 默认单机/轻部署路径不依赖重 backend
- 需要 board/inbox/human handoff 时才启用更重运行面
- 文档和代码都不再把 ClawTeam 当成总架构中心

### 风险

- 如果 control surface 自身还不够好，会导致大家继续依赖重 backend 兜底

---

## 4. 中期终局（作为后半部分保留，而非当前第一优先级）

长期来看，OctoClaw 更合理的终局不是“更多 agent 类型”，而是下面这个结构：

```text
OpenClaw substrate truth
  +
OctoClaw policy / control / observer layer
  +
optional operator backends
```

在这个终局里：

- route 更像 contract selection
- artifact / retrieve 比 transcript 更重要
- control surface 比 prompt 技巧更重要
- optional backend 只在需要时介入
- 语言边界会逐步收口，而不是无限扩散

---

## 5. 明确延后项（现在先不要做）

以下事项不是“永远不做”，但不应排在近期主线前面：

1. 再新增一批专题设计文档
2. 把系统重新包装成通用多 Agent framework
3. 为了抽象而抽象地大规模改 worker taxonomy
4. 在 observer / taskflow 心智未稳定前做大规模 UI/看板产品化
5. 在控制面仍分裂时直接强推全面 Python→Node/TS 迁移

---

## 6. 旧文档如何映射到当前计划

- **总纲/方向类旧文档**：主要提供历史决策背景，不再直接指导实现顺序
- **产品设计与复盘类文档**：提供这份计划的输入材料，但已被本文件重组
- **专题方案类文档**：保留为局部实现时的 supporting references
- **外部项目借鉴类文档**：保留为 why / tradeoff 证据，不再决定系统边界

完整分级见 [`archive/design-notes/README.md`](./archive/design-notes/README.md)。

---

## 7. 维护规则

以后如果出现新的重要方向变化，优先更新这两份 canonical docs，而不是再往根目录平铺新的“v1/v2/v3 总纲”。

推荐规则：

- 新的总设计判断 → 更新 `octoclaw-design-foundation.md`
- 新的阶段优先级或实施顺序变化 → 更新 `octoclaw-execution-plan.md`
- 新的专题论证 / slice 记录 → 新增到 archive 或 supporting notes 区域，并明确它不是总真相源
