# Tasks: 稳定性收尾（A2）

## Phase A — Slack Smoke（< 1 天）

### A1. 补 5 个 smoke case
- [ ] 在 `slack-adapter.test.ts` 或新建 `slack-smoke.test.ts` 补 5 个 case（见 design.md §1）
- [ ] S1：普通 reply，`sent: true, delivered: true`
- [ ] S2：delegate + footer，footer 包含 model 名
- [ ] S3：streaming，`transport: "native_streaming"`
- [ ] S4：`channel_not_found`，`sent: false, error: "IM_SEND_FAILED"`（或 error code）
- [ ] S5：超长消息自动截断，`sent: true`
- [ ] `pnpm test` 全绿

---

## Phase B — Watchdog Phase 2（1-2 天）

### B1. 新增状态类型
- [ ] 在 `runtime-status.ts` 加 `degraded` / `delivered` 状态判定逻辑（见 design.md §2.1）
- [ ] `degraded`：native completed + 30s 内无 result receipt
- [ ] `delivered`：final relay `IMSendResult.delivered = true`

### B2. Operator surface
- [ ] `octoclawctl status` 展示 `degraded` / `delivered` 状态（中英文）
- [ ] `octoclawctl details <taskId>` 展示 compact verdict（不是 raw native state）
- [ ] 测试：mock `degraded` 状态，验证 `octoclawctl status` 输出包含 "任务已完成但结果未送达"

---

## Phase C — Judge Cooldown（< 1 天）

### C1. Cooldown 状态机
- [ ] 在 `resolve/llm-judge.ts` 加 `JudgeCooldownState` 内存状态（见 design.md §3.1）
- [ ] 实现 `isCooldown()` / `recordSuccess()` / `recordFailure()` / `setCooldown()`
- [ ] 触发条件：10 次窗口内失败 >= 5 次 → cooldown 30 分钟
- [ ] 恢复：cooldown 到期后重置计数器

### C2. 集成到 judge 调用
- [ ] `callJudge()` 前检查 cooldown，cooldown 中直接走 fallback
- [ ] emit `router_judge_fallback` 事件（`reason: "cooldown"`）
- [ ] emit `router_judge_cooldown_entered` 事件

### C3. 环境变量关闭
- [ ] `OCTOCLAW_DISABLE_HEALTH_GATES=1` 时跳过 cooldown 检查
- [ ] 测试：设置环境变量后，连续失败不触发 cooldown

---

## Phase D — Shadow Lane Invariant（< 1 天）

### D1. 3 个回归测试
- [ ] 新建或补充 `router-lite/shadow-bridge.test.ts`
- [ ] 回归点 1：shadow IO error 不影响 live dispatch（见 design.md §4）
- [ ] 回归点 2：snapshot missing，shadow 跳过，live 正常
- [ ] 回归点 3：JSON parse error，shadow swallow，live 正常
- [ ] 每个测试都断言：live dispatch 返回值不受 shadow 失败影响

---

## Acceptance

- [ ] Slack smoke 5 case 全绿
- [ ] `octoclawctl status` 展示 `degraded` / `delivered`
- [ ] judge 连续失败 5/10 后走 fallback（不调 endpoint）
- [ ] `OCTOCLAW_DISABLE_HEALTH_GATES=1` 时 cooldown 不生效
- [ ] shadow 3 个回归测试全绿
- [ ] `pnpm check && pnpm test` 全绿
