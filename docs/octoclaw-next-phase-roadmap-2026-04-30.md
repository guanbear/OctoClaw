# OctoClaw 下一阶段完整规划

> 基于：全量文档扫描 + 代码核查（extensions/、tools/、docs/）  
> 最后核查日期：2026-04-30  
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

本文档所有 ✅/⚠️/❌ 均经过代码核查，不是凭记忆写的。

---

## 一、重要修正（vs 之前版本的规划）

之前的规划把 Auto Router 放在 P1，**这是错的**。正确的优先级是：

> **先让 OctoClaw 能证明发生了什么、花了多长时间、花了多少钱、结果是否更好。然后再优化。**

Auto Router 是 Phase 5，不是 Phase 1。

---

## 二、已完成的全貌（代码核查后）

### 2.1 五阶段 TypeScript 重构（全部完成，2026-04-17）

| Phase | 核心产出 |
|-------|---------|
| 1 重建基线对齐 | 冻结 TS 重建设计，建立护栏（禁 Python/大 JS live-path）|
| 2 运行时核心与安全委派 | TS Contracts/Policy/RuntimeCore 包，claim/lease/delivery，安全委派原语 |
| 3 原生基底与运营面 | OpenClaw native TaskFlow TS 适配，substrate-first 投影，IM/运营面统一 |
| 4 评估门和高级路由 | 推广级 gate，路由策略 golden，shadow drift，acceptance harness |
| 5 执行基底重构 | TS-native live path，零 Python/shell 权威，执行合同驱动路由 |

### 2.2 refactor/0.4.0-stable 新增（代码核查后，逐条确认）

| 功能 | 状态 | 核查说明 |
|------|------|---------|
| Completion file protocol | ✅ | `child-finalizer.ts:50` 读 `{workContractId}.completion.json`，无 .jsonl 扫描 |
| Delivery outbox + 完整 retry | ✅ | `delivery-outbox.ts` 已有指数退避 `[30s,60s,120s,300s]` + MAX 5 次，不只是基础 |
| ACK guard + execution notifications | ✅ | ACK0/Tier1-3/execution-transition-notifier；三阶段 dispatch→progress→result 链路 |
| IM adapter 注册表 | ✅ | `im/index.ts:34` `registerIMAdapter()`，Slack 已注册，接口可扩展 |
| 状态面板 Slack mrkdwn 渲染 + 重要性排序 | ✅ | `im-status-renderer.ts:85` `buildSlackStatusOutput()`，含 emoji + bold |
| 模型按需选择（动态 model map） | ✅ | `model-map.ts:131` 调 `openclaw models list --json`，5 分钟缓存 |
| octoclawctl 统一安装工具 + judge-fast.json 自动迁移 | ✅ | `config.ts:96` 自动 import legacy judge-fast.json |
| 插件开关（enabled=false 不卸载） | ✅ | `extension-entry.ts:845` 跳过 hook 注册，不 unload |
| ACK thread 锚定（Route C via Slack conversations.history） | ✅ | `slack-thread-anchor.ts:48`，10s 缓存，找最新非 bot 消息 |
| ackNoTarget 从 unknown → fail bucket | ✅ | `classifier.ts:412` failCount 包含 ackNoTarget |
| DM 频道（D 前缀）footer 支持 | ✅ | `extension-entry.ts` `/^[cud].../` 修复，2026-04-30 部署 |
| reply route ACK 顺序修复 | ✅ | `doSendRouteCommitAck` 检查 tracking state，不依赖 liveState 非 null，2026-04-30 部署 |
| 夜间回放 delivery lane 新事件 | ⚠️ | classifier 已有接收代码，但 **runtime 未发出**这些事件（见待办 #1）|

---

## 三、设计原则

1. **工作流优先，agent 其次**：`direct/runner/spawn_single/spawn_multi` 是正确顶层形态
2. **上下文工程比 prompt 设计更重要**：brief/summary/artifact 不是旁路，是核心产品
3. **工具是产品，不是管道**：工具合同、描述、shaped results 为模型消费而设计
4. **长时运行 harness 是一等公民**：所有权锁、dead-agent 恢复、progress signal、delivery 不可妥协
5. **多 agent 是选择性的**：`spawn_single` 是默认；多 agent 只用于真正需要并行探索的场景
6. **每天 eval 和事后复盘**：小 eval 早做；真实故障驱动；短反馈循环

---

## 四、P0 高危区（代码核查后，逐条更新）

| 高危区 | 代码核查结论 |
|--------|------------|
| IM thread anchor 失败→静默跳过 | ✅ **已修**：Route C 部署，ackNoTarget → fail bucket |
| Status 重启后投影漂移 | ✅ **已好于预期**：`octoclaw_status` 直接读 task-state 文件（非 policyState），重启不漂移；但 task-state 文件损坏时无 fallback，需监控 |
| Delivery outbox 无 retry 语义 | ✅ **已完整**：指数退避 + 5 次上限，非"已有基础" |
| Delegate 路由的 tier 推送 | ✅ **已修**：updateAckGuardDecision 取消 delegate/observe 路由的 tier 定时器 |
| Replay 仍然中心化 | ⚠️ **部分**：`appendExecutionCoverageProjection` 已禁用（no-op），footer 移入 message_sending hook；但 replay-logger.ts 本体结构未完全拆分 |
| 受保护 lane 未强制执行 | ⚠️ **仍开放**：protected_lane 字段存在但无 dispatch 层面的拦截验证 |
| Substrate mirror 未废弃 | ❌ **仍开放**：native + mirror 双真相，无融合规则 |
| cost/latency baseline 未自动化 | ❌ **仍开放**：D3 nightly 未全接通，gate 决策仍靠直觉 |
| child-finalizer 无 replay 事件 | ❌ **新发现**：completion_file_delivered/timeout 事件从未被发出 |

---

## 五、正确的五阶段规划

### Phase 0：热路径稳定（当前阶段）

**目标**：消除已知 bug，让基础行为可靠

**待办（按优先级）**：

```
立刻：
  1. child-finalizer.ts 发出 completion_file_delivered/timeout replay 事件
     （classifier 已准备好，只差 emitter）
  2. judge timeout 调优（qwen3-judge:0.6b-q4km 频繁 2s timeout）

近期：
  3. Protected lane 拦截：session_control/control_observer 不可被误委派
  4. task-state.json 损坏时的 fallback 监控/告警
```

---

### Phase 1：真相收敛 + 术语统一（6-8 周）

**目标**：让所有读状态的地方读同一个来源，让 observer/patrol/runner/ctl 术语清晰

| 任务 | 具体内容 |
|------|---------|
| 真相来源明确 | Native TaskFlow = 执行生命周期真相；WorkContract = 语义/委派真相；task-state.json = 持久投影 |
| Replay 彻底拆分 | replay-logger.ts 降为 re-export shim，delivery relay 完全退出 live path |
| 术语统一 | Observer/Patrol/Runner/Ctl 边界清晰，各有测试覆盖，文档对齐 |

**交付物**：
- replay 日志只是 observability 旁路，不影响行为
- 术语有文档，有测试，不混用

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
- 飞书 `sendCard()` 实现（IMAdapter 接口已有，需实现）
- 微信 IMAdapter 实现（`openclaw-weixin` 已在 OpenClaw）
- 统一降级规则：L2 失败 → L1；L1 失败 → L0

**交付物**：
- 跨渠道的 ACK/Progress/Final 行为一致
- 新渠道接入只需实现 IMAdapter 接口

---

### Phase 4：基底收敛（6-8 周）

**目标**：managed TaskFlow 升为主，mirror 作兼容层，清理双真相

**具体工作**：
- 明确字段映射：OctoClaw ↔ native task/flow/run/session
- Revision/state/wait/cancel 语义对齐
- 废弃 mirror 模式（兼容层保留，不再是权威）

---

### Phase 5：Auto Router 加固（8-10 周）

**前提**：Phase 0-4 全部完成，有 cost/latency baseline

**Auto Router 完整设计**（来自 `octoclaw-auto-router-design.md`）：

Router 的**第一个任务**是决定执行合同：
- `direct`：主 agent 直接完成
- `runner`：轻量任务执行 lane
- `spawn_single`：委派给单一子 agent（默认）
- `spawn_multi`：多 worker 或 parent-child TaskFlow（保守）

五层架构：Signal → Router Core → Budget Planner → Policy/Gateway → Model-Intel/Feedback

**永不做的**：
- Online bandit/RL 训练（P5 之后才考虑）
- Learned router 作为 live hot path（先 shadow 推荐，再推广）

---

## 六、开源高星路径

完成 Phase 0-2 后，可以对外的 pitch：

> **一条命令安装，让 OpenClaw 变成真正好用的多 agent 工作流引擎**
>
> - 消息到来 <1s ACK，任务进 Slack/飞书/微信 thread
> - 复杂任务自动委派，简单任务直接回答，按复杂度选模型（省钱）
> - 任务运行中：IM 里能看进度；任务完成：结果推送到原消息线程
> - 任务失败可以 retry，不需要重头再来
> - 一份 cost/speed 对比报告，数据上证明比裸跑 OpenClaw 省钱

前提：Phase 0-2 完成，基础稳了。

---

## 七、不该做的事

1. **不要在没有 cost/latency baseline 的情况下做 Auto Router**
2. **不要把 ClawTeam/tmux 变成 live path 依赖**
3. **不要做 compound/multi-step 多智能体编排**（solo_worker 先稳固）
4. **不要把学习循环放进热路径**
5. **不要重建已经存在的系统**——反馈链路/IM层/Substrate 都有第一桶，统一它们，不是推倒重来
6. **不要用新功能来掩盖基础稳定性问题**

---

## 附：活跃设计文档索引

`docs/` 目录下只保留以下文档，其余已移入 `docs/archive/`。

| 文档 | 覆盖范围 | 关联阶段 |
|------|---------|---------|
| [octoclaw-design-foundation.md](octoclaw-design-foundation.md) | 系统定义：OctoClaw 是什么、架构边界、反馈闭环底稿 | 全局 |
| [octoclaw-state-convergence-4-4-design.md](octoclaw-state-convergence-4-4-design.md) | 真相权威层级：TaskFlow > task-state.json > policyState | Phase 0/1 |
| [octoclaw-phase1-stabilization-design-2026-04-29.md](octoclaw-phase1-stabilization-design-2026-04-29.md) | Phase 0/1 稳定性目标：状态投影、重启恢复、delivery retry、thread anchor | Phase 0/1 |
| [octoclaw-judge-ack-policy-spec-2026-04-21.md](octoclaw-judge-ack-policy-spec-2026-04-21.md) | Judge 分层、ACK 决策真相表、thread 交付规范 | Phase 0/1 |
| [octoclaw-work-contract-centered-delegation-design-2026-04-25.md](octoclaw-work-contract-centered-delegation-design-2026-04-25.md) | WorkContract 委派核心设计（线上运行中） | Phase 0/1 |
| [octoclaw-phase2-lightweight-install-design-2026-04-30.md](octoclaw-phase2-lightweight-install-design-2026-04-30.md) | Phase 2 统一配置、插件开关、安装工具 | Phase 2 |
| [octoclaw-nightly-eval-scheduler-2026-04-26.md](octoclaw-nightly-eval-scheduler-2026-04-26.md) | 夜间 eval 调度、D3 指标接通方案 | Phase 2 |
| [octoclaw-im-display-contract.md](octoclaw-im-display-contract.md) | IM 渲染合同：anchor/thread/action/artifact 语义 | Phase 3 |
| [octoclaw-auto-router-design.md](octoclaw-auto-router-design.md) | Auto Router 五层架构完整设计 | Phase 5 |

---

*文档路径：`docs/octoclaw-next-phase-roadmap-2026-04-30.md`*  
*代码核查分支：`refactor/0.4.0-stable`，核查日期：2026-04-30*
