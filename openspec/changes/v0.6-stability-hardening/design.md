# Design: 稳定性收尾（A2）

## 1. Slack Smoke 5 Case

在 `extensions/octoclaw-runtime/src/im/slack/` 下补 smoke 测试，用 mock Slack server（已有 `slack-adapter.test.ts` 的 mock 模式）。

5 个 case：

| Case | 场景 | 期望 |
|------|------|------|
| S1 | 普通 reply，无 thread | `sent: true, delivered: true` |
| S2 | delegate，带 footer（model 字段） | footer 包含 model 名 |
| S3 | 流式 streaming，native transport | `transport: "native_streaming"` |
| S4 | Slack API 返回 `channel_not_found` | `sent: false, error: "IM_SEND_FAILED"` |
| S5 | 消息超长（> 40000 chars） | 自动截断，`sent: true` |

## 2. Watchdog Phase 2

### 2.1 新增状态

在现有 `running / running_slow / stalled / timed_out` 基础上加：

```typescript
type TaskStatus =
  | "running"
  | "running_slow"
  | "stalled"
  | "timed_out"
  | "degraded"          // ← 新：native completed 但没 result receipt
  | "delivered"         // ← 新：completion event 到 + final relay 送达
  | "completed"         // 已有
  | "failed";           // 已有
```

**`degraded(completed_without_result)`**：
- 触发条件：native task 状态变为 `completed`，但 30 秒内没有 result receipt
- 含义：任务跑完了，但结果没送到用户
- 展示：`⚠️ 任务已完成但结果未送达`

**`delivered`**：
- 触发条件：final relay 成功（`IMSendResult.delivered = true`）
- 含义：用户已收到结果
- 展示：`✅ 已送达`

### 2.2 Operator Surface

`octoclawctl status` 输出：

```
任务 task-abc123
  状态：degraded (completed_without_result)
  开始：2026-05-13 10:30:00
  耗时：45s
  模型：openai/gpt-5.5
  ⚠️  任务已完成但结果未送达（30s 内无 result receipt）
  → 运行 octoclawctl details task-abc123 查看详情
```

`octoclawctl details <taskId>` 输出完整 verdict（不是 raw native state）。

### 2.3 实现位置

- `extensions/octoclaw-runtime/src/tools/runtime-status.ts`：加 `degraded` / `delivered` 状态判定
- `tools/octoclawctl/src/commands/status.ts`：展示新状态
- `tools/octoclawctl/src/commands/details.ts`：展示 compact verdict

## 3. Judge Cooldown

### 3.1 状态机

```typescript
interface JudgeCooldownState {
  modelId: string;
  failureCount: number;
  windowStart: number;       // 窗口开始时间（ms）
  cooldownUntil: number | null;  // null = 不在 cooldown
}
```

规则：
- 窗口：最近 10 次调用
- 触发：失败 >= 5 次 → cooldown 30 分钟
- 恢复：cooldown 到期后，下一次调用重置计数器
- 关闭：`OCTOCLAW_DISABLE_HEALTH_GATES=1` 时跳过所有 cooldown 检查

### 3.2 实现位置

`extensions/octoclaw-runtime/src/resolve/llm-judge.ts`（已有 judge 调用逻辑）：

```typescript
// 在 callJudge() 前检查
if (isCooldown(modelId) && !isHealthGatesDisabled()) {
  emitEvent("router_judge_fallback", { reason: "cooldown", modelId });
  return fallbackRules(input);
}

// 调用后更新计数
try {
  const result = await callJudgeEndpoint(input);
  recordSuccess(modelId);
  return result;
} catch (err) {
  recordFailure(modelId);
  if (shouldEnterCooldown(modelId)) {
    setCooldown(modelId, 30 * 60 * 1000);
    emitEvent("router_judge_cooldown_entered", { modelId });
  }
  return fallbackRules(input);
}
```

### 3.3 持久化

V1 只存内存（进程重启后重置）。V2 再考虑持久化到 SQLite。

## 4. Shadow Lane Invariant 测试

3 个回归点，每个都是独立测试：

**回归点 1：IO error**
```typescript
// shadow-bridge.ts 的 writeShadowEvent 抛 ENOENT
// 期望：live dispatch 正常完成，shadow 失败被 swallow
```

**回归点 2：Snapshot missing**
```typescript
// loadRouterLiteSnapshot() 返回 null
// 期望：shadow 跳过（不写事件），live dispatch 正常
```

**回归点 3：JSON parse error**
```typescript
// shadow event 序列化失败（circular reference）
// 期望：live dispatch 正常，shadow 失败被 swallow
```

实现位置：`extensions/octoclaw-runtime/src/router-lite/shadow-bridge.test.ts`（新建或补充）

所有 3 个测试都必须验证：**live dispatch 的返回值不受 shadow 失败影响**。
