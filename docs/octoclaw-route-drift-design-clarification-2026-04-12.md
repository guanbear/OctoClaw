# OctoClaw Route Drift 设计澄清

日期：2026-04-12
状态：pending design decision（含建议方案）
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
- `inspect_report` 合约下，任务不满足 `fresh_live_lookup` / `bounded_external_inspect` / `explicit_local_probe` / `hard_runner_candidate` 等硬条件时
- `route.js:1286-1307` 的 if-else 链最后一个 else 走到这里

---

## 2. 设计文档中的相关约束

以下是从三份设计文档中提取的、与 route drift 直接相关的设计约束。

### 约束 1：语义只判一次，下游不重判

> **octoclaw-router-policy-refactor-2026-04-10.md §3.1 (line 302-310):**
> "自然语言语义只判一次，由 stateless policy judge 为每个 work item 产出 request_kind/scope/target/route/evidence_required。下游不再重判语义。validator 只做一致性检查。dispatch 只消费 sealed decision。"

> **同文档 §4.6.1 (line 702-721):**
> "dispatch 不得重判自然语言。一旦 PolicyJudgeResult 已通过 validator，后续 dispatch/spawn/runner 层应只消费 decision_id 和 sealed route/scope/target。不应再让 dispatch 依赖 cached decision、相似 prompt 命中的旧 policy state、或手写 freeform task 再跑一轮语义分类。否则会继续出现顶层看起来是 runner、dispatch 却返回'适合主 agent 直接处理'——这类现象本质上是 dispatch decision source 错粒度。"

**对当前 bug 的含义**：如果 runner → spawn_single 的漂移发生在 `applyStickyRoute`（policy 判定内部的 sticky 机制），这不算"下游重判"，但算 policy 内部的二次决策。如果漂移发生在 dispatch 阶段，则明确违反此约束。

### 约束 2：runner 不可用时只允许 degraded_direct_lookup

> **octoclaw-router-policy-refactor-2026-04-10.md §3.1 (line 287-300):**
> "`lookup_scope=upstream_project` 的目标态应进入 runner/workflow-first。只有在前 runner 明确 unavailable 时，才允许显式 degraded_direct_lookup。"

> **octoclaw-execution-plan.md (line 146-147):**
> "runner unavailable → explicit degraded_direct_lookup"

> **octoclaw-execution-plan.md §K2 (line 676-679):**
> "runner 当前不可用时，只允许 degraded_direct_lookup。不允许 silent direct fallback 把 upstream_project 查询长期吞掉。"

**对当前 bug 的含义**：设计文档说 runner 不可用时 fallback 应该是 `degraded_direct_lookup`，不是 `spawn_single`。但代码里 `lane_feasibility` 把 `spawn_single.feasible = !runnerFeasible`，等于说 runner 不可用时 spawn_single 自动可行。**这是代码和设计的明确矛盾。**

### 约束 3：route 必须固定 materialize 成 execution contract

> **octoclaw-design-foundation.md §7.3.2 (line 620-627):**
> "OctoClaw 不只负责 route selection，还必须把 selected route materialize 成固定 execution contract。runner 不是建议标签，而是固定 workflow/playbook。spawn_single 不是'让主 agent 随便写一段 task 文本'，而是固定 child-task contract。没有 materialize 成 task_id/runner job/explicit failure 之前，系统不能声称'已经派出去了'。"

> **octoclaw-design-foundation.md §7.3.1 (line 612-616):**
> "如果后续还能发生：delegated lane 再次被二跳重路由、executed=false 却没有明确失败面——那么系统表面上看像是'有 routing'，实际上仍然没有稳定 workflow。"

**对当前 bug 的含义**：如果 runner 被漂移到 spawn_single，这改变了 execution contract 的语义（runner playbook vs child task spec）。设计要求 route 一旦选定就必须固定 materialize，不应被后续逻辑覆盖。

### 约束 4：spawn_single 和 runner 是不同语义层

> **octoclaw-router-policy-refactor-2026-04-10.md §6.5 (line 1055-1066):**
> "轻量、频繁、低风险、需要快的任务：runner pool。复杂研究/代码/评审：native spawn_single 优先。"

> **octoclaw-design-foundation.md (line 454-460):**
> "runner 不是单纯'长期常驻快腿'，而是：轻任务执行 lane + 可以常驻也可以 on-demand 的执行器形态。"

**对当前 bug 的含义**：runner 和 spawn_single 的分工是明确的——runner 是轻快 lane，spawn_single 是复杂研究 lane。天气查询这类轻任务应该走 runner 而非 spawn_single。

### 约束 5：delegated ACK 绑定 route commit

> **octoclaw-router-policy-refactor-2026-04-10.md §4.5 (line 659-682):**
> "delegated ACK 的语义应绑定 route commit。一旦某个 work item 的 final route 被确认成 runner/spawn_single/spawn_multi，即使后续 materialization 还没完成，系统也应该先发一句 route-consistent 的中性 ACK。"

**对当前 bug 的含义**：route commit 时的 ack 必须发到同一个 Slack DM。如果 route 从 runner 漂移到 spawn_single 后丢失了 session_key，ack 就找不到投递目标。这本质上是 route drift 的连锁效应。

### 约束 6：route_judge / validator / dispatch 三层不能相互覆盖

> **octoclaw-router-policy-refactor-2026-04-10.md §4.6 (line 692-700):**
> "judge 结果只有在以下条件同时满足时才能覆盖 legacy planner：schema 正常、route 通过 validator、confidence 高于阈值、没有 forceRoute、**没有 sticky lane 抢占**。否则必须显式回退到 legacy planner，并把 judgeValidationProblems 写进 replay。"

**对当前 bug 的含义**：设计提到 "sticky lane 抢占" 应该阻止 judge 结果覆盖。但当前代码（`applyStickyRoute`）的实现是 sticky lane 可以覆盖 baseRoute，且当 `continuityOverrideAllowed=true` 时跳过 feasibility 检查。这与设计约束方向相反。

---

## 3. 当前 Ledger 缺失的信息

不论 route drift 来自哪条路径，dispatch_called 事件目前 **不记录**：

| 字段 | 当前状态 | 应有状态 |
|------|---------|---------|
| `original_route` | 不存在 | 应记录首次 policy 判定的 route |
| `final_route` | `route` 字段 | 已有 |
| `fallback_taken` | `outcome.js` 计算 | 已有，但仅在 outcome 层面 |
| `fallback_reason` | **不存在** | 应记录具体原因（sticky_override / lane_infeasible / scoring_bias） |
| `route_override_source` | **不存在** | 应记录覆盖来源（applyStickyRoute / buildLaneFeasibility / inferRoute） |

---

## 4. 建议方案

### Q1：sticky route 跨 lane override 是否允许？

**建议：选项 B — 限制 override scope，不允许跨 lane override**

理由：
- 设计约束 1（§3.1）要求语义只判一次。sticky route 跨 lane override 本质上是让历史 route 覆盖当前 policy judge 的新判定，违反"语义只判一次"原则。
- 设计约束 6（§4.6）提到 "sticky lane 抢占" 应阻止 judge 结果覆盖，但当前代码实现方向相反。应修正为：sticky route 不能跨 lane 抢占新的 judge 判定。
- `continuityOverrideAllowed` 的本意是 ack followup 时保持连续性，但"连续性"应该是同 lane 内的连续性（e.g., 同一个 runner pool），不应该跨 lane（runner → spawn_single 是完全不同的执行模型）。

具体修改：
- `applyStickyRoute` line 316-319：当 `baseRoute !== stickyRoute` 时，不返回 `stickyRoute`，而是返回 `baseRoute`
- 保留 `route_sticky_lane:<route>` reason code，记录 "sticky 尝试了但被拒绝" 用于 audit
- `applyOnFollowupOnly` + 同 lane 时仍然生效，保持同 lane 内的连续性

### Q2：runner 不可用时 fallback 到哪里？

**建议：选项 C — 分级 fallback，但不需要 degraded_direct_lookup**

理由：
- 设计约束 2 说 runner 不可用时 "只允许 degraded_direct_lookup"，但那是针对 `upstream_project` lookup 场景写的。对于 `probe_measurement` 和普通 `inspect_report`，spawn_single 作为 fallback 是合理的——因为 spawn_single 能完成任务，只是模式不同。
- 设计约束 3 要求 route 必须 materialize。runner playbook 缺失时如果硬走 degraded_direct_lookup，用户得不到有效结果。spawn_single 至少能产出 `task_id` 和 report。
- 但必须 **显式标记** 这是 fallback，不能静默切换。

具体修改：
- `probe_measurement` 合约（route.js:1064-1067）：保留 `spawn_single = !runnerFeasible`，但增加 `fallbackFromRunner: true` 标记
- `inspect_report` 合约（route.js:1123-1130）：同上，保留 spawn_single fallback 但标记来源
- 两个合约都在 dispatch_called 事件中记录 `original_route: "runner"` + `fallback_reason: "runner_materialization_missing_spawn_fallback"`
- `dispatch_task.py` 的 runner_dispatch_runtime_resolution（场景 1）也同步：当 `can_dispatch=False` 且 `fallback_permitted=True` 时，自动走 `recommend_spawn` 而非返回 `capability_failure`

### Q3：dispatch_called 是否增加 original_route + fallback_reason？

**建议：是，必须加**

理由：
- 设计约束 3 要求 "route 与实际执行不一致" 是三类长期漂移之一。要消除这类漂移，首先必须能观测到它。
- 当前 ledger 完全没有 route 变更的可观测性。增加 `original_route` + `fallback_reason` 是最小成本、最大收益的修改。

具体修改：
- `index.js:3206` dispatch_called 事件增加 `original_route`、`route_changed`、`route_override_reason` 三个字段
- `outcome.js:98-103` buildRouteOutcome 增加 `fallback_reason` 字段

### Q4：两种 fallback 场景策略是否统一？

**建议：统一到 spawn_single fallback + 显式 audit**

理由：
- 场景 1（runtime resolution，dispatch_task.py）当前返回 `capability_failure`，主 agent 需要手动重试。场景 2（lane feasibility，route.js）静默切 spawn_single。两者行为不一致。
- 统一为：runner 不可用时都自动 fallback 到 spawn_single，但必须：
  1. 在 dispatch_called 记录 `original_route: "runner"` + `fallback_reason`
  2. ack 仍然发到同一个 Slack DM（这已由 commit `9954553` 修复）
  3. 如果 spawn 也不可行，才走 `capability_bound_failure`（设计约束 3 §7.3.1）

具体修改：
- `dispatch_task.py:1731-1782`：当 `dispatch_runner` 返回 `can_dispatch=False` 且 `fallback_permitted=True` 时，自动调用 `recommend_spawn` 而非返回 runner failure
- payload 中保留 `original_route: "runner"` 标记

### Q5：`prefer_spawn_single_over_soft_runner_bias` 评分兜底是否保留？

**建议：保留，但限制 scope**

理由：
- 这个评分逻辑处理的是 `inspect_report` 合约下，runner 没有硬条件（不是 `fresh_live_lookup`、不是 `bounded_external_inspect`、不是 `hard_runner_candidate`）的情况。这类任务本质上不必须走 runner。
- spawn_single 对这类"软" inspect 任务是合理的 fallback——有完整的子 agent 执行能力。
- 但应该增加 `route_override_reason: "prefer_spawn_single_over_soft_runner_bias"` 到 reason_codes，让 ledger 可观测。

具体修改：
- 保留 route.js:1304-1307 的逻辑不变
- 确保 `prefer_spawn_single_over_soft_runner_bias` reason code 被 propagate 到 dispatch_called 事件

### Q6：runner→spawn drift 时是否通知用户？

**建议：不需要单独通知，但 ack 文案应反映实际 route**

理由：
- 设计约束 5（§4.5）说 ack 应是 "route-consistent 的中性 ACK"。如果 route 从 runner 漂移到 spawn_single，ack 应该反映实际执行模式。
- 当前 ack 文案是通用的（"我先看一下"），不需要区分 runner vs spawn。
- 但如果 fallback 策略已统一，ack 应该在 route commit 后立刻发送，不需要等到 materialization 完成。

---

## 5. 实施优先级

| 优先级 | 修改项 | 影响范围 | 复杂度 |
|--------|--------|---------|--------|
| P0 | dispatch_called 增加 `original_route` + `route_override_reason` | index.js ~10 行 | 低 |
| P1 | applyStickyRoute 禁止跨 lane override | decide.js ~5 行 | 低 |
| P2 | dispatch_task.py runner fallback 统一到 spawn | dispatch_task.py ~20 行 | 中 |
| P3 | lane feasibility spawn_single fallback 增加 fallbackFromRunner 标记 | route.js ~3 行 | 低 |
| P4 | outcome.js 增加 fallback_reason | outcome.js ~5 行 | 低 |

P0 是观测基础设施，不修则后续所有 route drift 问题都不可调试。建议 P0-P1 一起做，P2-P4 在下一个迭代做。

---

## 6. 需要确认的决策

| # | 问题 | 建议 | 你的决策 |
|---|------|------|---------|
| Q1 | sticky route 跨 lane override | 禁止跨 lane（选项 B） | ☐ 同意 / ☐ 不同意 |
| Q2 | runner 不可用时 fallback | 分级 fallback，runner→spawn_single + audit（选项 C 变体） | ☐ 同意 / ☐ 不同意 |
| Q3 | dispatch_called 增加 audit trail | 是（P0） | ☐ 同意 / ☐ 不同意 |
| Q4 | 两种 fallback 场景统一 | 统一到 spawn_single + audit | ☐ 同意 / ☐ 不同意 |
| Q5 | prefer_spawn_single_over_soft_runner_bias | 保留，增加 reason code 传播 | ☐ 同意 / ☐ 不同意 |
| Q6 | route drift 时通知用户 | 不需要单独通知 | ☐ 同意 / ☐ 不同意 |

---

## 7. 关联代码位置索引

| 文件 | 行号 | 功能 |
|------|------|------|
| `extensions/octoclaw-runtime/policy/decide.js` | 226-319 | applyStickyRoute — sticky route override |
| `extensions/octoclaw-runtime/policy/decide.js` | 291 | continuityOverrideAllowed = followupCandidate |
| `extensions/octoclaw-runtime/policy/decide.js` | 345-359 | routeHintCorrectionPolicy — feasible hint routes 不含 runner |
| `extensions/octoclaw-runtime/policy/decide.js` | 1480-1520 | buildDecision — route 解析优先级链（inferRoute → sticky → judge → hint） |
| `extensions/octoclaw-runtime/policy/route.js` | 1055-1067 | buildLaneFeasibility — probe_measurement 合约 spawn_single = !runnerFeasible |
| `extensions/octoclaw-runtime/policy/route.js` | 1073-1133 | buildLaneFeasibility — inspect_report 合约 spawn_single fallback |
| `extensions/octoclaw-runtime/policy/route.js` | 1286-1307 | inspect_report 评分 — prefer_spawn_single_over_soft_runner_bias |
| `extensions/octoclaw-runtime/policy/outcome.js` | 98-103 | fallback_taken 标记（但无 fallback_reason） |
| `extensions/octoclaw-runtime/index.js` | 3179-3200 | stickyDecision 构造 + persist |
| `extensions/octoclaw-runtime/index.js` | 3206-3246 | dispatch_called 事件记录 |
| `lib/dispatch_task.py` | 1087-1180 | runner_dispatch_runtime_resolution — runner pool 检查 |
| `lib/dispatch_task.py` | 1539-1570 | recommend_spawn — session_key 传播（已修复） |
| `lib/dispatch_task.py` | 1731-1782 | main() runner 路径 dispatch |

## 8. 关联设计文档索引

| 文档 | 章节 | 约束 |
|------|------|------|
| `octoclaw-router-policy-refactor-2026-04-10.md` | §3.1 (line 302-310) | 语义只判一次，下游不重判 |
| `octoclaw-router-policy-refactor-2026-04-10.md` | §4.6.1 (line 702-721) | dispatch 不得重判自然语言 |
| `octoclaw-router-policy-refactor-2026-04-10.md` | §3.1 (line 287-300) | runner 不可用时只允许 degraded_direct_lookup |
| `octoclaw-router-policy-refactor-2026-04-10.md` | §4.5 (line 659-682) | delegated ACK 绑定 route commit |
| `octoclaw-router-policy-refactor-2026-04-10.md` | §4.6 (line 692-700) | sticky lane 抢占应阻止覆盖 |
| `octoclaw-router-policy-refactor-2026-04-10.md` | §6.5 (line 1055-1066) | runner 轻快 / spawn_single 复杂 |
| `octoclaw-design-foundation.md` | §7.3.2 (line 620-627) | route 必须固定 materialize |
| `octoclaw-design-foundation.md` | §7.3.1 (line 612-616) | delegated lane 不能被二跳重路由 |
| `octoclaw-design-foundation.md` | (line 454-460) | runner 定义：轻任务执行 lane |
| `octoclaw-execution-plan.md` | (line 146-147) | runner unavailable → degraded_direct_lookup |
| `octoclaw-execution-plan.md` | (line 594-598) | runner 一旦被选中只能 materialize 成固定 playbook |
| `octoclaw-execution-plan.md` | (line 609-610) | spawn 必须落到固定 child spec |
| `octoclaw-execution-plan.md` | (line 676-679) | 不允许 silent direct fallback |
