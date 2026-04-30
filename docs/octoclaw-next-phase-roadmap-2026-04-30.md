# OctoClaw 下一阶段完整规划

> 基于：全量文档扫描（docs/、docs/archive/、.planning/phases/、.sisyphus/、.omx/plans/、历史分支、Anthropic 工程笔记、DeerFlow/ClawTeam/OMO 借鉴分析）  
> 日期：2026-04-30  
> 分支：`refactor/0.4.0-stable`

---

## 零、真相层级（How to Read This Doc）

当代码、设计文档、历史文档三者不一致时，优先级如下：

```
现有代码（refactor/0.4.0-stable）
  ↓ 高于
现有设计文档（docs/ 中最新版本）
  ↓ 高于
历史规划文档（docs/archive/、.planning/phases/、历史分支）
```

**历史文档的正确用途**：只用来检查"有没有遗漏"——即历史上设计过、现在代码里已经没有了的功能是否应该保留。不要用历史文档驱动决策，也不要用它来推翻现有实现。

---

## 一、重要修正（vs 之前版本的规划）

之前的规划把 Auto Router 放在 P1，**这是错的**。读完全量文档后，正确的优先级是：

> **先让 OctoClaw 能证明发生了什么、花了多长时间、花了多少钱、结果是否更好。然后再优化。**

这是 `octoclaw-next-stage-roadmap-and-execution-design-2026-04-25.md` 里已经说清楚的原则，Auto Router 是 Phase 5，不是 Phase 1。

---

## 二、已完成的全貌（比之前更完整）

### 2.1 五阶段 TypeScript 重构（全部完成，2026-04-17）

| Phase | 核心产出 |
|-------|---------|
| 1 重建基线对齐 | 冻结 TS 重建设计，建立护栏（禁 Python/大 JS live-path）|
| 2 运行时核心与安全委派 | TS Contracts/Policy/RuntimeCore 包，claim/lease/delivery，安全委派原语 |
| 3 原生基底与运营面 | OpenClaw native TaskFlow TS 适配，substrate-first 投影，IM/运营面统一 |
| 4 评估门和高级路由 | 推广级 gate，路由策略 golden，shadow drift，acceptance harness |
| 5 执行基底重构 | TS-native live path，零 Python/shell 权威，执行合同驱动路由 |

### 2.2 refactor/0.4.0-stable 新增（本次重构批次）

✅ Completion file protocol（显式结构化结果，删除 530 行文件扫描）  
✅ Delivery outbox 重试队列  
✅ ACK 三相模型（ACK/Progress/Final）  
✅ IM adapter 注册表（Slack 已实现，接口可扩展）  
✅ 状态面板 Slack mrkdwn 渲染 + 按重要性排序  
✅ 模型按需选择（fallback rank 自动映射 + user overrides）  
✅ octoclawctl 统一安装工具（含 judge-fast.json 自动迁移）  
✅ 插件开关（enabled=false 不卸载）  
✅ ACK thread 锚定（Route C via Slack conversations.history API）  
✅ 夜间回放 delivery lane 新事件（completion_file_*、delivery_outbox_*）  
✅ ackNoTarget 从 unknown → fail bucket  

---

## 三、已确认的设计原则（来自 Anthropic 工程笔记）

1. **工作流优先，agent 其次**：`direct/runner/spawn_single/spawn_multi` 是正确顶层形态
2. **上下文工程比 prompt 设计更重要**：brief/summary/artifact 不是旁路，是核心产品
3. **工具是产品，不是管道**：工具合同、描述、shaped results 为模型消费而设计
4. **长时运行 harness 是一等公民**：所有权锁、dead-agent 恢复、progress signal、delivery 不可妥协
5. **多 agent 是选择性的**：orchestrator-worker；`spawn_single` 是默认；多 agent 只用于真正需要并行探索的场景
6. **每天 eval 和事后复盘**：小 eval 早做；真实故障驱动；短反馈循环

---

## 四、ClawTeam / DeerFlow / OMO 借鉴分析结论

### ClawTeam（借用什么）
- ✅ 任务存储 + 显式锁所有权 + stale-lock 释放语义
- ✅ Session 持久化（不从日志重发现）
- ✅ Worktree 隔离 + checkpoint
- ✅ Spawn retry/backoff + 幂等性
- ❌ 不把 tmux 变系统先决条件
- ❌ 不把 swarm runtime 变默认
- **决策**：ClawTeam 是**可选 backend**，不是依赖。OpenClaw native TaskFlow 是执行真相，ClawTeam 模式是实现灵感。

### DeerFlow（借用什么）
- ✅ 执行模式分层：L0 direct → L1 runner → L2 single → L3 multi → L4 heavy
- ✅ 隔离子 agent 上下文：只给 task brief + 约束 + expected output + artifact refs，不给完整父上下文
- ✅ 激进摘要化：中间结果写文件系统，主链只看 summary + status + artifacts
- ❌ 不导入 DeerFlow 主控循环
- ❌ 不把学习循环放进 v1 热路径
- **决策**：DeerFlow 给执行**哲学**，不给实现。

### OMO（Ultrawork）Session Continuity
- 委派任务返回 `session_id`，后续 follow-up 恢复同一个子 session（而不是新开）
- OctoClaw 实现：`workContractId + delegateTaskId + childSessionKey`（比原始 `session_id` 更安全）
- ❌ 不导入 OMO 的完整学习循环
- **决策**：只借 session continuity 模式，学习循环保持在热路径之外。

---

## 五、重要发现（读完全量文档后的修正）

### 发现 1：反馈链路已经有 7 个独立工具，需要统一而非新建

**已有**：replay log → replay summary → review → curate → validate → promote → learn

**问题**：7 个工具相互独立，没有统一的观察-总结-审核-精选-验证-推广-学习链路。

**P2 真正要做的**：统一成一条链，而不是"从零建反馈循环"。

### 发现 2：IM 层各渠道的第一桶已存在，缺的是能力矩阵

**已有**：Slack/飞书/Discord/Telegram/WhatsApp 各自有实现  
**问题**：没有正式的 L0/L1/L2 能力分级，没有统一的 anchor/thread/action/artifact 语义  
**P3 真正要做的**：定义能力矩阵 + 统一降级规则，而不是"构建 IM 层"

### 发现 3：Substrate（TaskFlow）集成基本做完，需要清理而非重建

**已有**：taskflow-bound runner jobs、native taskflow 控制元数据、session resume 持久化、on-demand runner fallback  
**问题**：mirror/managed 双模式并存，没有明确的融合规则  
**P4 真正要做的**：managed TaskFlow 升为主，mirror 作兼容层

### 发现 4：Auto Router 是 Phase 5，不是 P1

**错误直觉**：模型选择是独立小功能，可以先做  
**文档实际说的**：Auto Router 依赖 truth spine + measurement gate + feedback loop 全部稳定后才能有意义地运作。在没有 cost/latency baseline 的情况下做 router 只是直觉，不是数据驱动的。  
**Auto Router 的正确位置**：Phase 5，在 P0-P4 全部完成后。

### 发现 5：有 8 个 P0 高危区

| 高危区 | 描述 |
|--------|------|
| IM thread anchor 失败→静默跳过 | `no_valid_thread_anchor` 应降级为 top-level，不是 skip（已部分修复）|
| Status 重启后投影漂移 | `policyState` fallback 违反重启持久性 |
| Delivery outbox 无 retry 语义 | 结果能入队但没有完整的重试/flush 生命周期（已有基础）|
| Delegate 路由的 tier 推送 | tier1/2/3 "还在跑" 消息仍有可能回退（已修复大部分）|
| Replay 仍然中心化 | replay-logger.ts 仍然是 God File 中心（已拆分，但 delivery relay 仍有耦合）|
| 受保护 lane 未强制执行 | session_control / control_observer 仍可能被误委派 |
| Substrate mirror 未废弃 | native + mirror 双真相，没有明确融合规则 |
| cost/latency baseline 未自动化 | D3 nightly 未完全接通，gate 决策仍靠直觉 |

---

## 六、正确的五阶段规划

### Phase 0/P1：真相收敛 + 术语统一（6-8 周）

**目标**：让所有读状态的地方读同一个来源，让 observer/patrol/runner/ctl 术语清晰

| 任务 | 具体内容 |
|------|---------|
| 真相收敛 | Native TaskFlow = 执行生命周期真相；WorkContract = 语义/委派真相；task-state.json = 持久投影；只这三个，其余是派生 |
| Status 读 durable task-state | `octoclaw_status` 停止 fallback 到 policyState；重启后状态从 task-state.json 完整恢复 |
| Delivery outbox 完整模块 | 有界重试生命周期（最大尝试次数、指数退避、flush 语义）|
| ACK 三相模型验证 | 确认 tier1/2/3 在 delegate 路由下不会触发（已修，需验证）|
| Replay 彻底拆分 | replay-logger.ts 降为 re-export shim，delivery relay 完全退出 live path |
| 术语统一 | Observer/Patrol/Runner/Ctl 边界清晰，各有测试覆盖，文档对齐 |

**交付物**：
- 任何查询 `octoclaw_status` 都不依赖内存状态
- 重启 OpenClaw 后，任务状态不丢失
- replay 日志只是 observability 旁路，不影响行为

---

### Phase 2：反馈链路统一（4-6 周）

**目标**：把 7 个独立工具变成一条可观察的链

```
observe → summarize → review → curate → validate → promote → learn
```

| 工具 | 当前状态 | 统一后角色 |
|------|---------|----------|
| replay log | ✅ 存在 | observe |
| replay summary | ✅ 存在 | summarize |
| reply review | ✅ 存在 | review |
| curate/fixture export | ✅ 存在 | curate |
| nightly eval | ✅ 存在 | validate |
| calibration gate | ✅ 存在 | promote |
| learning/error promotion | ✅ 存在 | learn |

**具体工作**：
- 定义链中每个工具的输入/输出合同
- 统一 `observe → summarize` 边界（replay 格式标准化）
- 让 `validate → promote` 能自动阻断回归（calibration gate 接通 nightly）
- D3 nightly 完全接通 cost/latency/correctness 三维指标

**交付物**：
- 每次 route 决策都有可追踪的 telemetry id
- 每次变更都有 gate report（pass/fail/unknown）
- cost/speed 对比在数据上可证明，不靠直觉

---

### Phase 3：IM 能力矩阵（4-6 周）

**目标**：定义正式的 L0/L1/L2 能力分级，统一 anchor/thread/action/artifact 语义

| 能力层 | 包含 |
|--------|------|
| L0（所有渠道）| 文本消息、ACK、基本状态 |
| L1（支持 thread 的）| Thread reply、Progress update in thread |
| L2（富媒体）| 飞书卡片、Slack mrkdwn block、按钮交互 |

**具体工作**：
- 飞书 `sendCard()` 实现（接口已设计，需要 adapter）
- 微信 OctoClaw IMAdapter 实现（`openclaw-weixin` 已在 OpenClaw）
- 统一降级规则：L2 失败 → L1；L1 失败 → L0
- Anchor/thread/notification/action 语义在所有渠道保持一致

**交付物**：
- 飞书用户看到卡片，不是纯文本
- 跨渠道的 ACK/Progress/Final 行为一致
- 新渠道接入只需实现 IMAdapter 接口

---

### Phase 4：基底收敛（6-8 周）

**目标**：managed TaskFlow 升为主，mirror 作兼容层，清理双真相

**具体工作**：
- 明确字段映射：OctoClaw ↔ native task/flow/run/session
- Revision/state/wait/cancel 语义对齐
- 废弃 mirror 模式（兼容层保留，不再是权威）
- 测试：基底状态转换完全可追踪

---

### Phase 5：Auto Router 加固（8-10 周）

**前提**：Phase 0-4 全部完成，有 cost/latency baseline

**Auto Router 完整设计**（已有，来自 `octoclaw-auto-router-design.md`）：

#### 五层架构
1. **Signal 层**：task_type、complexity、reasoning_need、tool_need、context_size、latency/cost sensitivity、language、workspace/risk hints
2. **Router Core（V1）**：确定性规则 + intent/semantic route + optional tiny judge → route class + candidate set
3. **Budget Planner（R2）**：联合选择 `(model, output_budget)`，budget 是一等决策变量
4. **Policy/Gateway Adapter**：provider allowlist、health/cooldown、quota pressure、privacy policy、fallback chain
5. **Model-Intel/Feedback Loop**：price、capability profile、health、quota pressure、route outcome、replay/validation/promotion

#### Execution Contract 优先
Router 的**第一个任务**是决定执行合同（不是选模型）：
- `direct`：主 agent 直接完成
- `runner`：轻量任务执行 lane
- `spawn_single`：委派给单一子 agent（默认）
- `spawn_multi`：多 worker 或 parent-child TaskFlow（保守）

然后各 lane 内部再做 model/budget 决策。

#### V1 → V2 渐进
- **V1（规则优先）**：确定性规则处理显然情况 → tiny judge 处理模糊情况 → route class + budget
- **V1.5（合同稳定）**：`recommend(request) / resolve(recommendation, policy) / record_outcome()` 接口固定
- **V2（反馈驱动）**：基于 replay/validation 数据的 learned recommender，低置信度仍 fallback 到规则

#### 永不做的
- Online bandit/RL 训练（P5 之后才考虑）
- Learned router 作为 live hot path（先 shadow 推荐，再推广）
- Auto Router 变成独立服务（保持 plugin-first）

---

## 七、近 1-2 周 Action Items

```
立刻（P0 验证）：
  1. 发 Slack DM，验证 ACK 进 thread（Route C 刚部署）
  2. child-finalizer.ts 加 completion_file_delivered/timeout replay 事件
  3. judge timeout 调优（qwen3-judge:0.6b-q4km 经常 2s timeout）

本周（Phase 0 核心）：
  4. octoclaw_status 停止 fallback 到 policyState（读 durable task-state）
  5. Delivery outbox 完整的 retry/flush 生命周期
  6. Replay 彻底拆分（消除 delivery relay 在 live path 的最后耦合）

下周（Phase 1）：
  7. Observer/Patrol/Runner/Ctl 术语边界清晰
  8. Protected lanes 盘点 + 测试
```

---

## 八、开源高星路径

完成 Phase 0-2 后，可以对外的 pitch：

> **一条命令安装，让 OpenClaw 变成真正好用的多 agent 工作流引擎**
>
> - 消息到来 <1s ACK，任务进 Slack/飞书/微信 thread
> - 复杂任务自动委派，简单任务直接回答，按复杂度选模型（省钱）
> - 任务运行中：IM 里能看进度；任务完成：结果推送到原消息线程
> - 任务失败可以 retry，不需要重头再来
> - 一份 cost/speed 对比报告，数据上证明比裸跑 OpenClaw 省钱

这个 pitch + `npx octoclawctl install` 是冲 GitHub 高星的正确姿势。但前提是 Phase 0-2 完成，基础稳了。

---

## 九、不该做的事

1. **不要在没有 cost/latency baseline 的情况下做 Auto Router**
2. **不要把 ClawTeam/tmux 变成 live path 依赖**
3. **不要做 compound/multi-step 多智能体编排**（solo_worker 先稳固）
4. **不要把学习循环放进热路径**
5. **不要重建已经存在的系统**——反馈链路/IM层/Substrate 都有第一桶，统一它们，不是推倒重来
6. **不要用新功能来掩盖基础稳定性问题**

---

*文档路径：`docs/octoclaw-next-phase-roadmap-2026-04-30.md`*  
*基于全量文档扫描：docs/、docs/archive/、.planning/phases/ 全部、.sisyphus/、.omx/plans/、历史分支、Anthropic 工程笔记*
