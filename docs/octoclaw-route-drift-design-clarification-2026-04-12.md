# OctoClaw Route Drift 设计澄清

日期：2026-04-12（v3 — 修正根因分析）
状态：pending design decision（含建议方案）
关联 bug：Slack DM delegated task ack target loss + route drift runner→spawn_single + handoff failure

---

## 0. 背景

用户在 Slack DM 发送"帮我查下北京接下来一周的天气"。

| 时间 (GMT+8) | 事件 | route | sessionKey | usedCachedPolicy |
|---|---|---|---|---|
| 18:09:15 | policy_resolved（首次判定） | `runner` | `agent:main:slack:default:direct:u0al9t5u89z` | — |
| 18:09:23 | 内部 policy 事件（**新 prompt，二跳**） | `spawn_single` | **空** | **false** |
| 18:10:04 | dispatch_called | `spawn_single` | **空** | **false** |

**关键证据**：replay 里 `policyJudgeInvoked` / `policyJudgeApplied` 都没有记录。这不是 judge 把 runner 改成 spawn_single，也不是 sticky override。

### 已修复（commit `9954553` + `b68bc3a`）

| Commit | 修复内容 |
|--------|---------|
| `9954553` | session_key 传给 spawn materialization；failed 任务有 user_safe_summary 时自动 handoff；ack telemetry attempted/delivered |
| `b68bc3a` | ACK sent→delivered ground truth；dispatch_task.py 从 policy_json 继承 session_key；native spawn degraded success (exit 0 但无 RESULT marker → done_degraded)；task brief sealed_route；OPENCLAW_BIN env 传递 |

### 剩余未修

route drift 的根因是 **sealed decision 在二跳 materialization 中丢失**（路径 D）。以下文档描述此问题及修复方案。

---

## 1. 根因分析：路径 D — sealed decision 丢失 + freeform 二跳

### 什么是"二跳"

用户消息"帮我查下北京接下来一周的天气"在 18:09:15 被 policy 判为 `runner`。这是首次判定（一跳），sealed decision 应该包含 `route=runner, sessionKey=agent:main:slack:default:direct:u0al9t5u89z`。

但 8 秒后（18:09:23），出现了一个 **新的 prompt**：

> "查询北京接下来一周的天气预报，给出适合 Slack 私聊的简洁中文总结，包含每天概况、温度范围、是否下雨及简短出行建议。优先使用 weather skill / wttr.in。"

这是一个主 agent 自己重写/扩展的 freeform 子任务 prompt。它被传入一个新的 policy 判定（`usedCachedPolicy=false`），**没有继承原始 sealed decision**。新判定产生了 `route=spawn_single, sessionKey=""`。

### 漂移链路

```
用户 Slack DM → 首次 policy判定: route=runner, sessionKey=agent:main:slack:...
    ↓
主 agent 调用 octoclaw_dispatch，传入新的 freeform prompt
    ↓
octoclaw_dispatch 发现 no cachedDecision → buildDecision(新prompt)
    ↓ usedCachedPolicy=false
buildDecision 用新 prompt 重新判定 → route=spawn_single（因为新 prompt 不匹配 runner playbook）
    ↓ sessionKey 没有传入（或被覆盖为空）
dispatch_task.py → recommend_spawn(session_key="")
    ↓
dispatch_called: route=spawn_single, sessionKey="", ACK missing_session_key
```

### 与路径 A/B/C 的区别

| 路径 | 机制 | replay 证据 | 是否本次主因 |
|------|------|------------|-------------|
| A: sticky override | applyStickyRoute 跨 lane | 无 sticky reason code | ❌ 不是 |
| B: lane feasibility | runner 不可行 → spawn_single 可行 | runner pool 当时健康 | ❌ 不是 |
| C: scoring bias | soft runner bias → spawn_single | 这是二跳 prompt 的评分结果，不是一跳 | ⚠️ 间接相关 |
| **D: sealed decision 丢失** | **二跳 freeform prompt 重走 policy** | **usedCachedPolicy=false, 新 prompt 文本** | **✅ 是** |

路径 D 违反的设计约束：

> **§4.6.1**: "dispatch 不得重判自然语言。后续 dispatch/spawn/runner 层应只消费 sealed route/scope/target。不应再让 dispatch 依赖手写 freeform task 再跑一轮语义分类。"
>
> **§7.3.1**: "delegated lane 在执行期被 freeform 二跳 prompt 洗掉原始 contract"
>
> **§7.3.2**: "runner 不是建议标签，而是固定 workflow/playbook。没有 materialize 成 task_id/runner job/explicit failure 之前，系统不能声称'已经派出去了'。"

---

## 2. 路径 A/B/C 仍然存在的设计风险

虽然路径 D 是本次事故主因，路径 A/B/C 仍然是设计风险，应在后续迭代中修。

### 路径 A：Sticky Route 跨 Lane Override

**风险**：`applyStickyRoute` 在 `continuityOverrideAllowed=true` 时可以跨 lane 覆盖（runner→spawn_single），跳过 lane feasibility 检查。

**与设计约束的矛盾**：
- §4.6: "sticky lane 抢占" 应阻止覆盖
- §3.1: 语义只判一次，历史 route 不应覆盖新判定

**建议**：禁止跨 lane override（Q1 建议 "同意"）

### 路径 B：Lane Feasibility spawn_single Fallback

**风险**：`spawn_single.feasible = !runnerFeasible`，runner playbook 缺失时 spawn_single 自动可行。

**与设计约束的矛盾**：
- §3.1: runner 不可用时 "只允许显式 degraded_direct_lookup"
- §K2: "不允许 silent direct fallback 把 upstream_project 查询长期吞掉"

**建议**：保留作为 audited fallback 但必须记录来源（Q2 建议）

### 路径 C：Scoring Bias

**风险**：`prefer_spawn_single_over_soft_runner_bias` 兜底逻辑。

**建议**：保留作为 deterministic scoring reason，必须 propagate 到 audit trail（Q5 建议 "同意"）

---

## 3. 建议方案（修正版）

### Q1：sticky route 跨 lane override

**建议：同意禁止跨 lane override**

这是设计风险，应修，但不是本次事故主因。P1 优先级。

### Q2：runner 不可用时 fallback

**建议：不同意全局统一 runner→spawn_single**

upstream_project 仍应 runner/workflow-first；runner 不可用只允许显式 degraded_direct_lookup 或 capability-bound failure。

天气这类 generic bounded external lookup 可以短期 audited spawn fallback，但更优解是补 generic live lookup runner playbook，覆盖天气/汇率/轻量实时查询，减少 runner playbook missing 导致的 fallback。

**理由**：设计约束 2 明确区分了 `upstream_project`（必须 runner）和通用查询的 fallback 策略。全局统一到 spawn 会掩盖 playbook 缺失问题。

### Q3：dispatch_called 增加 audit trail

**建议：同意，必须加**

字段建议至少有：
- `original_route` / `final_route` / `route_changed`
- `decision_source`（cached / fresh / inherited）
- `route_override_source`（applyStickyRoute / buildLaneFeasibility / inferRoute / freeform_reroute）
- `fallback_reason`
- `usedCachedPolicy`

**红线告警条件**：`usedCachedPolicy=false && delegated route` 应触发告警。

### Q4：两种 fallback 场景统一

**建议：不同意现在统一到 spawn_single**

先修 sealed decision 丢失和 freeform 二跳（路径 D），再谈 fallback 策略统一。否则会把真正的 contract 丢失问题掩盖成 fallback 策略问题。

### Q5：prefer_spawn_single_over_soft_runner_bias

**建议：同意保留**

但只作为 deterministic scoring reason，必须被 propagate 到 audit trail，不能作为 silent drift。

### Q6：route drift 时通知用户

**建议：同意不需要额外通知**

ACK 应绑定 route commit 和原始 session。用户侧保持中性 ACK，内部 ledger 记录 drift/fallback 即可。

---

## 4. 修正后的实施优先级

### P0：修 sealed decision 丢失 + freeform 二跳

这是本次事故的真正根因。两个修改点：

**P0-1：octoclaw_dispatch 在 managed context 下必须消费 cached/sealed decision**

在 `index.js` octoclaw_dispatch tool 里：如果没有 `cachedDecision`、没有 `policyJson` 参数、没有 `decision_id`，且当前是 managed context（有 sessionKey），应该 **fail closed**——不允许 `usedCachedPolicy=false` 继续 materialize delegated route。

**代码位置**：`index.js:3090-3155`（octoclaw_dispatch resolve policy 阶段）

```
if (!cachedDecision && !params.policyJson && isDelegatedRoute && hasManagedSessionKey) {
  // fail closed: 不能用 freeform prompt 重新判定 delegated route
  return toolResponse("error: sealed decision required for managed delegated dispatch");
}
```

**P0-2：octoclaw_spawn 在 managed context 下不能自由 materialize 新 freeform task**

在 `octoclaw_spawn.py` 或 `index.js` 的 octoclaw_spawn tool 里：如果 parent decision 的 route 是 runner，不能转 spawn。spawn 必须继承 parent decision。

**代码位置**：`index.js:3258-3340`（octoclaw_spawn tool）

### P1：Audit trail + sticky hardening

**P1-1：dispatch_called 增加 drift audit trail**

`index.js:3206` recordPolicyReplay 增加字段：`original_route` / `final_route` / `route_changed` / `decision_source` / `route_override_source` / `fallback_reason`

**P1-2：applyStickyRoute 禁止跨 lane override**

`decide.js:316-319`：当 `baseRoute !== stickyRoute` 时返回 baseRoute。

### P2：补 generic live lookup runner playbook

补 runner playbook 覆盖天气/汇率/轻量实时查询，减少 runner playbook missing 导致的 spawn fallback。这比改 fallback 策略更根本。

### 一句话总结

> 这次不要按 judge 或 sticky 主因修；先修 sealed decision 丢失 + freeform 二跳重路由，再补 audit 和 sticky hardening。

---

## 5. 已修问题清单

| Commit | 修了什么 | 还有什么没修 |
|--------|---------|-------------|
| `e3e91a6` | Slack DM session key 解析 `slack:default:direct:` 格式 | 二跳丢失 sessionKey |
| `9954553` | spawn materialization 传 session_key；auto handoff | sealed decision 丢失 |
| `3dd94c0` | 综合修复：title_suffix / import sys / bare except / Map mutation / cache cap | 路径 D 未修 |
| `b68bc3a` | ACK delivered ground truth；policy_json session_key 继承；degraded success；sealed_route in task brief | P0-1 fail closed；P0-2 spawn 继承 parent decision |

---

## 6. 需要确认的决策

| # | 问题 | 建议 | 你的决策 |
|---|------|------|---------|
| Q1 | sticky route 跨 lane override | 禁止跨 lane（同意） | ☑ 同意 |
| Q2 | runner 不可用时 fallback | 不同意全局 spawn；补 runner playbook | ☑ 同意 |
| Q3 | dispatch_called 增加 audit trail | 必须加（P1） | ☑ 同意 |
| Q4 | 两种 fallback 场景统一 | 不同意现在统一；先修路径 D | ☑ 同意 |
| Q5 | prefer_spawn_single_over_soft_runner_bias | 保留 + propagate audit | ☑ 同意 |
| Q6 | route drift 时通知用户 | 不需要额外通知 | ☑ 同意 |

---

## 7. 关联代码位置索引

| 文件 | 行号 | 功能 | 修复状态 |
|------|------|------|---------|
| `extensions/octoclaw-runtime/index.js` | 3090-3155 | octoclaw_dispatch resolve policy | **P0-1 待修** |
| `extensions/octoclaw-runtime/index.js` | 3258-3340 | octoclaw_spawn tool | **P0-2 待修** |
| `extensions/octoclaw-runtime/index.js` | 2310-2335 | decision_cache_miss (usedCachedPolicy=false) | P0-1 相关 |
| `extensions/octoclaw-runtime/index.js` | 3206-3246 | dispatch_called 事件记录 | P1-1 待修 |
| `extensions/octoclaw-runtime/policy/decide.js` | 226-319 | applyStickyRoute — sticky route override | P1-2 待修 |
| `extensions/octoclaw-runtime/policy/decide.js` | 1480-1520 | buildDecision — route 解析优先级链 | 路径 C 相关 |
| `extensions/octoclaw-runtime/policy/route.js` | 1055-1067 | buildLaneFeasibility — spawn fallback | 路径 B 相关 |
| `extensions/octoclaw-runtime/policy/route.js` | 1286-1307 | inspect_report 评分 | 路径 C 相关 |
| `lib/dispatch_task.py` | 1691-1705 | session_key 继承 | ✅ b68bc3a 已修 |
| `lib/dispatch_task.py` | 1731-1782 | main() runner 路径 | P2 playbook 相关 |
| `lib/octoclaw_spawn.py` | 642-690 | finalize_native_spawn_result degraded | ✅ b68bc3a 已修 |
| `lib/runtime_protocol.py` | 175, 234-235 | sealed_route in task brief | ✅ b68bc3a 已修 |

## 8. 关联设计文档索引

| 文档 | 章节 | 约束 |
|------|------|------|
| `octoclaw-router-policy-refactor-2026-04-10.md` | §3.1 | 语义只判一次，下游不重判 |
| `octoclaw-router-policy-refactor-2026-04-10.md` | §4.6.1 | **dispatch 不得重判自然语言（路径 D 直接违反）** |
| `octoclaw-router-policy-refactor-2026-04-10.md` | §3.1 | runner 不可用时只允许 degraded_direct_lookup |
| `octoclaw-router-policy-refactor-2026-04-10.md` | §4.5 | delegated ACK 绑定 route commit |
| `octoclaw-router-policy-refactor-2026-04-10.md` | §4.6 | sticky lane 抢占应阻止覆盖 |
| `octoclaw-design-foundation.md` | §7.3.2 | route 必须固定 materialize 成 execution contract |
| `octoclaw-design-foundation.md` | §7.3.1 | **delegated lane 不能被二跳重路由（路径 D 直接违反）** |
| `octoclaw-execution-plan.md` | K2 | runner unavailable → degraded_direct_lookup |
| `octoclaw-execution-plan.md` | P5I (line 594-598) | runner 一旦被选中只能 materialize 成固定 playbook |
| `octoclaw-execution-plan.md` | P5I (line 609-610) | spawn 必须落到固定 child spec |
| `octoclaw-execution-plan.md` | P5I (line 605-607) | runner lane 不允许拼二跳 freeform task 再次重路由 |
