# OctoClaw 下一阶段规划

> 基于：所有历史设计文档、.planning/phases、docs/archive、Anthropic 工程笔记、当前代码状态  
> 日期：2026-04-30  
> 分支：`refactor/0.4.0-stable`

---

## 一、当前已完成的能力

**5 阶段 TypeScript 重构全部完成（Phase 1-5）。** 系统基础稳固：

| 能力 | 状态 |
|------|------|
| TypeScript-first 执行策略 | ✅ |
| OpenClaw native task/flow 真相路径 | ✅ |
| 安全委派（scope/claim/lease/outbox）| ✅ |
| WorkContract 语义合同 | ✅ |
| Judge 单模型路由（本地 Ollama / 远程廉价 API）| ✅ |
| Completion file protocol（显式结构化结果）| ✅ |
| Delivery outbox 重试队列 | ✅ |
| ACK 三相模型（ACK/Progress/Final）| ✅ |
| IM adapter 注册表（Slack 已接，可扩展）| ✅ |
| 状态面板 Slack mrkdwn 渲染 | ✅ |
| 模型按需选择（fallback rank 自动映射）| ✅ |
| octoclawctl 统一安装工具 | ✅ |
| 插件开关（enabled=false 不卸载）| ✅ |
| 夜间回放 5 lane 评估 + calibration gate | ✅ |
| Slack acceptance harness 8 场景 | ✅ |
| ACK thread 锚定（Route C via Slack API）| ✅（刚完成）|

---

## 二、已确认的 Anthropic 工程原则

以下原则来自项目集成的 Anthropic 官方资料，已内化进当前架构：

1. **工作流优先，agent 其次**：`direct/runner/spawn_single/spawn_multi` 是正确的顶层形态，不默认多 agent
2. **上下文工程比 prompt 设计更重要**：状态/摘要/产出物/最近行动比系统提示长度更关键
3. **工具是产品，不是管道**：工具合同、描述、shaped results 要为模型消费而设计
4. **长时运行 harness 是一等公民**：恢复性、交接产出物、checkpoint、跨会话连续性、进度可见性不可妥协
5. **多 agent 是选择性的**：orchestrator-worker 模式；`spawn_single` 是默认；多 agent 只用于真正需要并行探索的场景
6. **每天 eval 和事后复盘**：小 eval 早做；用真实故障驱动；短反馈循环

---

## 三、优先级规划

### 优先级 P0：稳定性和可靠性（立刻做）

**目标**：让现有功能真正稳定好用，消除用户感知到的 bug

| 任务 | 问题描述 | 工作量 |
|------|---------|--------|
| **ACK 进 thread 验收** | Route C 刚部署，需确认 Slack DM 里 ACK 进入正确 thread | 测试 |
| **夜间回放 delivery lane 数据补全** | child-finalizer 需要加 `completion_file_delivered/timeout` replay 事件，否则 delivery lane total=0 | 1h |
| **status panel 展示验证** | 确认 Slack mrkdwn 格式（新代码）实际生效，imType 检测正常 | 测试 |
| **judge timeout 优化** | qwen3-judge:0.6b-q4km 经常 2000ms timeout；考虑降低 timeoutLocalMs 或换更快模型 | 配置 |
| **replay-logger fire-and-forget 验证** | 确认 `recordPolicyReplay` 在 live path 中是 void 调用 | 查代码 |

### 优先级 P1：Auto Router V1（下一个重大功能）

这是项目**最重要的下一步**，历史设计文档里已经完整设计了，但从未实现。

**核心价值**：自动根据任务复杂度、工具需求、预期时长选择合适的模型和执行模式，而不是一刀切用最贵的模型。

**当前状态**：
- Judge 已输出 `complexityBand`（simple/normal/deep）、`budgetBand`、`toolNeedHint`、`durationHint`
- `complexityModelMap` 已接 fallback rank 自动映射（T1 完成）
- 但路由模式（`spawn_single` vs `runner` vs `direct`）还是由 agent 手动决定

**V1 实现计划**（3-5 天，分 4 步）：

**步骤 1：提取路由推荐合同**
```typescript
interface RouteRecommendation {
  executionLane: "direct" | "runner" | "spawn_single";  // 执行模式
  workerPool: "octoclaw-main" | "octoclaw-research" | "octoclaw-code" | "octoclaw-review";
  modelProfile: "fast_cheap" | "balanced" | "capable";  // 直接映射到 complexityModelMap
  outputBudget: "short" | "medium" | "long" | "deep";
  reason: string;  // 供 debug 用
}
```

**步骤 2：规则优先的路由核心**
基于 judge 的输出，用确定性规则决定大多数情况：
```
toolNeedHint=required + durationHint=long → spawn_single + capable
toolNeedHint=none + complexityBand=simple → direct + fast_cheap
complexityBand=deep + durationHint=long → spawn_single + capable
fresh_live_lookup → spawn_single + balanced（环境查询类）
plain_chat → direct + fast_cheap
```

**步骤 3：接入 dispatch 工具**
`octoclaw_dispatch` 里的 `complexityModelMap` 已经接了，扩展为完整的 `RouteRecommendation`。

**步骤 4：Shadow mode 验证**
新路由推荐先在 shadow 模式跑一周，对比 replay log 里实际使用 vs 推荐的差异。

### 优先级 P2：IM 扩展

| 任务 | 说明 |
|------|------|
| **飞书卡片支持** | `buildFeishuStatusCard()` 已有接口设计，需要 `IMAdapter.sendCard()` 实现 |
| **微信适配** | `openclaw-weixin` 已在 OpenClaw 里，需要实现 IMAdapter 接口接进 OctoClaw |
| **DM vs Channel 差异处理** | DM 和 Channel 的 thread 行为不同，需要分别优化 ACK 策略 |

### 优先级 P3：Retry / Resume

当前 `octoclaw_task_action retry` 是空接口，核心逻辑未实现。

**设计**：
- **Retry**：从 `task-state.json` 读原任务描述，创建新 `octoclaw_dispatch` 调用，原 `workContractId` 标记为 `retrying`
- **Resume**：检查 `childSessionKey` 对应的 session 是否还活跃，活跃则续跑，不活跃则走 Retry

工作量约 3-4 天，需要同步更新状态面板（显示 retry 次数）。

### 优先级 P4：反哺 OpenClaw 社区

| 内容 | 说明 |
|------|------|
| **Completion file protocol PR** | 把 worker 写结构化完成文件的机制提交给 OpenClaw 上游 |
| **IMAdapter 规范** | 把 `IMAdapter` 接口设计作为 OpenClaw 插件标准 |
| **ACK thread anchor 问题报告** | OpenClaw 需要在 ctx 里传 `channelId` + `messageTs`，当前只传 `channelId` |

---

## 四、与历史设计文档的对照

### 已完成但历史文档标记"待做"的

| 历史标记 | 实际状态 |
|---------|---------|
| Completion file protocol（P0-T1）| ✅ 完成 |
| Remove minified aliases（P0-T2）| ✅ 完成 |
| ACK guard 先于 judge（P0-T3）| ✅ 完成 |
| Remote judge 删除（P0-T4）| ✅ 完成 |
| IM adapter registry（P1-T5）| ✅ 完成 |
| PolicyStateEntry 类型安全（P1-T6）| ✅ 完成 |
| ACK/Progress 三相模型（P1-T7）| ✅ 完成 |
| replay-logger 拆分（P1-T8）| ✅ 完成 |
| 幽灵包合并（P2-T9）| ✅ 完成 |
| 插件开关（P2-T10）| ✅ 完成 |
| octoclawctl 统一（P2-T11）| ✅ 完成 |
| 模型按需选择 T1（P3 part）| ✅ 基础完成，Auto Router V1 待做 |
| 状态面板 IM 适配（P3 part）| ✅ Slack mrkdwn 完成 |

### 历史文档明确"deferred"的

| 功能 | 历史理由 | 当前建议 |
|------|---------|---------|
| Auto Router V1（完整）| 需要 telemetry baseline 先 | **P1 优先级，现在可以做** |
| 飞书卡片 | 需要 IMAdapter.sendCard() | P2 |
| Retry/Resume | 需要先稳定 completion protocol | P3（P0 完成后可以做）|
| 多 agent coordinator | 需要 solo worker 先稳 | 暂不做，符合 Anthropic 原则 |
| ClawTeam/tmux 集成 | 非核心依赖 | 保持 optional，不进 live path |
| Online model learning | 无 baseline | Phase 5+ |

---

## 五、开源高星路径

完成 Auto Router V1 + Retry + 飞书适配后，OctoClaw 对外的 pitch 可以是：

> **一条命令安装，让 OpenClaw 变成真正好用的多 agent 工作流引擎**
>
> - 消息到来 <1s ACK（再也不用干等）
> - 复杂任务自动委派，简单任务直接回答（按复杂度自动选模型，省钱）
> - IM 里能看到任务进度（Slack mrkdwn 面板、飞书卡片）
> - 任务失败可以 retry，不需要重头再来
> - 支持 Slack、飞书、微信（IM adapter 可扩展）

这个 pitch 结合"npx octoclawctl install 一步搞定"，是可以冲 GitHub 高星的。

---

## 六、近期不应该做的

1. **不要在没有 telemetry baseline 的情况下做 online model learning**（Anthropic 原则明确说了）
2. **不要把 ClawTeam/tmux 变成 live path 依赖**（历史文档和架构诊断都明确 optional）
3. **不要做 compound/multi-agent 多步编排**（solo_worker 先稳固）
4. **不要添加新功能来掩盖基础稳定性问题**（先把 ACK/状态面板/delivery 做稳再扩展）

---

## 七、Action Items（按顺序）

```
1. 测试 ACK thread 是否通过 Route C 进入正确 thread
2. child-finalizer.ts 加 completion_file_delivered/timeout 事件（夜间 eval 数据）
3. Auto Router V1 步骤 1-2（合同定义 + 规则核心）— 1-2 天
4. Auto Router V1 步骤 3-4（接入 dispatch + shadow validation）— 1-2 天
5. Retry 基础实现
6. 飞书 IMAdapter + sendCard
```
