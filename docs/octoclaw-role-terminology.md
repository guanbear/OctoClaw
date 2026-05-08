# OctoClaw 四类角色术语规范

> 适用分支：`v0.5.0`
> 最后更新：2026-05-09

Phase 1 交付物：Observer/Patrol/Runner/Ctl 四个核心术语的定义、边界和执行合同。

---

## 一览

| 术语 | 本质 | 代码位置 |
|------|------|---------|
| **Observer** | 只读监控会话（control_observer 任务类） | `policy-utils.ts:108`, `extension-entry.ts:1351` |
| **Patrol** | 后台健康检查进程（watchdog） | `ack-guard.ts:watchdogTick`, `octoclawctl patrol` |
| **Runner** | 执行委派任务的子 agent/worker | `policy-resolver.ts`, `tools/registration.ts`, OpenClaw native TaskFlow |
| **Ctl** | 控制面操作（octoclawctl CLI + session_control 任务类） | `tools/octoclawctl/`, `policy-utils.ts:112` |

---

## Observer

**定义**：以只读模式运行的会话。只能查询状态，不能修改执行状态或派发新任务。

**触发条件**：judge 决定路由为 `observe`，或 WorkContract 显式设置 `lane_hint: "control_observer"`。

**执行合同**：
- task_class = `"control_observer"`
- execution_profile = `"observer"`（通过 `observer_probe` role）
- worker_pool = `"octoclaw-observer"`

**允许工具**（`observerControlTools()`，`policy-utils.ts:66`）：
- `octoclaw_status`、`octoclaw_task_action`、`session_status`
- `tool_policy.observer_control_tools` 中配置的工具
- WorkContract 的 `allowedTools`

**阻断规则**：任何不在上述集合中的工具调用返回 `tool_blocked_control_observer`。

**与 Reply 路由的区别**：Reply 路由允许直接工具调用（web search、代码执行等）；Observer 只允许控制面工具。

---

## Patrol

**定义**：自动运行的后台健康检查进程，不是会话角色。负责检测卡死/超时的任务并将其标记为 `timed_out`。

**实现**：`watchdogTick()` in `extensions/octoclaw-runtime/src/ack/ack-guard.ts`

**触发方式**：
- 自动：`setInterval(watchdogTick, WATCHDOG_INTERVAL_MS)` in extension-entry.ts
- 手动：`octoclawctl patrol` 命令

**检查内容**：
1. 排队超时（`STALE_QUEUED_THRESHOLD_MIN`）→ 发出 `queued_stale` 异常
2. 运行卡死（`STUCK_THRESHOLD_MIN`）→ 发出 `runner_stuck` 异常
3. 调用 `watchdogTransitionStaleTask()` 将超时任务设为 `timed_out`

**边界**：Patrol 没有独立的"会话"或"工具集合"概念，它是运行时基础设施的一部分，不是 OpenClaw 的 agent 模式。

---

## Runner

**定义**：执行委派任务的子 agent。接收 WorkContract/handoff packet，执行具体工作，并通过 OpenClaw native announce / channel delivery 回传最终结果。

**两种子类型**：

| 子类型 | worker_pool | 典型场景 |
|--------|------------|---------|
| research | `octoclaw-research` | 信息收集、问答 |
| code | `octoclaw-code` | 写代码、修 bug |
| review | `octoclaw-review` | 代码审查 |

**执行合同**：
- route = `"delegate"`
- execution_profile = `"worker"`（区别于 observer 的 `"observer"` profile）
- 必须通过 `octoclaw_dispatch` 派发
- native spawn 必须通过 `octoclaw_dispatch_confirm` 绑定 accepted run evidence
- completion file / child-finalizer 不再是当前 planner/native path 的完成协议

**允许工具**（`runnerWorkflowTools()`，`policy-utils.ts:93`）：
- `octoclaw_status`、`octoclaw_task_action`
- `tool_policy.allowed_control_tools` + `must_delegate_via`
- WorkContract 的 `allowedTools`

**与 Observer 的区别**：Observer 的 `executionProfile = "observer"`（`observer_probe` role），Runner 的 `executionProfile = "worker"`。Runner 可以执行实质性工作；Observer 只能读状态。

**生命周期**：dispatch → native spawn intent → sessions_spawn accepted → dispatch confirm → native running/completed facts → native announce/channel delivery → status projection

---

## Ctl

**两层含义**（都属于 Ctl 域）：

### 4.1 octoclawctl CLI

独立命令行工具，控制 OctoClaw 插件的安装、配置和运营。

**主要命令**：

| 命令 | 作用 |
|------|------|
| `install / update / deploy` | 插件安装与部署 |
| `patrol` | 手动触发健康检查（等同 Patrol） |
| `reconcile` | 同步状态 |
| `repair` | 恢复操作 |
| `status / details / queue / timeline` | 状态查询 |
| `calibration-gate` | 发布校准门控 |
| `nightly / nightly-eval` | 夜间评估 |

**代码位置**：`tools/octoclawctl/src/cli.ts`

### 4.2 session_control 任务类

当 agent 处于当前会话控制模式时，工具调用被限制到 session 范围。

**执行合同**：
- task_class = `"session_control"`
- 执行器：`isSessionControlDecision()` in `policy-utils.ts:112`

**允许工具**（`sessionControlTools()`，`policy-utils.ts:80`）：
- `octoclaw_status`、`session_status`
- `tool_policy.session_control_tools`
- WorkContract 的 `allowedTools`
- **注意**：不含 `octoclaw_task_action`（与 Observer 的区别）

**阻断规则**：任何不在集合中的工具返回 `tool_blocked_session_control`。

**与 Observer 的区别**：session_control 只操作当前 session（无 task_action）；Observer 可以查询任意任务状态。

---

## 四者关系图

```
OpenClaw 消息到来
    │
    ├─ judge → reply ──────────────────────── 主 agent 直接回复（无限制）
    │
    ├─ judge → delegate → worker_* ────────── Runner（执行实质工作）
    │
    ├─ judge → delegate → observer_probe ──── Observer（只读监控）
    │
    ├─ judge → control_observer task_class ── Observer（会话级只读）
    │
    └─ judge → session_control task_class ──── Ctl/session_control（session 范围控制）
                                               
后台（不依赖消息）：
    Patrol（watchdog）── 定时检测卡死任务 ── octoclawctl patrol（手动触发）
    Ctl（octoclawctl）── 安装/部署/校准 ── 独立于 agent 会话
```

---

## 命名约定

| 用语 | 规范写法 | 避免混用 |
|------|---------|---------|
| 只读监控会话 | Observer | ~~observe_only~~、~~observe session~~ |
| 后台健康检查 | Patrol | ~~watchdog~~（代码内部可用，文档用 Patrol） |
| 子 agent 执行者 | Runner | ~~worker~~（代码内部变量名可用 worker，文档用 Runner） |
| 控制面操作 | Ctl | ~~control~~、~~ctl session~~ |

**代码内部 vs 文档**：代码中 `control_observer`、`observer_probe`、`worker_pool`、`session_control` 等是实现名称，保持不变。文档和用户可见文本用上述规范写法。

---

*文档路径：`docs/octoclaw-role-terminology.md`*  
*代码核查分支：`refactor/0.4.0-stable`*
