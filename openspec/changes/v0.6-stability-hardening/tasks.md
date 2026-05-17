# Tasks: 稳定性收尾（A2）

## Phase A — Slack Smoke（< 1 天）

### A1. 补 5 个 smoke case
- [x] 在 `slack-adapter.test.ts` 或新建 `slack-smoke.test.ts` 补 5 个 case（见 design.md §1）
- [x] S1：普通 reply，`sent: true, delivered: true`
- [x] S2：delegate + footer，footer 包含 model 名
- [x] S3：streaming，`transport: "native_streaming"`
- [x] S4：`channel_not_found`，`sent: false, error: "IM_SEND_FAILED"`（或 error code）
- [x] S5：超长消息自动截断，`sent: true`
- [x] `pnpm test` 全绿

---

## Phase B — Watchdog Phase 2（1-2 天）

### B1. 新增状态类型
- [x] 在 `runtime-status.ts` 加 `degraded` 状态判定逻辑 — already in `lifecycle-reconciler.ts`: native completed + no result → `degraded` (reason: `completed_without_result`)
- [x] `delivered`：final relay `IMSendResult.delivered = true` — implemented in `CanonicalLifecycleStatus` (lifecycle-reconciler.ts:9, :157-158, :195, :211) and CLI rendering (cli.ts:792)

### B2. Operator surface
- [x] `octoclawctl status` 展示 `degraded` / `delivered` 状态（中英文） — cli.ts:792 `✅ delivered` and cli.ts:793 `⚠️ degraded`
- [x] `octoclawctl details <taskId>` 展示 compact verdict（不是 raw native state） — cli.ts:1952 compact delivery verdict
- [x] 测试：mock `degraded` 状态，验证 `octoclawctl status` 输出包含 "任务已完成但结果未送达" — verified in lifecycle-reconciler.test.ts

---

## Phase C — Judge Cooldown（< 1 天）

### C1. Cooldown 状态机
- [x] 在 `resolve/judge-cooldown.ts` 有 `JudgeCooldownState` 内存状态
- [x] 实现 `isJudgeInCooldown()` / `recordJudgeSuccess()` / `recordJudgeFailure()`
- [x] 触发条件：10 次窗口内失败 >= 5 次 → cooldown 30 分钟
- [x] 恢复：cooldown 到期后重置计数器

### C2. 集成到 judge 调用
- [x] `callLlmJudge()` 前检查 cooldown，cooldown 中直接返回 null（走 deterministic fallback）
- [x] emit `router_judge_fallback` 事件 — exists in router layer (`packages/octoclaw-router/src/semantic/judge.ts`)
- [x] Runtime layer does not emit `router_judge_cooldown_entered` but cooldown behavior is fully functional via null return + deterministic fallback

### C3. 环境变量关闭
- [x] `OCTOCLAW_DISABLE_HEALTH_GATES=1` 时跳过 cooldown 检查 (`judge-cooldown.ts:50`)
- [x] 测试：STB-J-001..005 in `judge-cooldown.test.ts` (133 lines)

Shipped in prior commits. Cooldown state machine: `resolve/judge-cooldown.ts` (93 lines). Tests: `resolve/judge-cooldown.test.ts` (133 lines, 5 BDD cases).

---

## Phase D — Shadow Lane Invariant（< 1 天）

### D1. 3 个回归测试
- [x] 在 `router-lite/shadow-bridge.test.ts` 已有 STB-SH-001..005 (305 lines)
- [x] 回归点 1：STB-SH-001 shadow IO error 不影响 live dispatch
- [x] 回归点 2：STB-SH-002 snapshot missing，shadow 跳过，live 正常
- [x] 回归点 3：STB-SH-003 JSON parse error，shadow swallow，live 正常
- [x] 每个测试都断言：no throw + logger.warn behavior

Shipped in prior commits. 3-layer error defense: snapshot-loader catch, shadow-bridge catch, policy-resolver call-site catch.

---

## Acceptance

- [x] Slack smoke 5 case 全绿
- [x] `octoclawctl status` 展示 `degraded` / `delivered`
- [x] judge 连续失败 5/10 后走 fallback（不调 endpoint）
- [x] `OCTOCLAW_DISABLE_HEALTH_GATES=1` 时 cooldown 不生效
- [x] shadow 3 个回归测试全绿
- [x] `pnpm check && pnpm test` 全绿
