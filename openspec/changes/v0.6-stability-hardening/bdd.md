# BDD: 稳定性收尾（A2）

Date: 2026-05-13

## 命名约定

- `STB-S-*` Stability / Slack smoke
- `STB-W-*` Stability / Watchdog Phase 2
- `STB-J-*` Stability / Judge cooldown
- `STB-SH-*` Stability / Shadow lane invariant

---

## STB-S: Slack Smoke

### STB-S-001: 普通 reply 送达

**Given** Slack mock server 正常响应
**When** `SlackAdapter.send({ message: "hello", sessionKey: "slack:C123:U456:ts789" })`
**Then** `result.sent = true`
**And** `result.delivered = true`

### STB-S-002: delegate footer 包含 model

**Given** `projectionFooter = { route: "delegate", model: "openai/gpt-5.5" }`
**When** `SlackAdapter.send({ ..., projectionFooter })`
**Then** 发送的消息文本包含 `gpt-5.5`

### STB-S-003: streaming transport 标记

**Given** `SlackAdapter` 配置 `streamingMode: "partial"`
**When** `SlackAdapter.send({ ... })`
**Then** `result.transport` 包含 `streaming` 相关字符串

### STB-S-004: channel_not_found 返回错误

**Given** Slack mock server 返回 `{ ok: false, error: "channel_not_found" }`
**When** `SlackAdapter.send({ ... })`
**Then** `result.sent = false`
**And** `result.error` 包含 `channel_not_found` 或对应 error code

### STB-S-005: 超长消息自动截断

**Given** `message` 长度为 50000 字符（超过 40000 限制）
**When** `SlackAdapter.send({ message })`
**Then** 实际发送的消息长度 <= 40000
**And** `result.sent = true`

---

## STB-W: Watchdog Phase 2

### STB-W-001: degraded 状态判定

**Given** native task 状态变为 `completed`
**And** 30 秒内没有 result receipt
**When** `getTaskStatus(taskId)`
**Then** 返回 `"degraded"`

### STB-W-002: delivered 状态判定

**Given** final relay `IMSendResult.delivered = true`
**When** `getTaskStatus(taskId)`
**Then** 返回 `"delivered"`

### STB-W-003: octoclawctl status 展示 degraded

**Given** 任务状态为 `degraded`
**When** `octoclawctl status`
**Then** 输出包含 "任务已完成但结果未送达" 或 "completed_without_result"
**And** 输出包含 actionable hint

### STB-W-004: octoclawctl details 展示 compact verdict

**Given** 任务 `task-abc123` 存在
**When** `octoclawctl details task-abc123`
**Then** 输出包含 `status` / `model` / `duration` 字段
**And** 不输出 raw native state JSON

---

## STB-J: Judge Cooldown

### STB-J-001: 连续失败触发 cooldown

**Given** judge 在 10 次调用窗口内失败 5 次
**When** 第 6 次调用
**Then** judge endpoint 不被调用
**And** fallback 规则被使用
**And** `router_judge_fallback` 事件被 emit，`reason = "cooldown"`

### STB-J-002: cooldown 期间不调用 endpoint

**Given** judge 处于 cooldown 状态（cooldownUntil 未到期）
**When** `callJudge(input)`
**Then** 不发出任何 HTTP 请求到 judge endpoint
**And** 返回 fallback 结果

### STB-J-003: cooldown 到期后恢复

**Given** judge cooldown 已到期（mock 时间前进 31 分钟）
**When** 下一次 `callJudge(input)`
**Then** judge endpoint 被正常调用
**And** 失败计数器被重置

### STB-J-004: OCTOCLAW_DISABLE_HEALTH_GATES 关闭 cooldown

**Given** 环境变量 `OCTOCLAW_DISABLE_HEALTH_GATES=1`
**And** judge 已连续失败 10 次
**When** 下一次 `callJudge(input)`
**Then** judge endpoint 仍被调用（cooldown 不生效）

### STB-J-005: cooldown_entered 事件

**Given** judge 失败次数达到触发阈值
**When** cooldown 被设置
**Then** `router_judge_cooldown_entered` 事件被 emit，包含 `modelId` 字段

---

## STB-SH: Shadow Lane Invariant

### STB-SH-001: shadow IO error 不影响 live

**Given** `writeShadowEvent()` 抛出 `ENOENT`（目录不存在）
**When** `shadowBridge.run(input)`
**Then** live dispatch 的返回值不变（`PolicyDecision` 正常返回）
**And** 不 throw
**And** 不影响 ACK / footer

### STB-SH-002: snapshot missing 时 shadow 跳过

**Given** `loadRouterLiteSnapshot()` 返回 `null`
**When** `shadowBridge.run(input)`
**Then** shadow event 不被写入
**And** live dispatch 正常完成

### STB-SH-003: JSON parse error 被 swallow

**Given** shadow event 对象包含循环引用（序列化失败）
**When** `shadowBridge.run(input)`
**Then** 不 throw
**And** live dispatch 正常完成
**And** 错误被记录到 debug log（不是 error log）

---

## Test 文件位置

```
extensions/octoclaw-runtime/src/
  im/slack/
    slack-smoke.test.ts              # STB-S-001..005
  tools/
    runtime-status.test.ts           # STB-W-001..002（补充）
  router-lite/
    shadow-bridge.test.ts            # STB-SH-001..003

tools/octoclawctl/src/
  __tests__/
    status.test.ts                   # STB-W-003..004
    judge-cooldown.test.ts           # STB-J-001..005
```
