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

## 四、Phase 0：当前状态 + 行动项

P0 高危区和 Phase 0 是同一件事：下表同时列状态和行动项，不再分两处。

| 问题 | 状态 | 行动 |
|------|------|------|
| IM thread anchor 失败→静默跳过 | ✅ 已修：Route C 部署，ackNoTarget → fail | — |
| Delivery outbox 无 retry | ✅ 已完整：指数退避 [30s,60s,120s,300s] + 5次上限 | — |
| Delegate 路由 tier 推送 | ✅ 已修：updateAckGuardDecision 取消 delegate 路由的 tier 定时器 | — |
| Status 重启后投影漂移 | ✅ 已好于预期：直接读 task-state 文件，不依赖 policyState | 监控 task-state.json 损坏场景 |
| Protected lane 未强制执行 | ✅ 已有工具级拦截：control_observer/session_control 不允许 octoclaw_dispatch | — |
| child-finalizer 无 replay 事件 | ✅ **已修（2026-04-30）**：新增 completion_file_delivered / completion_file_timeout / delivery_outbox_queued | — |
| Judge timeout 过短 | ✅ **已修（2026-04-30）**：timeoutMs 1500→3000ms，timeoutLocalMs 800→2500ms | 如需更大可在 judge-fast.json 里覆盖 |
| Replay 仍然中心化 | ✅ **已好于预期**：历史文档提到的 `replay-logger.ts` 不存在，当前 `replay.ts` 是干净的工具集，无 delivery relay 耦合，所有调用均为 fire-and-forget | — |
| Substrate mirror 未废弃 | ❌ 仍开放：native + mirror 双真相，无融合规则 | Phase 4 工作 |
| cost/latency baseline 未自动化 | ❌ 仍开放：D3 nightly 未全接通，gate 决策仍靠直觉 | Phase 2 工作 |

**Phase 0 已全部完成。** 所有 ✅ 项均已修复或确认为好于预期。Substrate mirror 和 cost baseline 是 Phase 4/2 的工作，不属于 Phase 0 范围。

---

### Phase 1：真相收敛 + 术语统一 ✅ 已完成

**目标**：让所有读状态的地方读同一个来源，让 observer/patrol/runner/ctl 术语清晰

| 任务 | 状态 | 核查说明 |
|------|------|---------|
| 真相来源明确 | ✅ | `octoclaw_status` 纯读 task-state.json（磁盘），无 policyState fallback，重启持久 |
| Replay 彻底拆分 | ✅ | `replay.ts` 是纯工具集；live path 全部 `void` fire-and-forget；无 delivery 耦合 |
| 术语统一 | ✅ | Observer/Patrol/Runner/Ctl 边界明确，有代码执行（tool blocking），有测试，有文档 → [`octoclaw-role-terminology.md`](octoclaw-role-terminology.md) |

**交付物**：
- ✅ 任何查询 `octoclaw_status` 都不依赖内存状态
- ✅ replay 日志只是 observability 旁路，不影响行为
- ✅ 术语有文档，有测试，不混用

---

### Phase 2：反馈链路统一 ✅ 已完成

**背景**：nightly eval、calibration-gate、nightly classifier 已存在。工作是把已有的环节接成一条有合同的链，**不是从零建反馈循环**。

**目标链路**：
```
observe → summarize → review → curate → validate → promote → learn
```

| 环节 | 工具 | 状态 |
|------|------|------|
| observe | `replay.ts` | ✅ 30+ 事件类型，turnId/decisionId 全程可追踪 |
| summarize | `octoclawctl nightly` | ✅ 5 lanes + cost/latency/correctness 三维指标 |
| review | `octoclawctl review` | ✅ 列出 failure/unknown 样本，支持 JSON/text |
| curate | `octoclawctl curate --task-id <turnId>` | ✅ 从 replay log 导出 fixture |
| validate | `octoclawctl nightly-eval run` | ✅ 自动读取 stored baseline 运行 calibration |
| promote | `octoclawctl nightly-eval promote` | ✅ 保存 passing 报告为新 baseline |
| learn | 内置于 promote | ✅ baseline 版本演进即学习记录 |

**交付物**：
- ✅ 每次 route 决策都有可追踪的 telemetry id（turnId + decisionId）
- ✅ 每次变更都有 gate report（pass/fail/unknown）— calibration gate 自动与 stored baseline 对比
- ✅ cost/speed 对比在数据上可证明，不靠直觉

**参考**：[`octoclaw-feedback-loop-contracts.md`](octoclaw-feedback-loop-contracts.md)

---

### Phase 3：IM 能力矩阵（4-6 周）

**背景**：只有 Slack 有完整 adapter（`im/slack/slack-adapter.ts`）。飞书、微信、Telegram、Discord 只有类型定义和 capability 矩阵（`core/im/adapter.ts`），没有 adapter 实现，飞书/微信明确标注 DEFERRED。工作是**先定义能力矩阵和降级规则，再按优先级补 adapter**，不是"5个渠道都已有基础"。

**目标**：L0/L1/L2 能力分级正式化，anchor/thread/action/artifact 语义跨渠道统一

| 能力层 | 包含 |
|--------|------|
| L0（所有渠道）| 文本消息、ACK、基本状态 |
| L1（支持 thread 的）| Thread reply、Progress update in thread |
| L2（富媒体）| 飞书卡片、Slack mrkdwn block、按钮交互 |

**具体工作**：
- 正式化 L0/L1/L2 能力矩阵（当前只有 Slack 有完整路径）
- 统一降级规则：L2 失败 → L1；L1 失败 → L0
- 飞书 `sendCard()` adapter 实现（接口已设计，`im-status-renderer.ts` 有 stub）
- 微信 IMAdapter 实现（capability 矩阵已有，adapter 待做）

**交付物**：
- 跨渠道的 ACK/Progress/Final 行为一致
- 新渠道接入只需实现 IMAdapter 接口

---

### Phase 4：基底收敛（6-8 周）

**背景**：TaskFlow 的类型定义和 plumbing 已完成（`adapter/runtime-taskflow.ts` 中 syncMode managed/mirrored 字段存在）。但 mirror 模式**没有独立执行逻辑**，走的和 managed 是同一条代码路径，字段值不同但行为相同。工作是**赋予 mirror 明确的语义边界并废弃它，而不是重建 TaskFlow 集成**。

**具体工作**：
- 明确 mirror 模式的废弃时间表（兼容层保留，不再是权威）
- 明确字段映射：OctoClaw ↔ native task/flow/run/session
- Revision/state/wait/cancel 语义对齐
- 测试：基底状态转换完全可追踪

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

## 五、开源高星路径

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

## 六、不该做的事

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
| [octoclaw-role-terminology.md](octoclaw-role-terminology.md) | Observer/Patrol/Runner/Ctl 术语规范，工具边界，命名约定 | Phase 1 ✅ |
| [octoclaw-state-convergence-4-4-design.md](octoclaw-state-convergence-4-4-design.md) | 真相权威层级：TaskFlow > task-state.json > policyState | Phase 0/1 ✅ |
| [octoclaw-phase1-stabilization-design-2026-04-29.md](octoclaw-phase1-stabilization-design-2026-04-29.md) | Phase 0/1 稳定性目标：状态投影、重启恢复、delivery retry、thread anchor | Phase 0/1 |
| [octoclaw-judge-ack-policy-spec-2026-04-21.md](octoclaw-judge-ack-policy-spec-2026-04-21.md) | Judge 分层、ACK 决策真相表、thread 交付规范 | Phase 0/1 |
| [octoclaw-work-contract-centered-delegation-design-2026-04-25.md](octoclaw-work-contract-centered-delegation-design-2026-04-25.md) | WorkContract 委派核心设计（线上运行中） | Phase 0/1 |
| [octoclaw-phase2-lightweight-install-design-2026-04-30.md](octoclaw-phase2-lightweight-install-design-2026-04-30.md) | Phase 2 统一配置、插件开关、安装工具 | Phase 2 |
| [octoclaw-feedback-loop-contracts.md](octoclaw-feedback-loop-contracts.md) | 七步反馈链路合同：observe→summarize→review→curate→validate→promote→learn | Phase 2 ✅ |
| [octoclaw-nightly-eval-scheduler-2026-04-26.md](octoclaw-nightly-eval-scheduler-2026-04-26.md) | 夜间 eval 调度、D3 指标接通方案 | Phase 2 ✅ |
| [octoclaw-im-display-contract.md](octoclaw-im-display-contract.md) | IM 渲染合同：anchor/thread/action/artifact 语义 | Phase 3 |
| [octoclaw-auto-router-design.md](octoclaw-auto-router-design.md) | Auto Router 五层架构完整设计 | Phase 5 |

---

*文档路径：`docs/octoclaw-next-phase-roadmap-2026-04-30.md`*  
*代码核查分支：`refactor/0.4.0-stable`，核查日期：2026-04-30*
