# OctoClaw Route Drift 设计澄清

日期：2026-04-12
状态：pending design decision
关联 bug：Slack DM delegated task ack target loss + route drift runner→spawn_single + handoff failure

---

## 0. 背景

用户在 Slack DM 发送"帮我查下北京接下来一周的天气"。

| 时间 (GMT+8) | 事件 | route |
|---|---|---|
| 18:09:15 | policy_resolved（用户面向的首次判定） | `runner` |
| 18:09:23 | 内部 policy 事件（第二次判定） | `spawn_single` |
| 18:10:04 | dispatch_called（实际 materialization） | `spawn_single` |

用户收到 ack 失败（channel_not_found / missing_session_key），任务最终有有效结果但没自动 handoff。

已修复部分（commit `9954553`）：
- session_key 不再在 spawn materialization 中丢失
- failed 任务有 user_safe_summary 时自动设 handoff_state
- ack telemetry 区分 attempted vs delivered

**本文档描述剩余未修问题——route drift——需要设计确认。**

---

## 1. Route Drift 的三个可能路径

### 路径 A：Sticky Route Override（最可能）

**代码位置**：`extensions/octoclaw-runtime/policy/decide.js:226-319`

```
applyStickyRoute(baseRoute="runner", ...)
```

关键逻辑（line 291-319）：

```javascript
const continuityOverrideAllowed = followupCandidate;

if (stickyRoute !== baseRoute
    && !laneIsFeasible(laneFeasibility, stickyRoute)
    && !continuityOverrideAllowed) {
  // 只有 continuityOverrideAllowed=false 时才阻止
  return { route: baseRoute, ... };
}

// continuityOverrideAllowed=true 时，直接返回 stickyRoute
// 不管 lane feasibility
if (baseRoute === stickyRoute) {
  return { route: baseRoute, ... };
}
return { route: stickyRoute, ... };  // ← runner 被 spawn_single 覆盖
```

**触发条件**：
1. `followupCandidate = true`（ack_followup_candidate 或 features.followup_candidate）
2. 该 session 之前有过 sticky route = "spawn_single"
3. 当前 baseRoute = "runner"

**需要确认**：
- [ ] 当 baseRoute=runner 被 sticky spawn_single 覆盖时，这算正常行为还是 bug？
- [ ] 如果是正常行为，ledger 是否必须记录 `fallback_reason` 和 `original_route`？

### 路径 B：Lane Feasibility Fallback

**代码位置**：`extensions/octoclaw-runtime/policy/route.js:1055-1067`

```javascript
const runnerFeasible = Boolean(runnerMaterialization);

baseline.runner = {
  feasible: runnerFeasible,
  reasons: runnerFeasible
    ? ["contract:probe_measurement", "capability:runner_probe_or_snapshot"]
    : ["runner_materialization_missing"],
};

baseline.spawn_single = {
  feasible: !runnerFeasible,  // ← runner 不可用时 spawn_single 自动可行
  reasons: ["runner_materialization_missing_spawn_fallback"],
};
```

当 runner 没有注册 playbook 时（`runnerMaterialization = null`），lane feasibility 标记 `runner.feasible = false`，`spawn_single.feasible = true`。

**触发条件**：
1. 任务的 intent 没有匹配到任何已注册 runner playbook
2. 或 runner pool 暂时不可用（health check 失败）

**需要确认**：
- [ ] runner 不可用时应该 fallback 到 `spawn_single` 还是 `degraded_direct_lookup`？
- [ ] 当前设计文档说："在 runner pool 未证明可用时，只允许显式 degraded_direct_lookup"（octoclaw-router-policy-refactor-2026-04-10.md:69）
- [ ] 但代码实际行为是 spawn_single fallback，这是设计文档过时还是代码错误？

### 路径 C：Scoring Bias

**代码位置**：`extensions/octoclaw-runtime/policy/route.js:1304-1307`

```javascript
} else {
  route = "spawn_single";
  reasonCodes.push("prefer_spawn_single_over_soft_runner_bias");
}
```

当 runner 得分太低（soft runner bias），评分兜底逻辑选择 spawn_single。

**触发条件**：
- runner 被判定为"soft"（不是硬性需要），但 spawn_single 得分更高

**需要确认**：
- [ ] 这个评分兜底是否应该存在？
- [ ] 如果 policy 已经明确判定 runner，后续评分不应该再覆盖它？

---

## 2. 当前 Ledger 缺失的信息

不论 route drift 来自哪条路径，dispatch_called 事件目前 **不记录**：

| 字段 | 当前状态 | 应有状态 |
|------|---------|---------|
| `original_route` | 不存在 | 应记录首次 policy 判定的 route |
| `final_route` | `route` 字段 | 已有 |
| `fallback_taken` | `outcome.js` 计算 | 已有，但仅在 outcome 层面 |
| `fallback_reason` | **不存在** | 应记录具体原因（sticky_override / lane_infeasible / scoring_bias） |
| `route_override_source` | **不存在** | 应记录覆盖来源（applyStickyRoute / buildLaneFeasibility / inferRoute） |

**需要确认**：
- [ ] 是否同意在 dispatch_called 事件中增加这些字段？
- [ ] 是否在 `buildRouteOutcome`（outcome.js）也增加 `fallback_reason`？

---

## 3. Sticky Route 的 `continuityOverrideAllowed` 问题

**当前逻辑**：当 `followupCandidate = true` 时，`continuityOverrideAllowed = true`，允许 sticky route 跳过 lane feasibility 检查。

**问题**：
- 这意味着一个 ack followup 请求可以被 sticky 到之前不相关的 route
- 如果前一条消息走了 spawn_single，当前消息应该走 runner，但 sticky 会把它拉回 spawn_single
- 没有记录为什么覆盖发生

**需要确认的选择**：

### 选项 A：保留 override，增加 audit trail
- 保持当前行为不变
- 但在 dispatch_called 事件中增加 `route_override_reason`
- 在 outcome 中记录 `original_route` 和 `override_source`

### 选项 B：限制 override scope
- `continuityOverrideAllowed` 只允许在 **同 lane** 内覆盖（e.g., runner→runner 的不同 pool）
- 不同 lane 的 override 需要显式 `reason_code`
- 跨 lane override 只在 `applyOnFollowupOnly=true` 时允许

### 选项 C：移除 cross-lane sticky override
- sticky route 只在 `baseRoute === stickyRoute` 时生效
- 跨 lane 永远走 fresh policy decision
- 最保守，但可能影响连续性体验

---

## 4. runner→spawn_single 的 Fallback 策略

当前有两种 fallback 行为需要统一：

### 场景 1：runner pool 不可用（runtime resolution）

**代码**：`dispatch_task.py:1087-1180`

```
runner_dispatch_runtime_resolution()
  → can_dispatch=False, fallback_permitted=True
```

当前行为：dispatch_runner 返回 `route: "runner"` + `capability_failure`，**不会自动切到 spawn**。
主 agent 收到失败后可能用 octoclaw_spawn 重试。

### 场景 2：lane feasibility 标记 runner 不可行

**代码**：`route.js:1055-1067`

当前行为：`spawn_single.feasible = !runnerFeasible`，runner 不可行时 spawn_single 自动可行。
policy 的 `mergeRouteFromHint` 会选择 spawn_single。

**矛盾**：场景 1 不自动切 spawn，场景 2 自动切。策略不一致。

**需要确认**：

### 选项 A：统一 fallback 到 spawn_single
- 两个场景都自动切到 spawn_single
- 需要在 dispatch_called 记录 `fallback_reason`
- 优点：用户无感，任务照做
- 缺点：runner 和 spawn 语义不同，执行模型不同

### 选项 B：统一 fallback 到 degraded_direct_lookup
- 两个场景都走设计文档说的 degraded_direct_lookup
- runner 不可用时给用户一个简短回复，告知无法执行复杂任务
- 优点：符合设计文档
- 缺点：用户体验降级

### 选项 C：分级 fallback
- runner playbook 缺失 → spawn_single（有 fallback_reason）
- runner pool 暂时满 → 排队等待（不 fallback）
- runner worker 不健康 → degraded_direct_lookup
- 优点：最精细
- 缺点：状态机复杂度增加

---

## 5. 建议的最小修复方案

如果暂时不做大的 route 策略调整，建议先做以下最小修复：

1. **dispatch_called 增加 fallback audit trail**

   在 `index.js:3206` 的 `recordPolicyReplay("dispatch_called", ...)` 增加字段：
   ```javascript
   {
     // 现有字段
     route: "spawn_single",
     // 新增
     original_route: String(cachedDecision?.route_decision?.route || ""),  // 首次判定
     route_changed: String(cachedDecision?.route_decision?.route || "") !== String(payload?.route || ""),
     route_override_reason: String(stickyOverrideReason || laneFeasibilityReason || ""),
   }
   ```

2. **applyStickyRoute 记录 override reason**

   在 `decide.js:319` 返回时附带 reason_code：
   ```javascript
   return {
     route: stickyRoute,
     stickyState,
     stickyReasons,
     overrideReason: "sticky_route_continuity_override",  // 新增
   };
   ```

3. **lane feasibility spawn_single fallback 显式标记**

   在 `route.js:1066` 增加 reason code：
   ```javascript
   baseline.spawn_single = {
     feasible: !runnerFeasible,
     reasons: ["runner_materialization_missing_spawn_fallback"],
     fallbackFromRunner: true,  // 新增标记
   };
   ```

---

## 6. 需要决策的问题清单

| # | 问题 | 影响范围 | 紧急度 |
|---|------|---------|--------|
| Q1 | sticky route 跨 lane override 是否允许？ | decide.js applyStickyRoute | 高 |
| Q2 | runner 不可用时 fallback 到 spawn_single 还是 degraded_direct？ | route.js buildLaneFeasibility + dispatch_task.py | 高 |
| Q3 | dispatch_called 是否增加 original_route + fallback_reason？ | index.js recordPolicyReplay | 中 |
| Q4 | 场景 1（runtime resolution）和场景 2（lane feasibility）的 fallback 策略是否统一？ | dispatch_task.py + route.js | 中 |
| Q5 | `prefer_spawn_single_over_soft_runner_bias` 评分兜底是否保留？ | route.js inferRoute | 低 |
| Q6 | runner→spawn drift 时是否需要通知用户"任务将以子 agent 模式执行"？ | notifier.py / im_thread.py | 低 |

---

## 7. 关联代码位置索引

| 文件 | 行号 | 功能 |
|------|------|------|
| `extensions/octoclaw-runtime/policy/decide.js` | 226-319 | applyStickyRoute — sticky route override |
| `extensions/octoclaw-runtime/policy/decide.js` | 291 | continuityOverrideAllowed = followupCandidate |
| `extensions/octoclaw-runtime/policy/decide.js` | 345-359 | routeHintCorrectionPolicy — feasible hint routes 不含 runner |
| `extensions/octoclaw-runtime/policy/route.js` | 1055-1067 | buildLaneFeasibility — spawn_single = !runnerFeasible |
| `extensions/octoclaw-runtime/policy/route.js` | 1304-1307 | prefer_spawn_single_over_soft_runner_bias |
| `extensions/octoclaw-runtime/policy/outcome.js` | 98-103 | fallback_taken 标记（但无 fallback_reason） |
| `extensions/octoclaw-runtime/index.js` | 3179-3200 | stickyDecision 构造 + persist |
| `extensions/octoclaw-runtime/index.js` | 3206-3246 | dispatch_called 事件记录 |
| `lib/dispatch_task.py` | 1087-1180 | runner_dispatch_runtime_resolution — runner pool 检查 |
| `lib/dispatch_task.py` | 1731-1782 | main() runner 路径 dispatch |
| `docs/octoclaw-router-policy-refactor-2026-04-10.md` | 69 | 设计文档："runner pool 未证明可用时，只允许显式 degraded_direct_lookup" |
